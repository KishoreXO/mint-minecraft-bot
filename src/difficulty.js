const logger = require('./logger');
const {
  DIFFICULTIES, mobFacts, scaleDamage, armorWorn, armorMultiplier, expectedHit,
} = require('./knowledge');

/**
 * Work out which difficulty this world is running on, from how hard things hit.
 *
 * Asked for directly: "make the find which difficulty by the attack damage
 * from the mob". It matters more than it sounds. Every damage figure in
 * src/knowledge.js is the Normal value, and the same zombie costs 2.5 health
 * on Easy and 4.5 on Hard — so "can I survive three more hits" has three
 * different answers and the bot was always assuming the middle one. On Hard
 * that makes it fatally bold; on Easy, needlessly timid.
 *
 * TWO SOURCES, and they are not equal:
 *
 *   reported  the server states the difficulty in its own packet, which
 *             mineflayer parks on bot.game.difficulty. When it is there it is
 *             the truth and nothing should second-guess it.
 *   inferred  worked out from observed hits, for when it is not. In 1.21 the
 *             value moved out of the login packet into a separate one, and a
 *             packet the client never receives leaves bot.game.difficulty
 *             undefined — so this cannot be the only mechanism.
 *
 * THE INFERENCE. Vanilla scales incoming damage in the PLAYER's damage
 * handler, not the mob's:
 *
 *   easy    min(base / 2 + 1, base)
 *   normal  base
 *   hard    base * 3 / 2
 *
 * So a zombie's base 3 lands as 2.5 / 3 / 4.5. Those are far enough apart to
 * tell apart from a single clean hit, and the gap widens with the mob: a
 * vindicator's 13 lands as 7.5 / 13 / 19.5.
 *
 * A "clean" hit is doing a lot of work in that sentence, and most of this file
 * is about refusing the dirty ones. Rejected outright:
 *
 *   creepers   blast damage falls off with distance, so any value is possible
 *   arrows     damage scales with draw strength and flight speed
 *   shields    a blocked hit is reduced by an amount we cannot see
 *   unknown    a mob with no entry has no baseline to compare against
 *   multiples  two mobs in reach means we cannot say which one landed it
 *
 * What is left is a single identified melee attacker in reach, which is the
 * common case and is enough. Armour is corrected for rather than rejected,
 * using the real 1.9 formula — otherwise the bot would stop being able to
 * learn the moment it put a helmet on.
 *
 * Peaceful is deliberately NOT inferrable. Its signature is the absence of
 * damage, and "nothing has hit me recently" is equally consistent with being
 * good at not getting hit. It is only ever accepted from the server.
 */

// Damage-based inference can only distinguish these three.
const MEASURABLE = DIFFICULTIES.filter((d) => d !== 'peaceful');

// How far off a prediction can be and still count as a match. Health is sent
// as a float and the server rounds in places, so exact equality is too strict.
const TOLERANCE = 0.35;

// Enough hits to be confident. One is suggestive; three from the same world
// with consistent answers is not a coincidence.
const MIN_SAMPLES = 3;
const MIN_CONFIDENCE = 0.45;

// Anything landing harder than this against no armour is not a plain melee
// hit — it is a fall, a fused creeper we failed to spot, or two things at once.
const IMPLAUSIBLE_HIT = 25;

function createState() {
  return {
    /** What the server told us, if anything. Authoritative. */
    reported: null,
    /** What the hits say. Used only when the server has not told us. */
    inferred: null,
    confidence: 0,
    samples: 0,
    // Accumulated absolute error per candidate, lowest wins.
    scores: Object.fromEntries(MEASURABLE.map((d) => [d, 0])),
    lastSample: null,
    warnedMismatch: false,
  };
}

/**
 * The difficulty to plan against right now. Server first, then inference,
 * and when neither has an answer yet: HARD.
 *
 * Assuming Normal was the obvious default and it is the wrong one, because
 * the two directions of error are not symmetrical. Guess too high and the bot
 * is briefly over-cautious — it flees a fight it could have won, and loses
 * thirty seconds. Guess too low and it stands and trades with something
 * hitting 50% harder than it expects, and loses everything it is carrying.
 *
 * The exposure is small and it is front-loaded: this only applies until three
 * clean hits have landed, which on any world with hostiles is the first
 * minute. Being timid for that minute costs nothing worth measuring.
 */
