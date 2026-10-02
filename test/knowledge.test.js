/**
 * The game facts the bot is expected to know without looking.
 *
 * One of these is not a nicety. `canHarvest` guards a silent, permanent loss:
 * a wooden pickaxe breaks iron ore perfectly happily and it drops NOTHING.
 * The dig reports success, the block disappears, the inventory does not
 * change, and the ore is gone for good. A bot at wooden tier walking past an
 * iron vein was destroying the exact thing it needed to progress, with no
 * error anywhere.
 *
 * Run with: node test/knowledge.test.js
 */

const assert = require('assert');
const {
  canHarvest, mobFacts, animalFacts, foodFacts, describeMob,
  structureFrom, STRUCTURES,
} = require('../src/knowledge');

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

console.log('what a pickaxe can actually collect');

check('a wooden pickaxe destroys iron ore rather than mining it', () => {
  assert.strictEqual(canHarvest('wooden', 'iron_ore'), false);
  assert.strictEqual(canHarvest('wooden', 'deepslate_iron_ore'), false);
});

check('but coal is fine at wooden tier', () => {
  assert.strictEqual(canHarvest('wooden', 'coal_ore'), true);
});

check('stone gets iron, copper and lapis — not gold, redstone or diamond', () => {
  assert.strictEqual(canHarvest('stone', 'iron_ore'), true);
  assert.strictEqual(canHarvest('stone', 'copper_ore'), true);
  assert.strictEqual(canHarvest('stone', 'lapis_ore'), true);
  assert.strictEqual(canHarvest('stone', 'gold_ore'), false);
  assert.strictEqual(canHarvest('stone', 'redstone_ore'), false);
  assert.strictEqual(canHarvest('stone', 'diamond_ore'), false);
});

// The whole reason the run needs an iron pickaxe before going to y=-59.
check('diamond needs iron, and iron tier gets it', () => {
  assert.strictEqual(canHarvest('stone', 'deepslate_diamond_ore'), false);
  assert.strictEqual(canHarvest('iron', 'deepslate_diamond_ore'), true);
  assert.strictEqual(canHarvest('diamond', 'deepslate_diamond_ore'), true);
});

// Gold looks like a strong material and mines like wood.
check('a golden pickaxe is no better than wooden for harvesting', () => {
  assert.strictEqual(canHarvest('golden', 'iron_ore'), false);
  assert.strictEqual(canHarvest('golden', 'coal_ore'), true);
});

check('an unknown block is assumed harvestable rather than skipped forever', () => {
  assert.strictEqual(canHarvest('wooden', 'some_new_ore_block'), true);
});

console.log('\nmob facts');

check('a vindicator hits far harder than a zombie', () => {
  assert.ok(mobFacts('vindicator').damage > mobFacts('zombie').damage * 3);
});

check('spiders are faster than us; zombies are not', () => {
  assert.ok(mobFacts('spider').speed > 0.28);
  assert.ok(mobFacts('zombie').speed < 0.28);
});

check('archers are flagged as ranged', () => {
  for (const name of ['skeleton', 'stray', 'bogged', 'pillager', 'witch', 'blaze']) {
    assert.strictEqual(mobFacts(name).ranged, true, name);
  }
});

check('an unknown mob gets safe defaults, not a crash', () => {
  const facts = mobFacts('some_mob_from_1_22');
  assert.strictEqual(facts.unknown, true);
  assert.ok(facts.damage > 0);
});

check('the briefing handed to Jev names the numbers that decide a fight', () => {
  const brief = describeMob('creeper');
  assert.strictEqual(brief.mob_type, 'creeper');
  assert.ok(brief.damage_to_us > 20, 'a creeper can one-shot an unarmoured bot');
  assert.ok(brief.note.includes('fuse'));
});

console.log('\nwhat an animal costs to kill');

// Bare fists do 1 damage. A starving bot at 0 food was chasing sheep it
// could not kill — eight swings each, while the sheep ran between them —
// because prey was chosen by distance and wool value, never by whether the
// kill was achievable at all.
check('a chicken is far cheaper to kill than a cow', () => {
  assert.ok(animalFacts('chicken').health < animalFacts('cow').health);
  assert.ok(animalFacts('rabbit').health < animalFacts('sheep').health);
});

check('sheep are still recorded as the wool source', () => {
  assert.ok(animalFacts('sheep').drops.includes('wool'));
  assert.ok(animalFacts('cow').drops.includes('leather'));
});

check('an unknown animal gets a middling default, not a crash', () => {
  assert.ok(animalFacts('some_new_animal').health > 0);
});

console.log('\nrecognising structures without crying wolf');

check('a village is identified from its own furniture', () => {
  const found = structureFrom(['bell', 'composter', 'oak_planks']);
  assert.ok(found);
  assert.strictEqual(found.name, 'village');
});

check('one stray marker is not a structure', () => {
  assert.strictEqual(structureFrom(['rail', 'stone', 'dirt']), null);
});

// The bot places crafting tables. Keying a detector on one guarantees it
// eventually identifies its OWN BASE — and witch_hut is marked "avoid", so
// it would have been told to keep away from its own workshop.
check('the bot never mistakes its own workshop for a witch hut', () => {
  const asIfAtBase = ['spruce_log', 'crafting_table', 'furnace', 'torch', 'dirt'];
  assert.strictEqual(structureFrom(asIfAtBase), null);
});

check('a real witch hut still registers', () => {
  const found = structureFrom(['cauldron', 'spruce_log', 'spruce_planks']);
  assert.ok(found);
  assert.strictEqual(found.name, 'witch_hut');
  assert.strictEqual(found.worth, 'avoid');
});

check('the dangerous ones carry a warning and the useful ones a reason', () => {
  assert.ok(STRUCTURES.pillager_outpost.danger);
  assert.ok(STRUCTURES.ocean_monument.danger);
  assert.ok(STRUCTURES.village.why);
  assert.ok(STRUCTURES.mineshaft.why);
  // The desert temple trap is the one that actually kills people.
  assert.ok(/TNT/i.test(STRUCTURES.desert_temple.danger));
});

console.log('\nfood values');

// Cooking is worth a trip to the furnace precisely because of this gap.
check('cooking roughly doubles hunger and multiplies saturation sevenfold', () => {
  const raw = foodFacts('beef');
  const cooked = foodFacts('cooked_beef');
  assert.ok(cooked.hunger > raw.hunger * 2);
  assert.ok(cooked.saturation > raw.saturation * 6);
});

check('beef outranks mutton, so it is cooked first', () => {
  assert.ok(foodFacts('cooked_beef').saturation > foodFacts('cooked_mutton').saturation);
});

check('the risky foods are labelled', () => {
  assert.ok(foodFacts('chicken').risk);
  assert.ok(foodFacts('rotten_flesh').risk);
});

check('an unknown food returns null rather than a wrong number', () => {
  assert.strictEqual(foodFacts('some_new_food'), null);
});

console.log(`\n${passed} checks passed`);
