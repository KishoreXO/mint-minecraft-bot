const logger = require('../logger');
const { ensureTable, ensureSticks, ensurePlanks } = require('../stations');
const {
  itemCount, countAny, hasItem, findItem, plankNames, bestToolOfType, tierRank, craftItem,
  toolIsWornOut, countUsableTools, durabilityLeft, STONE_MATERIAL, equipTo,
} = require('../inventory');
const { KEEP_PER_TOOL_TYPE } = require('../stock');

/**
 * Never hold more than two of a tool type, and never craft a third.
 *
 * This is the hard stop behind "he crafts a ton of stone pickaxes for no
 * reason". The soft rules — replace when worn, keep one spare — are each
 * correct and each has a failure mode where it fires repeatedly: a craft that
 * succeeds but is reported as failed (the inventory lags the packet), a
 * durability read that has not arrived yet, a spare that is itself half worn.
 * Every one of those turns "build one replacement" into "build one replacement
 * per scheduling round", and `tidy` then throws the surplus away, and `collect`
 * used to walk back and fetch it.
 *
 * So the count is checked as arithmetic before any of the judgement runs. Two
 * of anything is enough; a third is never the right answer, whatever the
 * reasoning that got here.
 *
 * Not "the same number as" KEEP_PER_TOOL_TYPE in src/stock.js — literally that
 * number. `stock` decides when to throw one away and this decides when to build
 * one, and the two disagreeing is how the bot ends up crafting and discarding
 * the same pickaxe forever. Written down once.
 */
const MAX_PER_TOOL_TYPE = KEEP_PER_TOOL_TYPE;

/**
 * What a crafted item cost in iron, so mined iron does not stop counting the
 * moment it is spent.
 *
 * `stockOf('raw_iron')` counts raw iron, ingots and blocks. It does NOT count
 * the iron pickaxe in the bot's hand or the chestplate on its back — so every
 * craft made the bot poorer by that measure, and the "do I have enough iron
 * yet" test could never be satisfied. With a target of thirty and a full set of
 * armour costing twenty-four, the bot would mine iron, spend it, and conclude
 * it needed thirty more. Forever.
 */
const IRON_COST = {
  iron_ingot: 1, raw_iron: 1, iron_block: 9, iron_nugget: 0,
  shield: 1, bucket: 3, flint_and_steel: 1, shears: 2,
  iron_sword: 2, iron_pickaxe: 3, iron_axe: 3, iron_shovel: 1, iron_hoe: 2,
  iron_helmet: 5, iron_chestplate: 8, iron_leggings: 7, iron_boots: 4,
};

/**
 * The same ledger for diamond, and for the same reason.
 *
 * `stockOf('diamond')` counted loose diamonds only, so every diamond crafted
 * into the kit made the bot poorer by the measure that decides whether it has
 * enough: build the pickaxe and the counter drops by three. ENOUGH.diamond
 * could therefore never be reached — the "finish line" in the log never
 * flipped, and `neededResource` kept the bot digging for diamond with the full
 * kit on its back. Iron had exactly this bug and was fixed with ironInvested;
 * diamond was left behind.
 */
const DIAMOND_COST = {
  diamond: 1, diamond_block: 9,
  diamond_sword: 2, diamond_pickaxe: 3, diamond_axe: 3, diamond_shovel: 1, diamond_hoe: 2,
  diamond_helmet: 5, diamond_chestplate: 8, diamond_leggings: 7, diamond_boots: 4,
};

/** Units of a material held in any form — loose, in the bag, or worn. */
function investedIn(bot, costs) {
  let total = 0;
  for (const item of bot.inventory.items()) {
    total += (costs[item.name] ?? 0) * item.count;
  }
  // Worn armour is not in items(); it is in the equipment slots.
  for (const slot of ['head', 'torso', 'legs', 'feet', 'off-hand']) {
    let name;
    try {
      name = bot.inventory.slots[bot.getEquipmentDestSlot(slot)]?.name;
    } catch {
      name = null; // older registries do not know every slot name
    }
    total += costs[name] ?? 0;
  }
  return total;
}

