const { Vec3 } = require('vec3');
const logger = require('../logger');
const config = require('../config');
const jevClient = require('../jevClient');
const { sleep, isInterruption } = require('../task');
const { goNear, retreatFrom } = require('../nav');
const {
  isHostileMob, isOtherPlayer, isExplosive, isRangedAttacker,
  canOutrun, isBoss, eyePos, isNeutralMob,
} = require('../entities');
const {
  findItem, hasItem, armorSummary, equipIfDifferent, pillarItem, pillarUp, bestWeapon,
  tryPlaceBlock,
} = require('../inventory');
const { lookAtSmoothly } = require('../combat');
const {
  engage, creeperIsFusing, fightCreeper, lowerShield,
  backAwayFacing, shieldInOffHand,
} = require('../tactics');
const { describeMob, ARMOR_POINTS } = require('../knowledge');
const difficulty = require('../difficulty');

/**
 * Past this a creeper is scenery, not a threat.
 *
 * It walks at 0.25 blocks per tick against a sprinting bot's 0.28, so it can
 * never catch us in the open — and the old behaviour of retreating from one
 * at any distance inside the 14-block detection range meant a single creeper
 * wandering past could stop the bot working for as long as it stayed around.
 */
const CREEPER_BOTHER_RANGE = 7;

/**
 * Three blocks is out of an enderman's reach and it cannot follow.
 *
 * They are 2.9 blocks tall and cannot jump, so a three-block pillar is
 * unreachable — and since they teleport away once they lose their target,
 * waiting up there IS the win. We are not trying to kill it.
 */
const ENDERMAN_PILLAR_HEIGHT = 3;
const ENDERMAN_WAIT_MS = 20000;

/**
 * Build straight up to get out of something's reach.
 *
 * Deliberately a modest height: the bot has to be able to get back down
 * afterwards, and a tall spire is its own kind of trap.
 *
 * The block list and the place-and-jump loop both live in inventory.js now.
 * This file had its own copy of each, and the block list had already drifted —
 * it was missing sandstone, so a bot in a desert holding a stack of it could
 * seal a shelter roof but could not pillar away from an enderman.
 */
async function pillarAwayFrom(bot, task) {
  if (!pillarItem(bot)) return false;
  return (await pillarUp(bot, task, ENDERMAN_PILLAR_HEIGHT)) >= 2;
}

const DETECT_RANGE = config.behavior.mobDetectionRange;
// Close enough that it's genuinely a problem right now, rather than just
// visible — used to decide whether to abandon work already in progress.
const INTERRUPT_RANGE = 7;
const RECENT_ATTACK_MS = 6000;
const FIGHT_TIMEOUT_MS = 45000;
const LOW_HEALTH_BAIL = 7;
/** Extra health to keep in hand for each melee mob beyond the first. */
const BAIL_PER_EXTRA_MOB = 2;
const BAIL_HEALTH_CAP = 12;

// How far the bot will chase from where a fight started. Without this it
// will follow a fleeing player or mob across the map indefinitely, which is
// both useless and exactly what "he just follows you endlessly" described.
const CHASE_LEASH = 18;

/**
 * How long to leave a target alone after failing to find any route to it.
 *
 * Escalating, because a fixed hold produced a perfect waste loop: the bot
 * engaged a skeleton it could not reach, stood there 25 seconds, `unstick`
 * decided it was trapped and pillared it three blocks up, `gatherStone`
 * immediately dug it back down, the hold expired, and it engaged the same
 * skeleton again. Up, down, up, down, achieving nothing, for minutes.
 *
 * Doubling the hold each time means a genuinely unreachable mob is quickly
 * forgotten for long enough to get real work done, while something that was
 * only briefly blocked still gets another chance soon.
 */
const UNREACHABLE_HOLD_MS = 30000;
const UNREACHABLE_HOLD_MAX_MS = 5 * 60 * 1000;

/**
 * How close something must be before it is worth reacting to at all.
 *
 * This is the difference between a bot that survives the night and one that
 * wastes it. At priority 90, `threat` monopolises the schedule — so a single
 * zombie ambling about 13 blocks away meant the bot spent the entire night
 * "fleeing" instead of gathering wood, and therefore never crafted the sword
 * that would have let it stop running. Observed live: 90 straight seconds of
 * `doing: threat`, weapon `none`, with nothing else ever getting a turn.
 *
 * Distant, slower-than-us mobs are scenery. Walking to a tree already moves
 * us away from them; that IS the escape, and it gets work done at the
 * same time.
 */
const BOTHER_RANGE = 8;

/**
 * The bot picks fights it was never offered.
 *
 * `threat` outranks all productive work, so every mob it decides to "deal
 * with" is time not spent gathering, crafting or descending. The old rule
 * reacted to anything it couldn't outrun at any distance up to 14 blocks —
 * and skeletons, spiders, witches and withers are all un-outrunnable, so at
 * night that meant reacting to essentially everything on screen, forever.
 *
 * Minecraft hostiles only aggro within ~16 blocks and most lose interest
 * quickly. Walking away and working is almost always better than engaging,
 * so the bar is now: it hurt us, or it is genuinely on top of us. Anything
 * else is scenery, whatever it is.
 */
const ENGAGE_RANGE = 6;
/**
 * How far away we will start a fight we can SEE.
 *
 * Bigger than ENGAGE_RANGE because sight changes the calculation: something
 * visible and approaching is a fight we are having anyway, and the side that
 * swings first wins the exchange. Kept well under the 14-block detection
 * range so the bot does not go touring after everything it can make out on
 * the horizon.
 */
const SIGHTED_ENGAGE_RANGE = 10;
const PURSUIT_MEMORY_MS = 4000;

/**
 * Inside this range an armed, healthy bot attacks immediately — no state
 * building, no model call, no logging of a decision that wasn't made.
 * Creepers are excluded: walking into one on reflex is how you die.
 */
const FAST_ATTACK_RANGE = 4.5;

// How close a player has to be to be suspected of hitting us when damage
// attribution fails. Melee reach is ~3, so this is "close enough to have
// done it" with a little slack for lag.
const PLAYER_SUSPECT_RANGE = 5;

function hasWeapon(bot) {
  return !!bestWeapon(bot);
}

