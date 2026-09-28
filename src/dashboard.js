const fs = require('fs');
const http = require('http');
const path = require('path');
const express = require('express');
const { Server: SocketServer } = require('socket.io');
const logger = require('./logger');
const { collectStatus } = require('./statusFile');
const { knownBase } = require('./base');
const memory = require('./memory');
const stats = require('./stats');
const jevClient = require('./jevClient');
const { isHostileMob, isFoodAnimal } = require('./entities');
const {
  buildStateMap, translateChunkJson, rendererVersion,
} = require('./viewerTranslate');

/**
 * The dashboard: a web page anyone can watch the bot on.
 *
 * Asked for directly: a way to "see what the bot does realtime with extremely
 * good UI ... so we can attract non coding people". bot-status.txt answers
 * the question for someone at a terminal; this answers it for someone at a
 * browser — the same snapshot (statusFile.collectStatus), plus the three
 * things a text file cannot show: the world in 3D, the scheduler deciding,
 * and a story of what just happened.
 *
 * One server, one port, bound to 127.0.0.1 — this computer only, no firewall
 * prompt, and nothing on it can control the bot. It lives for the whole
 * process; each connection to the game `attach`es its bot, so a reconnect
 * does not take the page down.
 *
 *   /            the dashboard (dashboard/)
 *   /stream      Server-Sent Events: `state` 4x a second, `event` per log line
 *   /api/state   the same state, once
 *   /viewer/     prismarine-viewer's 3D page, fed through viewerTranslate
 *   /textures/   item and block icons from the viewer's texture pack
 */

const STATE_EVERY_MS = 250;
// One number for the radar, sent to the page: the page drew 32 while the
// server sent mobs out to 48, and the threat chip counted mobs the radar could
// not show.
const RADAR_RANGE = 32;
// Splits, phase, markers, Jev and the trail change slowly; every fourth state
// frame carries them (1 Hz), the rest only what moves.
const SLOW_EVERY = 4;
const TRAIL_EVERY_MS = 2000;
const TRAIL_LENGTH = 300;
const FEED_BACKLOG = 80;
const VIEWER_PKG = path.dirname(require.resolve('prismarine-viewer/package.json'));
// Required piecemeal: the package's index pulls in node-canvas for headless
// rendering, a native module this bot has no use for.
const { WorldView } = require('prismarine-viewer/viewer/lib/worldView');
const { supportedVersions } = require('prismarine-viewer/viewer/lib/version');
// The mob models the viewer ships (a 1.16-era set), plus look-alikes for
// newer mobs so they appear as something rather than nothing.
const lag = require('./lag');

/**
 * WorldView, but the chunks go out at a walking pace.
 *
 * The stock one serialises five whole columns per tick until the view is full
 * — 169 of them at distance 6, about five milliseconds each once translated —
 * and starts over on every page reload. Live, the session with the page open
 * had fourteen event-loop stalls in five minutes against one in ten without
 * it. Queued here instead, one column per CHUNK_PACE_MS, so the 3D view can
 * never take more than a sliver of the thread the bot fights with. A column
 * that has left the view by the time its turn comes is skipped for free by
 * the distance check in the original loadChunk.
 */
const CHUNK_PACE_MS = 25;

class PacedWorldView extends WorldView {
  constructor(...args) {
    super(...args);
    this.queue = new Map(); // "x,z" -> position, in arrival order
    this.timer = setInterval(() => this.pump(), CHUNK_PACE_MS);
    this.timer.unref?.();
  }

  loadChunk(pos) {
    this.queue.set(`${pos.x},${pos.z}`, pos);
    return Promise.resolve();
  }

  unloadChunk(pos) {
    this.queue.delete(`${pos.x},${pos.z}`);
    super.unloadChunk(pos);
  }

  pump() {
    const next = this.queue.entries().next();
    if (next.done) return;
    const [key, pos] = next.value;
    this.queue.delete(key);
    super.loadChunk(pos).catch(() => {});
  }

  stop() {
    clearInterval(this.timer);
    this.queue.clear();
  }
}

