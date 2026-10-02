/**
 * The reflex layer / state machine / pluggable policy addition.
 *
 * Run with: node test/layers.test.js
 */

const assert = require('assert');
const { EventEmitter } = require('events');
const Vec3 = require('vec3');
const { StateMachine } = require('../src/layers/stateMachine');
const { STATES, TRANSITIONS, classify } = require('../src/layers/states');
const { defaultPolicy, observationFor } = require('../src/layers/policy');
const {
  installReflexLayer, nearestHostileWithin, hasGroundBelow, placeableBlock,
} = require('../src/layers/reflex');
const { Task } = require('../src/task');

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

console.log('state machine');

check('starts in the given initial state', () => {
  const m = new StateMachine(STATES, TRANSITIONS, 'idle');
  assert.strictEqual(m.current, 'idle');
});

check('a legal transition runs exit on the old state and enter on the new', () => {
  const calls = [];
  const states = {
    a: { enter: () => calls.push('a-enter'), exit: () => calls.push('a-exit') },
    b: { enter: () => calls.push('b-enter'), exit: () => calls.push('b-exit') },
  };
  const m = new StateMachine(states, { a: new Set(['b']), b: new Set(['a']) }, 'a');
  const ok = m.transition('b', {}, {}, 'test');
  assert.strictEqual(ok, true);
  assert.strictEqual(m.current, 'b');
  assert.deepStrictEqual(calls, ['a-exit', 'b-enter']);
});

check('an illegal transition is refused and the state does not change', () => {
  const states = { a: {}, b: {}, c: {} };
  const m = new StateMachine(states, { a: new Set(['b']) }, 'a');
  const ok = m.transition('c', {}, {}, 'test');
  assert.strictEqual(ok, false);
  assert.strictEqual(m.current, 'a');
});

check('transitioning to the current state is a no-op, not an error', () => {
  const states = { a: {} };
  const m = new StateMachine(states, { a: new Set() }, 'a');
  assert.strictEqual(m.transition('a', {}, {}, 'test'), false);
  assert.strictEqual(m.current, 'a');
});

check('update() runs the active state\'s update and nothing else', () => {
  let ticked = 0;
  const states = { a: { update: () => { ticked++; } }, b: { update: () => { ticked += 100; } } };
  const m = new StateMachine(states, { a: new Set(['b']) }, 'a');
  m.update({}, {});
  m.update({}, {});
  assert.strictEqual(ticked, 2);
});

check('a state update that throws does not take the machine down', () => {
  const states = { a: { update: () => { throw new Error('boom'); } } };
  const m = new StateMachine(states, { a: new Set() }, 'a');
  assert.doesNotThrow(() => m.update({}, {}));
});

console.log('\nthe six real states and their transition table');

check('all six spec\'d states exist', () => {
  for (const name of ['idle', 'gathering', 'mining', 'crafting', 'fighting', 'fleeing']) {
    assert.ok(STATES[name], `${name} should be a registered state`);
  }
});

check('every state can reach fleeing directly — reflexes force this transition', () => {
  for (const name of Object.keys(STATES)) {
    if (name === 'fleeing') continue;
    assert.ok(TRANSITIONS[name].has('fleeing'), `${name} -> fleeing should be legal`);
  }
});

check('every state can reach fighting directly — a mob does not wait its turn', () => {
  for (const name of Object.keys(STATES)) {
    if (name === 'fighting') continue;
    assert.ok(TRANSITIONS[name].has('fighting'), `${name} -> fighting should be legal`);
  }
});

console.log('\nclassifying director behaviors into states');

check('combat behaviors classify as fighting', () => {
  assert.strictEqual(classify('defend'), 'fighting');
  assert.strictEqual(classify('threat'), 'fighting');
});

check('hazard/drowning/water-exit behaviors classify as fleeing', () => {
  assert.strictEqual(classify('escapeHazard'), 'fleeing');
  assert.strictEqual(classify('escapeDrowning'), 'fleeing');
  assert.strictEqual(classify('leaveWater'), 'fleeing');
});

