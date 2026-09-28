const { TypeSafeClient, choice } = require('@typesafe-ai/sdk');
const config = require('./config');
const logger = require('./logger');

/**
 * Wrapper around TypeSafe's Jev — the typed-decision ("System One") model.
 *
 * Jev is only asked the genuinely judgement-shaped questions: fight/flee/
 * ignore, and mine/skip. Everything deterministic (pathing, crafting order,
 * combat tactics once a fight is chosen) is plain code, because a model call
 * would add latency and buy nothing.
 *
 * Every call fails safe: if the API is down, slow, or misconfigured we fall
 * back to a conservative hardcoded default rather than crashing the bot.
 */

/**
 * Warm sockets.
 *
 * The SDK uses global fetch, whose pool keeps an idle connection for about
 * four seconds. A quiet bot asks something every twelve, so most of those
 * calls paid a fresh TCP and TLS handshake before Jev saw a byte — the likely
 * source of a 2.8 s p99 on a model whose median is 0.3 s. An explicit pool
 * that keeps sockets for a minute makes every call after the first a warm one.
 */
function keepAliveFetch() {
  try {
    const { Agent, fetch } = require('undici');
    const dispatcher = new Agent({
      keepAliveTimeout: 60000,
      keepAliveMaxTimeout: 120000,
      connections: 8,
      pipelining: 1,
    });
    return (url, init = {}) => fetch(url, { ...init, dispatcher });
  } catch {
    return undefined; // undici missing: the SDK's own fetch still works
  }
}

// Retries are deliberately disabled. The SDK's default retry policy turns a
// single slow call into multi-second blocking — we measured 5.26s for one
// combat decision, during which the bot just stands there getting hit. For a
// reflex model a late answer is worse than no answer, so: one attempt, short
// timeout, fall back to a hardcoded default.
let client = config.typesafe.apiKey
  ? new TypeSafeClient({
    apiKey: config.typesafe.apiKey,
    timeout: config.typesafe.timeoutMs,
    retry: { maxRetries: 0 },
    fetch: keepAliveFetch(),
  })
  : null;

if (!client) {
  logger.warn('TYPESAFE_API_KEY not set — all Jev calls will use safe fallbacks');
}

/**
 * An answer below this is a coin flip, and a coin flip is worse than the
 * consistent hardcoded rule. The director has always applied it to strategy;
 * threat and ore verdicts were cached and acted on at any confidence — 29% of
 * ore verdicts in the logs were under it ("iron_ore skip, 0.01").
 */
const MIN_CONFIDENCE = config.typesafe.minConfidence;

function confident(result) {
  return result.source === 'jev' && (result.confidence ?? 0) >= MIN_CONFIDENCE;
}

// --- measurement ---------------------------------------------------------

// A failure within this long of an event-loop stall is the computer, not Jev.
const STALL_BLAME_MS = 6000;
function duringStall() {
  return require('./lag').msSinceStall() < STALL_BLAME_MS;
}

// Requests on the wire, by subject — see ask() below.
const inFlight = new Map();

const LATENCY_SAMPLES = 200;
const stats = {};

function statFor(kind) {
  if (!stats[kind]) {
    stats[kind] = {
      calls: 0, ok: 0, failed: 0, failedDuringStall: 0, aborted: 0, samples: [],
    };
  }
  return stats[kind];
}

function noteLatency(kind, ms) {
  const s = statFor(kind);
  s.samples.push(ms);
  if (s.samples.length > LATENCY_SAMPLES) s.samples.shift();
}

function percentile(sorted, p) {
  if (!sorted.length) return null;
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
}

/** Per kind: calls, answers, failures, and p50/p90 latency of recent calls. */
function snapshot() {
  const out = {};
  for (const [kind, s] of Object.entries(stats)) {
    const sorted = [...s.samples].sort((a, b) => a - b);
    out[kind] = {
      calls: s.calls,
      ok: s.ok,
      failed: s.failed,
      failedDuringStall: s.failedDuringStall,
      aborted: s.aborted,
      inFlight: [...inFlight.values()].filter((f) => f.kind === kind).length,
      p50: percentile(sorted, 50),
      p90: percentile(sorted, 90),
    };
  }
  return out;
}

