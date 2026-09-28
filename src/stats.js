const fs = require('fs');
const path = require('path');

/**
 * How good is the bot — per world, per try, and over time?
 *
 * Asked for directly: "how good the bot [is] over time and in multiple world
 * average time taken to reach goals over multiple worlds and tries and how
 * good is the bot [in] multiple world[s]". The session logs already hold every
 * fact needed; this reads them into one history.
 *
 * Deliberately built on LOG ENTRIES rather than on calls from the behaviors:
 * the live bot feeds it through logger.subscribe, and tools/backfill-stats.js
 * feeds it the same entries from the 690 older logs — one code path, so live
 * and imported history can never disagree about what a milestone is.
 * stats.json is therefore a cache of the logs and can always be rebuilt.
 *
 * A "life" is one try: from a fresh start (a new world, or a respawn after a
 * death) to the next death, or to the end of the session. Averages use fresh
 * lives only — a session restarted with a full iron kit in the bag did not
 * "reach stone tools in 3 seconds".
 */

const FILE = path.join(__dirname, '..', 'stats.json');
const SAVE_DEBOUNCE_MS = 5000;

const IRON_ORES = new Set(['iron_ore', 'deepslate_iron_ore']);
const DIAMOND_ORES = new Set(['diamond_ore', 'deepslate_diamond_ore']);

/**
 * The goals, in order. Each is detected from a log entry that exists in old
 * logs as well as new ones, so a run from last week and a run from today are
 * measured the same way. The two phase-only milestones come from
 * src/progression.js and exist in new logs only.
 */
const MILESTONES = [
  { id: 'wooden_pickaxe', label: 'Wooden pickaxe' },
  { id: 'stone_pickaxe', label: 'Stone pickaxe' },
  { id: 'stone_kit', label: 'Stone kit' },
  { id: 'trip_ready', label: 'Ready to dig' },
  { id: 'first_iron', label: 'First iron' },
  { id: 'iron_pickaxe', label: 'Iron pickaxe' },
  { id: 'first_diamond', label: 'First diamond' },
  { id: 'diamond_pickaxe', label: 'Diamond pickaxe' },
  { id: 'diamond_kit', label: 'Diamond kit' },
];
const MILESTONE_INDEX = Object.fromEntries(MILESTONES.map((m, i) => [m.id, i]));
const CRAFTED = new Set(['Crafted', 'Crafted item']);
const PHASE_MILESTONES = { 'Stone tools': 'stone_kit', 'Ready to dig': 'trip_ready', 'Diamond kit': 'diamond_kit' };

function blankStore() {
  return { version: 1, worlds: {}, updatedAt: 0 };
}

function load() {
  try {
    const store = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    return store?.version === 1 ? store : blankStore();
  } catch {
    return null; // no history yet — the caller decides whether to backfill
  }
}

/**
 * Turns a stream of log entries into worlds and lives. Pure apart from the
 * store it is given; `approx` marks history reconstructed from old logs,
 * where world identity is inferred from "New world" / "been here before".
 */
class Recorder {
  constructor(store = blankStore(), { approx = false } = {}) {
    this.store = store;
    this.approx = approx;
    this.world = null;
    this.life = null;
    this.phase = null;
    this.unknownWorlds = 0;
    this.crafted = new Set();
  }

  worldEntry(id) {
    if (!this.store.worlds[id]) {
      this.store.worlds[id] = {
        id, label: null, firstSeen: null, lastSeen: null, approx: this.approx, lives: [],
      };
    }
    return this.store.worlds[id];
  }

  useWorld(id, at) {
    const w = this.worldEntry(id);
    w.firstSeen = w.firstSeen ?? at;
    w.lastSeen = at;
    if (this.world !== id) {
      this.closeLife(at, 'quit');
      this.world = id;
    }
    return w;
  }

  currentWorld(at) {
    if (!this.world) {
      this.unknownWorlds += 1;
      this.useWorld(`unidentified-${this.unknownWorlds}`, at);
    }
    return this.worldEntry(this.world);
  }

