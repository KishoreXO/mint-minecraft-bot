const logger = require('./logger');
const { itemCount, countAny } = require('./inventory');

/**
 * What the bot is allowed to eat, and when.
 *
 * mineflayer-auto-eat takes a static banned list, which is not enough: raw
 * meat should be off the menu almost always, but not when the alternative
 * is starving. So the list is swapped at runtime depending on what's in the
 * bag and how hungry the bot is.
 *
 * Why it matters: cooking doubles a piece of meat. Raw beef restores 3
 * hunger and 1.8 saturation; steak restores 8 and 12.8 — more than four
 * times the saturation from the same animal. A bot that eats its meat raw
 * has to hunt more than twice as often, and hunting is the single most
 * interruptible thing it does. It was doing exactly that.
 */

// Never eaten, at any hunger level, for good reasons:
//  - spider_eye / poisonous_potato / pufferfish: poison
//  - raw chicken: 30% food poisoning
//  - suspicious_stew: unknown effect, can be harmful
//  - golden apples: far too valuable to eat as food
const ALWAYS_BANNED = [
  'golden_apple', 'enchanted_golden_apple', 'spider_eye',
  'poisonous_potato', 'pufferfish', 'chicken', 'suspicious_stew',
];

// Edible, but half the value of the cooked version — a last resort.
const RAW_MEAT = ['beef', 'porkchop', 'mutton', 'rabbit', 'cod', 'salmon'];

const COOKED = [
  'cooked_beef', 'cooked_porkchop', 'cooked_chicken', 'cooked_mutton', 'cooked_rabbit',
  'cooked_cod', 'cooked_salmon', 'bread', 'baked_potato', 'golden_carrot',
];

// Other things worth eating that need no cooking at all.
const SAFE_RAW = ['carrot', 'apple', 'melon_slice', 'sweet_berries', 'glow_berries', 'potato', 'beetroot'];

/**
 * Worse than hunger, better than starving to death.
 *
 * Rotten flesh gives 4 hunger and an 80% chance of Hunger for 30 seconds,
 * which costs back less than it gave. It used to be banned outright alongside
 * the real poisons, so a bot carrying zombie drops starved with them in the
 * bag: three times on 09-26 between 22:06 and 22:33, the ledger reading
 * `starving 20` each time. Eaten only when there is nothing else at all and
 * hunger is at LAST_RESORT_FOOD or below; the rest of the time it is banned.
 */
const LAST_RESORT = ['rotten_flesh'];
const LAST_RESORT_FOOD = 6;

// Below this, eating something inefficient beats going hungry: health stops
// regenerating at 17 and starts draining at 0.
const DESPERATE_FOOD = 10;

function shouldAllowLastResort(bot) {
  if (hasProperFood(bot) || countAny(bot, RAW_MEAT) > 0) return false;
  return (bot.food ?? 20) <= LAST_RESORT_FOOD;
}

function hasProperFood(bot) {
  return countAny(bot, COOKED) > 0 || countAny(bot, SAFE_RAW) > 0;
}

/**
 * Allow raw meat only when there is genuinely nothing better and the bot is
 * actually hungry. Anything else and it should hold on to the meat so the
 * furnace can double it.
 */
function shouldAllowRaw(bot) {
  if (hasProperFood(bot)) return false;
  return (bot.food ?? 20) <= DESPERATE_FOOD;
}

/**
 * When to start eating.
 *
 * Minecraft only regenerates health at food >= 18. A fixed `startAt: 16`
 * therefore creates a trap: at 17 food the bot won't eat, so it can never
 * reach 18, so it never heals — observed live sitting at 6/20 health with
 * 17/20 food and no way out of it.
 *
 * So the threshold depends on whether there's damage to heal. Hurt: eat
 * early and keep the regen running. Healthy: let hunger drop further before
 * spending food, because food is the scarcest thing the bot manages.
 */
const REGEN_FOOD_LEVEL = 18;

/**
 * NOTE THE OPTION NAME. mineflayer-auto-eat's setting is `minHunger`, and
 * it has no `startAt` at all — passing `startAt` is silently accepted and
 * silently ignored, because setOpts is a plain Object.assign. That typo
 * meant the plugin ran on its default `minHunger: 15` the whole time: the
 * bot would not eat until food dropped below 15, while regeneration needs
 * 18, so it was structurally incapable of healing. Observed at 6/20 health
 * and 17/20 food, stuck, with cooked meat in the bag.
 */
function minHungerFor(bot) {
  const hurt = (bot.health ?? 20) < 20;
  // Hurt: keep food pinned at max so regeneration never stops.
  // Healthy: let it drift down before spending food.
  return hurt ? 20 : 16;
}

/**
 * Health below which auto-eat eats regardless of hunger — but only when eating
 * is possible at all.
 *
 * A full player cannot eat: the game refuses the bite at 20 food. auto-eat does
 * not know that, and its health trigger fired anyway, so a hurt bot at full
 * food tried to eat over and over — each attempt swapping the food into its
 * hand and slowing it to a crawl while it held the use key. At 15:36:23 on
 * 09-24 that was three meals started, at 20/20 food, in the lava the bot was
 * trying to walk out of. It died there.
 */