// --- one request per subject ---------------------------------------------

/**
 * Requests in flight, by subject ("mob:123", "ore:coal_ore", "strategy").
 *
 * Call sites used to send their own request even while the prefetcher's was
 * already on the wire about the same mob, so a decision that could have been
 * the first answer's arrival became a second, slower round trip. Now asking
 * about a subject that is already being asked about returns the same promise.
 * (The map itself is declared up top, beside the stats that count it.)
 */

function isAbort(err) {
  return err?.name === 'AbortError' || err?.constructor?.name === 'APIUserAbortError';
}

function ask(kind, subject, run) {
  if (subject && inFlight.has(subject)) return inFlight.get(subject).promise;
  const controller = new AbortController();
  const startedAt = Date.now();
  statFor(kind).calls++;

  const promise = (async () => {
    if (!client) return { source: 'fallback' };
    try {
      const result = await run(controller.signal);
      const latencyMs = Date.now() - startedAt;
      noteLatency(kind, latencyMs);
      statFor(kind).ok++;
      return { ...result, source: 'jev', latencyMs };
    } catch (err) {
      if (isAbort(err) || controller.signal.aborted) {
        statFor(kind).aborted++;
        return { source: 'aborted' };
      }
      statFor(kind).failed++;
      if (duringStall()) statFor(kind).failedDuringStall++;
      throw err;
    } finally {
      if (subject && inFlight.get(subject)?.controller === controller) inFlight.delete(subject);
    }
  })();

  if (subject) inFlight.set(subject, { kind, controller, promise, startedAt });
  return promise;
}

/** Is a request about this subject on the wire right now? */
function pending(subject) {
  return inFlight.has(subject);
}

/** Give up on a question whose answer no longer matters (the mob is gone). */
function abort(subject) {
  const entry = inFlight.get(subject);
  if (!entry) return false;
  entry.controller.abort();
  inFlight.delete(subject);
  return true;
}

function inFlightSubjects(prefix = '') {
  return [...inFlight.keys()].filter((k) => k.startsWith(prefix));
}

// --- the questions --------------------------------------------------------

const THREAT_QUESTION = () => choice(
  'A hostile is near the bot. Considering its health, hunger, weapon, armour, '
  + 'and how many hostiles are around, should it fight, flee, or ignore?',
  {
    fight: 'Engage and attack — the bot can realistically win this',
    flee: 'Disengage and get to safety — losing or too risky',
    ignore: 'Not an actual threat; carry on with what it was doing',
  },
);

const RESOURCE_QUESTION = (subject = 'this block') => choice(
  `The bot can see ${subject} while going about its work. Given what it already `
  + 'has and what the block is worth, should it stop to mine it or skip it?',
  {
    mine: 'Worth the detour — mine it',
    skip: 'Not worth stopping for; keep going',
  },
);

async function assessMobThreat(state, { subject = null } = {}) {
  const fallback = { decision: 'flee', confidence: 0, source: 'fallback' };
  try {
    const result = await ask('threat', subject, (signal) => client.systemOne({
      state,
      questions: { action: THREAT_QUESTION() },
    }, { signal }).then((r) => ({
      decision: r.answers.action.choice,
      confidence: r.answers.action.confidence,
    })));
    return result.source === 'jev' ? result : { ...fallback, source: result.source };
  } catch (err) {
    // warn, not error: a slow or failed call is expected and survivable — every
    // caller falls back to instinct — and an ERROR line for it buries real faults.
    logger.warn('Jev threat call failed — defaulting to flee', { error: err.message, duringStall: duringStall() });
    return fallback;
  }
}

async function assessResource(state, { subject = null } = {}) {
  const fallback = { decision: 'skip', confidence: 0, source: 'fallback' };
  try {
    const result = await ask('ore', subject, (signal) => client.systemOne({
      state,
      questions: { action: RESOURCE_QUESTION() },
    }, { signal }).then((r) => ({
      decision: r.answers.action.choice,
      confidence: r.answers.action.confidence,
    })));
    return result.source === 'jev' ? result : { ...fallback, source: result.source };
  } catch (err) {
    // warn, not error — see assessMobThreat.
    logger.warn('Jev resource call failed — defaulting to skip', { error: err.message, duringStall: duringStall() });
    return fallback;
  }
}

