// Wiring: one /stream connection feeds the live view and the decision
// stream; /api/history feeds the history view and the phase ETA.
import { $, storage, store, reducedMotion } from './util.js';
import * as live from './live.js';
import * as stream from './stream.js';
import * as historyView from './history.js';

const params = new URLSearchParams(location.search);
const overlay = params.get('overlay') === '1';
const HISTORY_EVERY_MS = 30000;
// No state for this long and the page says so, instead of showing the last
// frame as if it were live.
const STALE_AFTER_MS = 2000;
// The radar does not need sixty frames a second on a laptop that is also
// running the game; twenty looks the same.
const RADAR_FRAME_MS = 50;

// ---- boot -------------------------------------------------------------------

const BOOT = [
  '> bot dashboard',
  '> linking to localhost ............ OK',
  '> director: priority scheduler .... OK',
  '> progression: phases loaded ...... OK',
  '> water pilot: on physics ticks ... OK',
  '> jev: typed decisions ............ OK',
  '> prismarine-viewer: 3d feed ...... OK',
  '> ACCESS GRANTED',
];

function boot() {
  const box = $('boot');
  if (overlay || reducedMotion() || storage('booted', '') === String(new Date().toDateString())) {
    box.remove();
    return;
  }
  store('booted', new Date().toDateString()); // once a day is fun; every reload is not
  const pre = $('bootText');
  let i = 0;
  const step = () => {
    if (i < BOOT.length) {
      pre.textContent += `${BOOT[i++]}\n`;
      setTimeout(step, i === BOOT.length ? 380 : 140);
    } else {
      box.classList.add('done');
      setTimeout(() => box.remove(), 600);
    }
  };
  step();
  box.addEventListener('click', () => box.remove(), { once: true });
}

// ---- views --------------------------------------------------------------------

let view = overlay ? 'live' : storage('view', 'live');
let lastHistory = null;

function showView(name) {
  view = name === 'history' ? 'history' : 'live';
  store('view', view);
  $('viewLive').hidden = view !== 'live';
  $('viewHistory').hidden = view !== 'history';
  document.querySelectorAll('.tab').forEach((t) => {
    const on = t.dataset.view === view;
    t.classList.toggle('on', on);
    t.setAttribute('aria-selected', String(on));
  });
  if (view === 'history') {
    if (lastHistory) historyView.render(lastHistory);
    loadHistory();
  } else {
    live.resizeRadar();
  }
}

// ---- the 3D feed ----------------------------------------------------------------

// '0' orbit, '1' the bot's eyes, 'off' unloaded. The 3D view is the one part
// of this page that costs real memory, on the machine running the game.
let camera = storage('fp', '0');

/**
 * Where the 3D view is loaded from: the same server under its OTHER loopback
 * name. localhost and 127.0.0.1 are different sites to the browser, so the
 * view gets a process and main thread of its own instead of sharing one with
 * this page's rendering, the radar and the stream. The server listens on
 * 127.0.0.1, which both names reach.
 */
function viewerBase() {
  const { protocol, hostname, port } = location;
  const other = { localhost: '127.0.0.1', '127.0.0.1': 'localhost' }[hostname];
  return other ? `${protocol}//${other}${port ? `:${port}` : ''}` : '';
}

/** The view reports its own frame rate once a second (dashboard/viewer.html). */
function onViewerMessage(e) {
  if (e.source !== $('viewer').contentWindow || e.data?.type !== 'viewer-fps') return;
  const fps = Number(e.data.fps);
  if (!Number.isFinite(fps)) return;
  const el = $('fps3d');
  el.hidden = camera === 'off';
  el.textContent = `3D ${fps} FPS`;
  el.classList.toggle('slow', fps < 30);
}

function applyCamera(delay = 0) {
  document.querySelectorAll('.cam button').forEach((b) => {
    const on = b.dataset.cam === camera;
    b.classList.toggle('on', on);
    b.setAttribute('aria-pressed', String(on));
  });
  $('feed3d').classList.toggle('no3d', camera === 'off');
  setTimeout(() => {
    const want = camera === 'off' ? 'about:blank' : `${viewerBase()}/viewer/${camera === '1' ? '?fp=1' : ''}`;
    if (camera === 'off') $('fps3d').hidden = true;
    $('viewer').src = want;
  }, delay);
}

// A hidden tab still costs the bot: the server keeps meshing chunks and
// streaming entities to a viewer nobody is looking at, and building state
// frames for a page nobody is reading, on the machine that is also running the
// game. After a minute out of sight the viewer is unloaded and the stream
// closed; both come back with the tab, the stream resuming where it stopped.
const HIDDEN_UNLOAD_MS = 60000;
let hiddenTimer = null;
let parked = false;

function onVisibility() {
  if (document.hidden) {
    hiddenTimer = setTimeout(() => {
      parked = true;
      if (camera !== 'off') $('viewer').src = 'about:blank';
      disconnect();
    }, HIDDEN_UNLOAD_MS);
  } else {
    clearTimeout(hiddenTimer);
    if (parked) {
      parked = false;
      applyCamera();
      connect();
    }
  }
}

function setCamera(c) {
  camera = c;
  store('fp', camera);
  applyCamera();
}

/** Key 3: off, or back to whichever camera was on before. */
function toggle3d() {
  if (camera === 'off') {
    setCamera(storage('fpOn', '0'));
  } else {
    store('fpOn', camera);
    setCamera('off');
  }
}

// ---- history --------------------------------------------------------------------

