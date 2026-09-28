const logger = require('./logger');
const {
  sleep, withDeadline, isInterruption, AbortError,
} = require('./task');
const { toolTypeForBlock: pickToolType, isWeaponOrGear } = require('./tools');
const { canHarvest } = require('./knowledge');
const { isUnwantedOre, TOOL_TIERS } = require('./stock');
const memory = require('./memory');
// Safe: nav depends only on pathfinder and task, never on this module.
const Vec3 = require('vec3');
const { goNear, groundUnder } = require('./nav');

const TIER_RANK = TOOL_TIERS;

const WOOD_SPECIES = [
  'oak', 'birch', 'spruce', 'jungle', 'acacia', 'dark_oak', 'mangrove', 'cherry', 'pale_oak',
];

// Items that satisfy Minecraft's "stone tool material" tag and the furnace
// recipe. Deliberately excludes granite/diorite/andesite/tuff — they look
// like stone and are everywhere, but they satisfy neither.
const STONE_MATERIAL = ['cobblestone', 'cobbled_deepslate', 'blackstone'];

function itemCount(bot, name) {
  return bot.inventory.items()
    .filter((i) => i.name === name)
    .reduce((sum, i) => sum + i.count, 0);
}

function countAny(bot, names) {
  const set = names instanceof Set ? names : new Set(names);
  return bot.inventory.items()
    .filter((i) => set.has(i.name))
    .reduce((sum, i) => sum + i.count, 0);
}

function hasItem(bot, name) {
  return itemCount(bot, name) > 0;
}

function findItem(bot, predicate) {
  return bot.inventory.items().find(predicate) || null;
}

/**
 * Wood measured in planks, counting every form it comes in.
 *
 * ONE definition, because having several is what caused the descent to
 * deadlock. `deepTripShortfall` counted only planks and sticks while
 * `gear` and the resupply check both treated a log as four planks, so a bot
 * carrying ten logs — forty planks' worth — reported "need: wood" and
 * refused to go underground, permanently. Anything asking "do we have
 * enough wood" asks here.
 */
function woodUnits(bot) {
  return countAny(bot, plankNames(bot))
    + itemCount(bot, 'stick')
    + bot.inventory.items()
      .filter((i) => i.name.endsWith('_log'))
      .reduce((sum, i) => sum + i.count * 4, 0);
}

function plankNames(bot) {
  return WOOD_SPECIES
    .map((s) => `${s}_planks`)
    .filter((n) => bot.registry.itemsByName[n]);
}

function tierRank(name) {
  const idx = TIER_RANK.findIndex((t) => name.startsWith(t));
  return idx === -1 ? TIER_RANK.length : idx;
}

/**
 * Best tool of a type: highest tier first, then the FRESHEST of that tier.
 *
 * The durability tiebreak is not a nicety, it is the fix for a runaway. This
 * sorted on tier alone, so with several stone pickaxes it returned whichever
 * sat in the lowest inventory slot — and if that one happened to be nearly
 * dead, every question asked about "our pickaxe" got the dying one as the
 * answer, no matter how many good ones were sitting beside it.
 *
 * toolIsWornOut therefore answered yes permanently, `gear` crafted a
 * replacement, the replacement went into a higher slot, the dead one was
 * still picked, and it crafted another. Found live with SIX stone pickaxes in
 * the bag and 184 cobblestone spent. It also meant deepTripShortfall reported
 * `pickaxe` forever, which blocks the descent outright.
 *
 * A player reaches for the freshest one. So does this now.
 */
function bestToolOfType(bot, toolType) {
  return bot.inventory.items()
    .filter((i) => i.name.endsWith(`_${toolType}`))
    .sort((a, b) => tierRank(a.name) - tierRank(b.name)
      || durabilityLeft(b) - durabilityLeft(a))[0] || null;
}

/**
 * Fraction of a tool's life remaining, 0..1. Returns 1 for anything that
 * doesn't wear out (or whose durability the server hasn't told us about).
 */
function durabilityLeft(item) {
  if (!item || !item.maxDurability) return 1;
  const used = item.durabilityUsed ?? 0;
  return Math.max(0, (item.maxDurability - used) / item.maxDurability);
}

/**
 * Is our best tool of this type about to break?
 *
 * Tools breaking is not a rare edge case — a stone pickaxe lasts 131 blocks
 * and this bot mines constantly. Watched live, its pickaxe broke mid-session
 * and it silently dropped back to a WOODEN one, which cannot mine iron at
 * all, quietly undoing the whole progression. Noticing beforehand means
 * crafting a replacement while the materials are still in the bag.
 */
const WORN_OUT = 0.15;

function toolIsWornOut(bot, toolType) {
  const tool = bestToolOfType(bot, toolType);
  if (!tool) return false; // no tool is a different problem
  return durabilityLeft(tool) < WORN_OUT;
}

/**
 * How many usable tools of a type we hold, ignoring nearly-dead ones.
 *
 * `atLeastAsGoodAs` restricts the count to tools of that tier or better.
 * Without it a leftover WOODEN pickaxe counted as the spare for a stone one —
 * see toolUpgrade in behaviors/gear.js for what that cost.
 */
function countUsableTools(bot, toolType, atLeastAsGoodAs = null) {
  const floor = atLeastAsGoodAs ? tierRank(atLeastAsGoodAs.name) : Infinity;
  return bot.inventory.items()
    .filter((i) => i.name.endsWith(`_${toolType}`)
      && tierRank(i.name) <= floor
      && durabilityLeft(i) >= WORN_OUT)
    .length;
}

/**
 * Which tool type to use for a block — now answered by src/tools.js, which
 * holds the whole table in one place.
 *
 * The rule that used to live here mapped leaves to SWORD. Blocks cost a
 * sword two durability instead of one, and the bot breaks leaves constantly
 * (every tree it fells, every canopy it cuts through), so its only weapon was
 * being destroyed by gardening — which is the "using sword to mine tree"
 * complaint, and why it kept arriving at fights unarmed.
 *
 * Passing `has` means the answer accounts for what we actually own: shears
 * for leaves if we have them, a hoe if not, bare hands otherwise.
 */
function toolTypeForBlock(bot, block) {
  return pickToolType(block, (type) => !!bestToolOfType(bot, type));
}

// Same failure mode as bot.craft(): equipping waits on an inventory-update
// packet and can hang for its full internal timeout if the window desyncs.
// This runs before every single dig and every swing, so a hang here is felt
// immediately as the bot standing still.
const EQUIP_TIMEOUT_MS = 2500;

async function equipIfDifferent(bot, item) {
  if (!item) return false;
  // Remembered for tryPlaceBlock, which puts it back if something else (an
  // auto-eat meal) took the hand in between.
  bot.lastEquippedName = item.name;
  if (bot.heldItem && bot.heldItem.type === item.type) return true;
  try {
    await withDeadline(bot.equip(item, 'hand'), EQUIP_TIMEOUT_MS, `equip ${item.name}`);
  } catch (err) {
    logger.info('Could not equip in time', { item: item.name, error: err.message });
    return false;
  }
  return true;
}

/**
 * Equip to a slot that is not the hand — the off-hand, an armour slot.
 *
 * Same hazard as every other window transaction in this project: mineflayer
 * waits on an inventory-update packet with a twenty-second internal timeout,
 * and if the server never sends one the await simply never returns. These calls
 * were all bare. Putting a shield in the off-hand happens at the start of a
 * fight, and a twenty-second freeze there is not a slow equip, it is a death.
 */
