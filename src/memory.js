const fs = require('fs');
const path = require('path');
const { Vec3 } = require('vec3');
const logger = require('./logger');

/**
 * What the bot remembers about a world between sessions.
 *
 * `known-base.json` already survives restarts, but it only holds where the
 * crafting table is. Everything else the bot learns — how deep it got, where
 * it saw an iron vein it could not yet mine, where it died, whether it has
 * slept — evaporated the moment the process stopped. So every restart began
 * from nothing even in a world the bot had spent an hour in, and the same
 * discoveries had to be made again.
 *
 * Keyed by world signature (host + spawn point), the same way base.js is, so
 * a different world gets a clean slate and a reopened LAN world — which
 * changes port every time — does not.
 *
 * Deliberately small and bounded. This is a notebook, not a world model:
 * everything in it is either a coordinate worth returning to or a number
 * worth resuming from, and the lists are capped so a long session cannot
 * grow the file without limit.
 */

const FILE = path.join(__dirname, '..', 'world-memory.json');
const MAX_ORE_NOTES = 40;
const MAX_DEATHS = 10;
const MAX_WATER_TRAPS = 10;
// How far around a remembered trap counts as "in it": a ravine is long and
// narrow, and the water the bot fell into is rarely the exact cell it left.
const WATER_TRAP_RADIUS = 8;
// Ground searched for food and found empty. Animals are generated with the
// chunks and barely come back, so a hunted-out area stays hunted out: live on
// 09-26 the bot starved three times in one evening walking in circles inside
// the same 200 blocks. Kept long enough to steer a whole session, not forever.
const MAX_EMPTY_FOOD_SPOTS = 30;
const EMPTY_FOOD_RADIUS = 48;
const EMPTY_FOOD_MEMORY_MS = 2 * 60 * 60 * 1000;
const SAVE_DEBOUNCE_MS = 4000;

function blank(world = null) {
  return {
    world,
    firstSeen: Date.now(),
    lastSeen: Date.now(),
    sessions: 0,
    // Deepest we have been, so a new session knows the run is already
    // underground rather than starting from "I am on the surface".
    deepestY: null,
    // Day number we last slept, for phantom insomnia.
    lastSleptDay: null,
    // Ore we SAW but could not harvest with the pickaxe we had. Worth
    // returning to the moment the tier improves — it is already located, and
    // finding ore is the expensive half of mining.
    oreNotes: [],
    // Where we have died, so those places can be treated with suspicion.
    deaths: [],
    // Structures we identified, with what they are good for.
    structures: [],
    // Water the bot could only get out of by building or digging its way up
    // — a flooded ravine, a sheer-sided pool. See noteWaterTrap.
    waterTraps: [],
    // Places a food search reached and found nothing to eat. See noteNoFood.
    emptyFoodSpots: [],
  };
}

let state = blank();
let saveTimer = null;
// Tests run the real behaviors, and those write notes (a water trap, an ore).
// The file is the LIVE bot's notebook, shared with a bot that may be running
// right now, so a test switches writing off rather than hoping it exits first.
// Off by default for anything run from test/, so no test can forget.
let persist = !/[\\/]test[\\/][^\\/]+$/.test(require.main?.filename ?? '');

function load() {
  try {
    const raw = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    const merged = { ...blank(raw.world), ...raw };
    // Re-assert the array fields. A truncated or hand-edited file can carry
    // a null where a list belongs, and every reader here calls .length or
    // .filter on them — so one bad file would crash the bot on startup
    // rather than simply starting it without its notes.
    for (const key of ['oreNotes', 'deaths', 'structures', 'waterTraps', 'emptyFoodSpots']) {
      if (!Array.isArray(merged[key])) merged[key] = [];
    }
    return merged;
  } catch {
    return blank();
  }
}

state = load();

function save() {
  if (!persist) return;
  // Debounced: this is written from hot paths (every ore sighting, every
  // descent) and a synchronous write per event would stutter the bot.
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    fs.writeFile(FILE, JSON.stringify(state, null, 2), (err) => {
      if (err) logger.warn('Could not save world memory', { error: err.message });
    });
  }, SAVE_DEBOUNCE_MS);
  if (saveTimer.unref) saveTimer.unref();
}

/**
 * Write immediately, for shutdown.
 *
 * `save()` debounces by four seconds and the timer is unref'd, so a process
 * that exits inside that window never performs the write at all — every
 * Ctrl+C silently discarded up to four seconds of notes, which for a feature
 * whose entire purpose is remembering things across restarts is the one
 * failure that matters. Synchronous on purpose: there is no event loop left
 * to finish an async write.
 */
function flush() {
  if (!persist) return;
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  try {
    fs.writeFileSync(FILE, JSON.stringify(state, null, 2));
  } catch (err) {
    logger.warn('Could not flush world memory on exit', { error: err.message });
  }
}

/**
 * Attach to a world, wiping the notebook if it is a different one.
 *
 * Returns what we already knew, so the caller can say so in the log — the
 * difference between "starting fresh" and "resuming at y=-12 with three iron
 * veins noted" is worth seeing.
 */
function adopt(signature) {
  if (!signature) return null;

  if (state.world !== signature) {
    state = blank(signature);
    state.sessions = 1;
    save();
    return null; // nothing known about this world
  }

  state.sessions += 1;
  state.lastSeen = Date.now();
  save();
  return summary();
}

function summary() {
  return {
    sessions: state.sessions,
    deepestY: state.deepestY,
    oreNotes: state.oreNotes.length,
    deaths: state.deaths.length,
    structures: state.structures.map((s) => s.name),
    lastSleptDay: state.lastSleptDay,
  };
}

