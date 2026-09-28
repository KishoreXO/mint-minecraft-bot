const config = require('./src/config');
const logger = require('./src/logger');
const { createBot } = require('./src/bot');
const { startDirector, INTERRUPT_PRIORITY_FLOOR, FOCUS_TTL_MS } = require('./src/director');
const progression = require('./src/progression');
const { startChatCommands, describeStatus } = require('./src/chatCommands');
const {
  startAutosave, save: saveBase, adoptWorld, forgetEverything, knownBase,
} = require('./src/base');
const { snapshot } = require('./src/world');
const { applyEatingPolicy } = require('./src/eating');
const { startPrefetch } = require('./src/prefetch');
const { startDamageWatch } = require('./src/damage');
const difficulty = require('./src/difficulty');
const { startSwimWatchdog } = require('./src/swim');
const { startFallGuard } = require('./src/falls');
const lag = require('./src/lag');
const { startLeakGuard } = require('./src/leakguard');
const { installLayers } = require('./src/layers/controller');
const memory = require('./src/memory');
const { startStatusFile, STATUS_FILE } = require('./src/statusFile');
const { startDashboard } = require('./src/dashboard');
const stats = require('./src/stats');
const { rebuild: rebuildStats } = require('./tools/backfill-stats');

const { escapeDrowning, leaveWater, escapeHazard } = require('./src/behaviors/survive');
const { shelter } = require('./src/behaviors/shelter');
const { bed } = require('./src/behaviors/bed');
const {
  threat, defend, buildThreatState, worthAskingJev, needsFreshAnswer,
} = require('./src/behaviors/threat');
const { loot, noteDeathSite } = require('./src/behaviors/loot');
const { touchingLava } = require('./src/lava');
const { collect } = require('./src/behaviors/collect');
const { tidy } = require('./src/behaviors/tidy');
const { unstick } = require('./src/behaviors/unstick');
const { gear } = require('./src/behaviors/gear');
const { smelt, fetchCooked } = require('./src/behaviors/smelt');
const {
  hunt, huntUrgent, forage, forageTopUp,
} = require('./src/behaviors/hunt');
const {
  mine, gatherStone, goDeep, stripMine, resupply, valuables,
  buildOreState, visibleOreTypes, buildStrategyState, ORE_VERDICT_TTL_MS,
} = require('./src/behaviors/mine');
const { wood, woodUrgent, idle } = require('./src/behaviors/wood');
const { explore } = require('./src/behaviors/explore');

const RECONNECT_BASE_MS = 5000;
const RECONNECT_MAX_MS = 30000;
const SWEEP_INTERVAL_MS = 60000;
const DECISION_RETENTION_MS = 60000;
// How long to keep asking which world this is before giving up and starting
// clean. bot.spawnPoint normally lands before the spawn event; this covers
// the case where it does not.
const WORLD_ID_ATTEMPTS = 20;
const WORLD_ID_RETRY_MS = 250;

// Backoff + de-duplication, so a closed world doesn't produce three near
// identical error lines every five seconds forever.
let reconnectDelay = RECONNECT_BASE_MS;
let lastErrorKey = null;
let lastErrorLoggedAt = 0;

function logConnectionError(err) {
  const key = err.code || err.message || 'unknown';
  const now = Date.now();
  if (key === lastErrorKey && now - lastErrorLoggedAt < 30000) return;
  lastErrorKey = key;
  lastErrorLoggedAt = now;
  if (key === 'ECONNREFUSED') {
    logger.warn('Server not reachable — is the world open to LAN on this port?', {
      host: config.mc.host,
      port: config.mc.port,
      retryingEveryMs: reconnectDelay,
    });
  } else {
    logger.error('Bot error', { error: err.message, code: err.code });
  }
}

