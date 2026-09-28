const logger = require('../logger');
const worldMemory = require('../memory');
const { sleep, isInterruption } = require('../task');
const { goNear } = require('../nav');
const { stepOntoDrop } = require('../inventory');
const { worthPickingUp, isPrecious } = require('../stock');

/**
 * Walk over dropped items to pick them up.
 *
 * Minecraft only collects an item when the player's hitbox touches it, and
 * drops scatter several blocks from wherever they were produced. Standing
 * near the middle and waiting — which is all the death-recovery did — leaves
 * most of a dropped inventory on the ground. This visits each drop.
 */

const COLLECT_RANGE = 16;
// Vertical reach is far more restrictive than horizontal: climbing or
// descending to a drop usually means digging, and often isn't possible.
// Walking DOWN to something is easy and extremely common (items fall), so
// that limit is looser than the one for climbing.
const MAX_DESCENT_FOR_DROP = 8;
const MAX_CLIMB_FOR_DROP = 3;
/**
 * How many drops to clear in one run.
 *
 * Six was far too few for the case that matters most. A death scatters an
 * entire inventory — tools, ore, food, blocks — over a few blocks, and the
 * bot would walk all the way back, pick up SIX things, and the behavior
 * would end. Watched live: it returned to its death site and collected only
 * a sword while everything else it owned lay around it and despawned.
 */
const MAX_PER_RUN = 16;

/**
 * How long to leave a drop alone after failing to reach it.
 *
 * Items despawn after five minutes, so a sixty-second blacklist meant at
 * most four attempts and in practice one or two — a single unlucky failure
 * (a mob bumping us, a preempted approach) permanently lost the item. Short
 * enough now that a transient failure costs a few seconds rather than the
 * drop.
 */
const RETRY_BLOCK_MS = 12000;
const APPROACH_TIMEOUT_MS = 7000;
/**
 * How many times to fail at one drop before writing it off for good.
 *
 * A short blacklist is right for a transient failure — a mob bumped us, the
 * approach was preempted — and wrong for a drop that is genuinely
 * unreachable: one stuck inside terrain, or on the far side of a ravine. At
 * twelve seconds the bot retried an impossible pickup five times a minute for
 * the item's whole five-minute life, at roughly seven seconds a go. That is
 * most of a minute per drop spent proving the same thing.
 *
 * Reported as "he literally couldn't pick up the item, went to collect, and
 * he couldn't collect it" — the part that hurts is not the first failure, it
 * is the next twenty-four.
 */
const GIVE_UP_AFTER_FAILURES = 3;
const FORGET_DROP_MS = 5 * 60 * 1000;

function noteDropFailure(ctx, id) {
  const entry = ctx.collect.failed.get(id);
  const strikes = (entry?.strikes ?? 0) + 1;
  ctx.collect.failed.set(id, { at: Date.now(), strikes });
  return strikes;
}

function dropIsBlocked(ctx, id) {
  const entry = ctx.collect.failed.get(id);
  if (!entry) return false;
  const waited = Date.now() - entry.at;
  // Given up on: leave it alone until it has certainly despawned.
  if (entry.strikes >= GIVE_UP_AFTER_FAILURES) return waited < FORGET_DROP_MS;
  return waited < RETRY_BLOCK_MS;
}

/**
 * What to pick up FIRST when several things are on the floor.
 *
 * Distance alone is the wrong order at a death site: the bot would grab the
 * dirt at its feet and hit the per-run limit before reaching the iron three
 * blocks away. Worth is what should decide, with distance breaking ties.
 */
