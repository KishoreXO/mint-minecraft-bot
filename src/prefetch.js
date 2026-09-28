const logger = require('./logger');
const config = require('./config');
const jevClient = require('./jevClient');
const { isHostileMob, isOtherPlayer, isBoss } = require('./entities');

/**
 * Ask Jev the question BEFORE the answer is needed.
 *
 * This is the fix for the project's central tension. Jev is a fast typed
 * model, but "fast" measured live means 0.6–3.6 seconds, while a reflex
 * decision has to happen in tens of milliseconds. Every call site therefore
 * races it against a short deadline and falls back to a hardcoded instinct —
 * and Jev lost that race almost every time. The model was barely deciding
 * anything; instinct was running the bot.
 *
 * Latency only matters if you start the call at the moment you need the
 * answer. A mob is visible for several seconds before it's close enough to
 * fight, and an ore vein is on screen long before the bot reaches it. So
 * this warms the same caches the decision paths already read, continuously
 * and in the background. By the time the bot actually has to choose, the
 * answer is usually already sitting there and gets used with zero delay.
 *
 * Measured over 690 logs, it mostly was NOT sitting there: of 17,185 warmed
 * answers, 317 were ever used. The answers expired before they were re-asked
 * (a threat lived 1.2 s and was refreshed every 2 s), a quarter of the threat
 * calls were about creepers whose answers nothing reads, ore was re-asked
 * every 8 s for a verdict cached 25 s, and strategy every 12 s for a focus
 * held 30 s. Every refresh below is now derived from the lifetime of the
 * answer it refreshes, and only questions someone reads are asked.
 */

const TICK_MS = 500;

// Refresh a threat answer this often; it stays usable for this plus the
// latency allowance (see threat.js cachedDecision), so there is no gap.
const ENTITY_REFRESH_MS = config.typesafe.threatRefreshMs;
// How long an answer takes to come back, near the top of its range.
const LATENCY_ALLOWANCE_MS = config.typesafe.answerLatencyAllowanceMs;

/**
 * Bound how many requests can be in flight, so a slow API can't pile up
 * thousands of pending promises during a mob swarm — and share the bound out,
 * so a swarm cannot take every slot and starve the strategy and ore
 * questions, which is what happened whenever six mobs were in range.
 */
const MAX_IN_FLIGHT = 6;
const SLOTS = { threat: 4, strategy: 1, ore: 1 };

function slotsInUse(kind) {
  return jevClient.inFlightSubjects(kind === 'threat' ? 'mob:' : kind === 'ore' ? 'ore:' : 'strategy').length;
}

function canSend(kind) {
  if (!config.typesafe.apiKey) return false;
  if (jevClient.inFlightSubjects().length >= MAX_IN_FLIGHT) return false;
  return slotsInUse(kind) < SLOTS[kind];
}

/**
 * Hostiles worth having an opinion about ready: the ones the bot would
 * actually fight (hooks.worthAsking), whose current answer is about to run
 * out, nearest first so the most imminent decision is warmed first.
 */
function threatsToWarm(bot, ctx, hooks) {
  const range = config.behavior.mobDetectionRange;
  const out = [];

  for (const id of Object.keys(bot.entities)) {
    const e = bot.entities[id];
    if (e === bot.entity || !e.isValid) continue;
    const distance = bot.entity.position.distanceTo(e.position);
    if (distance > range) continue;
    if (!hooks.worthAsking(bot, ctx, e, distance)) continue;
    if (!hooks.needsFreshAnswer(ctx, e.id)) continue;
    out.push({ entity: e, distance });
  }
  return out.sort((a, b) => a.distance - b.distance);
}

// Before hooks were passed in: every hostile and every player, minus bosses.
function defaultWorthAsking(bot, ctx, e) {
  return (isHostileMob(e) || isOtherPlayer(bot, e)) && !isBoss(e);
}

/**
 * A question about a mob that has left is a slot held for nothing until the
 * four-second timeout. Let it go.
 */
const ABANDON_RANGE_FACTOR = 1.5;

function abandonStale(bot) {
  const range = config.behavior.mobDetectionRange * ABANDON_RANGE_FACTOR;
  for (const subject of jevClient.inFlightSubjects('mob:')) {
    const e = bot.entities[subject.slice(4)];
    const gone = !e || !e.isValid || bot.entity.position.distanceTo(e.position) > range;
    if (gone) jevClient.abort(subject);
  }
}