function worthReactingTo(bot, ctx, entity, distance) {
  // Never pick a fight with a boss. Not at any range, not for any reason,
  // not even if it is hitting us — a wither will kill this bot every single
  // time, so the only correct response is to leave. It was attacking one
  // bare-fisted that had not even engaged it.
  if (isBoss(entity)) return false;

  // Did this specific thing just hurt us? Then it's our problem.
  const hurtUs = ctx.threat.lastAttackerId === entity.id
    && Date.now() - ctx.threat.lastAttackAt < PURSUIT_MEMORY_MS;
  if (hurtUs) return true;

  // Are we being hurt by *something* and this is the nearest candidate?
  //
  // "Hurt" means HIT — lastAttackedAt only moves for melee, arrows, blasts
  // and unexplained hits (see src/damage.js). It used to be any health drop,
  // so a fall or a starvation tick made every hostile within eight blocks
  // worth a fight, walls or no walls.
  if (Date.now() - ctx.threat.lastAttackedAt < 2000 && distance <= BOTHER_RANGE) return true;

  // Anything that SHOOTS, with a clear line to us, has to be dealt with at
  // any range it can hit from — you cannot walk away from an archer.
  //
  // This was the pillager bug. Damage attribution only correlates melee
  // swings (bloodhound caps at 6 blocks), so arrows and crossbow bolts are
  // never traced back to their owner. A pillager at 12 blocks therefore
  // failed every test above: not identified as the attacker, too far for
  // the proximity fallback, too far to be "on top of us". The bot stood
  // there being shot and never once responded. Skeletons, strays, bogged
  // and witches all had the same hole.
  //
  // Line of sight keeps this honest: one behind a wall genuinely can't hit
  // us, so it stays scenery and doesn't drag the bot into pointless fights.
  if (isRangedAttacker(entity) && distance <= DETECT_RANGE) {
    const myEye = bot.entity.position.offset(0, 1.6, 0);
    if (hasLineOfSight(bot, myEye, eyePos(entity))) return true;
  }

  // STRIKE FIRST when we can see it and we are equipped to win.
  //
  // Waiting for something to reach ENGAGE_RANGE hands it the opening hit
  // every time — the bot only ever started fights that had already started.
  // A zombie in plain sight at nine blocks is a fight we are going to have
  // regardless; taking it on our terms means arriving with the swing ready
  // instead of eating one first.
  //
  // Deliberately conditional on being able to WIN it: armed, healthy, and
  // able to see the thing. An unarmed or hurt bot has nothing to gain from
  // picking a fight early and should keep walking away.
  //
  // Line of sight is what stops this turning into chasing noises. Something
  // audible through a wall or round a corner stays scenery, which is the
  // difference between hunting and standing in a field turning in circles.
  //
  // NOT against shooters, though. I added this for melee mobs and let it
  // cover archers too, and it made things measurably worse: the bot began
  // charging skeletons from ten blocks across open ground with no shield,
  // eating an arrow every second of the approach. Three deaths in one
  // session, all `killedBy: ranged`, with the ledger reading `ranged 47`.
  //
  // Starting a fight early only pays when the approach is free. Against
  // something that hurts us the entire way in, the opening move is not ours
  // to take — that case is handled further up, and only when it is already
  // shooting at us.
  if (distance <= SIGHTED_ENGAGE_RANGE
    && hasWeapon(bot)
    && bot.health > bailHealth(bot, ctx)
    && !isExplosive(entity)
    && !isRangedAttacker(entity)) {
    const myEye = bot.entity.position.offset(0, 1.6, 0);
    if (hasLineOfSight(bot, myEye, eyePos(entity))) return true;
  }

  // Otherwise: only things genuinely on top of us. Everything else —
  // including the zombie across the clearing — is scenery, and walking
  // away from it while doing useful work is the better play.
  //
  // "ON TOP OF US" HAS TO MEAN REACHABLE, not merely close in a straight
  // line, and this branch was the one place in the whole function that
  // didn't check. In a cave, "close" and "reachable" are different questions
  // — a creeper 5.6 blocks away through solid rock is not on top of us at
  // all, it is on the other side of a wall, and its distance never changes
  // because it never gets any closer. Confirmed by eye: spectating the bot
  // showed exactly one zombie actually adjacent to it while the dashboard
  // reported ten to thirteen "near" hostiles and the bot cycled "flee"
  // against a phantom threat at a fixed 5.6 blocks for over five minutes,
  // making no progress at all.
  //
  // Every other branch above already checks line of sight before trusting
  // distance alone; this catch-all is the one that was missed.
  if (distance > ENGAGE_RANGE) return false;
  const myEye = bot.entity.position.offset(0, 1.6, 0);
  return hasLineOfSight(bot, myEye, eyePos(entity));
}

/**
 * Only what we could actually see, not merely stand within range of through
 * rock. Feeds Jev's `nearby_hostiles` field, and an inflated count there tells
 * the model it is surrounded when it is standing next to a cave wall with a
 * cavern full of mobs on the other side of it — a fact that argues for a very
 * different decision than "surrounded" does.
 */
function countHostilesNear(bot, range) {
  let n = 0;
  const myEye = bot.entity.position.offset(0, 1.6, 0);
  for (const id of Object.keys(bot.entities)) {
    const e = bot.entities[id];
    if (e !== bot.entity && isHostileMob(e)
      && bot.entity.position.distanceTo(e.position) <= range
      && hasLineOfSight(bot, myEye, e.position.offset(0, 1, 0))) n++;
  }
  return n;
}

/**
 * When to leave a fight, given how many things are in it.
 *
 * A flat 7 is right for one zombie: two more of its hits and we are gone, so
 * leave now. Against three it is two seconds too late. In the 09-25 02:09
 * session the bot broke off at 1 and 3 health — "Too hurt to fight —
 * retreating" — and died on the first step of the retreat, every time with
 * more than one mob on it. Each extra melee mob in reach adds its hits to the
 * ones the retreat has to survive, so each one raises the bar. Archers and
 * creepers are excluded: running does not reduce what they do, which is why
 * those fights are handled separately and never bail on this.
 */
// Jev says "danger": leave a fight one extra mob's worth sooner.
const DANGER_BAIL_BONUS = BAIL_PER_EXTRA_MOB;

function bailHealth(bot, ctx = null) {
  let melee = 0;
  const myEye = bot.entity.position.offset(0, 1.6, 0);
  for (const id of Object.keys(bot.entities ?? {})) {
    const e = bot.entities[id];
    if (e === bot.entity || !isHostileMob(e) || isRangedAttacker(e) || isExplosive(e)) continue;
    if (bot.entity.position.distanceTo(e.position) > INTERRUPT_RANGE) continue;
    if (!hasLineOfSight(bot, myEye, e.position.offset(0, 1, 0))) continue;
    melee++;
  }
  const danger = require('../director').currentRisk(ctx) === 'danger' ? DANGER_BAIL_BONUS : 0;
  return Math.min(BAIL_HEALTH_CAP, LOW_HEALTH_BAIL + BAIL_PER_EXTRA_MOB * Math.max(0, melee - 1) + danger);
}

/**
 * How dangerous is this thing, right now, to us?
 *
 * Retargeting used to be a short list of special cases ("is there a creeper
 * within 6", "did something else hit us"), which produced exactly the
 * complaint it earned: the bot both clung to bad targets and flip-flopped
 * between equally-bad ones. Scoring every candidate on the same scale makes
 * the comparison meaningful, and the hysteresis in pickBetterTarget stops
 * the switching from becoming a twitch.
 */
function threatScore(bot, ctx, entity, distance) {
  let score = 0;

  if (isExplosive(entity)) {
    // A creeper that has lit its fuse is not a target, it's a countdown.
    score += creeperIsFusing(entity) ? 220 : 95;
  }
  // Archers can hurt us wherever we stand, so distance discounts them less.
  if (isRangedAttacker(entity)) score += 50;

  // Whatever is actually landing hits on us matters more than whatever we
  // happened to notice first. bloodhound gives us the real attacker.
  if (ctx.threat.lastAttackerId === entity.id
    && Date.now() - ctx.threat.lastAttackAt < RECENT_ATTACK_MS) {
    score += 75;
  }

  // Players fight back properly and are the only thing here that can chase.
  if (entity.type === 'player') score += 35;

  // Proximity: closest gets the swings, but never outweighs a live creeper.
  score += Math.max(0, 45 - distance * 4.5);

  return score;
}

/**
 * Ranking every entity in range is not free, and it is asked for constantly.
 *
 * `candidates` walks the whole entity list, computes a distance for each and
 * — for archers and anything in sight range — runs a raycast per candidate.
 * It is called from `threat.shouldRun`, `threat.canInterrupt`, the same two on
 * `defend`, and from `pickBetterTarget` on every combat tick. The director's
 * supervisor fires sixteen times a second and combat polls twenty, so on a bad
 * night that is the same scan running sixty-plus times a second, synchronously,
 * on the thread that also runs pathfinding and physics.
 *
 * A tenth of a second is two game ticks. Nothing in a fight turns on the
 * difference, and the lag it buys back is the difference between reacting and
 * not.
 */
const TARGET_CACHE_MS = 100;

function candidates(bot, ctx) {
  const now = Date.now();
  const cached = bot._threatScan;
  if (cached && now - cached.at < TARGET_CACHE_MS) return cached.list;

  const list = scanCandidates(bot, ctx, now);
  bot._threatScan = { at: now, list };
  return list;
}

/**
 * Would the bot fight this at all? Shared by the target scan and by the Jev
 * prefetcher, which used to warm answers for every player in range whether or
 * not the scan would ever pick them.
 */