const FULL_FOOD = 20;
const EAT_BELOW_HEALTH = 16;

function minHealthFor(bot) {
  return (bot.food ?? FULL_FOOD) < FULL_FOOD ? EAT_BELOW_HEALTH : 0;
}

function applyEatingPolicy(bot) {
  if (!bot.autoEat) return;

  const allowRaw = shouldAllowRaw(bot);
  const allowLastResort = shouldAllowLastResort(bot);
  const minHunger = minHungerFor(bot);
  const minHealth = minHealthFor(bot);
  if (bot.eatingPolicyAllowsRaw === allowRaw && bot.eatingPolicyMinHunger === minHunger
    && bot.eatingPolicyMinHealth === minHealth && bot.eatingPolicyAllowsLastResort === allowLastResort) {
    return; // nothing changed
  }
  // Only the raw-meat decision is worth a log line. The eating threshold flips
  // between 16 and 20 every time health crosses 20 — and at full food the bot
  // regenerates a point and loses one to anything at all, so a single gravel
  // collapse produced "Raw meat off the menu" twice a second: 57 identical
  // lines in eleven minutes, drowning out the ones that mattered.
  const rawChanged = bot.eatingPolicyAllowsRaw !== allowRaw;
  const lastResortChanged = (bot.eatingPolicyAllowsLastResort ?? false) !== allowLastResort;
  bot.eatingPolicyAllowsRaw = allowRaw;
  bot.eatingPolicyAllowsLastResort = allowLastResort;
  bot.eatingPolicyMinHunger = minHunger;
  bot.eatingPolicyMinHealth = minHealth;

  bot.autoEat.setOpts({
    priority: 'foodPoints',
    minHunger,
    // Emergency trigger: eat on low health even if not hungry enough —
    // whenever there is room to eat. See minHealthFor.
    minHealth,
    bannedFood: [
      ...ALWAYS_BANNED,
      ...(allowRaw ? [] : RAW_MEAT),
      ...(allowLastResort ? [] : LAST_RESORT),
    ],
  });

  if (lastResortChanged && allowLastResort) {
    logger.warn('Nothing else to eat — allowing rotten flesh', { food: bot.food, flesh: countAny(bot, LAST_RESORT) });
  }

  if (!rawChanged) return;
  logger.info(allowRaw
    ? 'Nothing cooked left — allowing raw meat'
    : 'Raw meat off the menu; cook it instead', {
    food: bot.food,
    health: bot.health === undefined ? undefined : Math.round(bot.health),
    eatBelowFood: minHunger,
    cooked: countAny(bot, COOKED),
    raw: countAny(bot, RAW_MEAT),
  });
}

/** Raw meat sitting in the bag that the furnace should turn into real food. */
function rawMeatCount(bot) {
  return countAny(bot, RAW_MEAT) + itemCount(bot, 'chicken');
}

/**
 * Keep auto-eat's hands off for a moment, and give them back.
 *
 * Eating puts food in the hand. Done at the wrong moment that is not a slow
 * meal, it is a failed action: at 14:06:10 on 09-26 auto-eat started a meal
 * 67ms after a pillar step equipped its cobblestone, and the server was asked
 * to "place cooked_mutton". At 14:32:32 it ate in the middle of digging toward
 * an air pocket, and the bot drowned a block short of it.
 *
 * Counted, because two things can want it off at once — escaping lava while
 * the drowning escape is running — and the first to finish must not switch
 * eating back on under the other. Returns the release; calling it twice is
 * harmless.
 *
 * Deliberately NOT used around ordinary digging: a strip mine digs back to
 * back for minutes, and a pause per dig would leave auto-eat no window at all.
 */
function pauseAutoEat(bot, why = 'busy') {
  const eater = bot.autoEat;
  if (!eater) return () => {};
  const pause = bot.autoEatPause ?? (bot.autoEatPause = { count: 0, wasEnabled: false, why: [] });
  if (pause.count === 0) {
    pause.wasEnabled = !!eater.enabled;
    try {
      eater.cancelEat?.();
    } catch {
      // not eating; nothing to cancel
    }
    if (pause.wasEnabled) eater.disableAuto();
  }
  pause.count++;
  pause.why.push(why);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    pause.count--;
    const at = pause.why.indexOf(why);
    if (at !== -1) pause.why.splice(at, 1);
    if (pause.count === 0 && pause.wasEnabled) eater.enableAuto();
  };
}

module.exports = {
  applyEatingPolicy,
  pauseAutoEat,
  minHungerFor,
  minHealthFor,
  REGEN_FOOD_LEVEL,
  rawMeatCount,
  hasProperFood,
  ALWAYS_BANNED,
  RAW_MEAT,
  COOKED,
  LAST_RESORT,
  LAST_RESORT_FOOD,
};
