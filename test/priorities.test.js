/**
 * The order the bot does things in.
 *
 * Every behavior carries a comment explaining where it sits relative to its
 * neighbours — "above threat, because the whole point is to NOT take the
 * fight", "below unstick, because a bot that cannot move cannot place a bed
 * either". Those sentences are the design. Nothing enforced them.
 *
 * So when `shelter` was raised from 89 to 91 to stop combat interrupting a
 * half-dug hole, it silently overtook `bed` at 90 — and `bed`'s comment went
 * on claiming it sat "above shelter" while being below it. Sleeping skips the
 * whole night and resets the phantom clock; burrowing waits it out. The bot
 * had been quietly choosing the worse one, and nothing failed.
 *
 * These checks are the stated relationships, written down where they break
 * the build instead of where they are merely described.
 *
 * Run with: node test/priorities.test.js
 */

const assert = require('assert');
const { recordRun, OVERRUN_COOLDOWN_MS } = require('../src/director');
const { escapeHazard, escapeDrowning, leaveWater } = require('../src/behaviors/survive');
const { unstick } = require('../src/behaviors/unstick');
const { bed } = require('../src/behaviors/bed');
const { shelter } = require('../src/behaviors/shelter');
const { threat, defend } = require('../src/behaviors/threat');
const { loot } = require('../src/behaviors/loot');
const { collect } = require('../src/behaviors/collect');
const { tidy } = require('../src/behaviors/tidy');
const { gear } = require('../src/behaviors/gear');
const { smelt, fetchCooked } = require('../src/behaviors/smelt');
const {
  hunt, huntUrgent, forage, forageTopUp,
} = require('../src/behaviors/hunt');
const {
  mine, gatherStone, goDeep, stripMine, resupply, valuables,
} = require('../src/behaviors/mine');
const { wood, woodUrgent, idle } = require('../src/behaviors/wood');
const { explore } = require('../src/behaviors/explore');

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

/** `a` must outrank `b`, and the reason is part of the assertion. */
function outranks(a, b, why) {
  assert.ok(
    a.priority > b.priority,
    `${a.name} (${a.priority}) must outrank ${b.name} (${b.priority}) — ${why}`,
  );
}

console.log('staying alive');

check('lava and suffocation come before everything', () => {
  outranks(escapeHazard, escapeDrowning, 'you can hold your breath, you cannot stand in lava');
  outranks(escapeHazard, unstick, 'burning while trapped is still burning');
});

check('drowning outranks fighting', () => {
  outranks(escapeDrowning, threat, 'drowning while fighting is still drowning');
  outranks(escapeDrowning, defend, 'and it outranks fighting back, too');
});

// The relationship that cost a death. `shelter` and `bed` outrank `threat` on
// the reasoning that a night fight is better avoided than taken — which is
// right about a mob across the clearing and wrong about the one already hitting
// you. Both are also in the director's LONG_RUNNING set, so nothing below them
// can ever cut them short. With Jev pushing `focus: shelter` on top, `threat`
// at 88 could not get the wheel back, and the bot stood in full iron armour
// being eaten by a zombie.
check('fighting back outranks going to bed', () => {
  outranks(defend, shelter, 'it was killed in full iron while sheltering was running');
  outranks(defend, bed, 'a bed you are being hit in is not a plan');
  outranks(defend, threat, 'being in a fight is more urgent than starting one');
});

check('being unable to move outranks every plan that needs movement', () => {
  outranks(unstick, bed, 'a bot that cannot move cannot place a bed');
  outranks(unstick, shelter, 'a bot that cannot move cannot dig in');
  outranks(unstick, threat, 'it kept engaging a creeper it had no route to');
  outranks(defend, unstick, 'hit back before rearranging the terrain');
});

// The relationship that broke. A bed skips the night outright and resets the
// phantom clock; a hole waits it out.
check('sleeping beats burrowing', () => {
  outranks(bed, shelter, 'a bed skips the night, a hole only survives it');
});