const ASSUMED = 'hard';

function current(ctx) {
  return ctx.difficulty?.reported ?? ctx.difficulty?.inferred ?? ASSUMED;
}

/** Where that answer came from, for anything that reports to a human. */
function source(ctx) {
  if (ctx.difficulty?.reported) return 'server';
  if (ctx.difficulty?.inferred) return 'observed damage';
  return 'assumed';
}

/**
 * What one hit from this mob costs us right now — difficulty and armour both
 * applied. This is the number every fight-or-flight judgement actually wants.
 */
function hitCost(bot, ctx, mobName) {
  return expectedHit(bot, mobName, current(ctx));
}

/** How many more hits from this mob we could take before dying. */
function hitsSurvivable(bot, ctx, mobName) {
  const cost = hitCost(bot, ctx, mobName);
  if (cost <= 0) return Infinity; // peaceful, or armour good enough to ignore it
  return Math.floor((bot.health ?? 20) / cost);
}

/**
 * Record what the server said. Called on join and whenever it changes — a
 * difficulty change mid-session is a real thing an operator can do.
 */
function noteReported(ctx, value) {
  if (!value || !DIFFICULTIES.includes(value)) return;
  if (ctx.difficulty.reported === value) return;

  const first = ctx.difficulty.reported === null;
  ctx.difficulty.reported = value;
  logger.info(first ? 'Server difficulty' : 'Difficulty changed', {
    difficulty: value,
    ...(ctx.difficulty.inferred ? { weHadInferred: ctx.difficulty.inferred } : {}),
    meaning: value === 'peaceful'
      ? 'no hostiles will spawn'
      : `a zombie hits for ${scaleDamage(mobFacts('zombie').damage, value)}`,
  });
}

/**
 * Is this hit clean enough to learn anything from?
 *
 * Returns the reason it is not, or null when it is usable. Returning the
 * reason rather than a boolean is worth the extra word: when the bot spends a
 * whole session never working out the difficulty, the question is always
 * "which filter is eating every sample".
 */
function rejectReason(bot, mobName, lost) {
  const facts = mobFacts(mobName);
  if (facts.unknown) return 'unknown mob';
  // Explosion damage is a function of distance and cover, not difficulty
  // alone, so a creeper tells us nothing we can invert.
  if (mobName === 'creeper') return 'creeper blast varies with distance';
  // Arrow damage varies with draw and flight speed; only the mob's MELEE
  // number is a fixed quantity we can compare against.
  if (facts.ranged) return 'ranged attacker';
  if (lost <= 0) return 'no damage';
  if (lost > IMPLAUSIBLE_HIT) return 'too large to be one melee hit';
  // A raised shield absorbs an amount we cannot observe. Index 8 is the
  // LivingEntity "hand states" byte and bit 0 is "using an item", which for
  // this bot means blocking. If the index is wrong on some future version the
  // only cost is a sample that gets thrown out later for matching nothing.
  const handState = bot.entity?.metadata?.[8];
  if (typeof handState === 'number' && (handState & 0x01) !== 0) return 'shield was up';
  return null;
}

/**
 * Learn from one hit.
 *
 * `mobName` must be the mob that actually landed it — the caller is
 * responsible for being sure, because a guess here poisons the estimate
 * permanently rather than merely leaving it unknown.
 */
