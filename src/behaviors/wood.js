const logger = require('../logger');
const worldMemory = require('../memory');
const { sleep, isInterruption } = require('../task');
const { goToBlock, goNearXZ } = require('../nav');
const { findNearestTiered } = require('../blocks');
const {
  digBlock, WOOD_SPECIES, stepOntoDrop, woodUnits,
} = require('../inventory');
// One number for "enough wood", shared with the descent gate that defines it.
// mine.js does not require this file, so there is no cycle.
const { DEEP_TRIP_NEEDS } = require('./mine');
// ...and the same for "is there a tool we could be building instead". gear.js
// requires only stations and inventory, so this is a cycle-free direction too.
const { nextGoal } = require('./gear');
// director.js requires only the logger and task, so this is cycle-free too.
const { MAX_BEHAVIOR_MS } = require('../director');
// The hunger at which hunting unlocks without a stone weapon — woodUrgent
// hands over at exactly that bar. hunt.js does not require this file.
const { CANNOT_SPRINT_FOOD } = require('./hunt');

/**
 * The bot's default activity: keep a wood stock up.
 *
 * Lowest priority, so it only runs when nothing more important is going on.
 * One tree per run — the whole tree, see treeLogs — and every dig is
 * interruptible, so the director still re-evaluates between logs.
 */

const LOG_NAMES = WOOD_SPECIES.map((s) => `${s}_log`);
/**
 * Close first, and only widen when close is empty — see findNearestTiered.
 *
 * A flat 48-block sweep was the most expensive thing the bot did. findBlocks
 * scans whole 16-block sections and only stops early once it has enough hits,
 * so in a forest it was running the full 4096-position inner loop over a
 * hundred-odd sections several times a second, synchronously, on the same
 * thread as pathfinding and combat. In a treeless area — where it finds
 * nothing and therefore never stops early — it paid the whole bill for no
 * result at all.
 */
const SEARCH_RADII = [16, 32, 48];
const SCAN_THROTTLE_MS = 600;
/**
 * How long to wait before scanning again after coming up empty.
 *
 * The throttle above is right when there are trees about: the answer changes
 * as the bot walks. It is badly wrong when there are none, because then the
 * bot pays the most expensive version of the search — the one that cannot
 * stop early — over and over for an answer that is still going to be "no
 * trees". Backing off to a couple of seconds costs nothing (walking to a tree
 * takes far longer than that) and hands the event loop back.
 */
const EMPTY_SCAN_THROTTLE_MS = 2500;
/**
 * "Critical" means "not enough to do the next thing", not "none left".
 *
 * This was 4, and the gap between 4 and the sixteen units a descent needs was
 * a dead zone with nothing in it. Watched live at wood 4, cobble 15:
 *
 *   woodUrgent (47)  stands down — four units is not zero
 *   forage (46)      stands down — the hunger bar is still full
 *   resupply (43)    fires: "missing food, wood", and climbs to the surface
 *   gatherStone (28) still wants five more cobble, so it digs back down
 *   resupply         fires again, because digging down is being underground
 *
 * Round and round, for minutes, each behavior individually correct. `wood`
 * itself sits at priority 10 and never once got the wheel, because
 * gatherStone at 28 always had something to do. Four minutes of that produced
 * three more cobblestone.
 *
 * Tying the threshold to what the descent actually requires closes the gap:
 * either the bot has enough wood to proceed, or getting wood is the most
 * urgent thing it can do. One tree is four to seven logs — sixteen to
 * twenty-eight units — so this is a short burst, not a career.
 */
const CRITICAL_WOOD = DEEP_TRIP_NEEDS.planks;

/**
 * Once it starts restocking, FILL UP — do not stop at the trigger.
 *
 * Without hysteresis the two thresholds are the same number, so the bot tops
 * up to exactly the bar and is one plank away from doing it all again.
 * Reported directly: it surfaced from a mine, "gets a single piece of log and
 * starts mining back down again", then came back up for another. Each of
 * those round trips is forty blocks of climbing for four planks.
 *
 * Two trees' worth. A tree is four to seven logs, so this is one or two
 * chops, and it buys enough margin that the next trip down is not interrupted
 * by the same errand.
 */
