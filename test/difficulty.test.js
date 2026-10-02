/**
 * Working out which difficulty this world is on, from how hard things hit.
 *
 * This is a measurement, and a measurement that is confidently wrong is worse
 * than one that is missing: the whole point is to feed fight-or-flight
 * decisions, so a bot that has decided it is on Easy when it is on Hard will
 * stand and trade with things that kill it in two hits. So the tests are as
 * much about what it REFUSES to learn from as what it learns.
 *
 * The arithmetic being checked comes from the vanilla player damage handler:
 *
 *   easy   min(base / 2 + 1, base)
 *   hard   base * 3 / 2
 *
 * Against a zombie's base 3 that is 2.5 / 3 / 4.5, and against a vindicator's
 * 13 it is 7.5 / 13 / 19.5 — both of which match the published tables, which
 * is the only reason inverting it works at all.
 *
 * Run with: node test/difficulty.test.js
 */

const assert = require('assert');
const difficulty = require('../src/difficulty');
const { scaleDamage, armorMultiplier, armorWorn } = require('../src/knowledge');

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

/** A bot with no armour, no shield up, and nothing else going on. */
function plainBot({ health = 20, armor = {}, handState = 0 } = {}) {
  const slots = {
    head: 5, torso: 6, legs: 7, feet: 8,
  };
  const inventory = { slots: {} };
  for (const [slot, name] of Object.entries(armor)) {
    inventory.slots[slots[slot]] = { name };
  }
  return {
    health,
    inventory,
    getEquipmentDestSlot: (slot) => slots[slot],
    entity: { metadata: [null, null, null, null, null, null, null, null, handState] },
  };
}

function freshCtx() {
  return { difficulty: difficulty.createState() };
}

/** Feed the same clean hit several times, which is what a real fight does. */
function feed(ctx, bot, mob, amount, times = 3) {
  for (let i = 0; i < times; i++) difficulty.observe(bot, ctx, mob, amount);
}

console.log('the arithmetic it is all built on');

check('easy halves a hit and adds one back', () => {
  assert.strictEqual(scaleDamage(3, 'easy'), 2.5);
  assert.strictEqual(scaleDamage(13, 'easy'), 7.5);
});

check('normal changes nothing', () => {
  assert.strictEqual(scaleDamage(3, 'normal'), 3);
  assert.strictEqual(scaleDamage(13, 'normal'), 13);
});

check('hard is half again', () => {
  assert.strictEqual(scaleDamage(3, 'hard'), 4.5);
  assert.strictEqual(scaleDamage(13, 'hard'), 19.5);
});

check('peaceful is nothing at all', () => {
  assert.strictEqual(scaleDamage(22, 'peaceful'), 0);
});

// A small hit never scales BELOW itself on easy — min() is doing real work
// there, and dropping it would make a 1-damage hit read as 1.5.
check('easy never makes a small hit bigger', () => {
  assert.strictEqual(scaleDamage(1, 'easy'), 1);
  assert.strictEqual(scaleDamage(2, 'easy'), 2);
});

console.log('\nreading the difficulty off real hits');

check('zombies hitting for 3 say normal', () => {
  const ctx = freshCtx();
  feed(ctx, plainBot(), 'zombie', 3);
  assert.strictEqual(difficulty.current(ctx), 'normal');
});

check('zombies hitting for 4.5 say hard', () => {
  const ctx = freshCtx();
  feed(ctx, plainBot(), 'zombie', 4.5);
  assert.strictEqual(difficulty.current(ctx), 'hard');
});

check('zombies hitting for 2.5 say easy', () => {
  const ctx = freshCtx();
  feed(ctx, plainBot(), 'zombie', 2.5);
  assert.strictEqual(difficulty.current(ctx), 'easy');
});

// The mobs that hit hardest are the easiest to read, because the three
// candidate values are furthest apart.
check('a vindicator at 19.5 is unmistakably hard', () => {
  const ctx = freshCtx();
  feed(ctx, plainBot(), 'vindicator', 19.5);
  assert.strictEqual(difficulty.current(ctx), 'hard');
  assert.ok(ctx.difficulty.confidence > 0.8, `confidence was ${ctx.difficulty.confidence}`);
});

// Until it has been hit a few times the bot assumes HARD, not Normal. The two
// directions of error are not symmetrical: guess high and it is briefly
// over-cautious, guess low and it stands and trades with something hitting
// half again as hard as it expects.
check('one hit is not enough to commit, and until then it assumes the worst', () => {
  const ctx = freshCtx();
  difficulty.observe(plainBot(), ctx, 'zombie', 4.5);
  assert.strictEqual(ctx.difficulty.inferred, null);
  assert.strictEqual(difficulty.current(ctx), 'hard');
});

check('and it stops assuming as soon as the hits say otherwise', () => {
  const ctx = freshCtx();
  feed(ctx, plainBot(), 'zombie', 2.5);
  assert.strictEqual(difficulty.current(ctx), 'easy');
});

console.log('\nwhat it refuses to learn from');

// Blast damage falls off with distance, so a creeper is consistent with any
// difficulty at all and would poison the estimate.
check('creepers are never a sample', () => {
  const ctx = freshCtx();
  feed(ctx, plainBot(), 'creeper', 11, 10);
  assert.strictEqual(ctx.difficulty.samples, 0);
  assert.match(ctx.difficulty.lastSample.ignored, /creeper/);
});

