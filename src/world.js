/**
 * The F3 screen, as data.
 *
 * A player reads the debug overlay constantly without thinking about it —
 * what time it is, how long until dark, what biome this is, whether the
 * corner they are standing in is dark enough to spawn something behind them.
 * The bot had none of that. It inferred night from a hardcoded tick range,
 * decided "underground" meant y < 50, and placed torches on a timer rather
 * than where it was actually dark.
 *
 * Everything here comes from data the client already receives, so none of it
 * is cheating in the way x-ray is — it is the same information the F3 screen
 * shows a human, read directly instead of through pixels.
 */

// Minecraft's day is 24000 ticks: 0 dawn, 6000 noon, 12000 dusk, 18000
// midnight. Hostile mobs spawn on the surface from roughly 13000 to 23000.
const DAY_LENGTH = 24000;
const DUSK = 13000;
const DAWN = 23000;
const TICKS_PER_SECOND = 20;

/**
 * Hostile mobs spawn where the BLOCK light level is 0 (1.18 and later —
 * before that it was 7, and skylight participated). Block light is the one
 * that matters because it is what a torch changes.
 */
const SPAWNABLE_LIGHT = 0;

const { STRUCTURES, structureFrom } = require('./knowledge');
const logger = require('./logger');
const memory = require('./memory');
const lag = require('./lag');
const { findPositions } = require('./blocks');

function timeInfo(bot) {
  const t = bot.time?.timeOfDay;
  if (t === undefined) {
    return {
      known: false, isNight: false, timeOfDay: 0, ticksUntilDawn: 0, ticksUntilDusk: 0, day: 0,
    };
  }

  const isNight = t >= DUSK && t <= DAWN;
  const ticksUntilDawn = isNight ? DAWN - t : 0;
  const ticksUntilDusk = isNight ? 0 : (t < DUSK ? DUSK - t : DAY_LENGTH - t + DUSK);

  return {
    known: true,
    isNight,
    timeOfDay: t,
    ticksUntilDawn,
    ticksUntilDusk,
    secondsUntilDawn: Math.round(ticksUntilDawn / TICKS_PER_SECOND),
    secondsUntilDusk: Math.round(ticksUntilDusk / TICKS_PER_SECOND),
    day: bot.time?.day ?? 0,
  };
}

/**
 * Is the light data we are being served actually meaningful?
 *
 * prismarine-chunk returns 15 for any position whose lighting section is
 * missing (ChunkColumn.js:109), so the failure mode is everything looking
 * BRIGHT, never everything looking dark. That is the safe direction — acting
 * on it can only make the bot place too few torches, never carpet the world
 * in them — but it is still worth knowing when the data is uniform and
 * therefore useless.
 *
 * Sampled once and cached per bot: it is a property of the server, not of
 * where the bot is standing.
 */
const LIGHT_REPROBE_MS = 10000;

function lightingUsable(bot) {
  // A POSITIVE is permanent: once we have seen two different light values we
  // know the server sends per-block lighting, and that cannot stop being true.
  if (bot._lightingUsable === true) return true;

  // A negative is not proof, and caching it was a real bug. The probe reads
  // the bot's immediate surroundings, and there are places where uniform
  // darkness is simply CORRECT — sealed inside a stone shelter, every sampled
  // cell really is 0:0. Caught live: the probe happened to run while the bot
  // was walled into its own burrow, concluded the server sent no lighting,
  // and disabled torch placement for the entire session. So a negative only
  // holds until the bot has moved somewhere worth re-asking about.
  const now = Date.now();
  if (bot._lightProbeAt && now - bot._lightProbeAt < LIGHT_REPROBE_MS) return false;
  bot._lightProbeAt = now;

  const seen = new Set();
  const origin = bot.entity.position.floored();

  // Every Y near the bot, because that is where variation lives — the cell at
  // its feet, the one at its head and the one above it routinely differ, and
  // a coarser vertical step walked straight past all three. Horizontally a
  // wider, sparser net is enough to catch a lit doorway or an open sky column.
  for (let dy = -2; dy <= 3; dy++) {
    for (let dx = -4; dx <= 4; dx += 2) {
      for (let dz = -4; dz <= 4; dz += 2) {
        const block = bot.blockAt(origin.offset(dx, dy, dz));
        if (!block) continue;
        // BOTH channels, because block light alone gives a false negative in
        // the most common case there is. Outdoors at night with no torches
        // placed, block light is legitimately 0 at every single position —
        // so a block-light-only probe concluded "this server sends no
        // lighting" and silently disabled itself exactly when it was needed.
        // Caught live: `lighting: "unavailable"` on a world that was sending
        // perfectly good data. Sky light varies with terrain regardless.
        seen.add(`${block.light ?? 15}:${block.skyLight ?? 15}`);
      }
    }
  }

  // More than one distinct value anywhere in the sample means the server is
  // really sending per-block lighting.
  if (seen.size > 1) bot._lightingUsable = true;
  return seen.size > 1;
}

