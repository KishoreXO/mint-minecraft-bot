// The history view: how good the bot is across every world and every try,
// from /api/history (src/stats.js summarize()).
import { $, pretty, mmss, storage, store } from './util.js';

const METRICS = {
  stonePickaxeMs: { title: 'TIME TO STONE PICKAXE // EACH FRESH LIFE', lowerIsBetter: true },
  ironPickaxeMs: { title: 'TIME TO IRON PICKAXE // EACH FRESH LIFE', lowerIsBetter: true },
  lifeMs: { title: 'LIFE LENGTH // EACH FRESH LIFE', lowerIsBetter: false },
};

let metric = storage('trendMetric', 'stonePickaxeMs');
if (!METRICS[metric]) metric = 'stonePickaxeMs';
let last = null;

function median(xs) {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
}

function hours(ms) {
  if (!ms) return '0h';
  const h = ms / 3600000;
  return h >= 10 ? `${Math.round(h)}h` : `${h.toFixed(1)}h`;
}

function renderKpis(h) {
  const t = h.totals;
  const stone = h.overall.find((m) => m.id === 'stone_pickaxe');
  const iron = h.overall.find((m) => m.id === 'first_iron');
  const kpis = [
    ['WORLDS', t.worlds, ''],
    ['LIVES', t.lives, `${t.freshLives} fresh starts`],
    ['PLAYED', hours(t.playMs), ''],
    ['DEATHS / HR', t.deathsPerHour, `${t.deaths} deaths`],
    ['STONE PICK', stone?.median != null ? mmss(stone.median) : '—', stone ? `median · ${stone.reached}/${stone.of} lives` : ''],
    ['FIRST IRON', iron ? `${Math.round(iron.rate * 100)}%` : '—', iron ? `${iron.reached} of ${iron.of} fresh lives` : ''],
    ['BEST EVER', (t.bestEver ?? '—').toUpperCase(), 'furthest milestone'],
  ];
  const box = $('kpis');
  box.innerHTML = '';
  for (const [label, value, sub] of kpis) {
    const k = el('div', 'kpi');
    k.append(el('label', '', label), el('b', '', String(value)));
    if (sub) k.append(el('span', 'sub', sub));
    box.append(k);
  }
}

function renderFunnel(h) {
  const list = $('funnel');
  list.innerHTML = '';
  const top = Math.max(1, ...h.overall.map((m) => m.reached));
  for (const m of h.overall) {
    const li = el('li', `fn${m.reached ? '' : ' none'}`);
    const track = el('div', 'track');
    const bar = el('i');
    bar.style.width = `${(100 * m.reached) / top}%`;
    track.append(bar);
    li.title = `${m.reached} of ${m.of} fresh lives reached ${m.label} (${Math.round(m.rate * 100)}%)`;
    li.append(
      el('span', 'lbl', m.label.toUpperCase()),
      track,
      el('span', 'n', `${m.reached}/${m.of}`),
      el('span', 'med', m.median != null ? mmss(m.median) : '—'),
      el('span', 'best', m.best != null ? mmss(m.best) : '—'),
    );
    list.append(li);
  }
}

function renderWorlds(h) {
  const body = $('worlds');
  body.innerHTML = '';
  for (const w of h.worlds) {
    const tr = el('tr');
    const name = el('td');
    name.append(el('span', '', w.label));
    if (w.approx) name.append(el('span', 'approx', ' · from logs'));
    tr.append(
      name,
      el('td', w.furthestIndex >= 0 ? 'cyan' : '', (w.furthest ?? 'nothing yet').toUpperCase()),
      el('td', '', String(w.lives)),
      el('td', '', hours(w.playMs)),
      el('td', w.deathsPerHour > 3 ? 'red' : '', String(w.deathsPerHour)),
    );
    body.append(tr);
  }
  if (!h.worlds.length) body.innerHTML = '<tr><td colspan="5">no worlds yet</td></tr>';
}

function bars(list, rows, limit = 8) {
  list.innerHTML = '';
  const top = Math.max(1, ...rows.map((r) => r.count));
  for (const r of rows.slice(0, limit)) {
    const li = el('li', 'bar-row');
    const track = el('div', 'track');
    const bar = el('i');
    bar.style.width = `${(100 * r.count) / top}%`;
    track.append(bar);
    li.append(el('span', 'lbl', pretty(r.key)), track, el('span', 'n', String(r.count)));
    list.append(li);
  }
  if (!rows.length) list.append(el('li', 'bar-row', 'none recorded'));
}

function renderTrend(h) {
  const def = METRICS[metric];
  $('trendTitle').textContent = def.title;
  document.querySelectorAll('.trend-panel .filters button').forEach((b) => {
    b.classList.toggle('on', b.dataset.metric === metric);
    b.setAttribute('aria-pressed', String(b.dataset.metric === metric));
  });
  const points = h.trend;
  const values = points.map((p) => p[metric]).filter((v) => v != null);
  const top = Math.max(1, ...values);
  const mid = median(values);
  const box = $('trend');
  box.innerHTML = '';
  for (const p of points) {
    const v = p[metric];
    const b = el('div', 'tb');
    const when = new Date(p.at).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
    if (v == null) {
      b.classList.add('none');
      b.style.height = '3px';
      b.dataset.tip = `${when} · never got there (${p.end === 'death' ? `died: ${p.killedBy ?? '?'}` : p.end})`;
    } else {
      b.style.height = `${Math.max(3, (100 * v) / top)}%`;
      const better = def.lowerIsBetter ? v <= mid : v >= mid;
      b.classList.add(better ? 'fast' : 'slow');
      b.dataset.tip = `${when} · ${mmss(v)}`;
    }
    box.append(b);
  }
  const recent = points.slice(-20).map((p) => p[metric]).filter((v) => v != null);
  const bits = [`${points.length} fresh lives`, `${values.length} got there`];
  if (mid != null) bits.push(`median ${mmss(mid)}`);
  const recentMid = median(recent);
  if (recentMid != null && mid != null && values.length >= 6) {
    const better = def.lowerIsBetter ? recentMid < mid : recentMid > mid;
    bits.push(`last 20: ${mmss(recentMid)} (${better ? 'improving' : 'not better yet'})`);
  }
  bits.push(def.lowerIsBetter ? 'green = faster than median' : 'green = longer than median');
  $('trendNote').textContent = bits.join(' · ');
}

export function render(h) {
  if (!h || !h.totals) {
    $('historyNote').textContent = 'no history yet · run `npm run stats` to rebuild it from the logs';
    return;
  }
  last = h;
  const updated = h.updatedAt ? new Date(h.updatedAt).toLocaleTimeString([], { hour12: false }) : '—';
  $('historyNote').textContent = `updated ${updated} · ${h.totals.worlds} worlds · ${h.totals.lives} lives · times are from a fresh start`;
  $('deathTitle').textContent = `DEATHS BY CAUSE // ${h.totals.deaths}`;
  renderKpis(h);
  renderFunnel(h);
  renderWorlds(h);
  bars($('deathCauses'), h.deathsByCause);
  bars($('deathPhases'), h.deathsByPhase.map((r) => ({ ...r, key: r.key === 'unknown' ? 'phase unknown (old logs)' : r.key })));
  renderTrend(h);
}

export function init() {
  document.querySelectorAll('.trend-panel .filters button').forEach((btn) => {
    btn.addEventListener('click', () => {
      metric = btn.dataset.metric;
      store('trendMetric', metric);
      if (last) renderTrend(last);
    });
  });
}
