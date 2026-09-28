const logger = require('./logger');
const {
  woodUnits, countAny, bestToolOfType, tierRank,
} = require('./inventory');
const { nearestWithin, isFoodAnimal } = require('./entities');
const { EDIBLE } = require('./behaviors/survive');
const {
  stoneKitDone, ironStillNeeded, missingIronPieces, diamondInvested, TOOL_TYPES,
} = require('./behaviors/gear');
const {
  deepTripShortfall, descentShortfall, DIAMOND_GOAL, RESUPPLY_FOOD,
  importantOreInView,
} = require('./behaviors/mine');
const { CRITICAL_WOOD } = require('./behaviors/wood');
const {
  STOCK_FOR_TRIP, FOOD_STOCK_TARGET, mayHunt,
} = require('./behaviors/hunt');

/**
 * The progression, written down: which phase the bot is in, and which
 * behaviors are allowed to work on it.
 *
 * Asked for directly: "make a perfect hardcoded progression system and when to
 * bypass it". Before this, the order lived in fifteen shouldRun gates and the
 * gaps between priority numbers, and it leaked. The night staircase went deep
 * on a wooden pickaxe with none of the trip kit; a Jev focus plus the
 * commitment bonus lifted stocking food (34 -> 45) over crafting tools (40);
 * `mine` detoured for coal before there was a stone pickaxe. Each was a gate
 * someone forgot to add in one more place.
 *
 * Now there is one ordered list. Every "done" test is an existing predicate
 * or constant — nothing here restates a number the behaviors already own.
 *
 * Bypasses, agreed with the user as "safety plus cheap wins":
 *  - survival (priority >= the director's interrupt floor) is never gated;
 *  - maintenance (picking up drops, cooking, crafting what can be crafted
 *    now, keeping a wood reserve, climbing out to resupply) always runs;
 *  - a cheap win — needed ore or an animal within CHEAP_WIN_BLOCKS — may be
 *    taken out of order, because the detour costs seconds.
 * Nothing else skips a phase.
 */

const CHEAP_WIN_BLOCKS = 6;

function foodStock(bot) {
  return countAny(bot, EDIBLE);
}

function heldOrWorn(bot) {
  const names = bot.inventory.items().map((i) => i.name);
  for (const slot of ['head', 'torso', 'legs', 'feet', 'off-hand']) {
    try {
      const worn = bot.inventory.slots?.[bot.getEquipmentDestSlot(slot)]?.name;
      if (worn) names.push(worn);
    } catch {
      // No equipment table (tests, or before spawn) — the bag is the answer.
    }
  }
  return names;
}

const DIAMOND_KIT = ['pickaxe', 'sword', 'helmet', 'chestplate', 'leggings', 'boots'];

function missingDiamondPieces(bot) {
  const held = heldOrWorn(bot);
  return DIAMOND_KIT.filter((piece) => !held.some((n) => n === `diamond_${piece}` || n === `netherite_${piece}`));
}

function missingStoneTools(bot) {
  const stone = tierRank('stone_pickaxe');
  return TOOL_TYPES.filter((type) => {
    const tool = bestToolOfType(bot, type);
    return !tool || tierRank(tool.name) > stone;
  });
}

/**
 * The phases, in order. `done` is the bar for moving on; `kept` is the looser
 * bar for staying moved on — the same split as starting a trip against
 * continuing one (see mine.js descentShortfall). Without it the bot would drop
 * back to "food" the moment it ate its sixth steak at y=16 and walk out of the
 * mine it had just spent the kit getting to.
 */
