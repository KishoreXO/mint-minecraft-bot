/**
 * Which tool for which block. One table, stated once, no guessing.
 *
 * This kept being got wrong in small ways that added up, so it is now a
 * single explicit ruleset rather than a regex someone tweaks each time
 * something looks odd.
 *
 * The rule that caused the visible damage: leaves used to map to SWORD.
 * Breaking blocks with a sword costs 2 durability per block instead of 1,
 * and the bot breaks a lot of leaves — every tree it fells, every canopy it
 * cuts out of. So its only weapon was being ground down by gardening, and it
 * would arrive at a fight with a nearly-dead sword or none at all. A sword
 * is a WEAPON; the only block it is ever the right answer for is cobweb.
 *
 * Facts encoded here (Minecraft 1.17+):
 *   - hoe is the proper tool for leaves; shears also work and drop saplings
 *   - shears are correct for wool and vines
 *   - sword is correct for cobweb only
 *   - axe covers logs, planks and every wooden fixture, plus melon/pumpkin
 *   - pickaxe covers stone, ore, metal, ice, and terracotta/concrete
 *   - shovel covers the soft ground blocks
 *   - some blocks (glass, torches, plants) have no useful tool at all, and
 *     for those the right answer is BARE HANDS — not whatever we held last,
 *     which is how a pickaxe ends up chewing durability on tall grass.
 */

/**
 * Ordered rules; first match wins. `prefer` lists tool types best-first, so
 * a bot with no shears still does something sensible with leaves.
 *
 * `null` in `prefer` means "bare hands are correct here".
 */
const RULES = [
  // Cobweb is the one block a sword is genuinely the right tool for.
  { test: /^cobweb$/, prefer: ['sword', 'shears'] },

  // Leaves: shears drop saplings, hoe is the vanilla "correct" tool. Never
  // a sword — see the note above.
  { test: /_leaves$|^azalea_leaves$|^flowering_azalea_leaves$/, prefer: ['shears', 'hoe', null] },

  { test: /^(wool|.*_wool)$|^vine$|.*_vines$|^glow_lichen$/, prefer: ['shears', null] },

  // Wood and everything made of it.
  {
    test: /(_log|_wood|_stem|_hyphae|_planks|_slab|_stairs|_fence|_fence_gate|_door|_trapdoor|_sign|_button|_pressure_plate)$|^(bookshelf|crafting_table|chest|trapped_chest|barrel|ladder|melon|pumpkin|carved_pumpkin|bamboo|note_block|jukebox|composter|loom|cartography_table|fletching_table|smithing_table|lectern)$/,
    prefer: ['axe'],
  },

  // Stone, ore, metal, ice. Deliberately before the shovel rule because
  // several names contain both ("stone" and "sand" in "sandstone").
  {
    test: /(stone|_ore$|cobble|deepslate|granite|andesite|diorite|tuff|calcite|basalt|blackstone|obsidian|netherrack|brick|terracotta|concrete|anvil|furnace|smoker|rail|ice$|amethyst|dripstone|prismarine|purpur|quartz|sandstone|magma_block|glazed)|^(iron|gold|diamond|emerald|lapis|redstone|coal|copper|netherite|raw_iron|raw_gold|raw_copper)_block$/,
    prefer: ['pickaxe'],
  },

  // Soft ground.
  {
    test: /^(dirt|coarse_dirt|rooted_dirt|grass_block|podzol|mycelium|sand|red_sand|gravel|clay|soul_sand|soul_soil|farmland|dirt_path|snow|snow_block|powder_snow|mud|muddy_mangrove_roots)$/,
    prefer: ['shovel'],
  },

  // Nothing helps: glass, plants, torches, beds, redstone bits. Bare hands
  // are not a fallback here, they are the CORRECT answer — using a tool just
  // spends durability for no speed gain.
  {
    test: /glass|^torch$|_torch$|^(short_grass|tall_grass|fern|large_fern|dead_bush|seagrass|kelp|sugar_cane|cactus|.*_sapling|.*_flower|dandelion|poppy|blue_orchid|allium|azure_bluet|.*_tulip|oxeye_daisy|cornflower|lily_of_the_valley|wither_rose|sunflower|lilac|rose_bush|peony|sweet_berry_bush|moss_carpet|.*_carpet|.*_bed|redstone_wire|repeater|comparator|lever|tripwire|string)$/,
    prefer: [null],
  },
];

/**
 * Best-first list of tool types for a block.
 *
 * Returns an array so callers can fall back: `['shears', 'hoe', null]` means
 * shears if we have them, else a hoe, else bare hands. An empty array means
 * we have no opinion and whatever is in hand is fine.
 */
function toolPreferenceFor(block) {
  if (!block || !block.name) return [];
  for (const rule of RULES) {
    if (rule.test.test(block.name)) return rule.prefer;
  }
  return [];
}

/**
 * The single tool type to use, or null for bare hands.
 *
 * `has(toolType)` lets the caller answer from its own inventory without this
 * module needing to know anything about inventories.
 */
function toolTypeForBlock(block, has = () => true) {
  const preference = toolPreferenceFor(block);
  for (const type of preference) {
    if (type === null) return null; // bare hands are correct
    if (has(type)) return type;
  }
  // Nothing we own is listed. If the rule wanted a real tool, say so anyway
  // so the caller can at least avoid holding a sword.
  return preference.length > 0 && preference[0] !== null ? preference[0] : null;
}

/**
 * Should this item be kept out of the bot's hand for breaking blocks?
 *
 * Swords take double durability from block-breaking and are the one thing
 * the bot cannot afford to lose. Bows and shields do nothing useful at all.
 */
function isWeaponOrGear(itemName) {
  return /_sword$|^bow$|^crossbow$|^shield$|^trident$/.test(itemName || '');
}

module.exports = { toolTypeForBlock, toolPreferenceFor, isWeaponOrGear };
