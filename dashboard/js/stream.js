// The decision stream: every pick and preemption from the director, merged
// with what the log says happened, as terminal lines. Also owns the moments
// worth interrupting the viewer for: milestone toasts and the death replay.
import { $, pretty, clock, mmss, info, reducedMotion, storage, store } from './util.js';

const MAX_LINES = 220;
const REPLAY_MS = 10000; // how far back the death card looks
// Decisions reach the page with the state, up to a quarter second after the
// log line they explain: the last preemption before a death came after it.
const REPLAY_AFTER_MS = 300;
const STALE_MS = 15000; // older than this is backlog from before the page opened: no toast, no card

// Log lines that are true but tell a viewer nothing.
const CHATTER = new Set([
  'State transition', 'World', 'Listener baseline recorded', 'Event loop stalled — the bot could not react',
  'Behavior kept doing nothing — backing it off', 'Foraging toward better ground', 'Searching for food',
  'Hungry underground — heading for the surface', 'Going up to stock food for the trip', 'Preempting behavior',
  'Heading for food', 'Capabilities', 'Combat engine ready', 'Session started', 'Raw meat off the menu; cook it instead',
  'Could not reach the crafting table this time — will try again', 'Jev usage',
]);

let filter = storage('streamFilter', 'all');
let overlayMode = false;
// Log lines already shown, by server id (and by time + message for a line
// without one): a reconnect must not print the story twice.
const seenEvents = new Set();
const seenDeaths = new Set();
let lastFocus = null;
let soundOn = storage('sound', '0') === '1';
const seenDecisions = new Set();
const history = []; // every line, filtered or not, for the death replay
const rates = { decisions: [], events: [] };

function brief(data) {
  if (!data || typeof data !== 'object') return '';
  return Object.entries(data).slice(0, 3).map(([k, v]) => {
    let val = v;
    if (v && typeof v === 'object') val = ('x' in v && 'z' in v) ? `${Math.round(v.x)},${Math.round(v.y ?? 0)},${Math.round(v.z)}` : JSON.stringify(v).slice(0, 40);
    return `${k} ${val}`;
  }).join(' · ');
}