// Arrow damage scales with draw and flight speed, not difficulty.
check('archers are never a sample', () => {
  const ctx = freshCtx();
  feed(ctx, plainBot(), 'skeleton', 4, 10);
  assert.strictEqual(ctx.difficulty.samples, 0);
  assert.match(ctx.difficulty.lastSample.ignored, /ranged/);
});

check('a mob we have no numbers for is never a sample', () => {
  const ctx = freshCtx();
  feed(ctx, plainBot(), 'something_modded', 3, 10);
  assert.strictEqual(ctx.difficulty.samples, 0);
});

check('a raised shield disqualifies the hit', () => {
  const ctx = freshCtx();
  feed(ctx, plainBot({ handState: 0x01 }), 'zombie', 1, 10);
  assert.strictEqual(ctx.difficulty.samples, 0);
  assert.match(ctx.difficulty.lastSample.ignored, /shield/);
});

// Two things landing on the same tick, or a fall arriving with a punch. The
// total matches no single difficulty, so it says nothing about any of them.
check('a hit matching no difficulty is discarded, not averaged in', () => {
  const ctx = freshCtx();
  feed(ctx, plainBot(), 'zombie', 12, 5);
  assert.strictEqual(ctx.difficulty.samples, 0);
  assert.match(ctx.difficulty.lastSample.ignored, /matches no difficulty/);
});

// And discarding must leave no trace — an earlier version scored the sample
// and then subtracted it back, which left floating-point residue on exactly
// the numbers the verdict is read off.
check('discarded hits leave the scores untouched', () => {
  const ctx = freshCtx();
  const before = { ...ctx.difficulty.scores };
  feed(ctx, plainBot(), 'zombie', 12, 5);
  assert.deepStrictEqual(ctx.difficulty.scores, before);
});

console.log('\narmour is corrected for, not a reason to give up');

// Without this the bot would stop being able to measure anything the moment
// it put a helmet on — which is early, and permanent.
check('the same difficulty is still read correctly through iron armour', () => {
  const armor = {
    head: 'iron_helmet',
    torso: 'iron_chestplate',
    legs: 'iron_leggings',
    feet: 'iron_boots',
  };
  const bot = plainBot({ armor });
  const { points, toughness } = armorWorn(bot);
  assert.strictEqual(points, 15); // 2 + 6 + 5 + 2

  const landed = scaleDamage(3, 'hard') * armorMultiplier(points, toughness, scaleDamage(3, 'hard'));
  const ctx = freshCtx();
  feed(ctx, bot, 'zombie', landed);
  assert.strictEqual(difficulty.current(ctx), 'hard');
});

console.log('\nthe server always wins');

check('a reported difficulty overrides anything we inferred', () => {
  const ctx = freshCtx();
  feed(ctx, plainBot(), 'zombie', 4.5); // looks like hard
  difficulty.noteReported(ctx, 'easy');
  assert.strictEqual(difficulty.current(ctx), 'easy');
  assert.strictEqual(difficulty.source(ctx), 'server');
});

check('peaceful only ever comes from the server', () => {
  const ctx = freshCtx();
  assert.ok(!difficulty.MEASURABLE.includes('peaceful'));
  difficulty.noteReported(ctx, 'peaceful');
  assert.strictEqual(difficulty.current(ctx), 'peaceful');
});

check('nonsense from the server is ignored', () => {
  const ctx = freshCtx();
  difficulty.noteReported(ctx, 'impossible');
  difficulty.noteReported(ctx, undefined);
  assert.strictEqual(ctx.difficulty.reported, null);
  assert.strictEqual(difficulty.source(ctx), 'assumed');
});

console.log('\nwhat the number is actually for');

check('a hit costs more on hard than on easy', () => {
  const bot = plainBot();
  const easy = { difficulty: { ...difficulty.createState(), reported: 'easy' } };
  const hard = { difficulty: { ...difficulty.createState(), reported: 'hard' } };
  assert.ok(difficulty.hitCost(bot, hard, 'zombie') > difficulty.hitCost(bot, easy, 'zombie'));
});

check('how many hits we can take falls as health does', () => {
  const ctx = { difficulty: { ...difficulty.createState(), reported: 'normal' } };
  assert.strictEqual(difficulty.hitsSurvivable(plainBot({ health: 20 }), ctx, 'zombie'), 6);
  assert.strictEqual(difficulty.hitsSurvivable(plainBot({ health: 6 }), ctx, 'zombie'), 2);
});

// The rule that fires from this must not turn every creeper into a retreat,
// which is what dividing health by a 22-point blast would do.
check('a vindicator on hard is a one-hit problem', () => {
  const ctx = { difficulty: { ...difficulty.createState(), reported: 'hard' } };
  assert.strictEqual(difficulty.hitsSurvivable(plainBot({ health: 20 }), ctx, 'vindicator'), 1);
});

check('nothing can hurt us on peaceful', () => {
  const ctx = { difficulty: { ...difficulty.createState(), reported: 'peaceful' } };
  assert.strictEqual(difficulty.hitCost(plainBot(), ctx, 'zombie'), 0);
  assert.strictEqual(difficulty.hitsSurvivable(plainBot(), ctx, 'zombie'), Infinity);
});

console.log(`\n${passed} checks passed`);
