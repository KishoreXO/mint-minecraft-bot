/**
 * Fighting, and surviving, in water.
 *
 * Reported directly: "he was just in water, not under, and was attacked by
 * drowned and died twice and he did nothing". Two separate mistakes produced
 * that, and both are the same shape — land assumptions applied to water.
 *
 *  1. SCHEDULING. Escaping water sat at priority 95, above combat at 90, so a
 *     bot with a full air gauge and a drowned on it spent every round paddling
 *     for a shore it could not reach and never once defended itself. Drowning
 *     and being wet are different problems and now have different priorities.
 *
 *  2. TACTICS. `drowned` was aliased to `zombie`, so it was fought with the
 *     sprint-hit-and-withdraw combo. In water you cannot sprint, cannot crit,
 *     deal almost no knockback, and swim slower (0.11 blocks a tick) than a
 *     drowned does (0.15). Every clause of the land tactic is false there, and
 *     backing off hands it free hits.
 *
 * Run with: node test/water.test.js
 */

const assert = require('assert');
const Vec3 = require('vec3');
const { escapeDrowning, leaveWater } = require('../src/behaviors/survive');
const { threat } = require('../src/behaviors/threat');
const { findShore, isSubmerged, AIR_FULL } = require('../src/swim');
const { mobFacts } = require('../src/knowledge');

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

const SOLID = new Set(['stone', 'dirt', 'grass_block', 'sand']);

/** `terrain(x, y, z)` returns a block name; the bot floats at `pos`. */
function swimmer(pos, terrain, { air = AIR_FULL, inWater = true } = {}) {
  return {
    oxygenLevel: air,
    entity: {
      position: new Vec3(pos[0], pos[1], pos[2]),
      isInWater: inWater,
    },
    blockAt(p) {
      const name = terrain(p.x, p.y, p.z);
      if (name === null) return null;
      return {
        name,
        position: new Vec3(p.x, p.y, p.z),
        boundingBox: SOLID.has(name) ? 'block' : 'empty',
      };
    },
  };
}

/** Water from floorY+1 up to surfaceY, stone below, air above. */
const lake = (surfaceY = 62, floorY = 55) => (x, y) => {
  if (y <= floorY) return 'stone';
  if (y <= surfaceY) return 'water';
  return 'air';
};

/** The same lake, with a bank at x >= bankX. */
function lakeWithBank(surfaceY, floorY, bankX) {
  return (x, y) => {
    if (x >= bankX) return y <= surfaceY ? 'stone' : 'air';
    if (y <= floorY) return 'stone';
    if (y <= surfaceY) return 'water';
    return 'air';
  };
}

const waterCtx = () => ({ water: { since: null, from: null, rescuing: false } });

console.log('drowning and being wet are different problems');

// THE bug. At 95 this outranked combat, so a bot with full lungs and a drowned
// on it spent every scheduling round swimming instead of fighting.
check('a bot with full air is not drowning, whatever else is happening', () => {
  const bot = swimmer([0, 61, 0], lake(), { air: AIR_FULL });
  assert.strictEqual(escapeDrowning.shouldRun(bot, waterCtx()), false);
});

check('a bot actually running out of air is', () => {
  const bot = swimmer([0, 58, 0], lake(), { air: 5 });
  assert.strictEqual(escapeDrowning.shouldRun(bot, waterCtx()), true);
});

check('and it outranks everything, including combat', () => {
  assert.ok(escapeDrowning.priority > threat.priority);
});

// The other half: merely being wet must NOT outrank defending ourselves,
// because swimming away from a drowned is not a thing that works.
check('merely being in water ranks below fighting', () => {
  assert.ok(
    leaveWater.priority < threat.priority,
    `leaveWater ${leaveWater.priority} must not outrank threat ${threat.priority}`,
  );
});

check('being on dry land is neither problem', () => {
  const bot = swimmer([0, 63, 0], lake(), { inWater: false });
  assert.strictEqual(escapeDrowning.shouldRun(bot, waterCtx()), false);
  assert.strictEqual(leaveWater.shouldRun(bot, waterCtx()), false);
});

