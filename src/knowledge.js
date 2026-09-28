/**
 * What the bot knows about Minecraft without having to look.
 *
 * Two kinds of information drive good play, and the bot only had one of them.
 * ACTIVE information is what the client is told each tick — where things are,
 * what time it is, how much light a block has — and src/world.js reads that.
 * PASSIVE information is what a player simply knows: how much damage a
 * creeper does, that gold armour is barely better than leather, that cooked
 * beef is worth twice what raw beef is, that iron peaks at y=16.
 *
 * Without the passive half the bot re-derives things badly or not at all. It
 * would trade with a skeleton at range because nothing told it a skeleton
 * out-damages it from twelve blocks away; it would eat raw chicken because
 * nothing told it about food poisoning.
 *
 * Everything here is vanilla 1.21 data, kept as plain tables so it can be
 * handed to Jev as context as easily as it can be read by a hardcoded rule.
 */

/**
 * Hostile mobs: what they do to us, and what we should do about them.
 *
 * `damage` is on Normal difficulty.
 *
 * `reach` and `range` are DIFFERENT and conflating them was a real bug.
 * `reach` is how close a mob must be to land a MELEE hit — the number the
 * standoff is built from. `range` is how far a shooter can hurt us from.
 * A skeleton's reach is about 2.4 and its range is 15, and using 15 as its
 * reach made the bot try to stand sixteen blocks away to fight it (the
 * standoff cap saved it) and hold its shield up permanently while closing,
 * at half speed, against the one enemy it most needs to close on quickly.
 */
const MOBS = {
  zombie: {
    health: 20, damage: 3, reach: 2.2, speed: 0.23, ranged: false, burnsInDay: true,
  },
  husk: {
    health: 20, damage: 3, reach: 2.2, speed: 0.23, ranged: false, burnsInDay: false,
  },
  drowned: {
    health: 20,
    damage: 3,
    reach: 2.2,
    range: 12,
    // On LAND it is an ordinary zombie. In water it is the fastest thing
    // there, and faster than we are — a swimming player manages about 0.11
    // blocks a tick against its 0.15, so "swim away" is not an option and
    // treating it as one is how the bot died twice without fighting back.
    speed: 0.23,
    waterSpeed: 0.15,
    ranged: true,
    swims: true,
    note: 'faster than us IN WATER; throws its trident for 9. Fight it from land if there is any.',
  },
  skeleton: {
    health: 20, damage: 4, reach: 2.4, range: 15, speed: 0.25, ranged: true, burnsInDay: true,
  },
  stray: {
    health: 20, damage: 4, reach: 2.4, range: 15, speed: 0.25, ranged: true, note: 'arrows slow you',
  },
  bogged: {
    health: 16, damage: 4, reach: 2.4, range: 15, speed: 0.25, ranged: true,
  },
  creeper: {
    health: 20,
    damage: 22, // point blank, unarmoured — survivable only at full health
    reach: 3,
    speed: 0.25,
    ranged: false,
    fuseTicks: 30, // 1.5 seconds
    blastRadius: 3,
    note: 'fuse resets if you leave the 3-block trigger radius',
  },
  spider: {
    health: 16, damage: 2, reach: 2.0, speed: 0.3, ranged: false, note: 'faster than us; climbs',
  },
  cave_spider: { health: 12, damage: 2, reach: 2.0, speed: 0.3, ranged: false, poisons: true },
  witch: {
    health: 26, damage: 6, reach: 2.4, range: 8, speed: 0.25, ranged: true, note: 'heals itself; close fast',
  },
  enderman: {
    health: 40, damage: 7, reach: 3, speed: 0.3, ranged: false, note: 'neutral unless looked at',
  },
  pillager: {
    health: 24, damage: 5, reach: 2.4, range: 16, speed: 0.35, ranged: true,
  },
  vindicator: { health: 24, damage: 13, reach: 2.2, speed: 0.35, ranged: false, note: 'hits very hard' },
  phantom: { health: 20, damage: 2, reach: 2, speed: 0.4, ranged: false, note: 'spawns after 3 sleepless days' },
  slime: { health: 16, damage: 2, reach: 2, speed: 0.2, ranged: false },
  blaze: {
    health: 20, damage: 6, reach: 2.4, range: 16, speed: 0.23, ranged: true,
  },
  warden: {
    health: 500, damage: 30, reach: 5, range: 20, speed: 0.3, ranged: true, note: 'never fight',
  },
};