const WORTH = [
  [/diamond|netherite|emerald|ancient_debris/, 1000],
  // Iron only. Gold, lapis and redstone were rated here alongside it and none
  // of them is a step toward a diamond kit — src/stock.js filters them out
  // before this table is ever consulted, so leaving them listed at 600 was a
  // second opinion waiting to be believed by the next person to read it.
  [/^(raw_iron|iron_ingot|iron_block)$/, 600],
  [/pickaxe|sword|axe|shovel|shield|helmet|chestplate|leggings|boots/, 500],
  [/^(coal|charcoal)$/, 300],
  [/cooked_|bread|_apple$|carrot|potato|beef|porkchop|mutton|chicken|rabbit/, 280],
  [/_log$|_planks$|^stick$|wool$/, 200],
  [/cobblestone|cobbled_deepslate|^stone$|deepslate/, 120],
  [/torch|flint|leather|feather|string|bone|gunpowder/, 100],
];

function worthOf(name) {
  if (!name) return 150; // unknown: assume it might matter
  for (const [pattern, score] of WORTH) {
    if (pattern.test(name)) return score;
  }
  return 50;
}

// Pickup is server-authoritative: we walk onto the item, the server decides,
// and only then does the entity disappear for us. A fixed 350ms settle was
// shorter than that round trip on a laggy tick, so items the bot HAD just
// collected were being marked unreachable and skipped for the next minute.
// Poll for the confirmation instead of guessing a duration.
const PICKUP_CONFIRM_MS = 1500;
const PICKUP_POLL_MS = 100;

// Not worth interrupting work for, and picking them up fills the inventory
// with rubbish the bot will never use.
const IGNORED = new Set([
  'poppy', 'dandelion', 'short_grass', 'tall_grass', 'fern', 'large_fern',
  'leaf_litter', 'seagrass', 'oak_button', 'dead_bush',
]);

/**
 * Best-effort read of what a dropped-item entity actually contains. The item
 * lives in entity metadata, whose slot index shifts between versions, so this
 * probes tolerantly and returns null when unsure — in which case we collect
 * it anyway rather than risk ignoring something valuable.
 */
function droppedItemName(bot, entity) {
  const meta = Array.isArray(entity.metadata) ? entity.metadata : [];
  for (const field of meta) {
    if (!field || typeof field !== 'object') continue;
    const id = field.itemId ?? field.blockId ?? field.itemType;
    if (id === undefined) continue;
    return bot.registry.items[id]?.name ?? null;
  }
  return null;
}

/**
 * Somewhere we deliberately threw something away.
 *
 * The belt to the braces of asking src/stock.js whether we want the item.
 * Identifying a dropped item is BEST EFFORT — it lives in entity metadata
 * whose slot index moves between versions — and when the read fails the drop
 * is treated as "might matter" and collected. One unreadable stack is all it
 * takes to restart the throw-it-away-and-fetch-it-back loop the user watched
 * happen twenty times with a stone pickaxe.
 *
 * A position needs no metadata, so this cannot be defeated that way.
 */
const DISCARD_RADIUS = 4;

/**
 * Was this drop one we threw away here?
 *
 * The position check alone was too blunt, and it cost real resources. A discard
 * blacklists a four-block sphere for two minutes, and the bot mines, fights and
 * dies inside those spheres — so an iron ingot that fell within four blocks of
 * where a stack of cobblestone had been dumped was simply left on the ground,
 * with nothing in the log to say why. Reported as: "the bot dropped an iron
 * ingot and didn't pick it up for no reason."
 *
 * Position is still what does the work, because identifying a dropped ITEM is
 * best-effort — the name lives in entity metadata whose slot index moves
 * between versions. So: skip it when the place matches AND either the item
 * matches or we cannot read it at all. Anything positively identified as
 * something else is collected.
 */
function nearADiscard(bot, ctx, position, itemName) {
  const marks = ctx.tidy?.discarded;
  if (!marks || marks.length === 0) return false;
  const now = Date.now();
  return marks.some((mark) => {
    // Marks now outlive the pickup blackout — tidy keeps them longer to spot
    // a stack bouncing back — so the blackout carries its own expiry.
    if ((mark.pickupBlockedUntil ?? Infinity) < now) return false;
    if (mark.pos.distanceTo(position) > DISCARD_RADIUS) return false;
    if (!itemName) return true; // unreadable: assume it is the one we dropped
    // Older marks carry no item name; fall back to the position alone.
    return !mark.item || mark.item === itemName;
  });
}