check('resource behaviors classify as gathering', () => {
  for (const name of ['wood', 'hunt', 'forage', 'gatherStone', 'collect', 'loot']) {
    assert.strictEqual(classify(name), 'gathering', name);
  }
});

check('underground behaviors classify as mining', () => {
  for (const name of ['mine', 'goDeep', 'stripMine', 'resupply']) {
    assert.strictEqual(classify(name), 'mining', name);
  }
});

check('crafting behaviors classify as crafting', () => {
  for (const name of ['gear', 'smelt', 'tidy']) {
    assert.strictEqual(classify(name), 'crafting', name);
  }
});

check('an unrecognised or absent behavior falls back to idle, not a crash', () => {
  assert.strictEqual(classify('somethingNewNobodyAddedYet'), 'idle');
  assert.strictEqual(classify(null), 'idle');
  assert.strictEqual(classify(undefined), 'idle');
});

console.log('\nthe default fighting policy');

check('nothing in range — stand down, do not swing at nothing', () => {
  const action = defaultPolicy.act({
    health: 20, maxHealth: 20, hunger: 20, enemy: null, attackCooldownReady: true, hasShield: false, hotbar: [],
  });
  assert.deepStrictEqual(action, {
    move: 'none', strafe: 'none', sprint: false, attack: false, shieldUp: false,
  });
});

check('an enemy beyond the standoff — close the gap, sprinting', () => {
  const action = defaultPolicy.act({
    health: 20,
    maxHealth: 20,
    hunger: 20,
    enemy: {
      distance: 6, angle: 0, velocity: { x: 0, y: 0, z: 0 }, reach: 2.2,
    },
    attackCooldownReady: true,
    hasShield: false,
    hotbar: [],
  });
  assert.strictEqual(action.move, 'forward');
  assert.strictEqual(action.sprint, true);
  assert.strictEqual(action.attack, false);
});

check('an enemy inside strike range with the cooldown up — attack', () => {
  const action = defaultPolicy.act({
    health: 20,
    maxHealth: 20,
    hunger: 20,
    enemy: {
      distance: 2.5, angle: 0, velocity: { x: 0, y: 0, z: 0 }, reach: 2.2,
    },
    attackCooldownReady: true,
    hasShield: false,
    hotbar: [],
  });
  assert.strictEqual(action.attack, true);
  assert.strictEqual(action.move, 'none');
});

check('in strike range but the cooldown is not up yet — do not waste the swing', () => {
  const action = defaultPolicy.act({
    health: 20,
    maxHealth: 20,
    hunger: 20,
    enemy: {
      distance: 2.5, angle: 0, velocity: { x: 0, y: 0, z: 0 }, reach: 2.2,
    },
    attackCooldownReady: false,
    hasShield: false,
    hotbar: [],
  });
  assert.strictEqual(action.attack, false);
});

check('something with a long reach already in range of US, but us not of it — shield up', () => {
  // reach 3.0 puts "their melee" at 3.6; our own strike range is 2.85, so at
  // distance 3.0 they can already hit us and we cannot yet answer.
  const action = defaultPolicy.act({
    health: 20,
    maxHealth: 20,
    hunger: 20,
    enemy: {
      distance: 3.0, angle: 0, velocity: { x: 0, y: 0, z: 0 }, reach: 3.0,
    },
    attackCooldownReady: true,
    hasShield: true,
    hotbar: [],
  });
  assert.strictEqual(action.shieldUp, true);
});

check('no shield in hand — never asked to raise one', () => {
  const action = defaultPolicy.act({
    health: 20,
    maxHealth: 20,
    hunger: 20,
    enemy: {
      distance: 3.0, angle: 0, velocity: { x: 0, y: 0, z: 0 }, reach: 3.0,
    },
    attackCooldownReady: true,
    hasShield: false,
    hotbar: [],
  });
  assert.strictEqual(action.shieldUp, false);
});

