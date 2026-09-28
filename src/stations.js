const logger = require('./logger');
const { knownBase, remember, forget } = require('./base');
const { goToBlock, goNear, feetCell } = require('./nav');
const { findNearest } = require('./blocks');
const { sleep, isInterruption } = require('./task');
const Vec3 = require('vec3');
const {
  hasItem, itemCount, findItem, plankNames, countAny, craftItem, digBlock, equipIfDifferent,
  tryPlaceBlock, STONE_MATERIAL,
} = require('./inventory');

const RELOCATE_MAX_DISTANCE = 120;
const CHUNK_SETTLE_ATTEMPTS = 4;

/**
 * How far a remembered station is worth walking back to AT ALL.
 *
 * A crafting table is four planks. A furnace is eight cobblestone. The bot
 * routinely carries a hundred of each. Walking sixty blocks to reach one — and
 * sixty back to whatever it was doing — is minutes of travel to save materials
 * it will never miss, and it does that walk every single time it wants to
 * smelt.
 *
 * Watched live: the bot bouncing between a furnace at (26,71,30) and animals at
 * (69,86,84), fifteen seconds of `smelt` and fifteen of `hunt`, over and over,
 * with "Couldn't reach the old furnace — leaving it behind" twice in two
 * minutes. It made no progress at all in three minutes of that.
 *
 * Twenty-four blocks is a few seconds' walk and is worth it. Past that, build
 * another — and leave the old one, which is precisely the case the user carved
 * out: retrieve the workshop "unless the crafting table or furnace is hard to
 * retrieve". A hundred-and-twenty-block round trip is hard to retrieve.
 */
const WORTH_WALKING_TO = 24;

/**
 * NEVER SEARCH FURTHER THAN WE ARE WILLING TO WALK — and that is not a figure
 * of speech, it is this constant.
 *
 * This was 48, which is an apothem of four chunk sections — 729 of them, each
 * up to 4096 positions, synchronously. The stall instrumentation caught it
 * directly: `findBlock r48 755ms worst / 1178ms in 3`, three quarters of a
 * second of a bot that cannot see, move or swing, to look for a crafting table.
 *
 * It then became 28, with a note saying anything past WORTH_WALKING_TO was
 * discarded anyway. It was not. tooFarToBother would forget a table at 26
 * blocks as not worth the walk, and `locate`'s nearby search would find the
 * very same table a moment later, inside 28, and walk to it. Watched live:
 * "The old crafting table is too far to be worth the walk {distance: 28}",
 * then "Going to collect the old crafting table" four seconds later, then a
 * failed trip to it. Two numbers that must agree, so it is one number.
 */
const NEARBY_RADIUS = WORTH_WALKING_TO;

/** Can we just make a new one here, rather than walking to the old one? */
function canAffordTable(bot) {
  return hasItem(bot, 'crafting_table')
    || countAny(bot, plankNames(bot)) >= 4
    || !!findItem(bot, (i) => i.name.endsWith('_log'));
}

function canAffordFurnace(bot) {
  return hasItem(bot, 'furnace') || countAny(bot, STONE_MATERIAL) >= 8;
}

/**
 * Is the station we remember too far to be worth the trip, given we could
 * simply build another where we stand?
 */
function tooFarToBother(bot, key, affordable) {
  const pos = knownBase[key];
  if (!pos) return false;
  if (!affordable) return false; // can't build one; the walk is the only option
  return bot.entity.position.distanceTo(pos) > WORTH_WALKING_TO;
}

/**
 * Stations we know exist but cannot actually walk to.
 *
 * Without this the bot deadlocks completely: `gear` asks for the crafting
 * table, gets the one it remembers, fails to path to it ("navigation
 * stalled" after six seconds), and next tick is handed the exact same table
 * again. Observed live as 45 unbroken seconds of `gear` failing on repeat
 * while the bot stood still and never crafted the sword it desperately
 * needed. A crafting table costs four planks — building a fresh one is
 * always cheaper than another minute of walking into a wall.
 */
const unreachable = new Map(); // "x,y,z" -> ignore-until timestamp
const UNREACHABLE_HOLD_MS = 90000;

// Consecutive failed approaches before a station is written off. One failure
// means nothing — pathfinder gives up on ordinary distances all the time.
const unreachableStrikes = new Map(); // "x,y,z" -> consecutive failures
const DISOWN_AFTER_STRIKES = 3;

// Never place a station when one is already this close. A block we can see
// from where we stand is reachable by definition, whatever the blacklist
// thinks — and placing beside it is how the duplicates accumulated.
const DUPLICATE_GUARD_RADIUS = 8;

// Beyond this, a remembered station is treated as stale rather than as a
// chunk that hasn't loaded yet. Building a new one is far cheaper than
// walking a few hundred blocks to something that may not be there.
const STALE_MEMORY_DISTANCE = 150;

