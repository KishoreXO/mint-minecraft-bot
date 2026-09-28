const logger = require('../logger');
const { sleep, isInterruption } = require('../task');
const { goNear, stepIsSafe, stepTo } = require('../nav');
const {
  digBlock, pillarItem, equipIfDifferent, tryPlaceBlock,
} = require('../inventory');
const memory = require('../memory');
const { pauseAutoEat } = require('../eating');
const {
  eyeInWater, eyeCell, airLeft, breathBudgetTicks, cappedAbove, planRoute, findExit, findLanding, findNotch,
  rimBeside, withPilot, swimAshore, surfaceSearch, airDigOptions, bestDigTicks,
} = require('../water');
const { pillarOut, digOutUpward } = require('./unstick');
const { findNearest } = require('../blocks');
const { touchingLava, lavaNearBody, lavaBeside } = require('../lava');
const { AIR_RESERVE } = require('../swim');

/**
 * Getting out of water.
 *
 * Eating used to live here too. It's now owned by mineflayer-auto-eat (wired
 * up in bot.js) because running both would have them fighting over the hand
 * slot mid-meal. Food *stock* is still ours — see behaviors/hunt.js.
 */

// What the bot counts as food when deciding whether it needs to go hunting.
// Kept here because hunt.js needs the name set and auto-eat doesn't expose
// one. Raw meat is included on purpose: it's still a reason not to hunt.
const EDIBLE = new Set([
  'cooked_beef', 'cooked_porkchop', 'cooked_chicken', 'cooked_mutton',
  'cooked_rabbit', 'cooked_cod', 'cooked_salmon', 'bread', 'baked_potato',
  'golden_carrot', 'carrot', 'apple', 'melon_slice', 'sweet_berries',
  'glow_berries', 'potato', 'beetroot',
  'beef', 'porkchop', 'mutton', 'chicken', 'rabbit',
]);

// --- Water ------------------------------------------------------------

/**
 * When to drop everything and go and breathe, in the OPEN.
 *
 * Eight bubbles is 120 ticks of air, and swimming straight up covers 3.5
 * blocks a second: a lot of climb in hand when the way up is open. Under a
 * lid it is not enough — see escapeDrowning.shouldRun, which does not wait.
 */
const LOW_AIR = AIR_RESERVE;

const STUCK_MS = 6000;
const STUCK_DISTANCE = 2.5;

/**
 * A route to air has to fit in the air (and health) left with this much to
 * spare: the router's costs are measured speeds, and a real swim loses time
 * turning, bumping walls and waiting on a stalled event loop.
 */
const ROUTE_SAFETY = 1.5;

// A climb out of a ravine on its own blocks is a minute or two of work. Past
// this it is not going to work, and the ladder starts again from the water.
const CLIMB_ESCAPE_MS = 3 * 60 * 1000;

// A notch dig through anything slower than this per block (while floating,
// eye dry: five times the dry time) is not an escape.
const NOTCH_DIG_MAX_TICKS = 200;

// Re-entering the water this soon after ESCAPING it is worth a log line: it
// was 63% of all escapes on 09-26, and nothing said which behavior did it.
// Only after an escape: timed from any exit, wading along a shore logged it
// 142 times in one 4.3-hour run, a few hundred milliseconds apart, against
// nine real escapes — noise that buried the signal it was added for.
const REENTRY_WINDOW_MS = 30000;

/** Capped overhead, cached: reflex.js asks escapeDrowning every tick. */
const capCache = { at: 0, key: '', value: false };
const CAP_CACHE_MS = 250;
function cappedNow(bot) {
  const e = eyeCell(bot);
  const key = `${e.x},${e.y},${e.z}`;
  const now = Date.now();
  if (key !== capCache.key || now - capCache.at > CAP_CACHE_MS) {
    capCache.key = key;
    capCache.at = now;
    capCache.value = cappedAbove(bot);
  }
  return capCache.value;
}