async function equipTo(bot, item, destination) {
  if (!item) return false;
  try {
    await withDeadline(
      bot.equip(item, destination),
      EQUIP_TIMEOUT_MS,
      `equip ${item.name} to ${destination}`,
    );
  } catch (err) {
    logger.info('Could not equip in time', {
      item: item.name, to: destination, error: err.message,
    });
    return false;
  }
  return true;
}

/** Empty the hand, without risking a hang. */
async function unequipHand(bot) {
  try {
    await withDeadline(bot.unequip('hand'), EQUIP_TIMEOUT_MS, 'empty hand');
  } catch {
    // Not fatal — worst case we mine with the wrong thing for one block.
  }
}

/**
 * Put the right tool in hand for a specific block.
 *
 * TIMING matters as much as the choice: this must run immediately before the
 * dig, never before pathing to the block — mineflayer-pathfinder swaps tools
 * itself while walking, so an early equip gets clobbered. That ordering bug
 * is what produced "mining stone bare-fisted and chopping dirt with a sword".
 *
 * Verifying what ended up in hand is not defensive padding either: the bot
 * was repeatedly caught punching stone while carrying a perfectly good
 * pickaxe, and stone mined by hand drops NOTHING. mineflayer-tool has two
 * ways to leave the wrong thing in hand — `isBetterMiningTool` equips
 * nothing when the held item ties on dig time, and with an empty inventory
 * slot it will happily `unequip('hand')`, i.e. choose fists.
 */
async function equipForBlock(bot, block) {
  const wanted = toolTypeForBlock(bot, block);

  // Our table decides, not the plugin.
  //
  // mineflayer-tool optimises purely for dig speed, which is why a sword kept
  // ending up in hand for leaves — it IS faster than bare hands there. What
  // it does not know is that this bot's sword is the difference between
  // surviving the night and not, and that blocks cost a sword double
  // durability. So the plugin is only consulted when we have no opinion.
  if (wanted === null) {
    // Bare hands are correct. Put away anything that would take needless
    // damage — a sword above all.
    if (bot.heldItem && isWeaponOrGear(bot.heldItem.name)) await unequipHand(bot);
    return;
  }

  const tool = bestToolOfType(bot, wanted);
  if (tool) {
    await equipIfDifferent(bot, tool);
    return;
  }

  // We don't own the right tool — and that is the END of it, not the start of
  // a plugin consultation.
  //
  // This used to hand every such block to mineflayer-tool, which is a window
  // transaction and a full inventory scan, on EVERY dig. Digging through dirt
  // with no shovel meant paying that for every block of a staircase. And it
  // cannot help: src/tools.js already names the one tool type that speeds
  // this block up, so if we do not own that type, nothing else in the bag is
  // faster than bare hands. The plugin would look, find nothing better, and
  // change nothing — slowly.
  //
  // What is left is to EMPTY THE HAND, and emptying it of a sword was not
  // enough. Reported directly: "I saw him use an axe to mine a dirt block."
  // Dirt wants a shovel; with no shovel this branch ran, the axe was not a
  // weapon by the old test, so it stayed in hand and paid durability for a
  // block it breaks no faster than a fist does. An axe is the bot's wood
  // supply and its backup weapon — grinding it down on a staircase is the same
  // mistake as mining leaves with the sword, one tool along.
  if (bot.heldItem && wearsOutOnBlocks(bot.heldItem.name) && block.name !== 'cobweb') {
    await unequipHand(bot);
  }
}

/**
 * Anything that loses durability for no speed gain when used on the wrong
 * block: every tool, plus the weapons and gear that should never touch one.
 *
 * Bare hands break dirt, gravel, sand and leaves at the same rate a pickaxe
 * does, and at no cost.
 */
const TOOL_SUFFIX_RE = /_(pickaxe|axe|shovel|hoe)$|^shears$/;

function wearsOutOnBlocks(itemName) {
  return isWeaponOrGear(itemName) || TOOL_SUFFIX_RE.test(itemName || '');
}


/**
 * Wait out a fall, so the dig that follows runs at full speed.
 *
 * Deliberately conditional on actually FALLING rather than on being off the
 * ground. A bot swimming, or standing somewhere the server does not call
 * grounded, must not pay 400ms on every block — but a bot a quarter of a
 * second into a one-block drop should absolutely wait, because starting the
 * dig now costs five times that.
 */
const FALL_SETTLE_MS = 400;
const FALL_SETTLE_STEP_MS = 50;
const FALLING_VELOCITY = -0.08;

async function waitForFallToFinish(bot, task) {
  const falling = () => bot.entity
    && !bot.entity.onGround
    && !bot.entity.isInWater
    && (bot.entity.velocity?.y ?? 0) < FALLING_VELOCITY;

  if (!falling()) return;
  for (let waited = 0; waited < FALL_SETTLE_MS; waited += FALL_SETTLE_STEP_MS) {
    await sleep(FALL_SETTLE_STEP_MS, task);
    if (!falling()) return;
  }
}

/**
 * Equip the right tool and dig, verifying the block is still what we expect.
 *
 * Crucially, the dig is ABORTABLE. bot.dig() runs to completion on its own
 * schedule and does not care about our cancellation token — so without
 * bot.stopDigging() the bot will calmly finish chopping a tree while
 * something is actively hitting it. That single omission made it look
 * completely unresponsive: aborts fired every 250ms for nearly four seconds
 * and changed nothing until the block happened to break.
 */