const RESTOCK_WOOD = CRITICAL_WOOD * 2;

/**
 * The filler, `wood` at priority 10, stops where a restock does, in the same
 * unit. It used to count logs only (32 of them, 128 planks) — so a bag of
 * planks read as empty and the bot kept chopping long after woodUrgent was
 * satisfied, twice over, in a different unit.
 */
const WOOD_TARGET = RESTOCK_WOOD;

/**
 * Only a handful of candidates are ever used — the loop below takes the first
 * trunk base that is not blacklisted. Asking for 24 made findBlocks keep
 * scanning layers it did not need.
 */
const CANDIDATE_COUNT = 8;

// How long to leave a log alone after failing to reach it. Same idea as the
// ore and item-drop blacklists: without one, findNearest keeps returning the
// SAME unreachable log, so the bot walks at a tree across a ravine, stalls
// after six seconds, and does it again forever. Observed live as a steady
// stream of "Behavior failed: navigation stalled" with no wood ever gathered
// — which starved the entire tool progression, so the bot never got a sword.
const UNREACHABLE_HOLD_MS = 45000;

/**
 * Each miss on the same tree doubles its hold, up to UNREACHABLE_HOLD_MAX_MS.
 *
 * A flat 45 s brought the same hilltop spruce back every minute on 09-26:
 * "Cannot reach that tree {-295,89,334}" nine times, with a pond in between,
 * the bot wading in and out of it each time while its food ran from 12 to 6.
 * The strike count is kept past the hold (the sweep in index.js only clears
 * `skipped`), so the next miss on the same trunk is punished harder.
 */
const UNREACHABLE_HOLD_MAX_MS = 10 * 60 * 1000;

function holdTree(ctx, key) {
  ctx.wood.strikes = ctx.wood.strikes ?? new Map();
  const strikes = (ctx.wood.strikes.get(key) ?? 0) + 1;
  ctx.wood.strikes.set(key, strikes);
  const hold = Math.min(UNREACHABLE_HOLD_MS * 2 ** (strikes - 1), UNREACHABLE_HOLD_MAX_MS);
  ctx.wood.skipped.set(key, Date.now() + hold);
  return hold;
}

function posKey(pos) {
  return `${pos.x},${pos.y},${pos.z}`;
}

/**
 * Walk down a trunk to its base.
 *
 * findBlocks returns the nearest log *block*, which is often partway up a
 * trunk or out along a branch — and with pathfinder digging disabled the bot
 * cannot cut through the canopy to reach it. The bottom log of a tree is
 * almost always standable-next-to, so aim there instead.
 */
function trunkBase(bot, pos) {
  let base = pos;
  for (let i = 0; i < 24; i++) {
    const below = bot.blockAt(base.offset(0, -1, 0));
    if (!below || !LOG_NAMES.includes(below.name)) break;
    base = below.position;
  }
  return base;
}

/**
 * Cut the rest of the trunk, standing where the base log was.
 *
 * Each broken log leaves a gap the bot falls or steps into, which brings the
 * next one into reach — so this needs no pathfinding at all. Stops at the
 * first non-log, which is the canopy.
 */
const MAX_TRUNK = 7;

async function fellTrunk(bot, basePos, task) {
  let cut = 0;
  for (let i = 1; i <= MAX_TRUNK; i++) {
    task.throwIfAborted();
    const above = bot.blockAt(basePos.offset(0, i, 0));
    if (!above || !LOG_NAMES.includes(above.name)) break;
    // Out of reach: the bot has not risen into the gap, so stop rather than
    // swinging at nothing for the rest of the trunk.
    if (bot.entity.position.distanceTo(above.position) > 4.4) break;
    if (!(await digBlock(bot, above, task))) break;
    cut++;
  }
  return cut;
}

/**
 * Every log of the tree, not just the column above the base.
 *
 * Asked for directly: "when the bot gets wood from a tree make it mine the
 * full tree". fellTrunk stops at the first log out of reach, which on a birch
 * or spruce is two or three logs short of the top, and never touches an oak's
 * or acacia's branches — so the bot walked away from a half-cut tree and paid
 * the walk to the next one for the logs it had left behind.
 *
 * Flood-filled through logs of the SAME species from the trunk, bounded in
 * size and spread so a log cabin or a forest of touching trees can never turn
 * into an afternoon of chopping. And a real tree has leaves: a log structure
 * with none anywhere near it is someone's building, so only its trunk is cut
 * (the old behavior) and nothing else.
 */