function isTarget(bot, ctx, e, distance, now = Date.now()) {
  // Players are only ever fought in self-defence — but "who hit me" is a
  // best-effort guess. mineflayer-bloodhound says so itself: it correlates
  // damage with nearby swings and is "at the mercy of latency". Requiring
  // a positive identification meant that whenever correlation failed, the
  // bot simply would not fight back, which is exactly what it looked like
  // from the other end.
  //
  // So: identified attacker, OR we are visibly being hurt and a player is
  // standing right there. If something is damaging us and you're the only
  // player within a few blocks, that is enough to defend against.
  const identified = ctx.threat.lastAttackerId === e.id
    && now - ctx.threat.lastAttackAt < RECENT_ATTACK_MS;
  // Being HIT, not merely hurt: with every health drop counted, a player
  // standing near the bot when it fell or starved became "the attacker".
  const suspect = now - ctx.threat.lastAttackedAt < RECENT_ATTACK_MS
    && distance <= PLAYER_SUSPECT_RANGE;

  // A NEUTRAL mob that has actually hit us is a real problem.
  //
  // Endermen, wolves and piglins are deliberately never picked as targets
  // — walking up and punching an idle enderman is a reliable way to die,
  // which is why they are excluded. But once one is attacking, ignoring it
  // is worse: the bot had no response at all to an aggravated enderman and
  // simply took the damage. Provoked is a different state from present,
  // and only the provoked ones get in here.
  const neutralAggro = isNeutralMob(e) && (identified || suspect);

  return isHostileMob(e)
    || neutralAggro
    || (isOtherPlayer(bot, e) && (identified || suspect));
}

function scanCandidates(bot, ctx, now) {
  const out = [];
  for (const id of Object.keys(bot.entities)) {
    const e = bot.entities[id];
    if (e === bot.entity || !e.isValid) continue;

    // Bosses are never targets. Leaving them out here means they can't be
    // selected, retargeted onto, or scored against anything else.
    if (isBoss(e)) continue;

    // Skip anything we've already proven we can't get to.
    const blockedUntil = ctx.threat.unreachable.get(e.id);
    if (blockedUntil && blockedUntil >= now) continue;

    const distance = bot.entity.position.distanceTo(e.position);
    if (distance > DETECT_RANGE) continue;

    if (!isTarget(bot, ctx, e, distance, now)) continue;

    // Filter here, not after picking a winner.
    //
    // Scoring and actionability are different questions, and testing them in
    // the wrong order produced a nasty blind spot: a creeper 12 blocks away
    // outscores a zombie chewing on us at 3, so the creeper was selected as
    // "the target", judged not worth reacting to at that range, and the bot
    // then ignored the zombie entirely. Only actionable things get ranked.
    if (!worthReactingTo(bot, ctx, e, distance)) continue;

    out.push({ entity: e, distance, score: threatScore(bot, ctx, e, distance) });
  }
  return out.sort((a, b) => b.score - a.score);
}

/** Pick who we're dealing with: the highest-scoring thing in range. */
function selectTarget(bot, ctx) {
  const best = candidates(bot, ctx)[0];
  if (!best) return null;
  return {
    entity: best.entity,
    distance: best.distance,
    score: best.score,
    label: isOtherPlayer(bot, best.entity) ? 'hostile_player' : best.entity.name,
  };
}

/**
 * Everything Jev needs to make a sensible fight/flee call. The old version
 * sent only health + held item, so it never knew the bot was starving, had
 * no armour, or was surrounded — and unsurprisingly kept saying "flee".
 */
function buildThreatState(bot, ctx, entity, distance) {
  // The weapon we would actually SWING, which is not always a sword: an iron
  // axe beats a wooden sword by five damage a hit, and the bot spawns holding
  // the axe it was chopping with as often as not.
  const weapon = bestWeapon(bot);
  const armor = armorSummary(bot);
  const failedEscapes = ctx.threat.fleeAttempts.get(entity.id)?.count ?? 0;

  // "Is it chasing me" is the single most decision-relevant fact in a
  // fight-or-flight call, and we weren't telling Jev about it at all — the
  // old `has_escape_route` was just "am I not in water", which is useless.
  return {
    mob_type: entity.name === 'player' ? 'hostile_player' : entity.name,
    distance_blocks: Number(distance.toFixed(1)),
    bot_health: Math.round(bot.health),
    bot_max_health: 20,
    bot_hunger: bot.food ?? 20,
    weapon: weapon ? weapon.name : 'none',
    armor_pieces: armor.length,
    armor,
    nearby_hostiles: countHostilesNear(bot, DETECT_RANGE),
    threat_is_pursuing: distance <= DETECT_RANGE,
    failed_escape_attempts: failedEscapes,
    recently_took_damage: Date.now() - ctx.threat.lastAttackedAt < 3000,
    // Whether running away is even physically possible. Without this Jev
    // was being asked to choose "flee" for things the bot cannot outrun,
    // and quite reasonably kept saying yes.
    can_outrun_it: canOutrun(entity),
    // WHERE the fight is, which changes the answer completely. In water the
    // bot cannot sprint, cannot crit, deals almost no knockback and is slower
    // than everything that lives there — so fleeing is off the table and the
    // correct move is to close and stay closed, or get to land first.
    in_water: !!bot.entity?.isInWater,
    target_in_water: !!entity.isInWater,
    attacks_at_range: isRangedAttacker(entity),
    // Bosses and minibosses. Jev has no way to know from the name alone
    // that a "wither" is categorically different from a "zombie".
    is_boss: isBoss(entity),

    // Hardcoded game facts about THIS mob, so the model does not have to
    // recall them from a name alone.
    //
    // A name is very little to decide on. "vindicator" and "zombie" look
    // equally ordinary written down, and one of them hits for 13 against the
    // other's 3 — a difference that decides the fight. Handing over the
    // damage, reach, speed and health turns a question about vocabulary into
    // a question about arithmetic, which is the kind a fast typed model
    // answers well. See src/knowledge.js.
    ...describeMob(entity.name),

    // ...and then correct the one number in there that is a world setting
    // rather than a game fact. describeMob's `damage_to_us` is the Normal
    // figure; this world may be on Easy or Hard, where the same zombie costs
    // 2.5 or 4.5. Armour is applied too, so this is what the hit would
    // ACTUALLY take off us right now rather than what it would take off a
    // naked bot on a default server.
    world_difficulty: difficulty.current(ctx),
    damage_to_us: Number(difficulty.hitCost(bot, ctx, entity.name).toFixed(1)),
    // The form of that number a decision is actually made on. "Fourteen
    // health against four damage" is arithmetic the model should not have to
    // do under a 300ms deadline.
    //
    // Null for anything explosive, and that is not a detail. A creeper's 22
    // is its point-blank maximum, not a hit it lands repeatedly — dividing
    // health by it says "you cannot survive one" about every creeper at every
    // health, which would turn the whole engagement into a permanent retreat
    // and throw away the hit-and-step-back tactic that actually kills them.
    // Same reason the difficulty inference refuses creeper samples: blast
    // damage is a function of distance, so it is not a per-hit figure at all.
    hits_we_can_take: isExplosive(entity)
      ? null
      : difficulty.hitsSurvivable(bot, ctx, entity.name),

    // Ours, for the same reason: "can I win this trade" needs both sides.
    our_reach: 3.0,
    our_damage: weaponDamage(weapon),
    // 4% damage reduction per armour point.
    our_damage_reduction: `${Math.min(80, armorPoints(bot) * 4)}%`,
    have_shield: hasItem(bot, 'shield'),
  };
}

/** Rough melee damage of what we are holding, for the threat briefing. */
const WEAPON_DAMAGE = {
  netherite_sword: 8,
  diamond_sword: 7,
  iron_sword: 6,
  stone_sword: 5,
  wooden_sword: 4,
  golden_sword: 4,
  netherite_axe: 10,
  diamond_axe: 9,
  iron_axe: 9,
  stone_axe: 9,
  wooden_axe: 7,
  golden_axe: 7,
};

function weaponDamage(weapon) {
  if (!weapon) return 1; // bare fists
  return WEAPON_DAMAGE[weapon.name] ?? 2;
}

/** Total armour points currently worn — 20 is a full diamond set. */
function armorPoints(bot) {
  let total = 0;
  for (const slot of ['head', 'torso', 'legs', 'feet']) {
    const worn = bot.inventory.slots[bot.getEquipmentDestSlot(slot)]?.name;
    if (!worn) continue;
    const [tier, piece] = [worn.split('_')[0], worn.split('_').slice(1).join('_')];
    total += ARMOR_POINTS[tier]?.[piece] ?? 0;
  }
  return total;
}

// --- tactics ----------------------------------------------------------