async function digBlock(bot, block, task) {
  if (task) task.throwIfAborted();

  const current = bot.blockAt(block.position);
  if (!current || current.name !== block.name) return false; // changed since we looked
  if (!bot.canDigBlock(current)) return false;

  // NEVER destroy ore we cannot collect.
  //
  // This is the last line of defence and it belongs here, because every dig
  // in the project goes through this function — strip mining, tunnelling,
  // staircases, escaping, clearing a pocket. Guarding only the deliberate
  // `mine` path left every other one free to break an iron vein with a
  // wooden pickaxe, which drops NOTHING: the block is gone, permanently, the
  // dig reports success, and the inventory does not change.
  //
  // Refusing costs one skipped block. Not refusing costs the ore forever,
  // and iron is the whole progression.
  if (/_ore$|^ancient_debris$/.test(current.name)) {
    const tier = bestToolOfType(bot, 'pickaxe')?.name.split('_')[0] ?? 'none';
    if (tier === 'none' || !canHarvest(tier, current.name)) {
      // Write it down. Finding ore is the expensive half of mining, and this
      // one is already found — so the moment the pickaxe improves it is worth
      // walking back to rather than re-discovering. Survives restarts.
      //
      // Not ore we would throw away: a noted copper vein became `mine`'s
      // candidate as soon as the pickaxe allowed it, only to be declined —
      // a scan and a blocked strip mine for nothing.
      if (!isUnwantedOre(current.name)) memory.noteOre(current.position, current.name, 'better pickaxe');
      logger.info('Leaving that ore for a better pickaxe — noted where it is', {
        ore: current.name,
        have: `${tier} pickaxe`,
        at: current.position,
      });
      return false;
    }
  }

  await equipForBlock(bot, current);
  if (task) task.throwIfAborted();

  // LAND FIRST. Mining while airborne takes FIVE TIMES as long.
  //
  // That is a vanilla rule, not a bot problem — a player in mid-air breaks
  // blocks at a fifth of the normal rate — but it hits this bot constantly in
  // a way it never hits a person. The bot digs the block under its feet,
  // falls into the hole, and the very next dig starts while it is still
  // falling. Staircases, tunnels and every descent are built out of exactly
  // that sequence, so a large fraction of every dig was paying the penalty.
  //
  // From the outside it looks like nothing is wrong: the arm is swinging the
  // whole time, the right tool is in hand, and it simply takes far longer
  // than it does when you mine the same block with the same tool. Reported in
  // precisely those words.
  //
  // Waiting is cheap — a one-block fall is about a quarter of a second — and
  // only happens when we are ACTUALLY falling, so a bot standing on a fence
  // or swimming on purpose is not delayed.
  await waitForFallToFinish(bot, task);
  if (task) task.throwIfAborted();

  const stop = () => {
    // Ours, on purpose: the dig evidence in bot.js stays quiet about it.
    bot._digStopReason = 'preempted';
    try {
      bot.stopDigging();
    } catch {
      // not currently digging; nothing to stop
    }
  };
  // Unregister when the dig is over. A staircase is a hundred digs and a strip
  // tunnel is more; leaving one listener behind per dig meant a single mining
  // behavior accumulated hundreds of them, all of which then ran on the next
  // preempt. See Task.onAbort.
  const unwatch = task ? task.onAbort(stop) : null;

  try {
    await bot.dig(current);
  } catch (err) {
    // stopDigging makes dig() reject; that's an interruption, not a failure.
    if (task && task.aborted) return false;
    // Stopped by something other than our own task — pathfinder beginning a
    // dig of its own, another stopDigging. The block is simply still there,
    // which is what `false` already means to every caller. Throwing turned it
    // into "Behavior failed {gatherStone: Digging aborted}" and a no-op strike.
    if (err?.message === 'Digging aborted') return false;
    throw err;
  } finally {
    if (unwatch) unwatch();
  }

  // Confirm the block actually went away.
  //
  // bot.dig() resolves when the CLIENT finishes its break animation, not
  // when the server agrees. If the server rejects the break — protected
  // region, adventure mode, a desynced block — dig() still resolves happily
  // and every caller counts it as work done. That is indistinguishable from
  // success in the logs: "Gathered stone" over and over with an inventory
  // that never changes by a single item.
  const after = bot.blockAt(current.position);
  if (after && after.name === current.name) {
    logger.warn('Dig did not take effect — server rejected it?', {
      block: current.name,
      pos: current.position,
      held: bot.heldItem?.name ?? 'nothing',
    });
    return false;
  }
  return true;
}

/**
 * Walk onto a block we just mined, so its drop actually reaches us.
 *
 * goToBlock deliberately stops as soon as a block is *reachable* (up to
 * ~4 blocks away), which is right for digging and wrong for collecting:
 * items only fly to the player from about a block away, so everything
 * mined at arm's length was left lying on the floor. The bot gathered stone
 * eleven times in a row with its cobblestone count frozen at 2, then
 * repeatedly failed to path back to the individual drops and gave up on
 * them. Stepping forwards is what a player does and needs no pathfinding.
 */
/**
 * Where the item actually ended up, which is not where the block was.
 *
 * Breaking a log six blocks up a tree leaves the drop on the ground below,
 * not floating where the block used to be. Walking to the block position
 * therefore misses it completely — observed live as the bot chopping a log
 * and wandering off without it. If a real item entity is near the broken
 * block, go to THAT.
 */
function dropNear(bot, pos, radius = 4) {
  let best = null;
  let bestDist = radius;
  for (const id of Object.keys(bot.entities)) {
    const e = bot.entities[id];
    const name = e?.name?.toLowerCase();
    if (!e.isValid || (name !== 'item' && name !== 'item_stack')) continue;
    // Items fall, so look further down than up.
    const dy = e.position.y - pos.y;
    if (dy > 2 || dy < -12) continue;
    const d = Math.hypot(e.position.x - pos.x, e.position.z - pos.z);
    if (d < bestDist) {
      bestDist = d;
      best = e;
    }
  }
  return best;
}

/**
 * Walk onto a point, jumping over the lip that usually blocks the last metre.
 *
 * Split out so it can be retried after clearing an obstruction, rather than
 * being a one-shot buried inside stepOntoDrop.
 */
/**
 * Blocks the bot can stand on top of, and therefore build with.
 *
 * One definition, shared. There were three — `PLACEABLE` in shelter.js,
 * `PILLAR_BLOCKS` in threat.js and an implicit one here — and they had already
 * drifted apart: threat's was missing sandstone, so a bot in a desert with a
 * stack of it could seal a shelter roof but could not pillar away from an
 * enderman. Three lists of the same fact is three chances for one of them to
 * be quietly wrong.
 */
const PILLAR_MATERIAL = new Set([
  'dirt', 'coarse_dirt', 'rooted_dirt', 'grass_block', 'podzol', 'mycelium',
  'cobblestone', 'stone', 'deepslate', 'cobbled_deepslate', 'blackstone',
  'andesite', 'diorite', 'granite', 'tuff', 'calcite', 'sandstone',
  'red_sandstone', 'netherrack', 'mossy_cobblestone', 'smooth_basalt',
]);

function pillarItem(bot) {
  return findItem(bot, (i) => PILLAR_MATERIAL.has(i.name) || i.name.endsWith('_planks'));
}

// Never widen a pocket — or cut a ceiling — by breaking one of these. Liquids
// flood the hole we are standing next to; the rest are either unbreakable or
// worth more intact than the one cobblestone we came for.
const KEEP_INTACT = new Set([
  'lava', 'flowing_lava', 'water', 'flowing_water', 'bedrock', 'obsidian',
  'chest', 'trapped_chest', 'barrel', 'spawner', 'budding_amethyst',
  'diamond_ore', 'deepslate_diamond_ore', 'ancient_debris',
]);

/**
 * A ceiling we can take out of the way quickly and safely.
 *
 * Quickly: the fastest thing in the bag must break it inside CEILING_DIG_MAX_MS
 * — a bot with no pickaxe is not going to punch through stone to reach a drop.
 * Safely: never something worth more intact (KEEP_INTACT), never a falling
 * block (the next one drops straight into the gap), and never one with liquid
 * on its far side, which would come down the hole onto the bot.
 */
const CEILING_DIG_MAX_MS = 2500;
const LIQUIDS = new Set(['lava', 'flowing_lava', 'water', 'flowing_water']);

function fastestDigMs(bot, block) {
  if (typeof block.digTime !== 'function') return 0;
  let best = block.digTime(null, false, false, false);
  for (const item of bot.inventory.items()) {
    best = Math.min(best, block.digTime(item.type, false, false, false));
  }
  return best;
}

function clearableCeiling(bot, block) {
  if (!block || block.boundingBox !== 'block') return false;
  if (KEEP_INTACT.has(block.name) || /^(gravel|sand|red_sand)$|concrete_powder$/.test(block.name)) return false;
  // Copper overhead is a drop tidy throws away — see isUnwantedOre.
  if (isUnwantedOre(block.name)) return false;
  for (const [dx, dy, dz] of [[0, 1, 0], [1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1]]) {
    if (LIQUIDS.has(bot.blockAt(block.position.offset(dx, dy, dz))?.name)) return false;
  }
  return fastestDigMs(bot, block) <= CEILING_DIG_MAX_MS;
}

