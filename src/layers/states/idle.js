const { observerState } = require('./shared');

/** Nothing urgent, nothing productive queued — director's `idle`/`explore`/bed/shelter. */
const idle = observerState('idle');

module.exports = { idle };