/** Every ingot the bot has ever kept, whatever shape it is in now. */
function ironInvested(bot) {
  return investedIn(bot, IRON_COST);
}

/** Every diamond the bot has ever kept, whatever shape it is in now. */
function diamondInvested(bot) {
  return investedIn(bot, DIAMOND_COST);
}

/** Do we already own a pickaxe good enough to mine diamond? */
function hasIronPickaxe(bot) {
  const pick = bestToolOfType(bot, 'pickaxe');
  if (!pick) return false;
  const tier = pick.name.split('_')[0];
  return tier === 'iron' || tier === 'diamond' || tier === 'netherite';
}

/**
 * How much iron the kit still has to be made OF — what is left to mine.
 *
 * ironInvested answered a different question ("how much iron have we ever
 * kept") against a fixed target of 33, and the two came apart as soon as the
 * bot outgrew iron. With a diamond pickaxe the iron one is surplus; tidy threw
 * it away, the ledger lost 3, and the bot wanted three more iron to rebuild a
 * pickaxe it would never use — 17 → 14 → 17 → 14 on 09-24 as it was thrown,
 * picked up and thrown again. And the pickaxe and sword were still being
 * counted as iron to find long after diamond ones were in hand.
 *
 * So count the kit piece by piece: a piece held at iron tier OR BETTER needs
 * nothing, and loose iron — in the bag or cooking in a furnace — pays for the
 * rest. Every cost comes from IRON_COST; with nothing held this is exactly
 * ENOUGH.raw_iron, which test/thresholds.test.js pins.
 */
const IRON_OR_BETTER = '(iron|diamond|netherite)';
const IRON_KIT = [
  { covers: /^shield$/, cost: IRON_COST.shield },
  { covers: new RegExp(`^${IRON_OR_BETTER}_pickaxe$`), cost: IRON_COST.iron_pickaxe },
  { covers: new RegExp(`^${IRON_OR_BETTER}_sword$`), cost: IRON_COST.iron_sword },
  { covers: new RegExp(`^${IRON_OR_BETTER}_helmet$`), cost: IRON_COST.iron_helmet },
  { covers: new RegExp(`^${IRON_OR_BETTER}_chestplate$`), cost: IRON_COST.iron_chestplate },
  { covers: new RegExp(`^${IRON_OR_BETTER}_leggings$`), cost: IRON_COST.iron_leggings },
  { covers: new RegExp(`^${IRON_OR_BETTER}_boots$`), cost: IRON_COST.iron_boots },
];
const GOOD_PICKAXE = new RegExp(`^${IRON_OR_BETTER}_pickaxe$`);
const LOOSE_IRON = ['iron_ingot', 'raw_iron', 'iron_block'];

function heldNames(bot) {
  const names = bot.inventory.items().flatMap((i) => Array(i.count).fill(i.name));
  for (const slot of ['head', 'torso', 'legs', 'feet', 'off-hand']) {
    try {
      const name = bot.inventory.slots[bot.getEquipmentDestSlot(slot)]?.name;
      if (name) names.push(name);
    } catch {
      // older registries do not know every slot name
    }
  }
  return names;
}

/** The iron cost of each kit piece not yet held at iron tier or better. */
function missingIronPieces(bot) {
  const held = heldNames(bot);
  return IRON_KIT.filter((piece) => !held.some((name) => piece.covers.test(name))).map((piece) => piece.cost);
}

function ironStillNeeded(bot) {
  const held = heldNames(bot);
  let cost = missingIronPieces(bot).reduce((sum, c) => sum + c, 0);
  // The spare pickaxe the diamond trip wants — until the trip has paid off
  // and a diamond one is in hand.
  const goodPicks = held.filter((name) => GOOD_PICKAXE.test(name)).length;
  const diamondPick = held.some((name) => /^(diamond|netherite)_pickaxe$/.test(name));
  if (!diamondPick && goodPicks < 2) cost += IRON_COST.iron_pickaxe;

  let loose = held.reduce((sum, name) => sum + (LOOSE_IRON.includes(name) ? IRON_COST[name] : 0), 0);
  // Raw iron cooking in a furnace is still ours — see smelt.js's pending batch.
  // It dropped out of the count while it cooked, 11 → 9 on 09-24.
  const cooking = bot.smeltingBatch;
  if (cooking?.expecting === 'iron_ingot') loose += cooking.count;
  return Math.max(0, cost - loose);
}

