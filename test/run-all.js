/**
 * Run every test/*.test.js and fail loudly if any of them does not finish.
 *
 * `a && b && c` stops at the first failure, which is what it should do, but it
 * cannot see a suite that EXITS EARLY with code 0: a pending wait whose timers
 * stop holding the process open ends the run half-way, every check after it
 * silently skipped, and the chain carries on. Each suite ends by printing
 * "N checks passed", so a suite without that line did not finish.
 *
 * Run with: npm test   (or node test/run-all.js)
 */

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const dir = __dirname;
const suites = fs.readdirSync(dir).filter((f) => f.endsWith('.test.js')).sort();

let total = 0;
const failed = [];
for (const suite of suites) {
  const run = spawnSync(process.execPath, [path.join(dir, suite)], { encoding: 'utf8' });
  const out = `${run.stdout ?? ''}${run.stderr ?? ''}`;
  const match = out.match(/(\d+) checks passed\s*$/m);
  if (run.status !== 0 || !match) {
    failed.push(suite);
    console.log(`FAIL  ${suite}${run.status !== 0 ? ` (exit ${run.status})` : ' (did not finish)'}`);
    console.log(out.split('\n').filter((l) => /FAIL|Error|at /.test(l)).slice(0, 15).join('\n'));
    continue;
  }
  total += Number(match[1]);
  console.log(`ok    ${suite.padEnd(28)} ${match[1]} checks`);
}

console.log(`\n${suites.length - failed.length}/${suites.length} suites, ${total} checks passed`);
if (failed.length) {
  console.log(`failed: ${failed.join(', ')}`);
  process.exitCode = 1;
}