/**
 * DROWNING and BEING IN WATER are two different problems, and running them
 * through one behavior at priority 95 is why the bot drowned standing up.
 *
 * Reported directly: "he was just in water, not under, and was attacked by
 * drowned and died twice and he did nothing". That is this behavior winning a
 * fight it should not have been in. At 95 it outranks `threat` at 90, so a bot
 * bobbing at the surface with a drowned chewing on it spent every scheduling
 * round trying to swim to a shore it could not reach, and never once got to
 * defend itself. Its air was full the whole time; it was not drowning at all.
 *
 * So they are split:
 *
 *   escapeDrowning  air is genuinely running out, or will before the surface
 *                   can be reached. Outranks everything.
 *   leaveWater      we are merely wet and going nowhere. BELOW combat, because
 *                   being in water with something attacking is a fight, and
 *                   swimming away from a drowned is not an option — they are
 *                   faster in water than we are.
 */
const escapeDrowning = {
  name: 'escapeDrowning',
  priority: 95,
  shouldRun(bot, ctx) {
    if (!bot.entity?.isInWater || !eyeInWater(bot)) return false;
    if (airLeft(bot) <= LOW_AIR) return true;
    // Diving on purpose (a fight below the surface, or leaveWater's own
    // budgeted swim through a flooded tunnel) is allowed until the reserve.
    if (bot.diveIntent) return false;
    if (ctx?.water?.divingUntil && Date.now() < ctx.water.divingUntil) return false;
    // UNDER A LID, DO NOT WAIT FOR THE RESERVE. All three drownings on record
    // were under something — a flooded cave, a ravine overhang, a flooded
    // pocket off a mine — and in each the escape started at eight bubbles,
    // which is a budget for swimming straight up, not for finding the way
    // round a ceiling.
    return cappedNow(bot);
  },
  canInterrupt(bot, ctx) {
    return escapeDrowning.shouldRun(bot, ctx);
  },
  async run(bot, ctx, task) {
    logger.warn('Running out of air — surfacing', {
      air: airLeft(bot),
      capped: cappedNow(bot),
      budgetTicks: breathBudgetTicks(bot),
    });
    // No meals on the way up: eating swaps the pickaxe out of the hand in the
    // middle of a dig — it did, at 14:32:32 on 09-26, a block from air.
    const resumeEating = pauseAutoEat(bot, 'drowning');
    try {
      await withPilot(bot, 'escapeDrowning', (pilot) => breatheAgain(bot, pilot, task));
    } finally {
      resumeEating();
    }
    const breathing = !eyeInWater(bot);
    if (breathing) {
      logger.action('Breathing again', { air: airLeft(bot) });
      if (ctx.water) ctx.water.since = null;
    }
    return breathing;
  },
};

/**
 * Get the head into air: by swimming when a route fits the air left, by
 * digging when a dig does, and otherwise by the best route there is anyway.
 *
 * The order matters. Digging underwater while floating is twenty-five times
 * slower than on land (14 seconds for one stone with a stone pickaxe — the
 * whole air supply), so a dig is only chosen when its measured time fits.
 * That rule alone would have saved the bot at 14:32 on 09-26, which started
 * digging diorite with two bubbles left.
 */
