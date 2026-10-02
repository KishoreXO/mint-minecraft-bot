/**
 * The road from empty-handed to a full diamond kit.
 *
 * Every step of that chain gates the next one, so a single wrong threshold
 * stalls the bot forever with no error anywhere. That has happened twice:
 * the deep trip demanded 8 torches while `neededResource` only went looking
 * for coal at ZERO torches (so 1 torch meant never descending again), and
 * diamond was missing from the craftable tiers entirely, so a full set was
 * unreachable even holding 29 diamonds.
 *
 * These are pure functions over an inventory, so the whole progression can
 * be checked offline instead of by watching a bot for an hour.
 *
 * Run with: node test/progression.test.js
 */

const assert = require('assert');
const { Vec3 } = require('vec3');
const {
  neededResource, deepTripShortfall, ENOUGH, DIAMOND_GOAL,
  stripMine, goDeep, resupply, ORE_DEPTH, DEEP_TRIP_NEEDS,
} = require('../src/behaviors/mine');
const { nextGoal } = require('../src/behaviors/gear');
const { wood, woodUrgent, RESTOCK_WOOD } = require('../src/behaviors/wood');
const {
  smeltableItem, fuelItem, canFuel, smeltOutputName, LOG_RESERVE,
} = require('../src/behaviors/smelt');

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

// Everything the bot can craft, so registry lookups resolve.
const ITEM_NAMES = [];
for (const tier of ['wooden', 'stone', 'iron', 'diamond']) {
  for (const tool of ['sword', 'pickaxe', 'axe', 'shovel']) ITEM_NAMES.push(`${tier}_${tool}`);
}
for (const tier of ['leather', 'iron', 'diamond']) {
  for (const piece of ['helmet', 'chestplate', 'leggings', 'boots']) ITEM_NAMES.push(`${tier}_${piece}`);
}
ITEM_NAMES.push('torch', 'stick', 'oak_planks', 'crafting_table', 'furnace');

const itemsByName = Object.fromEntries(ITEM_NAMES.map((n, i) => [n, { id: i, name: n }]));

// Mineflayer's armour window slots.
const ARMOR_SLOT_INDEX = {
  head: 5, torso: 6, legs: 7, feet: 8,
};

/**
 * `worn` is separate from `items` on purpose: equipped armour leaves the
 * inventory and lives in the armour slots, and gear.js reads those slots to
 * decide whether a piece is an upgrade. A mock that ignores the distinction
 * makes a carried chestplate look permanently un-equipped.
 */
function botWith(items, wearing = {}) {
  const list = Object.entries(items).map(([name, count]) => ({ name, count, type: 1 }));
  const slots = [];
  for (const [slot, name] of Object.entries(wearing)) {
    slots[ARMOR_SLOT_INDEX[slot]] = { name };
  }
  return {
    entity: { position: { x: 0, y: 64, z: 0 } },
    inventory: { items: () => list, slots },
    getEquipmentDestSlot: (slot) => ARMOR_SLOT_INDEX[slot],
    registry: { itemsByName },
  };
}

/**
 * Everything the descent asks for, DERIVED from the requirement rather than
 * typed out beside it.
 *
 * These kits used to be literals — five cooked beef, twenty planks, thirty-two
 * cobblestone — which quietly encoded the thresholds a second time. Raising the
 * real ones (the trip is now stocked to finish the job rather than to survive
 * the first ten minutes, because surfacing is the expensive part) then broke
 * eight tests that were describing the old numbers rather than the rule.
 *
 * A test that restates a constant cannot check it. This one reads it.
 */
function tripKit(extra = {}) {
  return {
    stone_pickaxe: 1,
    stone_sword: 1, // the descent ends in a cave whether or not that was the plan
    cooked_beef: DEEP_TRIP_NEEDS.food,
    oak_planks: DEEP_TRIP_NEEDS.planks,
    cobblestone: DEEP_TRIP_NEEDS.placeable,
    ...extra,
  };
}

const FULL_DIAMOND_ARMOR = {
  head: 'diamond_helmet',
  torso: 'diamond_chestplate',
  legs: 'diamond_leggings',
  feet: 'diamond_boots',
};

console.log('what to dig for next');

/**
 * THE deadlock, and the reason the bot never once reached iron.
 *
 * `neededResource` used to answer 'coal' whenever torches were short. Coal's
 * band is y=0..190, so standing on the surface at y=70 already counts as "at
 * good depth" for it — which makes `goDeep` see nothing to descend for and
 * `stripMine` see exactly the right depth. The bot tunnelled along the
 * surface hunting coal, forever. Iron lives at y<=56, so it was structurally
 * unreachable: every session ended at stone tier with stripMine running at
 * y=69, which looked like bad luck and was a deadlock.
 *
 * Charcoal removes the need for coal entirely — one log in a furnace, doable
 * anywhere — so torches are a comfort, not a prerequisite.
 */
check('no torches does NOT send the bot prospecting for coal', () => {
  const bot = botWith({ stone_pickaxe: 1 });
  assert.strictEqual(neededResource(bot), 'raw_iron', 'iron must not be gated behind torches');
});

check('one torch does not either', () => {
  const bot = botWith({ torch: 1, stone_pickaxe: 1 });
  assert.strictEqual(neededResource(bot), 'raw_iron');
});

// Coal is FUEL now and nothing else — the torch chain it used to serve has
// been removed. It is still worth fetching once the things that gate progress
// are done, because a furnace with nothing to burn cannot smelt.
check('coal is only worth a trip once iron and diamond are satisfied', () => {
  const kitted = botWith({ diamond_pickaxe: 1, raw_iron: 64, diamond: 64 });
  assert.strictEqual(neededResource(kitted), 'coal');

  const stocked = botWith({
    diamond_pickaxe: 1, raw_iron: 64, diamond: 64, coal: 64,
  });
  assert.strictEqual(neededResource(stocked), null);
});

// ...and never before them. Sending a stone-tier bot after coal is the exact
// deadlock described above: coal's band includes the surface, so `goDeep` saw
// nothing to descend for and the bot tunnelled sideways at y=70 forever.
check('a stone-tier bot never goes prospecting for coal', () => {
  const bot = botWith({ stone_pickaxe: 1, raw_iron: 64 });
  assert.notStrictEqual(neededResource(bot), 'coal');
});

check('iron comes before diamond', () => {
  const bot = botWith({ torch: 16, stone_pickaxe: 1, raw_iron: 2 });
  assert.strictEqual(neededResource(bot), 'raw_iron');
});

check('diamond is only sought with a pickaxe that can mine it', () => {
  const stone = botWith({ torch: 16, stone_pickaxe: 1, raw_iron: ENOUGH.raw_iron });
  assert.strictEqual(neededResource(stone), null, 'stone cannot mine diamond — do not go down for it');

  const iron = botWith({ torch: 16, iron_pickaxe: 1, iron_ingot: ENOUGH.raw_iron });
  assert.strictEqual(neededResource(iron), 'diamond');
});