/**
 * One pillar step: jump, and put a block into the cell the feet just left.
 *
 * The server refuses a block placed into space the player still occupies, and
 * this used to press jump and place after a flat 180ms whether or not the bot
 * had actually risen. From the ground that is just enough — a jump is past one
 * block by the third tick — but pillarUp is called from walkOnto straight
 * after a 500ms hop, while the bot is still in the air, and each step waited
 * only 220ms before the next jump when a jump arc takes about 600ms. Either way
 * the jump had not happened yet, the feet were still in the target cell, and
 * the placement came back "the block is still air". Live on 09-24: five of six
 * attempts out in the open, far from any ceiling, gained nothing, and the one
 * two-step attempt gained exactly one block.
 *
 * So wait for the conditions instead of guessing a delay: on the ground before
 * jumping, feet above the cell before placing.
 */
// A full jump arc is about twelve ticks; past this the bot is not coming down
// (a ladder, water, a cobweb) and there is no jump to time.
const JUMP_ARC_MS = 700;
// Rising one block takes three ticks from the ground. Anything slower means a
// ceiling, or a jump that never started.
const RISE_MS = 400;

/**
 * In water or on a ladder there is no landing to wait for.
 *
 * Holding jump there swims or climbs upward instead. When this waited for
 * onGround regardless, a bot floating in a flooded staircase — exactly where
 * unstick sends it to pillar out — timed out every step, placed nothing, and
 * ran the whole sixty seconds before the director cut it off. Live on 09-24,
 * the first two and a half minutes of the session.
 */
function floating(bot) {
  return !!(bot.entity.isInWater || bot.entity.isOnLadder);
}

/**
 * Wait for a condition of the BODY, checked every physics tick as well as on
 * a 25ms timer.
 *
 * A jump is a sequence of ticks; a 25ms poll sampled it at whatever phase the
 * event loop happened to wake in, and during a stall it slept straight past
 * the apex. Checking on the tick means the check sees the position the
 * physics just produced. The timer stays for anything that does not tick (a
 * test fake, a bot whose physics is off), and the deadline is whichever of
 * wall time or the equivalent in ticks comes first — so a physics simulation
 * running faster than real time still gives up after the right number of
 * ticks.
 */
function waitUntil(predicate, ms, task, bot = null) {
  return new Promise((resolve, reject) => {
    const end = Date.now() + ms;
    const maxTicks = Math.ceil(ms / 50);
    let ticks = 0;
    let timer = null;
    let unsubscribe = null;
    let over = false;
    const done = (fn, value) => {
      if (over) return;
      over = true;
      clearInterval(timer);
      if (bot && typeof bot.removeListener === 'function') bot.removeListener('physicsTick', onTick);
      if (unsubscribe) unsubscribe();
      fn(value);
    };
    const check = () => {
      let ok;
      try {
        ok = predicate();
      } catch (err) {
        done(reject, err);
        return;
      }
      if (ok) done(resolve, true);
      else if (Date.now() >= end || ticks >= maxTicks) done(resolve, false);
    };
    function onTick() {
      ticks++;
      check();
    }
    if (task) {
      if (task.aborted) {
        reject(new AbortError(task.reason));
        return;
      }
      unsubscribe = task.onAbort((reason) => done(reject, new AbortError(reason)));
    }
    timer = setInterval(check, 25);
    if (bot && typeof bot.on === 'function') bot.on('physicsTick', onTick);
    check();
  });
}

function landed(bot, task) {
  return waitUntil(() => bot.entity.onGround || floating(bot), JUMP_ARC_MS, task, bot);
}

/**
 * How far clear of its cell the feet must be before a block goes into it.
 *
 * The server checks the placement against where IT last saw the bot, which is
 * a tick behind. Sending the moment the feet crossed the cell top was refused
 * five times in the 09-26 logs with the feet 0.001 to 0.17 above it and still
 * rising ("the block is still air"). A jump peaks 1.25 above the ground, so
 * 0.2 of margin is reachable — and at the apex, where the bot is not moving,
 * any clearance at all is enough.
 */
const PLACE_CLEARANCE = 0.2;
const APEX_VELOCITY = 0.05;

function clearToPlace(bot, cellTop) {
  const y = bot.entity.position.y;
  const vy = bot.entity.velocity?.y ?? 0;
  return y >= cellTop + PLACE_CLEARANCE || (y >= cellTop && vy <= APEX_VELOCITY);
}

async function jumpAndPlaceBelow(bot, standingOn, filler, task) {
  // A mushroom, flower or torch in the feet cell has no collision, so nothing
  // else notices it, but it is not replaceable either: the server refuses to
  // put a block where it stands ("the block is still brown_mushroom", live
  // 09-24). They all break in one hit.
  const feet = bot.blockAt(standingOn.position.offset(0, 1, 0));
  if (feet && feet.boundingBox === 'empty' && !/air$/.test(feet.name) && !LIQUIDS.has(feet.name)) {
    if (!(await digBlock(bot, feet, task))) return false;
  }

  // NOT FROM WATER. There is no jump in water, only a slow swim-up, and a
  // floating body bobs between the water block's bottom and 0.8 above it —
  // measured on the real physics (test/waterSim.test.js). The feet can never
  // clear the cell, so every attempt is a refusal: "the block is still water",
  // over and over, in the flooded ravine of 09-26. Getting out of water is
  // leaveWater's job (a landing block beside the bot, not under it).
  if (bot.entity.isInWater) return false;

  await equipIfDifferent(bot, filler);
  const clearOfCell = standingOn.position.y + 2;
  try {
    const jumpedAt = Date.now();
    bot.setControlState('jump', true);
    if (!(await waitUntil(() => clearToPlace(bot, clearOfCell), RISE_MS, task, bot))) return false;
    // Taken NOW, as the placement goes out. The first version read these after
    // the server's refusal came back — by which time the bot had landed, so the
    // one refusal it caught (15:41:51 on 09-24) said feetY 64 about a bot the
    // check had just seen at 65, and explained nothing.
    const atSend = {
      feetY: Number(bot.entity.position.y.toFixed(3)),
      onGround: !!bot.entity.onGround,
      velocityY: Number((bot.entity.velocity?.y ?? 0).toFixed(3)),
      msSinceJump: Date.now() - jumpedAt,
    };
    const sentAt = Date.now();
    const placed = await tryPlaceBlock(bot, standingOn, new Vec3(0, 1, 0));
    // The server still refuses some of these with the feet reported clear of
    // the cell, and nothing in the log says why. Record what we believed at
    // the moment of the refusal, so the next live run can.
    if (!placed) {
      logger.info('Pillar step refused', {
        cellTop: clearOfCell,
        atSend,
        inWater: !!bot.entity.isInWater,
        answeredInMs: Date.now() - sentAt,
      });
    }
    return placed;
  } finally {
    bot.setControlState('jump', false);
  }
}

/**
 * Build straight up, one block at a time.
 *
 * A jump clears 1.25 blocks. Anything above that has to be BUILT to, and the
 * bot did not know that: walkOnto's only answer to "I am not getting closer"
 * was to hold jump, so a drop sitting two or three blocks up — on a ledge, on
 * the lip of the hole it had just dug, on top of the stone it had just mined —
 * produced a bot hopping on the spot until the timeout expired, every time,
 * and the item despawned above its head.
 *
 * Returns how many blocks it actually gained.
 */