async function breatheAgain(bot, pilot, task) {
  for (let attempt = 0; attempt < 4 && eyeInWater(bot); attempt++) {
    task.throwIfAborted();
    const budget = breathBudgetTicks(bot);
    const route = planRoute(bot, { type: 'breath' });
    if (route && route.ticks * ROUTE_SAFETY <= budget) {
      if (route.path.length > 1) {
        logger.info('Swimming for air', { routeTicks: route.ticks, budgetTicks: budget, steps: route.path.length - 1 });
        await pilot.follow(route.path, task);
      } else {
        await pilot.hold(20, task, { jump: true });
      }
      continue;
    }

    const [dig] = airDigOptions(bot);
    if (dig && dig.ticks * ROUTE_SAFETY <= budget) {
      logger.info('Digging toward air', {
        block: dig.block.name,
        at: dig.block.position,
        ticks: dig.ticks,
        budgetTicks: budget,
        routeTicks: route?.ticks ?? null,
        standingOnTheFloor: dig.sinkFirst,
      });
      // Standing: a fifth of the floating dig time. Sink first, then keep
      // still on the floor (no jump) for the whole dig.
      if (dig.sinkFirst) await pilot.hold(120, task, { jump: false, until: () => bot.entity.onGround });
      const keepStill = pilot.hold(2000, task, { jump: !dig.sinkFirst });
      try {
        await digBlock(bot, dig.block, task);
      } finally {
        pilot.hold(0, task).catch(() => {});
        await keepStill.catch(() => {});
      }
      await pilot.hold(40, task, { jump: true, until: () => !eyeInWater(bot) });
      continue;
    }

    if (route) {
      // Nothing fits. The nearest air is still the best chance there is.
      logger.warn('Air is further than the air left — going for it anyway', {
        routeTicks: route.ticks, budgetTicks: budget,
      });
      await pilot.follow(route.path, task);
      continue;
    }
    logger.warn('Underwater with no air in reach — rising', { air: airLeft(bot), y: Math.round(bot.entity.position.y) });
    await pilot.hold(40, task, { jump: true });
  }
  return !eyeInWater(bot);
}

const leaveWater = {
  name: 'leaveWater',
  /**
   * Below `threat` (88) on purpose — see the note above — and therefore below
   * `defend` (94), `unstick` (93), `bed` (92) and `shelter` (91) as well, all of
   * which are about being unable to act at all. Above everything that is merely
   * work. `unstick` and `shelter` both stand aside while the bot is in water
   * or climbing out of it; they cannot help there and used to make it worse.
   *
   * The numbers in this comment are checked by test/priorities.test.js rather
   * than trusted: a comment claiming `bed` sat above `shelter` stayed correct
   * in prose for weeks after it had stopped being true in code, and the bot
   * quietly chose the worse of the two every night.
   */
  priority: 85,
  shouldRun(bot, ctx) {
    const w = ctx.water;
    // Mid-climb out of a ravine, standing on its own blocks: dry, but not out.
    if (w.escape) {
      if (Date.now() < w.escape.until && !bot.entity.isInWater) return true;
      if (Date.now() >= w.escape.until) {
        logger.info('Giving up this climb out of the water', { how: w.escape.how, y: Math.round(bot.entity.position.y) });
      }
      w.escape = null;
    }

    if (!bot.entity.isInWater) {
      w.since = null;
      w.from = null;
      return false;
    }

    const now = Date.now();
    if (!w.since) {
      w.since = now;
      w.from = bot.entity.position.clone();
      if (w.leftAt && now - w.leftAt < REENTRY_WINDOW_MS) {
        logger.info('Re-entered water', {
          behavior: ctx.currentBehavior ?? null,
          sinceExitMs: now - w.leftAt,
          at: bot.entity.position.floored(),
          knownTrap: memory.inWaterTrap(bot.entity.position),
        });
      }
      w.leftAt = 0; // once per escape
      return false;
    }
    if (now - w.since < STUCK_MS) return false;

    // Swimming across a river on purpose is fine — only intervene if we're
    // in water AND haven't actually gone anywhere.
    const moved = bot.entity.position.distanceTo(w.from);
    if (moved > STUCK_DISTANCE) {
      w.since = now;
      w.from = bot.entity.position.clone();
      return false;
    }
    return true;
  },
  async run(bot, ctx, task) {
    if (ctx.water.escape) return continueClimb(bot, ctx, task);

    logger.warn('Stuck in water — getting out', {
      air: airLeft(bot),
      submerged: eyeInWater(bot),
      at: bot.entity.position.floored(),
    });
    const outcome = await withPilot(bot, 'leaveWater', (pilot) => getOut(bot, ctx, pilot, task));
    if (outcome === 'climbing') return continueClimb(bot, ctx, task);
    if (!bot.entity.isInWater) {
      logger.action('Reached dry land', { how: outcome });
      ctx.water.since = null;
      ctx.water.leftAt = Date.now();
      return true;
    }
    logger.info('Still in water, will retry', { tried: outcome, air: airLeft(bot) });
    return false;
  },
};