// The kit is made OF diamonds, so a loose count fell by three the moment the
// pickaxe was crafted and ENOUGH.diamond could never be reached — the finish
// line never flipped and the bot would have gone on digging for diamond with
// the whole kit on. Iron had the identical bug (see ironInvested).
check('diamonds crafted into gear still count as diamonds', () => {
  const { diamondInvested } = require('../src/behaviors/gear');
  const bot = botWith(
    { diamond_pickaxe: 1, diamond_sword: 1, diamond: 2 },
    { torso: 'diamond_chestplate' },
  );
  assert.strictEqual(diamondInvested(bot), 3 + 2 + 2 + 8);
});

check('with the kit built and the spares banked, diamond stops being the errand', () => {
  const fullKit = botWith(
    {
      diamond_pickaxe: 1, diamond_sword: 1, raw_iron: 64, coal: 64, diamond: ENOUGH.diamond - DIAMOND_GOAL,
    },
    FULL_DIAMOND_ARMOR,
  );
  assert.strictEqual(neededResource(fullKit), null, 'the goal is reached — stop descending for more');

  const oneShort = botWith(
    {
      diamond_pickaxe: 1, diamond_sword: 1, raw_iron: 64, coal: 64, diamond: ENOUGH.diamond - DIAMOND_GOAL - 1,
    },
    FULL_DIAMOND_ARMOR,
  );
  assert.strictEqual(neededResource(oneShort), 'diamond');
});

// Tools come before armour in nextGoal, so with iron armour on, the diamonds
// after the sword went into an AXE — not part of the 29-diamond kit — ahead
// of every diamond armour piece.
check('a diamond axe waits for diamond armour', () => {
  const FULL_IRON = {
    head: 'iron_helmet', torso: 'iron_chestplate', legs: 'iron_leggings', feet: 'iron_boots',
  };
  const saving = botWith(
    {
      diamond_pickaxe: 1, diamond_sword: 1, stone_axe: 1, diamond: 3, stick: 8,
    },
    FULL_IRON,
  );
  const goal = nextGoal(saving);
  assert.ok(!goal || goal.item !== 'diamond_axe', 'three diamonds belong to the armour first');

  const done = botWith(
    {
      diamond_pickaxe: 1, diamond_sword: 1, stone_axe: 1, diamond: 3, stick: 8,
    },
    FULL_DIAMOND_ARMOR,
  );
  assert.strictEqual(nextGoal(done)?.item, 'diamond_axe', 'with the kit complete, the axe is fair game');
});

// 43% of the 09-24 session was `explore`: below y=10, iron still short, and
// nothing willing to run — stripMine wanted iron depth, goDeep only goes down.
// The user's call: mine where you are.
check('below iron depth with an iron pickaxe, it mines diamond where it stands', () => {
  const at = (y) => {
    const bot = botWith({ iron_pickaxe: 1, iron_ingot: 4 });
    bot.entity.position.y = y;
    return neededResource(bot);
  };
  assert.strictEqual(at(-35), 'diamond', 'deep, armed, still short of iron: diamond, take iron on the way');
  assert.strictEqual(at(16), 'raw_iron', 'at iron depth, iron comes first as before');
});

check('...but never with a pickaxe that cannot mine diamond', () => {
  const bot = botWith({ stone_pickaxe: 1, iron_ingot: 4 });
  bot.entity.position.y = -35;
  assert.strictEqual(neededResource(bot), 'raw_iron');
});

check('a few blocks under iron\'s best level is still somewhere to tunnel for it', () => {
  const { worthStripMiningHere } = require('../src/behaviors/mine');
  const at = (y) => {
    const bot = botWith({ stone_pickaxe: 1 });
    bot.entity.position.y = y;
    return worthStripMiningHere(bot, 'raw_iron');
  };
  assert.strictEqual(at(16), true, 'the best level');
  assert.strictEqual(at(-5), true, 'below best, iron still generates here — nothing else would run');
  assert.strictEqual(at(40), false, 'above best is goDeep\'s job');
  assert.strictEqual(at(-40), false, 'below the band there is no iron to find');
});

check('below everything it needs, explore climbs instead of wandering', () => {
  const { neededBandFloor } = require('../src/behaviors/explore');
  const deep = botWith({ stone_pickaxe: 1 }); // needs iron; can't mine diamond
  deep.entity.position.y = -40;
  assert.strictEqual(neededBandFloor(deep), -22, 'just inside iron\'s band');
  const fine = botWith({ stone_pickaxe: 1 });
  fine.entity.position.y = 0;
  assert.strictEqual(neededBandFloor(fine), null, 'inside the band: nothing to climb for');
});

// The 13:38 session smelted eight batches of one and two raw iron, each a
// walk to the furnace and back.
check('ore is smelted in batches, unless a small one finishes the next piece', () => {
  const { oreWorthABatch, ORE_BATCH } = require('../src/behaviors/smelt');
  // Tools and shield done; the cheapest missing piece is boots, 4 iron.
  const kitted = { diamond_pickaxe: 1, diamond_sword: 1, shield: 1 };
  assert.strictEqual(oreWorthABatch(botWith({ ...kitted, raw_iron: 2 })), false, 'two raw iron finish nothing');
  assert.strictEqual(oreWorthABatch(botWith({ ...kitted, raw_iron: 4 })), true, 'four make the boots');
  assert.strictEqual(oreWorthABatch(botWith({ ...kitted, raw_iron: 2, iron_ingot: 4 })), false, 'the ingots already cover them');
  assert.strictEqual(oreWorthABatch(botWith({ ...kitted, raw_iron: ORE_BATCH })), true, 'a full batch always goes');
});

check('iron tools outgrown by diamond ones stop counting as iron to find', () => {
  const { ironStillNeeded, IRON_COST } = require('../src/behaviors/gear');
  const armour = IRON_COST.iron_helmet + IRON_COST.iron_chestplate + IRON_COST.iron_leggings + IRON_COST.iron_boots;
  const diamondTools = botWith({ diamond_pickaxe: 1, diamond_sword: 1 });
  assert.strictEqual(ironStillNeeded(diamondTools), armour + IRON_COST.shield);
  // 17 → 14 → 17 on 09-24: throwing the spare iron pickaxe must not make the
  // bot want three more iron to replace it.
  const withSpare = botWith({ diamond_pickaxe: 1, diamond_sword: 1, iron_pickaxe: 1 });
  assert.strictEqual(ironStillNeeded(withSpare), ironStillNeeded(diamondTools));
});

check('iron cooking in a furnace is still iron', () => {
  const { ironStillNeeded } = require('../src/behaviors/gear');
  const bot = botWith({ stone_pickaxe: 1, raw_iron: 2 });
  const before = ironStillNeeded(bot);
  bot.inventory.items = () => [{ name: 'stone_pickaxe', count: 1, type: 1 }];
  bot.smeltingBatch = { expecting: 'iron_ingot', count: 2 };
  assert.strictEqual(ironStillNeeded(bot), before, 'loading the furnace must not make the bot poorer');
});

check('smelted iron still counts as iron', () => {
  // Counting only the raw drop made the bot re-mine 24 iron the moment it
  // smelted what it had.
  const bot = botWith({ torch: 16, stone_pickaxe: 1, iron_ingot: ENOUGH.raw_iron });
  assert.notStrictEqual(neededResource(bot), 'raw_iron');
});

console.log('\nsupplies before descending');

check('a fully kitted bot is ready', () => {
  assert.deepStrictEqual(deepTripShortfall(botWith(tripKit())), []);
});

