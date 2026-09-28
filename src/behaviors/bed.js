const logger = require('../logger');
const { sleep: wait, isInterruption } = require('../task');
const { ensureTable, ensurePlanks, placeFromInventory } = require('../stations');
const {
  countAny, findItem, itemCount, craftItem, plankNames,
} = require('../inventory');
const { isHostileMob } = require('../entities');
const memory = require('../memory');
const { findNearest } = require('../blocks');
const { daysAwake, timeInfo } = require('../world');
const { PHANTOM_INSOMNIA_DAYS } = require('../knowledge');
const { goToBlock } = require('../nav');

/**
 * Craft a bed, and sleep through the night in it.
 *
 * This is the real answer to the night problem, and it is strictly better
 * than the burrow in shelter.js: sleeping doesn't just survive the night, it
 * *skips* it. Eight in-game hours of hostile spawns, fleeing and lost
 * progress collapse into about five seconds. It also resets the spawn point,
 * so the death-loot walk gets shorter rather than longer as the bot ranges
 * further from world spawn.
 *
 * Vanilla requirements, all of which this has to respect:
 *  - 3 matching wool + 3 planks, on a crafting table
 *  - it must actually be night (or a thunderstorm)
 *  - no hostile mob within 8 blocks, or the server refuses the sleep
 */

const WOOL_COLOURS = [
  'white', 'orange', 'magenta', 'light_blue', 'yellow', 'lime', 'pink',
  'gray', 'light_gray', 'cyan', 'purple', 'blue', 'brown', 'green', 'red', 'black',
];

const BED_NAMES = WOOL_COLOURS.map((c) => `${c}_bed`);

// The server's own no-sleep radius is 8; leave a margin so a mob wandering
// in doesn't make us fail the attempt after walking all the way to the bed.
const MONSTER_FREE_RADIUS = 10;
const RETRY_AFTER_FAILURE_MS = 20000;
const SLEEP_POLL_MS = 1000;
const MAX_SLEEP_MS = 60000;
// Close enough for the right-click that sleep() is — see the walk in run().
const BED_REACH = 2;
/**
 * How long to lie in bed waiting for the night to skip.
 *
 * Vanilla skips the night 100 ticks — five seconds — after the last player
 * lies down. Still night after eight means someone is not going to bed.
 */
const NIGHT_SKIP_WAIT_MS = 8000;

/** In bed long enough for the skip, and it is still night: it is not coming. */
function nightIsNotSkipping(bot, sleptAt, now) {
  return now - sleptAt > NIGHT_SKIP_WAIT_MS && timeInfo(bot).isNight;
}

function heldBed(bot) {
  return findItem(bot, (i) => BED_NAMES.includes(i.name));
}

/** A wool colour we hold at least three of — beds need matching wool. */
function craftableBedColour(bot) {
  for (const colour of WOOL_COLOURS) {
    if (itemCount(bot, `${colour}_wool`) >= 3) return colour;
  }
  return null;
}

function hostilesNear(bot, radius) {
  for (const id of Object.keys(bot.entities)) {
    const e = bot.entities[id];
    if (e === bot.entity || !isHostileMob(e)) continue;
    if (bot.entity.position.distanceTo(e.position) <= radius) return true;
  }
  return false;
}

/**
 * The SHARED definition of night, not a third private one.
 *
 * This read `!bot.time.isDay`, which mineflayer computes as
 * `timeOfDay < 13000` — so it called everything up to tick 24000 night, while
 * world.js ends night at 23000. That thousand-tick disagreement is not
 * harmless here: Minecraft only lets you into a bed between 12542 and 23459,
 * so for the last five hundred ticks of "night" this behavior would craft a
 * bed, place it, and have the server refuse the sleep.
 *
 * shelter.js had the identical bug and it has already been fixed there. Two
 * copies of a fact is one too many; three was asking for it.
 */
function isNight(bot) {
  return timeInfo(bot).isNight;
}