  openLife(at, fresh) {
    const w = this.currentWorld(at);
    this.crafted = new Set();
    this.life = {
      n: w.lives.length + 1,
      startedAt: at,
      endedAt: null,
      end: 'open',
      fresh,
      approx: this.approx,
      milestones: {},
      killedBy: null,
      diedInPhase: null,
      counters: {
        logs: 0, stone: 0, ores: 0, diamonds: 0, crafted: 0, kills: 0,
      },
    };
    w.lives.push(this.life);
    return this.life;
  }

  /** The end of a log file, or of a process: nothing more happens on it. */
  endOfSession() {
    this.closeLife(this.lastAt ?? Date.now(), 'quit');
    this.connected = false;
  }

  closeLife(at, end) {
    if (!this.life) return;
    this.life.endedAt = at;
    this.life.end = end;
    this.life = null;
  }

  ensureLife(at) {
    return this.life ?? this.openLife(at, !!this.pendingFresh);
  }

  reach(id, at) {
    const life = this.ensureLife(at);
    if (life.milestones[id] !== undefined) return;
    life.milestones[id] = at - life.startedAt;
  }

  ingest(entry) {
    const at = Date.parse(entry.ts);
    if (!Number.isFinite(at)) return;
    const d = entry.data ?? {};
    this.store.updatedAt = Math.max(this.store.updatedAt, at);
    this.lastAt = at;
    if (this.world) this.worldEntry(this.world).lastSeen = at;

    // Order within a connection, as logged: "Bot spawned", then "New world"
    // or "been here before" while the world is identified, then "Playing in
    // world", then "Session started", then the first "Progression" reading.
    switch (entry.message) {
      case 'Bot spawned':
        // A new connection: whatever was open ended with the last one. The
        // next life opens on the first thing that happens in this one.
        this.closeLife(at, 'quit');
        this.pendingFresh = false;
        this.connected = true;
        return;
      case 'New world — forgetting the old base':
        this.useWorld(d.world ?? `world-${at}`, at);
        this.pendingFresh = true;
        return;
      case 'Playing in world':
        this.useWorld(d.world, at);
        return;
      case 'I have been in this world before — picking up where I left off':
        this.currentWorld(at);
        return;
      case 'Progression':
        // The first phase reading of a session: a fresh start only if the bag
        // holds none of the progress.
        this.phase = d.phase;
        if (!this.life) this.openLife(at, !!this.pendingFresh || d.phase === 'Wood');
        else if (d.phase === 'Wood' && Object.keys(this.life.milestones).length === 0) this.life.fresh = true;
        return;
      case 'Phase complete':
        this.phase = d.next;
        if (PHASE_MILESTONES[d.phase]) this.reach(PHASE_MILESTONES[d.phase], at);
        return;
      case 'Back to an earlier phase':
        this.phase = d.to;
        return;
      case 'Bot died': {
        const life = this.ensureLife(at);
        life.killedBy = d.killedBy ?? 'unknown';
        life.diedInPhase = this.phase;
        this.closeLife(at, 'death');
        // Everything is on the floor: the next life starts from nothing. Its
        // phase is unknown until the log says ("Back to an earlier phase") —
        // old logs never do, and guessing Wood blamed 262 deaths on it.
        this.openLife(at, true);
        this.phase = null;
        return;
      }
      default:
        break;
    }

    // Only what happens on a connection counts. Before test runs stopped
    // writing session logs (09-24), a few hundred files held fixture lines
    // like "Crafted {stone_pickaxe}" with no bot behind them.
    if (!this.connected) return;
    const life = this.ensureLife(at);

    // A respawn that gets its kit back off the floor did not start over.
    if (entry.message === 'Cleared the death site' && (d.itemsRecovered ?? 0) > 0) life.fresh = false;

    if (CRAFTED.has(entry.message) && d.item) {
      life.counters.crafted += d.count ?? 1;
      this.crafted.add(d.item);
      if (d.item === 'wooden_pickaxe') this.reach('wooden_pickaxe', at);
      if (d.item === 'stone_pickaxe') this.reach('stone_pickaxe', at);
      if (d.item === 'iron_pickaxe') this.reach('iron_pickaxe', at);
      if (d.item === 'diamond_pickaxe') this.reach('diamond_pickaxe', at);
      if (d.item.startsWith('iron_')) this.reach('first_iron', at);
      // Old logs have no phase events: a stone pickaxe, sword and axe crafted
      // in the same life is the same fact.
      if (['stone_pickaxe', 'stone_sword', 'stone_axe'].every((n) => this.crafted.has(n))) this.reach('stone_kit', at);
    } else if (entry.message === 'Chopped tree') {
      life.counters.logs += d.logs ?? 1;
    } else if (entry.message === 'Gathered stone') {
      life.counters.stone += d.blocks ?? 1;
    } else if (entry.message === 'Mined ore') {
      life.counters.ores += 1;
      if (IRON_ORES.has(d.block)) this.reach('first_iron', at);
      if (DIAMOND_ORES.has(d.block)) this.reach('first_diamond', at);
    } else if (entry.message === '*** DIAMOND ***') {
      life.counters.diamonds += 1;
      this.reach('first_diamond', at);
    } else if (/^Collected/.test(entry.message) && d.item === 'iron_ingot') {
      this.reach('first_iron', at);
    } else if (entry.message === 'Hunt finished' && d.killed) {
      life.counters.kills += 1;
    }
  }
}

