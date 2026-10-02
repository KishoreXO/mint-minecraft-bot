/**
 * Numbers in different files that have to agree.
 *
 * This is the bug this project keeps having, in five different costumes so far,
 * and every one of them looked like a mystery until the two numbers were put
 * side by side:
 *
 *   goDeep wanted 16 wood, resupply fired below 6, and there are no trees at
 *   y=48 — a bot holding 8 could neither descend nor surface.
 *
 *   gatherStone stopped at 20 cobblestone while the descent demanded 32, so
 *   `needsCobble` was false and `deepTripShortfall` said "blocks" forever.
 *
 *   hunt stopped at 5 food against a trip requirement of 6, leaving the bot
 *   permanently one pork chop short of a descent it was otherwise ready for.
 *
 *   gear built a third stone pickaxe because it kept two; stock threw the
 *   third away because it kept two — written down twice, and they drifted.
 *
 *   stock capped wood at a number below what the trip needed, so `tidy` threw
 *   away the logs `wood` had just been sent to fetch.
 *
 * Each pair is individually reasonable. Jointly they are impossible, and
 * nothing fails — the bot just quietly stops making progress, which is the
 * hardest kind of bug to see from the outside and the one that has cost this
 * project the most time.
 *
 * So the relationships are asserted here. Changing a target now either keeps
 * the invariant or breaks the build.
 *
 * Run with: node test/thresholds.test.js
 */

const assert = require('assert');
const {
  DEEP_TRIP_NEEDS, ENOUGH, COBBLE_TARGET, RESUPPLY_FOOD, RESUPPLY_WOOD,
} = require('../src/behaviors/mine');
const { FOOD_STOCK_TARGET, STOCK_FOR_TRIP } = require('../src/behaviors/hunt');
const { CRITICAL_WOOD, RESTOCK_WOOD } = require('../src/behaviors/wood');
const { KEEP_PER_TOOL_TYPE, CAPS, WOOD_CAP } = require('../src/stock');
const { MAX_PER_TOOL_TYPE, IRON_COST } = require('../src/behaviors/gear');

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

/**
 * `gather` must be at least `need`, or the behavior that fetches the resource
 * stops before the behavior that spends it is satisfied.
 */
function gathersEnough(gather, need, what, why) {
  assert.ok(
    gather >= need,
    `${what}: the gathering target (${gather}) is below what it is gathered FOR (${need}) — ${why}`,
  );
}

console.log('the gathering target must reach the requirement');

check('food: hunting stops above what the descent asks for', () => {
  gathersEnough(
    FOOD_STOCK_TARGET, DEEP_TRIP_NEEDS.food, 'food',
    'hunt would stop one meal short of a trip the bot is otherwise ready for',
  );
  gathersEnough(
    STOCK_FOR_TRIP, DEEP_TRIP_NEEDS.food, 'food',
    'forage is the only behavior that TRAVELS to find animals; below the bar nothing goes looking',
  );
});

check('wood: chopping stops above what the descent asks for', () => {
  gathersEnough(CRITICAL_WOOD, DEEP_TRIP_NEEDS.planks, 'wood', 'no trees grow at y=16');
  assert.ok(
    RESTOCK_WOOD > CRITICAL_WOOD,
    'without hysteresis the bot tops up to exactly the bar and is one plank from doing it again',
  );
});

check('cobblestone: gathering stops above what the descent asks for', () => {
  gathersEnough(
    COBBLE_TARGET, DEEP_TRIP_NEEDS.placeable, 'cobblestone',
    'goDeep refuses while needsCobble is true, so a lower target is a deadlock with itself',
  );
});

console.log('\nthe come-back-up line must sit below the set-off line');

// These two must not overlap or the bot yo-yos: surface because wood is low,
// top up to just past the trip threshold, descend, spend a plank, surface again.
check('resupply fires well below what a trip is started with', () => {
  assert.ok(
    RESUPPLY_FOOD < DEEP_TRIP_NEEDS.food,
    'a bot that surfaces the moment it is one meal below the START bar never gets anywhere',
  );
  assert.ok(RESUPPLY_WOOD < DEEP_TRIP_NEEDS.planks, 'same, for wood');
});

console.log('\nwhat we keep must cover what we need');

