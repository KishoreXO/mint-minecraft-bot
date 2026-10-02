/**
 * The log summarizer's tally — tools/summarize-logs.js.
 *
 * Live verification now leans on this: "Digging aborted went to 0" is only a
 * finding if the counter would have counted it. So each signal is fed the
 * exact line shape the bot writes, and the time-window signals are checked on
 * both sides of their window.
 *
 * Run with: node test/logsummary.test.js
 */

const assert = require('assert');
const { parseLines, summarize, parseSlowest } = require('../tools/summarize-logs');

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

const T0 = Date.parse('2026-09-23T15:00:00.000Z');

function line(offsetMs, message, data = undefined, level = 'info') {
  return JSON.stringify({
    ts: new Date(T0 + offsetMs).toISOString(),
    level,
    message,
    ...(data === undefined ? {} : { data }),
  });
}

function tally(...lines) {
  return summarize(parseLines(lines.join('\n')));
}

console.log('parsing');

check('a half-written last line is skipped, not fatal', () => {
  const entries = parseLines(`${line(0, 'Session started')}\n{"ts":"2026-09-23T15:00:01`);
  assert.strictEqual(entries.length, 1);
});

check('status lines are counted apart from messages', () => {
  const s = tally(line(0, 'hp 20/20 | food 20/20', undefined, 'status'), line(10, 'Exploring'));
  assert.strictEqual(s.statusLines, 1);
  assert.strictEqual(s.messages.get('Exploring'), 1);
  assert.strictEqual(s.messages.has('hp 20/20 | food 20/20'), false);
});

check('the lag meter slowest-scan format is parsed, and its fallback is unattributed', () => {
  assert.deepStrictEqual(parseSlowest('findBlocks r16 213ms worst / 806ms in 6'), {
    name: 'findBlocks r16', worstMs: 213, totalMs: 806, calls: 6,
  });
  assert.strictEqual(parseSlowest('nothing over 60ms — likely a GC pause or pathfinder').name, 'unattributed');
});

console.log('\nsignals');

check('Digging aborted is counted from Behavior failed', () => {
  const s = tally(
    line(0, 'Behavior failed', { behavior: 'gatherStone', error: 'Digging aborted' }),
    line(10, 'Behavior failed', { behavior: 'mine', error: 'navigation stalled' }),
  );
  assert.strictEqual(s.signals.diggingAborted, 1);
  assert.strictEqual(s.failures.get('gatherStone: Digging aborted'), 1);
});

check('"too far" then "Going to collect" counts only inside the window', () => {
  const inside = tally(
    line(0, 'The old crafting table is too far to be worth the walk', { distance: 26 }),
    line(1500, 'Going to collect the old crafting table', { pos: {} }),
  );
  assert.strictEqual(inside.signals.tooFarThenCollect, 1);
  const outside = tally(
    line(0, 'The old crafting table is too far to be worth the walk', { distance: 26 }),
    line(9000, 'Going to collect the old crafting table', { pos: {} }),
  );
  assert.strictEqual(outside.signals.tooFarThenCollect, 0);
});

check('the same target re-engaged within a second is a repeat; a new target is not', () => {
  const s = tally(
    line(0, 'Engaging', { target: 'zombie' }),
    line(500, 'Engaging', { target: 'zombie' }),
    line(600, 'Engaging', { target: 'skeleton' }),
    line(5000, 'Engaging', { target: 'zombie' }),
  );
  assert.strictEqual(s.signals.engageRepeats, 1);
});

check('a fight or flee right after environmental damage is counted once per hit', () => {
  const s = tally(
    line(0, 'Took avoidable damage', { cause: 'fall', lost: 2 }),
    line(800, 'Committing to fight', { target: 'zombie' }),
    line(801, 'Engaging', { target: 'zombie' }),
    line(20000, 'Took avoidable damage', { cause: 'starving', lost: 1 }),
    line(26000, 'Fleeing', { from: 'zombie' }), // outside the 3s window
  );
  assert.strictEqual(s.signals.reactionsAfterEnvDamage, 1);
  assert.deepStrictEqual(s.damage.get('fall'), { hits: 1, lost: 2 });
});

check('lines are sorted by time before any "X then Y" signal is read', () => {
  // The logger appends asynchronously, so a later line can land first.
  const s = tally(
    line(1500, 'Going to collect the old crafting table', { pos: {} }),
    line(0, 'The old crafting table is too far to be worth the walk', { distance: 26 }),
  );
  assert.strictEqual(s.signals.tooFarThenCollect, 1);
});