/**
 * Should a different target take over mid-fight?
 *
 * Two failure modes to avoid, and the old rule-list managed both at once:
 * clinging to a target while a creeper walked up behind, and thrashing
 * between two mobs so fast it never landed a hit on either. So: compare on
 * one scale, and require a clear margin plus a cooldown before switching.
 */
const SWITCH_MARGIN = 30;
const SWITCH_COOLDOWN_MS = 700;

function pickBetterTarget(bot, ctx, current) {
  const now = Date.now();
  if (now - (ctx.threat.lastSwitchAt || 0) < SWITCH_COOLDOWN_MS) return null;

  const ranked = candidates(bot, ctx);
  const best = ranked[0];
  if (!best || best.entity.id === current.id) return null;

  const currentEntry = ranked.find((c) => c.entity.id === current.id);
  const currentScore = currentEntry ? currentEntry.score : -Infinity;
  if (best.score <= currentScore + SWITCH_MARGIN) return null;

  ctx.threat.lastSwitchAt = now;
  return {
    entity: best.entity,
    reason: describeSwitch(best, currentScore),
  };
}

function describeSwitch(best, currentScore) {
  if (isExplosive(best.entity)) {
    return creeperIsFusing(best.entity) ? 'creeper about to blow' : 'creeper closing in';
  }
  if (isRangedAttacker(best.entity)) return 'archer shooting us';
  if (currentScore === -Infinity) return 'previous target gone';
  return `higher threat (${Math.round(best.score)} vs ${Math.round(currentScore)})`;
}

/**
 * Run a fight, handling retargeting and the chase leash around the actual
 * per-mob tactics in tactics.js.
 */
async function fightTarget(bot, ctx, firstTarget, task, since) {
  const origin = bot.entity.position.clone();
  const startedAt = Date.now();
  let current = firstTarget;

  for (let switches = 0; switches < 6; switches++) {
    let retargetTo = null;

    const shouldContinue = () => {
      if (!current.isValid) return 'target dead';

      // Bail on low health ONLY if running is actually an option.
      //
      // These two checks used to contradict each other and deadlock: the
      // flee-escalation decides "we can't escape this, turn and fight",
      // then this line immediately aborted that fight for being at the very
      // health that prompted it. The bot looped commit -> break off ->
      // commit, dozens of times a second, swinging at nothing while a
      // zombie ate it. If we can't outrun the thing, dying while fighting
      // back is strictly better than dying while jogging away from it.
      const escapable = canOutrun(current) && !isRangedAttacker(current);
      if (escapable && bot.health <= bailHealth(bot, ctx)) return 'health too low';
      if (Date.now() - startedAt > FIGHT_TIMEOUT_MS) return 'fight timeout';
      if (bot.entity.position.distanceTo(origin) > CHASE_LEASH) return 'chase leash reached';
      if (bot.entity.position.distanceTo(current.position) > DETECT_RANGE + 8) return 'target fled';

      const better = pickBetterTarget(bot, ctx, current);
      if (better) {
        // A creeper walking into the fight means the fight is over — break
        // off entirely rather than retargeting onto it, so run() can handle
        // it the only way that works (walking away).
        if (isExplosive(better.entity)) return 'creeper arrived — disengaging';
        retargetTo = better;
        return `switching: ${better.reason}`;
      }
      return null;
    };

    const outcome = await engage(bot, current, task, {
      shouldContinue,
      since: switches === 0 ? since : undefined,
    });

    if (outcome?.unreachable) {
      const strikes = (ctx.threat.unreachableStrikes.get(current.id) ?? 0) + 1;
      ctx.threat.unreachableStrikes.set(current.id, strikes);
      const hold = Math.min(UNREACHABLE_HOLD_MS * 2 ** (strikes - 1), UNREACHABLE_HOLD_MAX_MS);

      logger.info('No route to target — leaving it alone', {
        target: current.name,
        strikes,
        forMs: hold,
      });
      ctx.threat.unreachable.set(current.id, Date.now() + hold);
      // An archer we cannot reach keeps shooting whether we fight it or not.
      if (isRangedAttacker(current) && current.isValid) await takeCoverFrom(bot, current, task);
      // NOTHING WAS ACHIEVED, and the caller has to be told.
      //
      // `threat.run` reported success whatever happened here, so a fight
      // against something it could not reach was scored as productive work:
      // the commitment bonus was granted, the no-op backoff never engaged, and
      // `threat` — which outranks every gathering behavior — was immediately
      // re-picked for the next unreachable mob in the room.
      //
      // Watched live at y=13 in a cave with seven hostiles: `doing: threat` for
      // two solid minutes, position frozen to the decimal at (-13,13,104),
      // pickups frozen at 358, health never dropping below 20/20 because not
      // one of them could actually get to the bot either. It had just reached
      // iron depth with an iron pickaxe and it stood there.
      return { resolved: false };
    }

    if (!retargetTo) return { resolved: true };
    logger.action('Retargeting mid-fight', {
      from: current.name,
      to: retargetTo.entity.name,
      reason: retargetTo.reason,
    });
    current = retargetTo.entity;
  }
  // Six retargets without resolving anything is a room full of mobs, not a
  // fight — the same "nothing achieved" answer as an unreachable target.
  return { resolved: false };
}

/**
 * A raycast walks every block along the line, so at detection range it is
 * twenty-odd block reads — and `worthReactingTo` asks it once per ranged
 * attacker, on a check the supervisor runs sixteen times a second. With three
 * skeletons about that is a thousand block reads a second to answer a
 * question about mobs that move a fifth of a block between asks.
 *
 * A quarter second of staleness is nothing next to that. Keyed on the pair of
 * positions rounded to a block, so the cache invalidates itself as soon as
 * either party actually moves somewhere new.
 */
const SIGHT_CACHE_MS = 250;

function hasLineOfSight(bot, fromPos, toPos) {
  const key = `${Math.round(fromPos.x)},${Math.round(fromPos.y)},${Math.round(fromPos.z)}`
    + `>${Math.round(toPos.x)},${Math.round(toPos.y)},${Math.round(toPos.z)}`;
  const now = Date.now();

  bot._sightCache = bot._sightCache ?? new Map();
  const hit = bot._sightCache.get(key);
  if (hit && now - hit.at < SIGHT_CACHE_MS) return hit.value;

  let value = true;
  try {
    const delta = toPos.minus(fromPos);
    const distance = delta.norm();
    value = distance < 0.5
      || !bot.world.raycast(fromPos, delta.scaled(1 / distance), distance - 0.3);
  } catch {
    value = true;
  }

  // Bounded: the keys are block pairs, so a moving fight would otherwise grow
  // this without limit over a session.
  if (bot._sightCache.size > 256) bot._sightCache.clear();
  bot._sightCache.set(key, { at: now, value });
  return value;
}

/**
 * Get out of an archer's sight when it cannot be reached.
 *
 * 09-25 17:34, a cave at y=45, full health: "No route to target — leaving it
 * alone", and then the bot stood exactly where it was, eating, while the
 * skeleton it had given up on put 14 health of arrows into it. Dead in ten
 * seconds with 161 cobblestone in the bag. Leaving it alone is right; staying
 * in its line of fire is not.
 *
 * Cover within a few steps if there is any; otherwise build it — two blocks,
 * feet and head, in the cardinal direction the arrows are coming from.
 */
async function takeCoverFrom(bot, archer, task) {
  const cover = findCover(bot, eyePos(archer));
  if (cover) {
    try {
      await goNear(bot, cover, 1, task);
      logger.action('Took cover from an archer', { from: archer.name, how: 'moved' });
      return true;
    } catch (err) {
      if (isInterruption(err)) throw err;
    }
  }
  return wallOff(bot, archer, task);
}

/**
 * Charging a skeleton is only a plan with something to charge it with.
 *
 * 09-25 18:03, two deaths thirteen seconds apart at the spawn point: first at
 * 13 health with a stone sword and no armour, then — respawned seven blocks
 * away — boxing the same skeleton bare-handed for thirteen seconds while Jev
 * answered "flee" nine times running. Flee is overridden against archers
 * ("cannot outrun it"), which is right; fighting instead is not the only
 * other option. A skeleton needs line of sight, and a wall takes it away.
 */