const PHASES = [
  {
    id: 'wood',
    label: 'Wood',
    done: (bot) => woodUnits(bot) >= CRITICAL_WOOD,
    // A table and a pickaxe's sticks — the same reserve shelter keeps.
    kept: (bot) => woodUnits(bot) >= require('./behaviors/shelter').pickaxeWoodReserve(bot),
    need: (bot) => `${woodUnits(bot)}/${CRITICAL_WOOD} planks`,
  },
  {
    id: 'stoneKit',
    label: 'Stone tools',
    done: stoneKitDone,
    need: (bot) => `stone ${missingStoneTools(bot).join(', ')}`,
  },
  {
    id: 'food',
    label: 'Food',
    done: (bot) => foodStock(bot) >= STOCK_FOR_TRIP,
    kept: (bot) => foodStock(bot) >= RESUPPLY_FOOD,
    need: (bot) => `${foodStock(bot)}/${STOCK_FOR_TRIP} food`,
  },
  {
    id: 'tripPrep',
    label: 'Ready to dig',
    done: (bot) => deepTripShortfall(bot).length === 0,
    kept: (bot) => descentShortfall(bot).length === 0,
    need: (bot) => `need ${deepTripShortfall(bot).join(', ')}`,
  },
  {
    id: 'iron',
    label: 'Iron',
    done: (bot) => ironStillNeeded(bot) === 0,
    need: (bot) => `${ironStillNeeded(bot)} iron to mine`,
  },
  {
    id: 'ironKit',
    label: 'Iron kit',
    done: (bot) => missingIronPieces(bot).length === 0,
    need: (bot) => `${missingIronPieces(bot).length} pieces to make`,
  },
  {
    id: 'diamonds',
    label: 'Diamonds',
    done: (bot) => diamondInvested(bot) >= DIAMOND_GOAL,
    need: (bot) => `${diamondInvested(bot)}/${DIAMOND_GOAL} diamonds`,
  },
  {
    id: 'diamondKit',
    label: 'Diamond kit',
    done: (bot) => missingDiamondPieces(bot).length === 0,
    need: (bot) => `make ${missingDiamondPieces(bot).join(', ')}`,
  },
];

const PHASE_INDEX = Object.fromEntries(PHASES.map((p, i) => [p.id, i]));
const FINISHED = PHASES.length;

/**
 * Who works on which phase. Behaviors not listed here and below the interrupt
 * floor are gated to exactly these phases; ALWAYS lists the maintenance that
 * runs in any phase.
 */
const SERVES = {
  wood: ['wood', 'tripPrep'],
  gatherStone: ['stoneKit', 'tripPrep'],
  hunt: ['food', 'tripPrep'],
  forageTopUp: ['food', 'tripPrep'],
  valuables: ['iron', 'ironKit', 'diamonds', 'diamondKit'],
  mine: ['iron', 'ironKit', 'diamonds', 'diamondKit'],
  goDeep: ['iron', 'ironKit', 'diamonds', 'diamondKit'],
  stripMine: ['iron', 'ironKit', 'diamonds', 'diamondKit'],
};

const ALWAYS = new Set([
  // Emergencies that sit below the floor only because they must not preempt
  // a fight: an empty larder, and wood below the pickaxe reserve.
  'forage', 'huntUrgent', 'woodUrgent',
  // Upkeep: none of these start a phase, they finish work already paid for.
  'loot', 'fetchCooked', 'collect', 'resupply', 'gear', 'smelt', 'tidy',
  // The fallbacks — they only run when nothing else wants to.
  'explore', 'idle',
]);

/** Where the bot is, with the done/kept hysteresis — and log the moves. */
const CACHE_MS = 250;

function progressState(ctx) {
  if (!ctx.progression) {
    ctx.progression = {
      reached: 0, cachedAt: 0, index: 0, since: Date.now(), log: [],
    };
  }
  return ctx.progression;
}

function computePhase(bot, reached) {
  for (let i = 0; i < PHASES.length; i++) {
    const phase = PHASES[i];
    const test = i < reached ? (phase.kept ?? phase.done) : phase.done;
    if (!test(bot)) return i;
  }
  return FINISHED;
}