// --- aggregation ----------------------------------------------------------

function median(xs) {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : Math.round((s[mid - 1] + s[mid]) / 2);
}

function mean(xs) {
  return xs.length ? Math.round(xs.reduce((a, b) => a + b, 0) / xs.length) : null;
}

function lifeLength(life, now) {
  return (life.endedAt ?? now) - life.startedAt;
}

function furthest(life) {
  let best = -1;
  for (const id of Object.keys(life.milestones)) best = Math.max(best, MILESTONE_INDEX[id] ?? -1);
  return best;
}

function milestoneTable(lives) {
  return MILESTONES.map((m) => {
    const times = lives.map((l) => l.milestones[m.id]).filter((t) => t !== undefined);
    return {
      id: m.id,
      label: m.label,
      reached: times.length,
      of: lives.length,
      rate: lives.length ? times.length / lives.length : 0,
      mean: mean(times),
      median: median(times),
      best: times.length ? Math.min(...times) : null,
    };
  });
}

function tally(values) {
  const out = {};
  for (const v of values) out[v] = (out[v] ?? 0) + 1;
  return Object.entries(out).sort((a, b) => b[1] - a[1]).map(([key, count]) => ({ key, count }));
}

/** Everything the dashboard's history view shows, computed from the store. */
function summarize(store, now = Date.now()) {
  const worlds = Object.values(store.worlds);
  const allLives = worlds.flatMap((w) => w.lives.map((l) => ({ ...l, world: w.id })));
  const fresh = allLives.filter((l) => l.fresh);
  const deaths = allLives.filter((l) => l.end === 'death');
  const playMs = allLives.reduce((sum, l) => sum + lifeLength(l, now), 0);

  const perWorld = worlds.map((w) => {
    const lives = w.lives;
    const freshLives = lives.filter((l) => l.fresh);
    const worldPlay = lives.reduce((sum, l) => sum + lifeLength(l, now), 0);
    const best = lives.reduce((b, l) => Math.max(b, furthest(l)), -1);
    return {
      id: w.id,
      label: w.label ?? w.id,
      approx: !!w.approx,
      firstSeen: w.firstSeen,
      lastSeen: w.lastSeen,
      lives: lives.length,
      deaths: lives.filter((l) => l.end === 'death').length,
      playMs: worldPlay,
      deathsPerHour: worldPlay > 0 ? +(lives.filter((l) => l.end === 'death').length / (worldPlay / 3600000)).toFixed(2) : 0,
      furthest: best >= 0 ? MILESTONES[best].label : null,
      furthestIndex: best,
      milestones: milestoneTable(freshLives),
    };
  }).sort((a, b) => (b.furthestIndex - a.furthestIndex) || (b.lastSeen - a.lastSeen));

  // One point per fresh life, oldest first: how far it got, and how fast.
  const trend = fresh
    .sort((a, b) => a.startedAt - b.startedAt)
    .map((l) => ({
      at: l.startedAt,
      world: l.world,
      lifeMs: lifeLength(l, now),
      furthest: furthest(l),
      stonePickaxeMs: l.milestones.stone_pickaxe ?? null,
      ironPickaxeMs: l.milestones.iron_pickaxe ?? null,
      end: l.end,
      killedBy: l.killedBy,
    }));

  return {
    milestones: MILESTONES,
    totals: {
      worlds: worlds.length,
      lives: allLives.length,
      freshLives: fresh.length,
      deaths: deaths.length,
      playMs,
      deathsPerHour: playMs > 0 ? +(deaths.length / (playMs / 3600000)).toFixed(2) : 0,
      bestEver: MILESTONES[Math.max(-1, ...allLives.map(furthest))]?.label ?? null,
    },
    overall: milestoneTable(fresh),
    worlds: perWorld,
    deathsByCause: tally(deaths.map((l) => l.killedBy ?? 'unknown')),
    deathsByPhase: tally(deaths.map((l) => l.diedInPhase ?? 'unknown')),
    trend: trend.slice(-200),
    updatedAt: store.updatedAt,
  };
}