function posKey(pos) {
  return `${Math.floor(pos.x)},${Math.floor(pos.y)},${Math.floor(pos.z)}`;
}

function sameSpot(a, b) {
  return !!a && !!b && posKey(a) === posKey(b);
}

/**
 * A station is only usable from INSIDE ARM'S REACH, and this module kept
 * handing back ones that were not.
 *
 * Opening a crafting table is `activateBlock`, which the server ignores
 * outright when the block is further away than the ~4.5 interaction limit. It
 * does not refuse it; it says nothing. mineflayer then waits twenty seconds for
 * a `windowOpen` that is never coming, and — because it caches the window it
 * opened in a module-level variable — the failure poisons every craft after it,
 * including the table-free ones for planks and sticks.
 *
 * Every one of the short-circuits below ("there is already a table within eight
 * blocks, use that") returned without walking anywhere. Eight is nearly double
 * the reach. So `gear` was handed an unusable table over and over, every craft
 * hung for nine seconds, the bot stood still through all of it, and its wood
 * drained away into plank batches for tools it never managed to make.
 *
 * Nothing leaves this module now without the bot standing at it.
 */
const USE_REACH = 3.0;

function withinReach(bot, block) {
  return bot.entity.position.distanceTo(block.position.offset(0.5, 0.5, 0.5)) <= USE_REACH;
}

/**
 * Stay-put mode: use only what is within arm's reach, or put one down here.
 *
 * For crafting from inside a sealed shelter. Every "go and stand at it" in
 * this module is a walk, and a walk from the bottom of a sealed shaft is a
 * walk out of it — through the lid, into the night the shaft was dug to keep
 * out. So while this is on, a station out of reach simply does not count.
 */
let stayPut = false;

async function stayingPut(fn) {
  const was = stayPut;
  stayPut = true;
  try {
    return await fn();
  } finally {
    stayPut = was;
  }
}

async function standAt(bot, block, task) {
  if (!block) return null;
  if (withinReach(bot, block)) return block;
  if (stayPut) return null;
  try {
    await goToBlock(bot, block, task, { within: USE_REACH, timeoutMs: 15000 });
  } catch (err) {
    if (isInterruption(err)) throw err;
    logger.info('Could not get to the station to use it', {
      station: block.name,
      pos: block.position,
      reason: err.message,
    });
    return null;
  }
  // Still have to be there. goToBlock can return having got as close as it
  // can, which for a table across a ravine is not close enough to open it.
  return withinReach(bot, block) ? block : null;
}

function isUnreachable(pos) {
  const until = unreachable.get(posKey(pos));
  return !!until && until > Date.now();
}

/**
 * Both of these live at module scope, so nothing sweeps them the way the
 * director sweeps its ctx maps — they simply grow for the life of the process.
 * One entry per station position is small, but the bot is meant to run for
 * hours and this is exactly the shape of leak that ended a run at two gigabytes
 * of heap. Expiring on write costs one pass over a handful of keys.
 */
function pruneExpired() {
  const now = Date.now();
  for (const [key, until] of unreachable) {
    if (until < now) {
      unreachable.delete(key);
      unreachableStrikes.delete(key);
    }
  }
}

function markUnreachable(pos) {
  pruneExpired();
  unreachable.set(posKey(pos), Date.now() + UNREACHABLE_HOLD_MS);
}

function findBlockNamed(bot, names, maxDistance = NEARBY_RADIUS) {
  const found = findNearest(bot, names, maxDistance);
  if (found && isUnreachable(found.position)) return null;
  return found;
}

function recall(bot, key, names) {
  const pos = knownBase[key];
  if (!pos) return null;
  if (isUnreachable(pos)) return null;
  const block = bot.blockAt(pos);
  return block && names.includes(block.name) ? block : null;
}

/**
 * Get to a station we've found, or disown it.
 *
 * Reachability is the station module's problem, not the caller's — callers
 * that did their own goToBlock() had no way to recover from a station they
 * could see but not reach, so they simply failed forever.
 */
/**
 * A station is worth walking a long way for.
 *
 * goToBlock's default 20s gives up on a table forty blocks away across
 * broken ground — and giving up here is expensive, because three failures
 * disown the station and the bot builds a duplicate. A crafting table is the
 * gate on every tool the bot owns; spending a minute reaching one is a
 * bargain next to abandoning it.
 */
const STATION_TRIP_MS = 45000;

