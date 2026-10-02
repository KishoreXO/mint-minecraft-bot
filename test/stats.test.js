/**
 * Run history: worlds, lives, milestones, and the averages the dashboard
 * shows. Fed synthetic log entries in the exact order the bot writes them.
 *
 * Run with: node test/stats.test.js
 */

const assert = require('assert');
const {
  Recorder, summarize, splits, blankStore, MILESTONES,
} = require('../src/stats');

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

const T0 = Date.parse('2026-09-26T10:00:00.000Z');
const at = (sec) => new Date(T0 + sec * 1000).toISOString();
const e = (sec, message, data) => ({ ts: at(sec), level: 'info', message, data });

/** One connection, the way index.js logs it. */
function connect(sec, world, { newWorld = false, phase = 'Wood' } = {}) {
  return [
    e(sec, 'Bot spawned', {}),
    ...(newWorld ? [e(sec, 'New world — forgetting the old base', { world })] : []),
    e(sec, 'Playing in world', { world }),
    e(sec, 'Session started', {}),
    e(sec + 1, 'Progression', { phase }),
  ];
}

function replay(entries) {
  const store = blankStore();
  const r = new Recorder(store);
  for (const entry of entries) r.ingest(entry);
  return { store, r };
}

console.log('lives and milestones');

check('a fresh start records each milestone at its time from the start of the life', () => {
  const { store } = replay([
    ...connect(0, 'w1', { newWorld: true }),
    e(60, 'Crafted', { item: 'wooden_pickaxe', count: 1 }),
    e(150, 'Crafted', { item: 'stone_pickaxe', count: 1 }),
    e(160, 'Phase complete', { phase: 'Stone tools', next: 'Food', tookSec: 100 }),
    e(400, 'Mined ore', { block: 'iron_ore' }),
  ]);
  const life = store.worlds.w1.lives[0];
  assert.strictEqual(life.fresh, true);
  assert.deepStrictEqual(life.milestones, {
    wooden_pickaxe: 60000, stone_pickaxe: 150000, stone_kit: 160000, first_iron: 400000,
  });
});

check('a death ends the life and starts a fresh one; the killer and the phase are kept', () => {
  const { store } = replay([
    ...connect(0, 'w1'),
    e(50, 'Phase complete', { phase: 'Wood', next: 'Stone tools', tookSec: 49 }),
    e(90, 'Bot died', { killedBy: 'melee' }),
    e(95, 'Crafted', { item: 'wooden_pickaxe' }),
  ]);
  const [first, second] = store.worlds.w1.lives;
  assert.strictEqual(first.end, 'death');
  assert.strictEqual(first.killedBy, 'melee');
  assert.strictEqual(first.diedInPhase, 'Stone tools');
  assert.strictEqual(second.fresh, true);
  assert.strictEqual(second.milestones.wooden_pickaxe, 5000);
});

check('a respawn that gets its kit back off the floor did not start over', () => {
  const { store } = replay([
    ...connect(0, 'w1'),
    e(90, 'Bot died', { killedBy: 'melee' }),
    e(120, 'Cleared the death site', { itemsRecovered: 14, stillOnGround: 0 }),
  ]);
  assert.strictEqual(store.worlds.w1.lives[1].fresh, false);
});

check('a restart mid-run is a continuation, not a fresh start', () => {
  const { store } = replay([
    ...connect(0, 'w1', { phase: 'Iron' }),
    e(30, 'Crafted', { item: 'iron_pickaxe' }),
  ]);
  const life = store.worlds.w1.lives[0];
  assert.strictEqual(life.fresh, false);
  assert.strictEqual(life.milestones.iron_pickaxe, 30000, 'still recorded, just not averaged');
});

check('a new connection closes the last life as a quit', () => {
  const { store } = replay([
    ...connect(0, 'w1'),
    e(100, 'Crafted', { item: 'wooden_pickaxe' }),
    ...connect(500, 'w1'),
  ]);
  const [first] = store.worlds.w1.lives;
  assert.strictEqual(first.end, 'quit');
  assert.strictEqual(first.endedAt, T0 + 500000);
});

check('lines with no connection behind them count for nothing', () => {
  const r = new Recorder(blankStore());
  r.ingest(e(0, 'Crafted', { item: 'stone_pickaxe' }));
  assert.deepStrictEqual(r.store.worlds, {});
});

console.log('\nacross worlds and tries');

function twoWorlds() {
  return replay([
    ...connect(0, 'w1', { newWorld: true }),
    e(100, 'Crafted', { item: 'wooden_pickaxe' }),
    e(300, 'Crafted', { item: 'stone_pickaxe' }),
    e(310, 'Bot died', { killedBy: 'ranged' }),
    e(400, 'Crafted', { item: 'wooden_pickaxe' }),
    e(510, 'Bot died', { killedBy: 'melee' }),
    ...connect(1000, 'w2', { newWorld: true }),
    e(1060, 'Crafted', { item: 'wooden_pickaxe' }),
    e(1120, 'Crafted', { item: 'stone_pickaxe' }),
  ]);
}

check('averages, medians, bests and reach rates over fresh lives in every world', () => {
  const { store } = twoWorlds();
  const s = summarize(store, T0 + 2000 * 1000);
  const wooden = s.overall.find((m) => m.id === 'wooden_pickaxe');
  // w1 life 1: 100 s; w1 life 2: 90 s after its death at 310; w2: 60 s.
  assert.strictEqual(wooden.reached, 3);
  assert.strictEqual(wooden.best, 60000);
  assert.strictEqual(wooden.median, 90000);
  const stone = s.overall.find((m) => m.id === 'stone_pickaxe');
  assert.strictEqual(stone.reached, 2);
  assert.ok(stone.rate > 0 && stone.rate < 1);
  assert.strictEqual(s.totals.worlds, 2);
  assert.strictEqual(s.totals.deaths, 2);
  assert.deepStrictEqual(s.deathsByCause.map((d) => d.key).sort(), ['melee', 'ranged']);
});

check('each world is ranked by how far it got', () => {
  const { store } = twoWorlds();
  const s = summarize(store, T0 + 2000 * 1000);
  assert.strictEqual(s.worlds[0].furthest, 'Stone pickaxe');
  assert.strictEqual(s.worlds.length, 2);
  assert.strictEqual(s.worlds.find((w) => w.id === 'w1').deaths, 2);
});

check('the trend has one point per fresh life, oldest first', () => {
  const { store } = twoWorlds();
  const { trend } = summarize(store, T0 + 2000 * 1000);
  assert.ok(trend.length >= 3);
  for (let i = 1; i < trend.length; i++) assert.ok(trend[i].at >= trend[i - 1].at);
});

check('splits compare the running life against this world and all worlds', () => {
  const { store } = twoWorlds();
  const sp = splits(store, 'w2', T0 + 1200 * 1000);
  assert.strictEqual(sp.rows.length, MILESTONES.length);
  const stone = sp.rows.find((row) => row.id === 'stone_pickaxe');
  assert.strictEqual(stone.at, 120000, 'this life');
  assert.strictEqual(stone.overallMean, 300000, 'the one other fresh life that got there');
});

console.log(`\n${passed} checks passed`);