/** A log entry as a stream line: a verb, what, and why. */
function describe(e) {
  const d = e.data ?? {};
  const m = e.message;
  if (m.startsWith('Out of order: ')) {
    return { v: 'BYPASS', c: 'bypass', w: `${m.slice(14)} · ${d.why ?? ''}`, y: d.phase ? `phase ${d.phase}` : '' };
  }
  if (m.startsWith('Resource decision')) {
    return { v: 'JEV', c: 'jev', w: `${pretty(d.input?.block_type ?? d.ore ?? 'ore')} → ${d.decision ?? '?'}`, y: d.latencyMs != null ? `${d.latencyMs}ms` : '' };
  }
  switch (m) {
    case 'Crafted': return { v: 'CRAFT', c: 'craft', w: `${d.item}${d.count > 1 ? ` ×${d.count}` : ''}` };
    case 'Chopped tree': return { v: 'WOOD', c: 'craft', w: `whole tree · ${d.logs} logs`, y: d.leftStanding ? `${d.leftStanding} out of reach` : '' };
    case 'Gathered stone': return { v: 'STONE', c: 'craft', w: `${d.stoneMaterial ?? '?'} / ${d.target ?? '?'} stone` };
    case 'Hunting': return { v: 'HUNT', c: 'hunt', w: `${d.animal}`, y: d.weapon ? `with ${pretty(d.weapon)}` : '' };
    case 'Hunt finished': return { v: 'HUNT', c: 'hunt', w: d.killed ? `caught ${d.animal}` : `${d.animal} got away`, y: d.foodStock != null ? `${d.foodStock} food in the bag` : '' };
    case 'Smelting': return { v: 'SMELT', c: 'craft', w: `${d.count} ${pretty(d.input)}`, y: d.readyInSec ? `ready in ${d.readyInSec}s` : '' };
    case 'Collected from the furnace': return { v: 'SMELT', c: 'craft', w: `collected ${d.count} ${pretty(d.item)}` };
    case 'Phase complete': return { v: 'PHASE', c: 'phase', w: `${String(d.phase).toUpperCase()} COMPLETE${d.tookSec != null ? ` in ${mmss(d.tookSec * 1000)}` : ''}`, y: d.next ? `next ${d.next}` : '' };
    case 'Back to an earlier phase': return { v: 'PHASE', c: 'preempt', w: `back to ${String(d.to).toUpperCase()}`, y: d.why ? `need ${d.why}` : '' };
    case 'Progression': return { v: 'PHASE', c: 'phase', w: `plan: ${String(d.phase).toUpperCase()}`, y: d.need ? `need ${d.need}` : '' };
    case 'Strategy': return { v: 'JEV', c: 'jev', w: `focus ${d.focus} ${Math.round((d.confidence ?? 0) * 100)}%`, y: `risk ${d.risk ?? '?'}${d.latencyMs != null ? ` · ${d.latencyMs}ms` : ''}${d.withOres ? ` · +${d.withOres.length} ore` : ''}` };
    case 'Took avoidable damage': return { v: 'HURT', c: 'hurt', w: `-${d.lost} from ${d.cause}`, y: `${d.health} hp · while ${info(d.doing).label.toLowerCase()}` };
    case 'Bot died': return { v: 'DIED', c: 'died', w: `killed by ${d.killedBy ?? 'something'}` };
    case 'Bot spawned': return { v: 'SPAWN', c: 'pick', w: 'joined the world', y: d.pos ? `at ${Math.round(d.pos.x)}, ${Math.round(d.pos.y)}, ${Math.round(d.pos.z)}` : '' };
    case 'Playing in world': return { v: 'WORLD', c: 'info', w: String(d.world ?? '') };
    case 'Stuck in water — getting out': return { v: 'WATER', c: 'water', w: 'stuck in water — getting out', y: d.submerged ? 'under the surface' : '' };
    case 'Reached dry land': return { v: 'WATER', c: 'water', w: 'reached dry land', y: d.how ?? '' };
    case 'Built a landing in the water': return { v: 'WATER', c: 'water', w: 'built a landing block', y: `against ${d.against}` };
    case 'Climbed out of the water': return { v: 'WATER', c: 'water', w: `climbed out · ${d.how}`, y: `up ${d.risenBy}` };
    case 'Re-entered water': return { v: 'WATER', c: 'hurt', w: 'back in the water', y: `${Math.round((d.sinceExitMs ?? 0) / 1000)}s after leaving · ${d.behavior ?? '?'}` };
    case 'Running out of air — surfacing': return { v: 'AIR', c: 'died', w: `air ${d.air} — surfacing`, y: d.capped ? 'under a lid' : '' };
    case 'Swimming for air': return { v: 'AIR', c: 'water', w: `swimming for air · ${d.steps} steps`, y: `${d.routeTicks} of ${d.budgetTicks} ticks` };
    case 'Digging toward air': return { v: 'AIR', c: 'water', w: `digging ${d.block} toward air`, y: `${d.ticks} of ${d.budgetTicks} ticks${d.standingOnTheFloor ? ' · from the floor' : ''}` };
    case 'Breathing again': return { v: 'AIR', c: 'pick', w: 'breathing again' };
    case 'Kicked from server': return { v: 'KICKED', c: 'died', w: brief(d) };
    case 'Disconnected — reconnecting': return { v: 'LINK', c: 'hurt', w: 'lost the connection, reconnecting' };
    default: break;
  }
  const verb = { warn: 'WARN', error: 'ERROR', action: 'DO', decision: 'JEV' }[e.level] ?? 'INFO';
  const cls = { warn: 'hurt', error: 'died', action: 'craft', decision: 'jev' }[e.level] ?? 'info';
  return { v: verb, c: cls, w: m, y: brief(d) };
}

function decisionLine(r) {
  const held = [];
  // The emergencies at the top say no nearly every time; the interesting
  // refusals are the ones just above the winner.
  if (r.no?.length) held.push(`no: ${r.no.length > 3 ? `${r.no.length - 3} more, ` : ''}${r.no.slice(-3).join(', ')}`);
  if (r.phase?.length) held.push(`held by phase: ${r.phase.slice(0, 3).join(', ')}${r.phase.length > 3 ? ` +${r.phase.length - 3}` : ''}`);
  if (r.backedOff?.length) held.push(`resting: ${r.backedOff.join(', ')}`);
  return r.mode === 'preempt'
    ? { v: 'PREEMPT', c: 'preempt', w: `${r.chosen} takes the wheel`, y: `p${r.priority}${held.length ? ` · ${held.join(' · ')}` : ''}` }
    : { v: 'PICK', c: 'pick', w: `${r.chosen}`, y: `p${r.priority}${held.length ? ` · ${held.join(' · ')}` : ''}` };
}

function visible(kind) {
  return filter === 'all' || filter === kind;
}