/**
 * Crafting and equipping progression: tools, then armour, then torches.
 *
 * Each run() does exactly ONE thing and returns, so the director can
 * re-check priorities between every craft rather than this hogging the bot.
 */

/**
 * PICKAXE FIRST. The order here is the speedrun.
 *
 * It used to be sword-first, which is defensible for survival and wrong for
 * progress: the pickaxe is the only tool that unlocks the next tier. Wooden
 * pickaxe gets stone, stone pickaxe gets iron, iron pickaxe gets diamond —
 * every single step of the run is gated on it, and nothing else is gated on
 * anything. A sword makes the bot safer at the tier it is already stuck on.
 *
 * Both are seconds apart at a crafting table, so this costs nothing in
 * safety and buys the whole chain starting earlier.
 */
const TOOL_TYPES = ['pickaxe', 'sword', 'axe'];

// Vanilla recipe costs: material units + sticks.
const TOOL_COST = {
  sword: { material: 2, sticks: 1 },
  pickaxe: { material: 3, sticks: 2 },
  axe: { material: 3, sticks: 2 },
  shovel: { material: 1, sticks: 2 },
};

// Best tier first. Ranks line up with tierRank() in inventory.js.
const TIERS = [
  { name: 'diamond', material: 'diamond', rank: 1 },
  { name: 'iron', material: 'iron_ingot', rank: 2 },
  { name: 'stone', material: 'cobblestone', rank: 3 },
  { name: 'wooden', material: null, rank: 5 }, // material resolved to planks
];

// Ordered by protection per unit of material, so scarce diamond goes to the
// chestplate (8 armour points) before the boots (3). With a partial set that
// ordering is the difference between surviving a fight and not.
const ARMOR_SLOTS = [
  { piece: 'chestplate', slot: 'torso', cost: 8 },
  { piece: 'leggings', slot: 'legs', cost: 7 },
  { piece: 'helmet', slot: 'head', cost: 5 },
  { piece: 'boots', slot: 'feet', cost: 4 },
];

const ARMOR_TIERS = [
  { name: 'diamond', material: 'diamond' },
  { name: 'iron', material: 'iron_ingot' },
  { name: 'leather', material: 'leather' },
];

// Which armour tier beats which, so an upgrade is never a downgrade.
const ARMOR_RANK = { diamond: 0, iron: 1, golden: 2, chainmail: 3, leather: 4 };

function armorRankOf(name) {
  const tier = name.split('_')[0];
  return ARMOR_RANK[tier] ?? 99;
}

function materialCount(bot, tier) {
  // Stone tools accept any of the stone-material items, not just literal
  // cobblestone (cobbled_deepslate counts, granite does not).
  if (tier.name === 'stone') return countAny(bot, STONE_MATERIAL);
  if (tier.name !== 'wooden') return itemCount(bot, tier.material);

  // Logs count too — each one crafts into 4 planks on demand. Counting only
  // existing planks made the bot conclude it couldn't build anything while
  // holding a stack of wood, which stalled the whole progression.
  const planks = countAny(bot, plankNames(bot));
  const logs = bot.inventory.items()
    .filter((i) => i.name.endsWith('_log'))
    .reduce((sum, i) => sum + i.count, 0);
  return planks + logs * 4;
}

/**
 * When to build a replacement before the current tool dies.
 *
 * Deliberately NOT "always carry two". A diamond pickaxe lasts 1561 blocks,
 * so a spare one costs three diamonds that belong in a chestplate; a stone
 * pickaxe lasts 131 and will absolutely break mid-tunnel. So the trigger is
 * how worn the current tool is, not how many we hold — which naturally
 * means cheap tools get replaced often and expensive ones almost never.
 */