/**
 * The way out, cheapest first. Each rung says in the log what it did, so a
 * session's water trouble can be read straight off it.
 *
 *   swim through   under a lid: a budgeted 3D route to somewhere dry
 *   climb out      a bank at most one block above the water (the physics limit)
 *   landing        no such bank within 40 (a ravine): place a block in the
 *                  water beside us against the wall, climb onto it, pillar up
 *   notch          no blocks: cut three cells into the wall, climb in, stair up
 */
async function getOut(bot, ctx, pilot, task) {
  // Submerged, or under a lid: the surface search cannot even start.
  if (eyeInWater(bot) || !findExit(bot, { radius: 2 }) && cappedNow(bot)) {
    const route = planRoute(bot, { type: 'dry' });
    const budget = breathBudgetTicks(bot);
    if (route && route.ticks * ROUTE_SAFETY <= budget) {
      ctx.water.divingUntil = Date.now() + route.ticks * ROUTE_SAFETY * 50;
      try {
        await pilot.follow(route.path, task);
      } finally {
        ctx.water.divingUntil = null;
      }
      if (!bot.entity.isInWater) return 'swam through';
    }
  }

  const exit = findExit(bot);
  if (exit) {
    const out = await swimAshore(bot, pilot, task, { exit });
    if (out.result === 'ashore') return exit.steps > 12 ? 'swam to a bank' : 'climbed out';
    return `swim stopped: ${out.result}`;
  }

  const filler = pillarItem(bot);
  const landing = filler && findLanding(bot);
  if (landing) {
    const built = await buildLanding(bot, pilot, landing, task);
    if (built) {
      ctx.water.escape = {
        how: 'landing', trapAt: landing.cell, startY: bot.entity.position.y, until: Date.now() + CLIMB_ESCAPE_MS,
      };
      return 'climbing';
    }
  }

  const notch = findNotch(bot);
  if (notch && notch.cut.every((c) => bestDigTicks(bot, bot.blockAt(c)) <= NOTCH_DIG_MAX_TICKS)) {
    if (await cutNotch(bot, pilot, notch, task)) {
      ctx.water.escape = {
        how: 'notch', heading: notch.heading, trapAt: notch.stand.offset(0, -1, 0), startY: bot.entity.position.y, until: Date.now() + CLIMB_ESCAPE_MS,
      };
      return 'climbing';
    }
  }

  // Nothing in reach. Swim on across the water rather than bob in one place:
  // somewhere along it the walls may drop.
  const onward = surfaceSearch(bot, (cell, n) => (Math.abs(n.x - Math.floor(bot.entity.position.x)) + Math.abs(n.z - Math.floor(bot.entity.position.z)) >= 10 ? n : null));
  if (onward) {
    logger.info('No way out of this water in reach — swimming on', {
      blocks: !!filler, landingSpot: !!landing, notchSpot: !!notch, to: onward.found,
    });
    await pilot.follow(onward.path, task);
  } else {
    logger.info('No way out of this water in reach', { blocks: !!filler, landingSpot: !!landing, notchSpot: !!notch });
    await pilot.hold(20, task, { jump: true });
  }
  return 'no way out yet';
}

