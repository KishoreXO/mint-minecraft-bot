const logger = require('../logger');
const { withDeadline, isInterruption } = require('../task');
const { goToBlock } = require('../nav');
const {
  hasItem, digBlock, stepOntoDrop, PILLAR_MATERIAL,
} = require('../inventory');
const { surplusCandidates, isPrecious } = require('../stock');
const { knownBase, forget } = require('../base');
const { nextGoal } = require('./gear');

/**
 * Throw away worthless blocks the bot accumulates incidentally.
 *
 * Mining and pathing leave it holding stacks of granite, diorite, leaf
 * litter and dirt it will never use. Left alone, these steadily consume
 * inventory slots until there's no room for the things that matter — at
 * which point newly dropped loot simply can't be picked up.
 */

/**
 * The bot keeps an escape kit even out of things it is otherwise throwing away.
 *
 * `unstick` pillars out of holes and `shelter` seals a roof overhead, and both
 * need something placeable. Dirt is the most common placeable the bot ever
 * holds and also the most common surplus — so tidying it all away left it with
 * no way out of the next hole it dug.
 *
 * Derived from PILLAR_MATERIAL rather than hand-written, because the
 * hand-written version had drifted and counted GRAVEL. Gravel falls: a bot
 * that kept a stack of it as its escape kit and pillared with it placed a
 * block that dropped straight back onto its head.
 */
const KEEP_PLACEABLE = 16;

function placeableHeld(bot) {
  return bot.inventory.items()
    .filter((i) => PILLAR_MATERIAL.has(i.name))
    .reduce((sum, i) => sum + i.count, 0);
}

// There is no "wait until the bag is nearly full" threshold any more, and
// that is the point: shedding surplus only once slots run out means the bag
// is nearly full for most of the session, which is exactly when a vein of
// iron is least likely to fit. Anything the policy calls surplus goes as soon
// as it is noticed. TOTAL_SLOTS remains for reporting.
const TOTAL_SLOTS = 36;

function freeSlots(bot) {
  return TOTAL_SLOTS - bot.inventory.items().length;
}

// How long a discard point stays blacklisted for `collect`. Short on purpose
// — collect.js explains what a long blackout cost: real drops left lying.
const DISCARD_MEMORY_MS = 120000;
// How long a stack thrown somewhere counts as "the one we already threw" when
// it turns up in the bag again. Longer, because it only ever stops a THROW:
// live on 09-24 the same 16 raw copper went out at 13:49, 13:51 and 13:52,
// the first gap just past two minutes.
const BOUNCE_MEMORY_MS = 5 * 60 * 1000;
// Back within this long, it bounced — however full the bag is. Throwing it
// again straight away only puts it back where it will be picked up again.
const IMMEDIATE_BOUNCE_MS = 30000;

/**
 * Throwing something away only works if the bot then walks away from it.
 *
 * `collect` honours the discard list, but the SERVER does not: any item the
 * bot's hitbox passes within a block of, once its two-second toss delay is
 * up, goes straight back into the inventory. In a one-wide strip mine the
 * stack lands in the tunnel the bot is about to walk back along. Live on
 * 09-24 the same single wheat seed was thrown six times and the same moss
 * carpet five, each time a preemption of whatever the bot was mining.
 *
 * So an item already thrown away near here recently is presumed to be that
 * same stack come back, and is kept — until the bag is genuinely short of
 * room, when getting rid of it matters more than the churn. Past
 * BOUNCE_RADIUS the bot has moved on and a fresh stack is worth dropping.
 */
const BOUNCE_RADIUS = 16;
const ROOM_TO_TOLERATE_BOUNCES = 6;

function bouncedBack(bot, ctx, stack, withinMs) {
  const cutoff = Date.now() - withinMs;
  return (ctx?.tidy?.discarded ?? []).some((d) => d.item === stack.name
    && d.at > cutoff
    && d.pos.distanceTo(bot.entity.position) <= BOUNCE_RADIUS);
}

/**
 * Standing at the workshop is the worst place to throw anything away.
 *
 * It is the one place the bot is guaranteed to come back to — every smelt,
 * every craft — and the server hands back any pile it walks through. The
 * repeated throws on 09-24 were almost all right beside the furnace and table:
 * raw copper three times, a stone pickaxe three times, the same 33 diorite four.
 * So junk waits until the bot has left, while there is room to carry it.
 */
