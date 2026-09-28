const logger = require('./logger');
const { Task, sleep, isInterruption } = require('./task');

/**
 * Priority scheduler — the single owner of the bot's body.
 *
 * Exactly one behavior runs at a time. Each behavior does ONE discrete unit
 * of work (chop one tree, craft one item, resolve one fight) and returns, so
 * priorities get re-evaluated constantly rather than a long-running loop
 * hogging the bot.
 *
 * A separate fast supervisor watches only the cheap, urgent checks (am I
 * drowning / being attacked / starving) and preempts the running behavior
 * when something more important comes up. Expensive checks (scanning for
 * trees or ore) belong to low-priority behaviors that never need to preempt
 * anything, so they're skipped by the supervisor entirely.
 */

// Reaction speed. These three numbers are the floor on how fast the bot can
// respond to anything, and they compound: worst case, a mob appears just
// after a supervisor tick, the running behavior finishes, and the loop waits
// out the gap before re-picking. At the old values that was ~320ms of pure
// scheduling delay before a single swing — on top of any decision cost.
//
// Minecraft runs at 20 ticks/second (50ms), so there is no value in polling
// faster than a tick; these sit just above it.
const SUPERVISOR_INTERVAL_MS = 60;
const IDLE_POLL_MS = 75;
const MIN_BEHAVIOR_GAP_MS = 25; // keeps a failing behavior from hot-looping

// Behaviors at or above this priority get checked by the fast supervisor and
// are allowed to interrupt whatever is currently running.
const INTERRUPT_PRIORITY_FLOOR = 50;

// A behavior that keeps getting picked and then immediately returning without
// doing anything is starving everything below it. Behaviors report this by
// returning false from run(); anything else counts as real work. (Timing
// alone is a bad proxy — equipping three armour pieces is fast but real.)
const NOOP_STRIKES = 3;
const NOOP_BACKOFF_BASE_MS = 500;
const NOOP_BACKOFF_MAX_MS = 8000;

// The lowest-priority behavior, which must always be available to run.
const FALLBACK_BEHAVIOR = 'idle';

// If nothing at all wants the wheel for this long, something is wrong with
// the schedule rather than with the world. Standing still is never correct.
const AFK_WARN_MS = 5000;

/**
 * Nothing may hold the bot for longer than this, ever.
 *
 * "No behavior wants to run — forMs 52341" was misleading: nothing was
 * blocked, a single behavior had simply not RETURNED for 52 seconds, so the
 * loop never got back round to pick anything. A creeper walked up and killed
 * a bot that was, from the outside, standing perfectly still.
 *
 * The specific cause was a fight against an unreachable target and is fixed
 * where it belongs, but this is the class of bug that keeps recurring — a
 * pathfinding leg, a craft, a furnace wait, a fight — and every instance
 * looks identical from the outside. So the scheduler now enforces the
 * invariant directly instead of trusting every behavior to police itself.
 *
 * Generous on purpose: legitimate units of work (walking to a distant
 * crafting table, waiting out a furnace) take tens of seconds. This is not a
 * timeout, it is a deadlock breaker.
 */
const MAX_BEHAVIOR_MS = 60000;
// `shelter` and `bed` genuinely occupy the bot for a whole Minecraft night,
// and that is the entire point of them.
const LONG_RUNNING = new Set(['shelter', 'bed']);
/** How long after an ignored abort before we call the bot frozen and say so. */
const STUCK_AFTER_ABORT_MS = 15000;

/**
 * Being cut off by the deadlock breaker IS the behavior's fault.
 *
 * The cut-off is delivered as an ordinary abort, and every abort reads as an
 * interruption — "not your fault, no penalty". So a behavior that had just
 * wedged for a full minute was eligible again on the very next pick, and
 * usually won it: the logs show gatherStone, gear and unstick each cut off
 * twice back to back, two minutes apiece of a bot achieving nothing. Nothing
 * about the world had changed, so the second minute went exactly like the
 * first.
 *
 * Every behavior gets the cooldown, urgent ones included. None of them
 * legitimately needs sixty unbroken seconds (the ones that do are LONG_RUNNING
 * and never cut off), so one that took it is wedged, and re-running a wedged
 * behavior just wedges it again. The reflex layer runs on physicsTick
 * regardless, so the hazard, drowning and void escapes do not depend on this.
 */