const SPARE_PICKAXE_BELOW = 0.5;

/**
 * Is a better TIER actually available right now?
 *
 * The one legitimate reason to exceed MAX_PER_TOOL_TYPE: holding two stone
 * pickaxes is no reason to refuse the iron one. `tidy` drops the worst of the
 * three within a scheduling round or two, so the overshoot is momentary.
 */
function isUpgradeInTier(bot, toolType, held) {
  if (!held) return true;
  const heldRank = tierRank(held.name);
  const cost = TOOL_COST[toolType] ?? { material: 3 };
  for (const tier of TIERS) {
    if (tier.rank >= heldRank) break;
    if (!bot.registry.itemsByName[`${tier.name}_${toolType}`]) continue;
    if (!ironIsSpareFor(bot, tier, toolType)) continue;
    if (materialCount(bot, tier) >= cost.material) return true;
  }
  return false;
}

/**
 * IRON GOES TO THE PICKAXE FIRST. Everything else waits.
 *
 * Stated plainly by the user: "the first iron thing he makes must be a shield
 * and then iron pickaxe and then everything else". The shield is handled above
 * — one ingot, taken before anything — and this is the other half.
 *
 * Without it the ordering quietly broke on arithmetic: an iron sword costs two
 * ingots and an iron pickaxe costs three, so a bot holding exactly two ingots
 * would skip the pickaxe it could not yet afford and spend them on the sword,
 * then need three MORE before the only tool that unlocks diamond. The list is
 * pickaxe-first and it still came out sword-first.
 */
function ironIsSpareFor(bot, tier, toolType) {
  if (tier.name !== 'iron' && tier.name !== 'diamond') return true;
  if (toolType === 'pickaxe') return true;
  if (!hasIronPickaxe(bot)) return false;
  // ...and the AXE waits for the armour.
  //
  // An iron axe is three ingots — most of a pair of boots — and a stone one
  // chops wood perfectly well. `nextGoal` runs tools before armour, so without
  // this the bot spends its fourth, fifth and sixth ingots on an axe upgrade it
  // barely notices while wearing nothing. Iron armour is 60% less damage taken
  // from everything, and dying is what actually costs this bot runs.
  //
  // And a DIAMOND axe waits for DIAMOND armour. Tools come before armour in
  // nextGoal, so with a full iron set on, the three diamonds after the sword
  // went into an axe — a tool the 29-diamond goal does not include, bought
  // with most of a pair of boots, ahead of every diamond armour piece.
  if (toolType === 'axe') {
    return armourComplete(bot, tier.name === 'diamond' ? ARMOR_RANK.diamond : ARMOR_RANK.iron);
  }
  return true;
}

/** Are all four armour slots filled with this tier or better? */
function armourComplete(bot, worstRankAllowed = ARMOR_RANK.iron) {
  for (const { slot } of ARMOR_SLOTS) {
    let worn;
    try {
      worn = bot.inventory.slots[bot.getEquipmentDestSlot(slot)]?.name;
    } catch {
      worn = null;
    }
    if (!worn) return false;
    if (armorRankOf(worn) > worstRankAllowed) return false;
  }
  return true;
}