/**
 * Food, by what it is actually worth.
 *
 * `hunger` refills the bar; `saturation` decides how long before it starts
 * dropping again — which is why cooked food is worth roughly double raw, and
 * why cooking before eating is nearly always right.
 */
const FOODS = {
  cooked_beef: { hunger: 8, saturation: 12.8 },
  cooked_porkchop: { hunger: 8, saturation: 12.8 },
  cooked_mutton: { hunger: 6, saturation: 9.6 },
  cooked_chicken: { hunger: 6, saturation: 7.2 },
  cooked_rabbit: { hunger: 5, saturation: 6 },
  cooked_salmon: { hunger: 6, saturation: 9.6 },
  cooked_cod: { hunger: 5, saturation: 6 },
  bread: { hunger: 5, saturation: 6 },
  baked_potato: { hunger: 5, saturation: 6 },
  golden_carrot: { hunger: 6, saturation: 14.4 },
  beef: { hunger: 3, saturation: 1.8, raw: true },
  porkchop: { hunger: 3, saturation: 1.8, raw: true },
  mutton: { hunger: 2, saturation: 1.2, raw: true },
  chicken: { hunger: 2, saturation: 1.2, raw: true, risk: 'food poisoning, 30%' },
  rabbit: { hunger: 3, saturation: 1.8, raw: true },
  carrot: { hunger: 3, saturation: 3.6 },
  apple: { hunger: 4, saturation: 2.4 },
  melon_slice: { hunger: 2, saturation: 1.2 },
  sweet_berries: { hunger: 2, saturation: 0.4 },
  glow_berries: { hunger: 2, saturation: 0.4 },
  potato: { hunger: 1, saturation: 0.6 },
  beetroot: { hunger: 1, saturation: 1.2 },
  rotten_flesh: { hunger: 4, saturation: 0.8, risk: 'hunger effect, 80%' },
};

/**
 * Tool tiers: durability, and how much faster they break things.
 *
 * The bot replaces tools on a durability fraction, and these are the numbers
 * that make "a stone pickaxe will not survive the trip to y=-59" a fact
 * rather than a guess — 131 blocks does not cover a descent plus a session.
 */
const TOOL_TIERS = {
  wooden: { durability: 59, speed: 2, mines: ['stone'] },
  stone: { durability: 131, speed: 4, mines: ['stone', 'iron', 'coal', 'copper', 'lapis'] },
  iron: {
    durability: 250, speed: 6, mines: ['stone', 'iron', 'coal', 'copper', 'lapis', 'gold', 'redstone', 'diamond', 'emerald'],
  },
  diamond: { durability: 1561, speed: 8, mines: ['everything except ancient_debris without netherite'] },
  golden: { durability: 32, speed: 12, mines: ['stone', 'coal'], note: 'breaks almost immediately' },
  netherite: { durability: 2031, speed: 9, mines: ['everything'] },
};

/**
 * Difficulty, and what it actually does to us.
 *
 * Every `damage` figure in MOBS above is the Normal value, because that is how
 * the wiki states them — but the server may be running any of four settings,
 * and the difference is not cosmetic: a zombie hits for 2.5 on Easy and 4.5 on
 * Hard, and a vindicator for 7.5 against 19.5. A bot that plans its fights
 * against the Normal numbers is either needlessly timid or fatally bold, and
 * has no way to tell which.
 *
 * The scaling itself lives in the PLAYER's damage handler, not the mob's, and
 * applies to every difficulty-scaled source (mob melee, mob-caused explosions)
 * but not to falls, drowning or starvation. Vanilla:
 *
 *   peaceful  no damage from hostiles at all — they do not spawn
 *   easy      min(amount / 2 + 1, amount)
 *   normal    amount
 *   hard      amount * 3 / 2
 *
 * Checked against the published tables: a zombie's base 3 gives 2.5 / 3 / 4.5,
 * and a vindicator's 13 gives 7.5 / 13 / 19.5. Both match exactly, which is
 * what makes the reverse direction — observing a hit and working out which
 * difficulty produced it — possible at all. See src/difficulty.js.
 */
