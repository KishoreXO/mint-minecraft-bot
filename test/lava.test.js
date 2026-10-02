/**
 * Lava, judged by the whole body.
 *
 * The bot died at 15:36 on 09-24 holding thirteen diamonds. Every lava check
 * asked about the one block under its centre point, and with half the body in
 * a pool and the centre on the bank they all said "not in lava": the escape
 * stopped after one step, the ledger booked lava as fire, and `valuables`
 * walked on. Pathfinder had cut the corner of a lava cell to get there, and
 * nothing that walks by hand looked for lava at all.
 *
 * Run with: node test/lava.test.js
 */

const assert = require('assert');
const Vec3 = require('vec3');
const { touchingLava, lavaNearBody } = require('../src/lava');
const { escapeHazard, nearestSafeFooting } = require('../src/behaviors/survive');
const { classify } = require('../src/damage');
const { stepWouldFall, walkingIntoLava } = require('../src/falls');
const { lavaEdgeCost } = require('../src/bot');

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

const SOLID = new Set(['stone', 'deepslate']);

/**
 * Stone floor with its top at y=63 (the bot stands at y=64), and a lava pool
 * flush with the floor wherever `isPool(x, z)` says — the lava fills y=63 and
 * y=64, the way a pool at floor level does.
 */
function world(isPool) {
  return (x, y, z) => {
    if (isPool(x, z) && (y === 63 || y === 64)) return 'lava';
    return y <= 63 ? 'stone' : 'air';
  };
}

function botIn(terrain, pos, { velocity = { x: 0, y: 0, z: 0 } } = {}) {
  return {
    health: 20,
    food: 20,
    entity: {
      position: new Vec3(...pos), velocity, onGround: true, isInWater: false, metadata: [],
    },
    entities: {},
    controlState: {},
    setControlState() {},
    blockAt(p) {
      const q = new Vec3(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z));
      const name = terrain(q.x, q.y, q.z);
      return { name, position: q, boundingBox: SOLID.has(name) ? 'block' : 'empty' };
    },
  };
}

// A pool at x >= 1. The bot stands at x=0.75: its centre over stone at x=0,
// the right-hand 0.05 of its body over the lava.
const poolEast = world((x) => x >= 1);

console.log('the whole body, not the centre point');

check('half over the lava with the centre on the bank is IN lava', () => {
  const bot = botIn(poolEast, [0.75, 64, 0.5]);
  assert.strictEqual(touchingLava(bot), true);
  assert.strictEqual(escapeHazard.shouldRun(bot), true, 'the hazard behavior must fire, and it did not');
});

check('centred in the next cell over is not in lava', () => {
  const bot = botIn(poolEast, [0.5, 64, 0.5]);
  assert.strictEqual(touchingLava(bot), false);
  assert.strictEqual(escapeHazard.shouldRun(bot), false, 'walking beside a pool is not an emergency');
});

check('...but it is not yet clear of it either', () => {
  assert.strictEqual(lavaNearBody(botIn(poolEast, [0.5, 64, 0.5]), 1), true,
    'one step from the edge is where the escape stopped, and it went back in');
});

check('physics saying so is enough on its own', () => {
  const bot = botIn(world(() => false), [0.5, 64, 0.5]);
  bot.entity.isInLava = true;
  assert.strictEqual(touchingLava(bot), true);
});

check('lava damage on the bank is booked as lava, not fire', () => {
  const bot = botIn(poolEast, [0.75, 64, 0.5]);
  bot.entity.metadata = [0x01]; // on fire, as a body in lava always is
  assert.strictEqual(classify(bot, { lastFall: 0, lastFallAt: 0, fusingCreeperAt: 0 }), 'lava');
});

check('the escape does not aim for footing on the lip of the pool', () => {
  const bot = botIn(poolEast, [0.75, 64, 0.5]);
  const spot = nearestSafeFooting(bot);
  assert.ok(spot, 'there is plenty of safe ground to the west');
  assert.ok(spot.x <= -1, `aimed at x=${spot.x}, which is beside the lava`);
});

console.log('\nroutes keep off the edge');

check('a step beside lava costs, a step anywhere else does not', () => {
  const bot = botIn(poolEast, [0.5, 64, 0.5]);
  assert.ok(lavaEdgeCost(bot, { position: new Vec3(0, 64, 0) }) > 0, 'this is where pathfinder cut the corner');
  assert.strictEqual(lavaEdgeCost(bot, { position: new Vec3(-3, 64, 0) }), 0);
});

console.log('\nwalking by hand');

check('aiming at a point across a pool flush with the floor is refused', () => {
  const bot = botIn(world((x) => x === 2), [0.5, 64, 0.5]);
  assert.strictEqual(stepWouldFall(bot, new Vec3(4.5, 64, 0.5)), true,
    'the drop check sees stone under the lava and calls it ground');
});

check('walking toward a pool is caught before the body reaches it', () => {
  const bot = botIn(world((x) => x === 2), [0.5, 64, 0.5], { velocity: { x: 0.28, y: 0, z: 0 } });
  assert.strictEqual(walkingIntoLava(bot), true);
});

check('walking along a pool one cell over is left alone', () => {
  const bot = botIn(poolEast, [0.5, 64, 0.5], { velocity: { x: 0, y: 0, z: 0.28 } });
  assert.strictEqual(walkingIntoLava(bot), false);
});

check('already in it, the guard stands aside so the way out stays open', () => {
  const bot = botIn(poolEast, [0.75, 64, 0.5], { velocity: { x: 0.28, y: 0, z: 0 } });
  assert.strictEqual(walkingIntoLava(bot), false);
});

console.log(`\n${passed} checks passed`);