function append(line) {
  history.push(line);
  while (history.length > 400) history.shift();
  rates[line.kind === 'decisions' ? 'decisions' : 'events'].push(line.ts);
  if (!visible(line.kind)) return;
  const list = $('stream');
  const nearBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 40;
  const last = list.lastElementChild;
  // Decisions arrive with the state, up to a quarter second after the log
  // lines around them: put a late line where its time says it belongs.
  if (last && Number(last.dataset.ts) > line.ts) {
    let after = last;
    while (after.previousElementSibling && Number(after.previousElementSibling.dataset.ts) > line.ts) after = after.previousElementSibling;
    list.insertBefore(renderLine(line, false), after);
    while (list.children.length > MAX_LINES) list.firstElementChild.remove();
    return;
  }
  // The same thing twice in a row is one line with a count, not two.
  if (last && last.dataset.sig === line.sig) {
    last.dataset.ts = line.ts;
    const n = Number(last.dataset.n) + 1;
    last.dataset.n = n;
    last.querySelector('.t').textContent = clock(line.ts);
    last.querySelector('.x').textContent = ` ×${n}`;
  } else {
    list.append(renderLine(line, !reducedMotion()));
    while (list.children.length > MAX_LINES) list.firstElementChild.remove();
  }
  if (nearBottom) list.scrollTop = list.scrollHeight;
}

function renderLine(line, animate) {
  const li = document.createElement('li');
  if (animate) li.className = 'new';
  li.dataset.sig = line.sig;
  li.dataset.ts = line.ts;
  li.dataset.n = 1;
  const parts = [['t', clock(line.ts)], [`v v-${line.c}`, line.v], ['w', line.w], ['y', line.y ?? ''], ['x', '']];
  parts.forEach(([cls, text], i) => {
    const span = document.createElement('span');
    span.className = cls;
    span.textContent = text;
    li.append(span);
    if (i < 3 && text) li.append(' ');
  });
  return li;
}

function redraw() {
  const list = $('stream');
  list.innerHTML = '';
  const frag = document.createDocumentFragment();
  let prev = null;
  const lines = history.filter((l) => visible(l.kind)).sort((a, b) => a.ts - b.ts).slice(-MAX_LINES);
  for (const line of lines) {
    if (prev && prev.dataset.sig === line.sig) {
      const n = Number(prev.dataset.n) + 1;
      prev.dataset.n = n;
      prev.querySelector('.x').textContent = ` ×${n}`;
      continue;
    }
    prev = renderLine(line, false);
    frag.append(prev);
  }
  list.append(frag);
  list.scrollTop = list.scrollHeight;
}

// ---- inputs -------------------------------------------------------------------

export function addEvent(raw, { id = null } = {}) {
  if (!raw?.message) return;
  const key = id ?? `${raw.ts}|${raw.message}`;
  if (seenEvents.has(key)) return;
  seenEvents.add(key);
  if (seenEvents.size > 3000) {
    const keep = [...seenEvents].slice(-1000);
    seenEvents.clear();
    keep.forEach((k) => seenEvents.add(k));
  }
  if (CHATTER.has(raw.message)) return;
  // The log stamps ISO strings; everything here compares numbers.
  const entry = { ...raw, ts: typeof raw.ts === 'number' ? raw.ts : (Date.parse(raw.ts) || Date.now()) };
  const view = describe(entry);
  append({ ...view, ts: entry.ts, kind: 'events', sig: `e|${view.v}|${view.w}` });
  const fresh = Date.now() - entry.ts < STALE_MS;
  if (!fresh) return;
  if (entry.message === 'Phase complete') {
    toast('PHASE COMPLETE', `${String(entry.data?.phase ?? '').toUpperCase()} ✓`, entry.data?.next ? `next: ${entry.data.next}` : '');
  } else if (entry.message === 'Bot died' && !seenDeaths.has(entry.ts)) {
    seenDeaths.add(entry.ts);
    // Replay what led up to it once the decisions around it have arrived.
    if (!overlayMode) setTimeout(() => showDeath(entry), REPLAY_AFTER_MS);
  }
}

export function addDecisions(recent) {
  for (const r of recent ?? []) {
    const key = `${r.at}|${r.mode}|${r.chosen}`;
    if (seenDecisions.has(key)) continue;
    seenDecisions.add(key);
    const view = decisionLine(r);
    append({ ...view, ts: r.at, kind: 'decisions', sig: `d|${r.mode}|${r.chosen}` });
  }
  if (seenDecisions.size > 2000) {
    const keep = [...seenDecisions].slice(-500);
    seenDecisions.clear();
    keep.forEach((k) => seenDecisions.add(k));
  }
}

let lastSplits = null;
/** A milestone this life just reached (it had no time a moment ago) earns a toast. */
export function noteSplits(splits) {
  if (!splits) return;
  if (lastSplits && lastSplits.life === splits.life) {
    for (const row of splits.rows) {
      const before = lastSplits.rows.find((r) => r.id === row.id);
      if (before && before.at === null && row.at !== null) {
        const best = row.worldBest ?? row.overallBest;
        const vs = best ? ` · ${row.at <= best ? 'NEW BEST' : `best ${mmss(best)}`}` : '';
        toast('ACCESS GRANTED', row.label.toUpperCase(), `${mmss(row.at)} into this life${vs}`);
      }
    }
  }
  lastSplits = splits;
}