async function approachOrDisown(bot, block, key, label, task) {
  const pk = posKey(block.position);
  try {
    // Arrive INSIDE the reach the caller then checks for. goToBlock's default
    // is digging reach, 4.2, and every caller follows this with
    // withinReach's 3.0 — so a table reached at four blocks counted as
    // reached, failed the reach test, and fell through to `retrieve`, which
    // walked the last metre, broke the table, carried it one step and put it
    // down again.
    await goToBlock(bot, block, task, { within: USE_REACH, timeoutMs: STATION_TRIP_MS });
    unreachableStrikes.delete(pk); // got there in the end
    return true;
  } catch (err) {
    if (isInterruption(err)) throw err;

    // Do NOT disown on a single failure.
    //
    // goToBlock gives up after 20s, or 6s without progress, which happens
    // routinely for a table 40 blocks away or one briefly blocked by a mob.
    // Disowning immediately was catastrophic in a way that took a while to
    // spot: the position gets blacklisted, so the nearby-search then skips
    // the perfectly good table standing right there, and the bot places a
    // NEW one beside it. Do that a few times and the base is a field of
    // crafting tables — which is exactly what it looked like in game.
    const strikes = (unreachableStrikes.get(pk) ?? 0) + 1;
    unreachableStrikes.set(pk, strikes);

    if (strikes < DISOWN_AFTER_STRIKES) {
      logger.info(`Could not reach the ${label} this time — will try again`, {
        pos: block.position,
        strikes,
        reason: err.message,
      });
      return false;
    }

    logger.warn(`Giving up on that ${label} after ${strikes} tries — building a new one`, {
      pos: block.position,
    });
    markUnreachable(block.position);
    forget(key);
    return false;
  }
}

/**
 * Right after a respawn the chunk holding our base often isn't loaded yet,
 * so a single lookup wrongly concludes "no table exists" and we build a
 * redundant one. Retry for a few seconds before giving up.
 */
async function locate(bot, key, names, task) {
  for (let attempt = 0; attempt < CHUNK_SETTLE_ATTEMPTS; attempt++) {
    const remembered = recall(bot, key, names);
    if (remembered) return remembered;

    const nearby = findBlockNamed(bot, names);
    if (nearby) {
      remember(key, nearby.position);
      return nearby;
    }

    if (!knownBase[key]) return null; // nothing was ever placed

    // A remembered position far outside loaded chunks isn't "still loading",
    // it's stale — most often left over in known-base.json from a world the
    // player has since replaced. Waiting on it costs ~3 seconds per lookup
    // and risks a very long walk to a table that no longer exists.
    if (bot.entity.position.distanceTo(knownBase[key]) > STALE_MEMORY_DISTANCE) {
      logger.info(`Remembered ${key} is too far to be real — forgetting it`, {
        pos: knownBase[key],
        distance: Math.round(bot.entity.position.distanceTo(knownBase[key])),
      });
      forget(key);
      return null;
    }

    // The remembered spot is loaded and is definitively NOT our station —
    // so it's gone, or the file is left over from a different world.
    // known-base.json survives process restarts by design, which means it
    // also survives the player making a brand new world; without this the
    // bot would trek to phantom coordinates from a world that no longer
    // exists, every time it wanted to craft.
    const atRemembered = bot.blockAt(knownBase[key]);
    if (atRemembered && !names.includes(atRemembered.name)) {
      logger.info(`Remembered ${key} is gone — forgetting it`, {
        pos: knownBase[key],
        found: atRemembered.name,
      });
      forget(key);
      return null;
    }

    await sleep(700, task);
  }
  return null;
}

/** Walk back to a distant station and pick it up so we can re-place it here. */
async function retrieve(bot, key, names, label, task) {
  const pos = knownBase[key];
  if (!pos) return false;

  logger.action(`Going to collect the old ${label}`, { pos });
  try {
    await goNear(bot, pos, 2, task);
  } catch (err) {
    if (isInterruption(err)) throw err;
    logger.warn(`Couldn't reach the old ${label} — leaving it behind`, { error: err.message });
    forget(key);
    return false;
  }

  const block = bot.blockAt(pos);
  if (!block || !names.includes(block.name)) {
    logger.warn(`Old ${label} is gone — forgetting it`);
    forget(key);
    return false;
  }

  await goToBlock(bot, block, task);
  const dug = await digBlock(bot, block, task);
  forget(key);
  if (dug) logger.action(`Collected the old ${label} to bring along`);
  return dug;
}

/**
 * A block we could stand a station on.
 *
 * `skip` walks through the candidates so a retry gets a genuinely different
 * spot rather than the same refused one again — but it WRAPS, and that is the
 * whole point of it. Skipping used to run off the end of the list and return
 * null, which the caller reads as "nowhere to put this" and gives up on.
 * Underground there is usually exactly one spot, so the second attempt always
 * ran off the end: one refused placement ended the operation, which is the
 * precise failure PLACE_ATTEMPTS was added to prevent. Across the logs that is
 * 26 of 103 give-ups reporting `tried: 1` — a quarter of them abandoning a
 * spot that existed. Wrapping means a lone spot gets retried (the bot has
 * usually drifted back into reach by then) instead of being forgotten.
 *
 * The offsets are ordered nearest-first because placement reach is about 4.5
 * blocks and a refusal at the edge of it is indistinguishable from a refusal
 * for any other reason.
 */
