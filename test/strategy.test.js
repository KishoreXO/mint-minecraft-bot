/**
 * Letting Jev steer, without letting it drive off a cliff.
 *
 * Everything else the model is asked is a reflex question it usually loses on
 * latency — 0.3 to 3.6 seconds measured, against a deadline of 300ms. "What
 * should the bot work on for the next minute" has no deadline at all, so a
 * slow answer is just as good, and it is the judgement that most needs many
 * factors weighed at once. That makes it the model's best use in the project.
 *
 * But advice is not command. A strategic preference must never outrank being
 * on fire, and a coin-flip answer is worse than the consistent hardcoded
 * ordering it would replace. These pin both limits.
 *
 * Run with: node test/strategy.test.js
 */

const assert = require('assert');
const { effectivePriority } = require('../src/director');

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

const strategy = (focus, confidence = 0.9, ageMs = 0) => ({
  strategy: {
    focus, risk: 'safe', confidence, at: Date.now() - ageMs,
  },
});

const behaviour = (name, priority) => ({ name, priority });

console.log('the model nudges the ordering');

check('a focused behavior outranks its neighbour', () => {
  const ctx = strategy('ore');
  // mine sits at 25, gatherStone at 28 — normally stone wins.
  const mine = effectivePriority(ctx, behaviour('mine', 25));
  const stone = effectivePriority(ctx, behaviour('gatherStone', 28));
  assert.ok(mine > 25, 'focus should lift it');
  assert.ok(mine >= stone - 1, 'and make it competitive with its neighbour');
});

check('behaviors outside the focus are untouched', () => {
  const ctx = strategy('food');
  assert.strictEqual(effectivePriority(ctx, behaviour('gatherStone', 28)), 28);
});

check('every focus maps to at least one behavior', () => {
  for (const focus of ['food', 'wood', 'stone', 'tools', 'descend', 'ore', 'shelter']) {
    const ctx = strategy(focus);
    const lifted = ['hunt', 'wood', 'gatherStone', 'gear', 'goDeep', 'mine', 'shelter']
      .some((name) => effectivePriority(ctx, behaviour(name, 10)) > 10);
    assert.ok(lifted, `focus "${focus}" should lift something`);
  }
});

console.log('\nand is never allowed to drive');

// The safety ordering is not up for negotiation. escapeHazard is 97,
// escapeDrowning 95, unstick 93 — no amount of strategic preference may put
// mining above being in lava.
check('a focus can never outrank the survival behaviors', () => {
  const ctx = strategy('ore');
  const mine = effectivePriority(ctx, behaviour('mine', 25));
  for (const [name, priority] of [['escapeHazard', 97], ['escapeDrowning', 95], ['unstick', 93], ['threat', 88]]) {
    assert.ok(
      effectivePriority(ctx, behaviour(name, priority)) > mine,
      `${name} must still outrank a focused mine`,
    );
  }
});

check('a coin-flip answer is ignored entirely', () => {
  const ctx = strategy('ore', 0.2);
  assert.strictEqual(effectivePriority(ctx, behaviour('mine', 25)), 25);
});

check('a stale answer expires rather than steering forever', () => {
  const ctx = strategy('ore', 0.9, 60000);
  assert.strictEqual(effectivePriority(ctx, behaviour('mine', 25)), 25);
});

check('no strategy at all changes nothing', () => {
  assert.strictEqual(effectivePriority({}, behaviour('mine', 25)), 25);
  assert.strictEqual(effectivePriority({ strategy: null }, behaviour('mine', 25)), 25);
});

check('an unrecognised focus is harmless', () => {
  const ctx = strategy('build_a_castle');
  assert.strictEqual(effectivePriority(ctx, behaviour('mine', 25)), 25);
});

console.log('\ncommitment still works alongside it');

check('doing real work keeps the wheel', () => {
  const ctx = { commitment: { name: 'wood', at: Date.now() } };
  assert.ok(effectivePriority(ctx, behaviour('wood', 10)) > 10);
});

check('focus and commitment stack on the same behavior', () => {
  const ctx = {
    ...strategy('wood'),
    commitment: { name: 'wood', at: Date.now() },
  };
  const both = effectivePriority(ctx, behaviour('wood', 10));
  const focusOnly = effectivePriority(strategy('wood'), behaviour('wood', 10));
  assert.ok(both > focusOnly, 'both bonuses should apply');
});

// The bonuses are for routine work flip-flopping at adjacent priorities. On the
// urgent tier they reordered the safety ordering itself: a committed `defend`
// sat at 100, above escapeHazard's 97, and a "shelter" focus lifted bed to 97.
console.log('\nthe urgent tier is ordered by raw priority');

const { pickBehavior, startDirector, INTERRUPT_PRIORITY_FLOOR } = require('../src/director');
const { Task, sleep } = require('../src/task');

