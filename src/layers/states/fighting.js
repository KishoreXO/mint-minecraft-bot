const logger = require('../../logger');
const { isHostileMob, eyePos } = require('../../entities');
const { defaultPolicy, observationFor } = require('../policy');

/**
 * Combat, with a swappable brain.
 *
 * By default this state does nothing to the bot — director's `defend`/
 * `threat` behaviors are already running the fight through tactics.js's
 * fightMelee/fightCreeper, which is the tuned, live-verified implementation.
 * Driving the controls from here too would mean two pieces of code fighting
 * over bot.setControlState in the same tick.
 *
 * Setting `ctx.combatPolicy.enabled = true` switches this state to actually
 * drive the fight itself, through whatever policy is plugged in
 * (ctx.combatPolicy.policy, defaulting to policy.defaultPolicy) — see
 * src/layers/policy.js for the observation/action contract. That's the
 * on-ramp for an RL policy later: point ctx.combatPolicy.policy at it and
 * flip the flag, no other code changes.
 */

function nearestHostile(bot) {
  const me = bot.entity?.position;
  if (!me) return null;
  let bestEntity = null;
  let bestDist = Infinity;
  for (const id of Object.keys(bot.entities)) {
    const e = bot.entities[id];
    if (!e || e === bot.entity || !isHostileMob(e)) continue;
    const d = me.distanceTo(e.position);
    if (d < bestDist) {
      bestEntity = e;
      bestDist = d;
    }
  }
  return bestEntity ? { entity: bestEntity, distance: bestDist } : null;
}

function applyAction(bot, action, target) {
  bot.setControlState('forward', action.move === 'forward');
  bot.setControlState('back', action.move === 'back');
  bot.setControlState('left', action.strafe === 'left');
  bot.setControlState('right', action.strafe === 'right');
  bot.setControlState('sprint', !!action.sprint);

  if (target) bot.lookAt(eyePos(target), true).catch(() => {});

  if (action.attack && target) {
    try {
      bot.attack(target);
      bot._policySwingAt = Date.now();
    } catch {
      // target died between the decision and the swing
    }
  }
}

const fighting = {
  name: 'fighting',
  enter(bot, ctx, reason) {
    ctx.combatPolicy = ctx.combatPolicy || { enabled: false, policy: defaultPolicy };
    logger.info('State transition', { to: 'fighting', reason });
  },
  update(bot, ctx) {
    if (!ctx.combatPolicy?.enabled) return;

    const found = nearestHostile(bot);
    const observation = observationFor(bot, found?.entity, found?.distance);
    const policy = ctx.combatPolicy.policy || defaultPolicy;
    const action = policy.act(observation);
    applyAction(bot, action, found?.entity);
  },
  exit(bot) {
    bot.clearControlStates();
  },
};

module.exports = { fighting, nearestHostile, applyAction };