/**
 * Ask Jev what the bot should be FOCUSED on.
 *
 * This is the question the model is best suited to and was never being asked.
 *
 * Its weakness is latency — 0.3 to 3.6 seconds measured — which is why every
 * combat call has to race a deadline and usually loses to instinct. But that
 * weakness only exists for reflex decisions. "What should I be working on for
 * the next minute?" has no deadline at all: the answer is just as good three
 * seconds late, and it is exactly the kind of judgement that needs many
 * factors weighed at once — time of day, hunger, what tier the tools are,
 * how far from the ore band, whether there are hostiles about.
 *
 * Several questions in ONE call, because a call costs the same whether it
 * carries one question or four — asking them separately was multiplying the
 * latency for no reason. That now includes the ore verdicts that are due: up
 * to MAX_ORES_PER_STRATEGY of them ride along as `ore_<name>` questions, with
 * each ore's own state under `ores.<name>`, instead of a request each.
 */
const MAX_ORES_PER_STRATEGY = 3;

async function assessStrategy(state, { ores = [] } = {}) {
  const fallback = { source: 'fallback', ores: {} };
  const riding = ores.slice(0, MAX_ORES_PER_STRATEGY);
  try {
    const result = await ask('strategy', 'strategy', (signal) => {
      const questions = {
        focus: choice(
          'Given everything about the bot right now, what single thing should it '
          + 'spend the next minute on to make the most progress toward a full '
          + 'diamond kit without dying? Its current phase and what that phase still '
          + 'needs are in the state.',
          {
            food: 'Hunt or forage — it is short of food and that will stall everything',
            wood: 'Chop trees — it needs logs for tools, handles and charcoal',
            stone: 'Mine stone — it needs cobblestone for tools and a furnace',
            tools: 'Craft or upgrade equipment with what it already carries',
            descend: 'Head down toward the ore band; it is equipped enough',
            ore: 'Mine the ore it can already see or knows about',
            shelter: 'Get somewhere safe — night, low health, or too many hostiles',
          },
        ),
        risk: choice(
          'How dangerous is the bot\'s current situation?',
          {
            safe: 'Nothing threatening — work freely',
            wary: 'Something is around; keep working but stay ready',
            danger: 'It should deal with the threat or retreat before anything else',
          },
        ),
      };
      const oreStates = {};
      for (const { name, state: oreState } of riding) {
        questions[`ore_${name}`] = RESOURCE_QUESTION(`${name.replace(/_/g, ' ')} (details under ores.${name})`);
        oreStates[name] = oreState;
      }
      const body = riding.length ? { ...state, ores: oreStates } : state;
      return client.systemOne({ state: body, questions }, { signal }).then((r) => {
        const oreAnswers = {};
        for (const { name } of riding) {
          const a = r.answers[`ore_${name}`];
          if (a) oreAnswers[name] = { decision: a.choice, confidence: a.confidence };
        }
        return {
          focus: r.answers.focus.choice,
          focusConfidence: r.answers.focus.confidence,
          risk: r.answers.risk.choice,
          riskConfidence: r.answers.risk.confidence,
          ores: oreAnswers,
        };
      });
    });
    return result.source === 'jev' ? result : fallback;
  } catch (err) {
    // warn, like the other two kinds: the same failure deserves the same level.
    logger.warn('Jev strategy call failed — carrying on with hardcoded priorities', {
      error: err.message,
      duringStall: duringStall(),
    });
    return fallback;
  }
}

module.exports = {
  assessMobThreat,
  assessResource,
  assessStrategy,
  MAX_ORES_PER_STRATEGY,
  MIN_CONFIDENCE,
  confident,
  pending,
  abort,
  inFlightSubjects,
  snapshot,
  // For the tests: swap the network for a stub. Production never calls it.
  _setClientForTests(stub) {
    client = stub;
    inFlight.clear();
    for (const key of Object.keys(stats)) delete stats[key];
  },
};