check('burrowing beats taking the fight', () => {
  outranks(shelter, threat, 'the whole point of sheltering is not to fight');
});

// Being wet with a full air gauge is a fight, not a navigation problem —
// drowned swim faster than we do, so swimming away is not on the table.
check('fighting beats swimming for shore', () => {
  outranks(threat, leaveWater, 'you cannot out-swim a drowned');
});

console.log('\ngetting anywhere');

check('recovering a death pile outranks routine work', () => {
  outranks(loot, collect, 'a whole inventory beats one loose drop');
  outranks(loot, gear, 'the tools are IN the pile');
});

check('food and wood outrank building things', () => {
  outranks(woodUrgent, forage, 'foraging without the means to cook produces meat it will not eat');
  outranks(forage, gear, 'tools are useless to a corpse');
  outranks(huntUrgent, gear, 'so is a sword');
});

// The 09-25 death: full hunger, two steaks, nine iron — and six minutes of
// chasing a cow at priority 46 while smelt and gear never got the wheel.
check('topping up the larder waits behind turning iron into tools', () => {
  outranks(smelt, forageTopUp, 'nine iron sat unsmelted while the bot went looking for a sixth steak');
  outranks(gear, forageTopUp, 'a pickaxe first, then the trip it is for');
  outranks(forage, forageTopUp, 'an empty larder is the emergency; a thin one is not');
  // 09-25: three cooked chickens left in the furnace while the bot chased live ones.
  outranks(fetchCooked, forage, 'food already cooked beats food still walking around');
  outranks(fetchCooked, huntUrgent, 'and beats killing more of it');
  outranks(fetchCooked, valuables, 'the ore will still be there');
});

check('but it still beats the digging it is stocking up for', () => {
  outranks(forageTopUp, gatherStone, 'the descent refuses to start without the food');
  outranks(forageTopUp, goDeep, 'the descent refuses to start without the food');
});

check('crafting outranks gathering', () => {
  outranks(gear, gatherStone, 'spend what you have before fetching more');
  outranks(smelt, mine, 'cook the ore you are carrying first');
});

check('known ore beats digging blind, which beats wandering', () => {
  outranks(mine, goDeep, 'ore in reach beats a speculative trip downward');
  outranks(goDeep, stripMine, 'get to the right depth before tunnelling at the wrong one');
  outranks(mine, stripMine, 'ore we can see always beats a speculative tunnel');
  outranks(stripMine, wood, 'at depth, digging is the job');
  outranks(wood, explore, 'chopping is work; wandering is the fallback');
  outranks(explore, idle, 'covering ground beats standing still');
});

check('coming back up for supplies outranks crafting at depth', () => {
  outranks(resupply, gear, 'there is nothing to craft with down here');
  outranks(resupply, smelt, 'and nothing to smelt it into');
});

console.log('\nnothing shares a rung by accident');

check('the survival behaviors are all distinct', () => {
  const survival = [escapeHazard, escapeDrowning, defend, unstick, bed, shelter, threat, leaveWater];
  const seen = new Map();
  for (const behavior of survival) {
    const clash = seen.get(behavior.priority);
    assert.ok(
      !clash,
      `${behavior.name} and ${clash} share priority ${behavior.priority}; `
      + 'neither can preempt the other, so which wins is whichever the sort happened to put first',
    );
    seen.set(behavior.priority, behavior.name);
  }
});

// The director's supervisor only considers behaviors at or above this floor,
// or ones that opt in with canInterrupt. Anything meant to interrupt a dig
// has to clear it.
const INTERRUPT_FLOOR = 50;

check('everything that must interrupt a dig can', () => {
  for (const behavior of [escapeHazard, escapeDrowning, defend, unstick, bed, shelter, threat, loot]) {
    assert.ok(
      behavior.priority >= INTERRUPT_FLOOR || behavior.canInterrupt,
      `${behavior.name} cannot preempt anything`,
    );
  }
});

