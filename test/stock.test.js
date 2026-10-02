/**
 * What the bot wants to be carrying — the one policy both sides consult.
 *
 * Before this there were four opinions about what was worth holding: a JUNK
 * list in tidy.js, a WORTH table in collect.js, an ENOUGH table in mine.js and
 * a per-tool rule in gear.js. They disagreed, and the disagreement was
 * visible in game: the bot dropped a spare stone pickaxe as surplus, the
 * pickup side rated tools at 500 and walked straight back for it, and tidy
 * dropped it again. Reported as "he drops the pickaxes to get rid of them but
 * continues to go pick them like 20 times".
 *
 * So the invariant that matters most here is not any single threshold, it is
 * that the two directions AGREE: nothing the bot throws away should be
 * something it then wants, and vice versa.
 *
 * Run with: node test/stock.test.js
 */

const assert = require('assert');
const {
  roomFor, worthPickingUp, surplusStack, isPrecious,
} = require('../src/stock');

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

/** `items` is name -> count; tools are listed one entry per tool. */
function carrying(items) {
  const list = [];
  for (const [name, count] of Object.entries(items)) {
    if (/_(pickaxe|sword|axe|shovel|hoe)$/.test(name)) {
      for (let i = 0; i < count; i++) {
        list.push({
          name, count: 1, maxDurability: 131, durabilityUsed: i * 10,
        });
      }
    } else {
      list.push({ name, count });
    }
  }
  return { inventory: { items: () => list } };
}

console.log('the goal is a diamond kit, not a museum');

// Reported directly: the bot mining lapis, carrying it, and burning furnace
// fuel smelting copper. Neither is a step toward 29 diamonds.
check('lapis, copper and redstone are worth nothing to this run', () => {
  const bot = carrying({});
  for (const name of ['lapis_lazuli', 'raw_copper', 'copper_ingot', 'redstone']) {
    assert.strictEqual(roomFor(bot, name), 0, `${name} should not be wanted`);
    assert.strictEqual(worthPickingUp(bot, name), false);
  }
});

check('but iron, diamond and fuel are always wanted', () => {
  const bot = carrying({ raw_iron: 64, diamond: 64, coal: 64 });
  for (const name of ['raw_iron', 'iron_ingot', 'diamond', 'coal', 'charcoal']) {
    assert.strictEqual(roomFor(bot, name), Infinity, `${name} should always be wanted`);
  }
});

check('and so is anything we do not recognise', () => {
  // An unclassified item might be an ore from a mod, or a new block name.
  // Guessing "junk" loses it forever; guessing "keep" costs a slot.
  assert.strictEqual(roomFor(carrying({}), 'something_unheard_of'), Infinity);
});

console.log('\ncaps on things it makes faster than it can spend');

check('cobblestone is wanted until there is far too much of it', () => {
  assert.ok(worthPickingUp(carrying({ cobblestone: 20 }), 'cobblestone'));
  assert.strictEqual(worthPickingUp(carrying({ cobblestone: 300 }), 'cobblestone'), false);
});

check('two of each tool, and no more', () => {
  assert.ok(worthPickingUp(carrying({ stone_pickaxe: 1 }), 'stone_pickaxe'));
  assert.strictEqual(worthPickingUp(carrying({ stone_pickaxe: 2 }), 'stone_pickaxe'), false);
  assert.strictEqual(worthPickingUp(carrying({ stone_pickaxe: 17 }), 'wooden_pickaxe'), false);
});

console.log('\nthe two sides must agree');

// THE bug this file exists to prevent. If something is surplus enough to
// throw away, walking back for it must never look like a good idea.
check('nothing it throws away is something it then wants back', () => {
  const inventories = [
    { stone_pickaxe: 17, cobblestone: 300 },
    { lapis_lazuli: 12, raw_iron: 3 },
    { dirt: 200, wooden_sword: 3 },
  ];
  for (const items of inventories) {
    const bot = carrying(items);
    const dropping = surplusStack(bot);
    assert.ok(dropping, `expected something to drop from ${JSON.stringify(items)}`);
    assert.strictEqual(
      worthPickingUp(bot, dropping.name),
      false,
      `would drop ${dropping.name} and then want it back`,
    );
  }
});

