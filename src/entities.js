/**
 * Entity classification.
 *
 * CRITICAL VERSION NOTE: `entity.type === 'mob'` is a trap. That value is
 * only ever set by mineflayer's handler for the legacy `spawn_entity_living`
 * packet, which Mojang REMOVED in 1.19. On 1.19+ every mob arrives via the
 * generic `spawn_entity` packet, where mineflayer fills the entity in from
 * minecraft-data instead — and that reports `type: 'hostile'` for a zombie
 * and `type: 'animal'` for a cow. So on any modern server a `=== 'mob'`
 * check silently matches nothing at all, forever.
 *
 * Everything here therefore matches on an explicit name list FIRST (stable
 * across versions) and only falls back to type/kind, so it works on both
 * old and new servers.
 */

/**
 * Mobs that attack on sight and are always worth treating as a threat.
 *
 * Deliberately EXCLUDES neutral mobs — see NEUTRAL_NAMES. Having enderman
 * and the piglins in here made the bot pick fights it had no business
 * picking: it walked up to an idle enderman and punched it, which is a
 * reliable way to die.
 */
const HOSTILE_NAMES = new Set([
  'zombie', 'husk', 'drowned', 'zombie_villager',
  'skeleton', 'stray', 'wither_skeleton', 'bogged',
  'spider', 'cave_spider', 'creeper', 'witch', 'slime',
  'phantom', 'magma_cube', 'blaze', 'ghast', 'breeze',
  'pillager', 'vindicator', 'evoker', 'ravager', 'illusioner', 'vex',
  'guardian', 'elder_guardian', 'silverfish', 'endermite', 'shulker',
  'piglin_brute', 'hoglin', 'zoglin', 'warden',
]);

/**
 * Neutral until provoked. These must only ever be fought in self-defence:
 *
 *  - enderman: aggros if you look at its head or hit it, teleports, hits hard
 *  - piglin / zombified_piglin: hitting one aggros every one in earshot
 *  - wolf, iron_golem, bee, llama: harmless unless attacked
 *
 * Attacking any of these unprovoked is strictly worse than ignoring them.
 */
const NEUTRAL_NAMES = new Set([
  'enderman', 'piglin', 'zombified_piglin',
  'wolf', 'iron_golem', 'bee', 'llama', 'trader_llama', 'panda', 'polar_bear',
  'goat', 'dolphin', 'rabbit_killer',
]);

const FOOD_ANIMAL_NAMES = new Set([
  'cow', 'mooshroom', 'pig', 'chicken', 'sheep', 'rabbit',
]);

// Mobs that punish standing next to them / need special handling.
const EXPLOSIVE_NAMES = new Set(['creeper']);
/**
 * Anything that can hurt us without closing the distance.
 *
 * This set is load-bearing: `worthReactingTo` uses it to decide what can't
 * simply be walked away from. Missing entries are invisible failures — the
 * bot stands there being shot and never responds, which is exactly what
 * happened with pillagers. Audited against minecraft-data for 1.21.
 *
 * Bosses (wither, ender_dragon, warden) shoot too but are excluded from
 * combat entirely, so they're deliberately not listed.
 */
const RANGED_NAMES = new Set([
  'skeleton', 'stray', 'bogged', 'wither_skeleton',
  'pillager', 'illusioner', 'witch',
  'ghast', 'blaze', 'breeze', 'shulker',
]);
// Ground melee mobs that genuinely cannot reach a bot standing 2 blocks up.
// Spiders climb, endermen teleport, phantoms fly — deliberately excluded.
const PILLARABLE_NAMES = new Set(['zombie', 'husk', 'drowned', 'zombie_villager', 'zombified_piglin']);

/**
 * Mobs a sprinting player can actually get away from.
 *
 * This matters because "flee" is only a real option against something
 * slower than you. A sprinting player does 5.6 blocks/s; a zombie does
 * ~4.6 and a creeper ~5.0, so those you lose. A spider does ~6.0 and
 * simply runs you down, and a skeleton doesn't need to catch you at all —
 * turning your back on one just gives it a free shooting gallery.
 *
 * Fleeing the un-outrunnable is how the bot died repeatedly: it would
 * disengage, get shot/bitten in the back the whole way, and arrive
 * "safe" with two hearts.
 */
const OUTRUNNABLE_NAMES = new Set([
  'zombie', 'husk', 'drowned', 'zombie_villager', 'zombified_piglin',
  'creeper', 'slime', 'magma_cube', 'silverfish', 'endermite',
  'iron_golem', 'shulker',
]);