check('missing essentials are named', () => {
  const bot = botWith({});
  const missing = deepTripShortfall(bot);
  for (const need of ['food', 'wood', 'blocks', 'weapon']) {
    assert.ok(missing.includes(need), `${need} should be reported missing`);
  }
});

// A wooden sword is not a weapon for this trip. It does 4 damage and breaks in
// 59 hits; a stone one costs two cobblestone the bot is already carrying.
check('a wooden sword does not count as being armed for the descent', () => {
  const wooden = tripKit();
  delete wooden.stone_sword;
  assert.ok(deepTripShortfall(botWith({ ...wooden, wooden_sword: 1 })).includes('weapon'));
});

// ...but an axe does, if it is a good enough one. Losing the sword should not
// send a bot carrying an iron axe back to the surface.
check('a decent axe counts as a weapon', () => {
  const noSword = tripKit();
  delete noSword.stone_sword;
  assert.ok(!deepTripShortfall(botWith({ ...noSword, iron_axe: 1 })).includes('weapon'));
});

// Torches are deliberately NOT on that list while fullbright is on.
check('torches never block the trip under fullbright', () => {
  assert.ok(!deepTripShortfall(botWith({})).includes('torches'));
});

check('raw meat counts as trip food — it is still food underground', () => {
  const raw = tripKit({ beef: DEEP_TRIP_NEEDS.food });
  delete raw.cooked_beef;
  assert.ok(!deepTripShortfall(botWith(raw)).includes('food'));
});

console.log('\nwhat to build next');

// The pickaxe is the only tool the run is gated on: wooden gets stone,
// stone gets iron, iron gets diamond. A sword makes the bot safer at the
// tier it is already stuck on. Both are seconds apart at a table.
check('with nothing but logs, it makes a wooden pickaxe first', () => {
  const goal = nextGoal(botWith({ oak_log: 5 }));
  assert.ok(goal, 'should want something');
  assert.strictEqual(goal.item, 'wooden_pickaxe', 'the pickaxe unlocks the next tier');
});

check('and the sword right after it, not instead of it', () => {
  const goal = nextGoal(botWith({ oak_log: 5, wooden_pickaxe: 1 }));
  assert.strictEqual(goal.item, 'wooden_sword');
});

check('cobblestone upgrades tools to stone', () => {
  const goal = nextGoal(botWith({
    oak_log: 5, stick: 8, cobblestone: 20, wooden_sword: 1, wooden_pickaxe: 1, wooden_axe: 1,
  }));
  assert.ok(goal.item.startsWith('stone_'), `expected a stone tool, got ${goal.item}`);
});

check('diamonds upgrade tools past iron — the missing tier', () => {
  const goal = nextGoal(botWith({
    stick: 8, oak_planks: 8, diamond: 12,
    iron_sword: 1, iron_pickaxe: 1, iron_axe: 1,
  }));
  assert.ok(goal, 'diamond tools must be craftable');
  assert.ok(goal.item.startsWith('diamond_'), `expected a diamond tool, got ${goal.item}`);
});

check('armour is built chestplate-first for protection per diamond', () => {
  const goal = nextGoal(botWith({
    stick: 8, oak_planks: 8, diamond: 8,
    diamond_sword: 1, diamond_pickaxe: 1, diamond_axe: 1,
  }));
  assert.strictEqual(goal.kind, 'armor');
  assert.strictEqual(goal.item, 'diamond_chestplate');
});

// Torches are gone entirely — see the note in gear.js. A fully equipped bot
// holding the materials for them wants nothing, rather than stopping to make
// something it was never any good at placing.
check('torches are never a goal, however much charcoal is in the bag', () => {
  const goal = nextGoal(botWith(
    {
      charcoal: 64, stick: 64, diamond_sword: 1, diamond_pickaxe: 1, diamond_axe: 1,
    },
    FULL_DIAMOND_ARMOR,
  ));
  assert.strictEqual(goal, null, 'nothing left to build, and torches are not a thing we build');
});

check('armour already worn is not re-crafted', () => {
  const goal = nextGoal(botWith(
    {
      torch: 32, diamond: 30, stick: 8,
      diamond_sword: 1, diamond_pickaxe: 1, diamond_axe: 1,
    },
    FULL_DIAMOND_ARMOR,
  ));
  assert.strictEqual(goal, null, 'a full set is a full set, even with diamonds spare');
});

check('a fully equipped bot wants nothing more', () => {
  const bot = botWith(
    {
      torch: 32, diamond_sword: 1, diamond_pickaxe: 1, diamond_axe: 1,
    },
    FULL_DIAMOND_ARMOR,
  );
  assert.strictEqual(nextGoal(bot), null, 'nothing left to build');
});

check('diamond armour replaces iron, but iron never replaces diamond', () => {
  const upgrading = nextGoal(botWith(
    { diamond: 8, stick: 8, diamond_sword: 1, diamond_pickaxe: 1, diamond_axe: 1 },
    { torso: 'iron_chestplate' },
  ));
  assert.strictEqual(upgrading.item, 'diamond_chestplate', 'diamond must beat iron');

  const downgrading = nextGoal(botWith(
    { iron_ingot: 24, stick: 8, diamond_sword: 1, diamond_pickaxe: 1, diamond_axe: 1 },
    FULL_DIAMOND_ARMOR,
  ));
  assert.strictEqual(downgrading, null, 'iron must never replace diamond');
});

console.log('\ntool wear');

// A stone pickaxe lasts 131 blocks and this bot mines constantly. Watched
// live, its pickaxe broke and it silently fell back to a WOODEN one — which
// cannot mine iron at all — undoing the progression with no error anywhere.
function worn(name, fraction) {
  const maxDurability = 131;
  return {
    name,
    count: 1,
    type: 1,
    maxDurability,
    durabilityUsed: Math.round(maxDurability * (1 - fraction)),
  };
}

function botWithTools(items, tools) {
  const bot = botWith(items);
  const base = bot.inventory.items();
  bot.inventory.items = () => [...base, ...tools];
  return bot;
}

check('a nearly-dead pickaxe is replaced before it breaks', () => {
  const bot = botWithTools(
    { cobblestone: 20, stick: 8, stone_sword: 1, stone_axe: 1 },
    [worn('stone_pickaxe', 0.05)],
  );
  const goal = nextGoal(bot);
  assert.ok(goal, 'a 5%-durability pickaxe must be replaced');
  assert.strictEqual(goal.item, 'stone_pickaxe');
});

check('a half-worn pickaxe earns a spare, while materials are still to hand', () => {
  const bot = botWithTools(
    { cobblestone: 20, stick: 8, stone_sword: 1, stone_axe: 1 },
    [worn('stone_pickaxe', 0.4)],
  );
  const goal = nextGoal(bot);
  assert.ok(goal && goal.item === 'stone_pickaxe', 'should build the backup now');
});

check('a healthy pickaxe is left alone — no hoarding', () => {
  const bot = botWithTools(
    { cobblestone: 20, stick: 8, stone_sword: 1, stone_axe: 1 },
    [worn('stone_pickaxe', 0.95)],
  );
  assert.strictEqual(nextGoal(bot), null, 'nothing to do but dig');
});

