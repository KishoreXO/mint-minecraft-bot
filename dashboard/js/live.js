// The live view: everything drawn from the /stream `state` messages.
import {
  $, pretty, clamp, mmss, info, itemImg, setImg, syncList, PHASE_MILESTONE,
} from './util.js';

let lastDoing = null;
let lastChosen = null;
let lastInv = {};
let history = null; // /api/history, for the phase ETA
let radarState = null; // the latest state, for the radar's own animation frames

// Hostiles further above or below than this are in a cave under us or on a
// cliff over us: on the radar, but not a threat to the bot right now.
const THREAT_DY = 12;

export function setHistory(h) {
  history = h;
}

/** The radar and threat chip only count what the radar can show. */
function inRange(state, e) {
  const range = state.radarRange ?? 32;
  const me = state.status?.world?.pos;
  return e.d <= range && (!me || Math.abs(e.y - me.y) <= THREAT_DY);
}

export function render(state) {
  const error = state.status?.error ?? null;
  const online = !!state.connected && !!state.status && !error;
  $('live').className = `live ${online ? 'on' : 'off'}`;
  $('liveText').textContent = online ? 'LIVE' : (error ? 'STATUS ERROR' : 'NO SIGNAL');
  $('offline').classList.toggle('show', !online);
  $('offlineText').textContent = error
    ? `The bot is connected but its status could not be read: ${error}`
    : 'Waiting for the world. Open it to LAN and the bot joins by itself.';
  $('uptime').textContent = mmss(state.uptimeSec * 1000);
  $('deaths').textContent = String(state.deathsThisRun ?? 0);
  if (!online) {
    // Nothing on the radar is live any more; drawing the last mobs as if they
    // were is how an empty screen looked busy.
    radarState = null;
    $('radarNote').textContent = 'no signal';
    return;
  }

  const s = state.status;
  const name = String(s.username || 'bot');
  $('botName').textContent = name.toUpperCase();
  // The name is BOT_NAME in .env, so the tab says whichever bot this is.
  const title = `${name} — live`;
  if (document.title !== title) document.title = title;
  $('ping').textContent = state.ping == null ? '–' : `${state.ping}ms`;
  $('cps').textContent = Number.isFinite(state.board?.checksPerSec) ? String(Math.round(state.board.checksPerSec)) : '–';
  const stalls = s.lag?.stalls;
  $('stalls').textContent = stalls == null ? '–' : String(stalls);
  $('stalls').className = stalls > 30 ? 'amber' : '';
  $('radarTitle').textContent = `RADAR // ${state.radarRange ?? 32}`;

  renderDaytime(s.time);
  renderNow(s, state);
  renderWhere(s, state);
  renderVitals(s);
  renderWater(s);
  renderCompass(s.world.yaw ?? 0);
  renderPhases(state);
  renderSupplies(s);
  renderSplits(state);
  renderBag(s);
  renderBoard(state);
  renderJev(state);
  renderRadarNote(state);
  radarState = state;
}

function renderDaytime(t) {
  $('day').textContent = `DAY ${t.day ?? '–'}`;
  $('dusk').textContent = t.isNight ? `dawn in ${mmss(t.secondsUntilDawn * 1000)}` : `dusk in ${mmss(t.secondsUntilDusk * 1000)}`;
  document.querySelector('.daytime').classList.toggle('night', !!t.isNight);
}

function renderNow(s, state) {
  const doing = s.doing || 'nothing';
  const meta = info(doing);
  const now = $('now');
  if (doing !== lastDoing) {
    now.classList.remove('flash');
    void now.offsetWidth; // restart the animation
    now.classList.add('flash');
    lastDoing = doing;
  }
  now.classList.toggle('urgent', !!meta.urgent);
  $('nowTag').textContent = meta.urgent ? '▶ OVERRIDE' : '▶ EXECUTING';
  $('nowText').textContent = meta.label;
  setImg($('nowIcon'), meta.icon);
  const bits = [];
  if (s.doingSince) bits.push(`for ${mmss(Date.now() - s.doingSince)}`);
  if (s.priority != null && s.priority >= 0) bits.push(`priority ${s.priority}`);
  if (state.phase?.label) bits.push(`phase ${state.phase.label.toUpperCase()}`);
  if (s.blocked) bits.push(`waiting on ${s.blocked}`);
  $('nowSub').textContent = bits.join(' · ');
}

