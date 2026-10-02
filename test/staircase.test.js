/**
 * The shape of a step, in both directions.
 *
 * This is arithmetic about a hitbox, and getting it wrong does not throw
 * anything — it produces a bot that walks face-first into stone on every single
 * step, turns, turns again, and reports "boxed in". Which is exactly what was
 * reported, twice, in the plainest possible words: the digging-down method is
 * weird, and so is the going-up one.
 *
 * THE FACT EVERYTHING HERE TURNS ON: a Minecraft player is 1.8 blocks tall, so
 * it occupies TWO cells — the one its feet are in and the one above. Any cell
 * it moves through has to be clear at both heights, not just at floor level.
 *
 * The descent used to dig two cells per step: the new floor and the space above
 * it. Both are about where the bot ENDS UP, and neither is about getting there.
 * The block at the bot's own head height, one step ahead, stayed standing — so
 * the doorway was a hole with a lintel across it at chest height.
 *
 * The climb had the mirror-image omission: it cleared the two cells ahead and
 * left the ceiling directly overhead intact, so every jump hit the roof of the
 * corridor the bot had just dug.
 *
 * Run with: node test/staircase.test.js
 */

const assert = require('assert');
const { Vec3 } = require('vec3');
const { stairCells, climbCells } = require('../src/behaviors/mine');

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

/** Cells a 2-tall bot occupies with its feet at `feet`. */
function occupies(feet) {
  return [feet, feet.offset(0, 1, 0)];
}

function includesCell(cells, wanted) {
  return cells.some((c) => c.equals(wanted));
}

const FEET = new Vec3(10, 64, 10);
const HEADINGS = [[1, 0], [-1, 0], [0, 1], [0, -1]];

console.log('going down');

check('a step clears three cells, not two', () => {
  for (const heading of HEADINGS) {
    const cells = Object.values(stairCells(FEET, heading));
    assert.strictEqual(cells.length, 3, `heading ${heading} should cut three cells`);
  }
});

check('the doorway is cleared at BOTH the heights the bot passes through', () => {
  for (const [dx, dz] of HEADINGS) {
    const cut = Object.values(stairCells(FEET, [dx, dz]));
    // Moving into the next column happens at the CURRENT level: feet at
    // FEET.y, head at FEET.y + 1. Both of those cells, in the column ahead,
    // have to be clear or the bot simply cannot enter it.
    for (const passing of occupies(FEET.offset(dx, 0, dz))) {
      assert.ok(
        includesCell(cut, passing),
        `heading ${dx},${dz}: ${passing} is in the way and is never dug — `
        + 'this is the bug that made every descent turn and give up',
      );
    }
  }
});

check('and the bot fits where it lands', () => {
  for (const [dx, dz] of HEADINGS) {
    const { stepDown } = stairCells(FEET, [dx, dz]);
    const cut = Object.values(stairCells(FEET, [dx, dz]));
    for (const standing of occupies(stepDown)) {
      assert.ok(includesCell(cut, standing), `${standing} would crush the bot`);
    }
  }
});

check('every step goes down exactly one block', () => {
  for (const heading of HEADINGS) {
    const { stepDown } = stairCells(FEET, heading);
    assert.strictEqual(stepDown.y, FEET.y - 1, 'a staircase, not a shaft');
  }
});

// The whole reason to cut stairs rather than a 1x1 shaft: a shaft is a trap.
// Pathfinder cannot dig and cannot pillar, so a bot at the bottom of one is
// stuck there. A 2-high staircase is walkable in both directions, which is also
// what lets `resupply` use pathfinder instead of re-cutting a way out by hand.
check('what the descent cuts is what the climb needs', () => {
  const heading = [1, 0];
  const down = stairCells(FEET, heading);
  // Standing on the new step, facing back the way we came, the cells we would
  // rise through are the ones the descent already opened.
  const back = [-heading[0], -heading[1]];
  const up = climbCells(down.stepDown, back);
  assert.ok(up.riseFeet.equals(FEET), 'climbing back puts the feet where they were');
  assert.ok(
    up.riseHead.equals(FEET.offset(0, 1, 0)),
    'and the head where it was — both already clear',
  );
});

console.log('\ngoing up');

check('a climb clears the ceiling as well as the way ahead', () => {
  for (const heading of HEADINGS) {
    const { ceiling } = climbCells(FEET, heading);
    assert.ok(
      ceiling.equals(FEET.offset(0, 2, 0)),
      'a step up is a jump, and a jump needs somewhere to put your head',
    );
  }
});

check('the bot fits where it lands after the step up', () => {
  for (const [dx, dz] of HEADINGS) {
    const cut = Object.values(climbCells(FEET, [dx, dz]));
    const landing = FEET.offset(dx, 1, dz);
    for (const standing of occupies(landing)) {
      assert.ok(includesCell(cut, standing), `${standing} is not cleared`);
    }
  }
});

check('every step goes up exactly one block', () => {
  for (const heading of HEADINGS) {
    const { riseFeet } = climbCells(FEET, heading);
    assert.strictEqual(riseFeet.y, FEET.y + 1);
  }
});

console.log(`\n${passed} checks passed`);
