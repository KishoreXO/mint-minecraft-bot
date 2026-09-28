const logger = require('./logger');

/**
 * Stop a third-party plugin leaking the bot to death.
 *
 * A run ended with "FATAL ERROR: Ineffective mark-compacts near heap limit"
 * after five minutes at 2GB, and the crash dump showed a Mark-Compact taking
 * 8.6 SECONDS — which is also where the 400-800ms "event loop stalled"
 * warnings had been coming from. They were never expensive scans; they were
 * the garbage collector losing.
 *
 * The bot said what was wrong itself, once, in a line that is easy to scroll
 * past:
 *
 *   MaxListenersExceededWarning: Possible EventEmitter memory leak detected.
 *   11 entity_status listeners added to [Client].
 *
 * It is mineflayer-auto-eat. Its buildEatingListener (dist/new.js:110) adds an
 * `entity_status` listener to the protocol client and an `updateSlot` listener
 * to the inventory, and removes them on exactly three paths: the eat
 * completing, the held item changing, and an explicit rejection binding. The
 * fourth path — its own timeout, at line 133 — calls reject() and removes
 * NEITHER. So every eat that times out leaks two listeners forever, each one
 * holding a closure over the bot, the item and a pending promise.
 *
 * This bot eats constantly and on a timer. The leak is therefore unbounded in
 * exactly the way that matters, and it gets worse as it goes: every
 * entity_status packet is dispatched to every leaked listener, so the CPU cost
 * climbs alongside the memory.
 *
 * Patching node_modules is not a fix — it survives until the next install. So
 * this prunes from outside. It records how many listeners are legitimately
 * present once the plugins have loaded, and anything beyond that plus one in
 * flight is a corpse.
 */

// One genuine eat can be in flight at a time; anything past that is leaked.
const IN_FLIGHT_ALLOWANCE = 1;
const CHECK_MS = 5000;
// Give the plugins a moment to attach their own listeners before deciding
// what "normal" looks like.
const BASELINE_DELAY_MS = 4000;
const WARN_THROTTLE_MS = 60000;

const WATCHED = [
  { name: 'entity_status', on: (bot) => bot._client },
  { name: 'updateSlot', on: (bot) => bot.inventory },
];

function countOn(emitter, event) {
  try {
    return emitter?.listenerCount?.(event) ?? 0;
  } catch {
    return 0;
  }
}

/**
 * Drop the OLDEST excess listeners, keeping the baseline and the newest.
 *
 * Order matters and is on our side: mineflayer's own listeners are attached
 * when the plugins load, so they are first in the array and are never the ones
 * removed. The newest is spared because it may be an eat genuinely in
 * progress — and the worst case if we are wrong about that is one eat that
 * times out, which is the situation that created the leak in the first place.
 */
function prune(emitter, event, keep) {
  const listeners = emitter.listeners(event);
  if (listeners.length <= keep) return 0;

  const doomed = listeners.slice(keep - IN_FLIGHT_ALLOWANCE, listeners.length - IN_FLIGHT_ALLOWANCE);
  for (const fn of doomed) emitter.removeListener(event, fn);
  return doomed.length;
}

function startLeakGuard(bot, ctx) {
  const baselines = new Map();
  let lastWarnAt = 0;
  let removedTotal = 0;

  const measure = setTimeout(() => {
    for (const { name, on } of WATCHED) {
      baselines.set(name, countOn(on(bot), name));
    }
    logger.info('Listener baseline recorded', {
      ...Object.fromEntries(baselines),
      why: 'anything beyond this is a plugin failing to clean up after itself',
    });
  }, BASELINE_DELAY_MS);
  if (measure.unref) measure.unref();

  const timer = setInterval(() => {
    if (!ctx.connected || baselines.size === 0) return;

    for (const { name, on } of WATCHED) {
      const emitter = on(bot);
      if (!emitter?.listeners) continue;

      const keep = (baselines.get(name) ?? 0) + IN_FLIGHT_ALLOWANCE;
      const removed = prune(emitter, name, keep);
      if (removed === 0) continue;

      removedTotal += removed;
      if (Date.now() - lastWarnAt > WARN_THROTTLE_MS) {
        lastWarnAt = Date.now();
        logger.warn('Cleaned up leaked event listeners', {
          event: name,
          removedNow: removed,
          removedThisSession: removedTotal,
          culprit: 'mineflayer-auto-eat: its eat timeout rejects without unsubscribing',
        });
      }
    }
  }, CHECK_MS);
  if (timer.unref) timer.unref();

  return () => {
    clearTimeout(measure);
    clearInterval(timer);
  };
}

module.exports = { startLeakGuard };