function threatLevel(state, hostiles) {
  const near = hostiles.filter((e) => e.d <= 8).length;
  const hp = state.status.vitals.health;
  if ((near >= 2 && hp <= 10) || (near >= 1 && hp <= 6)) return ['CRITICAL', 't-critical'];
  if (near >= 2 || (near && hp <= 12)) return ['HIGH', 't-high'];
  if (hostiles.length) return ['ELEVATED', 't-elevated'];
  return ['LOW', 't-low'];
}

function renderWhere(s, state) {
  const p = s.world.pos;
  $('coords').textContent = `X ${Math.round(p.x)} Y ${Math.round(p.y)} Z ${Math.round(p.z)}`;
  const depth = p.y <= -40 ? 'DIAMOND DEPTH' : (p.y <= 16 && s.world.underground ? 'IRON DEPTH' : (s.world.underground ? 'UNDERGROUND' : 'SURFACE'));
  $('biome').textContent = `${pretty(s.world.biome ?? 'unknown').toUpperCase()} · ${depth}`;
  const hostiles = (state.entities ?? []).filter((e) => e.kind === 'hostile' && inRange(state, e));
  const [level, cls] = threatLevel(state, hostiles);
  const chip = $('threat');
  chip.className = `chip ${cls}`;
  chip.textContent = `THREAT ${level} · ${hostiles.length} hostile${hostiles.length === 1 ? '' : 's'}`;
}

function segments(el, value, max = 20) {
  if (el.children.length !== 10) {
    el.innerHTML = '';
    for (let i = 0; i < 10; i++) el.appendChild(document.createElement('i'));
  }
  [...el.children].forEach((seg, i) => seg.classList.toggle('on', value - i * (max / 10) >= max / 20));
}

function renderVitals(s) {
  const { health, food, inWater } = s.vitals;
  const air = clamp(s.water?.air ?? s.vitals.air ?? 20, 0, 20);
  const reserve = s.water?.airReserve ?? 8;
  segments($('hpSegs'), health);
  segments($('foodSegs'), food);
  $('hpSegs').classList.toggle('low', health <= 6);
  $('foodSegs').classList.toggle('low', food <= 6);
  $('hpNum').textContent = `${Math.round(health)}/20`;
  $('foodNum').textContent = `${food}/20`;
  const showAir = air < 20 || inWater;
  $('airRow').hidden = !showAir;
  if (showAir) {
    segments($('airSegs'), air);
    $('airSegs').classList.toggle('low', air <= reserve);
    $('airNum').textContent = `${air}/20`;
  }
  const held = s.gear.held;
  if (held) setImg($('heldIcon'), held);
  else { $('heldIcon').dataset.name = ''; $('heldIcon').style.visibility = 'hidden'; }
  $('heldName').textContent = held ? pretty(held) : 'empty hand';
}

/** What the bot is doing about water, in one chip — see src/water.js. */
function renderWater(s) {
  const w = s.water;
  const chip = $('waterChip');
  const show = !!w && (w.inWater || !!w.escape);
  chip.hidden = !show;
  if (!show) return;
  const urgent = w.mode === 'surfacing for air' || (w.submerged && w.air <= w.airReserve);
  chip.className = `chip water${urgent ? ' urgent' : ''}${w.escape ? ' climbing' : ''}`;
  chip.textContent = `${String(w.mode ?? 'in water').toUpperCase()}${w.submerged ? ` · AIR ${w.air}` : ''}`;
}

// Forward is (-sin yaw, -cos yaw): yaw 0 faces north (-z), increasing westward.
const COMPASS = ['N', '·', 'NW', '·', 'W', '·', 'SW', '·', 'S', '·', 'SE', '·', 'E', '·', 'NE', '·'];
let compassStep = 0;
function renderCompass(yaw) {
  const el = $('compass');
  let strip = el.firstElementChild;
  if (!strip) {
    strip = document.createElement('div');
    strip.className = 'strip';
    const marks = [...COMPASS, ...COMPASS, ...COMPASS];
    strip.innerHTML = marks.map((m) => (m === 'N' ? '<b>N</b>' : m)).join('&nbsp;&nbsp;&nbsp;');
    el.appendChild(strip);
  }
  // Measured once: reading scrollWidth four times a second forced a layout
  // of the whole page each time.
  if (!compassStep) compassStep = strip.scrollWidth / (COMPASS.length * 3);
  const step = compassStep;
  if (!step) return;
  const turn = (((yaw / (Math.PI * 2)) % 1) + 1) % 1;
  const offset = (COMPASS.length + turn * COMPASS.length) * step;
  strip.style.left = `${150 - offset - step / 3}px`;
}