// The two-per-type cap counted the WOODEN pickaxe the bot had outgrown, so a
// worn stone pickaxe plus that wooden one was "two" and no spare could ever be
// made. Watched live going down a staircase: pick stone, then wooden, then
// none, with 240 cobblestone in the bag.
check('an outgrown wooden pickaxe is not the spare for a worn stone one', () => {
  const bot = botWithTools(
    { cobblestone: 20, stick: 8, stone_sword: 1, stone_axe: 1 },
    [worn('stone_pickaxe', 0.4), worn('wooden_pickaxe', 1)],
  );
  const goal = nextGoal(bot);
  assert.ok(goal && goal.item === 'stone_pickaxe', 'the real spare must still be built');
});

check('...and a dying stone pickaxe is still replaced with the wooden one in the bag', () => {
  const bot = botWithTools(
    { cobblestone: 20, stick: 8, stone_sword: 1, stone_axe: 1 },
    [worn('stone_pickaxe', 0.05), worn('wooden_pickaxe', 1)],
  );
  const goal = nextGoal(bot);
  assert.ok(goal && goal.item === 'stone_pickaxe');
});

check('two good stone pickaxes are still the cap, wooden leftover or not', () => {
  const bot = botWithTools(
    { cobblestone: 20, stick: 8, stone_sword: 1, stone_axe: 1 },
    [worn('stone_pickaxe', 0.4), worn('stone_pickaxe', 1), worn('wooden_pickaxe', 1)],
  );
  assert.strictEqual(nextGoal(bot), null, 'a third stone pickaxe is never the answer');
});

check('a worn pickaxe blocks the deep trip', () => {
  const kitted = tripKit();
  delete kitted.stone_pickaxe; // the tools come from botWithTools here
  const ok = botWithTools(kitted, [worn('iron_pickaxe', 0.9)]);
  assert.ok(!deepTripShortfall(ok).includes('pickaxe'));

  const dying = botWithTools(kitted, [worn('iron_pickaxe', 0.05)]);
  assert.ok(
    deepTripShortfall(dying).includes('pickaxe'),
    'a pickaxe about to break is the same as no pickaxe once you are 130 blocks down',
  );
});

console.log('\nthe goal itself');

check('the diamond target covers the whole kit', () => {
  // pickaxe 3 + sword 2 + chestplate 8 + leggings 7 + helmet 5 + boots 4
  assert.strictEqual(DIAMOND_GOAL, 29);
  assert.ok(ENOUGH.diamond >= DIAMOND_GOAL, 'must keep mining until the set is affordable');
});

console.log('\nmaking charcoal, which unblocks torches');

/**
 * Distinct `type` per item, unlike botWith above — the whole point of one of
 * these checks is that the furnace must not be handed the same stack as both
 * fuel and input.
 */
function smelterBot(items) {
  const list = Object.entries(items)
    .map(([name, count], i) => ({ name, count, type: 100 + i }));
  return {
    inventory: { items: () => list },
    registry: { itemsByName },
  };
}

// The bug this was written for: `neededResource` demands coal before iron,
// `gear` can make torches out of charcoal, and nothing produced any — so the
// bot strip-mined at y=63 hunting coal ore with logs in the bag and a furnace
// beside it, and never reached iron at all.
check('spare logs get turned into charcoal', () => {
  const bot = smelterBot({ oak_log: LOG_RESERVE + 4 });
  const raw = smeltableItem(bot);
  assert.ok(raw, 'should want to smelt something');
  assert.strictEqual(raw.name, 'oak_log');
  assert.strictEqual(smeltOutputName(raw.name), 'charcoal');
});

check('the wood reserve is respected — planks and sticks come first', () => {
  const bot = smelterBot({ oak_log: LOG_RESERVE });
  assert.strictEqual(smeltableItem(bot), null, 'must not burn the last logs');
});

check('already having fuel means no logs are burned', () => {
  const bot = smelterBot({ oak_log: LOG_RESERVE + 20, coal: 4 });
  assert.strictEqual(smeltableItem(bot), null);
});

check('charcoal counts toward that stock, not just coal', () => {
  const bot = smelterBot({ oak_log: LOG_RESERVE + 20, charcoal: 4 });
  assert.strictEqual(smeltableItem(bot), null);
});

check('ore still outranks wood — it is the real progression gate', () => {
  const bot = smelterBot({ oak_log: LOG_RESERVE + 8, raw_iron: 3 });
  assert.strictEqual(smeltableItem(bot).name, 'raw_iron');
});

check('raw food outranks both when there is nothing cooked to eat', () => {
  const bot = smelterBot({ oak_log: LOG_RESERVE + 8, raw_iron: 3, beef: 2 });
  assert.strictEqual(smeltableItem(bot).name, 'beef');
});

// Feeding one stack in as both fuel and input is a window transaction
// fighting itself, and the furnace ends up missing one of the two.
check('a log being smelted is never also used as its own fuel', () => {
  const bot = smelterBot({ oak_log: LOG_RESERVE + 4 });
  const raw = smeltableItem(bot);
  assert.strictEqual(fuelItem(bot, raw.type), null, 'no other fuel exists here');
});

check('a different log stack is fine as fuel', () => {
  const bot = smelterBot({ oak_log: LOG_RESERVE + 4, birch_log: 8 });
  const raw = smeltableItem(bot);
  const fuel = fuelItem(bot, raw.type);
  assert.ok(fuel, 'should find fuel');
  assert.notStrictEqual(fuel.type, raw.type);
});

console.log('\nthe fuel supply has to bootstrap itself');

// Coal is no longer something the bot goes prospecting for, so charcoal from
// logs IS the fuel supply — and a supply that cannot start itself is no
// supply at all. No fuel means no cooked food and no smelted iron.
check('one log stack alone can still fuel its own charcoal', () => {
  // The input is the only log, so fuelItem correctly refuses to use that
  // same stack as fuel too — but one log from it becomes four planks, which
  // are a different item and burn perfectly well.
  const bot = smelterBot({ oak_log: LOG_RESERVE + 4 });
  const raw = smeltableItem(bot);
  assert.strictEqual(raw.name, 'oak_log');
  assert.strictEqual(fuelItem(bot, raw.type), null, 'nothing burnable as-is');
  assert.strictEqual(canFuel(bot, raw.type), true, 'but planks are one craft away');
});

check('a single lone log cannot fuel itself', () => {
  // Converting the only log leaves nothing to smelt.
  const bot = smelterBot({ oak_log: 1 });
  const onlyLog = bot.inventory.items()[0];
  assert.strictEqual(canFuel(bot, onlyLog.type), false);
});

check('cooking meat burns logs directly — no craft needed', () => {
  const bot = smelterBot({ beef: 3, oak_log: 4 });
  const raw = smeltableItem(bot);
  assert.strictEqual(raw.name, 'beef');
  assert.ok(fuelItem(bot, raw.type), 'a log is fuel for anything that is not a log');
});

check('coal is used as fuel when we happen to have it', () => {
  const bot = smelterBot({ raw_iron: 4, coal: 2 });
  const raw = smeltableItem(bot);
  assert.strictEqual(raw.name, 'raw_iron');
  assert.strictEqual(fuelItem(bot, raw.type).name, 'coal');
});