const OVERRUN_REASON = 'exceeded time budget';
const OVERRUN_COOLDOWN_MS = 15000;

/**
 * Stickiness, so the bot finishes what it starts.
 *
 * Every behavior does one small unit of work and returns, at which point the
 * whole list is re-evaluated. Behaviors sitting at adjacent priorities —
 * gatherStone 28, tidy 30, hunt 31 — therefore steal the wheel from each
 * other constantly, and from the outside the bot looks like it is doing
 * random things and abandoning them: chop, wander off, tidy, come back,
 * chop again.
 *
 * So the behavior that just did real work gets a small bonus when the next
 * choice is made. It is deliberately small: anything genuinely more
 * important (combat, drowning, being stuck) outranks it easily, and the
 * bonus is dropped the moment that behavior stops being productive.
 */
const COMMITMENT_BONUS = 6;
const COMMITMENT_WINDOW_MS = 10000;

/**
 * Behaviors that serve each strategic focus Jev can pick.
 *
 * This is where the model actually gets to run the bot. Everything else it
 * is asked is a reflex question it usually loses on latency; "what should we
 * be working on for the next minute" has no deadline, so a two-second answer
 * is as good as an instant one — and it is the judgement that most needs
 * many factors weighed together.
 */
const FOCUS_BEHAVIORS = {
  food: new Set(['hunt', 'huntUrgent', 'forage', 'forageTopUp', 'fetchCooked']),
  wood: new Set(['wood']),
  stone: new Set(['gatherStone']),
  tools: new Set(['gear', 'smelt']),
  descend: new Set(['goDeep', 'resupply']),
  ore: new Set(['mine', 'stripMine']),
  shelter: new Set(['shelter', 'bed']),
};

/**
 * How much a Jev focus is worth in priority terms.
 *
 * Deliberately small — the same size as the commitment bonus. It is enough
 * to break a tie between neighbouring priorities (gatherStone 28 against
 * mine 25) but nowhere near enough to let a strategic preference outrank
 * drowning, being on fire, or a creeper. The model advises; the safety
 * ordering is not up for negotiation.
 */
const FOCUS_BONUS = 5;
const FOCUS_TTL_MS = 30000;
// One confidence floor for every Jev answer — see config.typesafe.minConfidence.
const FOCUS_MIN_CONFIDENCE = require('./config').typesafe.minConfidence;

function focusBonusFor(ctx, behavior) {
  const strategy = ctx.strategy;
  if (!strategy || !strategy.focus) return 0;
  if (Date.now() - strategy.at > FOCUS_TTL_MS) return 0;
  // A coin-flip answer is worse than the consistent hardcoded ordering.
  if ((strategy.confidence ?? 0) < FOCUS_MIN_CONFIDENCE) return 0;
  return FOCUS_BEHAVIORS[strategy.focus]?.has(behavior.name) ? FOCUS_BONUS : 0;
}

/**
 * Jev's read on the danger, when it is fresh and confident enough to use.
 *
 * Asked on every strategy call and read by nothing but the dashboards — the
 * "risk" answer was the one piece of judgement the bot threw away. It is used
 * only in the cautious direction (see bailHealth and nightComing): a "danger"
 * makes the bot leave fights and dig in sooner, never later.
 */
function currentRisk(ctx) {
  const s = ctx?.strategy;
  if (!s?.risk) return null;
  if (Date.now() - s.at > FOCUS_TTL_MS) return null;
  if ((s.riskConfidence ?? s.confidence ?? 0) < FOCUS_MIN_CONFIDENCE) return null;
  return s.risk;
}

function effectivePriority(ctx, behavior) {
  // THE URGENT TIER IS ORDERED BY RAW PRIORITY, and the bonuses were
  // reordering it.
  //
  // Both bonuses exist for ROUTINE work: gatherStone at 28 and tidy at 30
  // taking the wheel from each other on every pass. Applied to the urgent tier
  // they did something else entirely. `defend` (94) that had just won a fight
  // carried a commitment bonus to 100 into the next one, ahead of escapeHazard
  // (97) and escapeDrowning (95). A Jev "shelter" focus lifted bed (92) to 97.
  // Being on fire, out of air, or hit is not a tie to be broken by what
  // the bot was doing a moment ago, so nothing at or above the interrupt floor
  // gets either bonus.
  if (behavior.priority >= INTERRUPT_PRIORITY_FLOOR) return behavior.priority;

  let priority = behavior.priority + focusBonusFor(ctx, behavior);

  const committed = ctx.commitment;
  if (committed
    && committed.name === behavior.name
    && Date.now() - committed.at <= COMMITMENT_WINDOW_MS) {
    priority += COMMITMENT_BONUS;
  }
  return priority;
}