function renderPhases(state) {
  const ph = state.phase;
  const list = $('phases');
  if (!ph) return;
  $('pipelineTitle').textContent = `PROGRESSION // ${ph.phases.length} PHASES TO A DIAMOND KIT`;
  syncList(list, ph.phases, (p) => p.id, () => {
    const li = document.createElement('li');
    li.className = 'phase';
    li.innerHTML = '<div class="tag"></div><div class="name"></div><div class="time"></div>';
    return li;
  }, (li, p, i) => {
    const done = i < ph.index;
    const now = i === ph.index;
    li.className = `phase${done ? ' done' : ''}${now ? ' current' : ''}`;
    li.querySelector('.tag').textContent = done ? 'COMPLETE' : now ? 'IN PROGRESS' : 'LOCKED';
    li.querySelector('.name').textContent = p.label.toUpperCase();
    li.querySelector('.time').textContent = now ? (ph.need ?? '') : done ? '✓' : '—';
  });
  const bits = [`phase ${Math.min(ph.index + 1, ph.phases.length)} of ${ph.phases.length}`, `in it ${mmss(ph.sinceMs)}`];
  if (ph.need) bits.push(`need ${ph.need}`);
  const eta = phaseEta(ph, state.splits);
  if (eta !== null) bits.push(`ETA ${mmss(eta)} (typical)`);
  $('phaseNote').textContent = bits.join(' · ');
}

/** Typical time left: the average life reaches this phase's milestone at X; we are at Y. */
function phaseEta(ph, splits) {
  const milestone = PHASE_MILESTONE[ph.id];
  if (!milestone || !splits || !splits.fresh) return null; // a continued run's clock started elsewhere
  const row = splits.rows.find((r) => r.id === milestone);
  const typical = row?.worldMean ?? row?.overallMean ?? history?.overall?.find((m) => m.id === milestone)?.median;
  if (!typical) return null;
  const left = typical - splits.elapsedMs;
  return left > 0 ? left : null;
}

/**
 * Have / need for the next trip down: the question "why is it still on the
 * surface?" answered in one row. The server already sent this; nothing drew it.
 */
const SUPPLY_ICONS = {
  wood: 'oak_planks', cobble: 'cobblestone', food: 'cooked_beef', coal: 'coal', iron: 'raw_iron', diamond: 'diamond',
};
function renderSupplies(s) {
  const p = s.progress;
  if (!p) return;
  const rows = Object.entries(p).map(([name, v]) => {
    let text;
    let ok;
    if (v.need != null) {
      text = `${v.have}/${v.need}`;
      ok = v.have >= v.need;
    } else if (v.stillToMine != null) {
      text = `${v.have} · ${v.stillToMine} to go`;
      ok = v.stillToMine === 0;
    } else {
      text = String(v.have);
      ok = null;
    }
    return { name, text, ok };
  });
  syncList($('supplies'), rows, (r) => r.name, (r) => {
    const el = document.createElement('div');
    el.className = 'sup';
    el.append(itemImg(SUPPLY_ICONS[r.name] ?? r.name));
    const label = document.createElement('span');
    label.className = 'lbl';
    label.textContent = r.name.toUpperCase();
    const val = document.createElement('b');
    el.append(label, val);
    return el;
  }, (el, r) => {
    el.className = `sup${r.ok === true ? ' ok' : r.ok === false ? ' short' : ''}`;
    el.querySelector('b').textContent = r.text;
    el.title = `${r.name}: ${r.text}`;
  });
}