const TREE_MAX_LOGS = 48;
const TREE_SPREAD = 6; // blocks from the trunk, horizontally — big oak branches reach ~5
const TREE_HEIGHT = 32; // jungle giants are the tallest at ~30
const LEAF_PROBE = 2;

function treeLogs(bot, basePos) {
  const base = bot.blockAt(basePos);
  if (!base || !LOG_NAMES.includes(base.name)) return [];
  const species = base.name;
  const seen = new Set([posKey(basePos)]);
  const queue = [basePos];
  const logs = [];
  let leafy = false;

  while (queue.length && logs.length < TREE_MAX_LOGS) {
    const at = queue.shift();
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        for (let dz = -1; dz <= 1; dz++) {
          const p = at.offset(dx, dy, dz);
          const key = posKey(p);
          if (seen.has(key)) continue;
          seen.add(key);
          if (p.y < basePos.y || p.y > basePos.y + TREE_HEIGHT) continue;
          if (Math.max(Math.abs(p.x - basePos.x), Math.abs(p.z - basePos.z)) > TREE_SPREAD) continue;
          const block = bot.blockAt(p);
          if (!block) continue;
          if (block.name === species) {
            logs.push(p);
            queue.push(p);
          } else if (!leafy && block.name.endsWith('_leaves')) {
            leafy = true;
          }
        }
      }
    }
  }
  if (!leafy) leafy = logs.some((p) => nearLeaves(bot, p));
  return leafy ? logs : [];
}

function nearLeaves(bot, pos) {
  for (let dy = 0; dy <= LEAF_PROBE; dy++) {
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1], [0, 0]]) {
      if (bot.blockAt(pos.offset(dx, dy, dz))?.name?.endsWith('_leaves')) return true;
    }
  }
  return false;
}

/**
 * Cut whatever the trunk pass left: the top of a tall trunk, and branches.
 *
 * Lowest first, so each cut log lies on the way to the next one. A log in
 * reach is just dug; one out of reach is walked or pillared to — pathfinder
 * towers with the cobble/dirt the bot carries — and given up on if the route
 * is not there. Bounded to half the director's overrun limit, leaving the
 * other half for the walk there and the trunk, so a tree never gets a
 * behavior cut off and benched.
 */
const REACH = 4.4;
const CROWN_BUDGET_MS = MAX_BEHAVIOR_MS / 2;
const CROWN_LEG_MS = 8000;

async function fellCrown(bot, logs, task) {
  const deadline = Date.now() + CROWN_BUDGET_MS;
  const given = new Set();
  let cut = 0;

  for (;;) {
    task.throwIfAborted();
    if (Date.now() > deadline) break;
    const here = bot.entity.position;
    const next = logs
      .filter((p) => !given.has(posKey(p)) && bot.blockAt(p)?.name?.endsWith('_log'))
      .sort((a, b) => (a.y - b.y) || (here.distanceTo(a) - here.distanceTo(b)))[0];
    if (!next) break;

    const block = bot.blockAt(next);
    if (bot.entity.position.distanceTo(next.offset(0.5, 0.5, 0.5)) > REACH) {
      try {
        await goToBlock(bot, block, task, { within: REACH - 0.2, timeoutMs: CROWN_LEG_MS });
      } catch (err) {
        if (isInterruption(err)) throw err;
        given.add(posKey(next));
        continue;
      }
    }
    if (await digBlock(bot, bot.blockAt(next), task)) {
      cut++;
    } else {
      given.add(posKey(next));
    }
  }
  return { cut, left: logs.filter((p) => bot.blockAt(p)?.name?.endsWith('_log')).length };
}