const DIFFICULTIES = ['peaceful', 'easy', 'normal', 'hard'];

function scaleDamage(amount, difficulty) {
  switch (difficulty) {
    case 'peaceful': return 0;
    case 'easy': return Math.min(amount / 2 + 1, amount);
    case 'hard': return (amount * 3) / 2;
    default: return amount; // normal, and anything we don't recognise
  }
}

/** Armour points per piece. A full diamond set is 20; each point is 4% less damage. */
const ARMOR_POINTS = {
  leather: {
    helmet: 1, chestplate: 3, leggings: 2, boots: 1,
  },
  golden: {
    helmet: 2, chestplate: 5, leggings: 3, boots: 1,
  },
  chainmail: {
    helmet: 2, chestplate: 5, leggings: 4, boots: 1,
  },
  iron: {
    helmet: 2, chestplate: 6, leggings: 5, boots: 2,
  },
  diamond: {
    helmet: 3, chestplate: 8, leggings: 6, boots: 3,
  },
  netherite: {
    helmet: 3, chestplate: 8, leggings: 6, boots: 3,
  },
};

/**
 * Armour toughness, which is a SECOND stat and only diamond and netherite
 * have any. It matters because it changes the shape of the protection curve:
 * plain armour points get worse the harder you are hit, and toughness is what
 * stops that. Needed here so the damage the bot actually takes can be
 * predicted accurately enough to work backwards to the difficulty.
 */
const ARMOR_TOUGHNESS = { diamond: 2, netherite: 3 };

/**
 * How much of a hit gets through the armour currently worn, as a fraction.
 *
 * The 1.9+ formula, not the "4% per point" approximation used in the Jev
 * briefing: against a big hit the approximation is badly wrong, and a big hit
 * is exactly the case that decides whether the bot lives.
 *
 *   reduction = min(20, max(points / 5, points - damage / (2 + toughness / 4)))
 *   taken     = damage * (1 - reduction / 25)
 */
function armorMultiplier(points, toughness, damage) {
  if (!points) return 1;
  const reduction = Math.min(
    20,
    Math.max(points / 5, points - damage / (2 + toughness / 4)),
  );
  return 1 - reduction / 25;
}

/** Armour points and toughness currently worn, read straight off the bot. */
function armorWorn(bot) {
  let points = 0;
  let toughness = 0;
  for (const slot of ['head', 'torso', 'legs', 'feet']) {
    const name = bot.inventory?.slots?.[bot.getEquipmentDestSlot(slot)]?.name;
    if (!name) continue;
    const tier = name.split('_')[0];
    const piece = name.split('_').slice(1).join('_');
    points += ARMOR_POINTS[tier]?.[piece] ?? 0;
    toughness += ARMOR_TOUGHNESS[tier] ?? 0;
  }
  return { points, toughness };
}

/**
 * What one hit from this mob would actually cost us right now: its Normal
 * damage, scaled for the difficulty in force, then reduced by what we wear.
 */
function expectedHit(bot, mobName, difficulty) {
  const base = mobFacts(mobName).damage;
  const scaled = scaleDamage(base, difficulty);
  const { points, toughness } = armorWorn(bot);
  return scaled * armorMultiplier(points, toughness, scaled);
}

/**
 * Which ore needs which pickaxe. Mining with too soft a tool breaks the block
 * and drops NOTHING, which is worse than not mining it — the bot loses the
 * ore permanently and gets no warning.
 */
const ORE_REQUIRES = {
  coal_ore: 'wooden',
  copper_ore: 'stone',
  iron_ore: 'stone',
  lapis_ore: 'stone',
  gold_ore: 'iron',
  redstone_ore: 'iron',
  diamond_ore: 'iron',
  emerald_ore: 'iron',
  ancient_debris: 'diamond',
};

const TIER_ORDER = ['wooden', 'golden', 'stone', 'iron', 'diamond', 'netherite'];

/** Can this pickaxe tier actually collect this ore? */
function canHarvest(pickaxeTier, oreName) {
  const base = String(oreName).replace(/^deepslate_/, '');
  const needed = ORE_REQUIRES[base];
  if (!needed) return true;
  // Gold is a special case: fast, but it cannot mine much.
  const rank = (tier) => {
    if (tier === 'golden') return TIER_ORDER.indexOf('wooden');
    return TIER_ORDER.indexOf(tier);
  };
  return rank(pickaxeTier) >= rank(needed);
}