// Live on 09-24 the bot walked past a diamond for eight minutes: `mine` at 25
// could not interrupt the explore leg, the smelt or the tidy in front of it.
check('the goal ore interrupts routine work, never survival or a despawning drop', () => {
  for (const routine of [gear, smelt, tidy, gatherStone, mine, goDeep, stripMine, explore]) {
    outranks(valuables, routine, 'a diamond in view is what the run is for');
  }
  assert.ok(valuables.canInterrupt, 'below the interrupt floor it needs canInterrupt to preempt anything');
  outranks(collect, valuables, 'a drop despawns; the ore will still be there');
  outranks(huntUrgent, valuables, 'food first');
  assert.ok(valuables.priority < INTERRUPT_FLOOR, 'never above staying alive');
});

// Two lists name behaviors as strings, and both had drifted: each still listed
// `light`, which no longer exists, and neither knew about `valuables` — so a
// long dig by it would not have counted as progress.
check('every behavior named in a list by string is a real behavior', () => {
  const { PRODUCTIVE_WHILE_STATIONARY } = require('../src/director');
  const { STATIONARY_BEHAVIORS } = require('../src/behaviors/unstick');
  const real = new Set([
    escapeHazard, escapeDrowning, defend, unstick, bed, shelter, threat, leaveWater,
    loot, fetchCooked, woodUrgent, forage, forageTopUp, collect, resupply, huntUrgent, valuables, gear, smelt,
    tidy, gatherStone, mine, goDeep, stripMine, hunt, wood, explore, idle,
  ].map((b) => b.name));
  for (const name of [...PRODUCTIVE_WHILE_STATIONARY, ...STATIONARY_BEHAVIORS]) {
    assert.ok(real.has(name), `"${name}" is not a behavior`);
  }
  assert.ok(PRODUCTIVE_WHILE_STATIONARY.has('valuables'), 'digging ore is progress, whoever does it');
});

check('and the routine work deliberately cannot', () => {
  for (const behavior of [mine, stripMine, gatherStone, wood, explore, idle, tidy, hunt]) {
    assert.ok(
      behavior.priority < INTERRUPT_FLOOR,
      `${behavior.name} would cancel an in-progress dig`,
    );
  }
});

console.log('\nwhat a behavior outcome costs it');

const freshCtx = () => ({ backoff: new Map(), commitment: null, stuck: {} });
const someBot = { entity: null };

check('a behavior cut off by the deadlock breaker is benched', () => {
  const ctx = freshCtx();
  ctx.commitment = { name: 'gear', at: Date.now() };
  // Exactly what the loop reports for a cut-off: an abort, so "interrupted".
  recordRun(ctx, someBot, 'gear', true, true, true);
  const bench = ctx.backoff.get('gear');
  assert.ok(bench, 'a wedged behavior was left eligible for the very next pick');
  assert.ok(bench.until - Date.now() > OVERRUN_COOLDOWN_MS - 1000);
  assert.strictEqual(ctx.commitment, null, 'it kept its commitment bonus as well');
});

check('an ordinary preemption still costs nothing', () => {
  const ctx = freshCtx();
  recordRun(ctx, someBot, 'gear', true, true, false);
  assert.strictEqual(ctx.backoff.has('gear'), false);
});

check('the fallback is never benched, even for wedging', () => {
  const ctx = freshCtx();
  recordRun(ctx, someBot, 'idle', true, true, true);
  assert.strictEqual(ctx.backoff.has('idle'), false, 'benching idle leaves the bot with nothing to run');
});

// A bed only earns its priority if it can actually be used — and on a LAN
// world the night only skips when every player sleeps.
console.log('\nsleeping is worth its priority only when it works');

const { nightIsNotSkipping, NIGHT_SKIP_WAIT_MS } = require('../src/behaviors/bed');