let historyAt = 0;
async function loadHistory(force = false) {
  if (!force && Date.now() - historyAt < 5000) return;
  historyAt = Date.now();
  try {
    const res = await fetch('/api/history', { cache: 'no-store' });
    const h = await res.json();
    lastHistory = h;
    live.setHistory(h);
    // Rebuilding a view nobody is looking at every thirty seconds was pure
    // cost; it renders when it is shown.
    if (view === 'history') historyView.render(h);
  } catch {
    $('historyNote').textContent = 'history unavailable right now';
  }
}

// ---- the stream -----------------------------------------------------------------

let lastSession = null;
let lastSpawns = null;
let lastStateAt = 0;
let slowFields = {};
let es = null;
let lastEventId = 0;

function onState(state) {
  lastStateAt = Date.now();
  document.body.classList.remove('stale');
  // Splits, phase, markers, Jev and the trail come once a second; the frames
  // between carry only what moves, and keep the last of the rest.
  if (state.slow) {
    const {
      trail, markers, phase, splits, jev,
    } = state;
    slowFields = {
      trail, markers, phase, splits, jev,
    };
  }
  const full = { ...slowFields, ...state };
  // A new bot session means a new world connection, and a respawn a new
  // entity to follow; either way the viewer's socket belongs to the old one.
  const moved = (lastSession !== null && full.session !== lastSession)
    || (lastSpawns !== null && full.spawns !== lastSpawns);
  if (moved && camera !== 'off' && !parked) applyCamera(1500);
  lastSession = full.session;
  lastSpawns = full.spawns;
  live.render(full);
  if (full.board?.recent) stream.addDecisions(full.board.recent);
  stream.noteSplits(full.splits);
  stream.meta(full.board?.checksPerSec);
}

function connect() {
  if (es) return;
  // A manual reconnect (after the tab was hidden) says where it got to; the
  // browser's own reconnects send Last-Event-ID by themselves.
  es = new EventSource(lastEventId ? `/stream?since=${lastEventId}` : '/stream');
  es.addEventListener('state', (ev) => {
    try { onState(JSON.parse(ev.data)); } catch (err) { console.error(err); }
  });
  es.addEventListener('event', (ev) => {
    if (ev.lastEventId) lastEventId = Number(ev.lastEventId) || lastEventId;
    try { stream.addEvent(JSON.parse(ev.data), { id: Number(ev.lastEventId) || null }); } catch (err) { console.error(err); }
  });
  es.onerror = () => {
    $('live').className = 'live off';
    $('liveText').textContent = 'RELINKING';
  };
}

function disconnect() {
  if (!es) return;
  es.close();
  es = null;
}

/** No frame for a while: the bot, the server or the link is gone. Say so. */
function staleWatch() {
  if (parked || !lastStateAt) return;
  const stale = Date.now() - lastStateAt > STALE_AFTER_MS;
  document.body.classList.toggle('stale', stale);
  if (stale) {
    $('live').className = 'live off';
    $('liveText').textContent = 'NO SIGNAL';
    $('offline').classList.add('show');
  }
}

// The radar is drawn only while it is actually on screen.
let radarVisible = true;
function watchRadar() {
  if (typeof window.IntersectionObserver !== 'function') return;
  const io = new window.IntersectionObserver((entries) => {
    radarVisible = entries.some((e) => e.isIntersecting);
  });
  io.observe($('radar'));
}

let lastRadarAt = 0;
function radarLoop(t) {
  if (!document.hidden && view === 'live' && !overlay && radarVisible && t - lastRadarAt >= RADAR_FRAME_MS) {
    lastRadarAt = t;
    try { live.drawRadar(t); } catch { /* keep animating */ }
  }
  requestAnimationFrame(radarLoop);
}

// ---- keys -------------------------------------------------------------------

let keysOn = storage('keys', '1') === '1';

function onKey(e) {
  if (!keysOn || e.ctrlKey || e.metaKey || e.altKey) return;
  // Typing, or operating a control: the key belongs to that.
  if (e.target instanceof window.HTMLInputElement || e.target instanceof window.HTMLButtonElement) {
    if (e.key !== 'Escape') return;
  }
  const k = e.key.toLowerCase();
  if (k === '1') showView('live');
  else if (k === '2') showView('history');
  else if (k === '3') toggle3d();
  else if (k === 's') stream.setSound(!stream.soundEnabled());
  else if (k === 'escape') stream.closeDeath();
}

// ---- start ------------------------------------------------------------------

function start() {
  // OBS layers the page over the game, so the page itself must be see-through.
  if (overlay) { document.documentElement.classList.add('overlay'); document.body.classList.add('overlay'); }
  boot();
  stream.init({ overlay });
  historyView.init();
  document.querySelectorAll('.tab').forEach((t) => t.addEventListener('click', () => showView(t.dataset.view)));
  document.querySelectorAll('.cam button').forEach((b) => b.addEventListener('click', () => setCamera(b.dataset.cam)));
  document.addEventListener('keydown', onKey);
  document.addEventListener('visibilitychange', onVisibility);
  window.addEventListener('message', onViewerMessage);
  window.addEventListener('resize', () => live.resizeRadar());
  $('keys').checked = keysOn;
  $('keys').addEventListener('change', (e) => {
    keysOn = e.target.checked;
    store('keys', keysOn ? '1' : '0');
  });
  showView(view);
  applyCamera();
  connect();
  if (view !== 'history') loadHistory(true); // showView already asked for it
  setInterval(() => loadHistory(true), HISTORY_EVERY_MS);
  setInterval(staleWatch, 500);
  watchRadar();
  requestAnimationFrame(radarLoop);
}

start();