// Coal is saved for last on purpose: it is the only torch material, and
// burning it to cook three steaks when logs are in the bag is a bad trade.
check('but logs and charcoal are spent before coal', () => {
  const bot = smelterBot({ raw_iron: 4, coal: 8, oak_log: 8, charcoal: 2 });
  assert.strictEqual(fuelItem(bot, null).name, 'charcoal');
  const noCharcoal = smelterBot({ raw_iron: 4, coal: 8, oak_log: 8 });
  assert.strictEqual(fuelItem(noCharcoal, null).name, 'oak_log');
});

check('genuinely nothing burnable is reported honestly', () => {
  const bot = smelterBot({ raw_iron: 4 });
  assert.strictEqual(canFuel(bot, null), false);
});

// Three places counted wood and one of them disagreed: gear.js and the
// resupply check both treat a log as four planks, but deepTripShortfall
// looked only at planks and sticks. A bot holding ten logs — forty planks'
// worth — reported "need: wood" and refused to descend, permanently.
check('logs count as wood, so a bot carrying them can descend', () => {
  const kitted = tripKit({ oak_log: Math.ceil(DEEP_TRIP_NEEDS.planks / 4) });
  delete kitted.oak_planks;
  assert.deepStrictEqual(deepTripShortfall(botWith(kitted)), []);
});

check('but genuinely having no wood is still reported', () => {
  const noWood = tripKit();
  delete noWood.oak_planks;
  assert.ok(deepTripShortfall(botWith(noWood)).includes('wood'));
});

console.log('\nwood is upstream of everything');

/**
 * The loop this breaks, caught on the live dashboard:
 *
 *   no wood -> no fuel -> no cooking -> only raw meat, which the eating
 *   policy refuses -> food stock stays at zero -> `forage` (46) runs
 *   forever -> `wood` (10) never gets the wheel -> still no wood.
 *
 * The bot was standing in plains with ten cobblestone, two sticks, no logs
 * and no food, foraging in circles. It also cannot descend without sixteen
 * planks' worth, so this blocks iron outright.
 */
function forestBot(items, food = 18) {
  const list = Object.entries(items).map(([name, count], i) => ({ name, count, type: 500 + i }));
  return {
    food,
    entity: { position: { x: 0, y: 70, z: 0 } },
    inventory: { items: () => list, slots: [] },
    // woodUrgent now asks gear whether there is a tool worth building instead
    // of chopping, and armorUpgrade reads the worn armour slots to answer.
    getEquipmentDestSlot: (slot) => ARMOR_SLOT_INDEX[slot],
    registry: { itemsByName, blocksByName: { oak_log: { id: 17 } } },
    // A log is always in range, so the test is about the gate, not the
    // search. findBlocks returns Vec3s, and trunkBase walks down from one.
    findBlocks: () => [new Vec3(5, 70, 0)],
    blockAt: (p) => (p.y >= 70
      ? { name: 'oak_log', position: new Vec3(p.x, p.y, p.z), boundingBox: 'block' }
      : { name: 'dirt', position: new Vec3(p.x, p.y, p.z), boundingBox: 'block' }),
  };
}
const woodCtx = () => ({ wood: { candidate: null, lastScanAt: 0, skipped: new Map() } });

check('with no wood at all, chopping outranks foraging', () => {
  // No sticks and no planks, so there is nothing craftable to do instead.
  const bot = forestBot({ cobblestone: 10 });
  assert.strictEqual(woodUrgent.shouldRun(bot, woodCtx()), true);
  assert.ok(woodUrgent.priority > 46, 'must outrank forage');
});

// Wood is a MEANS, and woodUrgent (47) sits above gear (40) — so while the
// supply is low the bot chops and never crafts. Found live: fourteen wood
// units, a hundred and eighty cobblestone, and no stone pickaxe, because the
// pickaxe costs two sticks and it was too busy fetching more wood to spend
// them. Crafting takes seconds; the supply run can wait that long.
check('a tool we could build right now beats fetching more wood', () => {
  const canBuildAPickaxe = forestBot({ cobblestone: 10, stick: 2 });
  assert.ok(nextGoal(canBuildAPickaxe), 'the fixture should have something to craft');
  assert.strictEqual(woodUrgent.shouldRun(canBuildAPickaxe, woodCtx()), false);
});

check('...but only for tools; it does not stand down for anything else', () => {
  // Fully tooled at stone tier with nothing else affordable: nothing to craft,
  // so the supply run is the right call again.
  const tooled = forestBot({
    cobblestone: 10, stone_pickaxe: 1, stone_sword: 1, stone_axe: 1,
  });
  assert.strictEqual(nextGoal(tooled), null, 'fixture should want nothing');
  assert.strictEqual(woodUrgent.shouldRun(tooled, woodCtx()), true);
});

check('with a working supply it stands down and lets everything else run', () => {
  const bot = forestBot({ oak_log: 4 });
  assert.strictEqual(woodUrgent.shouldRun(bot, woodCtx()), false);
});

// Actually starving still beats chopping — huntUrgent is gated on being
// hungry, and this steps aside below that threshold.
check('genuine starvation still comes first', () => {
  const bot = forestBot({ cobblestone: 10 }, 5);
  assert.strictEqual(woodUrgent.shouldRun(bot, woodCtx()), false);
});

check('planks and logs both count, so it is not fooled by form', () => {
  // Twenty units either way — five logs or twenty planks — is past the bar.
  assert.strictEqual(woodUrgent.shouldRun(forestBot({ oak_planks: 20 }), woodCtx()), false);
  assert.strictEqual(woodUrgent.shouldRun(forestBot({ oak_log: 5 }), woodCtx()), false);
});

// The priority-10 filler used to count logs only, against 32 of them: a bag
// of planks read as empty, and it kept chopping to 128 units — twice what a
// restock stops at — in a different unit from everything else.
check('the wood filler stops where a restock does, and planks count', () => {
  const planks = RESTOCK_WOOD;
  assert.strictEqual(wood.shouldRun(forestBot({ oak_planks: planks }), woodCtx()), false);
  assert.strictEqual(wood.shouldRun(forestBot({ oak_log: planks / 4 }), woodCtx()), false);
  assert.strictEqual(wood.shouldRun(forestBot({ oak_planks: planks - 4 }), woodCtx()), true);
});

// The dead zone this threshold was raised to close. At four units the old
// rule called the supply healthy, forage stood down because the hunger bar
// was full, and `wood` at priority 10 never got the wheel — so the bot
// oscillated between resupply and gatherStone for minutes with no wood.
check('a supply too small for a descent is still urgent', () => {
  // Already tooled, so the crafting exemption above does not apply and the
  // only question left is whether four units is enough. It is not.
  const kit = { stone_pickaxe: 1, stone_sword: 1, stone_axe: 1 };
  assert.strictEqual(woodUrgent.shouldRun(forestBot({ ...kit, oak_log: 1 }), woodCtx()), true);
  assert.strictEqual(woodUrgent.shouldRun(forestBot({ ...kit, oak_planks: 8 }), woodCtx()), true);
});

// ...and it is the SAME number the descent asks for, not a second opinion.
check('the urgency threshold is the descent requirement, not a separate guess', () => {
  const justEnough = forestBot({ oak_planks: DEEP_TRIP_NEEDS.planks });
  assert.strictEqual(woodUrgent.shouldRun(justEnough, woodCtx()), false);
  assert.ok(!deepTripShortfall(justEnough).includes('wood'));
});