function renderSplits(state) {
  const sp = state.splits;
  const body = $('splits');
  if (!sp) {
    $('splitsTitle').textContent = 'SPLITS';
    $('splitsNote').textContent = '';
    body.innerHTML = '<tr><td colspan="5" class="pnote">no history for this world yet</td></tr>';
    $('tickers').textContent = '';
    return;
  }
  $('splitsTitle').textContent = `SPLITS // LIFE ${sp.life}`;
  $('splitsNote').textContent = `${sp.fresh ? 'fresh start' : 'continued run'} · ${mmss(sp.elapsedMs)} in`;
  if (body.firstElementChild && !body.firstElementChild.dataset.key) body.innerHTML = '';
  syncList(body, sp.rows, (r) => r.id, () => {
    const tr = document.createElement('tr');
    tr.innerHTML = '<td></td><td></td><td></td><td></td><td></td>';
    return tr;
  }, (tr, r) => {
    const best = r.worldBest ?? r.overallBest;
    const avg = r.worldMean ?? r.overallMean;
    const cells = tr.children;
    tr.className = r.at === null ? 'pending' : '';
    cells[0].textContent = r.label;
    cells[1].textContent = r.at === null ? '—' : mmss(r.at);
    cells[2].textContent = best === null || best === undefined ? '—' : mmss(best);
    cells[3].textContent = avg === null || avg === undefined ? '—' : mmss(avg);
    if (r.at !== null && best) {
      const delta = r.at - best;
      cells[4].textContent = `${delta <= 0 ? '-' : '+'}${mmss(Math.abs(delta))}`;
      cells[4].className = delta <= 0 ? 'ahead' : 'behind';
    } else {
      cells[4].textContent = '';
      cells[4].className = '';
    }
  });
  const c = sp.counters ?? {};
  const n = (v) => (Number.isFinite(v) ? v : 0);
  const mins = Math.max(sp.elapsedMs / 60000, 0.5);
  $('tickers').innerHTML = `<span>logs/min <b>${(n(c.logs) / mins).toFixed(1)}</b></span>`
    + `<span>stone/min <b>${(n(c.stone) / mins).toFixed(1)}</b></span>`
    + `<span>ores/hr <b>${Math.round((n(c.ores) / mins) * 60)}</b></span>`
    + `<span>kills <b>${n(c.kills)}</b></span>`;
}

function renderBag(s) {
  const inv = s.inventory ?? {};
  const entries = Object.entries(inv).sort((a, b) => b[1] - a[1]);
  // Cells are kept by item name: rebuilding them on every count change
  // reloaded each picture and the whole bag blinked while chopping.
  const fresh = Object.keys(lastInv).length > 0;
  syncList($('bag'), entries, ([name]) => name, ([name]) => {
    const cell = document.createElement('div');
    cell.className = 'cell';
    if (fresh && !(name in lastInv)) cell.classList.add('new');
    const n = document.createElement('span');
    n.className = 'n';
    cell.append(itemImg(name), n);
    return cell;
  }, (cell, [name, count]) => {
    cell.title = `${pretty(name)} × ${count}`;
    cell.querySelector('.n').textContent = count > 1 ? (count > 999 ? '999+' : count) : '';
  });
  lastInv = inv;
  $('invCount').textContent = `${entries.length} kinds · ${entries.reduce((t, [, c]) => t + c, 0)} items`;

  const g = s.gear;
  const slots = [
    ['WEAPON', g.weapon], ['PICKAXE', g.pickaxe], ['SHIELD', g.shield ? 'shield' : null],
    ...(g.armor ?? []).map((a) => ['ARMOUR', String(a).split(' ')[0]]),
  ];
  const gear = $('gear');
  const gearKey = slots.map((x) => x[1]).join('|');
  if (gear.dataset.key !== gearKey) {
    gear.dataset.key = gearKey;
    gear.innerHTML = '';
    for (const [label, item] of slots) {
      const el = document.createElement('div');
      el.className = `g${item ? '' : ' missing'}`;
      if (item) el.append(itemImg(item));
      const t = document.createElement('span');
      t.textContent = item ? pretty(item) : `no ${label.toLowerCase()}`;
      el.append(t);
      gear.append(el);
    }
  }
}