/**
 * Levels to look on, same level first.
 *
 * Level ground only was not enough, and the case it missed is the one where a
 * table matters most. Inside the bot's own staircase there IS no level spot:
 * the cell ahead is the next step down, the cell behind is the previous step
 * up, and both sides are rock. Watched live at y=41 with the pickaxe just
 * broken: "Nowhere clear to place block {tried: 0}", three times, and "Could
 * not make that: stone_pickaxe" — a bot a crafting table away from a new
 * pickaxe, with the table in its bag. The step behind is a perfectly good
 * floor one level up; `tidy` packs the table up again once it is done with.
 */
const PLACEMENT_LEVELS = [0, 1, -1];

// Half a player's width, plus a hair so touching counts as in the way.
const BODY_HALF_WIDTH = 0.3 + 0.01;
const BODY_HEIGHT = 1.8;

function overlapsBody(bot, cell) {
  const p = bot.entity.position;
  return p.x + BODY_HALF_WIDTH > cell.x && p.x - BODY_HALF_WIDTH < cell.x + 1
    && p.z + BODY_HALF_WIDTH > cell.z && p.z - BODY_HALF_WIDTH < cell.z + 1
    && p.y + BODY_HEIGHT > cell.y && p.y < cell.y + 1;
}

function findPlacementSpot(bot, skip = 0) {
  const offsets = [
    [1, 0], [-1, 0], [0, 1], [0, -1],
    [1, 1], [1, -1], [-1, 1], [-1, -1],
    [2, 0], [-2, 0], [0, 2], [0, -2],
  ];
  // From the cell the feet are actually in, not the raw float position. At
  // y=N.99999 — which the server routinely sends for a bot standing on a
  // block — the float version probed one block too low, found its own floor
  // where it wanted air, and rejected every spot on flat ground: `tried: 0`.
  // See feetCell in nav.js; this is the same rounding, in one more place.
  const feet = feetCell(bot);
  const spots = [];
  for (const dy of PLACEMENT_LEVELS) {
    for (const [dx, dz] of offsets) {
      const cell = feet.offset(dx, dy, dz);
      // Not a cell the bot's own body is in. The feet CELL is one column, but
      // the body is 0.6 wide: standing at x=65.75 it reaches into x=66, and the
      // server refuses a block where a player stands. Live on 09-24 the table
      // was refused at (66,-18,78) and then the furnace at the SAME cell, one
      // second later — both tried first because +x is the first offset.
      if (overlapsBody(bot, cell)) continue;
      const below = bot.blockAt(cell.offset(0, -1, 0));
      const at = bot.blockAt(cell);
      const above = bot.blockAt(cell.offset(0, 1, 0));
      if (below?.boundingBox === 'block'
        && at?.boundingBox === 'empty' && at.name !== 'water'
        && above?.boundingBox === 'empty') {
        spots.push(below);
      }
    }
  }
  if (spots.length === 0) return null;
  return spots[skip % spots.length];
}

const LIQUID = /(^|_)(water|lava)$|^bubble_column$/;
const FACES = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];

/**
 * No spot anywhere? Make one: cut a niche into the wall beside our feet.
 *
 * At the bottom of a one-wide shaft every neighbouring cell is stone, so
 * findPlacementSpot finds nothing — "Nowhere clear to place block {tried: 0}"
 * thirty-four times on one world, and a bot with cobblestone and sticks in
 * its bag unable to make a stone pickaxe for half a minute at a time because
 * there was nowhere to stand the table. A player just mines one block out of
 * the wall and puts the table in the gap.
 *
 * Only the one cell is cleared, and the station then fills it, so no window
 * is left in a shelter wall. Nothing that lets water or lava in, nothing with
 * gravel over it, and only plain ground we can dig quickly — see canDigThrough.
 * Returns the block to place on top of, like findPlacementSpot, or null.
 */
async function carvePlacementSpot(bot, task) {
  // Lazy: both modules sit above this one in the require graph.
  const { canDigThrough } = require('./behaviors/unstick');
  const { isFallingBlock } = require('./behaviors/mine');
  const feet = feetCell(bot);
  for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
    const cell = feet.offset(dx, 0, dz);
    const at = bot.blockAt(cell);
    const below = bot.blockAt(cell.offset(0, -1, 0));
    if (at?.boundingBox !== 'block' || below?.boundingBox !== 'block') continue;
    if (!canDigThrough(bot, at)) continue;
    if (isFallingBlock(bot.blockAt(cell.offset(0, 1, 0)))) continue;
    const wet = FACES.some(([x, y, z]) => LIQUID.test(bot.blockAt(cell.offset(x, y, z))?.name ?? ''));
    if (wet) continue;
    if (!(await digBlock(bot, at, task))) continue;
    if (bot.blockAt(cell)?.boundingBox !== 'empty') continue;
    logger.action('Cut a space in the wall for it', { pos: cell });
    return below;
  }
  return null;
}