/** Swim to the spot, stay put in the middle of the cell, place, climb on. */
async function buildLanding(bot, pilot, landing, task) {
  const swam = await pilot.follow(landing.path.length > 1 ? landing.path : [landing.approach], task, { arrive: 0.12 });
  if (swam !== 'arrived') return false;
  const filler = pillarItem(bot);
  if (!filler) return false;
  await equipIfDifferent(bot, filler);
  const ref = bot.blockAt(landing.ref);
  if (!ref) return false;
  await bot.lookAt(landing.ref.offset(0.5, 0.5, 0.5).plus(landing.face.scaled(0.5)), true).catch(() => {});
  // The pilot keeps the head up (jump) and the body still while this goes out.
  const placing = pilot.hold(200, task, { jump: true });
  const placed = await tryPlaceBlock(bot, ref, landing.face);
  const landed = isSolidBlock(bot.blockAt(landing.cell));
  logger.info(landed ? 'Built a landing in the water' : 'Could not place a landing', {
    at: landing.cell, against: ref.name, placed,
  });
  if (!landed) return false;
  pilot.hold(0, task).catch(() => {}); // end the hold
  await placing.catch(() => {});
  const climbed = await pilot.climbOut(landing.cell.offset(0, 1, 0), task);
  return climbed === 'arrived';
}

/** Swim to the wall, cut the notch, climb into it. */
async function cutNotch(bot, pilot, notch, task) {
  const swam = await pilot.follow(notch.path.length > 1 ? notch.path : [notch.approach], task, { arrive: 0.2 });
  if (swam !== 'arrived') return false;
  for (const pos of notch.cut) {
    task.throwIfAborted();
    const block = bot.blockAt(pos);
    if (!block || block.boundingBox !== 'block') continue;
    const holding = pilot.hold(400, task, { jump: true });
    const dug = await digBlock(bot, block, task);
    pilot.hold(0, task).catch(() => {});
    await holding.catch(() => {});
    if (!dug) return false;
  }
  logger.info('Cut a notch in the wall to climb out', { at: notch.stand, blocks: notch.cut.length });
  return (await pilot.climbOut(notch.stand, task)) === 'arrived';
}

/**
 * On the landing or in the notch, dry but still at the bottom: build or cut
 * the rest of the way up, until there is a dry standable cell beside the
 * feet — the rim. Resumable: the escape outlives a preemption, so a zombie on
 * the landing does not undo ten blocks of pillar.
 */
async function continueClimb(bot, ctx, task) {
  const esc = ctx.water.escape;
  const done = (b) => !!rimBeside(b);
  if (!done(bot)) {
    if (esc.how === 'notch') await digOutUpward(bot, task, { heading: esc.heading, done });
    else await pillarOut(bot, task, { done });
  }
  const rim = rimBeside(bot);
  if (rim) {
    await stepTo(bot, rim, task).catch((err) => { if (isInterruption(err)) throw err; });
    if (!bot.entity.isInWater) {
      memory.noteWaterTrap(esc.trapAt, esc.how);
      logger.action('Climbed out of the water', {
        how: esc.how, risenBy: Math.round(bot.entity.position.y - esc.startY), at: bot.entity.position.floored(),
      });
      ctx.water.escape = null;
      ctx.water.since = null;
      ctx.water.leftAt = Date.now();
      return true;
    }
  }
  if (bot.entity.isInWater) {
    // Fell back in: start the ladder again from the water.
    ctx.water.escape = null;
    return false;
  }
  logger.info('Still climbing out of the water', { how: esc.how, y: Math.round(bot.entity.position.y) });
  return false;
}

function isSolidBlock(block) {
  return !!block && block.boundingBox === 'block';
}

// --- Lava, fire and being buried alive ---------------------------------

/**
 * The three ways the bot died that nothing was watching for.
 *
 * The damage ledger (src/damage.js) exists to answer "what is actually
 * killing this bot", and these are the ones with no handler at all: it had
 * `escapeWater` for drowning and a whole combat system for mobs, but
 * standing in lava, being on fire, and having a block pushed into its head
 * were simply damage it absorbed until it died.
 *
 * All three are fast, all three are fatal, and all three have a response
 * that takes under a second. This outranks even drowning — you can hold your
 * breath, you cannot stand in lava.
 */
