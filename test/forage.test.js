/**
 * Looking for food: go somewhere new, and pick what is growing on the way.
 *
 * Live on 09-26 (22:06–22:33) the bot starved three times in the same
 * hunted-out 200 blocks. Every 24-block leg picked a fresh random heading, and
 * a random walk goes nowhere. These pin the replacement: a committed heading,
 * turned away from ground already searched and found empty.
 *
 * Run with: node test/forage.test.js
 */

const assert = require('assert');
const Vec3 = require('vec3');
const memory = require('../src/memory');
const {
  pickForageTarget, abandonHeading, isRipe, RIPE_AGE,
} = require('../src/behaviors/hunt');

let passed = 0;
function check(label, fn) {
  try {
    fn();
    passed++;
    console.log(`  ok  ${label}`);
  } catch (err) {
    console.error(`  FAIL  ${label}\n        ${err.message}`);
    process.exitCode = 1;
  }
}

// Plains everywhere; no biome data needed beyond "not barren".
function botAt(x, z) {
  return {
    entity: { position: new Vec3(x, 64, z) },
    blockAt: () => ({ biome: { name: 'plains' } }),
    world: { getBiome: () => 1 },
    registry: { biomes: { 1: { name: 'plains' } } },
  };
}

const headingOf = (bot, target) => Math.atan2(target.z - bot.entity.position.z, target.x - bot.entity.position.x);

console.log('forage heading');

check('keeps the same heading leg after leg', () => {
  const ctx = {};
  const bot = botAt(0, 0);
  const first = headingOf(bot, pickForageTarget(bot, ctx));
  for (let leg = 0; leg < 5; leg++) {
    bot.entity.position = pickForageTarget(bot, ctx);
  }
  const later = headingOf(bot, pickForageTarget(bot, ctx));
  assert.ok(Math.abs(Math.sin(first - later)) < 1e-9 && Math.cos(first - later) > 0, 'the heading drifted');
  assert.ok(bot.entity.position.distanceTo(new Vec3(0, 64, 0)) > 100, 'five committed legs cover real ground');
});

check('a leg that got nowhere makes it turn', () => {
  const ctx = {};
  const bot = botAt(0, 0);
  pickForageTarget(bot, ctx);
  abandonHeading(ctx);
  assert.strictEqual(ctx.forage.heading, null);
});

check('a new heading leads away from ground already searched and found empty', () => {
  // Everything east of the bot has been searched.
  for (let x = 20; x <= 200; x += 30) {
    for (let z = -120; z <= 120; z += 30) memory.noteNoFood({ x, z });
  }
  for (let i = 0; i < 10; i++) {
    const ctx = {};
    const bot = botAt(0, 0);
    const target = pickForageTarget(bot, ctx);
    assert.ok(target.x < 0, `heading ${Math.round((headingOf(bot, target) * 180) / Math.PI)} leads back east`);
  }
});

console.log('\nplant food');

function crop(name, age) {
  return { name, getProperties: () => ({ age }) };
}

check('crops are ripe only when fully grown', () => {
  assert.ok(!isRipe(crop('carrots', 6)));
  assert.ok(isRipe(crop('carrots', 7)));
  assert.ok(isRipe(crop('beetroots', 3)));
  assert.ok(!isRipe(crop('potatoes', 0)));
});

check('a berry bush is worth picking from age 2', () => {
  assert.ok(!isRipe(crop('sweet_berry_bush', 1)));
  assert.ok(isRipe(crop('sweet_berry_bush', RIPE_AGE.sweet_berry_bush)));
});

check('a melon is always ready; wheat and unknown blocks are not food', () => {
  assert.ok(isRipe({ name: 'melon' }));
  assert.ok(!isRipe(crop('wheat', 7)));
  assert.ok(!isRipe(null));
});

console.log(`\n${passed} checks passed`);