async function pillarUp(bot, task, blocks) {
  // walkOnto calls this mid-hop; measured from there, the gain is short by
  // however high the hop happened to be.
  await landed(bot, task);
  const startY = bot.entity.position.y;

  for (let i = 0; i < blocks; i++) {
    if (task) task.throwIfAborted();
    const filler = pillarItem(bot);
    if (!filler) break;

    // Before reading the ground: in mid-air, groundUnder answers for whatever
    // cell the bot happens to be falling past.
    if (!(await landed(bot, task))) break;
    const standingOn = groundUnder(bot);
    if (!standingOn) break;

    // THE CEILING FIRST, or the jump goes nowhere.
    //
    // To rise one block the bot's head has to move into the cell above it, and
    // in a two-high tunnel — which is where drops most often end up out of
    // reach, on the lip of a vein just mined overhead — that cell is stone. The
    // jump hits it, the bot never leaves its own cell, and the block cannot be
    // placed into space the bot still occupies: "Server refused to place …
    // the block is still air". Across every logged session this reached a drop
    // with `gained: 0` in 25 of 35 attempts. unstick's pillarOut has cleared
    // this same cell all along, and it is the one that works.
    const ceiling = bot.blockAt(standingOn.position.offset(0, 3, 0));
    if (ceiling && ceiling.boundingBox === 'block') {
      if (!clearableCeiling(bot, ceiling)) break;
      if (!(await digBlock(bot, ceiling, task))) break;
    }

    // A refused placement means another identical attempt will be refused too.
    if (!(await jumpAndPlaceBelow(bot, standingOn, filler, task))) break;
  }

  // Measured standing, not at the top of the last jump.
  await landed(bot, task);
  return Math.max(0, bot.entity.position.y - startY);
}

// How far above us something has to be before jumping cannot possibly reach
// it. A jump clears 1.25 blocks, so anything past that needs building to.
const JUMP_REACH = 1.25;
// How long to flail before concluding the obstacle is height, not a lip.
const STUCK_BEFORE_PILLAR_MS = 500;
// A jump arc is about twelve ticks; cancelling partway leaves the bot back
// where it started. See the matching note in nav.js.
const JUMP_HOLD_MS = 500;

async function walkOnto(bot, target, task, timeoutMs, item = null) {
  const deadline = Date.now() + timeoutMs;
  let closest = bot.entity.position.distanceTo(target);
  let lastGainAt = Date.now();
  let pillared = false;
  let jumpUntil = 0;

  try {
    bot.setControlState('sprint', false);
    while (Date.now() < deadline) {
      if (task) task.throwIfAborted();
      // The item vanishing IS the success condition, and it often happens
      // before we reach the coordinate — pickup has about a block of radius.
      // Without this the bot walks the full timeout after already having the
      // thing in its inventory.
      if (item && !item.isValid) return true;
      const d = bot.entity.position.distanceTo(target);
      if (d < 0.9) return true;

      // Walking blindly into a wall is a real possibility in a freshly dug
      // shaft, and it used to burn the whole timeout achieving nothing.
      // Jumping clears a one-block lip, which is the usual obstacle.
      // Same rule as walkTheLastBit: once committed to a hop, let it finish.
      // A jump makes a tenth of a block of progress instantly, so cancelling
      // on progress cancels every jump partway through and the bot bounces on
      // the spot instead of clearing the step.
      if (Date.now() < jumpUntil) {
        bot.setControlState('jump', true);
      } else if (d < closest - 0.1) {
        closest = d;
        lastGainAt = Date.now();
        // Release the jump once we are moving again. It was never released,
        // so the first stall turned the rest of the approach into a hop —
        // which is slower, noisier and, next to a ledge, how the bot launches
        // itself off one.
        bot.setControlState('jump', false);
      } else if (Date.now() - lastGainAt > STUCK_BEFORE_PILLAR_MS) {
        const height = target.y - bot.entity.position.y;

        // HEIGHT, not a lip. Jumping cannot reach it, so build.
        if (!pillared && height > JUMP_REACH) {
          pillared = true; // one attempt per approach; it either works or it doesn't
          bot.setControlState('forward', false);
          bot.setControlState('jump', false);
          const gained = await pillarUp(bot, task, Math.ceil(height));
          logger.info('Built up to reach a drop', {
            wanted: Number(height.toFixed(1)),
            gained: Number(gained.toFixed(1)),
          });
          lastGainAt = Date.now();
          closest = bot.entity.position.distanceTo(target);
          continue;
        }

        jumpUntil = Date.now() + JUMP_HOLD_MS;
        bot.setControlState('jump', true);
      }

      await bot.lookAt(target, true).catch(() => {});
      bot.setControlState('forward', true);
      await sleep(80, task);
    }
  } finally {
    bot.setControlState('forward', false);
    bot.setControlState('jump', false);
  }
  return bot.entity.position.distanceTo(target) < 0.9;
}

/**
 * Cut headroom above a drop we cannot walk into.
 *
 * Mining exposed stone out of a hillside leaves the cobblestone sitting in a
 * one-block alcove with a stone ceiling. The bot needs two blocks of
 * clearance to stand anywhere, so it cannot enter — it just presses forward
 * into the wall until the timeout, and the item despawns where it lies.
 *
 * Measured exactly: "sawItemEntity: true, startedAt: 2, endedAt: 2", over and
 * over, with the cobblestone counter frozen while "Gathered stone" was logged
 * every few seconds. Breaking the block above the drop is what a player does
 * without thinking about it, and it turns the alcove into a doorway.
 */
async function openPocketTo(bot, target, task) {
  const dest = target.floored();
  if (bot.entity.position.distanceTo(target) > 3.5) return false;

  let opened = false;
  // Head height over the drop, then head height over the step between us and
  // it — those two are what a 1x1 alcove is missing.
  const between = bot.entity.position.floored().plus(dest).scaled(0.5).floored();
  for (const at of [dest.offset(0, 1, 0), between.offset(0, 1, 0)]) {
    if (task) task.throwIfAborted();
    const block = bot.blockAt(at);
    if (!block || block.boundingBox === 'empty') continue;
    if (KEEP_INTACT.has(block.name) || isUnwantedOre(block.name)) continue;
    if (!bot.canDigBlock(block)) continue;
    if (await digBlock(bot, block, task)) opened = true;
  }
  return opened;
}

/**
 * Where a drop we have not seen yet will end up: it falls.
 *
 * With no item entity in view, this used to aim at the broken block's own cell.
 * For a block below or beside the bot that is where the item is. For one ABOVE
 * it — iron in a tunnel ceiling, a log halfway up a trunk — the cell is now a
 * hole in the air two or three blocks up, and the item has already fallen,
 * usually straight onto the bot, which picks it up. The bot then pillared up
 * towards the empty hole: live on 09-24, three "Built up to reach a drop" in
 * forty seconds under ceiling iron, each `sawItemEntity: false`, while the iron
 * count rose 9 → 11 → 13. The first run's pillars under trees were the same
 * thing, chasing logs it had chopped from above.
 */
const DROP_FALL_LIMIT = 16;

function whereItLands(bot, pos) {
  let cell = pos.floored();
  for (let i = 0; i < DROP_FALL_LIMIT; i++) {
    const below = bot.blockAt(cell.offset(0, -1, 0));
    // Unloaded counts as ground: better to aim short than into the void.
    if (!below || below.boundingBox === 'block') break;
    cell = cell.offset(0, -1, 0);
  }
  return cell.offset(0.5, 0, 0.5);
}