// Higher number wins.
//
// escapeDrowning outranks combat because drowning while fighting is still
// drowning — but `leaveWater` sits BELOW it, at 85, and that distinction
// matters: a bot floating in a lake with full air and a drowned on it is in a
// fight, not a navigation problem, and swimming away is not an option because
// drowned are faster in water than we are. Merging the two put the bot at
// priority 95 paddling for a shore it could not reach while being eaten.
//
// Eating isn't in here any more — auto-eat runs on its own timer rather than
// as a scheduled behavior, so the bot can eat while walking instead of having
// to win a priority contest first.
//
// `defend` and `threat` are the same fight seen from two ends, and they sit on
// opposite sides of sheltering on purpose — see the note above `defend` in
// behaviors/threat.js. Choosing to start a fight at night is worse than
// burrowing; being in one already is not.
const BEHAVIORS = [
  escapeHazard, escapeDrowning, defend, unstick, bed, shelter, threat, leaveWater,
  loot, fetchCooked, woodUrgent, forage, forageTopUp, collect, resupply, huntUrgent, valuables, gear, smelt, tidy,
  gatherStone, mine, goDeep, stripMine, hunt, wood, explore, idle,
];

let currentBot = null;
startAutosave();

// The web dashboard lives for the whole process; each session attaches its
// bot to it. See src/dashboard.js.
// Run history across worlds and tries — see src/stats.js. Rebuilt from the
// logs the first time (about 1.5 s for 700 of them), then kept up to date live.
stats.start(logger, { backfill: () => rebuildStats({ exclude: logger.logFile }) });

let dashboard = null;
if (config.dashboard.port) {
  dashboard = startDashboard(config.dashboard);
  dashboard.ready
    .then(() => logger.info('Dashboard', { url: `http://localhost:${config.dashboard.port}`, viewer: config.dashboard.viewer }))
    .catch((err) => {
      logger.warn('Dashboard could not start — the bot carries on without it', { error: err.message });
      dashboard = null;
    });
}