/** Block light at a position, or null when we have no usable data. */
function lightAt(bot, pos) {
  if (!lightingUsable(bot)) return null;
  const block = bot.blockAt(pos);
  if (!block) return null;
  return { block: block.light ?? 15, sky: block.skyLight ?? 15 };
}

/**
 * Could a hostile mob spawn on this exact spot?
 *
 * Block light alone is not the whole rule, and getting that wrong is
 * expensive in the other direction. A forest floor in broad daylight has a
 * block light of 0 almost everywhere — the canopy blocks the sun and nothing
 * else is lighting it — so a block-light-only test reported 49 spawnable
 * spots around a bot standing in the sun at midday, and would have had it
 * spend its whole torch supply lighting a wood that was not dangerous.
 *
 * Sunlight is what actually suppresses those spawns, so sky light has to
 * count too: a spot is only dangerous if nothing is lighting it AND the sun
 * is not reaching it — either because it is underground, or because it is
 * night.
 */
function isSpawnableSpot(bot, pos) {
  const at = bot.blockAt(pos);
  const head = bot.blockAt(pos.offset(0, 1, 0));
  const under = bot.blockAt(pos.offset(0, -1, 0));
  if (!at || !head || !under) return false;
  if (at.boundingBox !== 'empty' || head.boundingBox !== 'empty') return false;
  if (under.boundingBox !== 'block') return false;

  const light = lightAt(bot, pos);
  if (light === null) return false; // no data — caller falls back
  if (light.block > SPAWNABLE_LIGHT) return false;

  // Daylight reaching the spot keeps it safe until dusk.
  return light.sky === 0 || timeInfo(bot).isNight;
}

/**
 * The nearest spot near us that a mob could spawn on, i.e. where a torch is
 * worth placing. Searching outward from the bot means the first hit is the
 * most urgent one — the dark patch closest to where it is standing.
 */
function nearestDarkSpot(bot, radius = 6) {
  if (!lightingUsable(bot)) return null;
  const origin = bot.entity.position.floored();

  for (let r = 1; r <= radius; r++) {
    for (let dx = -r; dx <= r; dx++) {
      for (let dz = -r; dz <= r; dz++) {
        // Ring only — inner rings were covered by earlier iterations.
        if (Math.abs(dx) !== r && Math.abs(dz) !== r) continue;
        for (let dy = -1; dy <= 2; dy++) {
          const pos = origin.offset(dx, dy, dz);
          if (isSpawnableSpot(bot, pos)) return pos;
        }
      }
    }
  }
  return null;
}

/**
 * How many spawnable spots are around us, AND which is nearest — in one pass.
 *
 * These were two functions walking almost the same volume, and both are hot:
 * `light` wants the count to decide whether the corridor is dangerous and the
 * nearest one to decide where to put the torch, so every check ran both. Each
 * position costs four block reads, so the pair was roughly five thousand
 * lookups per call, synchronously, on the same thread as pathfinding.
 *
 * Returns null for both when the server sends no usable lighting, so callers
 * can tell "nothing is dark" from "we cannot tell".
 */
function scanDarkness(bot, radius = 5) {
  if (!lightingUsable(bot)) return { count: null, nearest: null };
  return lag.timeScan('scanDarkness', () => darknessSweep(bot, radius));
}

function darknessSweep(bot, radius) {
  const origin = bot.entity.position.floored();
  let count = 0;
  let nearest = null;
  let nearestDistance = Infinity;

  for (let dx = -radius; dx <= radius; dx++) {
    for (let dz = -radius; dz <= radius; dz++) {
      for (let dy = -1; dy <= 2; dy++) {
        const pos = origin.offset(dx, dy, dz);
        if (!isSpawnableSpot(bot, pos)) continue;
        count++;
        const distance = origin.distanceTo(pos);
        if (distance < nearestDistance) {
          nearestDistance = distance;
          nearest = pos;
        }
      }
    }
  }
  return { count, nearest };
}

/** How many spawnable spots are around us — a direct measure of how risky this spot is. */
function darkSpotCount(bot, radius = 5) {
  return scanDarkness(bot, radius).count;
}