const RENDERABLE = new Set(Object.keys(require('prismarine-viewer/viewer/lib/entity/entities.json')));
const ENTITY_STAND_INS = {
  glow_squid: 'squid', frog: 'slime', tadpole: 'cod', allay: 'vex', warden: 'iron_golem',
  camel: 'horse', sniffer: 'cow', armadillo: 'pig', breeze: 'blaze', bogged: 'skeleton',
  goat: 'sheep', axolotl: 'salmon',
};

const current = {
  bot: null,
  ctx: null,
  behaviors: [],
  session: 0,
  startedAt: Date.now(),
  deaths: 0,
  trail: [],
  feed: [], // { id, entry } — the id is what a reconnecting page resumes from
  feedSeq: 0,
  spawns: 0,
};

function entityKind(bot, e) {
  if (e.type === 'player') return 'player';
  if (isHostileMob(e)) return 'hostile';
  if (isFoodAnimal(e)) return 'animal';
  if (e.name === 'item') return 'item';
  return 'other';
}

function nearbyEntities(bot) {
  const me = bot.entity.position;
  const out = [];
  for (const e of Object.values(bot.entities)) {
    if (!e || e === bot.entity || !e.position) continue;
    const d = me.distanceTo(e.position);
    if (d > RADAR_RANGE) continue;
    out.push({
      id: e.id,
      name: e.username ?? e.displayName ?? e.name ?? 'unknown',
      kind: entityKind(bot, e),
      x: e.position.x,
      y: e.position.y,
      z: e.position.z,
      d: Math.round(d * 10) / 10,
    });
  }
  return out.sort((a, b) => a.d - b.d).slice(0, 60);
}

function plain(v) {
  return v ? { x: v.x, y: v.y, z: v.z } : null;
}

let checkSample = { at: Date.now(), checks: 0, rate: 0 };

function checksRate(checks) {
  const now = Date.now();
  const dt = now - checkSample.at;
  if (dt >= 1000) {
    checkSample = { at: now, checks, rate: Math.max(0, ((checks - checkSample.checks) * 1000) / dt) };
  }
  return checkSample.rate;
}

/** A dashboard must never be able to throw at the bot: bad data reads as none. */
function safely(fn) {
  try {
    return fn();
  } catch {
    return null;
  }
}

function buildState({ slow = true } = {}) {
  const { bot, ctx } = current;
  const connected = !!(bot?.entity && ctx?.connected);
  const base = {
    connected,
    session: current.session,
    spawns: current.spawns,
    radarRange: RADAR_RANGE,
    uptimeSec: Math.round((Date.now() - current.startedAt) / 1000),
    deathsThisRun: current.deaths,
    behaviors: current.behaviors,
  };
  if (!connected) return base;

  let status = null;
  try {
    status = collectStatus(bot, ctx);
  } catch (err) {
    status = { error: err.message };
  }
  const board = ctx.decisionBoard ?? null;
  const since = Date.now() - 5000;
  return {
    ...base,
    status,
    board: board && {
      pick: board.pick ?? null,
      preempt: board.preempt ?? null,
      checks: board.checks,
      recent: board.recent.slice(-12),
      perSec: board.recent.filter((d) => d.at >= since).length / 5,
      // How often the scheduler looks at the world: every pick plus every
      // preemption check. This is the "thinking" rate; picks alone are rare
      // while one long behavior holds the wheel.
      checksPerSec: checksRate(board.checks),
    },
    entities: nearbyEntities(bot),
    ping: bot.player?.ping ?? null,
    ...(slow ? slowState(bot, ctx) : {}),
  };
}

/**
 * The parts of the state that change on the scale of seconds. Built once a
 * second rather than four times: this runs on the bot's own thread, on a
 * laptop that was stalling for want of memory, and progression.describe,
 * the splits and the Jev percentiles are not free.
 */
function slowState(bot, ctx) {
  return {
    slow: true,
    trail: current.trail,
    markers: {
      table: plain(knownBase.tablePos),
      furnace: plain(knownBase.furnacePos),
      home: plain(knownBase.homePos),
      ...memory.markers(),
    },
    // The plan, where the bot is on it, and how this try compares — see
    // src/progression.js and src/stats.js.
    phase: safely(() => require('./progression').describe(bot, ctx)),
    splits: safely(() => stats.currentSplits()),
    jev: safely(() => jevClient.snapshot()),
  };
}