/** Where things happened, for the dashboard's radar. Copies — never the state. */
function markers() {
  return {
    deaths: state.deaths.map(({ x, y, z, cause }) => ({ x, y, z, cause })),
    ores: state.oreNotes.map(({ x, y, z, ore }) => ({ x, y, z, ore })),
    waterTraps: state.waterTraps.map(({ x, y, z }) => ({ x, y, z })),
  };
}

/** Remember an ore we could not mine yet, so we can come back for it. */
function noteOre(pos, oreName, neededTier) {
  const key = `${pos.x},${pos.y},${pos.z}`;
  if (state.oreNotes.some((n) => n.key === key)) return;

  state.oreNotes.unshift({
    key, x: pos.x, y: pos.y, z: pos.z, ore: oreName, needs: neededTier, at: Date.now(),
  });
  state.oreNotes.length = Math.min(state.oreNotes.length, MAX_ORE_NOTES);
  save();
}

/** Ore we noted earlier that the pickaxe we now hold could actually mine. */
function harvestableNotes(canHarvestNow) {
  return state.oreNotes
    .filter((n) => canHarvestNow(n.ore))
    .map((n) => ({ ...n, pos: new Vec3(n.x, n.y, n.z) }));
}

function forgetOre(pos) {
  const key = `${pos.x},${pos.y},${pos.z}`;
  const before = state.oreNotes.length;
  state.oreNotes = state.oreNotes.filter((n) => n.key !== key);
  if (state.oreNotes.length !== before) save();
}

function noteDeath(pos, cause) {
  if (!pos) return;
  state.deaths.unshift({
    x: Math.round(pos.x), y: Math.round(pos.y), z: Math.round(pos.z), cause, at: Date.now(),
  });
  state.deaths.length = Math.min(state.deaths.length, MAX_DEATHS);
  save();
}

/**
 * Remember water that had no way out but a built one.
 *
 * 09-26: the bot pillared fourteen blocks out of a flooded ravine and was back
 * in it within minutes — 33 re-entries across that session at three spots —
 * because nothing it chased on the rim knew the water below was a trap.
 * `y` is the water's surface level.
 */
function noteWaterTrap(pos, how) {
  if (!pos) return;
  const near = state.waterTraps.find((t) => Math.hypot(t.x - pos.x, t.z - pos.z) <= WATER_TRAP_RADIUS / 2 && Math.abs(t.y - pos.y) <= 2);
  if (near) {
    near.at = Date.now();
    near.times = (near.times ?? 1) + 1;
  } else {
    state.waterTraps.unshift({
      x: Math.round(pos.x), y: Math.round(pos.y), z: Math.round(pos.z), how, times: 1, at: Date.now(),
    });
    state.waterTraps.length = Math.min(state.waterTraps.length, MAX_WATER_TRAPS);
  }
  save();
}

/**
 * Is this position down in a remembered trap — within the radius across, and
 * no more than three above its water (the rim, far above, is not in it)?
 */
function inWaterTrap(pos) {
  if (!pos) return false;
  return state.waterTraps.some((t) => Math.hypot(t.x - pos.x, t.z - pos.z) <= WATER_TRAP_RADIUS
    && pos.y >= t.y - 2 && pos.y <= t.y + 3);
}

function waterTraps() {
  return state.waterTraps.map((t) => ({ ...t }));
}

/**
 * A food search got here and there was nothing to eat in sight.
 *
 * Spots closer than half the radius merge, so walking the same empty field
 * twice is one entry, not two.
 */
function noteNoFood(pos) {
  if (!pos) return;
  const now = Date.now();
  state.emptyFoodSpots = state.emptyFoodSpots.filter((s) => now - s.at < EMPTY_FOOD_MEMORY_MS);
  const near = state.emptyFoodSpots.find((s) => Math.hypot(s.x - pos.x, s.z - pos.z) <= EMPTY_FOOD_RADIUS / 2);
  if (near) {
    near.at = now;
  } else {
    state.emptyFoodSpots.unshift({ x: Math.round(pos.x), z: Math.round(pos.z), at: now });
    state.emptyFoodSpots.length = Math.min(state.emptyFoodSpots.length, MAX_EMPTY_FOOD_SPOTS);
  }
  save();
}

/** Where a food search has already come up empty, recent first. Copies. */
function emptyFoodSpots() {
  const now = Date.now();
  return state.emptyFoodSpots
    .filter((s) => now - s.at < EMPTY_FOOD_MEMORY_MS)
    .map(({ x, z }) => ({ x, z }));
}

function noteDepth(y) {
  if (state.deepestY === null || y < state.deepestY) {
    state.deepestY = Math.round(y);
    save();
  }
}

function noteSlept(day) {
  state.lastSleptDay = day;
  save();
}

function noteStructure(name, pos) {
  if (state.structures.some((s) => s.name === name)) return;
  state.structures.push({
    name, x: Math.round(pos.x), y: Math.round(pos.y), z: Math.round(pos.z),
  });
  save();
}

function lastSleptDay() {
  return state.lastSleptDay;
}

/** For tests: keep notes in memory only, never on disk. */
function setPersistence(on) {
  persist = !!on;
  if (!persist && saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
}

module.exports = {
  setPersistence,
  adopt,
  flush,
  summary,
  markers,
  noteOre,
  harvestableNotes,
  forgetOre,
  noteDeath,
  noteWaterTrap,
  inWaterTrap,
  waterTraps,
  noteNoFood,
  emptyFoodSpots,
  EMPTY_FOOD_RADIUS,
  WATER_TRAP_RADIUS,
  noteDepth,
  noteSlept,
  noteStructure,
  lastSleptDay,
};
