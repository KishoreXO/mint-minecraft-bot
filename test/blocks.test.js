/**
 * The fast block search must give mineflayer's answer, exactly.
 *
 * scanBlocks replaces bot.findBlocks for every tree, ore and stone search in
 * the bot, because mineflayer's version built a Block object per position and
 * could not prefilter single-value or direct-palette sections — the source of
 * most of the event-loop stalls. A faster search that answers DIFFERENTLY
 * would be a worse bug than the slow one, so this checks it against the real
 * thing: mineflayer's own blocks plugin, injected onto a stub bot, searching
 * the same real prismarine-chunk columns.
 *
 * The world deliberately contains all three section kinds — all-air sky
 * (single value), ordinary mixed terrain (indirect palette) and one section
 * with over 256 distinct states (direct palette) — because the prefilter
 * treats each differently.
 *
 * Run with: node test/blocks.test.js
 */

const assert = require('assert');
const { EventEmitter } = require('events');
const { Vec3 } = require('vec3');
const { scanBlocks, sectionMayContain } = require('../src/blocks');

const VERSION = '1.21.9';
const registry = require('prismarine-registry')(VERSION);
const Chunk = require('prismarine-chunk')(registry);
const World = require('prismarine-world')(registry);
const injectBlocks = require('mineflayer/lib/plugins/blocks');

let passed = 0;
function check(label, fn) {
  try {
    fn();
    passed++;
    console.log(`  ok  ${label}`);
  } catch (err) {
    console.error(`  FAIL ${label}: ${err.message}`);
    process.exitCode = 1;
  }
}

// Deterministic, so a failure reproduces — and so a second buildWorld() is
// the SAME world, which the filtered-search check relies on.
const SEED = 1234567;
let seed = SEED;
const rand = () => {
  seed = (seed * 1103515245 + 12345) & 0x7fffffff;
  return seed / 0x7fffffff;
};

const id = (name) => registry.blocksByName[name].defaultState;
const STONE = id('stone');
const TARGETS = ['oak_log', 'birch_log', 'coal_ore', 'iron_ore', 'deepslate_iron_ore'];

function buildWorld() {
  seed = SEED;
  const world = new World(null).sync;
  for (let cx = -3; cx <= 3; cx++) {
    for (let cz = -3; cz <= 3; cz++) {
      const column = new Chunk({ minY: -64, worldHeight: 384 });
      for (let x = 0; x < 16; x++) {
        for (let z = 0; z < 16; z++) {
          for (let y = -64; y < 60; y++) column.setBlockStateId(new Vec3(x, y, z), STONE);
        }
      }
      // Scatter targets through the stone and just above the surface.
      for (let i = 0; i < 40; i++) {
        const name = TARGETS[Math.floor(rand() * TARGETS.length)];
        const y = Math.floor(rand() * 90) - 20;
        column.setBlockStateId(
          new Vec3(Math.floor(rand() * 16), y, Math.floor(rand() * 16)),
          registry.blocksByName[name].minStateId + Math.floor(rand() * 3),
        );
      }
      world.setColumn(cx, cz, column);
    }
  }

  // One section with more distinct states than any palette holds, so it is
  // stored as a DIRECT container. Includes a log, which must still be found.
  const direct = world.getColumn(0, 0);
  let state = 1;
  for (let x = 0; x < 16; x++) {
    for (let z = 0; z < 16; z++) {
      for (let y = 0; y < 2; y++) direct.setBlockStateId(new Vec3(x, 32 + y, z), state++);
    }
  }
  direct.setBlockStateId(new Vec3(7, 40, 7), id('oak_log'));
  return world;
}

function stubBot(world, position) {
  const bot = new EventEmitter();
  bot.registry = registry;
  bot.version = VERSION;
  bot._client = new EventEmitter();
  bot.game = { minY: -64, height: 384 };
  injectBlocks(bot, { version: VERSION });
  bot.world = world;
  bot.entity = { position };
  return bot;
}

const world = buildWorld();
const key = (v) => `${v.x},${v.y},${v.z}`;

console.log('section prefilter');

check('the world really does contain all three container kinds', () => {
  const kinds = new Set();
  for (let cx = -3; cx <= 3; cx++) {
    for (let cz = -3; cz <= 3; cz++) {
      for (const s of world.getColumn(cx, cz).sections) {
        const d = s?.data;
        if (!d) continue;
        if (Array.isArray(d.palette)) kinds.add('indirect');
        else if (d.data) kinds.add('direct');
        else kinds.add('single');
      }
    }
  }
  assert.deepStrictEqual([...kinds].sort(), ['direct', 'indirect', 'single']);
});

check('an all-air section is ruled out without being walked', () => {
  const sky = world.getColumn(2, 2).sections[15]; // y=176..191
  assert.ok(!Array.isArray(sky.data.palette), 'expected a single-value section');
  assert.strictEqual(sectionMayContain(sky, new Set([registry.blocksByName.oak_log.minStateId])), false);
});

console.log('\nsame answer as mineflayer');

const cases = [];
for (const at of [new Vec3(0.5, 61, 0.5), new Vec3(-20.3, 30, 17.8), new Vec3(40.5, -10, -35.5), new Vec3(7, 41, 7)]) {
  for (const names of [['oak_log', 'birch_log'], ['coal_ore', 'iron_ore', 'deepslate_iron_ore'], ['diamond_ore']]) {
    for (const radius of [8, 16, 32, 48]) {
      for (const count of [1, 8, 16, 48]) cases.push({ at, names, radius, count });
    }
  }
}