/**
 * Are we actually underground, rather than merely at a low Y?
 *
 * "y < 50" is wrong in both directions: a mountain valley floor at y=90 is
 * open sky, and a deep ravine at y=40 is not. Sky light answers it directly —
 * if any light reaches this column from above, we are outside.
 */
/**
 * Is anything between us and the sky?
 *
 * Answered by LOOKING UP, not by reading sky light — because sky light
 * cannot be trusted. Caught live: the bot stood in plains at y=70 on a clear
 * night and reported `terrain: underground`, which made `shelter` decline to
 * run (it skips burrowing when already underground) while Jev was saying
 * "focus on shelter, risk danger". It fought instead of hiding.
 *
 * The cause is that this server reports skyLight as 0 everywhere. The
 * lighting probe still passes, because BLOCK light varies perfectly well and
 * that is enough to make the pair look varied — so the bad channel sailed
 * through the check meant to catch exactly this.
 *
 * Block data is never ambiguous in that way. A column of air above us means
 * open sky; a solid block in it means cover. That is the actual question.
 */
const SKY_PROBE_HEIGHT = 40;

/**
 * Cached for a fraction of a second, because of who asks and how often.
 *
 * The answer costs up to forty block lookups, and `shelter.shouldRun` is one
 * of the callers — which the director's supervisor evaluates every 60ms, so
 * this alone was six hundred lookups a second before anything else ran. The
 * bot cannot move far enough in 250ms to change the answer, and the dashboard,
 * resupply and the strategy briefing all ask it too.
 */
const UNDERGROUND_CACHE_MS = 250;

function isUnderground(bot) {
  const now = Date.now();
  const cached = bot._undergroundCache;
  if (cached && now - cached.at < UNDERGROUND_CACHE_MS) {
    // Only reuse it if we have not moved out of the column it was measured in.
    const p = bot.entity.position;
    if (Math.abs(p.x - cached.x) < 1 && Math.abs(p.y - cached.y) < 1
      && Math.abs(p.z - cached.z) < 1) {
      return cached.value;
    }
  }

  const value = probeForSky(bot);
  const p = bot.entity.position;
  bot._undergroundCache = {
    at: now, x: p.x, y: p.y, z: p.z, value,
  };
  return value;
}

/** Leaves, logs, stripped/bark variants, nether stems, huge mushrooms, nests. */
function isTreePart(name) {
  return /_(leaves|log|wood|stem|hyphae)$/.test(name)
    || /^(mushroom_stem|brown_mushroom_block|red_mushroom_block|bee_nest)$/.test(name);
}

function probeForSky(bot) {
  const head = bot.entity.position.floored().offset(0, 2, 0);
  let sawUnloaded = false;

  for (let dy = 0; dy < SKY_PROBE_HEIGHT; dy++) {
    const block = bot.blockAt(head.offset(0, dy, 0));
    if (!block) {
      sawUnloaded = true;
      break;
    }
    // A TREE is not a roof. Leaves count as cover for spawn purposes but are
    // not "underground" in any sense that matters here — the bot can still be
    // reached from every side, which is the whole question shelter is asking.
    //
    // The trunk is the same, and only leaves used to be excused. `wood` fells
    // a tree by cutting its lowest logs and standing in the gap, so the bot
    // spends its evenings directly beneath the logs it could not reach — and
    // that read as underground. Caught live on the first night after shelter
    // began saying why it declined: "Night, and not sheltering {reason:
    // something solid overhead counts as underground, y: 65}", mid-woodUrgent,
    // on open grass. It is the likeliest reason shelter sat out the 09-25 dusk
    // in a forest, which ended with the bot dead.
    if (block.boundingBox === 'block' && !isTreePart(block.name)) return true;
  }

  // Ran out of loaded chunks before finding anything: fall back to depth
  // rather than guessing, since a wrong "outside" is much safer than a wrong
  // "underground" (the latter silently disables sheltering).
  return sawUnloaded ? bot.entity.position.y < 50 : false;
}

function biomeName(bot, pos = null) {
  try {
    const block = bot.blockAt(pos || bot.entity.position.floored());
    const biome = block?.biome;
    if (biome === undefined || biome === null) return null;
    // prismarine-block hands back a biome OBJECT, which already carries the
    // name. Reading `.id` off it and then looking that id up in the registry
    // — which is what this did — throws away the answer it was holding and
    // returns null whenever the registry is keyed differently.
    if (typeof biome === 'object') {
      // prismarine-biome hands back a placeholder whose name is the EMPTY
      // STRING for any id it doesn't recognise, which is falsy but not
      // nullish — so `??` sails straight past it and reports '' as the biome.
      return biome.name || bot.registry.biomes?.[biome.id]?.name || null;
    }
    return bot.registry.biomes?.[biome]?.name ?? null;
  } catch {
    return null;
  }
}