// One pillar's worth: a jump clears 1.25, and walkOnto builds at most this
// many blocks before giving up on a drop above it.
const MAX_DROP_RISE = 3;

/**
 * How long a disturbed gravel column takes to finish falling into a cell.
 *
 * A column does not come down all at once: dig the bottom block and the rest
 * is a falling ENTITY for a few ticks, so the cells read as air. Walk in during
 * that window and the column lands in the bot's head cell. The strip corridor
 * waits this long before stepping (see mine.js); so does the walk to a drop,
 * which is how the bot was buried twice in 1.4 seconds at 14:25:47 on 09-24 —
 * `collect` walked straight back in under the gravel it had just disturbed.
 */
const GRAVEL_SETTLE_MS = 400;

function fallingBlockNear(bot, pos) {
  return Object.values(bot.entities ?? {}).some((e) => e?.name === 'falling_block'
    && e.position && e.position.distanceTo(pos) < 3);
}

async function stepOntoDrop(bot, pos, task, opts = {}) {
  // Minecraft has no item attraction: the bot's hitbox has to actually
  // touch the item, which is roughly one block. A 1.5 threshold therefore
  // skipped the walk while still being too far to collect — the bot mined
  // stone next to itself, decided it was close enough, and left the
  // cobblestone lying there.
  const { minDistance = 1.0, maxDistance = 5, timeoutMs = 1500 } = opts;

  // Prefer the real item entity over the hole we just made.
  const item = dropNear(bot, pos);
  const target = item ? item.position.offset(0, 0, 0) : whereItLands(bot, pos);

  // 3D distance, deliberately. Minecraft's pickup radius is about one block
  // horizontally and half a block vertically, but goNear() considers itself
  // arrived at a horizontal distance of 1 with up to THREE blocks of height
  // difference. Mining downwards drops the item into the hole, the bot stops
  // at the rim, reports success — and the item is never collected. That is
  // why the cobblestone counter sat at 0 while the bot mined stone all day
  // with a pickaxe in hand and 28 free inventory slots.
  const distance = bot.entity.position.distanceTo(target);
  if (distance < minDistance || distance > maxDistance) return;

  // TOO HIGH TO BE WORTH IT. Ore mined three to five blocks up a wall drops
  // onto a ledge, and the chase was walk, pathfind, open a pocket, walk again,
  // with a pillar attempt in the middle — up to six seconds a drop, and
  // "Built up to reach a drop" gained nothing in 10 of 16 tries across the
  // 09-24 logs. Past what one pillar can reach, a single item is not worth it.
  if (fallingBlockNear(bot, target)) {
    await sleep(GRAVEL_SETTLE_MS, task);
    // Landed where we were going: the drop is under it now, and the gravel
    // would only be dug out to fall again. Not worth the head.
    const head = bot.blockAt(target.floored().offset(0, 1, 0));
    if (head?.boundingBox === 'block') return;
  }

  const rise = target.y - bot.entity.position.y;
  if (rise > MAX_DROP_RISE) {
    logger.info('Leaving a drop on a ledge out of reach', {
      rise: Number(rise.toFixed(1)),
      item: item ? 'seen' : 'expected',
    });
    return;
  }

  // CLEAR THE HEADROOM FIRST, rather than after two failed attempts.
  //
  // This is the "it digs the block below but not the one blocking its head"
  // problem, and it is not a rare case — it is what mining ANYTHING below or
  // beside you produces. Breaking one block leaves a gap one block tall; the
  // bot is nearly two blocks tall, so it cannot get in. The drop sits there
  // in a slot it can see and not reach.
  //
  // The machinery to fix that already existed, but only as a last resort:
  // walk for a second and a half, fail, hand it to pathfinder for another two
  // and a half, fail, and only THEN cut the headroom. Four seconds of
  // flailing before trying the thing that works, on every single drop that
  // lands in a pocket. Doing it up front turns the alcove into a doorway
  // before the bot sets off, and gives those four seconds back.
  //
  // Only when the cell we are aiming at is actually roofed — openPocketTo is
  // a no-op otherwise, so an ordinary drop on open ground costs two block
  // reads.
  await openPocketTo(bot, target, task);

  await walkOnto(bot, target, task, timeoutMs, item);
  // Give the server a moment to hand us the item.
  await sleep(250, task);
  if (item && !item.isValid) return;
  if (bot.entity.position.distanceTo(target) <= 1.2) return;

  // Walking got us nowhere. The usual reason, confirmed by logging the
  // before/after distances, is a drop sitting almost directly BELOW the bot:
  // the horizontal direction to it is then nearly undefined, so "hold
  // forward" picks an arbitrary yaw and the distance never changes
  // (startedAt 2.0, endedAt 2.0, over and over).
  //
  // Pathfinder can drop down a ledge or walk around a lip, which manual
  // control cannot, so hand it the last couple of blocks.
  //
  // The time limit is goNear's OWN, not a withDeadline wrapped around it.
  // withDeadline stops WAITING at 2.5s; it does not stop the walk. The
  // abandoned driveTo kept its pathfinder goal for up to twenty seconds while
  // this function moved on to digging the pocket open, and its `finally` then
  // cleared the goal mid-dig — pathfinder's resetPath calls bot.stopDigging()
  // whenever it had been digging, and mineflayer has one dig slot, so it was
  // OUR dig that died. Both logged "Behavior failed: gatherStone — Digging
  // aborted" landed ~130ms after "Could not reach the drop", from here.
  try {
    await goNear(bot, target, 1, task, { timeoutMs: 2500 });
    await sleep(200, task);
  } catch (err) {
    if (task && task.aborted) throw err;
    // Not fatal on its own — the pocket-opening below is the real answer for
    // the common case, and goNear cannot help with it.
  }
  if (item && !item.isValid) return;
  if (bot.entity.position.distanceTo(target) <= 1.2) return;

  // One more go at the headroom. The up-front pass ran before we moved, and
  // we are somewhere else now — the block that is roofing us in may be a
  // different one, and the drop may have settled since.
  if (await openPocketTo(bot, target, task)) {
    await walkOnto(bot, target, task, 1200, item);
    await sleep(200, task);
    if (item && !item.isValid) return;
    if (bot.entity.position.distanceTo(target) <= 1.2) return;
  }

  logger.info('Could not reach the drop', {
    sawItemEntity: !!item,
    startedAt: Number(distance.toFixed(1)),
    endedAt: Number(bot.entity.position.distanceTo(target).toFixed(1)),
  });
}

const PLACE_TIMEOUT_MS = 2500;

/**
 * Place a block, without risking a hang.
 *
 * bot.placeBlock waits for the server to confirm, and a refused or lost
 * placement can leave the promise pending indefinitely. Every caller here
 * is a recovery path — pillaring out of a pit, sealing a shelter roof,
 * putting down a crafting table — so hanging is the worst possible outcome:
 * the bot freezes in exactly the situation it was trying to escape.
 *
 * Returns true only if the block is actually there afterwards.
 */