check('the inventory policy does not cap a resource below its requirement', () => {
  gathersEnough(
    WOOD_CAP, DEEP_TRIP_NEEDS.planks, 'wood cap',
    'tidy would throw away the logs `wood` was just sent to fetch',
  );
  gathersEnough(
    CAPS.get('cobblestone'), DEEP_TRIP_NEEDS.placeable, 'cobblestone cap',
    'tidy would throw away the blocks the descent is waiting for',
  );
});

check('one side builds exactly as many tools as the other side keeps', () => {
  assert.strictEqual(
    MAX_PER_TOOL_TYPE, KEEP_PER_TOOL_TYPE,
    'gear builds up to one number and stock throws away above another; '
    + 'a gap between them is a bot crafting and discarding the same pickaxe forever',
  );
});

console.log('\nthe iron target must cover the kit it is mined for');

// Shield 1 + iron pickaxe 3 + iron sword 2 + a full set of armour 24 = 30, and
// the spare pickaxe the diamond trip wants is 3 more. Mining less than the kit
// costs means `gear` wants a piece it can never afford while `neededResource`
// has already moved on to diamond.
check('thirty-three iron is the kit plus a spare pickaxe', () => {
  const kit = IRON_COST.shield
    + IRON_COST.iron_pickaxe
    + IRON_COST.iron_sword
    + IRON_COST.iron_helmet
    + IRON_COST.iron_chestplate
    + IRON_COST.iron_leggings
    + IRON_COST.iron_boots;
  assert.strictEqual(kit, 30, 'the arithmetic behind ENOUGH.raw_iron');
  gathersEnough(
    ENOUGH.raw_iron, kit, 'iron',
    'the bot would stop mining iron before it could finish the kit it is mining for',
  );
  assert.ok(
    ENOUGH.raw_iron >= kit + IRON_COST.iron_pickaxe,
    'and a spare pickaxe, because the diamond trip is 250 blocks of digging',
  );
});

// The piece-by-piece ledger and the headline target are the same number seen
// from two ends. If they drift, the status line reports one goal while the
// miner chases another.
check('a bot holding nothing still needs exactly ENOUGH.raw_iron', () => {
  const { ironStillNeeded } = require('../src/behaviors/gear');
  const empty = { inventory: { items: () => [], slots: [] }, getEquipmentDestSlot: () => 99 };
  assert.strictEqual(ironStillNeeded(empty), ENOUGH.raw_iron);
});

// The sixth costume. tooFarToBother forgot a crafting table past 24 blocks as
// not worth the walk, and the nearby search — radius 28 — found the same table
// a moment later and walked to it anyway: "too far to be worth the walk
// {distance: 28}", then "Going to collect the old crafting table".
console.log('\nstations: search no further than we would walk');

check('the station search radius never exceeds the walk worth making', () => {
  const { NEARBY_RADIUS, WORTH_WALKING_TO } = require('../src/stations');
  assert.ok(
    NEARBY_RADIUS <= WORTH_WALKING_TO,
    `a station found at ${NEARBY_RADIUS} would be walked to after being judged too far at ${WORTH_WALKING_TO}`,
  );
});

console.log('\nwhat the miner wants and what tidy throws away agree');

{
  const { ORE_YIELD, ORE_BLOCKS } = require('../src/knowledge');
  const { isWorthless, isPrecious, isUnwantedOre } = require('../src/stock');
  const drops = Object.values(ORE_YIELD);

  // The drop side and the dig side each had their own list, and they drifted:
  // mine.js refused to seek copper while four other paths dug it, and tidy
  // threw the result away — four stacks in one live session.
  check('no ore the miner seeks drops something tidy throws away', () => {
    for (const drop of drops) {
      if (isWorthless(drop)) assert.strictEqual(ENOUGH[drop] ?? 0, 0, `${drop} is sought and then thrown away`);
    }
  });

  check('every ore the miner skips is either junk or kept if it ever turns up', () => {
    for (const drop of drops) {
      if ((ENOUGH[drop] ?? 0) === 0) {
        assert.ok(isWorthless(drop) || isPrecious(drop), `${drop} is neither sought, thrown away nor kept`);
      }
    }
  });

  check('deepslate variants are just as unwanted', () => {
    assert.strictEqual(isUnwantedOre('deepslate_copper_ore'), true);
    assert.strictEqual(isUnwantedOre('deepslate_iron_ore'), false);
    assert.strictEqual(isUnwantedOre('stone'), false);
  });

  check('pathfinder may never break any ore — wanted is wasted, unwanted is junk', () => {
    const { buildMovements } = require('../src/bot');
    const registry = require('minecraft-data')('1.21.9');
    const m = buildMovements({ registry, version: '1.21.9' });
    for (const ore of ORE_BLOCKS) {
      assert.ok(m.blocksCantBreak.has(registry.blocksByName[ore].id), `pathfinder may dig ${ore}`);
    }
  });

  // 09-26: an eighteen-block drop into a flooded ravine was "safe" because it
  // landed in water, and the bot could not climb back out. Water gets the same
  // drop limit as ground.
  check('pathfinder does not drop further into water than onto ground', () => {
    const { buildMovements } = require('../src/bot');
    const registry = require('minecraft-data')('1.21.9');
    const m = buildMovements({ registry, version: '1.21.9' });
    assert.strictEqual(m.infiniteLiquidDropdownDistance, false);
    assert.ok(m.maxDropDown <= 4);
  });
}