function findLog(bot, ctx) {
  const now = Date.now();
  // Back off harder after a miss than after a hit — see EMPTY_SCAN_THROTTLE_MS.
  const throttle = ctx.wood.lastScanEmpty ? EMPTY_SCAN_THROTTLE_MS : SCAN_THROTTLE_MS;
  if (now - ctx.wood.lastScanAt < throttle) return ctx.wood.candidate;
  ctx.wood.lastScanAt = now;

  // A tier only counts as answered if it holds a tree we have not already
  // given up on. Otherwise a single unreachable trunk twelve blocks away —
  // across a ravine, say — would stop the bot ever looking at the forest
  // behind it for the whole forty-five second blacklist.
  // Nor a log down in water the bot has had to build its way out of: on
  // 09-26 the chase for wood was what walked it back into the ravine.
  const usable = (pos) => {
    if (worldMemory.inWaterTrap(pos)) return false;
    const until = ctx.wood.skipped.get(posKey(trunkBase(bot, pos)));
    return !until || until < now;
  };

  const found = findNearestTiered(bot, LOG_NAMES, SEARCH_RADII, CANDIDATE_COUNT, usable);
  ctx.wood.lastScanEmpty = found.length === 0;

  ctx.wood.candidate = null;
  for (const pos of found) {
    if (!usable(pos)) continue;
    ctx.wood.candidate = bot.blockAt(trunkBase(bot, pos));
    break;
  }
  return ctx.wood.candidate;
}

const wood = {
  name: 'wood',
  priority: 10,
  shouldRun(bot, ctx) {
    if (woodUnits(bot) >= WOOD_TARGET) return false;
    return !!findLog(bot, ctx);
  },
  async run(bot, ctx, task) {
    const block = findLog(bot, ctx);
    if (!block) return false;
    const key = posKey(block.position);

    try {
      // Close enough that the log drops at our feet, not across a gap.
      await goToBlock(bot, block, task, { within: 2.6 });
      // Mapped while the trunk still stands — once the base is gone the
      // flood fill has nothing to start from.
      const tree = treeLogs(bot, block.position);
      const dug = await digBlock(bot, block, task);
      if (dug) {
        // Fell the WHOLE trunk, not one log.
        //
        // The walk to a tree costs several seconds; the log itself costs
        // under one. Taking a single log per behavior cycle meant paying the
        // travel cost four or five times over for the same tree, and wood
        // gates the entire opening: planks, sticks, crafting table, the first
        // pickaxe. Standing in the trunk and cutting upward is nearly free,
        // and it is what turns "eventually gets a sword" into "has a sword in
        // the first minute".
        //
        // Still interruptible on every log, so a creeper walking up does not
        // have to wait for the tree to come down.
        const felled = 1 + await fellTrunk(bot, block.position, task);
        // ...and then the rest of the tree — see treeLogs.
        const crown = tree.length ? await fellCrown(bot, tree, task) : { cut: 0, left: 0 };
        await stepOntoDrop(bot, block.position, task);
        logger.action('Chopped tree', {
          logs: felled + crown.cut, pos: block.position, ...(crown.left ? { leftStanding: crown.left } : {}),
        });
      } else {
        // Reached it but couldn't break it — don't pick it again next tick.
        holdTree(ctx, key);
      }
      return dug;
    } catch (err) {
      if (isInterruption(err)) throw err;
      const holdMs = holdTree(ctx, key);
      logger.info('Cannot reach that tree — trying a different one', {
        pos: block.position,
        reason: err.message,
        ignoringForSec: Math.round(holdMs / 1000),
      });
      return false;
    } finally {
      ctx.wood.candidate = null;
    }
  },
};

/**
 * Having NO wood is an emergency, the same way having no food is.
 *
 * `wood` sits at priority 10, below everything, which is right when the bot
 * simply wants to top up its stock. It is badly wrong when the stock is
 * zero, because wood is upstream of almost everything else:
 *
 *   no wood -> no fuel -> no cooking -> only raw meat, which the eating
 *   policy refuses -> food stock stays at zero -> `forage` (46) runs
 *   forever -> `wood` (10) never gets the wheel -> no wood.
 *
 * That loop was caught on the live dashboard: hunger 12, food stock 0, and
 * an inventory of ten cobblestone, two sticks and no logs at all, with the
 * bot foraging in circles. It also blocks the descent outright, which needs
 * sixteen planks' worth.
 *
 * So when there is essentially none left, chopping outranks foraging. The
 * genuine-starvation case still wins, because `huntUrgent` is gated on
 * actually being hungry and this steps aside below that threshold.
 */
