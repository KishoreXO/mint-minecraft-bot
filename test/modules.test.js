/**
 * Loads every module and asserts its exports exist.
 *
 * This is deliberately dumb, and it exists because a real bug shipped that
 * this would have caught in a second: a behavior was deleted from
 * survive.js but left in its module.exports, so the file threw on require
 * and the entire bot failed to start. Syntax checking passes that happily —
 * `module.exports = { eat }` is valid JavaScript right up until it runs.
 *
 * index.js is excluded on purpose: requiring it opens a connection.
 *
 * Run with: node test/modules.test.js
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

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

const srcDir = path.join(__dirname, '..', 'src');

function jsFilesIn(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return jsFilesIn(full);
    return entry.name.endsWith('.js') ? [full] : [];
  });
}

console.log('module loading');

const files = jsFilesIn(srcDir);
assert.ok(files.length > 0, 'found no source files to check');

for (const file of files) {
  const rel = path.relative(path.join(__dirname, '..'), file).replace(/\\/g, '/');
  check(`${rel} loads and exports something`, () => {
    const mod = require(file);
    assert.ok(mod && typeof mod === 'object', 'no exports');
    assert.ok(Object.keys(mod).length > 0, 'exports object is empty');
    for (const [name, value] of Object.entries(mod)) {
      assert.notStrictEqual(value, undefined, `exports.${name} is undefined`);
    }
  });
}

// Behaviors are what the director actually schedules, so check the shape it
// depends on rather than just that the file loaded.
const BEHAVIOR_MODULES = [
  'behaviors/survive', 'behaviors/shelter', 'behaviors/bed', 'behaviors/threat',
  'behaviors/loot', 'behaviors/collect',
  'behaviors/tidy', 'behaviors/unstick', 'behaviors/gear', 'behaviors/smelt',
  'behaviors/hunt', 'behaviors/mine', 'behaviors/wood', 'behaviors/explore',
];

console.log('\nbehavior shape');
for (const rel of BEHAVIOR_MODULES) {
  const mod = require(path.join(srcDir, rel));
  for (const [name, value] of Object.entries(mod)) {
    // Skip plain data exports (name sets, block lists).
    if (!value || typeof value !== 'object' || !('priority' in value)) continue;
    check(`${rel}: ${name} is a valid behavior`, () => {
      assert.strictEqual(typeof value.name, 'string', 'missing name');
      assert.strictEqual(typeof value.priority, 'number', 'missing priority');
      assert.strictEqual(typeof value.shouldRun, 'function', 'missing shouldRun');
      assert.strictEqual(typeof value.run, 'function', 'missing run');
      if (value.canInterrupt !== undefined) {
        assert.strictEqual(typeof value.canInterrupt, 'function', 'canInterrupt must be a function');
      }
    });
  }
}

/**
 * Call every behavior's shouldRun() against a minimal mock bot.
 *
 * Syntax checks and module loading both pass a file that references an
 * identifier it never imported — the ReferenceError only happens when the
 * line actually runs. That shipped: mine.js called hasItem() without
 * importing it, inside a code path reached on nearly every scheduler tick.
 *
 * We don't care what shouldRun returns here, only that it doesn't explode.
 */
function mockBot() {
  const pos = {
    x: 0,
    y: 70,
    z: 0,
    offset: () => mockBot().entity.position,
    floored() { return this; },
    clone() { return this; },
    distanceTo: () => 10,
    minus() { return this; },
    plus() { return this; },
    norm: () => 10,
    scaled() { return this; },
    normalize() { return this; },
  };
  return {
    health: 20,
    food: 20,
    time: { isDay: true },
    entity: { position: pos, velocity: { x: 0, y: 0, z: 0 }, isInWater: false },
    entities: {},
    heldItem: null,
    username: 'TestBot',
    registry: { itemsByName: {}, blocksByName: {}, items: {} },
    inventory: { items: () => [], slots: [], emptySlotCount: () => 36 },
    getEquipmentDestSlot: () => 5,
    blockAt: () => null,
    findBlock: () => null,
    findBlocks: () => [],
    recipesFor: () => [],
    canDigBlock: () => false,
  };
}

function mockCtx() {
  return {
    paused: false,
    manualTask: null,
    currentBehavior: null,
    backoff: new Map(),
    commitment: null,
    threat: {
      decisions: new Map(),
      fleeAttempts: new Map(),
      unreachable: new Map(),
      lastAttackerId: null,
      lastAttackAt: 0,
      lastAttackedAt: 0,
      lastSwitchAt: 0,
    },
    death: {
      pendingPos: null, diedAt: 0, stalledLegs: 0, respawnedAt: 0,
    },
    water: { since: null, from: null },
    mine: {
      candidate: null, lastScanAt: 0, skipped: new Map(), verdicts: new Map(), descentBlockedUntil: 0,
    },
    wood: { candidate: null, lastScanAt: 0, skipped: new Map() },
    explore: { heading: null, headingSetAt: 0, lastLongScanAt: 0 },
    collect: { failed: new Map(), picked: 0 },
    jev: { prefetched: 0, usedCached: 0, usedInstinct: 0 },
    stuck: { anchor: null, since: 0 },
    shelter: { until: 0 },
    bed: { until: 0, pos: null },
  };
}

console.log('\nshouldRun against a mock bot');
for (const rel of BEHAVIOR_MODULES) {
  const mod = require(path.join(srcDir, rel));
  for (const [name, value] of Object.entries(mod)) {
    if (!value || typeof value !== 'object' || typeof value.shouldRun !== 'function') continue;
    check(`${rel}: ${name}.shouldRun survives a bare bot`, () => {
      value.shouldRun(mockBot(), mockCtx());
      if (typeof value.canInterrupt === 'function') {
        value.canInterrupt(mockBot(), mockCtx());
      }
    });
  }
}

console.log(`\n${passed} checks passed`);
