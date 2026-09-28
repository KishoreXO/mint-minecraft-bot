const logger = require('../logger');
const { sleep, isInterruption } = require('../task');
const { goNear, goNearXZ, goToHeight } = require('../nav');
const { findNearestTiered } = require('../blocks');
const { LOG_NAMES } = require('./wood');
const { EDIBLE } = require('./survive');
// wood.js already loaded mine.js, so this is not a new edge in the graph.
const { DEEP_TRIP_NEEDS } = require('./mine');
const {
  countAny, woodUnits, bestToolOfType, STONE_MATERIAL,
} = require('../inventory');

/**
 * Go looking for work.
 *
 * Without this the bot just stands still whenever there's no tree/ore/animal
 * within its search radius, which looks broken and never resolves itself.
 *
 * Prefers heading toward something it can actually see at long range; only
 * falls back to a held random heading when there's genuinely nothing in
 * sight, so it covers ground instead of jittering around one spot.
 */

const LEG_DISTANCE = 28;
/**
 * Kept modest on purpose, and now tiered as well.
 *
 * findBlocks is synchronous and its cost grows with the cube of the radius —
 * an earlier value of 110 scanned millions of positions and pegged the event
 * loop hard enough to freeze the whole bot. 64 is better and is still the
 * single most expensive call the bot makes, because this behavior only ever
 * runs when nothing is nearby, which is precisely the case where findBlocks
 * cannot stop early and scans every section in range.
 *
 * So ask 24 first. If there is a tree at 24 the bot should be walking to it
 * rather than planning a 64-block trek anyway.
 */
const LONG_RANGE = [24, 48];
const LONG_SCAN_THROTTLE_MS = 6000;
/**
 * After a sweep that found NOTHING, wait longer and move first.
 *
 * The lag meter caught this directly: "Event loop stalled — the bot could not
 * react {forMs: 777, doing: explore, droppedTicks: 16}". Sixteen dropped ticks
 * is nearly a second in which the bot cannot see, move or swing, and it was
 * happening every six seconds.
 *
 * The cause is inherent to findBlocks: it walks whole 16-block sections and can
 * only stop early once it has enough HITS, so a search that comes back empty is
 * the expensive one — and this behavior only ever runs when nothing is nearby,
 * which is exactly when every search comes back empty. The widest tier was 64,
 * an apothem of five sections, so 11x11x11 sections at up to 4096 positions
 * each.
 *
 * Two changes, both about not paying for the same answer twice. The widest tier
 * drops from 64 to 48 — a tree at 64 is a trek the bot should not be planning
 * when it could walk 28 blocks and look again — and an empty sweep is not
 * repeated until the bot has actually gone somewhere new. Standing still and
 * re-scanning the identical sphere cannot produce a different result; it can
 * only cost another second.
 */
const EMPTY_SCAN_THROTTLE_MS = 20000;
const RESCAN_AFTER_MOVING = 16;
const LEG_TIMEOUT_MS = 15000;
const HEADING_HOLD_MS = 45000;
const TURN_ON_FAILURE_RAD = Math.PI / 2;

// Only surface-reachable things. Ore was in this list and it was actively
// harmful: it sits encased in rock, so "head toward that ore" resolved to a
// point the bot could not stand at, failed, and dropped through to random
// wandering — the bot looked like it was pacing aimlessly past resources.
//
// Still true now that pathfinder may dig again, and for a better reason:
// digCost makes tunnelling a last resort, and `mine` already owns reaching
// buried ore deliberately, with the lava checks and tool handling that a
// blind pathfinder tunnel would skip.
const SEEK_NAMES = [...LOG_NAMES];

/** Anything worth walking toward, beyond the working behaviors' own radius. */
function spotDistantResource(bot, ctx) {
  const now = Date.now();
  const throttle = ctx.explore.lastScanEmpty
    ? EMPTY_SCAN_THROTTLE_MS
    : LONG_SCAN_THROTTLE_MS;
  if (now - ctx.explore.lastLongScanAt < throttle) return null;

  // An empty answer from this exact spot is still empty. Only pay for the
  // sweep again once the sphere it covers has actually changed.
  const from = ctx.explore.lastLongScanFrom;
  if (ctx.explore.lastScanEmpty
    && from
    && bot.entity.position.distanceTo(from) < RESCAN_AFTER_MOVING) return null;

  ctx.explore.lastLongScanAt = now;
  ctx.explore.lastLongScanFrom = bot.entity.position.clone();

  const hits = findNearestTiered(bot, SEEK_NAMES, LONG_RANGE, 1);
  ctx.explore.lastScanEmpty = hits.length === 0;
  if (hits.length === 0) return null;
  const found = bot.blockAt(hits[0]);
  if (!found) return null;

  // Ignore anything far below us — it's in a cave or ravine we can't walk to.
  if (found.position.y < bot.entity.position.y - 4) return null;
  return found;
}

/**
 * The single thing most worth finding right now.
 *
 * Exploration is the lowest-priority behavior, so it only runs when nothing
 * else can act — which means it is always a symptom of a shortage. Naming
 * that shortage turns aimless wandering into a stated errand, and makes it
 * obvious in the log when the bot is walking for a reason and when it is
 * simply walking.
 */
