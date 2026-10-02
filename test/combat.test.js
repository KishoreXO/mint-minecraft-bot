/**
 * The one number the melee turns on.
 *
 * A player's entity reach is 3.0 blocks. A zombie's is 2.2, a spider's 2.0.
 * Standing at 2.6 means we hit them and they cannot touch us at all;
 * standing at 2.0 — which is where the combat engine's `tooCloseRange`
 * parked the bot — means trading evenly with something that has more health
 * than we do. "Killed by a spider and a zombie in an open field while
 * holding a stone sword" was that gap, not bad luck.
 *
 * Run with: node test/combat.test.js
 */

const assert = require('assert');
const { standoffFor, attackCooldownMs, MAX_STRIKE } = require('../src/tactics');
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

const botWithPing = (ping = 0, held = 'stone_sword') => ({
  player: { ping },
  heldItem: { name: held },
});
const mob = (name) => ({ name });

console.log('standing outside their reach');

// The whole point: for every melee mob, our hold position is further away
// than it can swing, and still inside the 3.0 we can swing from.
check('we stand outside the reach of every melee mob we fight', () => {
  for (const name of ['zombie', 'spider', 'husk', 'cave_spider', 'vindicator', 'drowned']) {
    const standoff = standoffFor(botWithPing(), mob(name));
    const theirs = mobFacts(name).reach;
    assert.ok(standoff > theirs, `${name}: standoff ${standoff} must exceed reach ${theirs}`);
    assert.ok(standoff < MAX_STRIKE, `${name}: standoff ${standoff} must stay inside our reach`);
  }
});

// Not everything CAN be out-ranged: an enderman reaches exactly as far as we
// do, so there is no safe band against one. The cap keeps us at our own max
// reach rather than inventing a gap that does not exist — and the bot treats
// endermen as neutral and does not pick that fight in the first place.
check('a mob that reaches as far as we do gets our maximum, not a fantasy', () => {
  const standoff = standoffFor(botWithPing(), mob('enderman'));
  assert.ok(standoff <= MAX_STRIKE);
  assert.ok(standoff >= MAX_STRIKE - 0.2, 'should still be at our outer edge');
});

check('a spider lets us stand closer than a zombie does', () => {
  // Spider reach 2.0 vs zombie 2.2 — the band adapts per mob rather than
  // using one number for everything.
  assert.ok(standoffFor(botWithPing(), mob('spider'))
    < standoffFor(botWithPing(), mob('zombie')));
});

// Melee reach and shooting range are different numbers, and using the wrong
// one made the bot try to duel a skeleton from sixteen blocks away while
// holding its shield up at half speed the entire approach.
check('a shooter is fought at its MELEE reach, not its shooting range', () => {
  const standoff = standoffFor(botWithPing(), mob('skeleton'));
  assert.ok(standoff < MAX_STRIKE, 'must remain inside our own reach');
  assert.ok(standoff > mobFacts('skeleton').reach, 'outside what it can swing at');
  assert.ok(mobFacts('skeleton').range > 10, 'its shooting range is still recorded');
});

check('every ranged mob records both numbers', () => {
  for (const name of ['skeleton', 'stray', 'bogged', 'pillager', 'witch', 'blaze']) {
    const f = mobFacts(name);
    assert.ok(f.reach <= 3, `${name}: melee reach should be a melee number`);
    assert.ok(f.range > f.reach, `${name}: shooting range should exceed melee reach`);
  }
});

check('an unknown mob gets a sane band rather than a crash', () => {
  const standoff = standoffFor(botWithPing(), mob('some_mob_from_1_22'));
  assert.ok(standoff > 0 && standoff < MAX_STRIKE);
});

console.log('\naccounting for latency');

// Every position we read is already stale by one round trip. At 200ms a
// sprinting mob has moved most of a block since the packet we are looking at.
check('higher ping makes us stand further off', () => {
  const near = standoffFor(botWithPing(0), mob('zombie'));
  const laggy = standoffFor(botWithPing(250), mob('zombie'));
  assert.ok(laggy > near, 'a laggy connection needs more margin');
});

check('a fast mob needs more margin than a slow one at the same ping', () => {
  const slow = standoffFor(botWithPing(200), mob('zombie')); // 0.23/tick
  const fast = standoffFor(botWithPing(200), mob('spider')); // 0.30/tick
  const slowMargin = slow - mobFacts('zombie').reach;
  const fastMargin = fast - mobFacts('spider').reach;
  assert.ok(fastMargin > slowMargin);
});

check('even terrible ping cannot push the standoff past our reach', () => {
  assert.ok(standoffFor(botWithPing(2000), mob('spider')) < MAX_STRIKE);
});

console.log('\nswinging on cooldown');

// Swinging before the cooldown expires deals a fraction of full damage,
// which is how a stone sword stops being able to win a fight it should.
check('a sword waits 625ms between swings', () => {
  assert.strictEqual(attackCooldownMs(botWithPing(0, 'stone_sword')), 625);
});

check('an axe waits longer, because it hits harder', () => {
  assert.ok(attackCooldownMs(botWithPing(0, 'iron_axe'))
    > attackCooldownMs(botWithPing(0, 'iron_sword')));
});

check('an empty hand still has a cooldown rather than spamming', () => {
  assert.ok(attackCooldownMs({ player: {} }) > 0);
});

console.log(`\n${passed} checks passed`);