/**
 * Build the state BEFORE sending, and skip the subject if that fails.
 *
 * If the builder throws (an entity that vanished between the scan and the
 * read is the realistic case), there is no request and so nothing to clean
 * up — the leak that once froze the whole prefetcher cannot happen.
 */
function safeBuild(build, subject) {
  try {
    return { ok: true, state: build() };
  } catch (err) {
    logger.info('Could not build Jev state — skipping this one', {
      subject,
      error: err.message,
    });
    return { ok: false };
  }
}

function warmThreat(bot, ctx, entity, distance, buildState) {
  const entityId = entity.id;
  const subject = `mob:${entityId}`;
  if (jevClient.pending(subject)) return;

  const built = safeBuild(() => buildState(bot, ctx, entity, distance), subject);
  if (!built.ok) return;
  const { state } = built;

  jevClient.assessMobThreat(state, { subject })
    .then((result) => {
      // Never cache a fallback, and never a coin flip — instinct is better
      // than either (see jevClient.confident).
      if (!jevClient.confident(result)) return;
      ctx.threat.decisions.set(entityId, { decision: result.decision, at: Date.now() });
      ctx.jev.prefetched++;
      logger.decision('Threat decision (prefetched)', {
        input: { mob_type: state.mob_type, distance_blocks: state.distance_blocks },
        decision: result.decision,
        confidence: result.confidence,
        latencyMs: result.latencyMs,
      });
    })
    .catch(() => {});
}

function recordOre(ctx, oreName, held, result, prefetched) {
  if (!jevClient.confident(result)) return;
  ctx.mine.verdicts.set(oreName, { decision: result.decision, at: Date.now(), held });
  ctx.jev.prefetched++;
  logger.decision(prefetched, {
    input: { block_type: oreName, already_held: held },
    decision: result.decision,
    confidence: result.confidence,
    latencyMs: result.latencyMs,
  });
}

/**
 * Which visible ore types need a verdict: none cached, the cached one is
 * about to run out, or what the bot holds of it has changed since — the
 * only input that actually moves the answer (95% of the old re-asks sent
 * the same ore with the same count and got the same verdict back).
 */
function oresDue(bot, ctx, hooks) {
  const now = Date.now();
  const due = [];
  for (const oreName of hooks.visibleOreTypes(bot)) {
    if (jevClient.pending(`ore:${oreName}`)) continue;
    const built = safeBuild(() => hooks.buildOreState(bot, oreName), `ore:${oreName}`);
    if (!built.ok) continue;
    const cached = ctx.mine.verdicts.get(oreName);
    const live = cached && now - cached.at < hooks.oreVerdictTtlMs - LATENCY_ALLOWANCE_MS;
    if (live && cached.held === built.state.already_held) continue;
    due.push({ name: oreName, state: built.state });
  }
  return due;
}

function warmOre(bot, ctx, { name, state }) {
  jevClient.assessResource(state, { subject: `ore:${name}` })
    .then((result) => recordOre(ctx, name, state.already_held, result, 'Resource decision (prefetched)'))
    .catch(() => {});
}

/**
 * Ask Jev what to focus on, on a slow loop — and let the ore verdicts that
 * are due ride along in the same request.
 *
 * Never awaited by anything: the answer steers the scheduler for the next
 * half-minute, so a three-second latency is free. Re-asked just before the
 * director stops trusting the last answer (FOCUS_TTL_MS), or at once when the
 * progression phase changes, because a focus chosen for "needs wood" is no
 * answer for "ready to dig".
 */
const STRATEGY_EARLY_MS = 3 * LATENCY_ALLOWANCE_MS; // strategy's p99 is ~2.8 s