function makeContext() {
  return {
    connected: false,
    paused: false,
    currentTask: null,
    manualTask: null,
    currentBehavior: null,
    currentPriority: -1,
    // When the running behavior started, so the supervisor can break a
    // deadlock — see MAX_BEHAVIOR_MS in director.js.
    currentStartedAt: 0,
    // behavior name -> { strikes, until } — see director's no-op detection
    backoff: new Map(),
    // { name, at } — the behavior that last did real work, which gets a
    // small priority bonus so the bot finishes what it starts.
    commitment: null,

    threat: {
      decisions: new Map(), // entityId -> { decision, at }
      fleeAttempts: new Map(), // entityId -> { count, lastAt }
      unreachable: new Map(), // entityId -> ignore-until timestamp
      // entityId -> how many times we've failed to reach it, so the hold
      // can grow instead of re-engaging the same hopeless target forever.
      unreachableStrikes: new Map(),
      lastAttackerId: null,
      lastAttackAt: 0,
      // When something last HIT us — melee, an arrow, a blast, or a hit
      // nothing could explain. Not a fall, not hunger, not the gravel: those
      // were all counted once, and a bot that took fall damage with you
      // standing nearby treated you as the attacker. Set by src/damage.js,
      // which is the only place that knows what a health drop actually was.
      lastAttackedAt: 0,
      lastSwitchAt: 0, // retarget hysteresis
    },
    // A QUEUE of death sites, not one. Dying on the way back to your corpse
    // is the common case — the bot is unarmed and walking toward whatever
    // killed it — and a single slot meant the second death erased the first
    // pile, the one with all the tools in it. Each entry carries its own
    // despawn clock and its own stall count. See behaviors/loot.js.
    death: { sites: [], respawnedAt: 0 },
    // `rescuing` is the swim watchdog saying it has taken the controls to get
    // the bot to air — surfaced on the dashboard so "why did it abandon that"
    // has a visible answer.
    water: {
      since: null, from: null, rescuing: false, escape: null, leftAt: 0, divingUntil: null,
    },
    // Which difficulty this world is on, and how we know — see
    // src/difficulty.js. Every damage number in knowledge.js is the Normal
    // value, so without this the bot plans every fight against figures that
    // may be half or 1.5x what it will actually take.
    difficulty: difficulty.createState(),
    // How long the bot's OWN thread was too busy to react. Distinct from
    // ping, and routinely mistaken for it — see src/lag.js.
    lag: lag.createState(),
    // verdicts: ore name -> { decision, at } — Jev is asked about an ore
    // TYPE, not every individual block in a vein
    mine: {
      candidate: null,
      lastScanAt: 0,
      // An ore sweep that finds nothing is the expensive one — findBlocks
      // cannot stop early without hits — and underground that is most of
      // them. Back off after a miss instead of paying it twice a second.
      lastScanEmpty: false,
      // Where the last sweep was made from, so an empty answer is not paid for
      // again until the bot has actually moved — see findOre.
      lastScanFrom: null,
      // The stone sweep has its own clock. gatherStone.shouldRun is evaluated
      // every time the director picks a behavior, and an unthrottled
      // findBlocks there had the event loop permanently 100ms behind.
      lastStoneScanAt: 0,
      stoneCandidate: null,
      skipped: new Map(),
      verdicts: new Map(),
      descentBlockedUntil: 0,
      stripHeading: null, // persistent branch-tunnel direction at depth
      // ...and the same for the way DOWN. Without it every goDeep run cut a
      // flight of stairs in a fresh random direction, so the descent was a
      // dozen disconnected stubs rather than one walkable staircase.
      descentHeading: null,
      // Caves already worked out, so the bot does not ping-pong between the
      // same two forever — see workTheCave in behaviors/mine.js.
      cavesDone: [],
      lastShortfall: null, // what's stopping the descent, for the status line
    },
    // skipped: trunk-base key -> ignore-until, for trees we couldn't reach.
    // lastScanEmpty backs the scan off after a miss: a search that finds
    // nothing is the expensive one (findBlocks cannot stop early), and
    // repeating it every 600ms in a treeless area is pure event-loop tax.
    // `restocking` is the hysteresis latch: once a supply run starts it fills
    // right up instead of stopping at the trigger, so the bot does not climb
    // forty blocks for one log and then do it again.
    wood: {
      candidate: null,
      lastScanAt: 0,
      lastScanEmpty: false,
      restocking: false,
      skipped: new Map(),
    },
    // `lastScanEmpty` and `lastLongScanFrom` stop the widest block sweep in the
    // program being repeated from a spot that already answered "nothing" — it
    // was costing ~770ms of frozen event loop every six seconds. See
    // behaviors/explore.js.
    explore: {
      heading: null,
      headingSetAt: 0,
      lastLongScanAt: 0,
      lastLongScanFrom: null,
      lastScanEmpty: false,
    },
    // failed: entityId -> when we gave up on it. picked: lifetime pickups,
    // surfaced in the status line so a stalled resource loop is obvious.
    collect: { failed: new Map(), picked: 0 },
    stuck: { anchor: null, since: 0 },
    // Where the bot deliberately threw something away, so `collect` does not
    // walk straight back and fetch it. Identifying a dropped ITEM is
    // best-effort; identifying a PLACE is not — see behaviors/tidy.js.
    tidy: { discarded: [] },
    // Crafts that keep failing, so `gear` stops converting the bot's whole
    // wood supply into sticks for a tool it cannot make — see behaviors/gear.js.
    gear: { failures: new Map() },
    // How often Jev actually decided something, versus instinct deciding
    // because the answer wasn't back yet. This is the number that says
    // whether the model is running the bot or merely commenting on it.
    jev: { prefetched: 0, usedCached: 0, usedInstinct: 0 },
    // What Jev thinks the bot should be focusing on — { focus, risk,
    // confidence, at }. Advisory: it nudges the scheduler rather than
    // overriding it. See director.js and src/jevClient.js assessStrategy.
    strategy: null,
    // `pending` is a standing appointment with a furnace: where the batch is
    // and when it will be done, so the bot goes back for it deliberately
    // instead of only ever collecting by accident on a later errand.
    smelt: { pending: null },
    // When a crafting table or furnace was last used, so `tidy` can tell
    // "finished here and moving on" from "between two crafts" before it
    // breaks one to carry it.
    stations: { lastUsedAt: 0 },
    // `until` stops it retrying a burrow straight after a failure. `sealedIn`
    // says the bot is walled in DELIBERATELY, so `unstick` does not spend the
    // night breaking the roof open again — see behaviors/unstick.js.
    shelter: { until: 0, sealedIn: false },
    bed: { until: 0, pos: null },
    // Every point of health lost, attributed to a cause — see src/damage.js.
    // Without this there is no way to tell "dying to mobs" from "arriving at
    // every fight already half dead because it keeps falling down its own
    // mineshaft", and those need completely different fixes.
    // `life` is the same ledger for this life only, emptied at every death:
    // `total` runs for the whole session, and "Bot died" used to print it as
    // if it were this death's story — a second death on 09-25 carried the
    // first one's 14 ranged and a previous life's 21 drowning.
    damage: {
      total: {}, life: {}, hits: {}, lastCause: null, lastAt: 0,
    },
  };
}