/** The open life, as speedrun-style splits against this world's and all-time bests. */
function splits(store, worldId, now = Date.now()) {
  const w = store.worlds[worldId];
  const life = w?.lives.findLast?.((l) => l.end === 'open') ?? w?.lives.filter((l) => l.end === 'open').pop();
  if (!life) return null;
  const worldTable = milestoneTable(w.lives.filter((l) => l.fresh && l !== life));
  const all = Object.values(store.worlds).flatMap((x) => x.lives).filter((l) => l.fresh && l !== life);
  const overallTable = milestoneTable(all);
  return {
    life: life.n,
    fresh: life.fresh,
    elapsedMs: now - life.startedAt,
    counters: life.counters,
    rows: MILESTONES.map((m, i) => ({
      id: m.id,
      label: m.label,
      at: life.milestones[m.id] ?? null,
      worldBest: worldTable[i].best,
      worldMean: worldTable[i].mean,
      overallMean: overallTable[i].mean,
      overallBest: overallTable[i].best,
    })),
  };
}

// --- the live recorder -----------------------------------------------------

let live = null;

/**
 * Start recording for this process. `backfill` rebuilds history from the
 * logs when there is none yet (see tools/backfill-stats.js for the same
 * thing on demand). Returns { recorder, stop }.
 */
function start(logger, { backfill = null } = {}) {
  let store = load();
  if (!store) store = backfill ? backfill() : blankStore();
  const recorder = new Recorder(store);
  let saveTimer = null;
  const save = () => {
    saveTimer = null;
    try {
      fs.writeFileSync(`${FILE}.tmp`, JSON.stringify(store));
      fs.renameSync(`${FILE}.tmp`, FILE);
    } catch {
      try { fs.writeFileSync(FILE, JSON.stringify(store)); } catch { /* history is a nicety */ }
    }
  };
  const unsubscribe = logger.subscribe((entry) => {
    if (entry.level === 'status') return;
    try {
      recorder.ingest(entry);
    } catch {
      return; // a malformed entry must never reach the bot
    }
    if (entry.message === 'Bot died') save();
    else if (!saveTimer) {
      saveTimer = setTimeout(save, SAVE_DEBOUNCE_MS);
      saveTimer.unref?.();
    }
  });
  live = { recorder, store };
  return {
    recorder,
    stop() {
      unsubscribe();
      if (saveTimer) clearTimeout(saveTimer);
      save();
    },
  };
}

function history() {
  return live ? summarize(live.store) : null;
}

function currentSplits() {
  if (!live?.recorder.world) return null;
  return splits(live.store, live.recorder.world);
}

module.exports = {
  FILE, MILESTONES, Recorder, summarize, splits, start, history, currentSplits, blankStore, load,
};
