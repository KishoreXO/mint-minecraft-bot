/**
 * Block lookup helpers.
 *
 * Every search goes through scanBlocks, not bot.findBlocks. mineflayer's
 * version is correct but builds a full Block object for each of the 4096
 * positions in every section it walks (it calls bot.blockAt per position,
 * whatever form `matching` takes), and its palette prefilter misses two of the
 * three kinds of chunk section. See scanBlocks for the details and
 * test/blocks.test.js for the proof that the answers are identical.
 *
 * Searching is still synchronous, on the same thread as physics and combat, so
 * radii stay conservative and every search is timed through lag.timeScan.
 */

const { Vec3 } = require('vec3');
const { OctahedronIterator } = require('prismarine-world').iterators;
const { timeScan } = require('./lag');

const idCache = new WeakMap();
const stateCache = new WeakMap();

/** Numeric block ids for a list of block names, cached per bot/registry. */
function blockIds(bot, names) {
  let perBot = idCache.get(bot);
  if (!perBot) {
    perBot = new Map();
    idCache.set(bot, perBot);
  }

  const key = Array.isArray(names) ? names.join(',') : String(names);
  const cached = perBot.get(key);
  if (cached) return cached;

  const list = Array.isArray(names) ? names : [names];
  const ids = list
    .map((n) => bot.registry.blocksByName[n]?.id)
    .filter((id) => id !== undefined);

  perBot.set(key, ids);
  return ids;
}

/** Every block STATE id belonging to these block types, as a Set. */
function stateIdsFor(bot, names) {
  let perBot = stateCache.get(bot);
  if (!perBot) {
    perBot = new Map();
    stateCache.set(bot, perBot);
  }
  const key = Array.isArray(names) ? names.join(',') : String(names);
  const cached = perBot.get(key);
  if (cached) return cached;

  const states = new Set();
  for (const id of blockIds(bot, names)) {
    const block = bot.registry.blocks[id];
    if (!block) continue;
    const lo = block.minStateId ?? block.defaultState ?? id;
    const hi = block.maxStateId ?? lo;
    for (let s = lo; s <= hi; s++) states.add(s);
  }
  perBot.set(key, states);
  return states;
}

/**
 * Does this section possibly hold one of `states`? Reads the raw container.
 *
 * mineflayer's own prefilter asks `section.palette`, and that property only
 * exists on ONE of the three container kinds prismarine-chunk uses. A section
 * that is a single block throughout — every all-air section above the surface,
 * a slab of solid stone — has a SingleValueContainer, whose one value lives in
 * `.value`; a very mixed section has a DirectPaletteContainer with no palette
 * at all. For both, mineflayer's check sees `undefined` and answers "might be
 * in here", then walks all 4096 positions building a full Block object for
 * each. On plains most of a 48-block octahedron is sky, so the bulk of the
 * work in a tree search was proving, block by block, that air is not a log.
 */
function sectionMayContain(section, states) {
  const data = section?.data;
  if (!data) return false;
  if (Array.isArray(data.palette)) return data.palette.some((s) => states.has(s));
  if (data.value !== undefined && data.palette === undefined && !data.data) return states.has(data.value);
  return true; // direct palette: genuinely has to be scanned
}

/**
 * bot.findBlocks, same answer, without building a Block per position.
 *
 * Mirrors mineflayer's algorithm exactly — same octahedron of sections from
 * the same start, same "finish the layer once you have `count`" rule, same
 * distance cut, same nearest-first sort and truncation (node_modules/
 * mineflayer/lib/plugins/blocks.js:156). Two things differ, and they are the
 * whole point:
 *
 *  - the prefilter understands all three container kinds (sectionMayContain);
 *  - the inner loop compares raw state ids against a Set. mineflayer calls
 *    bot.blockAt for every position, which constructs a Block — name, hardness,
 *    properties, biome, light — to read one integer off it. A single r48 sweep
 *    was allocating on the order of a hundred thousand of them, and the
 *    garbage collector then billed for it later, in pauses the stall meter
 *    could only describe as "nothing over 60ms — likely a GC pause".
 *
 * If the world is not shaped the way this expects (a prismarine-chunk version
 * that has moved things), it hands the search to mineflayer rather than
 * guessing. Slow and right beats fast and blind.
 */