check('stalls, hungry-underground heights and placement tries are grouped', () => {
  const s = tally(
    line(0, 'Event loop stalled — the bot could not react', {
      forMs: 500, doing: 'forage', slowest: ['structureScan 434ms worst / 434ms in 1'],
    }),
    line(10, 'Hungry underground — heading for the surface', { y: 64 }),
    line(20, 'Hungry underground — heading for the surface', { y: 64 }),
    line(30, 'Nowhere clear to place block', { item: 'crafting_table', tried: 0 }),
  );
  assert.strictEqual(s.stalls.count, 1);
  assert.strictEqual(s.stalls.worstMs, 500);
  assert.strictEqual(s.stalls.byDoing.get('forage'), 1);
  assert.strictEqual(s.stalls.bySlowest.get('structureScan'), 1);
  assert.strictEqual(s.signals.hungryUnderground.get(64), 2);
  assert.strictEqual(s.signals.nowhereClear.get(0), 1);
});

// The night shift never ran and nothing said why. What the night was spent on
// is now one line of the summary.
check('nights: legs mined, crafts, and why it did not mine', () => {
  const s = tally(
    line(0, 'Not mining tonight', { reason: 'no pickaxe' }),
    line(10, 'Crafting in the shelter'),
    line(20, 'Mining through the night', { descended: 3, y: 50 }),
    line(30, 'Mining through the night', { descended: 2, y: 48 }),
    line(40, 'Going up to stock food for the trip', { y: 56, food: 20 }),
  );
  assert.strictEqual(s.nights.mined, 2);
  assert.strictEqual(s.nights.crafted, 1);
  assert.strictEqual(s.nights.notMining.get('no pickaxe'), 1);
  assert.strictEqual(s.signals.hungryUnderground.size, 0, 'stocking up is not being hungry');
});


// The progression and Jev's share of the decisions, as two summary lines.
check('phases completed in order, bypasses, and the Jev usage totals', () => {
  const s = tally(
    line(0, 'Phase complete', { phase: 'Wood', next: 'Stone tools', tookSec: 70 }),
    line(10, 'Out of order: valuables', { phase: 'Food', why: 'iron_ore 4 blocks away' }),
    line(20, 'Phase complete', { phase: 'Stone tools', next: 'Food', tookSec: 95 }),
    line(30, 'Back to an earlier phase', { from: 'Food', to: 'Wood' }),
    line(40, 'Could not make that — leaving it a moment', { item: 'stone_pickaxe', why: { stick: '0/2' } }),
    line(50, 'Jev usage', { decidedByJev: 3, byInstinct: 1, warmed: 20, calls: {} }),
    line(60, 'Jev usage', { decidedByJev: 9, byInstinct: 2, warmed: 40, calls: {} }),
  );
  assert.deepStrictEqual(s.progression.phases, ['Wood (70s)', 'Stone tools (95s)', 'back to Wood']);
  assert.strictEqual(s.progression.outOfOrder.get('valuables'), 1);
  assert.strictEqual(s.progression.craftFailedWhy.get('stone_pickaxe: {"stick":"0/2"}'), 1);
  assert.strictEqual(s.jev.decidedByJev, 9, 'the last usage line is the session total');
});

// The 09-26 ravine, compressed: out, straight back in, unstick taking the
// wheel, leaveWater giving up at once, a pillar step from the water, and a
// drowning — each one a water signal that should read 0.
check('water signals: re-entry, unstick after water, instant give-up, pillar in water, drowning', () => {
  const s = tally(
    line(0, 'Stuck in water — swimming out manually', { air: 20 }),
    line(5000, 'Reached dry land'),
    line(12000, 'Stuck in water — swimming out manually', { air: 20 }),
    line(12300, 'Still in water, will retry', { air: 20 }),
    line(27000, 'Stuck — getting out', { reason: 'walled in' }),
    line(30000, 'Pillar step refused', { inWater: true }),
    line(31000, 'Pillar step refused', { inWater: false }),
    line(60000, 'Re-entered water', { behavior: 'woodUrgent', sinceExitMs: 7000 }),
    line(90000, 'Took avoidable damage', { cause: 'drowning', lost: 2 }),
    line(91000, 'Bot died', { killedBy: 'drowning' }),
  );
  assert.strictEqual(s.signals.reenteredWater, 1, 'stuck again after an escape; a Re-entered water line alone is not a trap');
  assert.strictEqual(s.signals.waterThenUnstick, 1);
  assert.strictEqual(s.signals.leaveWaterGaveUpFast, 1);
  assert.strictEqual(s.signals.pillarRefusedInWater, 1);
  assert.strictEqual(s.signals.drownings, 1);
  assert.strictEqual(s.signals.drowningDamage, 2);
});

console.log(`\n${passed} checks passed`);