console.log('\nknowing where the fight should happen');

check('it finds the bank when there is one', () => {
  const bot = swimmer([0, 61, 0], lakeWithBank(62, 55, 4));
  const shore = findShore(bot, 12);
  assert.ok(shore, 'should find the bank');
  assert.ok(shore.x >= 4, `bank should be at x>=4, got ${shore.x}`);
});

check('open water has no bank, and it says so rather than guessing', () => {
  const bot = swimmer([0, 61, 0], lake());
  assert.strictEqual(findShore(bot, 8), null);
});

// The search radius is what stops "fight from land" turning into "swim twenty
// blocks while being eaten".
check('a bank outside the search radius is not offered', () => {
  const bot = swimmer([0, 61, 0], lakeWithBank(62, 55, 20));
  assert.strictEqual(findShore(bot, 6), null);
  assert.ok(findShore(bot, 24), 'but it is there if we look further');
});

console.log('\nthe facts the water tactic is built on');

// If these numbers are wrong the tactic built on them is wrong, and the whole
// reason the bot backed away from a drowned is that nothing recorded them.
check('a drowned is faster than a swimming player', () => {
  const facts = mobFacts('drowned');
  assert.ok(facts.waterSpeed, 'drowned must have a water speed recorded');
  // A swimming player manages about 0.11 blocks a tick.
  assert.ok(facts.waterSpeed > 0.11, 'it must out-swim us, or fleeing would work');
});

check('a drowned is still flagged as a shooter — it throws its trident', () => {
  assert.strictEqual(mobFacts('drowned').ranged, true);
});

console.log('\ntelling submerged from merely wet');

check('floating with the head out is not submerged', () => {
  const bot = swimmer([0, 62, 0], lake(62));
  assert.strictEqual(isSubmerged(bot), false);
});

check('under the surface is', () => {
  const bot = swimmer([0, 58, 0], lake(62));
  assert.strictEqual(isSubmerged(bot), true);
});

console.log('\nstanding aside in water');

// unstick read every water cell as "walled in" and, at 93 against 85,
// preempted leaveWater 46 times on 09-26 — then pillared where pillaring
// cannot work. In water it is leaveWater's problem alone.
check('unstick never fires in water, however long the bot has been still', () => {
  const { unstick, STUCK_AFTER_MS } = require('../src/behaviors/unstick');
  const bot = swimmer([0, 62, 0], lake(62));
  const ctx = { stuck: { anchor: bot.entity.position.clone(), since: Date.now() - STUCK_AFTER_MS * 3 }, water: {} };
  assert.strictEqual(unstick.shouldRun(bot, ctx), false);
});

check('...nor while climbing out of the water on its own blocks', () => {
  const { unstick, STUCK_AFTER_MS } = require('../src/behaviors/unstick');
  const bot = swimmer([0, 70, 0], lake(62), { inWater: false });
  const ctx = {
    stuck: { anchor: bot.entity.position.clone(), since: Date.now() - STUCK_AFTER_MS * 3 },
    water: { escape: { how: 'landing', until: Date.now() + 60000 } },
  };
  assert.strictEqual(unstick.shouldRun(bot, ctx), false);
});

console.log('\nwater the bot had to build its way out of');

check('a remembered trap prices the water below it, not the rim above', () => {
  const memory = require('../src/memory');
  const { waterTrapCost, WATER_TRAP_COST } = require('../src/bot');
  memory.noteWaterTrap(new Vec3(500, 62, 500), 'landing');
  assert.strictEqual(waterTrapCost({ position: new Vec3(503, 62, 502) }), WATER_TRAP_COST);
  assert.strictEqual(waterTrapCost({ position: new Vec3(503, 78, 502) }), 0, 'the rim is not the trap');
  assert.strictEqual(waterTrapCost({ position: new Vec3(530, 62, 500) }), 0, 'nor is water far along');
  assert.strictEqual(memory.inWaterTrap(new Vec3(501, 61, 499)), true);
});

console.log(`\n${passed} checks passed`);