const atTime = (timeOfDay) => ({ time: { timeOfDay, day: 3 } });

check('a night that has not skipped after the wait is not going to', () => {
  const sleptAt = 1000;
  assert.strictEqual(nightIsNotSkipping(atTime(15000), sleptAt, sleptAt + NIGHT_SKIP_WAIT_MS + 1), true);
});

check('...but give the skip its five seconds first', () => {
  const sleptAt = 1000;
  assert.strictEqual(nightIsNotSkipping(atTime(15000), sleptAt, sleptAt + 3000), false);
});

check('once morning has come there is nothing to give up on', () => {
  const sleptAt = 1000;
  assert.strictEqual(nightIsNotSkipping(atTime(100), sleptAt, sleptAt + 20000), false);
});

// Planks for the bed can come from any log. Only oak counted, so a bot in a
// spruce or birch forest never considered a bed at all.
check('a bed can be made from any wood, not only oak', () => {
  const items = [
    { name: 'white_wool', count: 3 }, { name: 'spruce_log', count: 4 },
  ];
  const bot = {
    health: 20,
    isSleeping: false,
    time: { timeOfDay: 15000, day: 1 },
    entities: {},
    entity: { position: { x: 0, y: 64, z: 0 } },
    inventory: { items: () => items },
    // No placed bed nearby: findPlacedBed's search falls back to this.
    findBlocks: () => [],
    registry: {
      itemsByName: { white_wool: {}, oak_planks: {}, spruce_planks: {} },
      blocksByName: { white_bed: { id: 1 } },
    },
  };
  assert.strictEqual(bed.shouldRun(bot, { bed: { until: 0 } }), true);
});

console.log('\nfood already cooked is fetched when the larder is short');

function cookedWaiting({ items = [], food = 12, readyInMs = -1000, at = [10, 64, 0], expecting = 'cooked_chicken' } = {}) {
  const { Vec3 } = require('vec3');
  const bot = {
    food,
    health: 20,
    entity: { position: new Vec3(0, 64, 0) },
    inventory: { items: () => items, slots: [] },
    registry: { itemsByName: {} },
  };
  const ctx = {
    smelt: {
      pending: {
        at: new Vec3(...at), readyAt: Date.now() + readyInMs, expecting, count: 3,
      },
    },
  };
  return { bot, ctx };
}

check('hungry, empty larder, chickens done: go and get them', () => {
  const { bot, ctx } = cookedWaiting();
  assert.strictEqual(fetchCooked.shouldRun(bot, ctx), true);
  assert.strictEqual(fetchCooked.canInterrupt(bot, ctx), true);
});

check('not before they are ready', () => {
  const { bot, ctx } = cookedWaiting({ readyInMs: 20000 });
  assert.strictEqual(fetchCooked.shouldRun(bot, ctx), false);
});

check('not iron — that is ordinary smelting business', () => {
  const { bot, ctx } = cookedWaiting({ expecting: 'iron_ingot' });
  assert.strictEqual(fetchCooked.shouldRun(bot, ctx), false);
});

check('not a furnace at the far end of the map', () => {
  const { bot, ctx } = cookedWaiting({ at: [500, 64, 0] });
  assert.strictEqual(fetchCooked.shouldRun(bot, ctx), false);
});

check('not with a full larder', () => {
  const steaks = [{ name: 'cooked_beef', count: 12, type: 1 }];
  const { bot, ctx } = cookedWaiting({ items: steaks, food: 20 });
  assert.strictEqual(fetchCooked.shouldRun(bot, ctx), false);
});

// The night workshop only smelts when ore is next in line — an iron pickaxe
// waits on the ingots, a batch of mutton does not.
console.log('\nwhat the night workshop will smelt');

const { oreIsNext } = require('../src/behaviors/smelt');
const bagOf = (...items) => ({
  inventory: { items: () => items.map(([name, count], i) => ({ name, count, type: 900 + i })), slots: [] },
  registry: { itemsByName: {} },
});

