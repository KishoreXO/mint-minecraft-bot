/**
 * Going back for what it dropped.
 *
 * Recovery hung on a single `pendingPos`, and the case that breaks is the
 * common one: the bot dies, sets off unarmed toward its own corpse, and dies
 * again on the way. The second death overwrote the first site, so the pile
 * with all the tools in it was forgotten at the exact moment it mattered — and
 * the bot has spent whole sessions cycling between rebuilding wooden tools and
 * losing them.
 *
 * So the sites are a queue now, each with its own despawn clock and its own
 * patience. These check the two things that decide whether anything is
 * actually recovered: that nothing is forgotten, and that the pile about to
 * vanish is the one collected first.
 *
 * Run with: node test/loot.test.js
 */

const assert = require('assert');
const Vec3 = require('vec3');
const {
  noteDeathSite, chooseSite, recoveryEtaSec, MAX_SITES, WALKABLE_DESCENT,
} = require('../src/behaviors/loot');

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

const lootCtx = () => ({ death: { sites: [], respawnedAt: 0 } });
const botAt = (x, y, z) => ({ entity: { position: new Vec3(x, y, z) } });

/** Backdate a site, to stand in for time passing. */
function age(site, seconds) {
  site.diedAt -= seconds * 1000;
  return site;
}

console.log('remembering every pile, not just the last one');

// THE bug: die on the way back to your corpse and the first pile vanishes
// from the bot's plans.
check('a second death does not erase the first pile', () => {
  const ctx = lootCtx();
  noteDeathSite(ctx, new Vec3(0, 64, 0));
  noteDeathSite(ctx, new Vec3(30, 64, 0));
  assert.strictEqual(ctx.death.sites.length, 2);
});

check('but it does not remember them forever', () => {
  const ctx = lootCtx();
  for (let i = 0; i < MAX_SITES + 3; i++) noteDeathSite(ctx, new Vec3(i, 64, 0));
  assert.strictEqual(ctx.death.sites.length, MAX_SITES);
  // The ones kept are the NEWEST, because the oldest are closest to
  // despawning and least likely to still be there.
  assert.strictEqual(ctx.death.sites[ctx.death.sites.length - 1].pos.x, MAX_SITES + 2);
});

check('a missing position is not queued', () => {
  const ctx = lootCtx();
  noteDeathSite(ctx, null);
  assert.strictEqual(ctx.death.sites.length, 0);
});

console.log('\ncollecting the one that is about to vanish');

// Nearest-first is the intuitive rule and it is wrong: the nearest pile is
// usually the newest, because it is where we just died, and it has the most
// time left. Walking past the four-minute-old pile to collect the ten-second
// -old one loses the four-minute-old one.
check('the oldest pile is collected first, not the nearest', () => {
  const ctx = lootCtx();
  const old = age(
    (noteDeathSite(ctx, new Vec3(40, 64, 0)), ctx.death.sites[0]),
    200,
  );
  noteDeathSite(ctx, new Vec3(2, 64, 0)); // right next to us, and fresh

  const picked = chooseSite(botAt(0, 64, 0), ctx);
  assert.ok(picked, 'should pick something');
  assert.strictEqual(picked, old, 'the one about to despawn wins');
});

check('a pile past its despawn window is dropped', () => {
  const ctx = lootCtx();
  noteDeathSite(ctx, new Vec3(1, 64, 0));
  age(ctx.death.sites[0], 6 * 60); // items live five minutes

  assert.strictEqual(chooseSite(botAt(0, 64, 0), ctx), null);
  assert.strictEqual(ctx.death.sites.length, 0, 'and forgotten, not re-checked forever');
});

// Budget, not distance: a pile four minutes old has one minute of walking
// left in it, and a fresh one has five. The same 200 blocks is reachable for
// one and not the other.
check('a pile too far to reach before it despawns is skipped, not dropped', () => {
  const ctx = lootCtx();
  noteDeathSite(ctx, new Vec3(200, 64, 0));
  age(ctx.death.sites[0], 4 * 60);

  assert.strictEqual(chooseSite(botAt(0, 64, 0), ctx), null, 'not worth the walk');
  assert.strictEqual(ctx.death.sites.length, 1, 'but still remembered');

  // ...and it becomes worth it again the moment we happen to be closer.
  assert.ok(chooseSite(botAt(195, 64, 0), ctx), 'reachable from nearby');
});

check('a pile we repeatedly cannot reach is given up on', () => {
  const ctx = lootCtx();
  noteDeathSite(ctx, new Vec3(5, 64, 0));
  ctx.death.sites[0].stalledLegs = 3;

  assert.strictEqual(chooseSite(botAt(0, 64, 0), ctx), null);
  assert.strictEqual(ctx.death.sites.length, 0);
});

check('no deaths means nothing to do', () => {
  assert.strictEqual(chooseSite(botAt(0, 64, 0), lootCtx()), null);
});

console.log('\nknowing what the trip takes before starting it');

const holding = (bot, ...names) => {
  bot.inventory = { items: () => names.map((name) => ({ name, count: 1 })) };
  return bot;
};