/** The SSE half: every open page gets state on a timer and log lines as they happen. */
function startStream(app) {
  const clients = new Set();

  app.get('/stream', (req, res) => {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    res.write('retry: 2000\n\n');
    // A page opened mid-session still gets the recent story, not a blank
    // feed — but a page RE-connecting gets only what it missed. Replaying all
    // eighty lines on every reconnect doubled the decision stream each time
    // the connection blinked, and reopened the death card for a death
    // already seen.
    const since = Number(req.headers['last-event-id'] ?? req.query?.since ?? 0) || 0;
    for (const { id, entry } of current.feed) {
      if (id > since) res.write(`id: ${id}\nevent: event\ndata: ${JSON.stringify(entry)}\n\n`);
    }
    clients.add(res);
    // The first state frame carries everything, slow fields included.
    try {
      res.write(`event: state\ndata: ${JSON.stringify(buildState())}\n\n`);
    } catch {
      // never let a dashboard disturb the bot
    }
    req.on('close', () => clients.delete(res));
  });

  const send = (event, data, id = null) => {
    const frame = `${id !== null ? `id: ${id}\n` : ''}event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const res of clients) res.write(frame);
  };

  const unsubscribe = logger.subscribe((entry) => {
    // Status lines are the 15-second heartbeat; the page has its own, 60x
    // faster, and the feed is for things that happened.
    if (entry.level === 'status') return;
    if (entry.message === 'Bot died') current.deaths++;
    const id = ++current.feedSeq;
    current.feed.push({ id, entry });
    if (current.feed.length > FEED_BACKLOG) current.feed.shift();
    if (clients.size) send('event', entry, id);
  });

  let frame = 0;
  const timer = setInterval(() => {
    if (!clients.size) return;
    try {
      send('state', buildState({ slow: frame++ % SLOW_EVERY === 0 }));
    } catch {
      // A dashboard must never be able to disturb the bot.
    }
  }, STATE_EVERY_MS);
  timer.unref?.();

  const trailTimer = setInterval(() => {
    const p = current.bot?.entity?.position;
    if (!p || !current.ctx?.connected) return;
    current.trail.push({ x: Math.round(p.x * 10) / 10, z: Math.round(p.z * 10) / 10 });
    if (current.trail.length > TRAIL_LENGTH) current.trail.shift();
  }, TRAIL_EVERY_MS);
  trailTimer.unref?.();

  return () => {
    clearInterval(timer);
    clearInterval(trailTimer);
    unsubscribe();
    for (const res of clients) res.end();
  };
}

/**
 * The 3D half: prismarine-viewer's own browser page, fed by its own WorldView,
 * with every chunk and block relabelled on the way out (see viewerTranslate).
 *
 * Its stock `mineflayer()` server listens on every interface and loads
 * node-canvas; this is the same sixty lines, bound to our server instead.
 */
function startViewer(server, { viewDistance }) {
  const io = new SocketServer(server, { path: '/viewer/socket.io' });
  const maps = new Map(); // world version -> state map
  const primitives = {};
  const sockets = new Set();

  const broadcast = (payload) => { for (const s of sockets) s.emit('primitive', payload); };
  const draw = (payload) => { primitives[payload.id] = payload; broadcast(payload); };
  const erase = (id) => {
    if (!primitives[id]) return;
    delete primitives[id];
    broadcast({ id });
  };

  io.on('connection', (socket) => {
    const { bot } = current;
    if (!bot?.entity || !bot.world) {
      socket.disconnect(true);
      return;
    }
    const worldVersion = bot.version;
    const target = rendererVersion(worldVersion, supportedVersions);
    if (!target) {
      socket.disconnect(true);
      return;
    }
    let map = null;
    if (target !== worldVersion) {
      if (!maps.has(worldVersion)) {
        const mcData = require('minecraft-data');
        maps.set(worldVersion, buildStateMap(bot.registry, mcData(target)));
      }
      map = maps.get(worldVersion);
    }

    const relabel = (event, data) => {
      if (!map) return data;
      if (event === 'loadChunk') {
        return lag.timeScan('viewer chunk', () => ({ ...data, chunk: translateChunkJson(data.chunk, map) }));
      }
      if (event === 'blockUpdate') return { ...data, stateId: map[data.stateId] ?? data.stateId };
      return data;
    };
    // Entities the renderer has a model for, and only those. Anything else it
    // draws as a magenta cube and logs a stack trace per update — a river of
    // glow squid and every dropped item turned the view into confetti. Moves
    // carry only an id, so an entity dropped at spawn stays dropped.
    const shown = new Set();
    const entityOut = (data) => {
      if (data.name !== undefined) {
        const name = ENTITY_STAND_INS[data.name] ?? data.name;
        if (!RENDERABLE.has(name)) return null;
        shown.add(data.id);
        return { ...data, name };
      }
      if (!shown.has(data.id)) return null;
      if (data.delete) shown.delete(data.id);
      return data;
    };
    // WorldView only ever calls on() and emit() on its emitter.
    const emitter = {
      on: (event, fn) => socket.on(event, fn),
      emit: (event, data) => {
        if (event === 'entity') {
          const out = entityOut(data);
          if (out) socket.emit(event, out);
          return;
        }
        socket.emit(event, relabel(event, data));
      },
    };

    // "?fp=1" on the iframe asks for the bot's own eyes rather than orbiting.
    const firstPerson = /[?&]fp=1\b/.test(socket.handshake.headers.referer ?? '');

    socket.emit('version', target);
    sockets.add(socket);
    const view = new PacedWorldView(bot.world, viewDistance, bot.entity.position, emitter);
    view.init(bot.entity.position).catch(() => {});
    for (const id of Object.keys(primitives)) socket.emit('primitive', primitives[id]);

    const onMove = () => {
      const packet = { pos: bot.entity.position, yaw: bot.entity.yaw, addMesh: true };
      if (firstPerson) packet.pitch = bot.entity.pitch;
      socket.emit('position', packet);
      view.updatePosition(bot.entity.position).catch(() => {});
    };
    bot.on('move', onMove);
    view.listenToBot(bot);
    onMove();

    socket.on('disconnect', () => {
      bot.removeListener('move', onMove);
      view.stop();
      try { view.removeListenersFromBot(bot); } catch { /* bot already gone */ }
      sockets.delete(socket);
    });
  });

  /** Overlays for one bot: its planned route, and the block it is digging. */
  function overlay(bot) {
    const onPath = (r) => {
      if (!r?.path?.length) return;
      draw({
        type: 'line',
        id: 'path',
        color: 0x36d6ff,
        points: [bot.entity.position, ...r.path].map((p) => ({ x: p.x, y: p.y + 0.5, z: p.z })),
      });
    };
    const clearPath = () => erase('path');
    bot.on('path_update', onPath);
    bot.on('goal_reached', clearPath);
    bot.on('path_reset', clearPath);

    const digTimer = setInterval(() => {
      const b = bot.targetDigBlock;
      if (b) {
        const p = b.position;
        draw({
          type: 'boxgrid', id: 'dig', color: 'yellow', start: { x: p.x, y: p.y, z: p.z }, end: { x: p.x + 1, y: p.y + 1, z: p.z + 1 },
        });
      } else {
        erase('dig');
      }
    }, STATE_EVERY_MS);
    digTimer.unref?.();

    return () => {
      clearInterval(digTimer);
      bot.removeListener('path_update', onPath);
      bot.removeListener('goal_reached', clearPath);
      bot.removeListener('path_reset', clearPath);
      erase('path');
      erase('dig');
    };
  }

  return {
    overlay,
    // A new bot means a new world object: the old sockets are looking at a
    // dead one. Dropping them makes the page reconnect to the live one.
    reset: () => { for (const s of sockets) s.disconnect(true); },
    close: () => io.close(),
  };
}

/**
 * The 3D view's page: prismarine-viewer's stock page, drawing at a capped
 * pixel ratio and reporting its frame rate (dashboard/viewer.html).
 *
 * The bundle itself is served untouched; the cap works by setting
 * devicePixelRatio before the bundle reads it. Together with the page loading
 * the view from the other loopback name (dashboard/js/main.js), which gives it
 * a browser process and main thread of its own, this is what makes the 3D view
 * smooth on a laptop that is also running the game.
 */
let viewerHtml = null;
function viewerPage(pixelRatio) {
  if (viewerHtml === null) {
    viewerHtml = fs.readFileSync(path.join(__dirname, '..', 'dashboard', 'viewer.html'), 'utf8');
  }
  const ratio = Number.isFinite(pixelRatio) && pixelRatio >= 0 ? pixelRatio : 1;
  return viewerHtml.replace('__PIXEL_RATIO__', String(ratio));
}

/**
 * Start the server once for the process.
 * Returns { url, attach(bot, ctx, behaviors) -> detach, close }.
 */
function startDashboard({
  port = 3000, host = '127.0.0.1', viewer = true, viewDistance = 6, pixelRatio = 1,
} = {}) {
  const app = express();
  app.use('/', express.static(path.join(__dirname, '..', 'dashboard')));
  const target = rendererVersion('99', supportedVersions);
  app.use('/textures', express.static(path.join(VIEWER_PKG, 'public', 'textures', target)));
  if (viewer) {
    app.get('/viewer/', (req, res) => res.type('html').send(viewerPage(pixelRatio)));
    app.use('/viewer', express.static(path.join(VIEWER_PKG, 'public')));
  }
  app.get('/api/state', (req, res) => res.json(buildState()));
  // History across worlds and tries. Heavier than state and slow-moving, so
  // the page asks for it on its own clock rather than on the stream.
  app.get('/api/history', (req, res) => res.json(stats.history() ?? { totals: null }));

  // One URL per item name, whatever folder its picture is in: an item icon,
  // or for blocks with no item sprite (logs, tables) the face a player would
  // recognise. Missing pictures 404 and the page draws a lettered tile.
  const texRoot = path.join(VIEWER_PKG, 'public', 'textures', target);
  const iconCache = new Map();
  app.get('/icon/:name', (req, res) => {
    const name = String(req.params.name).replace(/[^a-z0-9_]/g, '');
    if (!iconCache.has(name)) {
      const found = [`items/${name}.png`, `blocks/${name}.png`, `blocks/${name}_front.png`,
        `blocks/${name}_top.png`, `blocks/${name}_side.png`]
        .map((rel) => path.join(texRoot, rel))
        .find((p) => fs.existsSync(p));
      iconCache.set(name, found ?? null);
    }
    const file = iconCache.get(name);
    if (!file) return res.status(404).end();
    res.set('Cache-Control', 'max-age=86400');
    return res.sendFile(file);
  });

  const server = http.createServer(app);
  const stopStream = startStream(app);
  const view = viewer ? startViewer(server, { viewDistance }) : null;

  const ready = new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => resolve(server.address()));
  });

  function attach(bot, ctx, behaviors = []) {
    current.bot = bot;
    current.ctx = ctx;
    current.behaviors = behaviors.map((b) => ({ name: b.name, priority: b.priority }));
    current.session++;
    current.trail = [];
    // A respawn is a new place: no line from the grave to the bed on the
    // radar, and the 3D view reloads (it follows the old entity otherwise).
    const onSpawn = () => {
      current.spawns++;
      current.trail = [];
    };
    bot.on('spawn', onSpawn);
    view?.reset();
    const stopOverlay = view ? view.overlay(bot) : () => {};
    return () => {
      stopOverlay();
      bot.removeListener('spawn', onSpawn);
      if (current.bot === bot) {
        current.bot = null;
        current.ctx = null;
      }
    };
  }

  function close() {
    stopStream();
    view?.close();
    return new Promise((resolve) => {
      server.close(() => resolve());
    });
  }

  return { ready, attach, close, server };
}

module.exports = { startDashboard, buildState, PacedWorldView };
