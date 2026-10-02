// Shared helpers for the mission-control page. No framework: the page is
// read-only and redraws from one state object four times a second.

export const $ = (id) => document.getElementById(id);

export const icon = (name) => `/icon/${encodeURIComponent(name)}`;

export const pretty = (s) => String(s ?? '').replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
export const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

export function mmss(ms) {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return '—';
  const s = Math.max(0, Math.round(ms / 1000));
  if (s >= 3600) return `${Math.floor(s / 3600)}h${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}m`;
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

export function clock(ts) {
  const d = new Date(ts);
  return `${d.toLocaleTimeString([], { hour12: false })}.${String(d.getMilliseconds()).padStart(3, '0')}`;
}

export function hashColor(name) {
  let h = 0;
  for (const c of String(name)) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return `hsl(${h % 360} 55% 62%)`;
}

/** An item picture that degrades to a lettered tile when there is none. */
export function itemImg(name, cls = 'px') {
  const img = document.createElement('img');
  img.className = cls;
  img.alt = pretty(name);
  img.src = icon(name);
  img.onerror = () => {
    const tile = document.createElement('div');
    tile.className = 'fallback';
    tile.style.background = hashColor(name);
    tile.textContent = pretty(name).slice(0, 2);
    tile.title = pretty(name);
    img.replaceWith(tile);
  };
  return img;
}

export function setImg(el, name) {
  if (!el || el.dataset.name === name) return;
  el.dataset.name = name;
  el.style.visibility = 'visible';
  el.onerror = () => { el.style.visibility = 'hidden'; };
  el.src = icon(name);
}

/** Keeps `parent`'s children in step with `items`, reusing nodes by key. */
export function syncList(parent, items, key, make, update) {
  const existing = new Map([...parent.children].map((n) => [n.dataset.key, n]));
  const keep = new Set();
  items.forEach((item, i) => {
    const k = String(key(item, i));
    keep.add(k);
    let node = existing.get(k);
    if (!node) {
      node = make(item);
      node.dataset.key = k;
    }
    update(node, item, i);
    if (parent.children[i] !== node) parent.insertBefore(node, parent.children[i] ?? null);
  });
  for (const [k, node] of existing) if (!keep.has(k)) node.remove();
}

export const reducedMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

// What each behavior means, in words anyone watching understands.
export const BEHAVIORS = {
  escapeHazard: { label: 'Escaping danger', icon: 'lava_bucket', urgent: true },
  escapeDrowning: { label: 'Swimming up for air', icon: 'water_bucket', urgent: true },
  defend: { label: 'Fighting back', icon: 'iron_sword', urgent: true },
  unstick: { label: 'Getting unstuck', icon: 'piston', urgent: true },
  bed: { label: 'Going to bed', icon: 'red_wool', urgent: true },
  shelter: { label: 'Digging in for the night', icon: 'stone_shovel', urgent: true },
  threat: { label: 'Dealing with a mob', icon: 'bow', urgent: true },
  leaveWater: { label: 'Getting out of the water', icon: 'oak_boat', urgent: true },
  loot: { label: 'Recovering its lost items', icon: 'bundle' },
  fetchCooked: { label: 'Collecting cooked food', icon: 'cooked_beef' },
  woodUrgent: { label: 'Chopping wood (running low)', icon: 'oak_log' },
  forage: { label: 'Looking for food', icon: 'wheat' },
  forageTopUp: { label: 'Stocking food for the trip', icon: 'bread' },
  collect: { label: 'Picking up drops', icon: 'hopper' },
  resupply: { label: 'Heading up to resupply', icon: 'ladder' },
  huntUrgent: { label: 'Hunting, hungry!', icon: 'beef' },
  valuables: { label: 'Grabbing ore it spotted', icon: 'raw_gold' },
  gear: { label: 'Crafting gear', icon: 'crafting_table' },
  smelt: { label: 'Smelting', icon: 'furnace' },
  tidy: { label: 'Tidying the backpack', icon: 'barrel' },
  gatherStone: { label: 'Gathering stone', icon: 'cobblestone' },
  mine: { label: 'Mining ore', icon: 'iron_pickaxe' },
  goDeep: { label: 'Heading deep for diamonds', icon: 'diamond_pickaxe' },
  stripMine: { label: 'Strip-mining a tunnel', icon: 'stone_pickaxe' },
  hunt: { label: 'Hunting', icon: 'porkchop' },
  wood: { label: 'Chopping trees', icon: 'oak_log' },
  explore: { label: 'Exploring', icon: 'map' },
  idle: { label: 'Wandering', icon: 'feather' },
  dead: { label: 'Respawning…', icon: 'totem_of_undying', urgent: true },
  paused: { label: 'Paused', icon: 'clock_00' },
  PAUSED: { label: 'Paused', icon: 'clock_00' },
  manual: { label: 'Following a chat command', icon: 'writable_book' },
  nothing: { label: 'Deciding what to do', icon: 'ender_eye' },
};
export const info = (name) => BEHAVIORS[name] ?? { label: name ?? 'Choosing…', icon: 'ender_eye' };

// The phase pipeline's milestone for each phase — for the ETA from history.
export const PHASE_MILESTONE = {
  stoneKit: 'stone_kit', tripPrep: 'trip_ready', iron: 'first_iron', ironKit: 'iron_pickaxe',
  diamonds: 'first_diamond', diamondKit: 'diamond_kit',
};

export function storage(key, fallback) {
  try {
    return localStorage.getItem(key) ?? fallback;
  } catch {
    return fallback; // private mode, blocked storage: defaults are fine
  }
}

export function store(key, value) {
  try { localStorage.setItem(key, value); } catch { /* not important */ }
}