const LAVA_NAMES = new Set(['lava', 'flowing_lava']);
// How close to lava still counts as "in it" for the escape. See lavaNearBody.
const LAVA_CLEARANCE = 1;
const FIRE_NAMES = new Set(['fire', 'soul_fire', 'campfire', 'soul_campfire', 'magma_block']);
const HAZARD_ESCAPE_MS = 6000;
const WATER_SEARCH = 16;
/**
 * How many gravel blocks a single collapse is worth clearing before giving up
 * and letting the behavior be re-picked. A genuinely bottomless column (which
 * should not exist, but a corrupted chunk is not impossible) must not become
 * an infinite loop; a real deposit is rarely more than a handful of blocks.
 */
const SUFFOCATION_CLEAR_ATTEMPTS = 6;

function blockAtOffset(bot, dx, dy, dz) {
  try {
    return bot.blockAt(bot.entity.position.offset(dx, dy, dz));
  } catch {
    return null;
  }
}

// The whole body, not the cell under its centre point — see src/lava.js for
// the death that asking about one cell caused.
function inLava(bot) {
  return touchingLava(bot);
}

function standingInFire(bot) {
  return FIRE_NAMES.has(blockAtOffset(bot, 0, 0, 0)?.name)
    || FIRE_NAMES.has(blockAtOffset(bot, 0, -1, 0)?.name);
}

/** A solid block occupying our head is suffocation — it deals damage per tick. */
function suffocating(bot) {
  const head = blockAtOffset(bot, 0, 1, 0);
  return !!head && head.boundingBox === 'block';
}

/** Nearest spot that is neither lava nor fire and has something to stand on. */
function nearestSafeFooting(bot, radius = 6) {
  const origin = bot.entity.position.floored();
  let best = null;
  let bestDist = Infinity;

  for (let dx = -radius; dx <= radius; dx++) {
    for (let dz = -radius; dz <= radius; dz++) {
      for (let dy = -2; dy <= 3; dy++) {
        const pos = origin.offset(dx, dy, dz);
        const at = bot.blockAt(pos);
        const head = bot.blockAt(pos.offset(0, 1, 0));
        const under = bot.blockAt(pos.offset(0, -1, 0));
        if (!at || !head || !under) continue;
        if (at.boundingBox !== 'empty' || head.boundingBox !== 'empty') continue;
        if (under.boundingBox !== 'block') continue;
        if (LAVA_NAMES.has(under.name) || FIRE_NAMES.has(under.name)) continue;
        if (LAVA_NAMES.has(at.name) || FIRE_NAMES.has(at.name)) continue;
        // Not on the lip of the pool either: standing beside lava, the body
        // overlaps it, and that is exactly where the bot died.
        if (lavaBeside(bot, pos)) continue;
        if (!stepIsSafe(bot, pos)) continue;

        const d = pos.distanceTo(origin);
        if (d < bestDist) {
          bestDist = d;
          best = pos;
        }
      }
    }
  }
  return best;
}

function findWater(bot) {
  try {
    // Asked while ON FIRE, so it goes through the fast search — a stall here
    // is a stall spent burning.
    return findNearest(bot, ['water'], WATER_SEARCH);
  } catch {
    return null;
  }
}