console.log('\nthe gate to iron');

/**
 * `goDeep.shouldRun` is the single decision that separates a bot at stone
 * tier from a bot at iron, and it is a chain of five conditions in series.
 * Every one of them has been wrong at some point, each time producing the
 * same symptom — a bot that mines contentedly on the surface forever — and
 * none of them announce themselves when they fail.
 */
function surfaceBot(items, y = 70) {
  const list = Object.entries(items).map(([name, count], i) => ({ name, count, type: 400 + i }));
  return {
    // A stub position rather than a real Vec3, because several checks here want
    // a fixed distance to a station. `clone` returns itself: nothing in these
    // tests mutates it, and the scan throttling that calls it only needs
    // something it can measure a distance from on a later pass.
    // `floored` because descentShortfall now asks isUnderground below sea
    // level, which probes the column above the head; with blockAt returning
    // null that falls back to the depth rule, exactly as before.
    entity: {
      position: {
        x: 0, y, z: 0, distanceTo: () => 5, clone() { return this; }, floored: () => new Vec3(0, Math.floor(y), 0),
      },
    },
    inventory: { items: () => list, slots: [] },
    getEquipmentDestSlot: () => 5,
    registry: { itemsByName, blocksByName: {} },
    findBlocks: () => [],
    blockAt: () => null,
  };
}

const deepCtx = () => ({
  mine: {
    candidate: null,
    lastScanAt: 0,
    skipped: new Map(),
    verdicts: new Map(),
    descentBlockedUntil: 0,
    lastShortfall: null,
  },
});

// Everything the trip needs, on the surface, with iron still to find.
const READY_TO_DESCEND = tripKit();

check('a properly supplied bot on the surface goes down for iron', () => {
  assert.strictEqual(goDeep.shouldRun(surfaceBot(READY_TO_DESCEND), deepCtx()), true);
});

check('and it aims at the depth iron actually peaks at', () => {
  // Iron's band reaches y=56, but it peaks at 16. Stopping at the band edge
  // put the bot forty blocks above the ore and it strip-mined empty rock.
  assert.strictEqual(ORE_DEPTH.raw_iron.best, 16);
  const atBand = surfaceBot(READY_TO_DESCEND, 50); // inside the band, far above the peak
  assert.strictEqual(goDeep.shouldRun(atBand, deepCtx()), true, 'still worth descending');
});

check('once at the peak it stops descending', () => {
  assert.strictEqual(goDeep.shouldRun(surfaceBot(READY_TO_DESCEND, 16), deepCtx()), false);
});

check('a wooden pickaxe never goes down — it cannot harvest iron', () => {
  const wooden = { ...READY_TO_DESCEND, stone_pickaxe: 0, wooden_pickaxe: 1 };
  delete wooden.stone_pickaxe;
  assert.strictEqual(goDeep.shouldRun(surfaceBot(wooden), deepCtx()), false);
});

check('each missing supply blocks it, and is named', () => {
  for (const missing of ['cooked_beef', 'oak_planks', 'stone_sword']) {
    const short = { ...READY_TO_DESCEND };
    delete short[missing];
    const ctx = deepCtx();
    assert.strictEqual(goDeep.shouldRun(surfaceBot(short), ctx), false, `missing ${missing}`);
    assert.ok(ctx.mine.lastShortfall, `should report what ${missing} is short of`);
  }
});

check('too little cobblestone blocks it — no blocks to climb back out with', () => {
  const short = { ...READY_TO_DESCEND, cobblestone: 4 };
  assert.strictEqual(goDeep.shouldRun(surfaceBot(short), deepCtx()), false);
});

console.log('\nthe gap between "enough to work" and "enough to descend"');

// The dead zone. goDeep wants 16 wood units, resupply used to fire only below
// 6, and there are no trees at y=48 — so a bot holding 8 could neither go down
// nor go up, and not one behavior in the set would fix it. Two individually
// reasonable thresholds, jointly impossible.
const STUCK_MIDWAY = (() => {
  const kit = tripKit({ oak_log: 2 });
  delete kit.oak_planks; // 8 units: past the survival line, short of the trip bar
  return kit;
})();

/**
 * Same bot, but with a position isUnderground can actually probe from — it
 * reads a column of blocks above the head, so it needs a real Vec3. blockAt
 * returns null here, which is "chunk not loaded", and the fallback for that
 * is the depth rule: below y=50 counts as underground.
 */
function deepBot(items, y) {
  const bot = surfaceBot(items, y);
  bot.entity.position = new Vec3(0, y, 0);
  return bot;
}

// 2 logs is 8 units: past the survival line of 6, short of the 16 a trip is
// STARTED with. That gap used to stop the descent dead — goDeep re-checked
// the full kit list on every step down, so burning one plank at y=34 sent the
// bot back to the surface for a log and then down again. Deepest point of an
// entire session: y=34, against a target of 16.
check('underground and a little short, it presses on rather than climbing', () => {
  const bot = deepBot(STUCK_MIDWAY, 48);
  assert.strictEqual(resupply.shouldRun(bot, deepCtx()), false, 'should not climb');
  assert.strictEqual(goDeep.shouldRun(bot, deepCtx()), true, 'should keep descending');
});

// ...but the full kit is still demanded before SETTING OFF, because
// everything on that list is cheap on the surface and impossible at depth.
check('on the surface the same supply is not enough to set off with', () => {
  const ctx = deepCtx();
  assert.strictEqual(goDeep.shouldRun(surfaceBot(STUCK_MIDWAY, 70), ctx), false);
  assert.ok(ctx.mine.lastShortfall, 'and it says what it is short of');
});

check('and it still climbs when genuinely out of wood', () => {
  const none = { ...STUCK_MIDWAY };
  delete none.oak_log;
  assert.strictEqual(resupply.shouldRun(deepBot(none, 48), deepCtx()), true);
});

// ...but not once it is standing where the ore actually is. Otherwise the
// trigger never switches off and the bot spends the whole run climbing.
check('at the depth iron peaks at, low wood is no longer a reason to climb', () => {
  assert.strictEqual(resupply.shouldRun(deepBot(STUCK_MIDWAY, 16), deepCtx()), false);
});

// 09-25: nineteen blocks down the night staircase, "need: food" on the status
// line. Climbing out into the dark for that throws the descent away.
check('not up to the surface at night for a top-up', () => {
  const none = { ...STUCK_MIDWAY };
  delete none.oak_log;
  const bot = deepBot(none, 48);
  bot.time = { timeOfDay: 18000 };
  assert.strictEqual(resupply.shouldRun(bot, deepCtx()), false);
  bot.time = { timeOfDay: 6000 };
  assert.strictEqual(resupply.shouldRun(bot, deepCtx()), true, 'by day the same shortfall is a trip up');
});

check('a properly supplied bot underground stays underground', () => {
  const stocked = { ...STUCK_MIDWAY, oak_log: 8 };
  assert.strictEqual(resupply.shouldRun(deepBot(stocked, 48), deepCtx()), false);
});

console.log('\nnot digging while short of what digging cannot provide');

