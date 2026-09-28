/**
 * What the bot wants to be carrying, and how much of it.
 *
 * ONE policy, in one place. Before this there were four opinions about what
 * was worth holding — a JUNK list in tidy.js, a WORTH table in collect.js, an
 * ENOUGH table in mine.js and a per-tool rule in gear.js — and they disagreed.
 * The bot would drop a stone pickaxe as surplus and then walk back and pick it
 * up because the pickup side rated tools at 500 and knew nothing about the
 * drop side's reasoning. Watched live: the same pickaxe tossed and recovered
 * over and over.
 *
 * So the question "do I want this?" gets exactly one answer, and both the
 * picking-up and the throwing-away consult it.
 *
 * THE GOAL IS A DIAMOND KIT. That is what "required" means here and it is
 * narrower than "valuable in Minecraft". Lapis, copper, redstone and gold are
 * all real resources and none of them move this bot one step closer to 29
 * diamonds, so they are weight — as are the tools it already has two of, and
 * the two hundredth cobblestone.
 */

const { yieldOf } = require('./knowledge');

// Tools do not stack, so a spare pile of them costs a slot each. Two is what
// gear.js's spare rule asks for: one in hand, one for when it breaks.
const KEEP_PER_TOOL_TYPE = 2;
const TOOL_SUFFIX = /_(pickaxe|sword|axe|shovel|hoe)$/;

/**
 * Things there is no such thing as too much of. Everything here is either the
 * goal itself, a step to it, or unrecoverable if dropped.
 */
const PRECIOUS = new Set([
  'diamond', 'emerald', 'netherite_ingot', 'netherite_scrap', 'ancient_debris',
  'raw_iron', 'iron_ingot', 'iron_block',
  'shield', 'bed', 'crafting_table', 'furnace', 'smoker', 'blast_furnace',
  'coal', 'charcoal', // fuel: the furnace stops without it
]);

const ARMOUR_SUFFIX = /_(helmet|chestplate|leggings|boots)$/;
// One worn, one spare. The bot can only wear one of each.
const KEEP_PER_ARMOUR_SLOT = 2;

/**
 * Caps on things that are useful but that the bot produces faster than it can
 * ever spend. Cobblestone is the worst offender by a distance: every block on
 * the way to y=16 is another lump of it, so the supply runs away — 300 held
 * against a target of 20, filling the slots that ore needs.
 */
const CAPS = new Map([
  ['cobblestone', 128], ['cobbled_deepslate', 128], ['stone', 64],
  ['deepslate', 64], ['blackstone', 64], ['tuff', 32], ['calcite', 32],
  ['granite', 32], ['diorite', 32], ['andesite', 32],
  ['dirt', 64], ['coarse_dirt', 32], ['rooted_dirt', 32], ['grass_block', 32],
  ['gravel', 32], ['sand', 32], ['red_sand', 32], ['sandstone', 32],
  ['flint', 8], ['clay_ball', 8],
  // The food of last resort (see eating.js): a few, never a stack.
  ['rotten_flesh', 8],
]);

/**
 * Worth nothing to THIS run, whatever they are worth in general.
 *
 * Lapis, copper and redstone are the ones worth naming: the bot was mining
 * them, carrying them and burning furnace fuel smelting them, and not one of
 * them is on the path to a diamond pickaxe. Gold is only useful in the
 * nether, which is not where this is going.
 */
const WORTHLESS = new Set([
  'lapis_lazuli', 'raw_copper', 'copper_ingot', 'redstone', 'amethyst_shard',
  'raw_gold', 'gold_ingot', 'gold_nugget', 'quartz',
  'spider_eye', 'bone', 'string', 'gunpowder', 'ender_pearl',
  'leaf_litter', 'short_grass', 'tall_grass', 'fern', 'large_fern',
  'dead_bush', 'seagrass', 'kelp', 'poppy', 'dandelion', 'oak_button',
  'wheat_seeds', 'melon_seeds', 'pumpkin_seeds', 'beetroot_seeds',
  'torch', // the bot no longer places them — see gear.js
]);

/**
 * ...and everything else the world hands a bot that picks things up.
 *
 * A named list can only ever cover what somebody has already seen in the bag,
 * and the default for anything unnamed is "keep it, it might be an ore". Both
 * of those are right, and together they fill the inventory with novelties.
 * Read off the live dashboard after twenty minutes: 29 oak saplings, 72 leaf
 * litter, 4 eggs, 2 peonies — sixty-odd slots' worth of things no step of this
 * run will ever consume, in a bag that has to hold ore.
 *
 * Patterns rather than names, because the failure mode is specifically the
 * items nobody thought to list. Checked AFTER the precious set, and these
 * cannot collide with tools, armour, food, wood or stone — each of which has
 * its own branch below.
 *
 * Wool is deliberately absent: three of it is a bed, and a bed skips the night.
 */