function observe(bot, ctx, mobName, lost) {
  const state = ctx.difficulty;
  if (!state) return;

  const reason = rejectReason(bot, mobName, lost);
  if (reason) {
    state.lastSample = { mob: mobName, lost: Number(lost.toFixed(1)), ignored: reason };
    return;
  }

  const base = mobFacts(mobName).damage;
  const { points, toughness } = armorWorn(bot);

  // Predict first, decide whether the sample is usable, and only then let it
  // touch the running scores. Scoring first and undoing it afterwards leaves
  // floating-point residue on every rejected hit, which is a slow drift in
  // exactly the numbers the verdict is read off.
  const errors = {};
  for (const level of MEASURABLE) {
    const scaled = scaleDamage(base, level);
    const predicted = scaled * armorMultiplier(points, toughness, scaled);
    errors[level] = Math.abs(predicted - lost);
  }

  const closest = MEASURABLE.reduce(
    (best, level) => (errors[level] < errors[best] ? level : best),
    MEASURABLE[0],
  );

  // A hit that matches nothing at all is not evidence about the difficulty,
  // it is evidence that something else was happening at the same moment —
  // two mobs, a fall on the same tick, a potion, a shield we failed to notice.
  // Scoring it would drag every candidate equally and only add noise.
  if (errors[closest] > TOLERANCE + 1) {
    state.lastSample = {
      mob: mobName, lost: Number(lost.toFixed(1)), ignored: 'matches no difficulty',
    };
    return;
  }

  for (const level of MEASURABLE) state.scores[level] += errors[level];
  state.samples++;
  state.lastSample = { mob: mobName, lost: Number(lost.toFixed(1)), suggests: closest };

  // Softly normalise the accumulated errors into a confidence. A candidate
  // with zero error and two rivals well behind it comes out near 1; three
  // candidates doing equally badly come out at a third, which correctly reads
  // as "we still do not know".
  const weights = Object.fromEntries(
    MEASURABLE.map((d) => [d, 1 / (1 + state.scores[d])]),
  );
  const total = MEASURABLE.reduce((sum, d) => sum + weights[d], 0);
  const best = MEASURABLE.reduce((a, b) => (weights[b] > weights[a] ? b : a), MEASURABLE[0]);

  state.confidence = weights[best] / total;

  if (state.samples < MIN_SAMPLES || state.confidence < MIN_CONFIDENCE) return;
  if (state.inferred === best) return;

  state.inferred = best;
  logger.info('Worked out the difficulty from how hard things hit', {
    difficulty: best,
    confidence: `${Math.round(state.confidence * 100)}%`,
    fromHits: state.samples,
    lastHit: state.lastSample,
    inUse: state.reported ? `no — server says ${state.reported}` : 'yes',
  });

  // Disagreeing with the server means the model in knowledge.js is wrong
  // somewhere, and that is worth knowing about even though the server wins.
  if (state.reported && state.reported !== best && !state.warnedMismatch) {
    state.warnedMismatch = true;
    logger.warn('Observed damage disagrees with the reported difficulty', {
      reported: state.reported,
      observed: best,
      note: 'trusting the server; the damage table may be off for this mob',
    });
  }
}

/** One line for a human: what we think, how sure, and on what evidence. */
function describe(ctx) {
  const state = ctx.difficulty;
  if (!state) return 'unknown';
  const value = current(ctx);
  if (state.reported) return `${value} (from the server)`;
  if (state.inferred) {
    return `${value} (worked out from ${state.samples} hits, `
      + `${Math.round(state.confidence * 100)}% sure)`;
  }
  return `assuming ${value} until it has been hit a few times `
    + `(${state.samples} usable hits so far) — guessing high is the safe way to be wrong`;
}

/**
 * Watch for the server stating its difficulty.
 *
 * mineflayer parks it on bot.game.difficulty, but there is no event for it and
 * the packet can arrive after spawn, so this polls until it appears. Cheap —
 * a property read — and it stops as soon as there is an answer, then keeps a
 * slow watch in case an operator changes it mid-session.
 */
const POLL_MS = 1000;

function startDifficultyWatch(bot, ctx) {
  const timer = setInterval(() => {
    if (!ctx.connected) return;
    noteReported(ctx, bot.game?.difficulty);
  }, POLL_MS);
  if (timer.unref) timer.unref();
  return () => clearInterval(timer);
}

module.exports = {
  createState,
  startDifficultyWatch,
  noteReported,
  observe,
  current,
  source,
  describe,
  hitCost,
  hitsSurvivable,
  // Exported for the tests: which difficulties damage can distinguish at all
  // is the premise the whole inference rests on, and peaceful not being in
  // here is the reason it is only ever accepted from the server.
  MEASURABLE,
};