/**
 * Wrap every behavior so a chat `stop` genuinely halts everything — and so
 * nothing runs while the bot is dead.
 *
 * The dead check is not theoretical. Between taking the fatal hit and the
 * respawn packet the bot still has an entity, still has a position, and that
 * position is its own corpse. Loot recovery therefore looked at the death
 * site, saw it was standing on it, declared the trip complete and cleared the
 * pending position — one second after dying, before it had respawned. It then
 * came back to life somewhere else with the loot abandoned.
 */
function canAct(bot, ctx) {
  return !ctx.paused && !ctx.manualTask && bot.health > 0;
}

/**
 * The progression gate — see src/progression.js. Attached here rather than in
 * each behavior so the phase table stays the one place that says who works on
 * what, and so director.js stays free of behavior imports.
 */
function phased(behavior) {
  return {
    ...behavior,
    phaseGate: (bot, ctx) => progression.allows(bot, ctx, behavior, INTERRUPT_PRIORITY_FLOOR),
  };
}

function pausable(behavior) {
  return {
    ...behavior,
    shouldRun: (bot, ctx) => canAct(bot, ctx) && behavior.shouldRun(bot, ctx),
    ...(behavior.canInterrupt
      ? { canInterrupt: (bot, ctx) => canAct(bot, ctx) && behavior.canInterrupt(bot, ctx) }
      : {}),
  };
}