function warmStrategy(bot, ctx, hooks, ores) {
  const built = safeBuild(() => hooks.buildStrategyState(bot, ctx), 'strategy');
  if (!built.ok) return false;

  jevClient.assessStrategy(built.state, { ores })
    .then((result) => {
      if (result.source !== 'jev') return;
      ctx.jev.prefetched++;
      // Kept whatever the confidence: the director applies the same floor
      // itself, and the dashboard shows an ignored focus as ignored.
      ctx.strategy = {
        focus: result.focus,
        risk: result.risk,
        confidence: result.focusConfidence,
        riskConfidence: result.riskConfidence,
        at: Date.now(),
      };
      logger.decision('Strategy', {
        focus: result.focus,
        confidence: result.focusConfidence,
        risk: result.risk,
        latencyMs: result.latencyMs,
        ...(ores.length ? { withOres: ores.map((o) => o.name) } : {}),
      });
      for (const { name, state } of ores) {
        const answer = result.ores?.[name];
        if (answer) {
          recordOre(ctx, name, state.already_held, { ...answer, source: 'jev', latencyMs: result.latencyMs }, 'Resource decision (with strategy)');
        }
      }
    })
    .catch(() => {});
  return true;
}

/**
 * How often to LOOK for ore types, as opposed to how often to re-ask about
 * them.
 *
 * These were the same thing and should never have been: the tick runs twice a
 * second and called visibleOreTypes on every one of them, which is a full
 * findBlocks sweep of the surrounding sections — the single most expensive
 * call the bot makes, and `mine` is already doing its own copy of it on its
 * own throttle. The lag meter caught the consequence directly: "Event loop
 * stalled — the bot could not react {forMs: 1979, droppedTicks: 40}".
 */
const ORE_SCAN_INTERVAL_MS = 4000;
const USAGE_LOG_MS = 60000;

/**
 * Start the background warmer.
 *
 * `hooks` supplies the state builders and the rules so this module doesn't
 * duplicate the knowledge of what Jev needs to be told, or of which answers
 * anyone reads — the decision sites remain the single source of truth.
 */
function startPrefetch(bot, ctx, hooks) {
  const rules = {
    worthAsking: defaultWorthAsking,
    needsFreshAnswer: (c, id) => {
      const cached = c.threat.decisions.get(id);
      return !cached || Date.now() - cached.at >= ENTITY_REFRESH_MS;
    },
    phaseOf: () => null,
    oreVerdictTtlMs: 25000,
    focusTtlMs: 30000,
    ...hooks,
  };
  let lastStrategyAt = 0;
  let lastStrategyPhase = null;
  let lastOreScanAt = 0;
  let lastUsageLogAt = Date.now();

  const timer = setInterval(() => {
    if (!ctx.connected || ctx.paused || !bot.entity) return;
    abandonStale(bot);

    for (const { entity, distance } of threatsToWarm(bot, ctx, rules)) {
      if (!canSend('threat')) break;
      warmThreat(bot, ctx, entity, distance, rules.buildThreatState);
    }

    const now = Date.now();
    const scanOres = now - lastOreScanAt >= ORE_SCAN_INTERVAL_MS;
    const ores = scanOres ? oresDue(bot, ctx, rules) : [];
    if (scanOres) lastOreScanAt = now;

    // The strategic question, on the focus's own clock or on a phase change.
    let phase = null;
    try { phase = rules.phaseOf(bot, ctx); } catch { phase = null; }
    const strategyDue = now - lastStrategyAt >= rules.focusTtlMs - STRATEGY_EARLY_MS
      || (phase !== null && phase !== lastStrategyPhase);
    let riding = [];
    if (rules.buildStrategyState && strategyDue && canSend('strategy') && !jevClient.pending('strategy')) {
      riding = ores.slice(0, jevClient.MAX_ORES_PER_STRATEGY);
      if (warmStrategy(bot, ctx, rules, riding)) {
        lastStrategyAt = now;
        lastStrategyPhase = phase;
      }
    }

    // Ore that could not ride along — more due than fit, or no strategy call
    // this tick — goes on its own, one slot at a time.
    for (const ore of ores.slice(riding.length)) {
      if (!canSend('ore')) break;
      warmOre(bot, ctx, ore);
    }

    if (now - lastUsageLogAt >= USAGE_LOG_MS) {
      lastUsageLogAt = now;
      logger.info('Jev usage', {
        decidedByJev: ctx.jev.usedCached,
        byInstinct: ctx.jev.usedInstinct,
        warmed: ctx.jev.prefetched,
        calls: jevClient.snapshot(),
      });
    }
  }, TICK_MS);

  if (timer.unref) timer.unref();
  return () => clearInterval(timer);
}

module.exports = {
  startPrefetch,
  ENTITY_REFRESH_MS,
  SLOTS,
  MAX_IN_FLIGHT,
  // For the tests.
  threatsToWarm, canSend, oresDue, abandonStale,
};
