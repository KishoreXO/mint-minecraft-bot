/**
 * Cooperative cancellation for behaviors.
 *
 * The old design had six independent loops all calling bot.pathfinder.goto()
 * whenever they felt like it, coordinated by a handful of boolean flags.
 * Since every flag check was separated from its corresponding action by an
 * `await`, two actors routinely both believed they held the wheel — which is
 * what produced the endless "goal was changed before it could be completed"
 * errors and the jittery movement.
 *
 * Now exactly one behavior runs at a time, and preemption is explicit: the
 * director aborts the running task, which unblocks whatever it was awaiting.
 */

class AbortError extends Error {
  constructor(reason = 'aborted') {
    super(reason);
    this.name = 'AbortError';
  }
}

class Task {
  constructor(name) {
    this.name = name;
    this.aborted = false;
    this.reason = null;
    this._listeners = [];
  }

  abort(reason = 'preempted') {
    if (this.aborted) return;
    this.aborted = true;
    this.reason = reason;
    for (const fn of this._listeners) {
      try {
        fn(reason);
      } catch {
        // a listener failing must not prevent the others from running
      }
    }
    this._listeners = [];
  }

  /**
   * Register a cleanup callback, and hand back a way to UNREGISTER it.
   *
   * The unsubscribe is not a nicety, it is a leak fix. Every `sleep(ms, task)`
   * and every `digBlock` registered a listener here and none of them ever
   * removed it — so a behavior polling at 50ms for its 60-second budget
   * accumulated twelve hundred closures on a single task, each holding the bot,
   * a timer and whatever else it had closed over. Combat polls every tick and
   * runs for up to 45 seconds; strip mining, swimming and every staircase are
   * built out of the same loops.
   *
   * It also made abort() O(n): by the time the director cut a long behavior
   * off, aborting it meant calling a thousand no-op functions, on the same
   * thread that runs physics.
   */
  onAbort(fn) {
    if (this.aborted) {
      fn(this.reason);
      return () => {};
    }
    this._listeners.push(fn);
    let live = true;
    return () => {
      if (!live) return;
      live = false;
      const at = this._listeners.indexOf(fn);
      if (at !== -1) this._listeners.splice(at, 1);
    };
  }

  throwIfAborted() {
    if (this.aborted) throw new AbortError(this.reason);
  }
}

/** Sleep that wakes immediately if the task gets aborted. */
function sleep(ms, task) {
  return new Promise((resolve, reject) => {
    let done = false;
    let unsubscribe = null;
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      // Drop the abort listener the moment the sleep is over. Without this
      // every poll of every loop leaves one behind for the life of the task —
      // see Task.onAbort.
      if (unsubscribe) unsubscribe();
      resolve();
    }, ms);

    if (task) {
      unsubscribe = task.onAbort((reason) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        reject(new AbortError(reason));
      });
    }
  });
}

/**
 * Run `promise` but give up after `ms`.
 *
 * Needed because bot.pathfinder.goto() has no overall time limit — it keeps
 * recomputing toward an unreachable goal indefinitely, which is how a single
 * uncollectable item drop pinned the bot in place for over a minute.
 */
async function withDeadline(promise, ms, label = 'operation', task = null) {
  let timer = null;
  let unsubscribe = null;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} exceeded ${ms}ms`)), ms);
        // A deadline that ignores the abort is how the bot ends up standing
        // still while something eats it.
        //
        // bot.craft() waits on inventory packets for up to twenty seconds and
        // is not cancellable. Wrapping it in a plain deadline meant a preempt
        // could mark the task aborted and the behavior would carry on awaiting
        // anyway — the director's `finally` never ran, `threat` was never
        // started, and from the outside the bot was simply AFK. Watched live,
        // with a zombie killing a bot that was holding full iron gear.
        //
        // Failing fast on abort does not cancel the underlying operation
        // (nothing can), but it does give the wheel back, which is the part
        // that matters.
        if (task) {
          unsubscribe = task.onAbort((reason) => reject(new AbortError(reason)));
        }
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
    if (unsubscribe) unsubscribe();
  }
}

/**
 * True for errors that just mean "we got interrupted", which are expected and
 * shouldn't be logged as failures. mineflayer-pathfinder signals this by
 * rejecting with a plain Error whose message mentions the goal changing.
 */
function isInterruption(err) {
  if (!err) return false;
  if (err instanceof AbortError || err.name === 'AbortError') return true;
  const msg = String(err.message || err);
  return msg.includes('goal was changed')
    || msg.includes('Goal was changed')
    || msg.includes('path was stopped');
}

/**
 * Wait until `pred()` holds, checked once per physics tick.
 *
 * Why ticks and not a sleep loop: anything that steers the body — swimming,
 * climbing out of water, pillaring — acts on physics ticks, and a
 * setTimeout-paced loop drifts off them. During an event-loop stall a 100ms
 * sleep can wake after twenty ticks have gone by with the last controls still
 * held. And a physics simulation (test/simbot.js) can drive a tick-paced loop
 * a thousand times faster than real time, which a wall-clock loop cannot.
 *
 * Resolves true when the predicate holds, false after `maxTicks` ticks or
 * `maxMs` of wall time (a disconnected bot stops ticking, and a wait must not
 * outlive it). Rejects with AbortError when the task is aborted.
 */
function untilTick(bot, pred, { maxTicks = Infinity, maxMs = 60000, task = null } = {}) {
  return new Promise((resolve, reject) => {
    let ticks = 0;
    let unsubscribe = null;
    let timer = null;
    let poll = null;
    let over = false;
    // A partial emitter (a test fake with `on` only) must not turn the end of
    // a wait into an uncaught TypeError from a timer: that crashed
    // test/mining.test.js after every check had passed, and stopped `npm test`.
    const canListen = typeof bot.on === 'function';
    const stopListening = () => {
      if (!canListen) return;
      if (typeof bot.removeListener === 'function') bot.removeListener('physicsTick', onTick);
      else if (typeof bot.off === 'function') bot.off('physicsTick', onTick);
    };
    const finish = (fn, value) => {
      if (over) return;
      over = true;
      stopListening();
      if (timer) clearTimeout(timer);
      if (poll) clearInterval(poll);
      if (unsubscribe) unsubscribe();
      fn(value);
    };
    const check = () => {
      let ok = false;
      try {
        ok = !!pred(ticks);
      } catch (err) {
        finish(reject, err);
        return;
      }
      if (ok) finish(resolve, true);
      else if (ticks >= maxTicks) finish(resolve, false);
    };
    function onTick() {
      ticks++;
      check();
    }
    if (task) {
      if (task.aborted) {
        reject(new AbortError(task.reason));
        return;
      }
      unsubscribe = task.onAbort((reason) => finish(reject, new AbortError(reason)));
    }
    // Also between ticks, for anything that does not tick (a test fake, a bot
    // whose physics is paused): the condition may come true on its own.
    poll = setInterval(check, 25);
    timer = setTimeout(() => finish(resolve, false), maxMs);
    // Not unref'd: something awaiting this wait must keep the process alive
    // until it ends, or a test run exits half-way with code 0.
    if (canListen) bot.on('physicsTick', onTick);
  });
}

/** Wait `n` physics ticks (or the equivalent wall time, whichever is first). */
function waitTicks(bot, n, task = null) {
  return untilTick(bot, (t) => t >= n, { maxTicks: n, maxMs: Math.max(250, n * 50 * 4), task });
}

module.exports = {
  AbortError, Task, sleep, withDeadline, isInterruption, untilTick, waitTicks,
};