/** Decisions and events per minute, for the line above the stream. */
export function meta(checksPerSec) {
  const cutoff = Date.now() - 60000;
  for (const k of Object.keys(rates)) while (rates[k].length && rates[k][0] < cutoff) rates[k].shift();
  const bits = [`${rates.decisions.length} decisions/min`, `${rates.events.length} events/min`];
  if (Number.isFinite(checksPerSec)) bits.unshift(`${Math.round(checksPerSec)} checks/s`);
  $('streamMeta').textContent = bits.join(' · ');
}

// ---- toasts, sound, the death card ------------------------------------------

let audio = null;
function beep(freqs) {
  if (!soundOn) return;
  try {
    audio = audio ?? new AudioContext();
    const t0 = audio.currentTime;
    freqs.forEach((f, i) => {
      const osc = audio.createOscillator();
      const gain = audio.createGain();
      osc.type = 'square';
      osc.frequency.value = f;
      gain.gain.setValueAtTime(0.05, t0 + i * 0.09);
      gain.gain.exponentialRampToValueAtTime(0.0001, t0 + i * 0.09 + 0.08);
      osc.connect(gain).connect(audio.destination);
      osc.start(t0 + i * 0.09);
      osc.stop(t0 + i * 0.09 + 0.09);
    });
  } catch { /* no audio: silence is fine */ }
}

export function toast(kicker, main, sub = '') {
  const box = document.createElement('div');
  box.className = 'toast';
  box.setAttribute('role', 'status');
  box.innerHTML = '<div class="k"></div><div class="m"></div><div class="s"></div>';
  box.querySelector('.k').textContent = `▶ ${kicker}`;
  box.querySelector('.m').textContent = main;
  box.querySelector('.s').textContent = sub;
  $('toasts').append(box);
  while ($('toasts').children.length > 4) $('toasts').firstElementChild.remove();
  beep([660, 880, 1320]);
  setTimeout(() => box.classList.add('gone'), 6000);
  setTimeout(() => box.remove(), 6800);
}

function showDeath(entry) {
  const d = entry.data ?? {};
  const bySource = Object.entries(d.healthLostThisLife ?? d.healthLostBySource ?? {}).map(([k, v]) => `${k} ${v}`).join(', ');
  const at = d.at ? ` at ${Math.round(d.at.x)}, ${Math.round(d.at.y)}, ${Math.round(d.at.z)}` : '';
  $('deathWhy').textContent = `Killed by ${d.killedBy ?? 'something'}${at}.${bySource ? ` Health lost to: ${bySource}.` : ''}`;
  const since = entry.ts - REPLAY_MS;
  const replay = history.filter((l) => l.ts >= since && l.ts <= entry.ts + REPLAY_AFTER_MS)
    .sort((a, b) => a.ts - b.ts);
  const list = $('deathReplay');
  list.innerHTML = '';
  for (const line of replay) {
    const li = renderLine(line, false);
    li.querySelector('.t').textContent = `T-${(Math.max(0, entry.ts - line.ts) / 1000).toFixed(1)}s`;
    list.append(li);
  }
  if (!replay.length) list.innerHTML = '<li>nothing logged in the last 10 seconds</li>';
  lastFocus = document.activeElement;
  $('death').hidden = false;
  $('deathClose').focus();
  beep([440, 330, 220, 110]);
}

export function closeDeath() {
  if ($('death').hidden) return;
  $('death').hidden = true;
  // Back to where the reader was, not the top of the page.
  if (lastFocus && typeof lastFocus.focus === 'function') lastFocus.focus();
  lastFocus = null;
}

export function setSound(on) {
  soundOn = on;
  store('sound', on ? '1' : '0');
  $('sound').checked = on;
  if (on) beep([880]);
}

export function init({ overlay = false } = {}) {
  // An OBS overlay cannot click a modal away: no death card there.
  overlayMode = overlay;
  $('sound').checked = soundOn;
  $('sound').addEventListener('change', (e) => setSound(e.target.checked));
  $('deathClose').addEventListener('click', closeDeath);
  // Tab stays inside the dialog while it is open (it has one control).
  $('death').addEventListener('keydown', (e) => {
    if (e.key === 'Tab') {
      e.preventDefault();
      $('deathClose').focus();
    }
  });
  const buttons = document.querySelectorAll('.terminal .filters button');
  const mark = () => buttons.forEach((b) => {
    b.classList.toggle('on', b.dataset.filter === filter);
    b.setAttribute('aria-pressed', String(b.dataset.filter === filter));
  });
  mark();
  buttons.forEach((btn) => {
    btn.addEventListener('click', () => {
      filter = btn.dataset.filter;
      store('streamFilter', filter);
      mark();
      redraw();
    });
  });
}

export const soundEnabled = () => soundOn;
