const os = require('os');
const logger = require('./logger');

/**
 * How much of the bot's slowness is the network, and how much is us.
 *
 * "Latency is a problem here" has been a standing complaint, and it has been
 * treated as a network fact — standoffs widened for ping, combat deadlines
 * tuned around round trips. But Node runs everything on one thread, and this
 * bot does a great deal of synchronous work on it: findBlocks walks whole
 * 16x16x16 chunk sections, pathfinder's A* runs in 20ms slices, and both sit
 * on the same event loop as packet decoding and the physics tick.
 *
 * When that loop is blocked the bot is late for everything — it reads
 * positions that are already stale, swings after the window has closed, and
 * replies to keep-alives late. From the outside that is indistinguishable
 * from network lag, and it was being misdiagnosed as exactly that.
 *
 * So measure it. A timer that should fire every 100ms and fires at 340 has
 * told you the loop was blocked for 240ms, and nothing about the network.
 * Two numbers, side by side on the dashboard:
 *
 *   ping   the real round trip to the server
 *   lag    how long the bot's own thread was busy and unable to react
 *
 * Minecraft runs at 50ms per tick, so anything above that is dropped ticks.
 */

const SAMPLE_MS = 100;
// Anything under about half a tick is ordinary scheduling jitter.
const IGNORE_BELOW_MS = 20;
// A stall this long is a real freeze and worth a line in the log, not just a
// number on a dashboard — it is several dropped ticks and, in a fight, a hit.
const STALL_WARN_MS = 400;
const WARN_THROTTLE_MS = 15000;
// Rolling window, so the number describes now rather than the whole session.
const WINDOW = 50;

/**
 * Memory, watched as closely as time — because it turned out to be the same
 * problem.
 *
 * The bot died with "FATAL ERROR: Ineffective mark-compacts near heap limit"
 * after six minutes, having grown to 2GB. The 400-800ms stalls this meter had
 * been reporting were not expensive scans at all, they were the garbage
 * collector fighting a heap that would not shrink — a Mark-Compact of 8.6
 * SECONDS appears in the crash dump.
 *
 * A leak is invisible until you plot it, and "which behavior was running when
 * it grew" is most of the diagnosis. So the heap is sampled alongside the
 * delay, and a steady climb says so out loud rather than ending the session.
 */
const HEAP_WARN_MB = 900;
const HEAP_SAMPLE_EVERY = 20; // every other second, at a 100ms tick

/**
 * WHICH CALL blocked the loop, not merely which behavior was running.
 *
 * "doing: defend" on a three-second stall is not a diagnosis. Combat does no
 * expensive scanning of its own; the cost was something else entirely that
 * happened to land on the same tick — a block sweep, a cave probe, a
 * pathfinder solve. Naming the behavior sent me looking in the wrong file
 * twice.
 *
 * So the expensive synchronous calls time themselves, and the stall warning
 * reports the worst of them since the last warning. It costs two Date.now()
 * calls per scan and turns "the bot lagged" into "findShore took 2.9 seconds",
 * which is a thing that can actually be fixed.
 */
const SLOW_SCAN_MS = 60;
const SCANS_REPORTED = 3;

/**
 * Was the bot BUSY during the stall, or was it simply not running?
 *
 * Those are different problems with different fixes, and the wall clock
 * cannot tell them apart. A 20.9-second freeze during a hunt got the bot
 * kicked with disconnect.timeout, and its timed scans blamed a radius-32
 * block search for five seconds — a search that takes 14ms on this machine
 * under test. Everything that happened to be running during that window got
 * charged the whole window, because the process was not being scheduled at
 * all: the Minecraft client and its integrated server share the computer, and
 * under memory pressure the OS pages a process out and stops running it.
 *
 * CPU time settles it. Our own code blocking the loop burns CPU for the whole
 * stall; a process that was descheduled or paged out burns almost none.
 * Free system memory is reported alongside, because paging is the usual
 * reason a process stops being run.
 */
const STARVED_BELOW_CPU_SHARE = 0.3;

function cpuVerdict(cpuMs, wallMs) {
  const share = wallMs > 0 ? cpuMs / wallMs : 1;
  return share < STARVED_BELOW_CPU_SHARE
    ? 'not our code — the process was barely running (machine busy or paging)'
    : 'our own thread was busy';
}

function createState() {
  return {
    samples: [],
    worstMs: 0,
    worstAt: 0,
    stalls: 0,
    heapMb: 0,
    heapPeakMb: 0,
    heapAtStartMb: 0,
    ticks: 0,
    warnedHeap: false,
    // name -> { totalMs, calls, worstMs } since the last stall report.
    scans: new Map(),
  };
}

// The meter is started per session but the scans are timed from modules that
// have no ctx, so the live state is parked here on start.
let liveState = null;

/**
 * Time a synchronous scan and remember it if it was slow.
 *
 * Deliberately records only the slow ones: a 2ms block lookup is noise, and
 * keeping every call would be its own allocation problem.
 */
function timeScan(name, fn) {
  if (!liveState) return fn();
  const startedAt = Date.now();
  try {
    return fn();
  } finally {
    const took = Date.now() - startedAt;
    if (took >= SLOW_SCAN_MS) {
      const entry = liveState.scans.get(name) ?? { totalMs: 0, calls: 0, worstMs: 0 };
      entry.totalMs += took;
      entry.calls += 1;
      entry.worstMs = Math.max(entry.worstMs, took);
      liveState.scans.set(name, entry);
    }
  }
}