function renderBoard(state) {
  const list = [...(state.behaviors ?? [])].sort((a, b) => b.priority - a.priority);
  const pick = state.board?.pick;
  const verdicts = new Map((pick?.asked ?? []).map((a) => [a.name, a]));
  const doing = state.status.doing;
  const now = Date.now();
  syncList($('board'), list, (b) => b.name, (b) => {
    const li = document.createElement('li');
    li.className = 'b-row';
    const meta = info(b.name);
    if (meta.urgent) li.classList.add('urgent');
    li.append(itemImg(meta.icon));
    const name = document.createElement('div');
    name.className = 'b-name';
    name.textContent = meta.label;
    const pri = document.createElement('div');
    pri.className = 'b-pri';
    li.append(name, pri);
    return li;
  }, (li, b) => {
    const v = verdicts.get(b.name);
    const backed = v?.verdict === 'backed-off' || state.status.backedOff.includes(b.name);
    li.classList.toggle('running', b.name === doing);
    li.classList.toggle('no', v?.verdict === 'no');
    li.classList.toggle('phase', v?.verdict === 'phase');
    li.classList.toggle('threw', v?.verdict === 'threw');
    li.classList.toggle('backed', backed);
    const pri = li.querySelector('.b-pri');
    // The priority the director actually used: Jev's focus and a running
    // behavior's commitment both move it.
    const effective = v?.effective ?? b.priority;
    if (backed && v?.backoffMs != null && pick?.at) {
      const left = Math.ceil((v.backoffMs - (now - pick.at)) / 1000);
      pri.textContent = left > 0 ? `${left}s` : effective;
    } else {
      pri.textContent = effective;
    }
    pri.classList.toggle('boosted', effective !== b.priority);
    li.title = `${b.name}: priority ${b.priority}${effective !== b.priority ? `, ${effective} with focus and commitment` : ''}`;
  });
  if (pick?.chosen && pick.chosen !== lastChosen) {
    const row = [...$('board').children].find((n) => n.dataset.key === pick.chosen);
    if (row) { row.classList.remove('pop'); void row.offsetWidth; row.classList.add('pop'); }
    lastChosen = pick.chosen;
  }
  const held = (pick?.asked ?? []).filter((a) => a.verdict === 'phase').length;
  $('brainNote').textContent = pick ? `asked ${pick.asked.length} · chose ${info(pick.chosen).label.toLowerCase()}${held ? ` · ${held} held by phase` : ''}` : '';
}

function renderJev(state) {
  const s = state.status;
  const decided = s.jev.usedCached;
  const instinct = s.jev.usedInstinct;
  const pct = decided + instinct ? Math.round((100 * decided) / (decided + instinct)) : null;
  $('jevPct').textContent = pct === null ? '–' : `${pct}%`;

  const kinds = Object.entries(state.jev ?? {});
  const calls = kinds.reduce((t, [, k]) => t + (k.calls ?? 0), 0);
  const ok = kinds.reduce((t, [, k]) => t + (k.ok ?? 0), 0);
  if (kinds.length) $('jevHit').textContent = calls ? `${Math.round((100 * ok) / calls)}%` : '–';

  const st = s.strategy;
  const focus = $('jevFocus');
  if (st) {
    // The server's verdict, from the director's own limits — not a copy of
    // them here.
    focus.textContent = '';
    focus.append('focus ');
    const b = document.createElement('b');
    b.textContent = `${String(st.focus).toUpperCase()} ${Math.round(st.confidence * 100)}%`;
    focus.append(b, ` · ${st.applied ? 'steering' : `ignored (${st.why})`} · risk ${String(st.risk ?? '?').toUpperCase()}`);
  }
  if (!kinds.length) return;
  const scale = Math.max(1000, ...kinds.map(([, k]) => k.p90 ?? 0));
  syncList($('jevKinds'), kinds, ([kind]) => kind, () => {
    const d = document.createElement('div');
    d.className = 'jk';
    d.innerHTML = '<span class="k"></span><span class="bar"><i></i><s></s></span><span class="ms"></span>';
    return d;
  }, (d, [kind, k]) => {
    d.querySelector('.k').textContent = kind;
    d.querySelector('.bar i').style.width = `${clamp(((k.p50 ?? 0) / scale) * 100, 0, 100)}%`;
    d.querySelector('.bar s').style.left = `${clamp(((k.p90 ?? 0) / scale) * 100, 0, 99)}%`;
    const fails = k.failed ? ` · ${k.failed} failed${k.failedDuringStall ? ` (${k.failedDuringStall} in stalls)` : ''}` : '';
    const busy = k.inFlight ? ` · ${k.inFlight} asking` : '';
    d.querySelector('.ms').textContent = `${k.p50 ?? '–'}/${k.p90 ?? '–'}ms · ${k.ok}/${k.calls}${fails}${busy}`;
    d.title = `${kind}: p50 ${k.p50 ?? '–'}ms, p90 ${k.p90 ?? '–'}ms, ${k.ok} of ${k.calls} answered${fails}`;
  });
}