function isCollectableDrop(bot, ctx, entity) {
  if (!entity || !entity.isValid) return false;
  // Dropped items surface under either name depending on version.
  const name = entity.name?.toLowerCase();
  if (name !== 'item' && name !== 'item_stack') return false;

  const itemName = droppedItemName(bot, entity);

  // Not down in a remembered water trap, whatever it is — unless we are down
  // there already. On 09-26, collect was the second commonest way the bot
  // walked back into the ravine it had just pillared out of.
  if (worldMemory.inWaterTrap(entity.position) && !worldMemory.inWaterTrap(bot.entity.position)) return false;

  // Iron, diamonds and the workshop are always worth the walk, wherever they
  // are lying and whatever else we dumped nearby.
  if (itemName && isPrecious(itemName)) return true;

  // Never pick up something we deliberately put down.
  if (nearADiscard(bot, ctx, entity.position, itemName)) return false;

  if (itemName && IGNORED.has(itemName)) return false;
  // One policy, shared with `tidy` — see src/stock.js. Two tables disagreeing
  // about what is worth having is what produced the loop.
  return worthPickingUp(bot, itemName);
}

/**
 * Drops worth going to, excluding ones we've already tried and failed to
 * collect. Without that exclusion the bot will walk to an uncollectable drop
 * (stuck in terrain, or a stale entity the server already removed), report
 * success, find it still listed, and do it again forever.
 */
function nearbyDrops(bot, ctx) {
  const drops = [];
  for (const id of Object.keys(bot.entities)) {
    const entity = bot.entities[id];
    if (!isCollectableDrop(bot, ctx, entity)) continue;

    if (dropIsBlocked(ctx, entity.id)) continue;

    // Vertical limits are ASYMMETRIC, because items fall.
    //
    // Mining next to a cave drops items into the cavern, and chasing those
    // burns minutes with nothing collected — hence a limit at all. But
    // chopping a tree breaks logs several blocks up, and the drop lands on
    // the ground BELOW where the block was. A symmetric limit treated that
    // as unreachable and the bot walked off leaving its own log behind,
    // which is what happened live. Down is normal; up means climbing.
    const drop = entity.position.y - bot.entity.position.y;
    if (drop > MAX_CLIMB_FOR_DROP) continue;
    if (-drop > MAX_DESCENT_FOR_DROP) continue;

    const distance = bot.entity.position.distanceTo(entity.position);
    if (distance > COLLECT_RANGE) continue;
    drops.push({
      entity,
      distance,
      worth: worthOf(droppedItemName(bot, entity)),
    });
  }

  // Worth first, distance as the tie-break. Sorting by distance alone meant
  // the bot filled its per-run quota with whatever happened to be underfoot
  // and never reached the iron a few blocks further out.
  return drops.sort((a, b) => (b.worth - a.worth) || (a.distance - b.distance));
}

/**
 * Wait for the server to confirm the pickup, or for us to run out of
 * patience. Returns as soon as the entity goes away, so a successful grab
 * costs one poll rather than a fixed delay.
 */
async function waitForPickup(bot, entity, task) {
  const deadline = Date.now() + PICKUP_CONFIRM_MS;
  while (Date.now() < deadline) {
    if (!entity.isValid) return true;
    await sleep(PICKUP_POLL_MS, task);
  }
  return !entity.isValid;
}

const collect = {
  name: 'collect',
  // Above routine gathering (drops despawn) but deliberately below the
  // interrupt threshold — snatching items isn't worth cancelling a dig for.
  priority: 44,
  shouldRun(bot, ctx) {
    return nearbyDrops(bot, ctx).length > 0;
  },
  async run(bot, ctx, task) {
    return (await sweepDrops(bot, ctx, task, MAX_PER_RUN)) > 0;
  },
};

