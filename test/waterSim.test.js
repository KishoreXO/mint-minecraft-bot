/**
 * Water, on real physics.
 *
 * Every scenario here runs prismarine-physics' own simulatePlayer through
 * test/simbot.js, so what passes here is what the bot's body will actually do.
 * The first section pins the physics facts src/water.js is designed around;
 * if a dependency upgrade changes any of them, this fails before the bot
 * drowns over it.
 *
 * Run with: node test/waterSim.test.js
 */

const assert = require('assert');
const { createSimBot, runUntil, drive } = require('./simbot');

// The behaviors under test write notes; never into the live bot's file.
require('../src/memory').setPersistence(false);

let passed = 0;
const pending = [];
function check(label, fn) {
  pending.push(async () => {
    try {
      await fn();
      passed++;
      console.log(`  ok  ${label}`);
    } catch (err) {
      console.error(`  FAIL ${label}: ${err.stack || err.message}`);
      process.exitCode = 1;
    }
  });
}
function section(title) {
  pending.push(async () => console.log(`\n${title}`));
}

// Facing +x: mineflayer's forward is (-sin yaw, -cos yaw).
const EAST = -Math.PI / 2;

/** A lake whose top water block is y=62, floor at 54, and a bank east of x=4. */
function lake(bankTop) {
  return (x, y) => {
    if (y <= 54) return 'stone';
    if (x >= 4) return y < bankTop ? 'stone' : 'air';
    if (y <= 62) return 'water';
    return 'air';
  };
}

section('the physics the water code is built on');

check('a bank one block above the water is climbable (forward + jump)', async () => {
  const bot = createSimBot(lake(63), { pos: [2.5, 62, 0.5], yaw: EAST });
  bot.setControlState('forward', true);
  bot.setControlState('jump', true);
  const t = await runUntil(bot, () => bot.entity.onGround && !bot.entity.isInWater && bot.entity.position.y >= 63, 200);
  assert.ok(t >= 0, `never climbed out; feet at ${bot.entity.position.y.toFixed(2)}`);
});

check('a bank two blocks above the water is not, however long it tries', async () => {
  const bot = createSimBot(lake(64), { pos: [2.5, 62, 0.5], yaw: EAST });
  bot.setControlState('forward', true);
  bot.setControlState('jump', true);
  let peak = -Infinity;
  await runUntil(bot, () => {
    peak = Math.max(peak, bot.entity.position.y);
    return false;
  }, 300);
  assert.ok(peak < 64, `reached feet y=${peak.toFixed(2)}`);
  assert.ok(peak > 63.3 && peak < 63.7, `the boost should peak near Y+1.59, got ${(peak - 62).toFixed(2)}`);
});

check('floating with jump held, the feet never clear the top water block (no pillaring in open water)', async () => {
  const bot = createSimBot(lake(40), { pos: [0.5, 60, 0.5] });
  bot.setControlState('jump', true);
  let peak = -Infinity;
  await runUntil(bot, () => {
    peak = Math.max(peak, bot.entity.position.y);
    return false;
  }, 300);
  assert.ok(peak < 63, `feet reached ${peak.toFixed(2)}, above the water block`);
  assert.ok(peak > 62.5, `should float high, peaked at ${peak.toFixed(2)}`);
});

check('with no input the bot sinks, slowly', async () => {
  const bot = createSimBot(lake(40), { pos: [0.5, 60, 0.5] });
  await runUntil(bot, () => false, 60);
  const vy = bot.entity.velocity.y;
  assert.ok(vy < -0.015 && vy > -0.04, `terminal sink ${vy.toFixed(3)} b/tick`);
});

check('sneak does not sink any faster — there is no dive key', async () => {
  const still = createSimBot(lake(40), { pos: [0.5, 60, 0.5] });
  const sneak = createSimBot(lake(40), { pos: [0.5, 60, 0.5] });
  sneak.setControlState('sneak', true);
  await runUntil(still, () => false, 40);
  await runUntil(sneak, () => false, 40);
  assert.ok(Math.abs(still.entity.position.y - sneak.entity.position.y) < 0.01);
});