function scanBlocks(bot, names, maxDistance, count, accept = null) {
  // Anything missing that the scan reads directly means "not a world I know
  // how to read" — hand it to bot.findBlocks, which is also what lets a test's
  // stub bot keep answering the way it always has.
  if (!bot.registry?.blocks || typeof bot.world?.getColumn !== 'function' || !bot.game?.height) return null;
  const states = stateIdsFor(bot, names);
  if (states.size === 0) return [];

  const point = bot.entity.position.floored();
  const minY = bot.game.minY;
  const sectionsTall = bot.game.height >> 4;
  const minSection = Math.abs(minY >> 4);
  const start = new Vec3(Math.floor(point.x / 16), Math.floor(point.y / 16), Math.floor(point.z / 16));
  const it = new OctahedronIterator(start, Math.ceil((maxDistance + 8) / 16));
  const visited = new Set();
  const maxSq = maxDistance * maxDistance;

  const found = [];
  let startedLayer = 0;
  let next = start;
  while (next) {
    const column = bot.world.getColumn(next.x, next.z);
    const sectionY = next.y + minSection;
    const key = `${next.x},${next.y},${next.z}`;
    if (sectionY >= 0 && sectionY < sectionsTall && column && !visited.has(key)) {
      if (!column.sections) return null; // unfamiliar chunk layout — caller falls back
      const section = column.sections[sectionY];
      if (section && sectionMayContain(section, states)) {
        const data = section.data;
        if (typeof data.get !== 'function') return null;
        const bx = next.x * 16;
        const by = sectionY * 16 + minY;
        const bz = next.z * 16;
        // x, then y, then z — mineflayer's order, not the cache-friendly one.
        // Insertion order decides how equal-distance hits sort, and so which of
        // them survive the cut to `count`; a different order would be a
        // different answer, however rarely.
        for (let x = 0; x < 16; x++) {
          const dx = bx + x - point.x;
          for (let y = 0; y < 16; y++) {
            const dy = by + y - point.y;
            for (let z = 0; z < 16; z++) {
              const stateId = data.get((y << 8) | (z << 4) | x);
              if (!states.has(stateId)) continue;
              const dz = bz + z - point.z;
              if (dx * dx + dy * dy + dz * dz > maxSq) continue;
              const pos = new Vec3(bx + x, by + y, bz + z);
              // Filtered HERE, so `count` counts what the caller will accept.
              // The state id comes along because the scan already has it: a
              // filter that needs the block's name would otherwise build a
              // whole Block object per hit to learn it — see findOre.
              if (accept && !accept(pos, stateId)) continue;
              found.push(pos);
            }
          }
        }
      }
      visited.add(key);
    }
    // If we started a layer, finish it, or a closer block might be missed.
    if (startedLayer !== it.apothem && found.length >= count) break;
    startedLayer = it.apothem;
    next = it.next();
  }

  found.sort((a, b) => a.distanceTo(point) - b.distanceTo(point));
  return found.length > count ? found.slice(0, count) : found;
}

/**
 * scanBlocks, or mineflayer's own search if the world layout is unfamiliar.
 *
 * `accept` is applied DURING the search, so `count` means "this many the
 * caller wants". Filtering afterwards is how the bot walked past a diamond:
 * findOre asked for the sixteen nearest ore of any kind, and at deepslate depth
 * those were sixteen buried iron, copper and coal — the exposed diamond twenty
 * blocks away never made the list at all. Live on 09-24, eight minutes of it.
 */
const FALLBACK_OVERSAMPLE = 8;

function findPositions(bot, names, maxDistance, count, accept = null) {
  const fast = scanBlocks(bot, names, maxDistance, count, accept);
  if (fast) return fast;
  const ids = blockIds(bot, names);
  if (ids.length === 0) return [];
  if (!accept) return bot.findBlocks({ matching: ids, maxDistance, count });
  return bot.findBlocks({ matching: ids, maxDistance, count: count * FALLBACK_OVERSAMPLE })
    // No state id here: Array.filter would pass the index in its place.
    .filter((pos) => accept(pos))
    .slice(0, count);
}

/** Nearest block matching any of `names`, or null. */
function findNearest(bot, names, maxDistance) {
  if (blockIds(bot, names).length === 0) return null;
  // Timed, so a stalled event loop can say which search caused it rather than
  // only which behavior happened to be running — see lag.timeScan.
  const hit = timeScan(`findBlock r${maxDistance}`, () => findPositions(bot, names, maxDistance, 1));
  return hit.length ? bot.blockAt(hit[0]) : null;
}

/**
 * Search close first, and only widen when close comes up empty.
 *
 * This is the single largest source of event-loop stalls in the bot, and the
 * reason is in findBlocks itself (node_modules/mineflayer/lib/plugins/
 * blocks.js:172). It walks whole 16x16x16 sections, and for any section whose
 * palette contains the block it is looking for it runs the full 4096-position
 * inner loop. It only stops early once it has `count` hits AND has finished
 * the current layer — so a search that FINDS nothing scans every section in
 * range, every time.
 *
 * At maxDistance 48 that is an octahedron about four sections across: well
 * over a hundred sections, and in a forest most of them contain a log, so it
 * is on the order of a hundred thousand block lookups. Synchronously, on the
 * same thread as pathfinding, combat and packet handling. That is the "lag"
 * — not the network.
 *
 * The fix is just to ask the cheap question first. A tree within 16 blocks
 * costs one layer; the 48-block sweep only happens when there genuinely is
 * nothing nearby, which is exactly when the bot is about to go exploring
 * anyway. Volume scales with the cube of the radius, so 16 before 48 is
 * roughly a twenty-seventh of the work in the common case.
 */
/**
 * `accept` is what stops the tiering from becoming a new kind of blindness.
 *
 * Without it, a tier that returns hits ends the search — so if every log
 * within sixteen blocks is on the unreachable blacklist, or every ore is one
 * the current pickaxe would destroy rather than collect, the bot concludes
 * there is nothing to do and never looks at thirty-two. The old flat search
 * did not have that failure mode, and re-introducing it while making things
 * faster would be a poor trade.
 *
 * So a tier only counts as answered if something in it is actually USABLE.
 */
function findNearestTiered(bot, names, radii, count = 1, accept = null) {
  if (blockIds(bot, names).length === 0) return [];

  for (const maxDistance of radii) {
    const found = timeScan(
      `findBlocks r${maxDistance}`,
      () => findPositions(bot, names, maxDistance, count, accept),
    );
    // Everything returned has already been accepted.
    if (found.length > 0) return found;
  }
  return [];
}

module.exports = {
  blockIds, findNearest, findNearestTiered,
  // For test/blocks.test.js, which checks it against a brute-force search on
  // real prismarine-chunk columns — a faster search that answers differently
  // would be worse than the slow one.
  scanBlocks, sectionMayContain, findPositions,
};
