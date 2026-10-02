/**
 * Offline checks for the entity-classification logic.
 *
 * This exists because a single wrong assumption here (`entity.type === 'mob'`)
 * silently disabled all combat and all hunting on modern Minecraft versions,
 * and nothing in the logs said so — the bot just quietly never saw a mob.
 * Run with: node test/entities.test.js
 */

const assert = require('assert');
const {
  isHostileMob, isFoodAnimal, isOtherPlayer, isPillarable, isRangedAttacker, isExplosive,
  isNeutralMob, canOutrun, isBoss,
} = require('../src/entities');

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

// How mineflayer actually populates entities on 1.19+ (via minecraft-data),
// which is what the old `type === 'mob'` check failed to match.
const modernZombie = { name: 'zombie', type: 'hostile', kind: 'Hostile mobs', isValid: true };
const modernCow = { name: 'cow', type: 'animal', kind: 'Passive mobs', isValid: true };
const modernSkeleton = { name: 'skeleton', type: 'hostile', kind: 'Hostile mobs', isValid: true };
const modernCreeper = { name: 'creeper', type: 'hostile', kind: 'Hostile mobs', isValid: true };
// How they looked on pre-1.19 servers, which we must still support.
const legacyZombie = { name: 'zombie', type: 'mob', kind: 'Hostile mobs', isValid: true };
const player = { name: 'player', type: 'player', username: 'Steve', isValid: true };
const self = { name: 'player', type: 'player', username: 'Mint', isValid: true };

console.log('entity classification');

check('modern hostile (1.19+) is detected', () => {
  assert.strictEqual(isHostileMob(modernZombie), true);
  assert.strictEqual(isHostileMob(modernSkeleton), true);
});

check('legacy hostile (pre-1.19) still detected', () => {
  assert.strictEqual(isHostileMob(legacyZombie), true);
});

check('players are never treated as hostile mobs', () => {
  assert.strictEqual(isHostileMob(player), false);
});

check('passive animals are not hostile', () => {
  assert.strictEqual(isHostileMob(modernCow), false);
});

check('modern food animal is detected', () => {
  assert.strictEqual(isFoodAnimal(modernCow), true);
});

check('hostiles are not food animals', () => {
  assert.strictEqual(isFoodAnimal(modernZombie), false);
});

check('other players identified, self excluded', () => {
  const bot = { username: 'Mint' };
  assert.strictEqual(isOtherPlayer(bot, player), true);
  assert.strictEqual(isOtherPlayer(bot, self), false);
});

check('tactic classification', () => {
  assert.strictEqual(isPillarable(modernZombie), true);
  assert.strictEqual(isPillarable(modernSkeleton), false, 'skeletons shoot over a pillar');
  assert.strictEqual(isRangedAttacker(modernSkeleton), true);
  assert.strictEqual(isExplosive(modernCreeper), true);
});

check('invalid/missing entities never match', () => {
  assert.strictEqual(isHostileMob(null), false);
  assert.strictEqual(isHostileMob({ name: 'zombie', type: 'hostile', isValid: false }), false);
});

// The bot attacked an idle enderman with its bare fists and died. Endermen
// (and piglins) report type 'hostile' in minecraft-data but are neutral
// until provoked — attacking one unprovoked is never correct.
check('neutral mobs are not treated as hostile targets', () => {
  const enderman = { name: 'enderman', type: 'hostile', kind: 'Hostile mobs', isValid: true };
  const piglin = { name: 'piglin', type: 'hostile', kind: 'Hostile mobs', isValid: true };
  const zombiePiglin = { name: 'zombified_piglin', type: 'hostile', isValid: true };

  assert.strictEqual(isHostileMob(enderman), false, 'enderman must not be auto-targeted');
  assert.strictEqual(isHostileMob(piglin), false, 'piglin must not be auto-targeted');
  assert.strictEqual(isHostileMob(zombiePiglin), false, 'hitting one aggros them all');

  assert.strictEqual(isNeutralMob(enderman), true);
  assert.strictEqual(isNeutralMob(piglin), true);
});

check('genuinely hostile mobs are still targeted', () => {
  assert.strictEqual(isHostileMob({ name: 'creeper', type: 'hostile', isValid: true }), true);
  assert.strictEqual(isHostileMob({ name: 'piglin_brute', type: 'hostile', isValid: true }), true);
  assert.strictEqual(isNeutralMob({ name: 'creeper', type: 'hostile', isValid: true }), false);
});

// Fleeing something faster than you, or something that shoots, means taking
// the same damage while dealing none back. The bot kept choosing to flee
// spiders and skeletons and dying partway through the retreat.
check('only genuinely escapable threats are outrunnable', () => {
  assert.strictEqual(canOutrun(modernZombie), true, 'zombies are slower than a sprint');
  assert.strictEqual(canOutrun(modernCreeper), true, 'creepers are slower and must be escaped');
  assert.strictEqual(canOutrun({ name: 'spider', isValid: true }), false, 'spiders are faster');
  assert.strictEqual(canOutrun(modernSkeleton), false, 'running gives it a free shooting gallery');
  assert.strictEqual(canOutrun({ name: 'enderman', isValid: true }), false, 'teleports');
  assert.strictEqual(canOutrun(player), false, 'players sprint exactly as fast as we do');
  assert.strictEqual(canOutrun(null), false);
});

// The bot charged a wither bare-fisted and died in two seconds, twice,
// because "can't outrun it, so fight it" had no concept of an unwinnable
// fight. Fleeing a wither may fail too — but it isn't a certainty.
// Missing entries here are invisible: the bot stands there being shot and
// never reacts, because `worthReactingTo` only makes an exception at range
// for things it knows can shoot. Pillagers were missing and it showed.
check('everything that attacks at range is flagged as such', () => {
  for (const name of ['skeleton', 'stray', 'bogged', 'pillager', 'illusioner',
    'witch', 'ghast', 'blaze', 'breeze', 'shulker']) {
    assert.strictEqual(
      isRangedAttacker({ name, type: 'hostile', isValid: true }),
      true,
      `${name} shoots — it must not be treated as scenery at range`,
    );
  }
});

check('melee-only mobs are not flagged as ranged', () => {
  for (const name of ['zombie', 'spider', 'creeper', 'husk', 'silverfish']) {
    assert.strictEqual(isRangedAttacker({ name, type: 'hostile', isValid: true }), false, name);
  }
});

check('bosses are recognised as unwinnable fights', () => {
  assert.strictEqual(isBoss({ name: 'wither', isValid: true }), true);
  assert.strictEqual(isBoss({ name: 'warden', isValid: true }), true);
  assert.strictEqual(isBoss({ name: 'ender_dragon', isValid: true }), true);
  assert.strictEqual(isBoss(modernZombie), false);
  assert.strictEqual(isBoss(modernCreeper), false);
  assert.strictEqual(isBoss(null), false);
});

console.log(`\n${passed} checks passed`);
