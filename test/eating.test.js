/**
 * What the bot is allowed to eat.
 *
 * Cooking doubles a piece of meat — raw beef gives 3 hunger and 1.8
 * saturation, steak gives 8 and 12.8 — so a bot that eats its kills raw has
 * to hunt more than twice as often. It was doing exactly that.
 *
 * Run with: node test/eating.test.js
 */

const assert = require('assert');
const {
  applyEatingPolicy, minHungerFor, REGEN_FOOD_LEVEL, rawMeatCount, hasProperFood,
  ALWAYS_BANNED, RAW_MEAT, COOKED, LAST_RESORT_FOOD,
} = require('../src/eating');

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

/** A bot carrying the given items, with a recording autoEat stub. */
function botWith(items, food = 20, health = 20) {
  const list = Object.entries(items).map(([name, count]) => ({ name, count }));
  return {
    food,
    health,
    inventory: { items: () => list },
    autoEat: {
      opts: null,
      setOpts(o) { this.opts = o; },
    },
  };
}

console.log('eating policy');

check('raw meat is banned while cooked food remains', () => {
  const bot = botWith({ cooked_beef: 2, beef: 5 }, 12);
  applyEatingPolicy(bot);
  for (const raw of RAW_MEAT) {
    assert.ok(bot.autoEat.opts.bannedFood.includes(raw), `${raw} should be banned`);
  }
});

check('raw meat is banned when merely peckish, even with nothing cooked', () => {
  // 15 hunger is not an emergency: hold the meat for the furnace.
  const bot = botWith({ beef: 5 }, 15);
  applyEatingPolicy(bot);
  assert.ok(bot.autoEat.opts.bannedFood.includes('beef'));
});

check('raw meat is allowed only when genuinely desperate', () => {
  const bot = botWith({ beef: 5 }, 6);
  applyEatingPolicy(bot);
  assert.ok(!bot.autoEat.opts.bannedFood.includes('beef'), 'starving beats efficiency');
});

check('poisonous food is never allowed, even when starving', () => {
  const bot = botWith({ rotten_flesh: 9, spider_eye: 3, chicken: 4 }, 1);
  applyEatingPolicy(bot);
  for (const bad of ALWAYS_BANNED) {
    assert.ok(bot.autoEat.opts.bannedFood.includes(bad), `${bad} must stay banned`);
  }
});

check('golden apples are never eaten as ordinary food', () => {
  const bot = botWith({ golden_apple: 3 }, 2);
  applyEatingPolicy(bot);
  assert.ok(bot.autoEat.opts.bannedFood.includes('golden_apple'));
});

check('cooked food and safe vegetables both count as proper food', () => {
  assert.strictEqual(hasProperFood(botWith({ cooked_porkchop: 1 })), true);
  assert.strictEqual(hasProperFood(botWith({ carrot: 4 })), true);
  assert.strictEqual(hasProperFood(botWith({ beef: 9 })), false, 'raw meat is not proper food');
  assert.strictEqual(hasProperFood(botWith({})), false);
});

check('raw meat is counted so hunting can stop and cooking start', () => {
  assert.strictEqual(rawMeatCount(botWith({ beef: 3, porkchop: 2 })), 5);
  assert.strictEqual(rawMeatCount(botWith({ chicken: 2 })), 2, 'raw chicken still needs cooking');
  assert.strictEqual(rawMeatCount(botWith({ cooked_beef: 4 })), 0);
});

check('every cooked item has a sensible name', () => {
  assert.ok(COOKED.includes('cooked_beef'));
  assert.ok(!COOKED.some((n) => RAW_MEAT.includes(n)), 'cooked and raw lists must not overlap');
});

check('a missing autoEat plugin does not throw', () => {
  const bot = botWith({ beef: 1 }, 5);
  delete bot.autoEat;
  applyEatingPolicy(bot); // must be a no-op, not a crash
});

console.log('\nhealing');

