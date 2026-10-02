/**
 * Who owns a fight: `defend` or `threat`.
 *
 * They share a run(), and they sit on opposite sides of sheltering on purpose —
 * choosing to start a fight at night is worse than burrowing, being in one
 * already is not. That split fixed a death (a bot in full iron standing still
 * while a zombie ate it, because `shelter` at 91 outranked `threat` at 88 and
 * is exempt from the deadlock breaker).
 *
 * It also introduced a subtler problem, which is what this file exists for. If
 * both want the same fight, the fight gets STARTED TWICE: `threat` wins the
 * idle pick, `defend` preempts it a moment later, and the approach — equip,
 * close, first swing — is thrown away and redone. Watched live as two
 * "Committing to fight / Engaging" pairs inside the same second, against the
 * same zombie, at the same distance, with a preempt line between them.
 *
 * So the rule is: exactly one of them wants any given situation.
 *
 * Run with: node test/combatscheduling.test.js
 */

const assert = require('assert');
const { Vec3 } = require('vec3');
const { threat, defend } = require('../src/behaviors/threat');

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

function mob(name, distance, id = 1) {
  return {
    id,
    name,
    type: 'hostile',
    isValid: true,
    metadata: [],
    position: new Vec3(distance, 64, 0),
  };
}

/**
 * `hurtMsAgo` drives the "something is landing hits on us" clause; leave it out
 * for a mob that is merely present.
 */
function scene({ mobs = [], health = 20, hurtMsAgo = null } = {}) {
  const now = Date.now();
  const bot = {
    health,
    username: 'bot',
    entity: { id: 99, position: new Vec3(0, 64, 0), isValid: true },
    entities: Object.fromEntries(mobs.map((m) => [m.id, m])),
    inventory: { items: () => [], slots: [] },
    getEquipmentDestSlot: () => 5,
    registry: { itemsByName: {} },
    // Clear line of sight to everything: raycast finds nothing in the way.
    world: { raycast: () => null },
  };
  const ctx = {
    threat: {
      decisions: new Map(),
      fleeAttempts: new Map(),
      unreachable: new Map(),
      unreachableStrikes: new Map(),
      lastAttackerId: hurtMsAgo === null ? null : mobs[0]?.id ?? null,
      lastAttackAt: hurtMsAgo === null ? 0 : now - hurtMsAgo,
      lastAttackedAt: hurtMsAgo === null ? 0 : now - hurtMsAgo,
      lastSwitchAt: 0,
    },
  };
  return { bot, ctx };
}

console.log('exactly one behavior owns a fight');

check('something hitting us belongs to defend, not threat', () => {
  const { bot, ctx } = scene({ mobs: [mob('zombie', 3)], hurtMsAgo: 500 });
  assert.strictEqual(defend.shouldRun(bot, ctx), true, 'defend must take a live fight');
  assert.strictEqual(threat.shouldRun(bot, ctx), false, 'threat must not start it as well');
});

check('something on top of us belongs to defend too', () => {
  const { bot, ctx } = scene({ mobs: [mob('zombie', 3)] });
  assert.strictEqual(defend.shouldRun(bot, ctx), true);
  assert.strictEqual(threat.shouldRun(bot, ctx), false);
});

check('a mob across the clearing is threat\'s, and threat sits below sheltering', () => {
  const { bot, ctx } = scene({ mobs: [mob('zombie', 9)] });
  assert.strictEqual(defend.shouldRun(bot, ctx), false, 'not a fight yet');
  // Whether threat wants it depends on being armed, which this bare bot is
  // not — the point here is only that defend has not claimed it.
});

check('nothing nearby means neither wants the wheel', () => {
  const { bot, ctx } = scene({ mobs: [] });
  assert.strictEqual(defend.shouldRun(bot, ctx), false);
  assert.strictEqual(threat.shouldRun(bot, ctx), false);
});

// A creeper is answered with distance, and `shelter` sealing the bot into a
// hole away from one is a perfectly good answer. Letting `defend` outrank
// sheltering for a creeper would cancel that.
check('a creeper standing nearby is not a reason to outrank sheltering', () => {
  const { bot, ctx } = scene({ mobs: [mob('creeper', 4)] });
  assert.strictEqual(
    defend.shouldRun(bot, ctx), false,
    'the answer to a creeper is distance, not a fight that preempts the shelter',
  );
});

check('...but a creeper that has already hurt us is a live fight', () => {
  const { bot, ctx } = scene({ mobs: [mob('creeper', 4)], hurtMsAgo: 500 });
  assert.strictEqual(defend.shouldRun(bot, ctx), true);
  assert.strictEqual(threat.shouldRun(bot, ctx), false);
});