/**
 * Fights an under-equipped bot simply cannot win.
 *
 * Instinct says "if you can't outrun it, fight it", which is right for a
 * spider and suicidal here. A wither does ~8 damage a hit through armour,
 * flies, shoots homing skulls and has 300 HP; a warden two-shots a player in
 * full diamond. Observed live: the bot charged a wither bare-fisted and died
 * inside two seconds, twice in a row, because the generic rule had no
 * concept of an unwinnable fight.
 *
 * Fleeing these may also fail — but it is the only option with a non-zero
 * success rate, so it's the right one.
 */
const { mobFacts, SPRINT_SPEED } = require('./knowledge');

const BOSS_NAMES = new Set([
  'wither', 'ender_dragon', 'warden', 'elder_guardian', 'ravager', 'evoker',
]);

function isBoss(entity) {
  return !!entity && !!entity.name && BOSS_NAMES.has(entity.name);
}

/**
 * Can we realistically disengage from this, or would fleeing just hurt?
 *
 * Backed by measured mob speeds in src/knowledge.js rather than only a
 * hand-kept name list. A sprinting player moves 0.28 blocks per tick; a
 * zombie 0.23, a spider 0.3. The list stays as the authority for mobs we
 * have deliberately decided about (and for anything the speed table has no
 * entry for), but where we do have a number, the number decides — that way
 * a mob nobody remembered to list still gets a correct answer.
 */
function canOutrun(entity) {
  if (!entity || !entity.name) return false;
  if (entity.type === 'player') return false; // players sprint exactly as fast
  if (OUTRUNNABLE_NAMES.has(entity.name)) return true;
  const facts = mobFacts(entity.name);
  // Being slower than us is necessary but not sufficient: a skeleton walks
  // at 0.25 against our 0.28 and still cannot be escaped, because turning
  // your back on an archer just converts a fight into a free shooting
  // gallery. Anything that attacks at range is never outrunnable.
  return !facts.unknown && !facts.ranged && facts.speed < SPRINT_SPEED;
}

function isHostileMob(entity) {
  if (!entity || !entity.name || !entity.isValid) return false;
  if (entity.type === 'player') return false;
  // A neutral mob is never "hostile" for targeting purposes, even though
  // minecraft-data reports some of them (enderman, piglins) as type
  // 'hostile'. Provoking them is a choice, and the answer is always no.
  if (NEUTRAL_NAMES.has(entity.name)) return false;
  if (HOSTILE_NAMES.has(entity.name)) return true;
  return entity.type === 'hostile' || entity.kind === 'Hostile mobs';
}

/** Neutral mob — only ever a threat if it's already attacking us. */
function isNeutralMob(entity) {
  return !!entity && entity.isValid && NEUTRAL_NAMES.has(entity.name);
}

function isFoodAnimal(entity) {
  if (!entity || !entity.name || !entity.isValid) return false;
  if (FOOD_ANIMAL_NAMES.has(entity.name)) return true;
  // Don't trust type alone here — 'animal' also covers things we shouldn't
  // be punching, like horses and wolves.
  return false;
}

function isOtherPlayer(bot, entity) {
  return !!entity
    && entity.isValid
    && entity.type === 'player'
    && entity.username
    && entity.username !== bot.username;
}

function isExplosive(entity) {
  return !!entity && EXPLOSIVE_NAMES.has(entity.name);
}

function isRangedAttacker(entity) {
  return !!entity && RANGED_NAMES.has(entity.name);
}

function isPillarable(entity) {
  return !!entity && PILLARABLE_NAMES.has(entity.name);
}

/** Aim point — mobs vary a lot in height, so aim at mid-body, not feet. */
function eyePos(entity) {
  return entity.position.offset(0, (entity.height || 1.8) * 0.5, 0);
}

/**
 * Nearest entity matching `predicate` within `maxDistance`.
 * bot.nearestEntity() itself has no distance bound, which is how the bot
 * ended up chasing animals across the map.
 */
function nearestWithin(bot, predicate, maxDistance) {
  let best = null;
  let bestDist = maxDistance;
  for (const id of Object.keys(bot.entities)) {
    const entity = bot.entities[id];
    if (entity === bot.entity) continue;
    if (!predicate(entity)) continue;
    const dist = bot.entity.position.distanceTo(entity.position);
    if (dist < bestDist) {
      bestDist = dist;
      best = entity;
    }
  }
  return best;
}

module.exports = {
  isHostileMob,
  isNeutralMob,
  isFoodAnimal,
  isOtherPlayer,
  isExplosive,
  isRangedAttacker,
  isPillarable,
  canOutrun,
  isBoss,
  eyePos,
  nearestWithin,
};