// Minecraft only regenerates health at food >= 18. A fixed "eat below 16"
// threshold is therefore a trap: at 17 food the bot won't eat, so it can
// never reach 18, so it never heals. Seen live at 6/20 health with 17/20
// food, stuck indefinitely with cooked meat in the bag.
// The option is `minHunger`. There is no `startAt` — passing one is
// silently accepted and silently ignored, because auto-eat's setOpts is a
// plain Object.assign. That typo left the plugin on its default of 15,
// below the 18 needed for regeneration, so the bot could not heal at all.
check('the eating threshold uses the option the plugin actually reads', () => {
  const bot = botWith({ cooked_beef: 5 }, 17, 6);
  applyEatingPolicy(bot);

  assert.ok('minHunger' in bot.autoEat.opts, 'must set minHunger, not startAt');
  assert.strictEqual(bot.autoEat.opts.startAt, undefined, 'startAt is not a real option');
});

check('a hurt bot eats early enough to trigger regeneration', () => {
  const hurt = botWith({ cooked_beef: 5 }, 17, 6);
  assert.ok(
    minHungerFor(hurt) > REGEN_FOOD_LEVEL,
    'must keep food above the regen line while damaged',
  );

  applyEatingPolicy(hurt);
  assert.ok(hurt.autoEat.opts.minHunger > REGEN_FOOD_LEVEL);
});

check('a healthy bot conserves food instead', () => {
  const healthy = botWith({ cooked_beef: 5 }, 17, 20);
  assert.strictEqual(minHungerFor(healthy), 16, 'no damage to heal, so let hunger drop');
});

check('the policy updates when health changes, not just food', () => {
  const bot = botWith({ cooked_beef: 5 }, 17, 20);
  applyEatingPolicy(bot);
  const whenHealthy = bot.autoEat.opts.minHunger;

  bot.health = 6;
  applyEatingPolicy(bot);
  assert.notStrictEqual(bot.autoEat.opts.minHunger, whenHealthy, 'taking damage must re-evaluate');
});

// The game refuses a bite at 20 food. auto-eat's health trigger did not know,
// so a hurt bot at full food kept starting meals — pickaxe out of hand, walking
// at a crawl. Three of them in lava at 15:36:23 on 09-24, where it died.
check('at full food the low-health trigger is off, because the game will not let it eat', () => {
  const bot = botWith({ cooked_beef: 5 }, 20, 10);
  applyEatingPolicy(bot);
  assert.ok(bot.autoEat.opts.minHealth <= 0, 'would start meals the server refuses');
});

check('...and back on the moment there is room to eat', () => {
  const bot = botWith({ cooked_beef: 5 }, 20, 10);
  applyEatingPolicy(bot);
  bot.food = 19;
  applyEatingPolicy(bot);
  assert.ok(bot.autoEat.opts.minHealth > 10, 'hurt and able to eat: eat');
});

// Two lists of food, and they had drifted: EDIBLE knew cooked chicken, COOKED
// did not — so a bag of cooked chicken read as "Nothing cooked left" and the
// bot was allowed raw meat instead. Everything cooked we count as food has to
// be on the cooked list too.
check('every cooked food the larder counts is on the cooked list', () => {
  const { EDIBLE } = require('../src/behaviors/survive');
  const missing = [...EDIBLE].filter((n) => n.startsWith('cooked_') && !COOKED.includes(n));
  assert.deepStrictEqual(missing, []);
});

console.log('\nlast-resort food');

check('rotten flesh stays banned while anything else is edible', () => {
  const bot = botWith({ rotten_flesh: 5, carrot: 1 }, 2);
  applyEatingPolicy(bot);
  assert.ok(bot.autoEat.opts.bannedFood.includes('rotten_flesh'));
});

check('rotten flesh stays banned above the last-resort hunger line', () => {
  const bot = botWith({ rotten_flesh: 5 }, LAST_RESORT_FOOD + 1);
  applyEatingPolicy(bot);
  assert.ok(bot.autoEat.opts.bannedFood.includes('rotten_flesh'));
});

check('starving with only rotten flesh: eat it rather than starve to death', () => {
  const bot = botWith({ rotten_flesh: 5 }, LAST_RESORT_FOOD);
  applyEatingPolicy(bot);
  assert.ok(!bot.autoEat.opts.bannedFood.includes('rotten_flesh'));
  assert.ok(bot.autoEat.opts.bannedFood.includes('spider_eye'), 'real poison stays banned');
});

console.log(`\n${passed} checks passed`);