const WORKSHOP_RADIUS = 8;

function atTheWorkshop(bot) {
  return ['tablePos', 'furnacePos', 'smokerPos', 'blastPos']
    .some((key) => knownBase[key] && bot.entity.position.distanceTo(knownBase[key]) <= WORKSHOP_RADIUS);
}

/**
 * What to throw out, asked of the ONE place that knows — see src/stock.js.
 *
 * It used to be asked here, with a private JUNK list, while `collect` decided
 * what to pick up from a different table entirely. The two disagreed, and the
 * disagreement was visible: the bot dropped a spare stone pickaxe as surplus,
 * `collect` rated tools at 500 and walked straight back for it, and `tidy`
 * dropped it again. Reported as "he drops the pickaxes to get rid of them but
 * continues to go pick them like 20 times", and that is exactly what it was.
 */
function toDiscard(bot, ctx) {
  // The FIRST ACCEPTABLE candidate, not the first candidate. The escape kit
  // is protected — being unable to pillar out of a hole costs far more than a
  // stack of dirt is worth — and with only one candidate on offer a protected
  // stack of dirt at the front of the list masked every other surplus behind
  // it, so the bot went on carrying lapis and spare pickaxes it had already
  // decided to drop.
  const keepPlaceables = placeableHeld(bot) <= KEEP_PLACEABLE;
  const roomy = freeSlots(bot) > ROOM_TO_TOLERATE_BOUNCES;
  if (roomy && atTheWorkshop(bot)) return null;
  return surplusCandidates(bot).find(
    (stack) => !(keepPlaceables && PILLAR_MATERIAL.has(stack.name))
      && !bouncedBack(bot, ctx, stack, IMMEDIATE_BOUNCE_MS)
      && !(roomy && bouncedBack(bot, ctx, stack, BOUNCE_MEMORY_MS)),
  ) ?? null;
}

/**
 * Throw it AWAY, not at our feet, and remember where.
 *
 * bot.toss drops the stack where the bot stands, which puts it squarely back
 * inside `collect`'s pickup radius. Even with both sides agreeing on the
 * policy that is fragile, because identifying a dropped item is best-effort:
 * the item lives in entity metadata whose slot index moves between versions,
 * and when the read fails the drop is treated as "might matter" and collected.
 * One unreadable stack is all it takes to restart the loop.
 *
 * So: face away, throw, and write down where it landed. `collect` skips
 * anything near a discard point, which needs no metadata to work and cannot
 * be defeated by a failed read.
 */
/** Any single window transaction — see the note on OPEN_TIMEOUT_MS below. */
const SLOT_TIMEOUT_MS = 3000;

/**
 * Which way to throw: away from where the bot is about to walk.
 *
 * This comment used to say "look away from where we are going next" above a
 * Math.random() heading — which, in a one-wide tunnel, is ahead half the time,
 * straight into the cell the next step walks through. Behind the strip heading
 * is the tunnel already dug; away from the workshop is away from the one place
 * the bot always comes back to. Random only when neither is known.
 *
 * mineflayer's yaw faces (−sin yaw, −cos yaw), so a direction (dx, dz) is
 * atan2(−dx, −dz).
 */
function throwYaw(bot, ctx) {
  const yawFor = (dx, dz) => Math.atan2(-dx, -dz);
  const heading = ctx?.mine?.stripHeading;
  if (heading) return yawFor(-heading[0], -heading[1]);
  const station = ['tablePos', 'furnacePos'].map((k) => knownBase[k]).find(Boolean);
  if (station) {
    const away = bot.entity.position.minus(station);
    if (away.x || away.z) return yawFor(away.x, away.z);
  }
  return Math.random() * Math.PI * 2;
}