function phaseOf(bot, ctx) {
  const state = progressState(ctx);
  const now = Date.now();
  if (now - state.cachedAt < CACHE_MS) return state.index;

  let index = state.reached;
  try {
    index = computePhase(bot, state.reached);
  } catch {
    // A half-spawned bot (no inventory yet) keeps the last answer.
    return state.index;
  }
  state.cachedAt = now;
  if (!state.started) {
    // A restart or a fresh session mid-run: where we are, not what we "did".
    state.started = true;
    logger.info('Progression', { phase: PHASES[index]?.label ?? 'Done', need: PHASES[index]?.need(bot) ?? null });
  } else if (index !== state.index) {
    const from = PHASES[state.index]?.label ?? 'Done';
    const to = PHASES[index]?.label ?? 'Done';
    const tookSec = Math.round((now - state.since) / 1000);
    if (index > state.index) {
      logger.action('Phase complete', { phase: from, next: to, tookSec });
    } else {
      logger.warn('Back to an earlier phase', { from, to, why: PHASES[index]?.need(bot) });
    }
    state.log.push({ at: now, from: state.index, to: index });
    if (state.log.length > 50) state.log.shift();
    state.since = now;
  }
  state.index = index;
  state.reached = index;
  return index;
}

/** One place that says "are we at least this far along". */
function atLeast(bot, ctx, phaseId) {
  return phaseOf(bot, ctx) >= PHASE_INDEX[phaseId];
}

/** For the dashboard and the strategy prompt. */
function describe(bot, ctx) {
  const index = phaseOf(bot, ctx);
  const phase = PHASES[index];
  let need = null;
  try {
    need = phase ? phase.need(bot) : null;
  } catch {
    need = null;
  }
  return {
    index,
    id: phase?.id ?? 'done',
    label: phase?.label ?? 'Diamond kit complete',
    need,
    sinceMs: Date.now() - progressState(ctx).since,
    phases: PHASES.map((p) => ({ id: p.id, label: p.label })),
  };
}

/**
 * Out of order, but worth it: the target is a few seconds away.
 * Returns a reason string, or null.
 */
function cheapWin(bot, ctx, name) {
  if (name === 'valuables') {
    const candidate = importantOreInView(bot, ctx);
    if (!candidate) return null;
    const d = bot.entity.position.distanceTo(candidate.block.position);
    return d <= CHEAP_WIN_BLOCKS ? `${candidate.block.name} ${Math.round(d)} blocks away` : null;
  }
  if (name === 'hunt') {
    if (foodStock(bot) >= FOOD_STOCK_TARGET || !mayHunt(bot)) return null;
    const animal = nearestWithin(bot, isFoodAnimal, CHEAP_WIN_BLOCKS);
    return animal ? `${animal.name} ${Math.round(bot.entity.position.distanceTo(animal.position))} blocks away` : null;
  }
  return null;
}

/**
 * The director's gate. True means "this behavior may be asked".
 * Survival and maintenance always pass; everything else must serve the
 * current phase or be a cheap win.
 */
function allows(bot, ctx, behavior, floor) {
  if (behavior.priority >= floor) return true;
  if (ALWAYS.has(behavior.name)) return true;
  const serves = SERVES[behavior.name];
  if (!serves) return true; // unknown behaviors are not ours to hold back
  const index = phaseOf(bot, ctx);
  if (index >= FINISHED) return true;
  if (serves.includes(PHASES[index].id)) return true;

  const why = cheapWin(bot, ctx, behavior.name);
  if (why) {
    const state = progressState(ctx);
    const key = `${behavior.name}:${why}`;
    if (state.lastBypass !== key) {
      state.lastBypass = key;
      logger.info(`Out of order: ${behavior.name}`, { phase: PHASES[index].label, why });
    }
    return true;
  }
  return false;
}

module.exports = {
  PHASES, PHASE_INDEX, SERVES, ALWAYS, CHEAP_WIN_BLOCKS,
  phaseOf, atLeast, describe, allows, cheapWin, computePhase,
  missingDiamondPieces, missingStoneTools,
};