const WORTHLESS_PATTERNS = [
  /_sapling$/,
  /_leaves$/,
  /_dye$|^bone_meal$|^ink_sac$/,
  /_carpet$|_banner$|_candle$/,
  /^(peony|lilac|rose_bush|sunflower|allium|azure_bluet|blue_orchid|cornflower)$/,
  /^(lily_of_the_valley|oxeye_daisy|wither_rose|torchflower|pink_petals)$/,
  /_tulip$|_flower$|_orchid$/,
  /^(egg|feather|slime_ball|paper|book|honeycomb|glass_bottle)$/,
  /^(sugar_cane|bamboo|cocoa_beans|vine|glow_lichen|moss_block)$/,
  /^(azalea|flowering_azalea|hanging_roots|spore_blossom|big_dripleaf|small_dripleaf)$/,
  /^(nautilus_shell|prismarine_shard|prismarine_crystals|scute|phantom_membrane)$/,
];

function isWorthless(itemName) {
  if (isPrecious(itemName)) return false; // precious always wins
  if (WORTHLESS.has(itemName)) return true;
  return WORTHLESS_PATTERNS.some((p) => p.test(itemName));
}

/**
 * Ore that is not worth breaking, because what it drops is thrown straight
 * back out by `tidy`.
 *
 * mine.js already refused to go LOOKING for copper, but four other paths broke
 * it anyway — the strip corridor, the pathfinder cutting a route, and the
 * pocket and ceiling clearing in inventory.js — and each dig came back as
 * raw_copper for tidy to throw away. Live on 09-24 that was four stacks. Every
 * one of those asks here, so "unwanted" cannot mean one thing to the miner and
 * another to the pathfinder.
 */
function isUnwantedOre(blockName) {
  const drop = yieldOf(blockName);
  return !!drop && isWorthless(drop);
}

/**
 * THERE IS NO ITEM CALLED "bed".
 *
 * Every bed in the game is colour-prefixed — white_bed, red_bed — so the plain
 * `bed` sitting in PRECIOUS has never matched anything the bot could actually
 * be holding. That was harmless while nothing else claimed them, and it very
 * nearly stopped being harmless: a `_bed$` pattern in the worthless list would
 * have made the bot throw away every bed it ever found, and a bed is what lets
 * it skip a ten-minute night instead of sitting out the whole thing in a hole.
 *
 * Patterns, so the sixteen colours are covered once rather than sixteen times.
 */
const PRECIOUS_PATTERNS = [/_bed$/];

const FOOD_CAP = 16;
const FOODS = /^(cooked_|bread$|baked_potato$|golden_carrot$|carrot$|potato$|beetroot$|apple$|melon_slice$|sweet_berries$|glow_berries$|beef$|porkchop$|mutton$|chicken$|rabbit$|cod$|salmon$)/;

// Wood, counted loosely — planks, logs and sticks are all the same resource.
const WOOD = /(_log$|_planks$|^stick$)/;
const WOOD_CAP = 96;

function countHeld(bot, itemName) {
  let total = 0;
  for (const item of bot.inventory.items()) {
    if (item.name === itemName) total += item.count;
  }
  return total;
}

function toolsOfSameType(bot, itemName) {
  const match = itemName.match(TOOL_SUFFIX);
  if (!match) return null;
  return bot.inventory.items().filter((i) => i.name.endsWith(`_${match[1]}`));
}

/**
 * How many of this we still want. 0 means "not one more", Infinity means
 * "as many as there are".
 *
 * This is the single function both sides consult, which is the whole point:
 * whatever `collect` decides to walk to, `tidy` will not immediately throw
 * away, and vice versa.
 */
function roomFor(bot, itemName) {
  if (!itemName) return Infinity; // unidentified: assume it might matter
  // Precious is tested first, inside isWorthless, so a pattern can never
  // outvote the list of things the run actually needs.
  if (isPrecious(itemName)) return Infinity;
  if (isWorthless(itemName)) return 0;

  // Armour is capped the same way tools are, and for the same reason: a pile
  // of leather helmets is a slot each and the bot can only wear one. Unlimited
  // was the obvious answer and it is the one that fills the bag.
  const armour = itemName.match(ARMOUR_SUFFIX);
  if (armour) {
    const held = bot.inventory.items().filter((i) => i.name.endsWith(`_${armour[1]}`));
    return Math.max(0, KEEP_PER_ARMOUR_SLOT - held.length);
  }

  const tools = toolsOfSameType(bot, itemName);
  if (tools) return Math.max(0, KEEP_PER_TOOL_TYPE - tools.length);

  if (FOODS.test(itemName)) return Math.max(0, FOOD_CAP - countHeld(bot, itemName));

  if (WOOD.test(itemName)) {
    let wood = 0;
    for (const item of bot.inventory.items()) {
      if (WOOD.test(item.name)) wood += item.count;
    }
    return Math.max(0, WOOD_CAP - wood);
  }

  const cap = CAPS.get(itemName);
  if (cap !== undefined) return Math.max(0, cap - countHeld(bot, itemName));

  return Infinity; // unknown and unclassified: keep it, it might be an ore
}

/** Is walking over to this drop worth doing at all? */
function worthPickingUp(bot, itemName) {
  return roomFor(bot, itemName) > 0;
}