/**
 * The reported bottleneck, as a regression guard.
 *
 * stripMine sits at priority 23, `wood` at 10 and `hunt` at 12 — so once the
 * bot started speculatively digging it outranked the only two behaviors that
 * could fix what was blocking it. Observed live: a 60-block tunnel at y=69
 * hunting coal, with "need: food,wood" on every status line, while the
 * charcoal that would have ended the search needs logs it was too busy to cut.
 */
function minerBot(items, y = 16) {
  const list = Object.entries(items).map(([name, count], i) => ({ name, count, type: 200 + i }));
  return {
    // A stub position rather than a real Vec3, because several checks here want
    // a fixed distance to a station. `clone` returns itself: nothing in these
    // tests mutates it, and the scan throttling that calls it only needs
    // something it can measure a distance from on a later pass.
    // `floored` because descentShortfall now asks isUnderground below sea
    // level, which probes the column above the head; with blockAt returning
    // null that falls back to the depth rule, exactly as before.
    entity: {
      position: {
        x: 0, y, z: 0, distanceTo: () => 5, clone() { return this; }, floored: () => new Vec3(0, Math.floor(y), 0),
      },
    },
    inventory: { items: () => list },
    registry: { itemsByName, blocksByName: {} },
    findBlocks: () => [],
    blockAt: () => null,
  };
}

const minerCtx = () => ({
  mine: {
    candidate: null, lastScanAt: 0, skipped: new Map(), verdicts: new Map(), lastShortfall: null,
  },
});

// Kitted out and at the right depth: digging is exactly right.
check('a supplied bot at the right depth strip-mines', () => {
  const bot = minerBot({
    stone_pickaxe: 1, cooked_beef: 6, oak_planks: 20, cobblestone: 30, torch: 8,
  });
  assert.strictEqual(stripMine.shouldRun(bot, minerCtx()), true);
});

check('out of food, it stops digging and lets hunting have a turn', () => {
  const bot = minerBot({
    stone_pickaxe: 1, oak_planks: 20, cobblestone: 30, torch: 8,
  });
  assert.strictEqual(stripMine.shouldRun(bot, minerCtx()), false);
});

check('out of wood, it stops digging and lets chopping have a turn', () => {
  const bot = minerBot({
    stone_pickaxe: 1, cooked_beef: 6, cobblestone: 30, torch: 8,
  });
  assert.strictEqual(stripMine.shouldRun(bot, minerCtx()), false);
});

// Cobblestone and coal ARE down here. Surfacing for those would be the same
// mistake in reverse.
check('low on cobblestone is not a reason to stop — that is what mining is', () => {
  const bot = minerBot({
    stone_pickaxe: 1, cooked_beef: 6, oak_planks: 20, torch: 8,
  });
  assert.strictEqual(stripMine.shouldRun(bot, minerCtx()), true);
});

check('and the shortfall is reported, so the status line explains the pause', () => {
  const ctx = minerCtx();
  const bot = minerBot({ stone_pickaxe: 1, cobblestone: 30, torch: 8 });
  stripMine.shouldRun(bot, ctx);
  assert.ok(ctx.mine.lastShortfall, 'should say what it is waiting on');
  assert.ok(ctx.mine.lastShortfall.includes('food'));
});

// "Underground" was a height, and the height was sea level. Beaches, swamps
// and river banks sit at 62, so a bot standing in open grass there was treated
// as already underground — both by forage, which set off uphill in search of
// sky it was standing under (44 of 48 logged "Hungry underground" lines were
// at y=62–64), and by the descent, which let it START a trip on the lenient
// keep-going bar instead of the full kit.
console.log('\nlow ground is not underground');

/** A bot at y=62 under open sky, or under a stone roof, with real positions. */
function lowBot(items, roofed) {
  const bot = deepBot(items, 62);
  bot.blockAt = (p) => (roofed && p.y >= 64
    ? { name: 'stone', boundingBox: 'block', position: p }
    : { name: 'air', boundingBox: 'empty', position: p });
  return bot;
}

// Enough to keep a trip going (2 food, 6 wood), nowhere near enough to start one.
const halfKit = {
  stone_pickaxe: 1, stone_sword: 1, cooked_beef: 3, oak_planks: 10, cobblestone: DEEP_TRIP_NEEDS.placeable,
};

check('hungry in an open field at sea level does not mean climbing', () => {
  const { shouldClimbForFood } = require('../src/behaviors/hunt');
  assert.strictEqual(shouldClimbForFood(lowBot({}, false)), false);
  assert.strictEqual(shouldClimbForFood(lowBot({}, true)), true, 'under a roof it still climbs');
});

check('a descent is not STARTED from open sky on the keep-going bar', () => {
  const ctx = deepCtx();
  assert.strictEqual(goDeep.shouldRun(lowBot(halfKit, false), ctx), false);
  assert.ok(ctx.mine.lastShortfall.includes('food'), 'the full kit is what it is waiting on');
});

check('...but under a roof at the same height it is already a trip, and carries on', () => {
  assert.strictEqual(goDeep.shouldRun(lowBot(halfKit, true), deepCtx()), true);
});

// "When the bot gets wood from a tree make it mine the full tree": the logs
// the trunk pass cannot reach are part of the tree too — but a cabin is not.
console.log('\nthe whole tree, and only the tree');

{
  const { treeLogs } = require('../src/behaviors/wood');
  const Vec3Tree = require('vec3');
  const worldOf = (cells) => ({
    blockAt: (p) => ({ name: cells[`${p.x},${p.y},${p.z}`] ?? 'air', position: p }),
  });
  // An oak: five-log trunk, a two-log branch, leaves on top — and a birch
  // touching its branch, which is a different tree.
  const oak = {};
  for (let y = 64; y <= 68; y++) oak[`0,${y},0`] = 'oak_log';
  oak['1,68,1'] = 'oak_log';
  oak['2,69,1'] = 'oak_log';
  oak['0,69,0'] = 'oak_leaves';
  oak['3,69,1'] = 'birch_log';
  const logs = treeLogs(worldOf(oak), new Vec3Tree(0, 64, 0));
  const keys = logs.map((p) => `${p.x},${p.y},${p.z}`);

  check('the trunk top and the branches are all found', () => {
    for (const k of ['0,68,0', '1,68,1', '2,69,1']) assert.ok(keys.includes(k), `missing ${k}`);
  });

  check('a neighbouring tree of another kind is not', () => {
    assert.ok(!keys.includes('3,69,1'));
  });

  check('a tree it keeps failing to reach is left alone longer each time', () => {
    const { holdTree, UNREACHABLE_HOLD_MAX_MS } = require('../src/behaviors/wood');
    const ctx = { wood: { skipped: new Map() } };
    const holds = [1, 2, 3, 4, 5, 6, 7, 8].map(() => holdTree(ctx, '-295,89,334'));
    for (let i = 1; i < holds.length; i++) assert.ok(holds[i] >= holds[i - 1]);
    assert.strictEqual(holds[1], holds[0] * 2);
    assert.strictEqual(holds.at(-1), UNREACHABLE_HOLD_MAX_MS, 'capped, never forever');
    assert.strictEqual(holdTree(ctx, 'another tree'), holds[0], 'strikes are per tree');
  });

  check('logs with no leaves anywhere are a building, not a tree', () => {
    const cabin = {};
    for (let y = 64; y <= 67; y++) { cabin[`0,${y},0`] = 'oak_log'; cabin[`1,${y},0`] = 'oak_log'; }
    assert.deepStrictEqual(treeLogs(worldOf(cabin), new Vec3Tree(0, 64, 0)), []);
  });
}