const escapeHazard = {
  name: 'escapeHazard',
  // Above everything, including drowning. Lava does 4 damage every half
  // second; nothing else in the game kills a full-health bot faster.
  priority: 97,
  shouldRun(bot) {
    if (bot.health <= 0) return false;
    return inLava(bot) || suffocating(bot) || standingInFire(bot);
  },
  canInterrupt(bot) {
    return escapeHazard.shouldRun(bot);
  },
  async run(bot, ctx, task) {
    // Suffocation first: it is the cheapest to fix and the fix is unambiguous.
    if (suffocating(bot)) {
      // DIG UNTIL CLEAR, not once.
      //
      // A single dig was enough for a block that got pushed into the bot's
      // head, and nowhere near enough for the actual killer: a gravel
      // deposit collapsing overhead. Gravel is gravity-affected and falls the
      // instant the space under it is unsupported — so digging the one block
      // in the bot's head just makes room for the NEXT gravel block above it
      // to fall into exactly the same spot, one tick later. One dig, one
      // block of relief, one more block of gravel arriving.
      //
      // Watched live, killing the bot outright: "Buried — digging my head
      // out {gravel}" and "Took avoidable damage {suffocation}" alternating
      // for a full minute, fifteen points of damage in ones and twos, while
      // `stripMine` kept getting the wheel back in between and driving
      // further into the same deposit. A single dig per behavior run cannot
      // win that race; the fix has to actually clear the column.
      for (let attempt = 0; attempt < SUFFOCATION_CLEAR_ATTEMPTS && suffocating(bot); attempt++) {
        task.throwIfAborted();
        const head = blockAtOffset(bot, 0, 1, 0);
        logger.warn('Buried — digging my head out', { block: head?.name, attempt: attempt + 1 });
        try {
          if (head && bot.canDigBlock(head)) await digBlock(bot, head, task);
        } catch (err) {
          if (isInterruption(err)) throw err;
        }
        // A fresh gravel fall needs a moment to settle into the space before
        // the next check reads it correctly — same reasoning as the descent's
        // fall-settle wait.
        if (suffocating(bot)) await sleep(150, task);
      }
      return true;
    }

    const lava = inLava(bot);
    logger.warn(lava ? 'IN LAVA — getting out' : 'On fire — moving off it', {
      health: Math.round(bot.health),
    });

    const target = nearestSafeFooting(bot) || (lava ? null : findWater(bot)?.position);

    // Hold jump throughout. In lava that makes the bot rise rather than sink,
    // which is the difference between climbing out and cooking on the bottom.
    const deadline = Date.now() + HAZARD_ESCAPE_MS;
    // Released in the finally — see Task.onAbort for why a kept listener is a leak.
    const unwatchAbort = task.onAbort(() => bot.clearControlStates());
    // NO EATING ON THE WAY OUT.
    //
    // auto-eat eats whenever health drops under its threshold, and in lava it
    // always does. Eating swaps the food into the hand and slows a player to a
    // crawl for as long as it lasts — so at 15:36:23 on 09-24 the bot started
    // three meals in the lava it was trying to leave, and died there. Paused
    // for the escape, and only the escape.
    // Counted (eating.js pauseAutoEat), so a drowning escape running at the
    // same time cannot switch eating back on underneath this one.
    const resumeEating = pauseAutoEat(bot, 'escaping a hazard');
    try {
      bot.setControlState('jump', true);
      bot.setControlState('sprint', !lava); // sprinting in lava does nothing
      while (Date.now() < deadline) {
        task.throwIfAborted();
        // Clear of it by a block, not merely out of it. Stopping the moment
        // the lava cell was left is what put the bot straight back in: the
        // next step, a drift or the flow itself is enough.
        if (!lavaNearBody(bot, LAVA_CLEARANCE) && !standingInFire(bot)) break;
        if (target) await bot.lookAt(target.offset(0.5, 0.5, 0.5), true).catch(() => {});
        bot.setControlState('forward', true);
        await sleep(100, task);
      }
    } finally {
      unwatchAbort();
      bot.clearControlStates();
      resumeEating();
    }

    // On fire and still burning after getting clear? Water puts it out, and
    // the fire ticks keep dealing damage long after we have left the flames.
    if (!inLava(bot)) {
      const water = findWater(bot);
      const stillBurning = Array.isArray(bot.entity?.metadata)
        && typeof bot.entity.metadata[0] === 'number'
        && (bot.entity.metadata[0] & 0x01) !== 0;
      if (stillBurning && water) {
        logger.action('Still burning — heading for water', { pos: water.position });
        try {
          await goNear(bot, water.position, 1, task);
        } catch (err) {
          if (isInterruption(err)) throw err;
        }
      }
    }

    return true;
  },
};

module.exports = {
  escapeDrowning, leaveWater, escapeHazard, EDIBLE, nearestSafeFooting,
};