check('a bag of nothing but useful things has nothing to drop', () => {
  const bot = carrying({
    stone_pickaxe: 2, stone_sword: 1, raw_iron: 9, cooked_beef: 4, oak_log: 6,
  });
  assert.strictEqual(surplusStack(bot), null);
});

console.log('\nwhich one goes first');

check('the worthless goes before the merely surplus', () => {
  const bot = carrying({ lapis_lazuli: 4, cobblestone: 300 });
  assert.strictEqual(surplusStack(bot).name, 'lapis_lazuli');
});

// Reversing this silently throws away the good pickaxe and keeps the broken
// one, which is not a failure that announces itself.
check('of surplus tools, the worst one goes', () => {
  const bot = carrying({ stone_pickaxe: 2, wooden_pickaxe: 1 });
  const dropping = surplusStack(bot);
  assert.ok(dropping, 'three pickaxes is one too many');
  assert.strictEqual(dropping.name, 'wooden_pickaxe', 'the lowest tier should go');
});

console.log('\nthe things nobody thought to list');

/**
 * A named denylist only covers what somebody has already seen in the bag, and
 * the default for anything unnamed is "keep it, it might be an ore". Both are
 * right, and together they fill the inventory with novelties.
 *
 * Read off the live dashboard after twenty minutes of play: 29 oak saplings, 72
 * leaf litter, 4 eggs, 2 peonies — dozens of slots of things no step of this
 * run will ever consume, in a bag that has to hold iron. The patterns in
 * stock.js cover the shape of that rather than the instances.
 */
const SHOULD_DROP = [
  'oak_sapling', 'spruce_sapling', 'peony', 'blue_orchid', 'pink_tulip',
  'egg', 'leaf_litter', 'oak_leaves', 'bone_meal', 'red_dye', 'paper',
  'sugar_cane', 'moss_carpet', 'lapis_lazuli', 'raw_copper',
];

/**
 * ...and the same rule pointed the other way, which matters more.
 *
 * A pattern that is one character too greedy throws away the run. `_bed$` very
 * nearly shipped in the worthless list — and since EVERY bed in the game is
 * colour-prefixed (there is no item called "bed"), the plain `bed` entry in the
 * precious set has never matched anything at all. The bot would have thrown
 * away every bed it found, and a bed is what lets it skip a ten-minute night
 * rather than sitting the whole thing out in a hole.
 */
const MUST_KEEP = [
  'white_bed', 'red_bed', 'diamond', 'raw_iron', 'iron_ingot', 'coal',
  'shield', 'crafting_table', 'furnace', 'white_wool', 'cooked_beef',
  'oak_log', 'cobblestone',
];

check('novelties the bot picks up incidentally are not kept', () => {
  const bot = carrying({});
  for (const name of SHOULD_DROP) {
    assert.strictEqual(roomFor(bot, name), 0, `${name} should not be worth carrying`);
  }
});

check('and nothing the run depends on is caught by a pattern', () => {
  const bot = carrying({});
  for (const name of MUST_KEEP) {
    assert.notStrictEqual(roomFor(bot, name), 0, `${name} must never be thrown away`);
  }
});

check('every bed colour is precious, since none of them is called "bed"', () => {
  for (const colour of ['white', 'red', 'black', 'light_blue', 'yellow']) {
    assert.ok(isPrecious(`${colour}_bed`), `${colour}_bed is how the bot skips a night`);
  }
});

check('a few rotten flesh are kept as the food of last resort, never a stack', () => {
  assert.ok(worthPickingUp(carrying({}), 'rotten_flesh'));
  assert.strictEqual(roomFor(carrying({ rotten_flesh: 8 }), 'rotten_flesh'), 0);
});

console.log(`\n${passed} checks passed`);