console.log('\nbeing dead is not being in a fight');

check('a corpse wants neither', () => {
  const { bot, ctx } = scene({ mobs: [mob('zombie', 2)], health: 0, hurtMsAgo: 100 });
  assert.strictEqual(defend.shouldRun(bot, ctx), false);
  assert.strictEqual(threat.shouldRun(bot, ctx), false);
});

// threat.shouldRun honoured a cached "ignore" and defend did not — so a mob
// idling nearby with that verdict went to defend, whose run() ignored it
// again and reported it as work, and the director picked defend straight
// back up. Jev has not said "ignore" yet in any logged session, which is the
// only reason this never showed.
console.log('\nan "ignore" verdict is honoured by both owners');

function withVerdict(ctx, id, decision) {
  ctx.threat.decisions.set(id, { decision, at: Date.now() });
  return ctx;
}

check('a nearby mob Jev said to ignore does not wake defend', () => {
  const { bot, ctx } = scene({ mobs: [mob('zombie', 5)] });
  withVerdict(ctx, 1, 'ignore');
  assert.strictEqual(defend.shouldRun(bot, ctx), false);
  assert.strictEqual(threat.shouldRun(bot, ctx), false);
});

check('...but one that is hitting us is a fight, whatever the verdict said', () => {
  const { bot, ctx } = scene({ mobs: [mob('zombie', 3)], hurtMsAgo: 500 });
  withVerdict(ctx, 1, 'ignore');
  assert.strictEqual(defend.shouldRun(bot, ctx), true);
});

// The handoff: threat engages a zombie at 6.8 blocks, it closes to three, and
// defend — whose run is threat.run — preempted the fight to restart it. Six
// double "Engaging" lines in one five-minute session on 09-25.
check('a fight threat already started is not restarted by defend', () => {
  const { bot, ctx } = scene({ mobs: [mob('zombie', 3)], hurtMsAgo: 500 });
  ctx.currentBehavior = 'threat';
  assert.strictEqual(defend.canInterrupt(bot, ctx), false, 'aborting a fight to begin the same fight');
});

check('but defend still breaks into anything that is not already fighting', () => {
  const { bot, ctx } = scene({ mobs: [mob('zombie', 3)], hurtMsAgo: 500 });
  ctx.currentBehavior = 'mine';
  assert.strictEqual(defend.canInterrupt(bot, ctx), true, 'being hit while mining must interrupt the mining');
});

// 09-25 02:09: seven deaths in ten minutes, three of them "Digging in" →
// "Preempting {shelter → defend}" → "Could not break the floor to shelter
// {held: bare hands}" → an unarmed fight with a skeleton.
console.log('\na dig-in is a commitment, bounded by its damage budget');

function digging(ctx, bot, startHealth) {
  ctx.currentBehavior = 'shelter';
  ctx.shelter = { digging: true, digStartHealth: startHealth };
  return ctx;
}

check('defend leaves a dig-in alone while it is still cheap', () => {
  const { bot, ctx } = scene({ mobs: [mob('zombie', 3)], hurtMsAgo: 300, health: 17 });
  digging(ctx, bot, 20);
  assert.strictEqual(defend.canInterrupt(bot, ctx), false);
});

check('...and takes over once digging in has cost too much', () => {
  const { bot, ctx } = scene({ mobs: [mob('zombie', 3)], hurtMsAgo: 300, health: 13 });
  digging(ctx, bot, 20);
  assert.strictEqual(defend.canInterrupt(bot, ctx), true);
});

check('a sealed shelter that is not digging is defended as before', () => {
  const { bot, ctx } = scene({ mobs: [mob('zombie', 3)], hurtMsAgo: 300 });
  ctx.currentBehavior = 'shelter';
  ctx.shelter = { digging: false, sealedIn: true };
  assert.strictEqual(defend.canInterrupt(bot, ctx), true);
});

// The other half: defend (94) used to take the wheel before shelter (91) could
// even start, and an unarmed bot shot at from ten blocks boxed the skeleton.
function nightOnOpenGround(bot, ctx) {
  bot.time = { timeOfDay: 15000 };
  bot.blockAt = (p) => ({ name: p.y < 64 ? 'dirt' : 'air', position: p, boundingBox: p.y < 64 ? 'block' : 'empty' });
  ctx.shelter = {};
  return { bot, ctx };
}

check('unarmed, at night, shot at from range: dig in rather than box it', () => {
  const { bot, ctx } = nightOnOpenGround(...Object.values(scene({ mobs: [mob('skeleton', 10)], hurtMsAgo: 300 })));
  assert.strictEqual(defend.shouldRun(bot, ctx), false);
});

