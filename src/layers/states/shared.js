const logger = require('../../logger');

/** A state with no per-tick work of its own — director.js already drives it. */
function observerState(name) {
  return {
    name,
    enter(bot, ctx, reason) {
      logger.info('State transition', { to: name, reason });
    },
    // No update(): the real work behind this state is director.js picking
    // behaviors as it already does. This layer classifies what's running
    // rather than re-driving it — see states/index.js.
  };
}

module.exports = { observerState };