/**
 * How many spots to try before admitting we cannot put this down here.
 *
 * One attempt was not enough, and the failure was expensive rather than
 * cosmetic. Watched live: "Server refused to place furnace at (45,65,50): the
 * block is still air", then the bot crafted a SMOKER out of the same furnace
 * plus four logs and had that refused too — eight cobblestone and four logs
 * spent, no smelter standing, and `smelt` backed off for the rest of the
 * session because ensureFurnace kept returning null. A single refused
 * placement should cost one retry, not the bot's ability to cook.
 *
 * Re-picking the spot each time matters more than retrying the same one: the
 * bot drifts between choosing a spot and placing on it (pathfinder, knockback,
 * the water pilot's float), so the refusal is usually about THAT spot rather than
 * about placement in general.
 */
const PLACE_ATTEMPTS = 4;

async function placeFromInventory(bot, itemName, task) {
  const item = findItem(bot, (i) => i.name === itemName);
  if (!item) return null;

  // Stand still. Half the refusals are the bot having walked out of reach of
  // the spot it chose a moment ago, and nothing else here needs it moving.
  try {
    bot.clearControlStates();
  } catch {
    // disconnected
  }

  // One niche per call at most — see carvePlacementSpot. Kept for the retries:
  // the carved cell has a roof over it, so findPlacementSpot never lists it.
  let carved;
  for (let attempt = 0; attempt < PLACE_ATTEMPTS; attempt++) {
    task.throwIfAborted();

    let reference = findPlacementSpot(bot, attempt);
    if (!reference) {
      if (carved === undefined) carved = await carvePlacementSpot(bot, task);
      reference = carved;
    }
    if (!reference) {
      logger.warn('Nowhere clear to place block', { item: itemName, tried: attempt });
      return null;
    }

    // Re-equip every pass: a preempted craft, a tool swap or an auto-eat can
    // all take the hand back between attempts, and placing with the wrong
    // item in hand silently puts down the wrong block.
    await equipIfDifferent(bot, item);
    task.throwIfAborted();

    if (await tryPlaceBlock(bot, reference, new Vec3(0, 1, 0))) {
      const placed = bot.blockAt(reference.position.offset(0, 1, 0));
      // Confirm it is actually there and is actually ours. tryPlaceBlock only
      // reports that nothing threw.
      if (placed && placed.name === itemName) return placed;
    }
  }

  logger.warn('Placement refused everywhere nearby', {
    item: itemName,
    attempts: PLACE_ATTEMPTS,
    at: bot.entity.position.floored(),
  });
  return null;
}

// Each pass through these loops converts a whole log, so an unbounded loop
// that isn't making progress quietly eats the bot's entire wood supply.
// Observed live: five logs turned into planks in one second while the craft
// that actually mattered kept timing out.
const MAX_CRAFT_PASSES = 4;

// Vanilla yields, so a batch can be asked for in one round trip.
const PLANKS_PER_LOG = 4;
const STICKS_PER_CRAFT = 4;

/**
 * Crafting is a WINDOW TRANSACTION, and each one is a full round trip to the
 * server — craftItem waits for the inventory update and allows up to nine
 * seconds for it. Asking for one recipe at a time therefore pays that round
 * trip once per four planks: sixteen planks for a descent meant four separate
 * waits, in series, every single time the bot restocked.
 *
 * bot.craft takes a count and the server applies it in one go, so ask for what
 * is actually needed. The pass loop stays as the safety net for a craft that
 * silently does nothing — without it an unsatisfiable recipe turns into an
 * unbounded loop that quietly eats the bot's whole wood supply, which is a
 * thing that has happened.
 */
async function ensurePlanks(bot, minCount, task = null) {
  const names = plankNames(bot);
  for (let pass = 0; pass < MAX_CRAFT_PASSES; pass++) {
    const have = countAny(bot, names);
    if (have >= minCount) return true;

    const log = findItem(bot, (i) => i.name.endsWith('_log'));
    if (!log) return false;
    const species = log.name.replace('_log', '');
    // Never ask for more logs than we hold, or the craft is refused outright.
    const batch = Math.min(log.count, Math.ceil((minCount - have) / PLANKS_PER_LOG));
    if (!(await craftItem(bot, `${species}_planks`, Math.max(1, batch), null, task))) return false;
  }
  return countAny(bot, names) >= minCount;
}