check('underwater, only yaw steers: swimming forward is ~2 b/s whatever the pitch or sprint', async () => {
  const run = async (pitch, sprint) => {
    const bot = createSimBot(lake(40), { pos: [-10.5, 58, 0.5], yaw: EAST });
    bot.entity.pitch = pitch;
    bot.setControlState('forward', true);
    bot.setControlState('sprint', sprint);
    await runUntil(bot, () => false, 60);
    return bot.entity.position.x - -10.5;
  };
  const level = await run(0, false);
  const down = await run(-1.2, true);
  assert.ok(level > 4 && level < 7, `60 ticks covered ${level.toFixed(2)} blocks`);
  assert.ok(Math.abs(level - down) < 0.05, 'pitch or sprint changed the swim');
});

check('the air gauge drains with the eye under and refills at the surface', async () => {
  const bot = createSimBot(lake(40), { pos: [0.5, 57, 0.5], air: 300 });
  await runUntil(bot, () => false, 30);
  assert.ok(bot.oxygenLevel < 20);
  bot.entity.position.y = 62.3;
  bot.setControlState('jump', true);
  await runUntil(bot, () => bot.oxygenLevel >= 20, 100);
  assert.strictEqual(bot.oxygenLevel, 20);
});

section('getting out of the water');

const water = require('../src/water');
const { Task } = require('../src/task');

check('a lake: swims to the low bank and climbs out', async () => {
  const bot = createSimBot(lake(63), { pos: [-5.5, 62, 0.5] });
  const done = water.withPilot(bot, 'test', (pilot) => water.swimAshore(bot, pilot, new Task('t')));
  const out = await drive(bot, done, 600);
  assert.ok(out.settled, 'never finished');
  assert.strictEqual(out.value.result, 'ashore');
  assert.ok(bot.entity.onGround && !bot.entity.isInWater, 'not on dry land');
  assert.ok(bot.entity.position.x >= 4, `at x=${bot.entity.position.x.toFixed(2)}`);
});

// Every bank but one is two blocks high. The old findShore took the nearest
// of any height up to three and paddled at it forever.
function pool() {
  return (x, y, z) => {
    if (y <= 54) return 'stone';
    const inside = x >= -8 && x <= 8 && z >= -3 && z <= 3;
    if (!inside) {
      if (x === 9 && z >= -3 && z <= 3) return y <= 62 ? 'stone' : 'air'; // the one low bank, far east
      return y <= 63 ? 'stone' : 'air';
    }
    return y <= 62 ? 'water' : 'air';
  };
}

check('only a climbable bank counts as a way out, however much nearer the others are', async () => {
  const bot = createSimBot(pool(), { pos: [-6.5, 62, 0.5] });
  const exit = water.findExit(bot);
  assert.ok(exit, 'no exit found');
  assert.strictEqual(exit.stand.x, 9);
  const out = await drive(bot, water.withPilot(bot, 'test', (p) => water.swimAshore(bot, p, new Task('t'), { exit })), 900);
  assert.strictEqual(out.value.result, 'ashore');
  assert.ok(bot.entity.position.x >= 9);
});

check('a sheer-walled pool has no exit, and says so rather than guessing', async () => {
  const bot = createSimBot((x, y, z) => {
    if (y <= 54) return 'stone';
    if (Math.abs(x) <= 2 && Math.abs(z) <= 2) return y <= 62 ? 'water' : 'air';
    return y <= 70 ? 'stone' : 'air';
  }, { pos: [0.5, 62, 0.5] });
  assert.strictEqual(water.findExit(bot), null);
});

section('finding air');

// 09-26 13:45, cell for cell: feet at y=61, the pocket one across and one up,
// rock over the head. The old code pressed up into the ceiling and drowned.
function pocketAcross() {
  return (x, y, z) => {
    if (z !== 0) return 'stone';
    if (x === 0 && (y === 61 || y === 62)) return 'water';
    if (x === 1 && (y === 61 || y === 62)) return 'water';
    if (x === 1 && y === 63) return 'air';
    return 'stone';
  };
}