function startSession() {
  const bot = createBot();
  currentBot = bot;
  const ctx = makeContext();

  let stopDirector = null;
  let stopChat = null;
  let stopPrefetch = null;
  let stopDamageWatch = null;
  let stopStatusFile = null;
  let stopDashboard = null;
  let stopSwimWatch = null;
  let stopFallGuard = null;
  let stopLagMeter = null;
  let stopLeakGuard = null;
  let stopDifficultyWatch = null;
  let stopLayers = null;
  let statusTimer = null;
  let lastPosition = null;

  bot.once('spawn', async () => {
    ctx.connected = true;
    reconnectDelay = RECONNECT_BASE_MS; // connected fine, reset the backoff
    lastErrorKey = null;
    // Establish WHICH WORLD this is before any behavior can act on memory.
    //
    // The signature comes from bot.spawnPoint, which arrives in its own
    // packet — usually before this event fires, and not guaranteed to. If it
    // has not, the old code carried straight on with the previous world's
    // remembered base still live, and `gear` would set off toward a crafting
    // table in a world the bot is no longer in.
    //
    // So: keep asking until we know. Behaviors do not start until we do, and
    // a few hundred milliseconds of standing still at spawn costs nothing
    // next to walking two hundred blocks to the wrong place.
    await new Promise((resolve) => {
      const tryAdopt = (attempt = 0) => {
        if (adoptWorld(bot, config.mc.host)) return resolve(true);
        if (attempt >= WORLD_ID_ATTEMPTS) {
          // Never identified it. Start clean rather than trusting notes that
          // may belong somewhere else entirely.
          logger.warn('Could not identify this world — starting from a clean slate', {
            attempts: attempt,
          });
          forgetEverything();
          return resolve(false);
        }
        return setTimeout(() => tryAdopt(attempt + 1), WORLD_ID_RETRY_MS);
      };
      tryAdopt();
    });
    // For src/stats.js: which world this session's history belongs to.
    if (knownBase.world) logger.info('Playing in world', { world: knownBase.world });

    logger.info('Session started', {
      logFile: logger.logFile,
      liveStatus: STATUS_FILE,
      watchWith: `Get-Content -Wait -Tail 40 "${STATUS_FILE}"`,
    });

    // The F3 line, once the world has actually arrived.
    //
    // Logged immediately it reported "biome: null, lighting: unavailable" on
    // a world that was sending both — at the spawn event the chunk the bot is
    // standing in has not been received yet, so every block read comes back
    // empty. A couple of seconds is the difference between a snapshot that
    // describes the world and one that describes the loading screen.
    setTimeout(() => {
      if (ctx.connected) logger.info('World', snapshot(bot));
    }, 3000).unref?.();

    stopChat = startChatCommands(bot, ctx);
    stopDamageWatch = startDamageWatch(bot, ctx);
    // How hard things hit here. The server usually says outright; when it
    // doesn't, the damage ledger works it out from what actually lands.
    stopDifficultyWatch = difficulty.startDifficultyWatch(bot, ctx);
    // Swimming, including under the surface — and the guarantee that the bot
    // never drowns doing it: the water pilot's float, on physics ticks. See
    // src/water.js.
    stopSwimWatch = startSwimWatchdog(bot, ctx);
    // Don't walk off things. Pathfinder respects its own drop limit; the four
    // places that drive the controls by hand — and the pvp engine, whose
    // movement is not ours — do not. See src/falls.js.
    stopFallGuard = startFallGuard(bot, ctx);
    // Tells network lag apart from the bot blocking its own event loop. The
    // two look identical from the outside and need opposite fixes.
    stopLagMeter = lag.startLagMeter(bot, ctx);
    // A third-party listener leak ended a run at 2GB of heap. Until the
    // plugin is fixed upstream, this cleans up after it — see leakguard.js.
    stopLeakGuard = startLeakGuard(bot, ctx);
    // Live dashboard on disk — see src/statusFile.js. Watch it with
    // `Get-Content -Wait -Tail 40 bot-status.txt` in a spare terminal.
    stopStatusFile = startStatusFile(bot, ctx);
    stopDashboard = dashboard ? dashboard.attach(bot, ctx, BEHAVIORS) : null;
    stopDirector = startDirector(bot, ctx, BEHAVIORS.map((b) => phased(pausable(b))));
    // Reflex layer (physicsTick trip-wires) + state machine (observes what
    // director is running). See src/layers/controller.js for why this
    // doesn't compete with director for the bot's body.
    stopLayers = installLayers(bot, ctx);

    // Warm Jev's answers before they're needed. Without this the model
    // loses its own race almost every time (measured 0.6–3.6s against a
    // 300ms deadline) and hardcoded instinct ends up running the bot.
    stopPrefetch = startPrefetch(bot, ctx, {
      buildThreatState,
      buildOreState,
      visibleOreTypes,
      buildStrategyState,
      // Which answers anyone reads, and how long each lives — owned by the
      // decision sites, not restated in the prefetcher.
      worthAsking: worthAskingJev,
      needsFreshAnswer,
      oreVerdictTtlMs: ORE_VERDICT_TTL_MS,
      focusTtlMs: FOCUS_TTL_MS,
      phaseOf: progression.phaseOf,
    });

    statusTimer = setInterval(() => {
      // bot.entity is null between the killing blow and the respawn packet,
      // and describeStatus reads its position. A throw inside a setInterval
      // callback is an uncaught exception, so a routine death could take out
      // the status line — or worse, land in the uncaughtException handler and
      // be reported as a genuine bug.
      if (!ctx.connected || !bot.entity) return;
      try {
        logger.status(describeStatus(bot, ctx));
      } catch (err) {
        logger.warn('Could not build the status line', { error: err.message });
      }
    }, config.logging.statusIntervalMs);
  });

  /**
   * Stop the combat engine driving the bot when nobody asked it to.
   *
   * swordpvp's update() runs on EVERY physics tick for as long as it holds a
   * target, and in melee range it drives the control states directly —
   * forward, sprint, jump, strafe. That is correct while a fight is running
   * and catastrophic afterwards: a stale target means the engine keeps
   * steering while `mine` or `wood` owns the bot, so the two fight over the
   * controls. The symptoms are exactly what was reported — sprint particles
   * while standing still, knockback that never registers because something
   * re-asserts movement every tick, and generally "high ping player"
   * movement.
   *
   * It leaks because attack() is async: abort a fight in the moment between
   * calling it and it resolving, and stop() runs first, then the target gets
   * set anyway, with no behavior left to clear it.
   *
   * Rather than chase every ordering, assert the invariant continuously:
   * only a combat behavior may hold a pvp target.
   */
  const COMBAT_BEHAVIORS = new Set(['threat', 'defend', 'hunt', 'huntUrgent']);
  const pvpWatchdog = setInterval(() => {
    if (!ctx.connected || !bot.swordpvp) return;
    if (!bot.swordpvp.target) return;
    if (COMBAT_BEHAVIORS.has(ctx.currentBehavior)) return;

    logger.info('Combat engine still steering after the fight — releasing', {
      behavior: ctx.currentBehavior,
    });
    try {
      bot.swordpvp.stop();
    } catch {
      // not attacking after all
    }
    bot.clearControlStates();
  }, 250);

  // Track position continuously so we know where we died.
  const posTimer = setInterval(() => {
    if (!ctx.connected || !bot.entity) return;
    lastPosition = bot.entity.position.clone();
    // Deepest point reached, so a later session knows the run is already
    // underground instead of starting from "I am standing on grass".
    memory.noteDepth(bot.entity.position.y);
  }, 1000);

  // These caches are keyed by entity id / block position and would otherwise
  // grow for as long as the bot runs. Sweep the stale entries periodically.
  const sweepTimer = setInterval(() => {
    const now = Date.now();
    for (const [id, entry] of ctx.threat.decisions) {
      if (now - entry.at > DECISION_RETENTION_MS) ctx.threat.decisions.delete(id);
    }
    for (const [key, until] of ctx.mine.skipped) {
      if (until < now) ctx.mine.skipped.delete(key);
    }
    for (const [key, until] of ctx.wood.skipped) {
      if (until < now) ctx.wood.skipped.delete(key);
    }
    for (const [name, entry] of ctx.backoff) {
      if (entry.until && entry.until < now) ctx.backoff.delete(name);
    }
    for (const [item, entry] of ctx.gear.failures) {
      if (entry.until < now) ctx.gear.failures.delete(item);
    }
    // These are {at, strikes} now, not bare timestamps — and this loop was
    // still subtracting the object from a number, which is NaN, which is
    // never greater than anything. So nothing was ever swept and the map grew
    // for the life of the session. A small leak, but exactly the shape of the
    // one that ended a run with "Ineffective mark-compacts near heap limit".
    //
    // A drop we have GIVEN UP on is kept longer on purpose: forgetting it
    // after a minute would undo the give-up and start the retries again.
    for (const [id, entry] of ctx.collect.failed) {
      const keepFor = entry.strikes >= 3 ? 5 * 60 * 1000 : DECISION_RETENTION_MS;
      if (now - entry.at > keepFor) ctx.collect.failed.delete(id);
    }
    for (const [id, until] of ctx.threat.unreachable) {
      if (until < now) {
        ctx.threat.unreachable.delete(id);
        // Keep the strike count a little longer than the hold, so a mob
        // that is repeatedly unreachable keeps escalating instead of
        // resetting to a short hold every time.
        if (!bot.entities[id]) ctx.threat.unreachableStrikes.delete(id);
      }
    }
    for (const [id, entry] of ctx.threat.fleeAttempts) {
      if (now - entry.lastAt > DECISION_RETENTION_MS) ctx.threat.fleeAttempts.delete(id);
    }
  }, SWEEP_INTERVAL_MS);

  // Fires on hunger changes too, which is exactly when the raw-vs-cooked
  // decision needs revisiting.
  //
  // Damage is NOT handled here any more. This handler used to stamp "we are
  // under attack", start the knockback recoil and blame whoever stood within
  // five blocks for EVERY health drop — falls, starvation, gravel — because it
  // runs before anything has worked out what the drop was. A fall with you
  // standing next to the bot made you the attacker. src/damage.js classifies
  // each hit first and only then does any of that, for hits that were hits.
  bot.on('health', () => {
    if (!ctx.connected) return;
    applyEatingPolicy(bot);
  });

  // Fires on respawn as well as on the initial join. Loot recovery waits for
  // this rather than trusting a position read while the bot is still a corpse.
  bot.on('spawn', () => {
    if (ctx.death.sites.length > 0) {
      ctx.death.respawnedAt = Date.now();
      const newest = ctx.death.sites[ctx.death.sites.length - 1];
      logger.info('Respawned — will go back for the loot', {
        piles: ctx.death.sites.length,
        newest: newest.pos,
        distance: Math.round(bot.entity.position.distanceTo(newest.pos)),
      });
    }
  });

  const ledger = (by) => Object.fromEntries(
    Object.entries(by)
      .sort((a, b) => b[1] - a[1])
      .map(([cause, amount]) => [cause, Math.round(amount)]),
  );
  bot.on('death', () => {
    // Print the full ledger on every death. This is the one moment where the
    // question "what is actually killing this bot?" has a complete answer,
    // and it is worth more than any single log line: three deaths that read
    // "fall 24" mean something entirely different from three that read
    // "melee 58", and they had been indistinguishable.
    logger.warn('Bot died', {
      at: lastPosition,
      killedBy: ctx.damage.lastCause,
      healthLostThisLife: ledger(ctx.damage.life),
      healthLostThisSession: ledger(ctx.damage.total),
    });
    ctx.damage.life = {};
    // A climb out of the water belongs to the life that started it.
    if (ctx.water) ctx.water.escape = null;
    // Remembered across restarts — somewhere that has killed us once is
    // worth knowing about next session.
    memory.noteDeath(lastPosition, ctx.damage.lastCause);
    // Queue it rather than replacing what was already there. Dying on the way
    // back to a previous corpse used to erase that corpse from the bot's
    // plans entirely — see behaviors/loot.js.
    // A pile that went into lava has burned — loot writes it off rather than
    // walking back to look. The body test, not the centre cell: see lava.js.
    noteDeathSite(ctx, lastPosition, {
      inLava: touchingLava(bot) || ctx.damage.lastCause === 'lava',
    });
    ctx.death.respawnedAt = 0;
    // The blacklist is keyed by entity id and our own fresh drops get new
    // ids, but clearing it costs nothing and guarantees we don't skip a drop
    // because some unrelated item was unreachable earlier.
    ctx.collect.failed.clear();
    ctx.threat.decisions.clear();
    if (ctx.currentTask) ctx.currentTask.abort('died');
  });

  // Ground truth for the resource loop.
  //
  // The bot's inventory once sat frozen at the same eight stacks for a whole
  // session while it mined constantly, and three plausible theories (wrong
  // tool, full inventory, creative mode) were all disproved in turn. This
  // event settled it: drops were spawning 3–4 blocks away and nothing was
  // ever picking them up. Counting pickups is the cheapest possible check
  // that the bot is actually getting paid for its work.
  bot.on('playerCollect', (collector) => {
    if (collector?.id !== bot.entity?.id) return;
    ctx.collect.picked = (ctx.collect.picked || 0) + 1;
  });

  bot.on('kicked', (reason) => logger.error('Kicked from server', { reason }));
  bot.on('error', logConnectionError);

  let ended = false;
  bot.on('end', (reason) => {
    if (ended) return; // mineflayer can emit this more than once per socket
    ended = true;

    const wasConnected = ctx.connected;
    ctx.connected = false;
    clearInterval(posTimer);
    clearInterval(pvpWatchdog);
    clearInterval(sweepTimer);
    if (statusTimer) clearInterval(statusTimer);
    if (stopSwimWatch) stopSwimWatch();
    if (stopFallGuard) stopFallGuard();
    if (stopLayers) stopLayers();
    if (stopLagMeter) stopLagMeter();
    if (stopLeakGuard) stopLeakGuard();
    if (stopDifficultyWatch) stopDifficultyWatch();
    if (stopDamageWatch) stopDamageWatch();
    if (stopStatusFile) stopStatusFile();
    if (stopDashboard) stopDashboard();
    if (stopChat) stopChat();
    if (stopPrefetch) stopPrefetch();
    if (stopDirector) stopDirector();
    saveBase();
    // A disconnect is also a good moment to make the notebook durable: the
    // process may be about to be killed, and the reconnect loop will want
    // everything this session learned.
    memory.flush();

    // Only announce a genuine drop. Failed connection attempts to a closed
    // world are already covered by logConnectionError's throttled message.
    if (wasConnected) {
      logger.warn('Disconnected — reconnecting', { reason, retryInMs: reconnectDelay });
      reconnectDelay = RECONNECT_BASE_MS;
    } else {
      reconnectDelay = Math.min(reconnectDelay * 2, RECONNECT_MAX_MS);
    }

    setTimeout(startSession, reconnectDelay);
  });
}