const HIDE_FROM_ARCHER_HEALTH = 14;
const HIDDEN_WAIT_MS = 1000;

function shouldHideFromArcher(bot) {
  if (!hasWeapon(bot)) return true;
  return bot.health <= HIDE_FROM_ARCHER_HEALTH && !hasItem(bot, 'shield');
}

async function hideFromArcher(bot, archer, task) {
  const myEye = bot.entity.position.offset(0, 1.6, 0);
  if (!hasLineOfSight(bot, myEye, eyePos(archer))) {
    // Already out of its sight: hold still here rather than walking back into
    // it. A second, not longer — the director re-decides every round.
    await sleep(HIDDEN_WAIT_MS, task);
    return true;
  }
  return takeCoverFrom(bot, archer, task);
}

async function wallOff(bot, archer, task) {
  const block = pillarItem(bot);
  if (!block) return false;
  const here = bot.entity.position;
  const dx = archer.position.x - here.x;
  const dz = archer.position.z - here.z;
  const step = Math.abs(dx) >= Math.abs(dz)
    ? { x: Math.sign(dx) || 1, z: 0 }
    : { x: 0, z: Math.sign(dz) || 1 };
  const feet = here.floored().offset(step.x, 0, step.z);
  let placed = 0;
  for (const cell of [feet, feet.offset(0, 1, 0)]) {
    task.throwIfAborted();
    const at = bot.blockAt(cell);
    if (at?.boundingBox === 'block') continue;
    const below = bot.blockAt(cell.offset(0, -1, 0));
    if (below?.boundingBox !== 'block') break;
    await equipIfDifferent(bot, block);
    if (await tryPlaceBlock(bot, below, new Vec3(0, 1, 0))) placed++;
  }
  if (placed) logger.action('Took cover from an archer', { from: archer.name, how: 'wall', blocks: placed });
  return placed > 0;
}

function findCover(bot, targetEye) {
  const base = bot.entity.position.floored();
  let best = null;
  let bestDist = Infinity;
  for (let dx = -5; dx <= 5; dx++) {
    for (let dz = -5; dz <= 5; dz++) {
      if (dx === 0 && dz === 0) continue;
      const feet = base.offset(dx, 0, dz);
      const ground = bot.blockAt(feet.offset(0, -1, 0));
      const at = bot.blockAt(feet);
      const head = bot.blockAt(feet.offset(0, 1, 0));
      if (ground?.boundingBox !== 'block' || at?.boundingBox !== 'empty' || head?.boundingBox !== 'empty') continue;
      if (hasLineOfSight(bot, feet.offset(0.5, 1.6, 0.5), targetEye)) continue;
      const d = feet.distanceTo(bot.entity.position);
      if (d < bestDist) {
        bestDist = d;
        best = feet;
      }
    }
  }
  return best;
}

/**
 * Skeletons and friends. With a bow we take cover and peek out to shoot.
 * WITHOUT a bow, kiting is exactly wrong — backing off just donates free
 * arrows — so we close the distance fast and brawl instead.
 */
async function rangedFight(bot, entity, task, shouldContinue) {
  const bow = findItem(bot, (i) => i.name === 'bow');
  if (!bow || !hasItem(bot, 'arrow')) return false; // caller falls back to melee

  await equipIfDifferent(bot, bow);
  let lastShot = 0;
  let cover = null;

  while (!task.aborted) {
    const stop = shouldContinue();
    if (stop) {
      logger.info('Breaking off ranged fight', { reason: stop, target: entity.name });
      return true;
    }
    if (!hasItem(bot, 'arrow')) return false; // out of ammo, melee instead

    if (bot.recoilUntil && Date.now() < bot.recoilUntil) {
      bot.clearControlStates();
      await sleep(120, task);
      continue;
    }

    const targetEye = eyePos(entity);
    const myEye = bot.entity.position.offset(0, 1.6, 0);
    const exposed = hasLineOfSight(bot, myEye, targetEye);

    if (exposed) {
      if (!cover || bot.entity.position.distanceTo(cover) < 1) cover = findCover(bot, targetEye);
      if (cover) {
        try {
          await goNear(bot, cover, 1, task);
        } catch (err) {
          if (isInterruption(err)) throw err;
        }
      }
    }

    if (Date.now() - lastShot > 1400) {
      if (!exposed && cover) {
        // Behind cover we also can't shoot — step out just far enough.
        const dir = entity.position.minus(bot.entity.position).normalize();
        const peek = bot.entity.position.plus(dir.scaled(1.6));
        await goNear(bot, peek, 1, task).catch((e) => {
          if (isInterruption(e)) throw e;
        });
      }
      await lookAtSmoothly(bot, targetEye);
      bot.activateItem();
      await sleep(900, task); // full draw
      bot.deactivateItem();
      lastShot = Date.now();
    }
    await sleep(150, task);
  }
  return true;
}

/**
 * How long to spend reversing, shield first, before turning and running.
 *
 * The first moment of a disengagement is the dangerous one — it is the only
 * time the thing chasing us gets free hits with no reply. A second of backing
 * off behind a shield covers exactly that window; past it, distance is worth
 * more than cover and sprinting is how distance is made.
 */
const SHIELDED_BREAK_MS = 900;

async function flee(bot, entity, task) {
  // A shield pointed at the sky is not a shield.
  //
  // This raised the shield and then called retreatFrom, which walks AWAY —
  // facing away. A shield blocks only what is in front of you, so the bot spent
  // every retreat it has ever made holding a plank up at nothing while taking
  // the hits in the back, and the comment here confidently said arrows were
  // "stopped outright". Same bug as the creeper one that was reported: "it held
  // the shield up and then turned around and got the full explosion".
  //
  // So: cover the break cleanly by reversing while facing it, and only then
  // turn and run. With no shield there is nothing to face it with, and running
  // immediately is strictly better.
  const covered = shieldInOffHand(bot);
  logger.action('Fleeing', { from: entity.name, shielded: covered });
  try {
    if (covered) {
      await backAwayFacing(bot, entity, task, SHIELDED_BREAK_MS);
      lowerShield(bot); // blocking halves our speed; the run needs all of it
    }
    const moved = await retreatFrom(
      bot,
      entity.position,
      [config.behavior.fleeDistance, 8, 5, 3],
      task,
    );
    if (!moved) logger.warn('Could not get away at all', { from: entity.name });
    return moved;
  } finally {
    lowerShield(bot);
  }
}

// --- behavior ---------------------------------------------------------

/** How long an "ignore" verdict keeps us out of the way of other work. */
const IGNORE_HOLD_MS = 8000;

// Running away only works if the thing chasing you is slower than you. A
// pursuing player is not. After this many failed escapes from the same
// attacker we stop trying to disengage and defend ourselves instead —
// the bot previously fled four times in a row and died doing it.
const FLEE_ESCALATION_LIMIT = 2;
const FLEE_TRACK_RESET_MS = 15000;

/**
 * How long a fight/flee answer stays usable: one background refresh plus the
 * time the refresh takes to come back. It was 1.2 s against a 2 s refresh, so
 * for most of every cycle the prefetched answer had already expired — part of
 * why only 1.8% of warmed answers were ever used.
 */
const THREAT_ANSWER_TTL_MS = config.typesafe.threatRefreshMs + config.typesafe.answerLatencyAllowanceMs;

function answerTtl(decision) {
  return decision === 'ignore' ? IGNORE_HOLD_MS : THREAT_ANSWER_TTL_MS;
}

function cachedDecision(ctx, entityId) {
  const last = ctx.threat.decisions.get(entityId);
  if (!last) return null;
  return Date.now() - last.at < answerTtl(last.decision) ? last.decision : null;
}

/** For the prefetcher: ask again once the answer has less than a round trip left. */
function needsFreshAnswer(ctx, entityId, now = Date.now()) {
  const last = ctx.threat.decisions.get(entityId);
  if (!last) return true;
  return now - last.at >= answerTtl(last.decision) - config.typesafe.answerLatencyAllowanceMs;
}

/**
 * For the prefetcher: only warm answers someone will read. Creepers and
 * endermen are handled before any Jev lookup (see run() below), so their
 * answers were never read — creepers alone were 26% of all threat calls.
 */