check('a full batch of raw iron is next', () => {
  assert.strictEqual(oreIsNext(bagOf(['raw_iron', 8], ['cooked_beef', 4])), true);
});

check('raw meat with nothing cooked goes first, so ore is not next', () => {
  assert.strictEqual(oreIsNext(bagOf(['raw_iron', 8], ['beef', 3])), false);
});

check('no ore, nothing to smelt in the shelter', () => {
  assert.strictEqual(oreIsNext(bagOf(['cooked_beef', 4])), false);
});

// The user's rule: a stone weapon before any hunting. A cow standing right
// next to the bot is the case that tempts every hunt behavior at once.
console.log('\nno hunting before a stone weapon');

const { mayHunt, CANNOT_SPRINT_FOOD } = require('../src/behaviors/hunt');
const Vec3Hunt = require('vec3');

function hunter(weapon, food = 20, { cow = true } = {}) {
  const tools = Array.isArray(weapon) ? weapon : (weapon ? [weapon] : []);
  const items = tools.map((name, i) => ({ name, count: 1, type: 1 + i }));
  const me = { position: new Vec3Hunt(0, 64, 0), isInWater: false };
  const entities = { 1: me };
  if (cow) entities[2] = { id: 2, name: 'cow', isValid: true, position: new Vec3Hunt(3, 64, 0) };
  return {
    entity: me,
    entities,
    food,
    time: { timeOfDay: 1000 },
    blockAt: () => ({ name: 'air', boundingBox: 'empty' }),
    inventory: { items: () => items, slots: [] },
    registry: { itemsByName: {} },
  };
}

// Each behavior in the state that makes it want to run — so the weapon is the
// only thing that can be saying no.
const HUNGRY = 12;
const STONE_KIT = ['stone_pickaxe', 'stone_sword', 'stone_axe'];
const huntCases = [
  [hunt, (w) => hunter(w === 'stone_sword' ? STONE_KIT : w)],
  [huntUrgent, (w) => hunter(w, HUNGRY)],
  [forage, (w) => hunter(w, HUNGRY, { cow: false })],
];

check('each hunt behavior wants to run when armed', () => {
  for (const [b, make] of huntCases) {
    assert.strictEqual(b.shouldRun(make('stone_sword'), {}), true, `${b.name} did not run armed`);
  }
});

check('bare hands: none of them run, even with a cow in reach', () => {
  assert.strictEqual(mayHunt(hunter(null)), false);
  for (const [b, make] of huntCases) {
    assert.strictEqual(b.shouldRun(make(null), {}), false, `${b.name} would hunt unarmed`);
  }
});

check('a wooden or golden sword is not enough', () => {
  assert.strictEqual(mayHunt(hunter('wooden_sword')), false);
  assert.strictEqual(mayHunt(hunter('golden_sword')), false);
});

check('a stone sword or axe, or anything better, is', () => {
  for (const w of ['stone_sword', 'stone_axe', 'iron_sword', 'diamond_axe']) {
    assert.strictEqual(mayHunt(hunter(w)), true, w);
  }
});

check('stocking up waits for the whole stone kit, not just the sword', () => {
  assert.strictEqual(hunt.shouldRun(hunter('stone_sword'), {}), false, 'sword alone: no larder run yet');
  assert.strictEqual(hunt.shouldRun(hunter(STONE_KIT), {}), true);
  assert.strictEqual(huntUrgent.shouldRun(hunter('stone_sword', HUNGRY), {}), true, 'hunger does not wait for the axe');
});

check('once it can no longer sprint, starving outranks the rule', () => {
  assert.strictEqual(mayHunt(hunter(null, CANNOT_SPRINT_FOOD)), true);
  assert.strictEqual(mayHunt(hunter(null, CANNOT_SPRINT_FOOD + 1)), false);
});

console.log(`\n${passed} checks passed`);