/** The worst offenders since the last report, then reset. */
function drainScans(state) {
  const worst = [...state.scans.entries()]
    .sort((a, b) => b[1].totalMs - a[1].totalMs)
    .slice(0, SCANS_REPORTED)
    .map(([name, e]) => `${name} ${e.worstMs}ms worst / ${e.totalMs}ms in ${e.calls}`);
  state.scans.clear();
  return worst.length > 0 ? worst : ['nothing over 60ms — likely a GC pause or pathfinder'];
}

function record(state, delayMs) {
  state.samples.push(delayMs);
  if (state.samples.length > WINDOW) state.samples.shift();
  if (delayMs > state.worstMs) {
    state.worstMs = delayMs;
    state.worstAt = Date.now();
  }
}

/** Typical and worst recent event-loop delay, in milliseconds. */
function summary(ctx) {
  const state = ctx.lag;
  if (!state || state.samples.length === 0) {
    return { typicalMs: 0, peakMs: 0, stalls: 0 };
  }
  const sorted = [...state.samples].sort((a, b) => a - b);
  return {
    // Median, not mean: one 300ms chunk scan should not make an otherwise
    // healthy loop look permanently congested.
    typicalMs: Math.round(sorted[Math.floor(sorted.length / 2)]),
    peakMs: Math.round(Math.max(...state.samples)),
    stalls: state.stalls,
  };
}

/** One line for the dashboard and for chat. */
function describe(bot, ctx) {
  const { typicalMs, peakMs, stalls } = summary(ctx);
  const ping = bot.player?.ping;
  const heap = ctx.lag?.heapMb ?? 0;
  const peakHeap = ctx.lag?.heapPeakMb ?? 0;
  return `ping ${ping === undefined ? '?' : `${ping}ms`}`
    + ` | own thread ${typicalMs}ms typical, ${peakMs}ms peak`
    + ` | ${stalls} stalls over ${STALL_WARN_MS}ms`
    + ` | heap ${heap}MB (peak ${peakHeap}MB)`;
}

/**
 * Sample the heap, and say something if it is climbing.
 *
 * Reported as `doing`, because that is the question that matters: a leak that
 * only grows while one behavior runs is findable, and one that grows evenly
 * is a different problem entirely.
 */
function ownMemoryMb() {
  const m = process.memoryUsage();
  return {
    heapMb: Math.round(m.heapUsed / (1024 * 1024)),
    rssMb: Math.round(m.rss / (1024 * 1024)),
  };
}

function checkHeap(ctx, doing) {
  const state = ctx.lag;
  state.ticks += 1;
  if (state.ticks % HEAP_SAMPLE_EVERY !== 0) return;

  const mb = Math.round(process.memoryUsage().heapUsed / (1024 * 1024));
  state.heapMb = mb;
  if (!state.heapAtStartMb) state.heapAtStartMb = mb;
  if (mb > state.heapPeakMb) state.heapPeakMb = mb;

  if (mb >= HEAP_WARN_MB && !state.warnedHeap) {
    state.warnedHeap = true;
    logger.error('Heap is climbing — something is being retained', {
      heapMb: mb,
      sinceStartMb: mb - state.heapAtStartMb,
      doing,
      meaning: 'the bot will run out of memory and die if this continues',
    });
  }
}

// Module-level: when the last stall was, for msSinceStall.
let lastStallAt = 0;

function startLagMeter(bot, ctx) {
  let expected = Date.now() + SAMPLE_MS;
  let lastWarnAt = 0;
  let lastCpu = process.cpuUsage();
  liveState = ctx.lag;

  const timer = setInterval(() => {
    const now = Date.now();
    const delay = Math.max(0, now - expected);
    expected = now + SAMPLE_MS;
    // CPU spent over this whole sample (the intended 100ms plus any delay).
    const cpu = process.cpuUsage(lastCpu);
    lastCpu = process.cpuUsage();
    const cpuMs = Math.round((cpu.user + cpu.system) / 1000);

    checkHeap(ctx, ctx.currentBehavior ?? 'unknown');

    if (delay < IGNORE_BELOW_MS) {
      record(ctx.lag, 0);
      return;
    }
    record(ctx.lag, delay);

    if (delay >= STALL_WARN_MS) {
      ctx.lag.stalls++;
      lastStallAt = now;
      if (now - lastWarnAt > WARN_THROTTLE_MS) {
        lastWarnAt = now;
        // Name what was running. Nine times in ten it is a block search or a
        // pathfinder solve, and knowing which is the whole point.
        logger.warn('Event loop stalled — the bot could not react', {
          forMs: Math.round(delay),
          doing: ctx.currentBehavior ?? 'unknown',
          droppedTicks: Math.round(delay / 50),
          cpuMs,
          verdict: cpuVerdict(cpuMs, delay + SAMPLE_MS),
          freeMemMb: Math.round(os.freemem() / (1024 * 1024)),
          // Ours, beside the machine's: a stall with a small rss and no free
          // memory is the rest of the computer, not this process.
          ...ownMemoryMb(),
          // The part that actually identifies the culprit — see timeScan.
          slowest: drainScans(ctx.lag),
        });
      }
    }
  }, SAMPLE_MS);

  if (timer.unref) timer.unref();
  return () => clearInterval(timer);
}

/**
 * How long since the event loop last stalled, in ms (Infinity if never).
 * Every Jev timeout in the 09-26 logs fell within six seconds of a multi-
 * second stall, most of them "not our code": the request was fine, the bot
 * could not run to receive the answer. Callers use this to say which.
 */
function msSinceStall() {
  return lastStallAt ? Date.now() - lastStallAt : Infinity;
}

module.exports = {
  createState, startLagMeter, summary, describe, msSinceStall,
  // For test/lag.test.js — which kind of stall it was decides where to look.
  cpuVerdict,
  // Wrap an expensive synchronous scan so a stall can name it — see timeScan.
  timeScan,
};
