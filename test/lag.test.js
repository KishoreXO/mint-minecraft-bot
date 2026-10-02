/**
 * Telling "our code blocked the loop" apart from "the process was not running".
 *
 * A 20.9-second freeze got the bot kicked, and the lag meter blamed a block
 * search that takes milliseconds — because whatever was on the stack when the
 * process stopped being scheduled got charged the whole gap. The meter now
 * compares CPU time with wall time. This checks that the measurement really
 * separates the two by producing each kind of stall for real:
 *
 *  - a busy spin: our own code hogging the thread, burning CPU throughout;
 *  - Atomics.wait: the thread blocked without running, which is what being
 *    descheduled or paged out looks like from inside the process.
 *
 * Run with: node test/lag.test.js
 */

const assert = require('assert');
const { cpuVerdict } = require('../src/lag');

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

/** Run `stall`, and judge it the way the lag meter does. */
function measure(stall) {
  const before = process.cpuUsage();
  const startedAt = Date.now();
  stall();
  const wallMs = Date.now() - startedAt;
  const cpu = process.cpuUsage(before);
  const cpuMs = Math.round((cpu.user + cpu.system) / 1000);
  return { wallMs, cpuMs, verdict: cpuVerdict(cpuMs, wallMs) };
}

const STALL_MS = 300;

check('a thread spinning in our own code is called busy', () => {
  const { verdict, wallMs, cpuMs } = measure(() => {
    const until = Date.now() + STALL_MS;
    while (Date.now() < until) { /* spin */ }
  });
  assert.match(verdict, /busy/, `spin read as starved (wall ${wallMs}ms, cpu ${cpuMs}ms)`);
});

check('a thread that was not running is not blamed on our code', () => {
  const { verdict, wallMs, cpuMs } = measure(() => {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, STALL_MS);
  });
  assert.ok(wallMs >= STALL_MS - 20, `the wait did not actually stall (${wallMs}ms)`);
  assert.match(verdict, /not our code/, `idle wait read as busy (wall ${wallMs}ms, cpu ${cpuMs}ms)`);
});

check('the boundary sits at thirty percent', () => {
  assert.match(cpuVerdict(100, 1000), /not our code/);
  assert.match(cpuVerdict(500, 1000), /busy/);
  assert.match(cpuVerdict(0, 0), /busy/, 'no wall time is not evidence of starvation');
});

console.log(`\n${passed} checks passed`);