function whatWeNeed(bot) {
  if (countAny(bot, EDIBLE) < DEEP_TRIP_NEEDS.food) return 'food';
  // woodUnits, not a count of its own. This had its own inline version, and
  // several slightly different ways of counting wood is precisely what
  // deadlocked the descent — see the note on woodUnits in inventory.js.
  if (woodUnits(bot) < DEEP_TRIP_NEEDS.planks) return 'trees';
  if (!bestToolOfType(bot, 'pickaxe')) return 'stone for a pickaxe';
  if (countAny(bot, STONE_MATERIAL) < DEEP_TRIP_NEEDS.placeable) return 'stone';
  return null;
}

function chooseHeading(ctx) {
  const now = Date.now();
  if (ctx.explore.heading === null || now - ctx.explore.headingSetAt > HEADING_HOLD_MS) {
    ctx.explore.heading = Math.random() * Math.PI * 2;
    ctx.explore.headingSetAt = now;
  }
  return ctx.explore.heading;
}

/** Where to climb to when below the needed ore's band, or null. */
function neededBandFloor(bot) {
  // Required lazily: mine.js is large and explore only needs two answers.
  const { neededResource, ORE_DEPTH } = require('./mine');
  const band = ORE_DEPTH[neededResource(bot)];
  if (!band || bot.entity.position.y >= band.min) return null;
  return band.min + 2;
}

const explore = {
  name: 'explore',
  priority: 5, // above idle, below any real work
  shouldRun() {
    return true;
  },
  async run(bot, ctx, task) {
    // Exploring is movement, so "did it work?" means "did we move?". Saying
    // yes regardless let a walled-in bot report productive exploration
    // forever: the no-op backoff never engaged, and (because the director
    // treats real work as proof of progress) the stuck-detector was reset on
    // every attempt, so `unstick` could never fire either. It stood at one
    // coordinate picking new compass headings until something killed it.
    const startedAt = bot.entity.position.clone();
    const moved = () => bot.entity.position.distanceTo(startedAt) > 2;

    // BELOW EVERYTHING WE NEED, GO UP — not sideways.
    //
    // Wandering is for the surface, where it finds trees. Underground it aims
    // 28 blocks away at its own height, which is usually solid rock, turns 90°
    // on every failure and circles the same cave floor: 28 of 36 legs failed on
    // 09-24. When the bot is below the band the ore it needs comes from, the
    // useful direction is known.
    const floor = neededBandFloor(bot);
    if (floor !== null) {
      logger.info('Below where anything I need is — climbing back up', {
        y: Math.round(bot.entity.position.y),
        to: floor,
      });
      try {
        await goToHeight(bot, floor, task);
        if (moved()) return true;
      } catch (err) {
        if (isInterruption(err)) throw err;
        // No way up from here; wander after all, and look again next leg.
      }
    }

    const spotted = spotDistantResource(bot, ctx);
    if (spotted) {
      logger.info('Heading toward resources spotted at range', {
        block: spotted.name,
        pos: spotted.position,
        distance: Math.round(bot.entity.position.distanceTo(spotted.position)),
      });
      try {
        // Stop short — once in range the real gathering behaviors take over.
        // goNear's own deadline — see the note on the leg below.
        await goNear(bot, spotted.position, 6, task, { timeoutMs: LEG_TIMEOUT_MS });
        if (moved()) return true;
      } catch (err) {
        if (isInterruption(err)) throw err;
        // Couldn't get there; fall through to blind exploration.
      }
    }

    const heading = chooseHeading(ctx);
    const target = bot.entity.position.offset(
      Math.cos(heading) * LEG_DISTANCE,
      0,
      Math.sin(heading) * LEG_DISTANCE,
    );

    // Say WHY we are walking.
    //
    // "Wandering around with no purpose is the same as AFK" — and from the
    // outside the two are indistinguishable, because the log said only
    // "Exploring for resources" with a compass bearing. Naming the thing we
    // are short of makes the difference visible: a bot covering ground to
    // find trees is working, a bot covering ground for no stated reason is
    // the bug. If nothing is missing, this says so too, which is itself the
    // signal that something upstream has stalled.
    logger.info('Exploring', {
      lookingFor: whatWeNeed(bot) ?? 'nothing in particular — this is the fallback',
      heading: Math.round((heading * 180) / Math.PI),
      from: bot.entity.position.floored(),
    });

    try {
      // Deadline matters here: pathfinder will keep re-planning toward an
      // unreachable point indefinitely, which stalled the bot in place for
      // half a minute at a time with no error to show for it.
      // A heading, so no height to match — see goNearXZ.
      //
      // The walk's OWN deadline. A withDeadline wrapped around it gave up
      // waiting at fifteen seconds and left the walk running: the behavior
      // returned, the next one started, and the orphaned leg went on setting
      // pathfinder goals until its own timer ran out — then cleared the goal
      // and every control state out from under whatever was steering by then.
      await goNearXZ(bot, target, 3, task, { timeoutMs: LEG_TIMEOUT_MS });
    } catch (err) {
      if (isInterruption(err)) throw err;
      // Blocked that way (wall, water, cliff) — turn and try elsewhere next time.
      ctx.explore.heading = (heading + TURN_ON_FAILURE_RAD) % (Math.PI * 2);
      ctx.explore.headingSetAt = Date.now();
      await sleep(400, task);
    }
    return moved();
  },
};

module.exports = {
  explore,
  // For the tests: where "go up" means when the bot is below everything it needs.
  neededBandFloor,
};