async function tryPlaceBlock(bot, reference, faceVector) {
  // Lazy: eating.js requires this module.
  const release = require('./eating').pauseAutoEat(bot, 'placing');
  try {
    // The caller equipped a block; a meal may have taken the hand since. At
    // 14:06:10 on 09-26 that was 67ms, and the server was asked to place
    // cooked_mutton. Put the block back rather than place whatever is held.
    const held = bot.heldItem;
    const wanted = bot.lastEquippedName;
    if (wanted && held?.name !== wanted && (!held || bot.registry?.foodsByName?.[held.name])) {
      const again = findItem(bot, (i) => i.name === wanted);
      if (again) await equipIfDifferent(bot, again);
    }
    // Nothing in hand is not a placement, it is an error message from the
    // server about a placement — say what actually happened.
    if (!bot.heldItem) {
      logger.info('Nothing in hand to place', { wanted: wanted ?? null });
      return false;
    }
    await withDeadline(
      bot.placeBlock(reference, faceVector),
      PLACE_TIMEOUT_MS,
      'place block',
    );
  } catch (err) {
    logger.info('Placement failed', { error: err.message });
    return false;
  } finally {
    release();
  }
  return true;
}

/**
 * Put the best weapon we own in hand, and CHECK that it got there.
 *
 * "Still attacking with fists while holding a stone sword", and "switched to
 * a wooden sword" — both are this function failing quietly. Selection was
 * never the problem: tierRank orders stone ahead of wooden correctly. The
 * problem is that equipping is a window transaction that can simply not
 * happen, and equipIfDifferent swallows that and returns false, so the bot
 * went into the fight holding whatever it had before — a pickaxe, a stack of
 * dirt, or nothing.
 *
 * So: verify the postcondition and retry once, the same way digBlock and
 * craftItem now do. One retry is enough in practice; more than that and
 * something is wrong that another attempt will not fix.
 */
/**
 * Damage per hit and the cooldown that limits how often it lands.
 *
 * An axe is not a worse sword, it is a different weapon: it hits harder and
 * swings slower. A stone axe does 9 against a stone sword's 5, but a sword
 * recovers in 625ms against an axe's full second — so on sustained damage they
 * are close, and the sword pulls ahead at the same tier.
 *
 * Which matters here is that "no sword" used to mean "fists". The bot would
 * lose its sword mid-fight, or spawn after a death holding the axe it had been
 * chopping with, and swing for 1 damage while carrying a weapon that does nine.
 */
const WEAPON_STATS = {
  netherite_sword: [8, 625], diamond_sword: [7, 625], iron_sword: [6, 625],
  stone_sword: [5, 625], golden_sword: [4, 625], wooden_sword: [4, 625],
  netherite_axe: [10, 1000], diamond_axe: [9, 1000], iron_axe: [9, 1000],
  stone_axe: [9, 1000], golden_axe: [7, 1000], wooden_axe: [7, 1000],
};

function weaponDps(item) {
  const stats = WEAPON_STATS[item?.name];
  if (!stats) return 0;
  return (stats[0] * 1000) / stats[1];
}

/**
 * How much better an axe has to be before we spend it fighting.
 *
 * The axe is also the bot's wood supply, and wood is what tool handles and
 * crafting tables are made of — so a marginal damage gain is not worth wearing
 * it out. A whole point of damage per second is: that is a wooden sword being
 * swapped for an iron axe, not a stone sword being swapped for a stone axe.
 */
const AXE_MARGIN = 1.0;

/** The weapon we should be holding, sword unless an axe is clearly better. */
function bestWeapon(bot) {
  const sword = bestToolOfType(bot, 'sword');
  const axe = bestToolOfType(bot, 'axe');
  if (!sword) return axe;
  if (!axe) return sword;
  return weaponDps(axe) > weaponDps(sword) + AXE_MARGIN ? axe : sword;
}

async function equipBestWeapon(bot) {
  const weapon = bestWeapon(bot);
  if (!weapon) return null;

  for (let attempt = 0; attempt < 2; attempt++) {
    if (bot.heldItem && bot.heldItem.type === weapon.type) return weapon;
    await equipIfDifferent(bot, weapon);
    if (bot.heldItem && bot.heldItem.type === weapon.type) return weapon;
    await sleep(120);
  }

  logger.warn('Could not get the weapon into my hand', {
    wanted: weapon.name,
    holding: bot.heldItem?.name ?? 'nothing',
  });
  return bot.heldItem ? weapon : null;
}

/**
 * Is the right weapon still in hand?
 *
 * Checked during a fight rather than only at the start, because tools break.
 * A stone sword lasts 131 hits and this bot swings constantly — when it goes,
 * mineflayer silently leaves the hand empty and every subsequent swing does
 * one damage. That is the other half of "attacking with fists".
 */
function holdingBestWeapon(bot) {
  const best = bestWeapon(bot);
  if (!best) return true; // nothing better exists; fists are all we have
  return !!bot.heldItem && bot.heldItem.type === best.type;
}

function inventorySummary(bot) {
  const counts = {};
  for (const item of bot.inventory.items()) {
    counts[item.name] = (counts[item.name] || 0) + item.count;
  }
  return counts;
}

function armorSummary(bot) {
  return ['head', 'torso', 'legs', 'feet']
    .map((slot) => bot.inventory.slots[bot.getEquipmentDestSlot(slot)]?.name)
    .filter(Boolean);
}

// bot.craft() waits on an inventory-update packet with a 20 SECOND internal
// timeout, and it does hang: "Event updateSlot:0 did not fire within timeout
// of 20000ms" was observed live, freezing the bot mid-craft. Twenty seconds
// of standing still is exactly the AFK this project is trying to eliminate,
// so cut it off far sooner and let the behavior try again.
// Long enough for a slow server, far short of bot.craft's own 20s hang.
// The first value here was 4s, which turned out to be under the real round
// trip often enough that crafting failed constantly — and each failed
// attempt had already burned a log turning it into planks.
const CRAFT_TIMEOUT_MS = 9000;
/**
 * How long to wait for the inventory to catch up with a craft.
 *
 * Two seconds is generous for a local LAN world and still far inside the
 * director's patience. The cost of waiting too little is spending the
 * materials twice — the caller is told the craft failed and buys them again —
 * and the cost of waiting too long is a fraction of a second.
 */
const CRAFT_SETTLE_MS = 2000;
/**
 * How close we have to be to a crafting table to use it.
 *
 * THIS NUMBER IS THE BUG THAT BROKE THE WHOLE BUILD, so it gets its own note.
 *
 * bot.craft with a table does `bot.activateBlock(table)` and then waits for a
 * `windowOpen` packet. The server only opens the window if the block is within
 * interaction reach — about 4.5 blocks — and if it is not, it simply ignores
 * the packet. No error comes back. mineflayer then sits on `once(bot,
 * 'windowOpen')` for its full twenty seconds.
 *
 * `ensureTable` had a short-circuit that returned any crafting table within
 * EIGHT blocks without walking to it, on the grounds that a table we can see is
 * one we can reach. True for pathfinding, false for crafting. So `gear` was
 * handed a table twice as far away as the reach allows, every craft against it
 * hung, and — because mineflayer keeps the opened window in a module-level
 * variable — the poisoned window then broke every SUBSEQUENT craft too,
 * including the table-free ones for planks and sticks, which click on
 * `bot.currentWindow` and got the stale table instead of the inventory.
 *
 * The visible symptoms were all downstream of it: "Craft did not complete
 * {stick, exceeded 9000ms}" on repeat, wood draining away into half-finished
 * plank batches, `gear` and `woodUrgent` trading the wheel forever with
 * `need: wood` on every status line, and the bot standing perfectly still for
 * nine seconds at a time — which is how a zombie killed one holding full iron.
 */
const TABLE_REACH = 3.2;