check(`identical results across ${cases.length} searches`, () => {
  let nonEmpty = 0;
  let cutShort = 0;
  for (const { at, names, radius, count } of cases) {
    const bot = stubBot(world, at);
    const ids = names.map((n) => registry.blocksByName[n].id);
    const theirs = bot.findBlocks({ matching: ids, maxDistance: radius, count }).map(key);
    const ours = scanBlocks(bot, names, radius, count).map(key);
    assert.deepStrictEqual(
      ours,
      theirs,
      `differs for ${names.join('/')} r${radius} count ${count} from ${key(at.floored())}`,
    );
    if (theirs.length) nonEmpty++;
    if (theirs.length === count) cutShort++;
  }
  // Agreeing on a pile of empty lists would prove nothing. Most searches must
  // find something, and plenty must hit `count` — the early-exit and
  // truncation path, which is where two implementations could quietly differ.
  assert.ok(nonEmpty > cases.length / 2, `only ${nonEmpty} searches found anything`);
  assert.ok(cutShort > 20, `only ${cutShort} searches exercised the count cut-off`);
});

// The filter has to be applied DURING the scan, so `count` counts what the
// caller will take. Filtering afterwards is how the bot walked past a diamond:
// the sixteen nearest ore were all buried, and the exposed one never made it in.
check('a filtered search answers as if the rejected blocks were not there', () => {
  // Not "the exact nearest": neither this scan nor mineflayer's is exact — both
  // stop once a section layer holding `count` hits is finished. The promise is
  // that filtering is the same as the rejected blocks not existing.
  const accept = (pos) => (pos.x + pos.z) % 3 === 0; // any deterministic, selective rule
  const pruned = buildWorld(); // same seed, same world...
  const probe = stubBot(pruned, new Vec3(0.5, 20, 0.5));
  for (const pos of scanBlocks(probe, TARGETS, 200, 1e6)) {
    if (!accept(pos)) pruned.setBlockStateId(pos, STONE); // ...minus what the filter rejects
  }
  let rejectedNearer = 0;
  for (const { at, names, radius, count } of cases) {
    const ours = scanBlocks(stubBot(world, at), names, radius, count, accept).map(key);
    const expected = scanBlocks(stubBot(pruned, at), names, radius, count).map(key);
    assert.deepStrictEqual(ours, expected, `differs for ${names.join('/')} r${radius} count ${count}`);
    const unfiltered = scanBlocks(stubBot(world, at), names, radius, count);
    if (unfiltered.some((p) => !accept(p))) rejectedNearer++;
  }
  // And it must have mattered: plenty of searches had rejected blocks in the
  // way, which an after-the-fact filter would have returned instead.
  assert.ok(rejectedNearer > 20, `only ${rejectedNearer} searches had rejected blocks in the way`);
});

check('and it is actually faster', () => {
  const bot = stubBot(world, new Vec3(0.5, 61, 0.5));
  const ids = ['oak_log', 'birch_log'].map((n) => registry.blocksByName[n].id);
  const time = (fn) => {
    const t = process.hrtime.bigint();
    for (let i = 0; i < 3; i++) fn();
    return Number(process.hrtime.bigint() - t) / 3e6;
  };
  const theirs = time(() => bot.findBlocks({ matching: ids, maxDistance: 48, count: 64 }));
  const ours = time(() => scanBlocks(bot, ['oak_log', 'birch_log'], 48, 64));
  console.log(`      r48 sweep: mineflayer ${theirs.toFixed(0)}ms, ours ${ours.toFixed(0)}ms`);
  assert.ok(ours < theirs, 'the replacement is slower than what it replaces');
});

// findOre's filter runs on every ore the scan passes, and it asked bot.blockAt
// for all of it — the name, then six neighbours — each call a whole Block
// object. Near the surface that is thousands of hits: "findBlocks r32 912ms
// worst" at 15:47:27 on 09-24. The scan already holds each ore's state id.
check('the ore search does not build a Block for every buried ore it passes', () => {
  const { findOre } = require('../src/behaviors/mine');
  const oreWorld = new World(null).sync;
  seed = SEED;
  const buried = ['deepslate_iron_ore', 'coal_ore', 'iron_ore'];
  let placed = 0;
  for (let cx = -2; cx <= 1; cx++) {
    for (let cz = -2; cz <= 1; cz++) {
      const column = new Chunk({ minY: -64, worldHeight: 384 });
      for (let x = 0; x < 16; x++) {
        for (let z = 0; z < 16; z++) {
          for (let y = 30; y < 60; y++) column.setBlockStateId(new Vec3(x, y, z), STONE);
        }
      }
      for (let i = 0; i < 150; i++) {
        const name = buried[Math.floor(rand() * buried.length)];
        column.setBlockStateId(
          new Vec3(1 + Math.floor(rand() * 14), 32 + Math.floor(rand() * 25), 1 + Math.floor(rand() * 14)),
          registry.blocksByName[name].defaultState,
        );
        placed++;
      }
      oreWorld.setColumn(cx, cz, column);
    }
  }
  // One diamond on the surface, open air above it: the one worth having.
  oreWorld.setBlockStateId(new Vec3(9, 59, 3), registry.blocksByName.diamond_ore.defaultState);

  const bot = stubBot(oreWorld, new Vec3(0.5, 60, 0.5));
  bot.inventory = { items: () => [{ name: 'iron_pickaxe', type: 1, count: 1 }] };
  let reads = 0;
  const blockAt = bot.blockAt;
  bot.blockAt = (...args) => {
    reads++;
    return blockAt(...args);
  };
  const found = findOre(bot, { mine: { skipped: new Map(), lastScanAt: 0 } });
  assert.strictEqual(found?.block?.name, 'diamond_ore', 'and it still has to find the diamond');
  assert.ok(placed > 2000, `the world has ${placed} buried ore`);
  assert.ok(reads < 50, `${reads} Block objects built for one scan`);
});

console.log(`\n${passed} checks passed`);