check('no bonus applies at or above the interrupt floor', () => {
  const committed = (name) => ({ commitment: { name, at: Date.now() } });
  assert.strictEqual(effectivePriority(committed('defend'), behaviour('defend', 94)), 94);
  assert.strictEqual(effectivePriority({ ...strategy('shelter'), ...committed('bed') }, behaviour('bed', 92)), 92);
  assert.strictEqual(
    effectivePriority(committed('loot'), behaviour('loot', INTERRUPT_PRIORITY_FLOOR)),
    INTERRUPT_PRIORITY_FLOOR,
  );
});

const wants = (name, priority, extra = {}) => ({
  name, priority, shouldRun: () => true, ...extra,
});

check('a committed behavior never hides a higher raw-priority emergency from preemption', () => {
  // Raw order, the way the director sorts its list.
  const behaviors = [wants('escapeHazard', 97), wants('defend', 94)];
  const ctx = { backoff: new Map(), commitment: { name: 'defend', at: Date.now() }, ...strategy('shelter') };
  assert.strictEqual(pickBehavior({}, ctx, behaviors, { interruptiveOnly: true }).name, 'escapeHazard');
});

check('preemption never even asks behaviors that could not outrank the running one', () => {
  let asked = 0;
  const behaviors = [
    wants('escapeHazard', 97, { shouldRun: () => false, canInterrupt: () => false }),
    wants('gear', 40, { canInterrupt: () => { asked++; return true; } }),
  ];
  const got = pickBehavior({}, { backoff: new Map() }, behaviors, { interruptiveOnly: true, above: 94 });
  assert.strictEqual(got, null);
  assert.strictEqual(asked, 0, 'a fight at 94 cannot be preempted by gear at 40 — do not pay to ask');
});

check('routine work still keeps the wheel when the director picks what to start', () => {
  const behaviors = [wants('tidy', 30), wants('gatherStone', 28)];
  const ctx = { backoff: new Map(), commitment: { name: 'gatherStone', at: Date.now() } };
  assert.strictEqual(pickBehavior({}, ctx, behaviors).name, 'gatherStone');
});

console.log('\nthe preemption check the reflex layer calls');

/**
 * A director running one behavior that is parked on a long sleep, so the check
 * can be asked about it synchronously. Returns the pieces the checks inspect
 * and a stop function.
 */
function runningDirector(behaviors) {
  const bot = {
    pathfinder: { setGoal() {} },
    clearControlStates() {},
    entity: null,
    health: 20,
  };
  const ctx = {
    connected: true,
    paused: false,
    backoff: new Map(),
    commitment: null,
    strategy: null,
    stuck: { anchor: null, since: 0 },
    currentTask: null,
    currentBehavior: null,
    currentPriority: -1,
    currentStartedAt: 0,
  };
  const stop = startDirector(bot, ctx, behaviors);
  return { ctx, stop };
}

const parked = (name, priority, isWanted) => ({
  name,
  priority,
  shouldRun: () => isWanted(),
  canInterrupt: () => isWanted(),
  run: (_bot, _ctx, task) => sleep(60000, task),
});

check('the director hands the reflex layer its own preemption check', () => {
  const { ctx, stop } = runningDirector([parked('mine', 25, () => true)]);
  try {
    assert.strictEqual(typeof ctx.requestPreemptionCheck, 'function');
    assert.ok(ctx.currentTask instanceof Task);
  } finally {
    stop();
  }
  assert.strictEqual(ctx.requestPreemptionCheck, null, 'a stopped director must leave nothing to call');
});

check('asking while the OWNER is running changes nothing — the reflex never aborts it', () => {
  const { ctx, stop } = runningDirector([parked('escapeHazard', 97, () => true)]);
  try {
    assert.strictEqual(ctx.currentBehavior, 'escapeHazard');
    assert.strictEqual(ctx.requestPreemptionCheck('reflex:hazard'), false);
    assert.strictEqual(ctx.currentTask.aborted, false);
  } finally {
    stop();
  }
});

check('asking when something outranks the running behavior preempts it', () => {
  let hazard = false;
  const { ctx, stop } = runningDirector([
    parked('escapeHazard', 97, () => hazard),
    parked('mine', 25, () => true),
  ]);
  try {
    assert.strictEqual(ctx.currentBehavior, 'mine');
    assert.strictEqual(ctx.requestPreemptionCheck('reflex:hazard'), false, 'nothing outranks it yet');
    const task = ctx.currentTask;
    hazard = true;
    assert.strictEqual(ctx.requestPreemptionCheck('reflex:hazard'), true);
    assert.strictEqual(task.reason, 'preempted by escapeHazard');
  } finally {
    stop();
  }
});

console.log(`\n${passed} checks passed`);