async function throwAway(bot, ctx, stack) {
  // Look away from where we are going next, and slightly down, so the stack
  // lands a couple of blocks off rather than on our own feet.
  await bot.look(throwYaw(bot, ctx), 0.2, true).catch(() => {});

  // CHECK THE SLOT STILL HOLDS WHAT WE DECIDED TO DROP.
  //
  // bot.tossStack drops what is in `stack.slot` right now, not the object we
  // chose — and between choosing and throwing there is a `look`, an await, and
  // whatever the rest of the bot did in that window: an auto-eat finishing, a
  // craft landing, a pickup being slotted. Any of those reshuffles the
  // inventory, and the throw then goes out against whatever moved into that
  // index. That is how an iron ingot ends up on the ground with nothing in the
  // log explaining it, which is exactly what was reported.
  //
  // Re-reading the slot costs one array lookup and makes the whole class of
  // mistake impossible.
  const inSlot = bot.inventory.slots[stack.slot];
  if (!inSlot || inSlot.name !== stack.name || inSlot.type !== stack.type) {
    logger.info('Not throwing that after all — the inventory moved under me', {
      wanted: stack.name,
      slot: stack.slot,
      nowHolds: inSlot?.name ?? 'nothing',
    });
    return false;
  }
  // Belt and braces: whatever the surplus rules concluded, these never go.
  if (isPrecious(inSlot.name)) {
    logger.warn('Refusing to throw away something we need', { item: inSlot.name });
    return false;
  }

  try {
    // Another window transaction with a twenty-second internal timeout. Being
    // unable to drop a stack of dirt must never cost the bot twenty seconds of
    // standing still, which is long enough to be killed in.
    await withDeadline(bot.tossStack(inSlot), SLOT_TIMEOUT_MS, `toss ${inSlot.name}`);
  } catch (err) {
    // The stack can be gone by now — eaten, used in a craft, or picked up
    // into a different slot. Losing a throw is not worth failing the whole
    // behavior over.
    logger.info('Could not throw that away', { item: inSlot.name, error: err.message });
    return false;
  }

  // Mark the spot only once something has actually landed on it.
  //
  // Marking before the throw blacklists a four-block sphere for two minutes on
  // the strength of a toss that may have been refused — and `collect` then
  // walks past a genuine drop of the same item lying there for no reason
  // anybody could reconstruct from the log.
  ctx.tidy = ctx.tidy ?? { discarded: [] };
  ctx.tidy.discarded.push({
    pos: bot.entity.position.clone(),
    at: Date.now(),
    // WHAT was dropped here, so `collect` can skip this stack without also
    // skipping the iron that happens to be lying beside it.
    item: inSlot.name,
    // collect's blackout is shorter than the bounce memory — see both.
    pickupBlockedUntil: Date.now() + DISCARD_MEMORY_MS,
  });
  // Bounded: one entry per discard, and they expire. Without a cap a long
  // session accumulates a blacklist the size of the world.
  const cutoff = Date.now() - BOUNCE_MEMORY_MS;
  ctx.tidy.discarded = ctx.tidy.discarded.filter((d) => d.at > cutoff).slice(-48);
  return true;
}

/**
 * Take the workshop with us.
 *
 * The bot places a crafting table and a furnace, uses them, and then walks
 * off to mine or explore and leaves them standing. Next time it needs one it
 * is a hundred blocks away, so it either makes the long walk back or — far
 * more often — builds another, which costs wood and cobblestone it needs for
 * tools and eventually litters the world with them.
 *
 * A crafting table is one block and eight cobblestone is one furnace: both
 * are trivial to carry and enormously valuable to have on hand at depth,
 * where there is no wood to make a new one. So when the bot is about to
 * leave, it packs up. This is what a player does without thinking about it.
 *
 * Only ever picks up stations we placed and still remember — never someone
 * else's, and never one it is standing at and about to use.
 */
/**
 * Six blocks was too tight, and the consequence was the bot abandoning its
 * workshop every single time.
 *
 * The two conditions had to hold at once: the station idle for a full minute,
 * AND the bot within six blocks of it. Those are nearly incompatible — a
 * minute after its last craft the bot is off chopping or mining, tens of
 * blocks away, so the window simply never opened. Reported directly: "I saw
 * him leave a furnace and crafting table".
 *
 * Twenty blocks is a walk of a few seconds and buys back a table the bot
 * otherwise rebuilds out of wood it had to fetch, or walks a hundred blocks
 * for. Past that it genuinely is not worth retrieving, which is the line the
 * user drew: "unless the crafting table or furnace is hard to retrieve".
 */