/**
 * What structure, if any, we appear to be standing in or next to.
 *
 * The client is told nothing about structures, so this infers them from
 * their signature blocks — two distinct markers, so a stray rail is not a
 * whole mineshaft. Worth knowing because the difference between a village
 * and a pillager outpost is the difference between a free bed and a death.
 */
const STRUCTURE_SCAN_RADIUS = 24;
// A minute, not fifteen seconds. Villages do not appear, and the scan matches
// a long list of marker blocks so most sections in range pay the full inner
// loop — measured at 70-142ms per sweep by the stall instrumentation.
const STRUCTURE_RESCAN_MS = 60000;

const MARKERS = [...new Set(
  Object.values(STRUCTURES).flatMap((s) => s.detect),
)];

function structureNearby(bot) {
  const now = Date.now();
  if (bot._structureCheckedAt && now - bot._structureCheckedAt < STRUCTURE_RESCAN_MS) {
    return bot._structureSeen ?? null;
  }
  bot._structureCheckedAt = now;

  try {
    // Through blocks.js like every other search. This was the last one calling
    // bot.findBlocks directly, and a long marker list is its worst case: most
    // sections pass the palette prefilter and then pay a Block construction per
    // position. Measured live at up to 1307ms for one sweep, after the rest of
    // the bot's searches had already stopped showing up at all.
    const found = lag.timeScan(
      'structureScan',
      () => findPositions(bot, MARKERS, STRUCTURE_SCAN_RADIUS, 40),
    );
    const names = found.map((p) => bot.blockAt(p)?.name).filter(Boolean);
    const seen = structureFrom(names);

    // Write it down the first time. A village is worth walking back to for a
    // bed, and a pillager outpost is worth never walking into again — both
    // are facts about this world that should outlive the session.
    if (seen && !bot._structureLogged?.has(seen.name)) {
      bot._structureLogged = bot._structureLogged ?? new Set();
      bot._structureLogged.add(seen.name);
      memory.noteStructure(seen.name, bot.entity.position);
      logger.info(`Found a ${seen.name}`, {
        worth: seen.worth,
        ...(seen.gives ? { gives: seen.gives } : {}),
        ...(seen.why ? { why: seen.why } : {}),
        ...(seen.danger ? { CAREFUL: seen.danger } : {}),
      });
    }

    bot._structureSeen = seen;
  } catch {
    bot._structureSeen = null;
  }
  return bot._structureSeen;
}

/**
 * Days since the bot last slept.
 *
 * Phantoms start spawning at three, and they are fast, they come from above,
 * and they cannot be outrun — so this is a countdown worth watching rather
 * than a surprise worth surviving.
 */
function daysAwake(bot, lastSleptDay) {
  const today = bot.time?.day ?? 0;
  if (lastSleptDay === null || lastSleptDay === undefined) return today;
  return Math.max(0, today - lastSleptDay);
}

/** Everything the F3 screen would tell us, in one object — for logging. */
function snapshot(bot) {
  const time = timeInfo(bot);
  const pos = bot.entity.position;
  return {
    pos: `${Math.round(pos.x)},${Math.round(pos.y)},${Math.round(pos.z)}`,
    biome: biomeName(bot),
    day: time.day,
    timeOfDay: time.timeOfDay,
    ...(time.isNight
      ? { dawnInSec: time.secondsUntilDawn }
      : { duskInSec: time.secondsUntilDusk }),
    underground: isUnderground(bot),
    lighting: lightingUsable(bot) ? 'per-block' : 'unavailable (using depth/time)',
    darkSpotsNear: darkSpotCount(bot) ?? 'unknown',
    structure: structureNearby(bot)?.name ?? 'none',
    difficulty: bot.game?.difficulty,
    ping: bot.player?.ping,
  };
}

/**
 * Sea level — "the surface" for every height test in the bot. mine.js and
 * hunt.js each had their own (63 and 65) and they described the same line.
 */
const SURFACE_Y = 63;

module.exports = {
  SURFACE_Y,
  timeInfo,
  lightAt,
  lightingUsable,
  isSpawnableSpot,
  nearestDarkSpot,
  darkSpotCount,
  isUnderground,
  biomeName,
  structureNearby,
  daysAwake,
  snapshot,
  DUSK,
  DAWN,
};