check('the 13:45 drowning: a pocket one across and one up is reached, with six bubbles left', async () => {
  const bot = createSimBot(pocketAcross(), { pos: [0.5, 61, 0.5], air: 90 });
  const route = water.planRoute(bot, { type: 'breath' });
  assert.ok(route, 'no route to the pocket');
  const run = water.withPilot(bot, 'test', (p) => water.swimRoute(bot, p, { type: 'breath' }, new Task('t')));
  await drive(bot, run, 300);
  assert.ok(!water.eyeInWater(bot), `still under at ${bot.entity.position}`);
  assert.strictEqual(bot.drowningDamage, 0);
});

check('capped straight up: it notices the lid', async () => {
  const bot = createSimBot(pocketAcross(), { pos: [0.5, 61, 0.5] });
  assert.strictEqual(water.cappedAbove(bot), true);
  const open = createSimBot(lake(40), { pos: [0.5, 58, 0.5] });
  assert.strictEqual(water.cappedAbove(open), false);
});

// A flooded shaft with a lid, and the way out a tunnel to an open column.
function shaftAndTunnel() {
  return (x, y, z) => {
    if (z !== 0) return 'stone';
    if (x === 0 && y >= 50 && y <= 60) return 'water';
    if (y >= 55 && y <= 56 && x >= 0 && x <= 6) return 'water';
    if (x === 6 && y >= 55 && y <= 62) return 'water';
    if (x === 6 && y >= 63) return 'air';
    return 'stone';
  };
}

check('a capped shaft: it swims down and along the tunnel to the open column, not up into the lid', async () => {
  const bot = createSimBot(shaftAndTunnel(), { pos: [0.5, 59, 0.5], air: 300 });
  const run = water.withPilot(bot, 'test', (p) => water.swimRoute(bot, p, { type: 'breath' }, new Task('t')));
  const out = await drive(bot, run, 900);
  assert.strictEqual(out.value, 'arrived');
  assert.ok(!water.eyeInWater(bot), `still under at ${bot.entity.position}`);
  assert.strictEqual(bot.drowningDamage, 0);
});

section('drowning, the behavior');

check('under a lid it does not wait for the air reserve', async () => {
  const { escapeDrowning } = require('../src/behaviors/survive');
  const bot = createSimBot(pocketAcross(), { pos: [0.5, 61, 0.5], air: 300 });
  await runUntil(bot, () => false, 2);
  assert.strictEqual(escapeDrowning.shouldRun(bot, waterCtx()), true);
  const open = createSimBot(lake(40), { pos: [0.5, 58, 0.5], air: 300 });
  await runUntil(open, () => false, 2);
  assert.strictEqual(escapeDrowning.shouldRun(open, waterCtx()), false, 'open water at full air is not drowning');
});

check('the 13:45 drowning, through the behavior: breathing again with no damage', async () => {
  const { escapeDrowning } = require('../src/behaviors/survive');
  const bot = createSimBot(pocketAcross(), { pos: [0.5, 61, 0.5], air: 90 });
  water.installWater(bot);
  const out = await drive(bot, escapeDrowning.run(bot, waterCtx(), new Task('escapeDrowning')), 600);
  assert.strictEqual(out.value, true);
  assert.strictEqual(bot.drowningDamage, 0);
});

// Sealed in: no route anywhere, a dirt lid, air above it. Standing on the
// floor underwater, dirt by hand is ~75 ticks: a dig that fits.
function sealedUnderDirt() {
  return (x, y, z) => {
    if (x === 0 && z === 0) {
      if (y === 60 || y === 61) return 'water';
      if (y === 62) return 'dirt';
      if (y >= 63) return 'air';
    }
    return 'stone';
  };
}

check('sealed under a thin lid: digs up through it, because the dig fits the air', async () => {
  const { escapeDrowning } = require('../src/behaviors/survive');
  const bot = createSimBot(sealedUnderDirt(), { pos: [0.5, 60, 0.5], air: 300 });
  water.installWater(bot);
  const out = await drive(bot, escapeDrowning.run(bot, waterCtx(), new Task('escapeDrowning')), 1500);
  assert.strictEqual(out.value, true, `still under at ${bot.entity.position}`);
  assert.strictEqual(bot.world.specAt(0, 62, 0), 'air');
  assert.strictEqual(bot.drowningDamage, 0);
});