/**
 * The most times this recipe can be run with what we are holding.
 *
 * bot.recipesFor only checks that ONE craft is affordable, and bot.craft then
 * loops `count` times regardless — so asking for four when we can afford two
 * throws 'missing ingredient' on the third pass, after two crafts have already
 * happened. The whole call then reports failure, and the caller retries from
 * scratch and spends more.
 */
function affordableCrafts(bot, recipe) {
  if (typeof bot.inventory?.count !== 'function') return 1;
  let most = Infinity;
  for (const d of recipe.delta ?? []) {
    if (d.count >= 0) continue; // a product, not an ingredient
    const have = bot.inventory.count(d.id, d.metadata);
    most = Math.min(most, Math.floor(have / -d.count));
  }
  return most === Infinity ? 1 : most;
}

/**
 * Shut a window we are not using.
 *
 * mineflayer's craft keeps the crafting-table window it opened in a
 * module-level variable and reuses it, and `clickWindow` always acts on
 * `bot.currentWindow`. A window left open by a craft that timed out therefore
 * silently redirects the next craft's clicks — including a 2x2 inventory craft
 * that wants nothing to do with a table. Nothing recovers from that except
 * closing it.
 */
async function closeStaleWindow(bot, keepTable) {
  const open = bot.currentWindow;
  if (!open) return;
  // A table window we are about to use again is not stale.
  if (keepTable && open.type && String(open.type).includes('crafting')) return;
  try {
    bot.closeWindow(open);
  } catch {
    // already gone
  }
  await sleep(60);
}

/** Crafts `count` of an item if a recipe is currently satisfiable. */
async function craftItem(bot, itemName, count, craftingTable, task = null) {
  const def = bot.registry.itemsByName[itemName];
  if (!def) return false;

  // Prove we can actually use the table BEFORE opening a transaction against
  // it. Failing here costs the caller one walk; not failing here costs nine
  // seconds of standing still and poisons the next craft as well.
  if (craftingTable) {
    const centre = craftingTable.position.offset(0.5, 0.5, 0.5);
    const distance = bot.entity.position.distanceTo(centre);
    if (distance > TABLE_REACH) {
      logger.info('Too far from the crafting table to use it', {
        item: itemName,
        distance: Number(distance.toFixed(1)),
        needToBeWithin: TABLE_REACH,
      });
      return false;
    }
    await bot.lookAt(centre, true).catch(() => {});
  }

  const recipes = bot.recipesFor(def.id, null, 1, craftingTable || null);
  if (recipes.length === 0) return false;
  const recipe = recipes[0];

  // Never ask for more passes than the ingredients cover — see above.
  const wanted = Math.max(1, Math.floor(count) || 1);
  const passes = Math.max(1, Math.min(wanted, affordableCrafts(bot, recipe)));

  // Stand still to craft.
  //
  // Crafting is a window transaction, and doing it while pathfinder is
  // still steering means the inventory updates race against movement
  // packets — which is how a craft that normally takes a few hundred
  // milliseconds ends up missing a multi-second deadline.
  try {
    bot.pathfinder.setGoal(null);
  } catch {
    // pathfinder may not be active
  }
  bot.clearControlStates();
  await closeStaleWindow(bot, !!craftingTable);

  const before = itemCount(bot, itemName);
  const ingredientsBefore = ingredientCount(bot, recipe);

  // A meal is a hand swap and a use-item in the middle of a window
  // transaction; hold it until the craft is done.
  const releaseEating = require('./eating').pauseAutoEat(bot, 'crafting');
  try {
    await withDeadline(
      bot.craft(recipe, passes, craftingTable || null),
      CRAFT_TIMEOUT_MS,
      `craft ${itemName}`,
      task,
    );
  } catch (err) {
    // Clean up after ourselves, whatever went wrong. A craft that threw or
    // timed out may well have left a window open, and leaving it there breaks
    // everything that crafts after us rather than only this call.
    await closeStaleWindow(bot, false);
    logger.info('Craft did not complete', { item: itemName, error: err.message });
    // Interrupted is not refused. Returning false here made gear record a
    // strike, "why: recipe refused", for a stone pickaxe that leaveWater had
    // merely preempted (09-26 13:50:58) — and then leave it alone for a while.
    if (isInterruption(err)) throw err;
    return false;
  } finally {
    releaseEating();
  }

  // Confirm the item actually arrived, the same way digBlock confirms the
  // block actually went away.
  //
  // bot.craft() resolves on its own schedule, and bot.inventory lags behind
  // it — so a caller that immediately re-reads the inventory still sees the
  // old contents and concludes the craft never happened. `gear` then proposes
  // the same tool again, and again: caught live as four stone pickaxes and
  // six batches of sticks crafted inside two seconds, burning logs the bot
  // was simultaneously reporting a shortage of.
  //
  // The window used to be 600ms, which is under the real round trip often
  // enough to matter: the craft SUCCEEDED, the materials were spent, and we
  // reported failure — so the caller spent them again. That is where the pile
  // of surplus stone pickaxes came from.
  for (let waited = 0; waited < CRAFT_SETTLE_MS; waited += 100) {
    await sleep(100, task);
    if (itemCount(bot, itemName) > before) {
      logger.action('Crafted', { item: itemName, count: passes });
      return true;
    }
  }

  // The ingredients went, so the server made it: the bag is just behind.
  //
  // Live on 09-26 20:46–20:49 a stone sword "failed" at 20:47:20 and was in
  // the hand by 20:49:03; in between, gear struck it out four times as "no
  // crafting table" and re-crafted planks it already had. Reporting that as a
  // failure is what spends the materials twice.
  if (ingredientCount(bot, recipe) < ingredientsBefore) {
    logger.info('Crafted — the item has not shown up in the bag yet', { item: itemName, held: before });
    return true;
  }

  logger.info('Craft reported success but nothing appeared', {
    item: itemName,
    held: before,
  });
  return false;
}

/** How many of a recipe's ingredients the bag holds, all kinds together. */
function ingredientCount(bot, recipe) {
  const ids = new Set((recipe?.delta ?? []).filter((d) => d.count < 0).map((d) => d.id));
  if (ids.size === 0) return 0;
  return bot.inventory.items()
    .filter((i) => ids.has(i.type))
    .reduce((sum, i) => sum + i.count, 0);
}

module.exports = {
  WOOD_SPECIES,
  STONE_MATERIAL,
  itemCount,
  countAny,
  hasItem,
  findItem,
  plankNames,
  woodUnits,
  tierRank,
  bestToolOfType,
  durabilityLeft,
  toolIsWornOut,
  countUsableTools,
  toolTypeForBlock,
  equipIfDifferent,
  // Every slot change is a window transaction that can hang for twenty
  // seconds, and a hang during a fight is a death — see equipTo.
  equipTo,
  unequipHand,
  digBlock,
  stepOntoDrop,
  tryPlaceBlock,
  // One definition of "a block I can stand on", shared with shelter and
  // threat — they each had their own and the copies had already drifted.
  PILLAR_MATERIAL,
  pillarItem,
  pillarUp,
  jumpAndPlaceBelow,
  GRAVEL_SETTLE_MS,
  landed,
  equipBestWeapon,
  holdingBestWeapon,
  // One answer to "what do we fight with", so combat, the threat briefing and
  // the status line cannot disagree about whether the bot is armed.
  bestWeapon,
  weaponDps,
  WEAPON_STATS,
  inventorySummary,
  armorSummary,
  craftItem,
};