/**
 * Walk over every drop in range and pick it up. Returns how many were got.
 *
 * Extracted so death recovery can drive it directly. `loot` used to walk the
 * bot back to its corpse, clear the pending position, log "leaving pickup to
 * collect" and consider itself finished — handing an entire scattered
 * inventory to a behavior with a per-run cap that anything could preempt.
 * Watched live: the bot returned to its death site, picked up a sword, and
 * left everything else to despawn.
 *
 * Nothing owned the sweep. Now something does.
 */
async function sweepDrops(bot, ctx, task, limit) {
  const drops = nearbyDrops(bot, ctx).slice(0, limit);
  if (drops.length === 0) return 0;

  let collected = 0;
  for (const { entity } of drops) {
    task.throwIfAborted();
    if (!entity.isValid) continue; // already picked up, possibly by walking past

    const id = entity.id;
    try {
      // Range 1, not 0: pickup happens within about a block, and demanding
      // the exact coordinate is effectively unreachable — pathfinder then
      // retries forever. The deadline is a second safety net for drops
      // sitting somewhere genuinely awkward.
      //
      // goNear's own deadline, never withDeadline around it: that only stops
      // waiting, and the abandoned walk went on steering toward THIS drop —
      // then cleared the goal and every control — while the loop had already
      // moved on to the next one. See the matching note in stepOntoDrop.
      await goNear(bot, entity.position, 1, task, { timeoutMs: APPROACH_TIMEOUT_MS });
      // goNear stops at a horizontal distance of 1 and tolerates three
      // blocks of height difference, which is not close enough to actually
      // pick anything up — an item that fell into a hole we just dug is
      // "arrived at" and left there. Close the last bit on foot, in 3D.
      if (entity.isValid) {
        await stepOntoDrop(bot, entity.position, task, { minDistance: 0, timeoutMs: 2000 });
      }
      await waitForPickup(bot, entity, task);
    } catch (err) {
      if (isInterruption(err)) throw err;
      noteDropFailure(ctx, id); // unreachable — stop trying
      continue;
    }

    // The entity disappearing is the only real proof we picked it up.
    // Anything else means it's stuck somewhere we can't reach, or is a
    // stale entity the server already removed, so don't chase it again.
    if (entity.isValid) {
      noteDropFailure(ctx, id);
    } else {
      collected++;
    }
  }

  if (collected > 0) logger.action('Picked up drops', { collected });
  return collected;
}

/**
 * Clear EVERYTHING off the floor here, in passes, until nothing is left.
 *
 * For death recovery specifically: a death scatters a whole inventory, items
 * live five minutes, and a single pass with a per-run cap leaves most of it
 * behind. Keeps sweeping until the ground is clear, it stops making
 * progress, or the budget runs out.
 */
// Kept comfortably under the director's 60s deadlock breaker, since the
// linger and the final report sit inside the same behavior run.
const SWEEP_BUDGET_MS = 35000;

async function sweepUntilClear(bot, ctx, task) {
  const deadline = Date.now() + SWEEP_BUDGET_MS;
  let total = 0;

  while (Date.now() < deadline) {
    task.throwIfAborted();
    const got = await sweepDrops(bot, ctx, task, MAX_PER_RUN);
    total += got;
    // Nothing collected and nothing left worth trying: we are done.
    if (got === 0) break;
  }
  return total;
}

/** How much is still lying about — for reporting after a sweep. */
function nearbyDropCount(bot, ctx) {
  return nearbyDrops(bot, ctx).length;
}

module.exports = {
  collect, sweepUntilClear, nearbyDropCount,
  // For the tests: the pickup side of the throw-it-away loop.
  nearADiscard,
};
