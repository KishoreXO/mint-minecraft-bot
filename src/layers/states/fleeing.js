const { observerState } = require('./shared');

/**
 * Getting away from something rather than fighting it — director's
 * escapeHazard/escapeDrowning/leaveWater, and threat.js's own flee path.
 * Reflexes force this transition directly (see src/layers/reflex.js); it is
 * always reachable from every other state for that reason.
 */
const fleeing = observerState('fleeing');

module.exports = { fleeing };