function renderRadarNote(state) {
  const hostiles = (state.entities ?? []).filter((e) => e.kind === 'hostile' && inRange(state, e));
  const range = state.radarRange ?? 32;
  $('radarNote').textContent = hostiles.length
    ? `${hostiles.length} hostile · nearest ${pretty(hostiles[0].name)} ${Math.round(hostiles[0].d)}m`
    : `no hostiles within ${range}`;
  $('radar').setAttribute('aria-label', `radar: ${$('radarNote').textContent}`);
}

// ---- radar ------------------------------------------------------------------

const ORE_COLORS = {
  diamond_ore: '#5ef1e6', deepslate_diamond_ore: '#5ef1e6', iron_ore: '#e8b894', deepslate_iron_ore: '#e8b894',
  coal_ore: '#777', gold_ore: '#ffd24d', redstone_ore: '#ff4d4d', lapis_ore: '#3d6bff',
};
const KIND = { hostile: '#ff5a6a', animal: '#3cff9a', player: '#37e3ff', item: '#ffb347', other: '#4f8a6c' };
const TRAIL_BUCKETS = 8;

// The rings and grid never change; drawn once per size, not sixty times a second.
let rings = null;
function ringsFor(size, dpr, range) {
  if (rings && rings.size === size && rings.range === range) return rings.canvas;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  const c = size / 2;
  const scale = (c - 8 * dpr) / range;
  ctx.fillStyle = '#020a07'; ctx.fillRect(0, 0, size, size);
  ctx.strokeStyle = '#12382a'; ctx.lineWidth = dpr;
  for (let r = 8; r <= range; r += 8) { ctx.beginPath(); ctx.arc(c, c, r * scale, 0, Math.PI * 2); ctx.stroke(); }
  ctx.beginPath(); ctx.moveTo(c, 0); ctx.lineTo(c, size); ctx.moveTo(0, c); ctx.lineTo(size, c); ctx.stroke();
  rings = { size, range, canvas };
  return canvas;
}

let radarSize = 0;
export function resizeRadar() {
  radarSize = 0;
}