/** Highest tier of `toolType` we could craft right now, if it beats what we hold. */
function toolUpgrade(bot, toolType) {
  const held = bestToolOfType(bot, toolType);
  const cost = TOOL_COST[toolType];

  // Arithmetic first, judgement second — see MAX_PER_TOOL_TYPE. Two of a type
  // is enough no matter what the wear-and-spare rules below would conclude.
  //
  // But two USEFUL ones. The cap counted every pickaxe in the bag, so a stone
  // pickaxe and the wooden one it replaced were "two" — and the worn stone
  // pickaxe could never be replaced, because the wooden one held the spare's
  // place. Watched live: `pick: stone` to `wooden` to `none` on the way down a
  // staircase at y=41, with 240 cobblestone in the bag and no spare ever
  // made. A tool below the best tier we hold is not a spare for it; it is the
  // surplus `tidy` drops once the real spare exists (see src/stock.js).
  const heldTier = held ? tierRank(held.name) : Infinity;
  const owned = bot.inventory.items()
    .filter((i) => i.name.endsWith(`_${toolType}`) && tierRank(i.name) <= heldTier)
    .length;
  if (owned >= MAX_PER_TOOL_TYPE && !isUpgradeInTier(bot, toolType, held)) return null;

  // Treat a nearly-dead tool as if we didn't have it.
  //
  // Tools breaking is routine, not an edge case: a stone pickaxe lasts 131
  // blocks and this bot mines constantly. Watched live, its pickaxe broke
  // and it silently fell back to a WOODEN one — which cannot mine iron at
  // all — quietly undoing the whole progression with no error anywhere.
  // Replacing at 15% means the replacement is crafted while the materials
  // are still in the bag and while a crafting table is still reachable.
  const worn = toolIsWornOut(bot, toolType);

  // A pickaxe is the lifeline underground: once it's half gone and we have
  // no backup, build the backup now, while a crafting table and the
  // materials are both still within reach.
  // The spare has to be as good as the tool it backs up — see the cap above.
  const wantSpare = toolType === 'pickaxe'
    && held
    && durabilityLeft(held) < SPARE_PICKAXE_BELOW
    && countUsableTools(bot, toolType, held) < 2;

  const heldRank = (held && !worn && !wantSpare) ? tierRank(held.name) : Infinity;

  for (const tier of TIERS) {
    const name = `${tier.name}_${toolType}`;
    if (!bot.registry.itemsByName[name]) continue;
    if (tier.rank >= heldRank) break; // already have this good or better
    // Never "replace" a good tool with a worse one just to have a spare.
    if (held && !worn && tier.rank > tierRank(held.name)) break;
    // The pickaxe has first claim on every ingot — see ironIsSpareFor.
    if (!ironIsSpareFor(bot, tier, toolType)) continue;
    const haveMaterial = materialCount(bot, tier) >= cost.material;
    // Sticks are cheap and we can usually make more from logs.
    const canGetSticks = itemCount(bot, 'stick') >= cost.sticks
      || countAny(bot, plankNames(bot)) >= 2
      || !!findItem(bot, (i) => i.name.endsWith('_log'));
    if (haveMaterial && canGetSticks) return { item: name, tier };
  }
  return null;
}

function armorUpgrade(bot) {
  for (const tier of ARMOR_TIERS) {
    // Armour is where the iron goes AFTER the pickaxe, never before it.
    //
    // A chestplate costs eight ingots — nearly three pickaxes — so without this
    // the bot could wear a full iron set while still mining with stone, which
    // cannot harvest a diamond at all. Same rule one tier up: the diamond
    // pickaxe comes before diamond plate.
    if (tier.name === 'iron' && !hasIronPickaxe(bot)) continue;
    if (tier.name === 'diamond' && !bestToolOfType(bot, 'pickaxe')?.name.startsWith('diamond')) continue;

    for (const { piece, slot, cost } of ARMOR_SLOTS) {
      const name = `${tier.name}_${piece}`;
      if (!bot.registry.itemsByName[name]) continue;

      const wornName = bot.inventory.slots[bot.getEquipmentDestSlot(slot)]?.name;
      // Only replace with a strictly better tier. The old check hardcoded
      // "iron beats leather" and nothing else, so diamond armour could never
      // replace iron — which made a full diamond set unreachable even with
      // the diamonds in hand.
      if (wornName && armorRankOf(name) >= armorRankOf(wornName)) continue;
      if (hasItem(bot, name)) return { item: name, slot, ready: true, cost, material: tier.material };
      if (itemCount(bot, tier.material) >= cost) return { item: name, slot, ready: false, cost, material: tier.material };
    }
  }
  return null;
}