// "Make a perfect hardcoded progression system and when to bypass it."
console.log('\nthe phases, in order, and the bypasses');

{
  const progression = require('../src/progression');
  const Vec3P = require('vec3');
  const registry = require('minecraft-data')('1.21.9');
  const {
    PHASES, PHASE_INDEX, allows, phaseOf,
  } = progression;
  const FLOOR = 50;

  // A bot on open grass (or, with `underground`, under a stone roof).
  function stage(stacks, { underground = false, animalAt = null } = {}) {
    const items = stacks.map(([name, count], i) => ({
      name, count, type: 1000 + i, maxDurability: 250, durabilityUsed: 0,
    }));
    const me = { position: new Vec3P(0.5, underground ? 20 : 70, 0.5) };
    const entities = { 1: me };
    if (animalAt !== null) entities[2] = { id: 2, name: 'cow', isValid: true, position: new Vec3P(animalAt, me.position.y, 0) };
    return {
      entity: me,
      entities,
      food: 20,
      registry,
      inventory: { items: () => items, slots: [] },
      getEquipmentDestSlot: () => 5,
      blockAt: (p) => {
        const solid = underground && p.y > 22;
        return { name: solid ? 'stone' : 'air', position: p, boundingBox: solid ? 'block' : 'empty' };
      },
    };
  }
  const fresh = () => ({ });
  const phase = (bot, ctx = fresh()) => PHASES[phaseOf(bot, ctx)]?.id ?? 'done';

  const logs = ['oak_log', 10]; // 40 planks: past the wood bar (32)
  const stoneKit = [['stone_pickaxe', 1], ['stone_sword', 1], ['stone_axe', 1]];
  const food = ['cooked_beef', 6];
  const cobble = ['cobblestone', 64];
  const ironKit = [['iron_pickaxe', 1], ['iron_pickaxe', 1], ['iron_sword', 1], ['shield', 1],
    ['iron_helmet', 1], ['iron_chestplate', 1], ['iron_leggings', 1], ['iron_boots', 1]];
  const diamondKit = [['diamond_pickaxe', 1], ['diamond_sword', 1], ['diamond_helmet', 1],
    ['diamond_chestplate', 1], ['diamond_leggings', 1], ['diamond_boots', 1]];

  check('an empty bag starts at wood', () => {
    assert.strictEqual(phase(stage([])), 'wood');
  });

  check('an empty bag to a full diamond kit walks the phases in order', () => {
    const walk = [
      [],
      [logs],
      [logs, ...stoneKit],
      [logs, ...stoneKit, food],
      [logs, ...stoneKit, food, cobble],
      [logs, ...stoneKit, food, cobble, ...ironKit],
      [logs, ...stoneKit, food, cobble, ...ironKit, ['diamond', 29]],
      [logs, food, cobble, ['stone_axe', 1], ...ironKit.slice(1), ...diamondKit],
    ].map((bag) => phase(stage(bag)));
    assert.deepStrictEqual(walk, ['wood', 'stoneKit', 'food', 'tripPrep', 'iron', 'diamonds', 'diamondKit', 'done']);
  });

  check('once past the food phase, eating down to 3 does not walk the bot out of the mine', () => {
    const ctx = fresh();
    const deepBag = [logs, ...stoneKit, food, cobble];
    assert.strictEqual(phase(stage(deepBag, { underground: true }), ctx), 'iron');
    ctx.progression.cachedAt = 0;
    const ateSome = [logs, ...stoneKit, ['cooked_beef', 3], cobble];
    assert.strictEqual(phase(stage(ateSome, { underground: true }), ctx), 'iron', 'the continue-the-trip bar holds');
  });

  check('...but losing the kit to a death drops it back to the start', () => {
    const ctx = fresh();
    phase(stage([logs, ...stoneKit, food, cobble]), ctx);
    ctx.progression.cachedAt = 0;
    assert.strictEqual(phase(stage([]), ctx), 'wood');
  });

  const behavior = (name, priority) => ({ name, priority });

  check('out-of-phase work is held back: no stone digging or mining while it still needs wood', () => {
    const bot = stage([]);
    const ctx = fresh();
    assert.strictEqual(allows(bot, ctx, behavior('gatherStone', 28), FLOOR), false);
    assert.strictEqual(allows(bot, ctx, behavior('mine', 25), FLOOR), false);
    assert.strictEqual(allows(bot, ctx, behavior('wood', 10), FLOOR), true);
  });

  check('survival and upkeep are never held back', () => {
    const bot = stage([]);
    for (const name of ['defend', 'shelter', 'escapeHazard']) {
      assert.strictEqual(allows(bot, fresh(), behavior(name, 91), FLOOR), true, name);
    }
    for (const name of ['collect', 'smelt', 'gear', 'woodUrgent', 'forage', 'huntUrgent', 'resupply', 'explore']) {
      assert.strictEqual(allows(bot, fresh(), behavior(name, 30), FLOOR), true, name);
    }
  });

  check('a cheap win bypasses the phase: an animal a few blocks off, mid-mining', () => {
    const bag = [logs, ...stoneKit, food, cobble];
    assert.strictEqual(allows(stage(bag, { animalAt: 4 }), fresh(), behavior('hunt', 31), FLOOR), true);
    assert.strictEqual(allows(stage(bag, { animalAt: 20 }), fresh(), behavior('hunt', 31), FLOOR), false,
      'twenty blocks is a trip, not a cheap win');
  });

  check('the food phase comes after the stone kit, whatever the bonuses say', () => {
    // Before this, a Jev focus plus the commitment bonus lifted forageTopUp
    // (34 -> 45) over gear (40). Now the phase says no before any bonus is
    // looked at.
    const bot = stage([logs]);
    assert.strictEqual(phase(bot), 'stoneKit');
    assert.strictEqual(allows(bot, fresh(), behavior('forageTopUp', 34), FLOOR), false);
    assert.strictEqual(allows(bot, fresh(), behavior('hunt', 31), FLOOR), false);
  });

  check('every phase-gated behavior serves at least one real phase', () => {
    for (const [name, serves] of Object.entries(progression.SERVES)) {
      for (const id of serves) assert.ok(id in PHASE_INDEX, `${name} serves unknown phase ${id}`);
    }
  });

  check('the director asks the gate first, and records a phase refusal', () => {
    const { pickBehavior } = require('../src/director');
    let asked = false;
    const gated = {
      name: 'mine', priority: 25, phaseGate: () => false, shouldRun: () => { asked = true; return true; },
    };
    const fallback = { name: 'wood', priority: 10, shouldRun: () => true };
    const ctx = { backoff: new Map() };
    assert.strictEqual(pickBehavior({}, ctx, [gated, fallback]).name, 'wood');
    assert.strictEqual(asked, false, 'a gated behavior costs no shouldRun');
    assert.strictEqual(ctx.decisionBoard.pick.asked[0].verdict, 'phase');
  });
}

console.log(`\n${passed} checks passed`);
