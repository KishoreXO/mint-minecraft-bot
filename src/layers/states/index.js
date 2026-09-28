const { idle } = require('./idle');
const { gathering } = require('./gathering');
const { mining } = require('./mining');
const { crafting } = require('./crafting');
const { fighting } = require('./fighting');
const { fleeing } = require('./fleeing');

const STATES = {
  idle, gathering, mining, crafting, fighting, fleeing,
};

/**
 * Every state can reach every other state directly.
 *
 * Not laziness — it's the actual shape of this bot. A fight can start from
 * any activity (a zombie doesn't wait for a convenient moment), any activity
 * can need to flee mid-swing, and the moment a fight or flight ends the bot
 * goes straight back to whatever focus it had rather than passing through an
 * idle stop first. An artificially restricted table here wouldn't model a
 * real constraint, it would just be extra code standing between a reflex and
 * the transition it needs to force.
 */
const ALL = Object.keys(STATES);
const TRANSITIONS = Object.fromEntries(
  ALL.map((name) => [name, new Set(ALL.filter((other) => other !== name))]),
);

/**
 * Which state a director.js behavior name belongs to.
 *
 * This is classification, not control — the state machine is watching what
 * director already decided to run (see src/layers/controller.js), not
 * picking it. Keeping this table separate from director.js's own priority
 * list means a new behavior silently defaults to 'idle' until someone adds
 * it here, rather than crashing; see the fallback in classify().
 */
const BEHAVIOR_TO_STATE = {
  escapeHazard: 'fleeing',
  escapeDrowning: 'fleeing',
  leaveWater: 'fleeing',
  defend: 'fighting',
  threat: 'fighting',
  unstick: 'idle',
  bed: 'idle',
  shelter: 'idle',
  explore: 'idle',
  idle: 'idle',
  dead: 'idle',
  nothing: 'idle',
  loot: 'gathering',
  woodUrgent: 'gathering',
  forage: 'gathering',
  forageTopUp: 'gathering',
  collect: 'gathering',
  huntUrgent: 'gathering',
  hunt: 'gathering',
  wood: 'gathering',
  gatherStone: 'gathering',
  gear: 'crafting',
  smelt: 'crafting',
  fetchCooked: 'gathering',
  tidy: 'crafting',
  mine: 'mining',
  goDeep: 'mining',
  stripMine: 'mining',
  // Grouped with descent, not general gathering — see director.js's
  // FOCUS_BEHAVIORS.descend, which pairs it with goDeep.
  resupply: 'mining',
};

function classify(behaviorName) {
  return BEHAVIOR_TO_STATE[behaviorName] || 'idle';
}

module.exports = {
  STATES, TRANSITIONS, BEHAVIOR_TO_STATE, classify,
};