/**
 * A shield is the best survivability-per-resource item in the game, and the
 * bot was never building one.
 *
 * Six planks and a single iron ingot. It blocks skeleton arrows completely
 * and cuts creeper blast damage by roughly two thirds — the two things that
 * killed this bot most often. SWORD_PVP_CONFIG already enables shieldConfig,
 * so the combat engine raises and lowers it automatically; the only thing
 * missing was ever having one in the bag.
 *
 * Gated behind the iron pickaxe so it can't steal the three ingots that open
 * up diamond. Past that, one ingot is a trivial price.
 */
const SHIELD_PLANKS = 6;

function wantsShield(bot) {
  if (hasItem(bot, 'shield')) return false;
  if (!bot.registry.itemsByName.shield) return false;
  // The very FIRST ingot goes here, ahead of the iron pickaxe.
  //
  // This was gated behind having an iron pickaxe already, which was the wrong
  // way round: the pickaxe is the gate on diamond, but a bot that dies does
  // not mine anything at all, and dying is what this bot actually does. One
  // ingot buys immunity to arrows and roughly two thirds of a creeper — by
  // far the best survivability per unit of iron available, better than any
  // armour piece. The remaining three ingots for the pickaxe arrive within
  // minutes once it is at iron depth.
  return itemCount(bot, 'iron_ingot') >= 1
    && (countAny(bot, plankNames(bot)) >= SHIELD_PLANKS
      || !!findItem(bot, (i) => i.name.endsWith('_log')));
}

/**
 * TORCHES ARE GONE, deliberately and on instruction.
 *
 * The bot was never any good at placing them. Every version of the placement
 * rule produced the same thing from the outside: a bot that stopped mid-task,
 * fiddled at a wall, often failed, and carried on — and the version gated on
 * spawnable-spot scanning was also one of the most expensive checks in the
 * whole program.
 *
 * The case FOR them was spawn suppression in the bot's own corridors. That
 * case is real but it is not the only answer to it, and it is not the answer
 * this bot is good at: a shield plus a stone sword handles what spawns behind
 * it, and it is not building a base it needs to keep lit. Nothing here is
 * building for permanence — it digs a staircase, takes the ore, and leaves.
 *
 * So the whole chain is removed rather than tuned again: no torch crafting,
 * no torch placement behavior, and no torch prerequisite on the descent.
 * Coal and charcoal stay, because they are FUEL and the furnace needs them.
 */

/**
 * A craft that keeps failing gets left alone for a while.
 *
 * Escalating, because the two causes want different answers. A transient
 * failure — the table was briefly out of reach, a mob bumped us mid-window — is
 * worth retrying in a second. A structural one — the recipe needs something the
 * bot has misjudged owning — is worth not retrying at all, and retrying it
 * anyway is expensive: `ensureSticks` runs before every attempt and converts
 * logs into sticks whether or not the tool ever gets made.
 */
const CRAFT_BACKOFF_BASE_MS = 4000;
const CRAFT_BACKOFF_MAX_MS = 60000;

function craftFailures(ctx) {
  ctx.gear = ctx.gear ?? { failures: new Map() };
  ctx.gear.failures = ctx.gear.failures ?? new Map();
  return ctx.gear.failures;
}

/**
 * `why` names the blocker. "Could not make that {iron_pickaxe}" nine times in
 * a row on 09-25 said nothing about whether it was the table, the sticks or
 * the iron — and it was the wood, which is the one that would have mattered.
 */
function noteCraftFailure(ctx, item, why = null) {
  const failures = craftFailures(ctx);
  const strikes = (failures.get(item)?.strikes ?? 0) + 1;
  const wait = Math.min(CRAFT_BACKOFF_BASE_MS * 2 ** (strikes - 1), CRAFT_BACKOFF_MAX_MS);
  failures.set(item, { strikes, until: Date.now() + wait });
  logger.info('Could not make that — leaving it a moment', {
    item, strikes, forMs: wait, ...(why ? { why } : {}),
  });
}