export function drawRadar(t) {
  const cv = $('radar');
  const dpr = window.devicePixelRatio || 1;
  if (!radarSize) {
    const rect = cv.getBoundingClientRect();
    radarSize = Math.round(Math.min(rect.width, rect.height || rect.width) * dpr);
  }
  const size = radarSize;
  if (!size) return;
  if (cv.width !== size) { cv.width = size; cv.height = size; }
  const st = radarState;
  const range = st?.radarRange ?? 32;
  const ctx = cv.getContext('2d');
  const c = size / 2;
  const scale = (c - 8 * dpr) / range;
  ctx.clearRect(0, 0, size, size);
  ctx.save();
  ctx.beginPath(); ctx.arc(c, c, c - 2 * dpr, 0, Math.PI * 2); ctx.clip();
  ctx.drawImage(ringsFor(size, dpr, range), 0, 0);
  if (ctx.createConicGradient) {
    const g = ctx.createConicGradient((t / 2200) % (Math.PI * 2), c, c);
    g.addColorStop(0, 'rgba(60,255,154,0.28)'); g.addColorStop(0.1, 'rgba(60,255,154,0)'); g.addColorStop(1, 'rgba(60,255,154,0)');
    ctx.fillStyle = g; ctx.fillRect(0, 0, size, size);
  }
  if (st?.connected && st.status?.world) {
    const me = st.status.world.pos;
    const at = (x, z) => [c + (x - me.x) * scale, c + (z - me.z) * scale];
    // The trail in a few strokes, oldest faintest: one stroke per segment was
    // three hundred paths a frame.
    const trail = st.trail ?? [];
    const per = Math.ceil(trail.length / TRAIL_BUCKETS);
    ctx.lineWidth = 2 * dpr;
    for (let b = 0; b < TRAIL_BUCKETS && per; b++) {
      const from = b * per;
      const to = Math.min(trail.length, from + per + 1);
      if (to - from < 2) continue;
      ctx.strokeStyle = `rgba(55,227,255,${0.06 + 0.5 * ((b + 1) / TRAIL_BUCKETS)})`;
      ctx.beginPath();
      for (let i = from; i < to; i++) {
        const [x, y] = at(trail[i].x, trail[i].z);
        if (i === from) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      }
      ctx.stroke();
    }
    const m = st.markers ?? {};
    // Water the bot had to build its way out of: a ring, so it reads as an area.
    for (const w of m.waterTraps ?? []) {
      const [x, y] = at(w.x, w.z);
      ctx.strokeStyle = 'rgba(55,140,255,0.7)'; ctx.lineWidth = 1.5 * dpr;
      ctx.setLineDash([3 * dpr, 3 * dpr]);
      ctx.beginPath(); ctx.arc(x, y, 8 * scale, 0, Math.PI * 2); ctx.stroke();
      ctx.setLineDash([]);
    }
    for (const o of m.ores ?? []) {
      const [x, y] = at(o.x, o.z);
      ctx.fillStyle = ORE_COLORS[o.ore] ?? '#aaa';
      ctx.fillRect(x - 2 * dpr, y - 2 * dpr, 4 * dpr, 4 * dpr);
    }
    const glyph = (p, color, g, label = null) => {
      if (!p) return;
      const [x, y] = at(p.x, p.z);
      ctx.fillStyle = color; ctx.font = `${12 * dpr}px monospace`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText(g, x, y);
      if (label) {
        ctx.font = `${9 * dpr}px monospace`; ctx.textBaseline = 'top';
        ctx.fillText(label, x, y + 6 * dpr);
      }
    };
    for (const d of m.deaths ?? []) glyph(d, '#ff5a6a', 'x', d.cause ?? null);
    glyph(m.table, '#c8914b', '#'); glyph(m.furnace, '#b8c0cc', '■'); glyph(m.home, '#ffb347', '⌂');
    const pulse = 0.5 + 0.5 * Math.sin(t / 200);
    for (const e of st.entities ?? []) {
      const [x, y] = at(e.x, e.z);
      const r = (e.kind === 'item' ? 2 : 3.5) * dpr;
      const far = Math.abs(e.y - me.y) > THREAT_DY;
      ctx.globalAlpha = far ? 0.35 : 1; // in a cave below or on a cliff above
      if (e.kind === 'hostile' && !far) {
        ctx.fillStyle = `rgba(255,90,106,${0.15 + 0.2 * pulse})`;
        ctx.beginPath(); ctx.arc(x, y, r * 3.4, 0, Math.PI * 2); ctx.fill();
      }
      ctx.fillStyle = KIND[e.kind] ?? KIND.other;
      ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill();
      if (e.kind === 'hostile' || e.kind === 'player') {
        ctx.fillStyle = '#e9fff2'; ctx.font = `${10 * dpr}px monospace`; ctx.textAlign = 'center'; ctx.textBaseline = 'bottom';
        ctx.fillText(pretty(e.name), x, y - r - 3 * dpr);
      }
      ctx.globalAlpha = 1;
    }
    const yaw = st.status.world.yaw ?? 0;
    ctx.save();
    ctx.translate(c, c);
    ctx.rotate(Math.atan2(-Math.cos(yaw), -Math.sin(yaw)) + Math.PI / 2);
    ctx.fillStyle = '#e9fff2'; ctx.shadowColor = '#3cff9a'; ctx.shadowBlur = 10 * dpr;
    ctx.beginPath();
    ctx.moveTo(0, -9 * dpr); ctx.lineTo(6 * dpr, 7 * dpr); ctx.lineTo(0, 3 * dpr); ctx.lineTo(-6 * dpr, 7 * dpr);
    ctx.closePath(); ctx.fill();
    ctx.restore();
  }
  ctx.restore();
  ctx.fillStyle = '#6fae8c'; ctx.font = `${11 * dpr}px monospace`; ctx.textAlign = 'center'; ctx.textBaseline = 'top';
  ctx.fillText('N', c, 3 * dpr);
}