function worthAskingJev(bot, ctx, e, distance) {
  if (isBoss(e) || isExplosive(e) || e.name === 'enderman') return false;
  return isTarget(bot, ctx, e, distance);
}

function noteFleeAttempt(ctx, entityId) {
  const now = Date.now();
  const entry = ctx.threat.fleeAttempts.get(entityId);
  if (!entry || now - entry.lastAt > FLEE_TRACK_RESET_MS) {
    ctx.threat.fleeAttempts.set(entityId, { count: 1, lastAt: now });
    return 1;
  }
  entry.count += 1;
  entry.lastAt = now;
  return entry.count;
}

/**
 * A fast, hardcoded verdict for when there's no time to ask.
 *
 * Being decisive on instinct beats standing still deliberating while
 * something hits you — which is literally what was happening: the bot would
 * pause to consider a zombie that was already in swinging range and take
 * several free hits during its own deliberation.
 */
function instinctiveDecision(state) {
  // Some fights are unwinnable regardless of what the generic rules say.
  // Fleeing a wither may not work either, but it's the only option with a
  // non-zero success rate — charging one bare-fisted is a certainty.
  if (state.is_boss && state.armor_pieces < 4) return 'flee';

  // Running away from something faster than you, or something that shoots,
  // is strictly worse than fighting it: you take the same damage and deal
  // none back. Only flee what can actually be escaped.
  //
  // IN WATER, nothing is escapable. A swimming player manages about 0.11
  // blocks a tick and everything that lives in water beats that — a drowned
  // does 0.15 — so "flee" in water means being chased down while facing the
  // wrong way, which is how the bot died twice without landing a hit. On land
  // it can outrun a zombie; in water it cannot outrun anything.
  const escapable = state.can_outrun_it
    && !state.attacks_at_range
    && !state.in_water;

  // Unarmed is a mugging, not a fight — bare fists do 1 damage against a
  // zombie's 20 HP. Get away if we can. If we can't, swinging is still
  // better than being chewed on while we jog.
  if (state.weapon === 'none') return escapable ? 'flee' : 'fight';

  // Health alone is the wrong unit, and it is the unit this used for a long
  // time. "Eight health" means four more zombie hits on Easy and under two
  // from a vindicator on Hard, and the correct decision is opposite in those
  // two cases. Counting in HITS is the same judgement a player makes.
  //
  // Kept alongside the flat threshold rather than replacing it: the hit count
  // depends on the difficulty being known, and while it is still being worked
  // out the old rule is the safety net. Whichever fires first wins.
  const hits = state.hits_we_can_take;
  if (typeof hits === 'number' && hits <= 2) return escapable ? 'flee' : 'fight';

  if (state.bot_health <= 8) return escapable ? 'flee' : 'fight';
  if (state.nearby_hostiles >= 3) return 'flee'; // outnumbered: try regardless
  return 'fight';
}

/**
 * How long we're willing to deliberate about this particular threat.
 *
 * Distance is time. Something 12 blocks away can be thought about; something
 * at arm's length cannot, and asking anyway is how the bot died mid-question.
 */
function deliberationBudgetMs(state) {
  if (state.distance_blocks <= config.typesafe.reflexRangeBlocks) return 0;
  if (state.recently_took_damage) return 0;
  return config.typesafe.combatDeadlineMs;
}

/**
 * Get a verdict without letting a slow model call hold combat hostage.
 *
 * The request is ALWAYS made (it populates the cache and the decision log
 * either way) — what varies is whether we wait for it. At reflex range we
 * don't wait at all, which is the whole point of pairing a fast typed model
 * with hardcoded instincts: the model informs the next decision, reflexes
 * handle this one.
 */
async function decideAction(bot, ctx, entity, state, task) {
  const cached = cachedDecision(ctx, entity.id);
  if (cached) {
    // A cache hit here is almost always a PREFETCHED Jev answer — the
    // background warmer asked while the mob was still approaching. This is
    // the path that lets a model with second-scale latency actually decide
    // a reflex action.
    ctx.jev.usedCached++;
    return { decision: cached, source: 'cache' };
  }

  const entityId = entity.id;
  // Same subject as the prefetcher's, so a question already on the wire about
  // this mob is awaited rather than asked a second time.
  const pending = jevClient.assessMobThreat(state, { subject: `mob:${entityId}` })
    .then((result) => {
      // A failed call returns a blanket 'flee' fallback. Caching that would
      // make the bot run from things it cannot outrun for the next cooldown
      // window — the exact behaviour that kept getting it killed. Instinct
      // at least knows whether escape is possible, so prefer it. The same
      // goes for an answer below the confidence floor.
      if (!jevClient.confident(result)) return null;

      ctx.threat.decisions.set(entityId, { decision: result.decision, at: Date.now() });
      logger.decision('Threat decision', {
        input: state,
        decision: result.decision,
        confidence: result.confidence,
        source: result.source,
        latencyMs: result.latencyMs,
      });
      return result;
    })
    .catch(() => null);

  const budgetMs = deliberationBudgetMs(state);
  if (budgetMs > 0) {
    const answered = await Promise.race([
      pending,
      sleep(budgetMs, task).then(() => null),
    ]);
    if (answered) return { decision: answered.decision, source: answered.source };
  }

  ctx.jev.usedInstinct++;
  const instinct = instinctiveDecision(state);
  logger.info(budgetMs === 0 ? 'Too close to deliberate — reacting' : 'Jev slow — acting on instinct', {
    decision: instinct,
    target: state.mob_type,
    distance: state.distance_blocks,
    waitedMs: budgetMs,
  });
  return { decision: instinct, source: 'instinct' };
}