/** What a tool recipe is short of right now, as "have/need" — or null. */
function toolShortfall(bot, tier, cost) {
  const short = {};
  const sticks = itemCount(bot, 'stick');
  if (sticks < cost.sticks) short.stick = `${sticks}/${cost.sticks}`;
  const material = tier.name === 'wooden'
    ? countAny(bot, plankNames(bot))
    : materialCount(bot, tier);
  if (material < cost.material) short[tier.name === 'wooden' ? 'planks' : tier.material] = `${material}/${cost.material}`;
  return Object.keys(short).length ? short : null;
}

function clearCraftFailure(ctx, item) {
  craftFailures(ctx).delete(item);
}

function onCooldown(ctx, item) {
  const entry = craftFailures(ctx).get(item);
  return !!entry && entry.until > Date.now();
}

/**
 * A stone-or-better tool of every type the bot makes: pickaxe, sword, axe.
 *
 * The user's order for a new world: "enough wood first, then dig down to get
 * full stone stuff", and only then "enough food". hunt.js holds routine
 * hunting behind this.
 */
function stoneKitDone(bot) {
  const stone = tierRank('stone_pickaxe');
  return TOOL_TYPES.every((type) => {
    const tool = bestToolOfType(bot, type);
    return !!tool && tierRank(tool.name) <= stone;
  });
}

function nextGoal(bot) {
  // Shield before tools when the iron is there. See wantsShield — one ingot
  // is worth more here than anywhere else it could go.
  if (wantsShield(bot)) return { kind: 'shield', item: 'shield' };
  // TOOL_TYPES is pickaxe-first — see the note on it above. The sword is not
  // neglected by that: `gear.canInterrupt` takes the wheel for a sword the
  // moment the bot has none, and a sword costs two of the material a pickaxe
  // costs three of, so both are usually made in the same visit.
  for (const toolType of TOOL_TYPES) {
    const upgrade = toolUpgrade(bot, toolType);
    if (upgrade) return { kind: 'tool', ...upgrade };
  }
  const armor = armorUpgrade(bot);
  if (armor) return { kind: 'armor', ...armor };
  return null;
}