/**
 * What an ore block actually gives you, e.g. deepslate_iron_ore -> raw_iron.
 *
 * Here rather than in behaviors/mine.js because the question "is this ore
 * worth breaking" is asked well outside mining: by the pathfinder's list of
 * blocks it may not dig, and by inventory.js when it clears a pocket or a
 * ceiling. inventory.js cannot import mine.js, and a second copy of this table
 * is exactly how "unwanted" drifted before — see isUnwantedOre in stock.js.
 */
const ORE_YIELD = {
  coal_ore: 'coal',
  iron_ore: 'raw_iron',
  copper_ore: 'raw_copper',
  gold_ore: 'raw_gold',
  redstone_ore: 'redstone',
  lapis_ore: 'lapis_lazuli',
  diamond_ore: 'diamond',
  emerald_ore: 'emerald',
};

function yieldOf(oreName) {
  return ORE_YIELD[String(oreName).replace(/^deepslate_/, '')] ?? null;
}

/** Every ore block name, deepslate variants included. */
const ORE_BLOCKS = Object.keys(ORE_YIELD).flatMap((ore) => [ore, `deepslate_${ore}`]);

/** Everything we know about a mob, or a safe default for one we don't. */
function mobFacts(name) {
  return MOBS[name] || {
    health: 20, damage: 3, reach: 2.5, speed: 0.25, ranged: false, unknown: true,
  };
}

/** A sprinting player moves 0.28 blocks per tick — the bar for outrunning. */
const SPRINT_SPEED = 0.28;

/**
 * How much killing each animal costs.
 *
 * Bare fists do 1 damage, so a starving bot with no weapon needs eight swings
 * for a sheep and three for a chicken — while the animal runs away between
 * each one. Watched live: a bot at 0 food and 9 health chasing sheep for a
 * full minute and landing nothing, because prey was chosen by distance and
 * by whether it dropped wool, with no thought for whether it could actually
 * be killed.
 *
 * `drops` is what a kill yields beyond meat, which is why a sheep is still
 * worth preferring when the bot is armed and wants a bed.
 */
const ANIMALS = {
  chicken: { health: 4, food: 'chicken', drops: ['feather'] },
  rabbit: { health: 3, food: 'rabbit', drops: ['rabbit_hide'] },
  sheep: { health: 8, food: 'mutton', drops: ['wool'] },
  pig: { health: 10, food: 'porkchop', drops: [] },
  cow: { health: 10, food: 'beef', drops: ['leather'] },
  mooshroom: { health: 10, food: 'beef', drops: ['leather'] },
};

function animalFacts(name) {
  return ANIMALS[name] || { health: 10, food: null, drops: [] };
}

/**
 * Phantoms: the punishment for not sleeping.
 *
 * They begin spawning once the player has been awake for three full in-game
 * days, at night, and ONLY under open sky. They dive from above, which makes
 * them awkward for a bot that fights at a fixed standoff on the ground —
 * they spend most of the engagement out of reach and then arrive at speed.
 *
 * Almost everything about them is avoidable rather than fightable:
 *   - sleeping in a bed resets the counter to zero, which is the real fix
 *   - they cannot spawn where there is a block overhead, so a tunnel, a
 *     shelter, or even an overhang removes the problem entirely
 *   - they burn in daylight, so surviving until dawn also solves it
 *   - they are fast (0.4/tick, faster than sprinting) so fleeing does not work
 *
 * The practical rule: get a bed before day three, and if the counter is
 * already up, prefer being under cover at night over being in the open.
 */
const PHANTOM_INSOMNIA_DAYS = 3;

/**
 * Structures, and whether they are worth the detour.
 *
 * Each one is either a shortcut or a trap, and the difference matters far
 * more to a speedrun than to a casual player. A village is worth going out
 * of the way for; a pillager outpost will end the run.
 *
 * `detect` lists blocks that reliably indicate the structure nearby, since
 * the client is told nothing about structures directly and must infer them
 * from what it can see.
 */
