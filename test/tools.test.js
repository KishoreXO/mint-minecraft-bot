/**
 * Which tool for which block.
 *
 * This has been got wrong repeatedly in ways that each looked small and
 * weren't. The worst: leaves mapped to SWORD. Breaking blocks costs a sword
 * two durability instead of one, and the bot breaks leaves constantly — every
 * tree it fells, every canopy it cuts out of — so its only weapon was being
 * destroyed by gardening, and it kept arriving at fights unarmed. That is the
 * "using sword to mine tree" report.
 *
 * The table is now one explicit ruleset in src/tools.js, and this pins it.
 *
 * Run with: node test/tools.test.js
 */

const assert = require('assert');
const { toolTypeForBlock, toolPreferenceFor, isWeaponOrGear } = require('../src/tools');
const { tierRank } = require('../src/inventory');

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

/** A bot that owns every tool type. */
const hasAll = () => true;
/** A bot that owns nothing but a sword and a pickaxe. */
const hasBasics = (type) => type === 'sword' || type === 'pickaxe';

const forBlock = (name, has = hasAll) => toolTypeForBlock({ name }, has);

console.log('the rule that kept costing us a sword');

check('leaves never want a sword', () => {
  for (const name of ['oak_leaves', 'birch_leaves', 'spruce_leaves', 'azalea_leaves']) {
    assert.notStrictEqual(forBlock(name), 'sword', `${name} must not use the weapon`);
  }
});

check('leaves want shears when we have them', () => {
  assert.strictEqual(forBlock('oak_leaves'), 'shears');
});

check('leaves fall back to a hoe, then to bare hands', () => {
  const noShears = (type) => type === 'hoe';
  assert.strictEqual(forBlock('oak_leaves', noShears), 'hoe');
  // Carrying only a sword and pickaxe, the right answer is fists — not the
  // sword, which is exactly the trap this whole file exists for.
  assert.strictEqual(forBlock('oak_leaves', hasBasics), null);
});

check('cobweb is the one block a sword is correct for', () => {
  assert.strictEqual(forBlock('cobweb'), 'sword');
});

console.log('\nthe ordinary cases');

check('wood-like blocks want an axe', () => {
  for (const name of ['oak_log', 'birch_log', 'spruce_planks', 'crafting_table',
    'bookshelf', 'oak_fence', 'chest', 'melon', 'pumpkin']) {
    assert.strictEqual(forBlock(name), 'axe', name);
  }
});

check('stone, ore and metal want a pickaxe', () => {
  for (const name of ['stone', 'cobblestone', 'iron_ore', 'deepslate_diamond_ore',
    'furnace', 'blast_furnace', 'deepslate', 'tuff', 'obsidian', 'blue_ice',
    'iron_block', 'terracotta']) {
    assert.strictEqual(forBlock(name), 'pickaxe', name);
  }
});

// "sandstone" contains "sand"; "stone" ordering has to beat the shovel rule.
check('sandstone is a pickaxe block, not a shovel block', () => {
  assert.strictEqual(forBlock('sandstone'), 'pickaxe');
  assert.strictEqual(forBlock('red_sandstone'), 'pickaxe');
  assert.strictEqual(forBlock('sand'), 'shovel');
});

check('soft ground wants a shovel', () => {
  for (const name of ['dirt', 'grass_block', 'sand', 'gravel', 'clay',
    'podzol', 'dirt_path', 'snow_block', 'mud']) {
    assert.strictEqual(forBlock(name), 'shovel', name);
  }
});

check('wool and vines want shears', () => {
  assert.strictEqual(forBlock('white_wool'), 'shears');
  assert.strictEqual(forBlock('vine'), 'shears');
});

console.log('\nblocks where bare hands are the right answer');

// Not a fallback — the correct choice. Holding a tool just spends durability
// for no speed gain, and holding a sword spends double.
check('plants, glass and torches want nothing in hand', () => {
  for (const name of ['torch', 'poppy', 'dandelion', 'short_grass', 'tall_grass',
    'glass', 'oak_sapling', 'sweet_berry_bush', 'sugar_cane']) {
    assert.strictEqual(forBlock(name), null, name);
  }
});

check('an unknown block leaves us with no opinion', () => {
  assert.deepStrictEqual(toolPreferenceFor({ name: 'some_new_1_22_block' }), []);
  assert.strictEqual(forBlock('some_new_1_22_block'), null);
});

check('a missing or nameless block does not throw', () => {
  assert.deepStrictEqual(toolPreferenceFor(null), []);
  assert.deepStrictEqual(toolPreferenceFor({}), []);
});

console.log('\nkeeping weapons out of the mining hand');

check('weapons and gear are recognised', () => {
  for (const name of ['stone_sword', 'diamond_sword', 'bow', 'crossbow', 'shield', 'trident']) {
    assert.strictEqual(isWeaponOrGear(name), true, name);
  }
});

check('tools are not', () => {
  for (const name of ['stone_pickaxe', 'iron_axe', 'shears', 'diamond_shovel']) {
    assert.strictEqual(isWeaponOrGear(name), false, name);
  }
});

console.log('\ntool tier ranking');

check('better materials rank ahead of worse ones', () => {
  assert.ok(tierRank('diamond_pickaxe') < tierRank('iron_pickaxe'));
  assert.ok(tierRank('iron_pickaxe') < tierRank('stone_pickaxe'));
  assert.ok(tierRank('stone_pickaxe') < tierRank('wooden_pickaxe'));
  assert.ok(tierRank('netherite_sword') < tierRank('diamond_sword'));
});

check('unknown items rank last rather than throwing', () => {
  assert.ok(tierRank('some_mystery_item') >= tierRank('wooden_pickaxe'));
});

console.log(`\n${passed} checks passed`);