async function ensureSticks(bot, minCount, task = null) {
  for (let pass = 0; pass < MAX_CRAFT_PASSES; pass++) {
    const have = itemCount(bot, 'stick');
    if (have >= minCount) return true;

    const batch = Math.max(1, Math.ceil((minCount - have) / STICKS_PER_CRAFT));
    // Two planks per craft. Ask for the whole batch's worth up front rather
    // than discovering it one craft at a time.
    if (!(await ensurePlanks(bot, batch * 2, task))) return false;
    if (!(await craftItem(bot, 'stick', batch, null, task))) return false;
  }
  return itemCount(bot, 'stick') >= minCount;
}

/**
 * Stamp "we are using a station right now".
 *
 * `tidy` packs the workshop up to carry it, and needs to know the difference
 * between "finished here and moving on" and "between two crafts". Without
 * this it read the moment `gear` ran out of things to make as the moment to
 * break the table — while the bot was still standing at it, about to need it
 * again as soon as it had more cobblestone.
 */
function noteStationUse(ctx) {
  if (!ctx) return;
  ctx.stations = ctx.stations ?? { lastUsedAt: 0 };
  ctx.stations.lastUsedAt = Date.now();
}

/**
 * IF WE ARE CARRYING ONE, PUT IT DOWN. That is the entire point of carrying it.
 *
 * This check used to come last, after walking to the remembered station — so
 * a bot at y=16 with a crafting table in its bag would climb sixty blocks to
 * the one it had left on the surface, craft, and climb back. Watched live:
 * the bot reached y=58 with five iron and then reappeared at y=68 doing
 * `smelt`, because the furnace it knew about was up there.
 *
 * The packing behaviour in tidy.js exists precisely to avoid that walk, and
 * the ordering here threw the benefit away.
 */
async function placeCarried(bot, name, key, task) {
  if (!hasItem(bot, name)) return null;
  const placed = await placeFromInventory(bot, name, task);
  if (!placed || placed.name !== name) return null;
  logger.action(`Put down the ${name.replace('_', ' ')} I was carrying`, {
    pos: placed.position,
    why: 'no reason to walk back to the old one',
  });
  remember(key, placed.position);
  return placed;
}

/**
 * The walking half of ensureTable: the remembered table, fetched or approached.
 * Skipped entirely in stay-put mode — see stayingPut.
 */
async function reachKnownTable(bot, task) {
  // Decided BEFORE the walk, not after it. This check existed already but sat
  // below `locate` and `approachOrDisown`, so the bot had already spent up to
  // forty-five seconds failing to reach the thing by the time anyone asked
  // whether reaching it was worth it. See WORTH_WALKING_TO.
  if (tooFarToBother(bot, 'tablePos', canAffordTable(bot))) {
    logger.info('The old crafting table is too far to be worth the walk', {
      distance: Math.round(bot.entity.position.distanceTo(knownBase.tablePos)),
      insteadOf: 'four planks',
    });
    forget('tablePos');
  }

  const existing = await locate(bot, 'tablePos', ['crafting_table'], task);
  // Returning a table we can't get to is worse than returning none: the
  // caller has no way to recover from it. Prove we can stand at it first.
  let failedApproach = null;
  if (existing) {
    if (await approachOrDisown(bot, existing, 'tablePos', 'crafting table', task)) {
      if (withinReach(bot, existing)) return existing;
    } else {
      failedApproach = existing.position;
    }
  }

  // Not the table we just failed to reach. `retrieve` is a walk to the very
  // same spot, so right after a failed approach it only repeats the failure
  // with a shorter timeout — watched live as "Could not reach the crafting
  // table this time" and "Going to collect the old crafting table" in the
  // same second, then a second failure four seconds later.
  if (!hasItem(bot, 'crafting_table') && knownBase.tablePos
    && !sameSpot(knownBase.tablePos, failedApproach)) {
    const dist = bot.entity.position.distanceTo(knownBase.tablePos);
    if (dist <= RELOCATE_MAX_DISTANCE) {
      await retrieve(bot, 'tablePos', ['crafting_table'], 'crafting table', task);
    } else {
      logger.action('Old crafting table is too far — building a new one', { distance: Math.round(dist) });
      forget('tablePos');
    }
  }
  return null;
}