// 14:32 on 09-26: a flooded pocket off a mine, the air one across and one up
// — and a stone lid straight up that took 14 s to dig while floating. The old
// code dug the lid, with two bubbles left, and drowned.
function floodedPocket() {
  return (x, y, z) => {
    if (z !== 0) return 'stone';
    if (x === 0 && (y === 55 || y === 56)) return 'water';
    if (x === 1 && (y === 55 || y === 56)) return 'water';
    if (x === 1 && y === 57) return 'air'; // the pocket
    if (x === 0 && y === 58) return 'air'; // air above the lid too: a tempting dig
    return 'stone';
  };
}

check('the 14:32 pocket: the slow lid is refused, the swim round is taken', async () => {
  const { escapeDrowning } = require('../src/behaviors/survive');
  const bot = createSimBot(floodedPocket(), { pos: [0.5, 55.4, 0.5], air: 60, items: [['stone_pickaxe', 1]] });
  water.installWater(bot);
  const out = await drive(bot, escapeDrowning.run(bot, waterCtx(), new Task('escapeDrowning')), 900);
  assert.strictEqual(out.value, true);
  assert.strictEqual(bot.world.specAt(0, 57, 0), 'stone', 'it dug the lid anyway');
  assert.strictEqual(bot.drowningDamage, 0);
});

section('the flooded ravine');

// 09-26 13:20–14:45: a ravine three wide, water 58–62, walls to 77, and no
// bank anywhere within forty blocks. Before: an eight-minute leaveWater <->
// unstick loop, a drowning, and 33 re-entries.
function ravine() {
  return (x, y, z) => {
    if (y <= 57) return 'stone';
    if (Math.abs(z) > 30) return y <= 77 ? 'stone' : 'air';
    if (Math.abs(x) <= 1) return y <= 62 ? 'water' : 'air';
    return y <= 77 ? 'stone' : 'air';
  };
}

function waterCtx() {
  return { water: { since: null, from: null }, stuck: {}, currentBehavior: 'leaveWater' };
}

check('with blocks: builds a landing against the wall, pillars up, and steps onto the rim', async () => {
  const { leaveWater } = require('../src/behaviors/survive');
  const bot = createSimBot(ravine(), { pos: [0.5, 62, 0.5], items: [['cobblestone', 20], ['stone_pickaxe', 1]] });
  water.installWater(bot);
  const ctx = waterCtx();
  const task = new Task('leaveWater');
  let out = { settled: false };
  for (let run = 0; run < 3 && !(bot.entity.position.y >= 78 && !bot.entity.isInWater); run++) {
    out = await drive(bot, leaveWater.run(bot, ctx, task), 4000);
  }
  assert.ok(out.settled, 'leaveWater never finished');
  assert.ok(bot.entity.position.y >= 78, `still down at y=${bot.entity.position.y.toFixed(2)}`);
  assert.ok(!bot.entity.isInWater);
  assert.strictEqual(bot.drowningDamage, 0);
});

check('the ravine has no exit — and it knows, rather than paddling at a wall', async () => {
  const bot = createSimBot(ravine(), { pos: [0.5, 62, 0.5] });
  assert.strictEqual(water.findExit(bot), null);
  const landing = water.findLanding(bot);
  assert.ok(landing, 'no landing spot beside a wall');
});

section('who holds jump');

check('floating: the pilot holds jump while the eye is under, and lets go of its own jump on land', async () => {
  const bot = createSimBot(lake(40), { pos: [0.5, 58, 0.5] });
  water.installWater(bot);
  await runUntil(bot, () => false, 5);
  assert.strictEqual(bot.getControlState('jump'), true, 'not floating');
  // Someone else clears everything (the director does, after every behavior)...
  bot.clearControlStates();
  await runUntil(bot, () => false, 2);
  assert.strictEqual(bot.getControlState('jump'), true, 'the float did not re-assert');
  // ...and a behavior that takes the jump for itself keeps it after the water.
  bot.setControlState('jump', true);
  bot.entity.position.set(20.5, 70, 0.5); // teleported out of the lake
  await runUntil(bot, () => false, 3);
  assert.strictEqual(bot.getControlState('jump'), true, 'released a jump it no longer owned');
});

(async () => {
  for (const run of pending) await run();
  console.log(`\n${passed} checks passed`);
})();