const woodUrgent = {
  name: 'woodUrgent',
  // Above forage (46): foraging without the means to cook produces raw meat
  // the bot will not eat, so wood genuinely comes first.
  priority: 47,
  shouldRun(bot, ctx) {
    const units = woodUnits(bot);
    // Hysteresis: trigger at the bar, stop at twice it. See RESTOCK_WOOD.
    if (units >= RESTOCK_WOOD) {
      ctx.wood.restocking = false;
    } else if (units < CRITICAL_WOOD) {
      ctx.wood.restocking = true;
    }
    if (!ctx.wood.restocking) return false;

    // Actually starving beats everything — let huntUrgent have it. The same
    // bar as hunt.js's: this was 7 against hunting's 6, so at exactly 7 an
    // unarmed bot could neither chop nor hunt and only priority-10 `wood` was
    // left to move it.
    if ((bot.food ?? 20) <= CANNOT_SPRINT_FOOD) return false;

    // WOOD IS A MEANS, and this behavior outranks the thing it is a means TO.
    //
    // At priority 47 this sits above `gear` at 40, so while the supply is
    // below the threshold the bot chops and never crafts. Found live: a bot
    // holding fourteen wood units, a hundred and eighty cobblestone, and no
    // stone pickaxe — because a pickaxe costs two sticks and it was too busy
    // fetching more wood to spend them.
    //
    // Crafting takes seconds and unblocks everything downstream, so if what
    // we already carry can be turned into a tool right now, that goes first.
    // Deliberately only TOOLS: armour and other goals are not worth pausing
    // a supply run for.
    const goal = nextGoal(bot);
    if (goal && goal.kind === 'tool') return false;

    return !!findLog(bot, ctx);
  },
  run: (bot, ctx, task) => wood.run(bot, ctx, task),
};

/**
 * The last-resort fallback — and it must still be WORK.
 *
 * This used to turn on the spot and sleep for a second or two, which is the
 * definition of idling: the bot would sit in one place doing nothing while
 * its hunger ticked down, and on one occasion starved to death that way. It
 * also achieved nothing about the reason everything else had nothing to do,
 * which is almost always "there is nothing useful within scan range".
 *
 * So the fallback is now: go somewhere else. Moving brings fresh terrain
 * into the 32–48 block scan windows that wood, mine and hunt depend on, so
 * the thing that fixes an empty schedule is exactly the thing this does.
 */
const WANDER_DISTANCE = 20;

const idle = {
  name: 'idle',
  priority: 1,
  shouldRun() {
    return true;
  },
  async run(bot, ctx, task) {
    const heading = Math.random() * Math.PI * 2;
    const target = bot.entity.position.offset(
      Math.cos(heading) * WANDER_DISTANCE,
      0,
      Math.sin(heading) * WANDER_DISTANCE,
    );

    try {
      // A heading, so no height to match — see goNearXZ.
      await goNearXZ(bot, target, 3, task, { timeoutMs: 8000 });
    } catch (err) {
      if (isInterruption(err)) throw err;
      // Blocked — a short pause stops this hot-looping, but it is a pause
      // between attempts to move, not a decision to stand still.
      await sleep(400, task);
    }
    // Always report success. Trying to move IS this behavior's job, and it
    // is the guaranteed fallback — if it gets backed off for failing, the
    // scheduler runs out of options and the bot genuinely stands still.
    return true;
  },
};

module.exports = {
  wood,
  woodUrgent,
  idle,
  LOG_NAMES,
  // For test/thresholds.test.js: the trigger and the stopping point, which must
  // straddle the descent's requirement rather than sitting under it.
  CRITICAL_WOOD,
  RESTOCK_WOOD,
  // For test/progression.test.js: which logs count as "the whole tree".
  treeLogs,
  // ...and how long a tree we keep failing to reach is left alone.
  holdTree, UNREACHABLE_HOLD_MAX_MS,
};