/**
 * Throttled, because of where it is asked from.
 *
 * `bed.shouldRun` sits above the interrupt floor, so the director's
 * supervisor evaluates it every 60ms — and this is a findBlock sweep across
 * sixteen bed colours. All night, sixteen times a second. Beds do not move,
 * and the bot cannot walk out of a twelve-block radius in a second.
 */
const BED_SCAN_THROTTLE_MS = 2000;

function findPlacedBed(bot) {
  const now = Date.now();
  const cached = bot._bedScan;
  if (cached && now - cached.at < BED_SCAN_THROTTLE_MS) return cached.block;

  const block = findNearest(bot, BED_NAMES, 12);

  bot._bedScan = { at: now, block };
  return block;
}

const bed = {
  name: 'bed',
  /**
   * Above shelter: if we can sleep, burrowing is the worse plan — a bed skips
   * the night outright and resets the phantom clock. Below unstick, because a
   * bot that cannot move cannot place a bed either.
   *
   * This was 90, and the comment above it had quietly become false: shelter
   * was raised to 91 to stop combat interrupting a half-dug hole, which put
   * burrowing AHEAD of sleeping and inverted the intended order without
   * anything complaining. Stated relationships are worth checking when a
   * neighbour moves.
   */
  priority: 92,
  shouldRun(bot, ctx) {
    if (bot.health <= 0 || bot.isSleeping) return false;
    if (Date.now() < (ctx.bed.until || 0)) return false;
    if (!isNight(bot)) return false;

    // Already have one down and usable? Go use it.
    if (heldBed(bot) || findPlacedBed(bot)) return true;

    // Otherwise, can we make one right now? Wool comes from sheep, which
    // hunt.js already kills for food, so this tends to be satisfied for
    // free rather than needing its own gathering trip.
    //
    // ANY log makes planks — this counted oak alone, so a bot in a birch or
    // spruce forest with three wool and a stack of logs never considered a bed.
    return !!craftableBedColour(bot)
      && (countAny(bot, plankNames(bot)) >= 3 || !!findItem(bot, (i) => i.name.endsWith('_log')));
  },
  async run(bot, ctx, task) {
    // --- craft, if we need to -------------------------------------------
    if (!heldBed(bot) && !findPlacedBed(bot)) {
      const colour = craftableBedColour(bot);
      if (!colour) return false;

      const table = await ensureTable(bot, ctx, task);
      if (!table) return false;
      await ensurePlanks(bot, 3, task);
      task.throwIfAborted();

      if (!(await craftItem(bot, `${colour}_bed`, 1, table))) {
        ctx.bed.until = Date.now() + RETRY_AFTER_FAILURE_MS;
        return false;
      }
      logger.action('Crafted a bed', { colour });
    }

    // --- place it --------------------------------------------------------
    let bedBlock = findPlacedBed(bot);
    if (!bedBlock) {
      const held = heldBed(bot);
      if (!held) return false;
      bedBlock = await placeFromInventory(bot, held.name, task);
      if (!bedBlock) {
        ctx.bed.until = Date.now() + RETRY_AFTER_FAILURE_MS;
        logger.info('Nowhere to put the bed down');
        return false;
      }
      logger.action('Placed bed', { pos: bedBlock.position });
    }

    // --- get to it --------------------------------------------------------
    //
    // mineflayer's sleep() is a right-click on the bed, and it refuses
    // outright — "the bed is too far", or "cant click the bed" — unless the bot
    // is within a couple of blocks of it (mineflayer/lib/plugins/bed.js). A bed
    // this bot has just placed is next to it by construction; any OTHER bed
    // findPlacedBed turns up, up to twelve blocks away, never was. So a bed put
    // down last night, or one in a village, was found every evening, never
    // walked to, refused, and retried twenty seconds later, all night.
    try {
      await goToBlock(bot, bedBlock, task, { within: BED_REACH, timeoutMs: 15000 });
    } catch (err) {
      if (isInterruption(err)) throw err;
      ctx.bed.until = Date.now() + RETRY_AFTER_FAILURE_MS;
      logger.info('Could not get to the bed', { pos: bedBlock.position, reason: err.message });
      return false;
    }

    // --- sleep -----------------------------------------------------------
    if (hostilesNear(bot, MONSTER_FREE_RADIUS)) {
      // Not a failure: threat/shelter will deal with them and we'll be back.
      logger.info('Too many monsters nearby to sleep');
      ctx.bed.until = Date.now() + 5000;
      return false;
    }

    try {
      await bot.sleep(bedBlock);
      // Reset the insomnia clock. Phantoms begin spawning after three full
      // days awake, and this is the only thing that stops them — remembered
      // across restarts so the count is not silently forgotten.
      memory.noteSlept(bot.time?.day ?? 0);
      logger.action('Slept — insomnia clock reset', {
        day: bot.time?.day,
        phantomsAvoided: true,
      });
    } catch (err) {
      if (isInterruption(err)) throw err;
      // "not night", "monsters nearby", "bed occupied", "too far away" all
      // land here. None are worth retrying immediately.
      ctx.bed.until = Date.now() + RETRY_AFTER_FAILURE_MS;
      logger.info('Could not sleep', { reason: err.message });
      return false;
    }

    logger.action('Sleeping through the night');
    const sleptAt = Date.now();
    const deadline = sleptAt + MAX_SLEEP_MS;
    while (bot.isSleeping && Date.now() < deadline) {
      task.throwIfAborted();
      await wait(SLEEP_POLL_MS, task);

      if (nightIsNotSkipping(bot, sleptAt, Date.now())) {
        // Somebody else is awake — on a LAN world, usually the person playing
        // it — and the night only skips when every player is in bed. Lying
        // here would be the whole night doing nothing at all, a minute at a
        // time, since this behavior would simply lie down again. The spawn
        // point and the phantom clock were reset by getting into bed; that is
        // all the bed can do tonight. Leave it alone until dawn.
        ctx.bed.until = Date.now() + timeInfo(bot).secondsUntilDawn * 1000;
        logger.info('The night is not being skipped — someone is still up; getting out of bed', {
          dawnInSec: timeInfo(bot).secondsUntilDawn,
        });
        try {
          await bot.wake();
        } catch {
          // already awake
        }
        return true;
      }
    }

    if (bot.isSleeping) {
      try {
        await bot.wake();
      } catch {
        // already awake, or the server woke us
      }
    }
    logger.action('Morning', { health: Math.round(bot.health) });
    return true;
  },
};