const threat = {
  name: 'threat',
  // Below shelter (91) and bed (92): when it's night and we're outmatched,
  // not taking the fight beats taking it. Still far above the interrupt
  // floor, so it preempts all routine work.
  //
  // That ordering is right for CHOOSING a fight and wrong for being in one —
  // which is what `defend` below exists for. See the note there.
  priority: 88,
  shouldRun(bot, ctx) {
    if (bot.health <= 0) return false;

    // LEAVE IT TO `defend` WHEN `defend` WANTS IT.
    //
    // The two share a run(), so both wanting the same fight means the fight is
    // started twice: `threat` at 88 wins the idle pick, `defend` at 94 preempts
    // it a moment later, and the whole approach — equip, close, first swing —
    // is thrown away and redone. Watched live as two "Committing to fight /
    // Engaging" pairs inside the same second against the same zombie at the
    // same distance, with a preempt line between them.
    //
    // One owner per situation: anything already hitting us, or close enough to,
    // belongs to `defend`; everything further out is `threat` choosing to pick
    // a fight, which is the case that should stay below sheltering.
    if (underAttack(bot, ctx)) return false;

    // candidates() already filters to things worth reacting to, so anything
    // selectTarget returns is actionable by definition.
    const target = selectTarget(bot, ctx);
    if (!target) return false;

    // If Jev already said this thing isn't worth reacting to, genuinely
    // leave it alone. Previously "ignore" still ran this behavior (just to
    // sleep), which outranked and starved everything below it — the bot
    // would stand next to a harmless mob doing nothing instead of working.
    return cachedDecision(ctx, target.entity.id) !== 'ignore';
  },
  /**
   * Higher bar for interrupting work in progress: something has to actually
   * be on us, or have hit us. A skeleton ambling past 13 blocks away isn't
   * worth abandoning a half-mined block for, only to restart it afterwards.
   */
  canInterrupt(bot, ctx) {
    if (!threat.shouldRun(bot, ctx)) return false;
    if (Date.now() - ctx.threat.lastAttackedAt < 3000) return true;
    const target = selectTarget(bot, ctx);
    if (!target) return false;
    return bot.entity.position.distanceTo(target.entity.position) <= INTERRUPT_RANGE;
  },
  async run(bot, ctx, task) {
    const since = Date.now();
    const target = selectTarget(bot, ctx);
    if (!target) return false;

    const { entity, label } = target;
    const distance = bot.entity.position.distanceTo(entity.position);

    // ---- Creepers: leave, don't trade ---------------------------------
    //
    // The bot kept dying to these. Melee hit-and-run looked sensible on
    // paper and was unworkable in practice: the engine only swings inside
    // 3 blocks, and the safe distance is 5, so the bot backed off before it
    // could ever land a hit — it danced at arm's length until the fuse
    // finished. Creepers are also worth nothing to a speedrun (gunpowder
    // isn't on the critical path), and a sprinting player outruns one
    // comfortably. So: walk away. Every time.
    if (isExplosive(entity)) {
      const fusing = creeperIsFusing(entity);

      // Far away and unlit: it is scenery. Creepers are slower than a
      // sprinting bot, so one across the clearing is not a threat — and
      // dropping everything to walk away from it, which is what this used to
      // do at any distance up to 14 blocks, cost real working time for no
      // safety gain whatsoever.
      if (!fusing && distance > CREEPER_BOTHER_RANGE) {
        ctx.threat.decisions.set(entity.id, { decision: 'ignore', at: Date.now() });
        logger.info('Creeper, but far off — carrying on', {
          distance: Number(distance.toFixed(1)),
        });
        return false;
      }

      // Armed and it has not lit up: kill it properly with strike-and-
      // withdraw. A dead creeper is worth more than a creeper that follows
      // us around for the next five minutes.
      if (!fusing && hasWeapon(bot) && bot.health > LOW_HEALTH_BAIL) {
        logger.action('Creeper — strike and withdraw', {
          distance: Number(distance.toFixed(1)),
          weapon: bestWeapon(bot)?.name ?? 'fists',
        });
        const startedAt = Date.now();
        const origin = bot.entity.position.clone();
        await fightCreeper(bot, entity, task, () => {
          if (!entity.isValid) return 'creeper dead';
          if (bot.health <= LOW_HEALTH_BAIL) return 'health too low';
          if (Date.now() - startedAt > FIGHT_TIMEOUT_MS) return 'fight timeout';
          if (bot.entity.position.distanceTo(origin) > CHASE_LEASH) return 'chase leash';
          return null;
        });
        return true;
      }

      // Fusing, unarmed, or hurt — distance is the only answer left.
      logger.info('Creeper — backing off rather than trading', {
        distance: Number(distance.toFixed(1)),
        fusing,
        why: fusing ? 'fuse lit' : (hasWeapon(bot) ? 'too hurt' : 'unarmed'),
      });
      await retreatFrom(bot, entity.position, [10, 7, 5], task)
        .catch((e) => { if (isInterruption(e)) throw e; });
      return true;
    }

    // ---- Endermen: go up, not toe to toe ------------------------------
    //
    // An enderman reaches exactly as far as we do (3.0) and hits for 7 with
    // 40 health, so there is no range advantage to win on and no trade worth
    // taking — a stone sword loses that fight every time. But it cannot
    // jump, and it cannot path upward, so three blocks of pillar puts the
    // bot somewhere it simply cannot be hit.
    //
    // The nuances that make this work rather than just sound clever:
    //  - it must be a pillar we can get down from, so ordinary blocks, and
    //    the bot stays put rather than mining itself into a spire
    //  - endermen teleport away when they lose interest, so waiting is the
    //    win condition; we are not trying to kill it
    //  - looking at one is what provokes them, so once we are up we stop
    //    tracking it entirely
    //  - rain and water damage them, which is why this so often ends with
    //    the enderman simply gone
    if (entity.name === 'enderman') {
      logger.action('Enderman — going up out of its reach', {
        distance: Number(distance.toFixed(1)),
      });
      const rose = await pillarAwayFrom(bot, task);
      // Sit it out. It teleports off once it can't reach us.
      ctx.threat.unreachable.set(entity.id, Date.now() + ENDERMAN_WAIT_MS);
      if (!rose) logger.info('Could not get above it — leaving instead');
      return true;
    }

    // An archer we are in no state to charge: get out of its sight instead.
    // See hideFromArcher.
    if (isRangedAttacker(entity) && !isBoss(entity) && shouldHideFromArcher(bot)) {
      if (await hideFromArcher(bot, entity, task)) return true;
    }

    // ---- Reflex path -------------------------------------------------
    //
    // Something is at swinging range. The expensive part was never the
    // model itself — it was assembling the threat state (which scans every
    // entity in the world) and opening a request before the first swing.
    //
    // So: consult Jev's ALREADY-COMPUTED opinion, which the background
    // prefetcher warmed while this mob was still walking over. That's a Map
    // lookup — free — and it means the model genuinely decides point-blank
    // encounters despite having second-scale latency. Only if no answer is
    // ready do we build the state and fall back to instinct.
    const cornered = !canOutrun(entity) || isRangedAttacker(entity);
    const reflexEligible = distance <= FAST_ATTACK_RANGE
      && bot.health > bailHealth(bot, ctx)
      && !isExplosive(entity)
      && !isBoss(entity);

    if (reflexEligible) {
      const prefetched = cachedDecision(ctx, entity.id);

      if (prefetched) {
        ctx.jev.usedCached++;
        // Respect a "flee" verdict only when fleeing can actually work.
        // Against something faster than us, or an archer, running away
        // donates free hits — the model can't know that, we can.
        const escapable = canOutrun(entity) && !isRangedAttacker(entity);
        if (prefetched === 'fight' || !escapable) {
          logger.action('Reflex attack', {
            target: label,
            distance: Number(distance.toFixed(1)),
            per: prefetched === 'fight' ? 'jev' : `jev said flee, but ${isRangedAttacker(entity) ? 'it shoots' : 'we cannot outrun it'}`,
            reactionMs: Date.now() - since,
          });
          return (await fightTarget(bot, ctx, entity, task, since)).resolved;
        }
        // Jev says flee and fleeing is viable — fall through to the
        // considered path below, which knows how to retreat properly.
      } else if (hasWeapon(bot) || cornered) {
        // No opinion ready: instinct would say "hit it" at this range.
        ctx.jev.usedInstinct++;
        return (await fightTarget(bot, ctx, entity, task, since)).resolved;
      }
    }

    const state = buildThreatState(bot, ctx, entity, distance);

    // Too hurt to be picking fights. Decided here rather than asking, so a
    // cached "fight" can't put us in a loop that bails instantly on the
    // health check and immediately re-enters.
    let decision;
    const bail = bailHealth(bot, ctx);
    if (bot.health <= bail) {
      logger.info('Too hurt to fight — retreating', { health: Math.round(bot.health), bail, target: label });
      decision = 'flee';
    } else {
      decision = (await decideAction(bot, ctx, entity, state, task)).decision;
    }

    if (decision === 'ignore') {
      logger.info('Ignoring threat', { target: label });
      // NOTHING was done, and the director has to be told so. A bare `return`
      // is undefined, which it counts as work: commitment granted, backoff
      // never engaged. From `defend` — which does not consult the ignore
      // cache the way threat.shouldRun does — that is a behavior re-picked
      // every 25ms for the eight seconds the verdict lives, logging this line
      // each time and starving everything below priority 94.
      return false;
    }

    if (decision === 'flee') {
      // Escaping only works against something slower than us that can't
      // shoot. Against anything else, running away donates free hits: same
      // damage taken, none dealt. Don't even attempt it once — and if we
      // still have a weapon and some health, fight instead of being chased.
      // "Can't escape, so fight" must never apply to a boss — that turns a
      // slim chance of getting away into a certain death.
      //
      // Note there is NO weapon requirement here any more. Being unarmed is
      // a reason to prefer not to fight, not a reason to run from something
      // faster than you: a pursuing player catches the bot either way, and
      // running just means taking the same hits while dealing none back.
      // Requiring a weapon here is why the bot stopped fighting back after
      // losing its sword — it would jog away and die.
      const hopeless = state.threat_is_pursuing
        && (!state.can_outrun_it || state.attacks_at_range)
        && !state.is_boss
        && bot.health > LOW_HEALTH_BAIL;

      const attempts = noteFleeAttempt(ctx, entity.id);
      // A boss NEVER gets escalated into a fight. This was the hole that let
      // the bot punch a wither: "hopeless" excluded bosses correctly, but the
      // failed-escapes branch beside it did not, so after two unsuccessful
      // retreats it turned around and attacked anyway.
      if (isBoss(entity)) {
        await flee(bot, entity, task);
        return false;
      }
      if (hopeless || (attempts > FLEE_ESCALATION_LIMIT && state.threat_is_pursuing)) {
        logger.action('Cannot escape — turning to fight', {
          target: label,
          reason: hopeless
            ? (state.attacks_at_range ? 'it shoots' : 'faster than us')
            : `${attempts - 1} failed escapes`,
          armed: state.weapon !== 'none',
        });
        ctx.threat.decisions.set(entity.id, { decision: 'fight', at: Date.now() });
        decision = 'fight';
      } else {
        // Report a failed escape as "no work done" so the director backs this
        // behavior off instead of instantly re-running it. Threat sits at
        // priority 90 and monopolises the schedule, so a flee that achieves
        // nothing becomes a hot loop that blocks every other behavior —
        // including the crafting that would end the problem permanently.
        // Genuinely inescapable threats are handled by the escalation above.
        return flee(bot, entity, task);
      }
    } else {
      ctx.threat.fleeAttempts.delete(entity.id);
    }

    // Fight. Specialised openers first, then the per-mob tactics engine
    // (which handles crits, strafing, hit-and-run and retargeting).
    logger.action('Committing to fight', { target: label, distance: Number(distance.toFixed(1)) });

    if (isRangedAttacker(entity) && hasItem(bot, 'arrow') && findItem(bot, (i) => i.name === 'bow')) {
      const origin = bot.entity.position.clone();
      const startedAt = Date.now();
      const handled = await rangedFight(bot, entity, task, () => {
        if (!entity.isValid) return 'target dead';
        if (bot.health <= LOW_HEALTH_BAIL) return 'health too low';
        if (Date.now() - startedAt > FIGHT_TIMEOUT_MS) return 'fight timeout';
        if (bot.entity.position.distanceTo(origin) > CHASE_LEASH) return 'chase leash reached';
        return null;
      });
      if (handled) return true;
      // Fell through (no bow / out of arrows) — brawl instead.
    }

    // NOTE: there used to be a "pillar up out of reach and hit down" opener
    // here for zombies. It has been removed, and not reluctantly: placing
    // two blocks takes about a second of sleeps and block placements BEFORE
    // the first swing, which is a large part of "it takes too long to start
    // attacking". It also strands the bot on a tower in the middle of a
    // horde. With a real combat engine doing crits and strafing, fighting a
    // zombie on the ground is simply better.
    // `resolved` is false when the engagement achieved nothing — an
    // unreachable target, or a room full of them. Reporting that honestly is
    // what lets the director back this behavior off instead of handing it the
    // wheel again immediately. See fightTarget.
    return (await fightTarget(bot, ctx, entity, task, since)).resolved;
  },
};

