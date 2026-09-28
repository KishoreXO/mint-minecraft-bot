const { observerState } = require('./shared');

/** Wood, food, stone — director's wood/hunt/forage/collect/gatherStone family. */
const gathering = observerState('gathering');

module.exports = { gathering };