check('observationFor() produces plain data — no entity reference leaks into it', () => {
  const bot = {
    health: 14, food: 18, entity: { yaw: 1.2 }, inventory: { slots: [] },
  };
  const target = { name: 'zombie', velocity: { x: 0.1, y: 0, z: -0.2 } };
  const obs = observationFor(bot, target, 4.5);
  assert.strictEqual(obs.enemy.distance, 4.5);
  assert.strictEqual(typeof obs.enemy.reach, 'number');
  assert.deepStrictEqual(obs.enemy.velocity, { x: 0.1, y: 0, z: -0.2 });
  assert.strictEqual(obs.enemy.entity, undefined, 'observation must stay plain data');
});

console.log('\nreflex layer — the pure checks');

function fakeBot(entities, position) {
  return {
    entity: { position },
    entities,
  };
}

check('nearestHostileWithin ignores neutral and food mobs', () => {
  const me = new Vec3(0, 70, 0);
  const bot = fakeBot({
    1: {
      name: 'cow', isValid: true, position: me.offset(1, 0, 0),
    },
    2: {
      name: 'enderman', isValid: true, position: me.offset(1, 0, 0),
    },
  }, me);
  assert.strictEqual(nearestHostileWithin(bot, 3), null);
});

check('nearestHostileWithin finds the closest hostile inside range', () => {
  const me = new Vec3(0, 70, 0);
  const bot = fakeBot({
    1: { name: 'zombie', isValid: true, position: me.offset(2, 0, 0) },
    2: { name: 'skeleton', isValid: true, position: me.offset(1, 0, 0) },
  }, me);
  const found = nearestHostileWithin(bot, 3);
  assert.strictEqual(found.name, 'skeleton');
});

check('nearestHostileWithin respects the range — a hostile just outside does not count', () => {
  const me = new Vec3(0, 70, 0);
  const bot = fakeBot({
    1: { name: 'zombie', isValid: true, position: me.offset(5, 0, 0) },
  }, me);
  assert.strictEqual(nearestHostileWithin(bot, 3), null);
});

function groundBot(overrides) {
  return {
    entity: { position: new Vec3(0, 70, 0) },
    blockAt(pos) {
      const key = `${pos.x},${pos.y},${pos.z}`;
      if (Object.prototype.hasOwnProperty.call(overrides, key)) return overrides[key];
      return { name: 'air', boundingBox: 'empty' };
    },
  };
}

check('hasGroundBelow finds solid ground within the probe depth', () => {
  const bot = groundBot({ '0,60,0': { name: 'stone', boundingBox: 'block' } });
  assert.strictEqual(hasGroundBelow(bot, 24), true);
});

check('hasGroundBelow returns false for a genuine open void', () => {
  const bot = groundBot({});
  assert.strictEqual(hasGroundBelow(bot, 24), false);
});

check('hasGroundBelow treats water as ground — landing in it is free', () => {
  const bot = groundBot({ '0,65,0': { name: 'water', boundingBox: 'empty' } });
  assert.strictEqual(hasGroundBelow(bot, 24), true);
});

check('hasGroundBelow treats an unloaded chunk as not its business', () => {
  const bot = groundBot({ '0,69,0': null });
  assert.strictEqual(hasGroundBelow(bot, 24), true);
});

check('placeableBlock finds planks or common scaffolding, ignores everything else', () => {
  const bot = {
    inventory: {
      items: () => [{ name: 'iron_sword' }, { name: 'oak_planks' }],
    },
  };
  assert.strictEqual(placeableBlock(bot).name, 'oak_planks');
});

check('placeableBlock returns undefined with nothing suitable in the bag', () => {
  const bot = { inventory: { items: () => [{ name: 'iron_sword' }, { name: 'raw_iron' }] } };
  assert.strictEqual(placeableBlock(bot), undefined);
});