/**
 * What the last decision looked like, for the web dashboard's "brain" panel.
 *
 * Only what pickBehavior already asked is recorded — the behaviors above the
 * winner that said no, and the winner. Asking the rest just to fill a chart
 * would mean extra shouldRun calls, and some of those log or remember things.
 */
const RECENT_DECISIONS = 50;

function noteDecision(ctx, mode, asked, chosen) {
  const board = ctx.decisionBoard ?? (ctx.decisionBoard = { checks: 0, recent: [] });
  board.checks++;
  board[mode] = { at: Date.now(), asked, chosen: chosen?.name ?? null };
  if (chosen) {
    // Enough for the dashboard's decision stream to say why this one won:
    // who above it said no, and who the phase held back.
    const said = (verdict) => asked.filter((a) => a.verdict === verdict).map((a) => a.name);
    board.recent.push({
      at: Date.now(),
      mode,
      chosen: chosen.name,
      priority: chosen.priority,
      no: said('no'),
      phase: said('phase'),
      backedOff: said('backed-off'),
    });
    if (board.recent.length > RECENT_DECISIONS) board.recent.shift();
  }
}

function pickBehavior(bot, ctx, behaviors, { interruptiveOnly = false, above = null } = {}) {
  const now = Date.now();
  const asked = [];
  const mode = interruptiveOnly ? 'preempt' : 'pick';
  const decide = (chosen) => {
    noteDecision(ctx, mode, asked, chosen);
    return chosen;
  };

  // Re-sort by effective priority so the committed behavior — and whatever
  // Jev has asked us to focus on — is considered in the right place, rather
  // than only being preferred on exact ties.
  //
  // But NOT when looking for something to preempt with. The supervisor
  // compares RAW priorities, and walking the effective order and then
  // comparing raw is how the running behavior hid everything behind it: a
  // committed `defend` came first in the sort, wanted to run, failed its own
  // `94 > 94` test, and the lava or drowning check below it in the sort was
  // never asked. Preemption walks the raw order, which is the order
  // `behaviors` already arrives in.
  const ordered = (!interruptiveOnly && (ctx.commitment || ctx.strategy))
    ? [...behaviors].sort((a, b) => effectivePriority(ctx, b) - effectivePriority(ctx, a))
    : behaviors;

  for (const behavior of ordered) {
    // Nothing at or below the running behavior's priority can preempt it, and
    // the walk is in raw order here, so the rest of the list cannot either.
    // Stopping saves the supervisor asking every lower behavior's canInterrupt
    // sixteen times a second while a fight or an escape holds the wheel.
    if (interruptiveOnly && above !== null && behavior.priority <= above) break;

    // In preemption mode, only urgent behaviors are considered — either by
    // clearing the priority floor, or by explicitly opting in with
    // canInterrupt (which still can't displace anything above its own
    // priority, so it stays safe).
    const mayPreempt = behavior.priority >= INTERRUPT_PRIORITY_FLOOR || !!behavior.canInterrupt;
    if (interruptiveOnly && !mayPreempt) continue;

    // Out of phase — see src/progression.js. Checked before shouldRun, so a
    // gated behavior costs no scan, and before the sort's bonuses can matter:
    // a Jev focus or a commitment reorders only what the phase allows.
    if (behavior.phaseGate && !behavior.phaseGate(bot, ctx)) {
      asked.push({ name: behavior.name, priority: behavior.priority, verdict: 'phase' });
      continue;
    }

    const penalty = ctx.backoff.get(behavior.name);
    if (penalty && penalty.until > now) {
      asked.push({
        name: behavior.name, priority: behavior.priority, verdict: 'backed-off', backoffMs: penalty.until - now,
      });
      continue;
    }

    let wants = false;
    let threw = false;
    try {
      // A behavior can set a higher bar for yanking the bot away from what
      // it's already doing than for being chosen when idle. Without this, a
      // mob wandering past at the edge of detection range cancels an
      // in-progress dig — and the bot then restarts that same block from
      // scratch, which is pure wasted motion.
      wants = interruptiveOnly && behavior.canInterrupt
        ? behavior.canInterrupt(bot, ctx)
        : behavior.shouldRun(bot, ctx);
    } catch (err) {
      threw = true;
      logger.warn('Behavior shouldRun threw', { behavior: behavior.name, error: err.message });
    }
    asked.push({
      name: behavior.name,
      priority: behavior.priority,
      effective: effectivePriority(ctx, behavior),
      verdict: threw ? 'threw' : (wants ? 'yes' : 'no'),
    });
    if (wants) return decide(behavior);
  }
  return decide(null);
}