async function ensureTable(bot, ctx, task) {
  noteStationUse(ctx);

  // One already standing within a few blocks beats everything — a table we
  // can see is reachable whatever the notebook or the blacklist think.
  const here = findNearest(bot, ['crafting_table'], DUPLICATE_GUARD_RADIUS);
  if (here) {
    const at = await standAt(bot, here, task);
    if (at) {
      unreachable.delete(posKey(at.position));
      remember('tablePos', at.position);
      return at;
    }
  }

  const carried = await placeCarried(bot, 'crafting_table', 'tablePos', task);
  if (carried) return standAt(bot, carried, task);

  if (!stayPut) {
    const known = await reachKnownTable(bot, task);
    if (known) return known;
  }


  // Last line of defence against a field of crafting tables: if one is
  // already standing within a few blocks, use it, even if it's blacklisted
  // or forgotten. A table we are standing next to is by definition reachable.
  const adjacent = findNearest(bot, ['crafting_table'], DUPLICATE_GUARD_RADIUS);
  if (adjacent) {
    const at = await standAt(bot, adjacent, task);
    if (at) {
      logger.info('There is already a crafting table right here — using it', {
        pos: at.position,
      });
      unreachable.delete(posKey(at.position));
      remember('tablePos', at.position);
      return at;
    }
  }

  if (!hasItem(bot, 'crafting_table')) {
    if (!(await ensurePlanks(bot, 4, task))) return null;
    if (!(await craftItem(bot, 'crafting_table', 1, null, task))) return null;
  }

  const placed = await placeFromInventory(bot, 'crafting_table', task);
  if (!placed || placed.name !== 'crafting_table') return null;

  logger.action('Placed crafting table', { pos: placed.position });
  remember('tablePos', placed.position);
  if (!knownBase.homePos) remember('homePos', placed.position);
  return standAt(bot, placed, task);
}

/**
 * `getTable` is a getter, not a table, on purpose.
 *
 * A crafting table is only needed if a smelter has to be CRAFTED — and most of
 * the time one is standing right there, or being carried. `smelt` used to call
 * ensureTable before anything else, so every furnace trip began with a trip to
 * a table: walking back to an old one, retrieving it, or building a new one,
 * for a furnace that already existed. Watched live, "Made planks to burn"
 * followed by "The old crafting table is too far" and "Going to collect the
 * old crafting table", from a behavior that only wanted to cook. Now the
 * table is fetched only on the branch that crafts.
 */
const NO_TABLE = async () => null;

async function ensureFurnace(bot, ctx, task, getTable = NO_TABLE) {
  // Same ordering as the table, and for the same reason: the furnace in our
  // bag is worth more than the one sixty blocks up a staircase.
  const here = findNearest(bot, ['furnace'], DUPLICATE_GUARD_RADIUS);
  if (here) {
    const at = await standAt(bot, here, task);
    if (at) {
      unreachable.delete(posKey(at.position));
      remember('furnacePos', at.position);
      return at;
    }
  }

  const carried = await placeCarried(bot, 'furnace', 'furnacePos', task);
  if (carried) return standAt(bot, carried, task);

  // Eight cobblestone against a sixty-block walk — see WORTH_WALKING_TO.
  if (tooFarToBother(bot, 'furnacePos', canAffordFurnace(bot))) {
    logger.info('The old furnace is too far to be worth the walk', {
      distance: Math.round(bot.entity.position.distanceTo(knownBase.furnacePos)),
      insteadOf: 'eight cobblestone',
    });
    forget('furnacePos');
  }

  const existing = await locate(bot, 'furnacePos', ['furnace'], task);
  let failedApproach = null;
  if (existing) {
    if (await approachOrDisown(bot, existing, 'furnacePos', 'furnace', task)) {
      if (withinReach(bot, existing)) return existing;
    } else {
      failedApproach = existing.position;
    }
  }

  // Not straight back to the furnace we just failed to reach — see ensureTable.
  if (!hasItem(bot, 'furnace') && knownBase.furnacePos
    && !sameSpot(knownBase.furnacePos, failedApproach)) {
    const dist = bot.entity.position.distanceTo(knownBase.furnacePos);
    if (dist <= RELOCATE_MAX_DISTANCE) {
      await retrieve(bot, 'furnacePos', ['furnace'], 'furnace', task);
    } else {
      forget('furnacePos');
    }
  }

  // Same duplicate guard as the crafting table: a furnace we can see from
  // here is reachable, whatever the blacklist thinks.
  const adjacent = findNearest(bot, ['furnace'], DUPLICATE_GUARD_RADIUS);
  if (adjacent) {
    const at = await standAt(bot, adjacent, task);
    if (at) {
      unreachable.delete(posKey(at.position));
      remember('furnacePos', at.position);
      return at;
    }
  }

  if (!hasItem(bot, 'furnace')) {
    // Any stone-material item works, not just literal cobblestone.
    if (countAny(bot, STONE_MATERIAL) < 8) return null; // gathering handles this
    const tableBlock = await getTable();
    if (!tableBlock || !(await standAt(bot, tableBlock, task))) return null;
    if (!(await craftItem(bot, 'furnace', 1, tableBlock, task))) return null;
  }

  const placed = await placeFromInventory(bot, 'furnace', task);
  if (!placed || placed.name !== 'furnace') return null;

  logger.action('Placed furnace', { pos: placed.position });
  remember('furnacePos', placed.position);
  return standAt(bot, placed, task);
}