/**
 * FIGHTING BACK OUTRANKS GOING TO BED, and it did not.
 *
 * This is the bug behind the death that was reported in the plainest possible
 * terms: "he had full iron tools and a shield and there was a zombie, the bot
 * didn't do anything, it just got hit multiple times and it was AFK and got
 * killed by the zombie."
 *
 * The scheduler explains it exactly. `shelter` sits at 91 and `bed` at 92,
 * both above `threat` at 88, on the reasoning that avoiding a night fight beats
 * taking one. Both are also in the director's LONG_RUNNING set, which exempts
 * them from the sixty-second deadlock breaker, because burrowing or sleeping
 * legitimately occupies the bot for a whole Minecraft night. And Jev had been
 * returning `focus: shelter` all evening, which adds another five.
 *
 * So at night, with a zombie already swinging, `shelter` held the wheel at an
 * effective 96 and `threat` at 88 could not take it back. From outside: a bot
 * standing still in full iron being eaten.
 *
 * The distinction that fixes it is the one the reasoning was always making
 * implicitly. "Do not pick a fight at night" is about a mob across the
 * clearing. It is not about the one hitting you. So the decision to START a
 * fight stays below sheltering, and defending against a fight already happening
 * goes above it — the same split that `escapeDrowning` and `leaveWater` already
 * use, and for the same reason.
 *
 * It sits below escapeDrowning (95), because drowning while fighting is still
 * drowning, and above unstick (93): a bot being hit should hit back before it
 * starts rearranging the terrain.
 */
const DEFEND_RANGE = 6;
const DEFEND_RECENT_HIT_MS = 5000;

function underAttack(bot, ctx) {
  if (bot.health <= 0) return false;
  const target = selectTarget(bot, ctx);
  if (!target) return false;

  // Something is actually landing hits on us — hits, not a fall or hunger,
  // which is what lastAttackedAt now means (see src/damage.js).
  if (Date.now() - ctx.threat.lastAttackedAt < DEFEND_RECENT_HIT_MS) return true;

  // ...or is close enough that it is about to. Creepers are excluded: the
  // answer to one is distance, and `shelter` sealing us into a hole away from
  // it is a perfectly good answer that this must not preempt.
  //
  // So is anything Jev has already judged not worth reacting to. threat.shouldRun
  // has always honoured that verdict and this did not, so a mob idling at five
  // blocks with an "ignore" on it was handed to defend, whose run() promptly
  // ignored it again — and round it went. A mob that actually HITS us is caught
  // by the check above regardless of any verdict.
  return target.distance <= DEFEND_RANGE
    && !isExplosive(target.entity)
    && cachedDecision(ctx, target.entity.id) !== 'ignore';
}

/**
 * Unarmed, at night, with room to dig: the answer is a hole, not a fight.
 *
 * Bare fists do 1 damage. In the 09-25 02:09 session a freshly respawned bot
 * with nothing in its hands was killed seven times in ten minutes, and the
 * pattern was the same each time: something shot or hit it, `defend` (94)
 * took the wheel ahead of `shelter` (91), and it boxed a skeleton to death
 * — its own. wantsShelter already refuses when anything is close enough to
 * follow us down or a creeper is near, so yielding only happens when digging
 * in can actually work; and once shelter is digging, digInProgress keeps
 * defend out until the damage budget is spent.
 */
function shouldYieldToShelter(bot, ctx) {
  if (hasWeapon(bot)) return false;
  // Lazy: shelter.js imports this module.
  const { wantsShelter } = require('./shelter');
  return !!ctx.shelter && wantsShelter(bot, ctx) === true;
}

const defend = {
  name: 'defend',
  priority: 94,
  shouldRun: (bot, ctx) => underAttack(bot, ctx) && !shouldYieldToShelter(bot, ctx),
  // Same bar either way. Everything this fires for is already urgent enough to
  // abandon whatever was running, which is the entire point of it.
  //
  // Except `threat` itself. defend's run IS threat.run, so preempting threat
  // to start it again only aborts a fight in progress to restart the same one:
  // on 09-25 "Committing to fight {zombie}" was followed within the second by
  // "Preempting {running: threat, preemptedBy: defend}" and a second
  // "Engaging" of the same zombie, six times in five minutes. threat.run
  // already turns on whatever is hitting us ("Retargeting mid-fight — archer
  // shooting us"), so there is nothing defend would do differently.
  //
  // And not a dig-in still inside its damage budget — see digInProgress in
  // shelter.js. Aborting it mid-block is how the unarmed bot kept dying.
  canInterrupt: (bot, ctx) => ctx.currentBehavior !== 'threat'
    && !require('./shelter').digInProgress(bot, ctx)
    && underAttack(bot, ctx),
  run: (bot, ctx, task) => threat.run(bot, ctx, task),
};

// buildThreatState is exported so src/prefetch.js can warm the same cache
// this file reads, asking Jev exactly the question this file would ask.
// Keeping one definition of "what Jev needs to be told" matters: two copies
// would drift, and the prefetched answer would silently be for a different
// question than the one being asked.
module.exports = {
  threat, defend, buildThreatState,
  // For src/prefetch.js — which answers are worth warming, and when.
  worthAskingJev, needsFreshAnswer, THREAT_ANSWER_TTL_MS,
  // For test/combatscheduling.test.js.
  bailHealth, LOW_HEALTH_BAIL, BAIL_HEALTH_CAP, wallOff, shouldHideFromArcher,
  // Shared with shelter.js's own hostile count, which had the identical gap —
  // see the note on worthReactingTo's catch-all branch above.
  hasLineOfSight,
};