/**
 * Behaviors that genuinely accomplish things without moving.
 *
 * The stuck-detector is position-based, which mis-fires on productive work:
 * mining a vein is nine ores from one spot, and it read as "hasn't moved in
 * 25 seconds" and pillared the bot ten blocks out of its own mineshaft
 * mid-dig.
 *
 * But this list has to be exact, not "anything that reported success".
 * Crediting every behavior reset the stuck-watch on each pass, so a bot
 * walled in at one coordinate — with `explore` cheerfully reporting it had
 * explored — could never trigger `unstick` at all. Movement behaviors prove
 * progress by moving; only these prove it by achieving something.
 */
const PRODUCTIVE_WHILE_STATIONARY = new Set([
  'mine', 'valuables', 'gatherStone', 'goDeep', 'stripMine', 'wood', 'gear', 'smelt',
  'tidy', 'shelter', 'bed',
]);

function recordRun(ctx, bot, name, didWork, interrupted, overran = false) {
  if (overran && name !== FALLBACK_BEHAVIOR) {
    if (ctx.commitment?.name === name) ctx.commitment = null;
    ctx.backoff.set(name, { strikes: NOOP_STRIKES, until: Date.now() + OVERRUN_COOLDOWN_MS });
    logger.info('Behavior wedged — benching it before it can take the bot again', {
      behavior: name,
      forMs: OVERRUN_COOLDOWN_MS,
    });
    return;
  }

  if (didWork && !interrupted) {
    // Genuinely productive: keep the wheel for a bit so the bot finishes
    // what it started instead of being pulled away by a neighbour priority.
    ctx.commitment = { name, at: Date.now() };
  } else if (ctx.commitment?.name === name) {
    // Stopped achieving anything — drop the claim immediately.
    ctx.commitment = null;
  }

  if (didWork) {
    ctx.backoff.delete(name);

    // Being PREEMPTED is not progress, and crediting it created a perfect
    // deadlock: after 25 motionless seconds the supervisor would abort the
    // running behavior in favour of `unstick`, the abort counted as work
    // (an interruption isn't the behavior's fault), that reset the
    // stuck-watch, `unstick.shouldRun` went false again, and the same
    // behavior was re-picked. Observed live: the bot spent minutes at one
    // coordinate restarting the same tunnel, with `unstick` preempting it
    // over and over and never once getting to run.
    if (!interrupted && bot.entity && PRODUCTIVE_WHILE_STATIONARY.has(name)) {
      ctx.stuck.anchor = bot.entity.position.clone();
      ctx.stuck.since = Date.now();
    }
    return;
  }

  // The fallback is never penalised. If `idle` gets backed off along with
  // everything else, pickBehavior returns null and the bot genuinely stands
  // still doing nothing — which is the AFK the whole design is meant to
  // prevent. Its job is to keep trying to move; failing at that is not a
  // reason to stop it trying.
  if (name === FALLBACK_BEHAVIOR) return;

  const entry = ctx.backoff.get(name) || { strikes: 0, until: 0 };
  entry.strikes += 1;
  if (entry.strikes >= NOOP_STRIKES) {
    const wait = Math.min(
      NOOP_BACKOFF_BASE_MS * 2 ** (entry.strikes - NOOP_STRIKES),
      NOOP_BACKOFF_MAX_MS,
    );
    entry.until = Date.now() + wait;
    logger.info('Behavior kept doing nothing — backing it off', { behavior: name, forMs: wait });
  }
  ctx.backoff.set(name, entry);
}