/**
 * Would a sheep be worth taking if one happened to be in front of us?
 *
 * A bed skips the whole night — the single biggest time saving available to
 * this bot, since a night is ten real minutes it otherwise spends in a hole.
 * But going LOOKING for sheep is a detour off the progression, so this is
 * only ever consulted when the bot is already about to kill something for
 * food: if one of the animals in range happens to be a sheep and we have no
 * bed, take that one. Same trip, extra reward.
 */
function wantsWool(bot) {
  if (heldBed(bot)) return false;
  return !craftableBedColour(bot);
}

/**
 * How close we are to phantoms.
 *
 * They begin spawning after three full in-game days without sleep, at night,
 * and only under open sky. They are fast (0.4 blocks/tick — faster than
 * sprinting, so fleeing does not work), they come from above where a
 * ground-level standoff cannot reach them, and they keep coming.
 *
 * Every counter is preventative rather than reactive: sleep resets the clock,
 * a block overhead stops them spawning at all, and daylight burns them. So
 * this exists to make the bot act BEFORE day three, while the fix is still
 * cheap — three wool from a sheep it was going to kill anyway.
 */
function insomniaRisk(bot) {
  const days = daysAwake(bot, memory.lastSleptDay());
  return {
    days,
    imminent: days >= PHANTOM_INSOMNIA_DAYS - 1,
    active: days >= PHANTOM_INSOMNIA_DAYS,
  };
}

module.exports = {
  bed, wantsWool, insomniaRisk,
  // For the tests: when lying in bed has stopped being worth it.
  nightIsNotSkipping, NIGHT_SKIP_WAIT_MS,
};