check('...but not with something close enough to follow us down', () => {
  const { bot, ctx } = nightOnOpenGround(...Object.values(scene({ mobs: [mob('zombie', 2)], hurtMsAgo: 300 })));
  assert.strictEqual(defend.shouldRun(bot, ctx), true);
});

check('...and not in daylight', () => {
  const { bot, ctx } = nightOnOpenGround(...Object.values(scene({ mobs: [mob('skeleton', 10)], hurtMsAgo: 300 })));
  bot.time = { timeOfDay: 3000 };
  assert.strictEqual(defend.shouldRun(bot, ctx), true);
});

// 09-25 17:34: an archer with no route to it, and the bot stood in its line
// of fire eating until it died, 161 cobblestone in the bag.
async function wallTest() {
  const { wallOff } = require('../src/behaviors/threat');
  const { Task } = require('../src/task');
  const placed = [];
  const bot = {
    entity: { position: new Vec3(0.5, 64, 0.5) },
    inventory: { items: () => [{ name: 'cobblestone', count: 64, type: 1 }], slots: [] },
    heldItem: null,
    async equip(item) { this.heldItem = item; },
    blockAt(p) {
      const solid = p.y < 64 || placed.some((q) => q.equals(p));
      return { name: solid ? 'stone' : 'air', boundingBox: solid ? 'block' : 'empty', position: p };
    },
    async placeBlock(ref, face) { placed.push(ref.position.plus(face)); },
  };
  const archer = { name: 'skeleton', position: new Vec3(-8, 64, 1) };
  await wallOff(bot, archer, new Task('test'));
  return placed.map((p) => `${p.x},${p.y},${p.z}`);
}

const wallDone = wallTest().then((cells) => {
  check('an unreachable archer gets a two-high wall on its side', () => {
    assert.deepStrictEqual(cells, ['-1,64,0', '-1,65,0']);
  });
});

// 09-25 18:03: two deaths to one skeleton — at 13 health with a stone sword,
// then bare-handed after the respawn.
const { shouldHideFromArcher } = require('../src/behaviors/threat');
function armed(items, health) {
  return {
    health,
    inventory: { items: () => items.map((name, i) => ({ name, count: 1, type: 700 + i })), slots: [] },
    registry: { itemsByName: {} },
  };
}

check('bare hands against an archer: hide', () => {
  assert.strictEqual(shouldHideFromArcher(armed([], 20)), true);
});

check('a sword and full health: take it on', () => {
  assert.strictEqual(shouldHideFromArcher(armed(['stone_sword'], 20)), false);
});

check('a sword but already hurt, no shield: hide', () => {
  assert.strictEqual(shouldHideFromArcher(armed(['stone_sword'], 13)), true);
});

check('hurt, but holding a shield: the shield is the cover', () => {
  assert.strictEqual(shouldHideFromArcher(armed(['stone_sword', 'shield'], 13)), false);
});

console.log('\nretreat health scales with how many are in the fight');

const { bailHealth, LOW_HEALTH_BAIL, BAIL_HEALTH_CAP } = require('../src/behaviors/threat');

check('one zombie: the old bar', () => {
  const { bot } = scene({ mobs: [mob('zombie', 3)] });
  assert.strictEqual(bailHealth(bot), LOW_HEALTH_BAIL);
});

check('three zombies: leave with more in hand', () => {
  const { bot } = scene({ mobs: [mob('zombie', 3, 1), mob('zombie', 4, 2), mob('husk', 5, 3)] });
  assert.strictEqual(bailHealth(bot), LOW_HEALTH_BAIL + 4);
});

check('a crowd is capped, so the bot still fights for its life', () => {
  const mobs = [1, 2, 3, 4, 5, 6, 7].map((id) => mob('zombie', 2 + id * 0.5, id));
  const { bot } = scene({ mobs });
  assert.strictEqual(bailHealth(bot), BAIL_HEALTH_CAP);
});

check('archers and creepers do not raise it — running does not help against them', () => {
  const { bot } = scene({ mobs: [mob('zombie', 3, 1), mob('skeleton', 5, 2), mob('creeper', 4, 3)] });
  assert.strictEqual(bailHealth(bot), LOW_HEALTH_BAIL);
});

check('mobs out of reach do not count', () => {
  const { bot } = scene({ mobs: [mob('zombie', 3, 1), mob('zombie', 15, 2)] });
  assert.strictEqual(bailHealth(bot), LOW_HEALTH_BAIL);
});

wallDone.then(() => console.log(`\n${passed} checks passed`));