const PACK_UP_RANGE = 32;
// Past this far above the bot, the station is not worth the climb — see stationToPack.
const PACK_UP_MAX_RISE = 4;
const STATION_KEYS = [
  ['tablePos', 'crafting_table'],
  ['furnacePos', 'furnace'],
  ['smokerPos', 'smoker'],
  ['blastPos', 'blast_furnace'],
];

const SMELTERS = new Set(['furnace', 'smoker', 'blast_furnace']);
const OPEN_TIMEOUT_MS = 4000;

/**
 * Take everything out before breaking a smelter.
 *
 * Breaking a furnace with anything inside scatters the contents, and the bot
 * will already be walking away by the time they land — which is where "a lot of
 * unattended furnaces with cooked food in them" turns into cooked food on the
 * floor. Emptying it first costs one window transaction and turns the pack-up
 * into a clean retrieval: the furnace in the bag, the food in the inventory.
 *
 * Also the honest answer to a furnace that is still SMELTING: if there is fuel
 * burning and input left, this is not a good moment and the caller should wait.
 * Returns false in that case.
 */
async function emptySmelter(bot, block, task) {
  let furnace;
  try {
    furnace = await withDeadline(bot.openFurnace(block), OPEN_TIMEOUT_MS, 'open furnace', task);
  } catch (err) {
    if (isInterruption(err)) throw err;
    logger.info('Could not open that furnace to empty it', { error: err.message });
    return false;
  }

  try {
    // Still cooking. Leave it be; `smelt` has an appointment with it.
    if (furnace.inputItem() && furnace.fuelItem()) return false;

    for (const take of ['takeOutput', 'takeInput', 'takeFuel']) {
      if (task) task.throwIfAborted();
      try {
        // Deadlined: each of these waits on an inventory-update packet with
        // mineflayer's own twenty-second internal timeout, and an empty slot
        // or a desynced window means it simply never arrives.
        const got = await withDeadline(furnace[take](), SLOT_TIMEOUT_MS, take, task);
        if (got) {
          logger.action('Emptied the furnace before packing it', {
            item: got.name,
            count: got.count,
          });
        }
      } catch {
        // That slot was empty, or the server refused — either way there is
        // nothing more to do about it and the pack-up should still happen.
      }
    }
    return true;
  } finally {
    try {
      furnace.close();
    } catch {
      // already closed
    }
  }
}

/**
 * How long the station must have sat unused before we pack it.
 *
 * "Nothing left to craft" is NOT the same as "leaving", and treating them as
 * the same made this thrash. `gear` crafts its last tool, nextGoal goes null
 * that instant, tidy is then the highest behavior that wants to run — and it
 * breaks the table the bot is still standing at. The next time it gathers
 * enough cobblestone it places it again, crafts, and tidy packs it again:
 * place, craft, pack, repeat, every single cycle.
 *
 * A quiet period is what actually distinguishes "finished here" from "between
 * two crafts". Half a minute of not touching the station means the bot has
 * moved on to something else, which is exactly when carrying it is worth
 * doing — and it is short enough that the bot is usually still in range,
 * which sixty seconds was not.
 */
const STATION_IDLE_BEFORE_PACKING_MS = 30000;

/**
 * Stations we could not walk back to.
 *
 * Without this the pack-up is a treadmill: `shouldRun` says yes because a
 * remembered station is inside the range, `run` spends twenty seconds failing
 * to path to it, the director scores that as a no-op, backs the behavior off
 * for a few seconds, and then the whole thing repeats. The station is not
 * getting more reachable in the meantime.
 *
 * Bounded and expiring, because "unreachable" is usually about where the bot is
 * standing rather than about the station — a minute later, from somewhere else,
 * it may be a short walk.
 */
const PACK_RETRY_MS = 120000;
const unreachableStations = new Map(); // "x,y,z" -> ignore-until

function stationKey(pos) {
  return `${Math.floor(pos.x)},${Math.floor(pos.y)},${Math.floor(pos.z)}`;
}

function noteStationUnreachable(pos) {
  const now = Date.now();
  for (const [key, until] of unreachableStations) {
    if (until < now) unreachableStations.delete(key);
  }
  unreachableStations.set(stationKey(pos), now + PACK_RETRY_MS);
}

