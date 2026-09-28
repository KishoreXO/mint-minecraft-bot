const { MAX_STRIKE, shieldInOffHand } = require('../tactics');
const { mobFacts } = require('../knowledge');

/**
 * The pluggable policy interface for the fighting state.
 *
 *   policy.act(observation) -> action
 *
 * observation (plain data only — no entity references, so it can cross a
 * process boundary or be logged for training):
 *   {
 *     health, maxHealth, hunger,
 *     enemy: null | { distance, angle, velocity: {x, y, z}, reach },
 *     attackCooldownReady: boolean,
 *     hasShield: boolean,
 *     hotbar: (null | { name, count })[9],
 *   }
 *
 * action:
 *   {
 *     move: 'forward' | 'back' | 'none',
 *     strafe: 'left' | 'right' | 'none',
 *     sprint: boolean,
 *     attack: boolean,
 *     shieldUp: boolean,
 *   }
 *
 * WHY THIS IS NOT A WRAPPER AROUND tactics.js.
 *
 * tactics.js's fightMelee/fightCreeper are self-contained async loops —
 * months of live-tuned judgement about knockback windows, shield timing and
 * per-mob profiles, and they stay the bot's real combat implementation under
 * director.js. An RL policy cannot call into a loop like that; it can only
 * answer "given this observation, what's the one action right now", so
 * wrapping fightMelee behind policy.act() would mean faking single-step
 * semantics around a function that fundamentally isn't. Rewriting it as one
 * would risk the very behaviour that live combat depends on.
 *
 * So this is a genuinely separate, simpler decision function that reuses
 * tactics.js's NUMBERS (MAX_STRIKE, reach margins) so it fights by the same
 * geometry, without its state (knockback windows, strafe timers, per-mob
 * hit-and-run). It only runs when ctx.combatPolicy.enabled is explicitly
 * turned on (see states/fighting.js) — off by default, so the live bot keeps
 * fighting through the proven path.
 */

const REACH_MARGIN = 0.45;

function standoffFor(observation) {
  const reach = observation.enemy?.reach ?? 2.2;
  return Math.min(MAX_STRIKE - 0.1, reach + REACH_MARGIN);
}

const defaultPolicy = {
  act(observation) {
    const { enemy } = observation;
    if (!enemy) {
      return {
        move: 'none', strafe: 'none', sprint: false, attack: false, shieldUp: false,
      };
    }

    const standoff = standoffFor(observation);
    const tooFar = enemy.distance > standoff;
    const inStrikeRange = enemy.distance <= MAX_STRIKE;
    // The mob's OWN reach, not ours — this is what tactics.js calls
    // "inTheirMelee", and it is a different threshold from inStrikeRange
    // whenever the mob's reach is close to or beyond our own.
    const inTheirReach = enemy.distance <= (enemy.reach ?? 2.2) + 0.6;

    return {
      move: tooFar ? 'forward' : 'none',
      strafe: 'none',
      sprint: tooFar,
      attack: inStrikeRange && observation.attackCooldownReady,
      // Raise it once something that can already reach us has, and we are
      // not currently in OUR OWN strike range to answer with a swing.
      shieldUp: inTheirReach && !inStrikeRange && observation.hasShield,
    };
  },
};

/** Build the plain-data observation the interface promises, given a target entity. */
function observationFor(bot, target, distance) {
  const facts = target ? mobFacts(target.name) : null;
  return {
    health: bot.health ?? 20,
    maxHealth: 20,
    hunger: bot.food ?? 20,
    enemy: target ? {
      distance,
      angle: bot.entity?.yaw ?? 0,
      velocity: target.velocity ? { x: target.velocity.x, y: target.velocity.y, z: target.velocity.z } : { x: 0, y: 0, z: 0 },
      reach: facts?.reach ?? 2.2,
    } : null,
    attackCooldownReady: Date.now() - (bot._policySwingAt || 0) >= 625,
    hasShield: shieldInOffHand(bot),
    hotbar: (bot.inventory?.slots || []).slice(36, 45)
      .map((it) => (it ? { name: it.name, count: it.count } : null)),
  };
}

module.exports = { defaultPolicy, standoffFor, observationFor };