const gear = {
  name: 'gear',
  priority: 40,
  shouldRun(bot, ctx) {
    const goal = nextGoal(bot);
    // A goal we are backing off from is not a reason to be picked: without
    // this the director hands `gear` the wheel, run() refuses on the cooldown,
    // and the no-op backoff has to relearn the same fact three strikes at a
    // time while everything below it waits.
    return !!goal && !onCooldown(ctx, goal.item);
  },
  /**
   * Being unarmed is urgent enough to interrupt whatever else is happening —
   * every other behavior is worse at its job without a weapon, and combat
   * refuses to engage at all.
   */
  canInterrupt(bot) {
    if (bestToolOfType(bot, 'sword')) return false;
    const goal = nextGoal(bot);
    return !!goal && goal.kind === 'tool' && goal.item.endsWith('_sword');
  },
  async run(bot, ctx, task) {
    const goal = nextGoal(bot);
    if (!goal) return false;

    // Anything already in the bag just needs wearing — no table trip needed.
    if (goal.kind === 'armor' && goal.ready) {
      const piece = findItem(bot, (i) => i.name === goal.item);
      if (!piece) return false;
      if (!(await equipTo(bot, piece, goal.slot))) return false;
      logger.action('Equipped armor', { item: goal.item });
      return true;
    }

    // Stop hammering a craft that keeps failing.
    //
    // Every failed attempt at a tool costs real materials: `ensureSticks` and
    // `ensurePlanks` run first and convert logs, so a goal that cannot be
    // completed converts the bot's entire wood supply into sticks a few at a
    // time while `gear` is re-picked every scheduling round. Watched live with
    // "need: wood" on every status line and the bot holding one plank.
    if (onCooldown(ctx, goal.item)) return false;

    // ensureTable now guarantees we're standing at a usable table — it walks
    // there itself, proves it is inside arm's reach, and disowns one it can't
    // get to, rather than handing back a table on the far side of a ravine.
    const table = await ensureTable(bot, ctx, task);
    if (!table) {
      noteCraftFailure(ctx, goal.item, 'no crafting table');
      return false;
    }
    task.throwIfAborted();

    // Every path below returns craftItem's own result. Returning undefined
    // told the director "work done" even when the craft silently failed —
    // so nextGoal kept proposing the same impossible item, gear kept being
    // picked, and the no-op backoff never engaged. That's an infinite loop
    // that starves every lower-priority behavior.
    if (goal.kind === 'tool') {
      const cost = TOOL_COST[goal.item.split('_').pop()] || { material: 3, sticks: 2 };
      // Sticks first: making them consumes planks, so doing it the other way
      // round can eat the very planks the tool itself needs.
      // And CHECK them. Both results were ignored: at 13:25:05 on 09-26 the
      // plank craft "reported success but nothing appeared", sticks stayed at
      // one, and the stone axe was attempted anyway and blamed on the recipe.
      const handles = await ensureSticks(bot, cost.sticks, task);
      const planks = goal.tier.name !== 'wooden' || await ensurePlanks(bot, cost.material, task);
      task.throwIfAborted();
      if (!handles || !planks) {
        noteCraftFailure(ctx, goal.item, toolShortfall(bot, goal.tier, cost) ?? 'could not make the sticks or planks');
        return false;
      }
      const made = await craftItem(bot, goal.item, 1, table, task);
      if (!made) noteCraftFailure(ctx, goal.item, toolShortfall(bot, goal.tier, cost) ?? 'recipe refused');
      else clearCraftFailure(ctx, goal.item);
      return made;
    }

    if (goal.kind === 'armor') {
      if (!(await craftItem(bot, goal.item, 1, table, task))) {
        noteCraftFailure(ctx, goal.item, `recipe refused (${goal.cost ?? '?'} ${goal.material ?? 'material'} needed)`);
        return false;
      }
      clearCraftFailure(ctx, goal.item);
      const piece = findItem(bot, (i) => i.name === goal.item);
      if (piece && await equipTo(bot, piece, goal.slot)) {
        logger.action('Equipped armor', { item: goal.item });
      }
      return true;
    }

    if (goal.kind === 'shield') {
      const planks = await ensurePlanks(bot, SHIELD_PLANKS, task);
      task.throwIfAborted();
      if (!planks) {
        noteCraftFailure(ctx, goal.item, { planks: `${countAny(bot, plankNames(bot))}/${SHIELD_PLANKS}` });
        return false;
      }
      if (!(await craftItem(bot, 'shield', 1, table, task))) {
        noteCraftFailure(ctx, goal.item, `recipe refused (iron ${itemCount(bot, 'iron_ingot')}/1)`);
        return false;
      }
      clearCraftFailure(ctx, goal.item);
      // Straight into the off-hand, so it is already up the next time
      // something shoots at us rather than a slot later.
      const shield = findItem(bot, (i) => i.name === 'shield');
      // off-hand refused, or the server never replied? tactics.js retries
      // before every fight, so this is best-effort by design.
      if (shield && await equipTo(bot, shield, 'off-hand')) {
        logger.action('Shield up', { blocks: 'arrows, and most of a creeper' });
      }
      return true;
    }

    return false;
  },
};

// nextGoal is exported for test/progression.test.js: it is the single
// function that decides what the bot builds next, so a deadlock in it
// stalls everything downstream of it.
module.exports = {
  gear,
  nextGoal,
  // How much iron the bot has MINED, counting what it has since spent on
  // tools and armour. Without this the mining target can never be met — see
  // ironInvested.
  ironInvested,
  // ...and the same for diamond, which is what the whole run is counting.
  diamondInvested, DIAMOND_COST,
  hasIronPickaxe,
  // What is left to mine for the iron kit — see the comment above it.
  ironStillNeeded, missingIronPieces,
  IRON_COST,
  MAX_PER_TOOL_TYPE,
  // What "the full stone kit" means to hunt.js, and what a pickaxe costs to
  // shelter.js's wood reserve — one list and one recipe table, not copies.
  TOOL_TYPES, TOOL_COST, stoneKitDone,
};