function startDirector(bot, ctx, behaviorList) {
  // Highest priority first, so the first match always wins.
  const behaviors = [...behaviorList].sort((a, b) => b.priority - a.priority);
  let running = true;
  let lastHungWarnAt = 0;

  /**
   * Is something more urgent than the running behavior waiting for the wheel?
   * If so, take it.
   *
   * The supervisor below asks this every 60ms. It is ALSO the reflex layer's
   * only lever (see src/layers/reflex.js), and that is the point of pulling it
   * out into its own function: a trip-wire on the physics tick now hurries
   * this same arbitration instead of aborting whatever happens to be running.
   * The reflex used to abort blindly, and the task it hit most often was the
   * owner of the very situation it had noticed — escapeHazard restarted every
   * 50ms in lava, a melee fight torn down twice a second because the standoff
   * sits inside the three-block trip-wire. Asking "does anything outrank what
   * is running?" answers no in exactly those cases, and yes in the ones the
   * reflex exists for.
   */
  const preemptIfOutranked = (why = null) => {
    if (!running || !ctx.connected || !ctx.currentTask) return false;
    // Already winding down (preempted, or cut off by the deadlock breaker).
    // abort() would be a no-op, so the scan would buy nothing.
    if (ctx.currentTask.aborted) return false;

    // Preemption compares RAW priorities on purpose. The commitment bonus is
    // for choosing what to start next; it must never let a routine task hold
    // the bot while something urgent is waiting.
    const contender = pickBehavior(bot, ctx, behaviors, {
      interruptiveOnly: true, above: ctx.currentPriority,
    });
    if (!contender || contender.priority <= ctx.currentPriority) return false;

    logger.info('Preempting behavior', {
      running: ctx.currentBehavior,
      preemptedBy: contender.name,
      ...(why ? { noticedBy: why } : {}),
    });
    ctx.currentTask.abort(`preempted by ${contender.name}`);
    return true;
  };
  ctx.requestPreemptionCheck = preemptIfOutranked;

  const supervisor = setInterval(() => {
    if (!running || !ctx.connected || !ctx.currentTask) return;
    // Deadlock breaker — see MAX_BEHAVIOR_MS. Checked before anything else,
    // because a behavior that has stopped returning cannot be outranked: the
    // loop is not running to compare priorities in the first place.
    const overrunning = ctx.currentBehavior
      && !LONG_RUNNING.has(ctx.currentBehavior)
      && ctx.currentStartedAt
      && Date.now() - ctx.currentStartedAt > MAX_BEHAVIOR_MS;

    if (overrunning && !ctx.currentTask.aborted) {
      logger.warn('Behavior ran too long — cutting it off', {
        behavior: ctx.currentBehavior,
        forMs: Date.now() - ctx.currentStartedAt,
      });
      ctx.currentTask.abort(OVERRUN_REASON);
      return;
    }

    // Aborting is BEST EFFORT, and it is worth saying so out loud when it
    // fails.
    //
    // abort() only frees a behavior that is waiting on something abortable —
    // sleep(ms, task), a dig with stopDigging registered, a withDeadline
    // race. A promise that simply never settles ignores it completely, and
    // the bot stays frozen with the task merely *marked* aborted. The
    // original check would then go quiet, because it requires !aborted, and
    // a hung bot would look exactly like a working one again.
    //
    // This is precisely the shape of the 52-second freeze that killed it, so
    // it gets its own alarm rather than silence.
    if (overrunning
      && ctx.currentTask.aborted
      && Date.now() - ctx.currentStartedAt > MAX_BEHAVIOR_MS + STUCK_AFTER_ABORT_MS
      && Date.now() - lastHungWarnAt > STUCK_AFTER_ABORT_MS) {
      lastHungWarnAt = Date.now();
      logger.error('Behavior is IGNORING its abort — the bot is frozen', {
        behavior: ctx.currentBehavior,
        forMs: Date.now() - ctx.currentStartedAt,
        meaning: 'it is awaiting something that cannot be cancelled',
      });
    }

    // Only the first attempt is ever announced: preemptIfOutranked skips a task
    // that is already aborted, so a behavior stuck in a long uninterruptible
    // operation no longer produces a preempt line every tick until it ends.
    preemptIfOutranked();
  }, SUPERVISOR_INTERVAL_MS);

  let lastPickedAt = Date.now();

  const loop = (async () => {
    while (running) {
      if (!ctx.connected) {
        await sleep(IDLE_POLL_MS);
        continue;
      }

      const behavior = pickBehavior(bot, ctx, behaviors);
      if (!behavior) {
        // Being DEAD is not being idle.
        //
        // Every behavior is gated on bot.health > 0, so between the killing
        // blow and the respawn packet nothing can be selected — correctly.
        // Reporting that as "bot is idle for 30 seconds" sent me hunting a
        // scheduler bug that was not there, twice. A corpse has nothing to
        // do; keep the clock still until it is breathing again.
        if (!bot.entity || bot.health <= 0) {
          ctx.currentBehavior = 'dead';
          lastPickedAt = Date.now();
          await sleep(IDLE_POLL_MS);
          continue;
        }

        // Nor is being told to stand still. `stop` in chat, or a `come` walk
        // that owns the body, makes every behavior decline on purpose — and
        // that was reported every five seconds, for as long as it lasted, as
        // "No behavior wants to run — bot is idle", the alarm reserved for a
        // broken schedule.
        if (ctx.paused || ctx.manualTask) {
          ctx.currentBehavior = ctx.manualTask ? 'manual' : 'paused';
          lastPickedAt = Date.now();
          await sleep(IDLE_POLL_MS);
          continue;
        }

        // Nothing wants to run. With the fallback exempt from backoff this
        // should be impossible, so say so loudly rather than quietly
        // standing there — silent AFK is exactly the failure being hunted.
        ctx.currentBehavior = 'nothing';
        if (Date.now() - lastPickedAt > AFK_WARN_MS) {
          logger.warn('No behavior wants to run — bot is idle', {
            forMs: Date.now() - lastPickedAt,
            backedOff: [...ctx.backoff.keys()],
          });
          lastPickedAt = Date.now();
        }
        await sleep(IDLE_POLL_MS);
        continue;
      }
      lastPickedAt = Date.now();

      const task = new Task(behavior.name);
      ctx.currentTask = task;
      ctx.currentBehavior = behavior.name;
      ctx.currentPriority = behavior.priority;
      const startedAt = Date.now();
      ctx.currentStartedAt = startedAt;
      let didWork = true;
      let interrupted = false;

      try {
        // A behavior returning exactly false means "nothing to do after all".
        didWork = (await behavior.run(bot, ctx, task)) !== false;
      } catch (err) {
        if (!isInterruption(err)) {
          logger.warn('Behavior failed', { behavior: behavior.name, error: err.message });
        }
        // An interruption isn't the behavior's fault; a real error means it
        // didn't accomplish anything either way.
        interrupted = isInterruption(err);
        didWork = interrupted;
      } finally {
        ctx.currentTask = null;
        ctx.currentPriority = -1;
        ctx.currentStartedAt = 0;
        try {
          bot.pathfinder.setGoal(null);
          // Inside the try for the same reason as setGoal. This is a
          // `finally` in an async loop with no catch around it: a throw here
          // (it does throw once the client is gone — stations.js guards the
          // same call) would reject the loop itself, and the director would
          // silently stop picking behaviors for good.
          bot.clearControlStates();
        } catch {
          // disconnected mid-behavior
        }
      }

      recordRun(ctx, bot, behavior.name, didWork, interrupted, task.reason === OVERRUN_REASON);

      const elapsed = Date.now() - startedAt;
      if (elapsed < MIN_BEHAVIOR_GAP_MS) await sleep(MIN_BEHAVIOR_GAP_MS - elapsed);
    }
  })();

  return () => {
    running = false;
    clearInterval(supervisor);
    // A reflex firing after shutdown must find nothing to call, not a closure
    // over a director that has stopped picking behaviors.
    if (ctx.requestPreemptionCheck === preemptIfOutranked) ctx.requestPreemptionCheck = null;
    if (ctx.currentTask) ctx.currentTask.abort('shutdown');
    return loop;
  };
}

module.exports = {
  startDirector,
  // Exported for the tests: this decides what the bot does next, and it is
  // where Jev's advice meets the safety ordering that must not bend.
  effectivePriority,
  // ...and this is the ordering itself, including the preemption walk that
  // must never let a committed behavior hide an emergency behind it.
  pickBehavior, INTERRUPT_PRIORITY_FLOOR,
  // How long a Jev focus is trusted — the prefetcher re-asks just before it lapses.
  FOCUS_TTL_MS, FOCUS_MIN_CONFIDENCE, currentRisk,
  // And this decides what a behavior's outcome costs it — see OVERRUN_REASON.
  recordRun, OVERRUN_COOLDOWN_MS, PRODUCTIVE_WHILE_STATIONARY,
  // Long-running behaviors budget against this rather than restating it.
  MAX_BEHAVIOR_MS,
};