// Live on 09-24: died at y=-36, respawned at y=67 with an empty inventory,
// and walked at the pile for 1m50 because "121 blocks" fit a walking budget.
// A hundred blocks of staircase at the measured 0.35 a second, plus making a
// pickaxe first, is past the despawn clock before it starts.
check('a pile a hundred blocks down with no pickaxe is written off at once', () => {
  const ctx = lootCtx();
  noteDeathSite(ctx, new Vec3(67, -36, 43));
  age(ctx.death.sites[0], 5); // just respawned
  const bot = holding(botAt(60, 67, 36));
  assert.strictEqual(chooseSite(bot, ctx), null, 'no hope of arriving, so do not set off');
  assert.ok(recoveryEtaSec(bot, ctx.death.sites[0]) > 300, 'the estimate has to say why');
});

check('a reachable pile below waits for a pickaxe instead of walking at stone', () => {
  const ctx = lootCtx();
  noteDeathSite(ctx, new Vec3(5, 44, 0)); // 20 down
  age(ctx.death.sites[0], 60);
  assert.strictEqual(chooseSite(holding(botAt(0, 64, 0)), ctx), null, 'fists do not dig stone');
  assert.strictEqual(ctx.death.sites.length, 1, 'and it is kept for when the pickaxe exists');
  assert.strictEqual(ctx.death.sites[0].stalledLegs, 0, 'waiting is not a failed leg');
});

check('...and goes the moment it has one', () => {
  const ctx = lootCtx();
  noteDeathSite(ctx, new Vec3(5, 44, 0));
  age(ctx.death.sites[0], 60);
  assert.ok(chooseSite(holding(botAt(0, 64, 0), 'stone_pickaxe'), ctx));
});

check('a pile a few blocks down is a walk, pickaxe or not', () => {
  const ctx = lootCtx();
  noteDeathSite(ctx, new Vec3(5, 64 - WALKABLE_DESCENT, 0));
  assert.ok(chooseSite(holding(botAt(0, 64, 0)), ctx));
});

// Items in lava burn on contact; the pile is gone before the respawn screen.
check('a pile that went into lava is not gone back for', () => {
  const ctx = lootCtx();
  noteDeathSite(ctx, new Vec3(3, 64, 0), { inLava: true });
  assert.strictEqual(chooseSite(holding(botAt(0, 64, 0), 'diamond_pickaxe'), ctx), null);
  assert.strictEqual(ctx.death.sites.length, 0, 'forgotten, not re-checked');
});

// 09-25, Hard, 02:21-02:24: a night death, a respawn with nothing, and three
// walks back to the pile through the mobs that caused it — three more deaths.
check('not back across the surface at night with nothing to fight with', () => {
  const { loot } = require('../src/behaviors/loot');
  const ctx = lootCtx();
  noteDeathSite(ctx, new Vec3(20, 64, 0));
  ctx.death.respawnedAt = Date.now() - 5000;
  const night = holding(botAt(0, 64, 0));
  night.time = { timeOfDay: 18000, day: 1 };
  night.blockAt = (p) => ({ name: 'air', position: p, boundingBox: 'empty', light: 0, skyLight: 15 });
  assert.strictEqual(loot.shouldRun(night, ctx), false);

  const day = holding(botAt(0, 64, 0));
  day.time = { timeOfDay: 6000, day: 1 };
  day.blockAt = night.blockAt;
  assert.strictEqual(loot.shouldRun(day, ctx), true, 'by day the same pile is worth the walk');
});

// 09-25 17:13: killed by a creeper at dawn, straight back to the pile, dead
// again twenty-four seconds later fighting the same crowd.
function dawnAtPile(mobs, secondsOld = 5) {
  const { loot } = require('../src/behaviors/loot');
  const ctx = lootCtx();
  noteDeathSite(ctx, new Vec3(20, 64, 0));
  age(ctx.death.sites[0], secondsOld);
  ctx.death.respawnedAt = Date.now() - 5000;
  const bot = holding(botAt(0, 64, 0));
  bot.time = { timeOfDay: 1000, day: 2 };
  bot.blockAt = (p) => ({ name: 'air', position: p, boundingBox: 'empty', light: 15, skyLight: 15 });
  bot.entities = Object.fromEntries(mobs.map((m, i) => [i + 1, {
    id: i + 1, name: m.name, type: 'hostile', position: new Vec3(...m.at), isValid: true, metadata: [],
  }]));
  return loot.shouldRun(bot, ctx);
}

check('the mobs that killed us still on the pile: wait', () => {
  assert.strictEqual(dawnAtPile([{ name: 'creeper', at: [22, 64, 1] }]), false);
});

check('a mob well away from the pile does not hold it up', () => {
  assert.strictEqual(dawnAtPile([{ name: 'zombie', at: [60, 64, 0] }]), true);
});

check('...and the pile about to despawn is gone for regardless', () => {
  assert.strictEqual(dawnAtPile([{ name: 'creeper', at: [22, 64, 1] }], 250), true);
});

console.log(`\n${passed} checks passed`);