// The reflex used to ABORT the running task whenever a trip-wire fired — and
// the running task was, as often as not, the one handling that very thing:
// escapeHazard in lava (every tick), a melee fight inside the three-block
// trip-wire (twice a second), every behavior at all at low health (every
// tick). It now asks the director's own preemption check instead, which says
// no when the owner already has the wheel.
console.log('\nreflex layer — it hurries the director, it never aborts the owner');

/** A bot on a stone floor at y=70 that emits physicsTick on demand. */
function tickBot({ blocks = {}, entities = {}, health = 20 } = {}) {
  const bot = new EventEmitter();
  bot.health = health;
  bot.entity = {
    position: new Vec3(0.5, 70, 0.5), onGround: true, isInWater: false, velocity: new Vec3(0, 0, 0),
  };
  bot.entities = entities;
  bot.inventory = { items: () => [] };
  bot.clearControlStates = () => {};
  bot.blockAt = (pos) => {
    const p = pos.floored();
    const key = `${p.x},${p.y},${p.z}`;
    if (Object.prototype.hasOwnProperty.call(blocks, key)) return blocks[key];
    return p.y < 70
      ? { name: 'stone', boundingBox: 'block', position: p }
      : { name: 'air', boundingBox: 'empty', position: p };
  };
  return bot;
}

function reflexCtx(behavior) {
  const asked = [];
  return {
    asked,
    connected: true,
    currentBehavior: behavior,
    currentTask: new Task(behavior),
    requestPreemptionCheck: (why) => {
      asked.push(why);
      return false;
    },
  };
}

const zombieAt = (dx) => ({
  1: {
    name: 'zombie', type: 'hostile', isValid: true, position: new Vec3(0.5 + dx, 70, 0.5),
  },
});

check('standing in lava asks the director, and escapeHazard is left running', () => {
  const bot = tickBot({ blocks: { '0,70,0': { name: 'lava', boundingBox: 'empty' } } });
  const ctx = reflexCtx('escapeHazard');
  const stop = installReflexLayer(bot, ctx);
  bot.emit('physicsTick');
  bot.emit('physicsTick');
  stop();
  assert.strictEqual(ctx.currentTask.aborted, false, 'the escape must not be restarted every tick');
  assert.deepStrictEqual(ctx.asked, ['reflex:hazard', 'reflex:hazard']);
});

check('a hostile inside the melee trip-wire does not tear down the fight', () => {
  const bot = tickBot({ entities: zombieAt(2) });
  const ctx = reflexCtx('defend');
  const stop = installReflexLayer(bot, ctx);
  bot.emit('physicsTick');
  bot.emit('physicsTick'); // inside the cooldown
  stop();
  assert.strictEqual(ctx.currentTask.aborted, false);
  assert.deepStrictEqual(ctx.asked, ['reflex:hostile-adjacent']);
});

check('low health asks once per cooldown, not on every tick', () => {
  const bot = tickBot({ entities: zombieAt(10), health: 5 });
  const ctx = reflexCtx('forage');
  const stop = installReflexLayer(bot, ctx);
  for (let i = 0; i < 5; i++) bot.emit('physicsTick');
  stop();
  assert.strictEqual(ctx.currentTask.aborted, false);
  assert.deepStrictEqual(ctx.asked, ['reflex:low-health']);
});

check('with no director running, a reflex is a no-op rather than a crash', () => {
  const bot = tickBot({ blocks: { '0,70,0': { name: 'lava', boundingBox: 'empty' } } });
  const ctx = { connected: true, currentTask: new Task('mine'), currentBehavior: 'mine' };
  const stop = installReflexLayer(bot, ctx);
  assert.doesNotThrow(() => bot.emit('physicsTick'));
  stop();
  assert.strictEqual(ctx.currentTask.aborted, false);
});

console.log(`\n${passed} checks passed`);