const STRUCTURES = {
  village: {
    worth: 'high',
    detect: ['bell', 'composter', 'lectern', 'fletching_table', 'cartography_table'],
    gives: ['beds', 'crops', 'hay', 'iron from golems', 'anvils'],
    why: 'a bed here skips every night for the rest of the run',
    danger: 'iron golems hit for 21 — never attack a villager',
  },
  mineshaft: {
    worth: 'high',
    detect: ['rail', 'powered_rail', 'detector_rail', 'oak_fence', 'cobweb'],
    gives: ['exposed ore in the walls', 'chest loot', 'rails for iron'],
    why: 'pre-dug corridors at ore depth — far faster than strip mining',
    danger: 'cave spiders poison; spawners sit in the corridors',
  },
  ruined_portal: {
    worth: 'medium',
    detect: ['crying_obsidian', 'obsidian', 'netherrack', 'gilded_blackstone'],
    gives: ['obsidian', 'iron/gold from the chest', 'flint and steel'],
    why: 'free obsidian and often iron, with nothing guarding it',
  },
  desert_temple: {
    worth: 'medium',
    detect: ['chiseled_sandstone', 'orange_terracotta', 'blue_terracotta'],
    gives: ['diamonds', 'iron', 'gold', 'emeralds'],
    why: 'one of the only places to find diamonds without mining',
    danger: 'NINE TNT under the centre blue floor tile — break in from the side wall',
  },
  pillager_outpost: {
    worth: 'avoid',
    detect: ['dark_oak_log', 'white_banner', 'birch_fence'],
    danger: 'pillagers hit for 5 at 16 blocks and spawn continuously',
    why: 'nothing here is worth an early-game death',
  },
  ocean_monument: {
    worth: 'avoid',
    detect: ['prismarine', 'prismarine_bricks', 'dark_prismarine', 'sea_lantern'],
    danger: 'guardians, mining fatigue, and drowning all at once',
  },
  witch_hut: {
    worth: 'avoid',
    // `crafting_table` used to be in here, and it is a marker the BOT PLACES
    // ITSELF. Combined with spruce_log — ordinary taiga terrain — that meant
    // a bot which set up a workshop among conifers would identify its own
    // base as a witch hut and be told to avoid it. A detector must never key
    // on something the bot manufactures.
    detect: ['cauldron', 'spruce_log', 'spruce_planks'],
    danger: 'a witch heals itself and throws poison',
  },
};

/**
 * Markers that must never be used for detection.
 *
 * Anything the bot places itself will eventually appear next to it, so keying
 * a structure on one guarantees a false positive at its own base.
 */
const BOT_PLACED = new Set([
  'crafting_table', 'furnace', 'smoker', 'blast_furnace', 'torch', 'chest',
]);

/** Which structure, if any, these nearby block names suggest. */
function structureFrom(blockNames) {
  const seen = new Set(blockNames.filter((b) => !BOT_PLACED.has(b)));
  for (const [name, info] of Object.entries(STRUCTURES)) {
    // Two distinct markers, so a stray rail is not mistaken for a whole
    // mineshaft — and never counting anything the bot placed itself.
    const hits = info.detect.filter((b) => seen.has(b)).length;
    if (hits >= 2) return { name, ...info };
  }
  return null;
}

/** How good is this food, for choosing what to eat and what to cook first. */
function foodFacts(name) {
  return FOODS[name] || null;
}

/**
 * A compact briefing about one mob, for handing to Jev alongside the live
 * state. The model should not have to remember that a vindicator hits for 13.
 */
function describeMob(name) {
  const f = mobFacts(name);
  return {
    mob_type: name,
    its_health: f.health,
    damage_to_us: f.damage,
    its_reach: f.reach,
    faster_than_us: f.speed >= SPRINT_SPEED,
    attacks_at_range: !!f.ranged,
    ...(f.note ? { note: f.note } : {}),
  };
}

module.exports = {
  ARMOR_POINTS,
  DIFFICULTIES,
  SPRINT_SPEED,
  PHANTOM_INSOMNIA_DAYS,
  STRUCTURES,
  scaleDamage,
  armorMultiplier,
  armorWorn,
  expectedHit,
  TOOL_TIERS,
  canHarvest,
  ORE_YIELD,
  ORE_BLOCKS,
  yieldOf,
  mobFacts,
  animalFacts,
  foodFacts,
  describeMob,
  structureFrom,
};