function stationIsUnreachable(pos) {
  const until = unreachableStations.get(stationKey(pos));
  return !!until && until > Date.now();
}

function stationToPack(bot, ctx) {
  // Only when the work here is FINISHED.
  //
  // Without these checks this is an infinite loop and a data loss bug: a
  // furnace picked up mid-cook destroys whatever was inside it, and packing
  // the moment there is nothing to craft thrashes as described above.
  if (nextGoal(bot)) return null; // still something to craft
  if (ctx?.smelt?.pending) return null; // a batch is still in there

  const lastUsed = ctx?.stations?.lastUsedAt ?? 0;
  if (Date.now() - lastUsed < STATION_IDLE_BEFORE_PACKING_MS) return null;

  for (const [key, blockName] of STATION_KEYS) {
    const pos = knownBase[key];
    if (!pos) continue;
    if (stationIsUnreachable(pos)) continue;
    if (bot.entity.position.distanceTo(pos) > PACK_UP_RANGE) continue;
    // Well above us is behind us. Underground the way back up to a station is
    // usually the staircase the bot dug down, which pathfinder rarely finds:
    // both "no route" failures on 09-24 were a furnace six to nine blocks up,
    // each twenty seconds of trying before the retry timer let it try again.
    if (pos.y - bot.entity.position.y > PACK_UP_MAX_RISE) continue;
    // Already carrying one? Then leave this be; two is pointless weight.
    if (hasItem(bot, blockName)) continue;
    const block = bot.blockAt(pos);
    if (block && block.name === blockName) return { key, block };
  }
  return null;
}

const tidy = {
  name: 'tidy',
  priority: 30,
  shouldRun(bot, ctx) {
    if (stationToPack(bot, ctx)) return true;
    // Anything genuinely worthless — lapis, a third pickaxe, rotten flesh —
    // goes regardless of how much room there is. It is weight the bot cannot
    // spend, and waiting for the bag to be nearly full before shedding it
    // means it is nearly full for most of the session.
    return !!toDiscard(bot, ctx);
  },
  async run(bot, ctx, task) {
    // Pack the workshop before anything else — a table in the bag is worth
    // far more than a free inventory slot.
    const station = stationToPack(bot, ctx);
    if (station) {
      const { key, block } = station;
      // Walk to it. The range is thirty-two blocks now, not six, because six
      // was so tight the pack-up window never opened at all — and at that
      // range the bot is not standing next to the thing it is about to break.
      try {
        await goToBlock(bot, block, task, { within: 3, timeoutMs: 20000 });
      } catch (err) {
        if (isInterruption(err)) throw err;
        noteStationUnreachable(block.position);
        logger.info('Could not get back to the station to pack it', {
          station: block.name,
          reason: err.message,
          leavingItFor: `${Math.round(PACK_RETRY_MS / 1000)}s`,
        });
        return false;
      }

      // Empty it first if it holds anything — otherwise breaking it scatters
      // the contents behind a bot that is already walking away.
      if (SMELTERS.has(block.name) && !(await emptySmelter(bot, block, task))) return false;

      const still = bot.blockAt(block.position);
      if (!still || still.name !== block.name) {
        forget(key);
        return false;
      }
      if (await digBlock(bot, still, task)) {
        await stepOntoDrop(bot, still.position, task);
        forget(key);
        logger.action('Packed up the workshop to take along', {
          station: still.name,
          why: 'no wood at depth to build another, and no reason to litter',
        });
        return true;
      }
      return false;
    }

    const stack = toDiscard(bot, ctx);
    if (!stack) return false;

    if (!(await throwAway(bot, ctx, stack))) return false;
    logger.action('Threw away what it cannot use', {
      item: stack.name,
      count: stack.count,
      freeSlots: freeSlots(bot),
      note: 'tossed clear and blacklisted so it is not collected again',
    });
    return true;
  },
};

module.exports = {
  tidy,
  // Exported for the tests: this decides whether to BREAK the bot's crafting
  // table, so getting it wrong costs the workshop or loops forever.
  stationToPack,
  STATION_IDLE_BEFORE_PACKING_MS,
  // And this decides what leaves the bag, so a loop in it is a loop in tidy.
  toDiscard, throwYaw,
};