/**
 * The stack most worth throwing away, or null if the bag is all wanted.
 *
 * Ordered by how useless it is, not by how much room it frees — dropping a
 * stack of dirt to keep a lapis is the wrong trade even though it frees more
 * space.
 */
/**
 * Everything worth throwing away, worst first — not just the single worst.
 *
 * Returning one stack was not enough, because the caller is allowed to refuse
 * it: `tidy` keeps a working stack of anything placeable, since being unable
 * to pillar out of a hole costs far more than a stack of dirt is worth. With
 * only one candidate, a protected stack of dirt sitting at the front of the
 * list masked every other surplus behind it, and the bot went on carrying a
 * bag of lapis and spare pickaxes it had already decided to drop.
 */
// A full stack: how far over its cap something must be before it is thrown.
const CAP_SLACK = 64;

function surplusCandidates(bot) {
  const items = bot.inventory.items();
  const out = [];

  // Outright worthless first.
  for (const item of items) {
    if (isWorthless(item.name)) out.push(item);
  }

  // Then tools past the second of their type — the WORST ones, so what stays
  // is the best tier at the best durability.
  const byType = new Map();
  for (const item of items) {
    const match = item.name.match(TOOL_SUFFIX);
    if (!match) continue;
    const list = byType.get(match[1]) ?? [];
    list.push(item);
    byType.set(match[1], list);
  }
  for (const list of byType.values()) {
    if (list.length <= KEEP_PER_TOOL_TYPE) continue;
    const worstFirst = list.slice().sort(compareToolWorstFirst);
    out.push(...worstFirst.slice(0, list.length - KEEP_PER_TOOL_TYPE));
  }

  // Then anything well over its cap — a whole stack over, and the biggest
  // stack of it first.
  //
  // Over by ONE used to be enough: the 13:38 session on 09-24 threw
  // cobblestone thirty-four times, some throws two or seven blocks, each
  // walked straight back over while mining. `collect` stops picking up AT the
  // cap (see roomFor), so between the cap and a stack past it both sides leave
  // the pile alone, and a throw, when it comes, is worth making.
  const overCap = new Map();
  for (const item of items) {
    const cap = CAPS.get(item.name);
    if (cap === undefined || countHeld(bot, item.name) <= cap + CAP_SLACK) continue;
    const biggest = overCap.get(item.name);
    if (!biggest || item.count > biggest.count) overCap.set(item.name, item);
  }
  out.push(...overCap.values());
  return out;
}

/** The single worst thing in the bag, or null. */
function surplusStack(bot) {
  return surplusCandidates(bot)[0] ?? null;
}

/**
 * Worst tool first: lowest tier, then most worn. Written as a named function
 * so the ordering is stated once — reversing it silently throws away the good
 * pickaxe and keeps the broken one, which is not a failure that announces
 * itself.
 */
const TIERS = ['netherite', 'diamond', 'iron', 'stone', 'golden', 'wooden'];
const TOOL_TIERS = TIERS;

function tierOf(name) {
  const index = TIERS.findIndex((t) => name.startsWith(t));
  return index === -1 ? TIERS.length : index;
}

function lifeLeft(item) {
  if (!item || !item.maxDurability) return 1;
  return Math.max(0, (item.maxDurability - (item.durabilityUsed ?? 0)) / item.maxDurability);
}

function compareToolWorstFirst(a, b) {
  return tierOf(b.name) - tierOf(a.name) || lifeLeft(a) - lifeLeft(b);
}

/**
 * Things that must never be thrown away, and must always be picked up.
 *
 * Exported because two separate mistakes both needed it. `tidy` tosses a stack
 * by SLOT INDEX, and the inventory shifts under it — auto-eat finishing, a
 * pickup landing, a craft completing — so the slot it read a moment ago can
 * hold something else entirely by the time the toss goes out. And `collect`
 * refuses anything lying near a spot where the bot deliberately dropped
 * something, which is right for a spare pickaxe and wrong for the ingot that
 * happened to land beside it.
 *
 * Reported as: "the bot dropped an iron ingot and didn't pick it up for no
 * reason."
 */
function isPrecious(itemName) {
  if (!itemName) return false;
  return PRECIOUS.has(itemName) || PRECIOUS_PATTERNS.some((p) => p.test(itemName));
}

module.exports = {
  // Best tier first; inventory.js's TIER_RANK is this list.
  TOOL_TIERS,
  roomFor,
  worthPickingUp,
  surplusCandidates,
  surplusStack,
  isPrecious,
  isWorthless,
  isUnwantedOre,
  CAP_SLACK,
  PRECIOUS,
  // How many of a tool type the bot keeps. Exported so `gear` can refuse to
  // CRAFT a third rather than writing the same number down a second time —
  // those two disagreeing is precisely what produced the pile of stone
  // pickaxes: one side building them, the other throwing them away.
  KEEP_PER_TOOL_TYPE,
  // For test/thresholds.test.js: a cap below a requirement means `tidy` throws
  // away exactly what the gathering behavior was sent to fetch.
  CAPS,
  WOOD_CAP,
};