// Splitting forage in two must not open a gap: every larder below the trip's
// requirement, at every hunger level, is still someone's job to fix — and
// only one someone's, or the two would fight over the wheel.
check('food: every larder short of the trip is exactly one forager\'s job', () => {
  const { larderEmergency, larderShortForTrip } = require('../src/behaviors/hunt');
  const botWith = (steaks, food) => ({
    food,
    inventory: { items: () => (steaks ? [{ name: 'cooked_beef', count: steaks }] : []) },
  });
  for (let stock = 0; stock < STOCK_FOR_TRIP; stock++) {
    for (let food = 0; food <= 20; food++) {
      const bot = botWith(stock, food);
      const jobs = [larderEmergency(bot), larderShortForTrip(bot)].filter(Boolean).length;
      assert.strictEqual(jobs, 1, `stock ${stock}, hunger ${food}: ${jobs} foragers want it`);
    }
  }
  assert.strictEqual(larderShortForTrip(botWith(STOCK_FOR_TRIP, 20)), false, 'a full larder is nobody\'s job');
});

check('food: a cow that two legs could not close on is left alone', () => {
  const { noteChase, chaseable } = require('../src/behaviors/hunt');
  const ctx = {};
  const cow = { id: 7, name: 'cow', type: 'animal', isValid: true };
  noteChase(ctx, cow, 44, 43); // a leg that got nowhere
  assert.ok(chaseable(ctx)(cow), 'one bad leg is bad luck, not proof');
  noteChase(ctx, cow, 44, 44);
  assert.ok(!chaseable(ctx)(cow), 'the same cow was chased for six minutes');
  const pig = { id: 8, name: 'pig', type: 'animal', isValid: true };
  noteChase(ctx, pig, 30, 29);
  noteChase(ctx, pig, 29, 20); // real progress wipes the strike
  noteChase(ctx, pig, 20, 19);
  assert.ok(chaseable(ctx)(pig), 'progress between bad legs must reset the count');
});

check('food: a rabbit that two hunts could not kill is passed over for the cow beside it', () => {
  const { noteFailedKill, chaseable, pickPrey } = require('../src/behaviors/hunt');
  const Vec3 = require('vec3');
  const ctx = {};
  const rabbit = {
    id: 21, name: 'rabbit', type: 'animal', isValid: true, position: new Vec3(3, 64, 0),
  };
  const cow = {
    id: 22, name: 'cow', type: 'animal', isValid: true, position: new Vec3(9, 64, 0),
  };
  const bot = {
    entity: { position: new Vec3(0, 64, 0) },
    entities: { 21: rabbit, 22: cow },
    inventory: { items: () => [{ name: 'stone_sword', count: 1 }] },
  };
  assert.strictEqual(pickPrey(bot, ctx), rabbit, 'nearest first');
  noteFailedKill(ctx, rabbit);
  assert.ok(chaseable(ctx)(rabbit), 'one escape is bad luck');
  noteFailedKill(ctx, rabbit);
  // 10-02 08:43–08:47: eleven hunts of one rabbit, eleven "killed: false".
  assert.strictEqual(pickPrey(bot, ctx), cow);
});

console.log(`\n${passed} checks passed`);