process.on('SIGINT', () => {
  logger.info('Shutting down');
  saveBase();
  // Synchronous, because the debounced write is unref'd and would never
  // fire — see memory.flush(). Without this every Ctrl+C threw away the
  // last few seconds of the notebook.
  memory.flush();
  if (currentBot) {
    try {
      currentBot.quit();
    } catch {
      // already gone
    }
  }
  process.exit(0);
});

process.on('unhandledRejection', (err) => {
  logger.error('Unhandled rejection', { error: err?.message || String(err) });
});

// Network errors must never take the process down. The bot is meant to run
// unattended for hours and reconnect on its own; a refused connection while
// the world is closed used to kill it outright (exit code 4), which is the
// "keeps leaving and never comes back" symptom. Anything else is a genuine
// bug, so it's logged with its stack rather than silently swallowed.
const SURVIVABLE_ERRORS = new Set([
  'ECONNREFUSED', 'ECONNRESET', 'EPIPE', 'ETIMEDOUT', 'EHOSTUNREACH',
  'ENETUNREACH', 'ENOTFOUND', 'EAI_AGAIN',
]);

function errorCodes(err) {
  const codes = [];
  if (err?.code) codes.push(err.code);
  for (const inner of err?.errors ?? []) {
    if (inner?.code) codes.push(inner.code);
  }
  return codes;
}

process.on('uncaughtException', (err) => {
  const codes = errorCodes(err);
  if (codes.length > 0 && codes.every((c) => SURVIVABLE_ERRORS.has(c))) {
    logger.warn('Network error (ignored, reconnect loop continues)', {
      codes: [...new Set(codes)],
    });
    return;
  }
  logger.error('Uncaught exception', { error: err?.message || String(err), stack: err?.stack });
});

startSession();