/**
 * The right kind of smelter for the job.
 *
 * Vanilla has three, and the specialised two are twice as fast:
 *
 *   smoker        food only, 2x  — costs a furnace + 4 logs
 *   blast furnace ores only, 2x  — costs a furnace + 5 iron + 3 smooth stone
 *   furnace       everything, 1x
 *
 * The smoker is the one that matters here. Food is the bot's most constant
 * shortage, and cooking at half speed is why it kept falling back on raw
 * meat: the furnace simply could not keep up with what hunting brought in.
 * Four logs for double throughput is the best trade available to it.
 *
 * The blast furnace is listed for completeness but is a much longer chain
 * (smooth stone means smelting cobblestone twice), so it is only built if
 * the materials happen to be there.
 */
const SMELTER_FOR = {
  food: { preferred: 'smoker', key: 'smokerPos' },
  ore: { preferred: 'blast_furnace', key: 'blastPos' },
};

function canCraftSmoker(bot) {
  return hasItem(bot, 'furnace')
    && (countAny(bot, plankNames(bot)) >= 4
      || !!findItem(bot, (i) => i.name.endsWith('_log')));
}

function canCraftBlastFurnace(bot) {
  return hasItem(bot, 'furnace')
    && itemCount(bot, 'iron_ingot') >= 5
    && itemCount(bot, 'smooth_stone') >= 3;
}

/**
 * Get a smelter suited to `kind`, falling back to a plain furnace.
 *
 * Never blocks progress on building the fancy one: if the specialised
 * smelter isn't available and can't be made right now, the furnace is
 * returned instead and the bot gets on with it.
 */
async function ensureSmelter(bot, ctx, task, getTable, kind) {
  noteStationUse(ctx);
  const spec = SMELTER_FOR[kind];
  if (!spec) return ensureFurnace(bot, ctx, task, getTable);

  // One standing right here beats everything — including the one we remember,
  // which may be sixty blocks up a staircase.
  const adjacent = findNearest(bot, [spec.preferred], DUPLICATE_GUARD_RADIUS);
  if (adjacent) {
    const at = await standAt(bot, adjacent, task);
    if (at) {
      unreachable.delete(posKey(at.position));
      remember(spec.key, at.position);
      return at;
    }
  }

  // IF WE ARE CARRYING ONE, PUT IT DOWN — the same rule the table and the
  // furnace follow, and it was missing here entirely. `tidy` packs a smoker up
  // to take along precisely so the bot does not have to climb back to the old
  // one, and this function walked back to the old one anyway.
  const carried = await placeCarried(bot, spec.preferred, spec.key, task);
  if (carried) return standAt(bot, carried, task);

  // Same economics as the table and the furnace: a smoker is a furnace plus
  // four planks, which is never worth a sixty-block walk. See WORTH_WALKING_TO.
  if (tooFarToBother(bot, spec.key, canAffordFurnace(bot) && canAffordTable(bot))) {
    forget(spec.key);
  }

  const existing = await locate(bot, spec.key, [spec.preferred], task);
  if (existing && await approachOrDisown(bot, existing, spec.key, spec.preferred, task)) {
    if (withinReach(bot, existing)) return existing;
  }

  const affordable = kind === 'food' ? canCraftSmoker(bot) : canCraftBlastFurnace(bot);
  if (hasItem(bot, spec.preferred) || affordable) {
    if (!hasItem(bot, spec.preferred)) {
      // Only now is a table actually needed — see NO_TABLE.
      const tableBlock = await getTable();
      if (!tableBlock) return ensureFurnace(bot, ctx, task, getTable);
      if (kind === 'food') await ensurePlanks(bot, 4, task);
      if (!(await standAt(bot, tableBlock, task))) {
        return ensureFurnace(bot, ctx, task, getTable);
      }
      if (!(await craftItem(bot, spec.preferred, 1, tableBlock, task))) {
        return ensureFurnace(bot, ctx, task, getTable);
      }
    }
    const placed = await placeFromInventory(bot, spec.preferred, task);
    if (placed && placed.name === spec.preferred) {
      logger.action(`Placed ${spec.preferred}`, { pos: placed.position, twiceAsFastFor: kind });
      remember(spec.key, placed.position);
      return standAt(bot, placed, task);
    }
  }

  // Nothing fancy available — a plain furnace still does the job.
  return ensureFurnace(bot, ctx, task, getTable);
}

// ensureFurnace is internal now — callers go through ensureSmelter, which
// picks a smoker or blast furnace when one suits the job and falls back to
// a plain furnace otherwise.
module.exports = {
  ensureTable,
  ensureSmelter,
  ensurePlanks,
  ensureSticks,
  placeFromInventory,
  stayingPut, standAt,
  // Exported for test/packing.test.js. Whether `skip` wraps decides if one
  // refused placement costs a retry or costs the bot its crafting table.
  findPlacementSpot, carvePlacementSpot, PLACE_ATTEMPTS,
  // For test/thresholds.test.js: the search must never find a station further
  // away than the bot is willing to walk to one.
  NEARBY_RADIUS, WORTH_WALKING_TO,
};
