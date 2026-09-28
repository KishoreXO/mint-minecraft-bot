/**
 * Water: what it is, how to get through it, and how to get out of it.
 *
 * WHY THIS FILE EXISTS. The bot was awkward in water in a way no single fix
 * could touch, because the whole approach was built on physics this client
 * does not have. swim.js steered "by LOOK — pitch down and hold forward and
 * you go down", sprinted "for the 1.13 swim animation", and expected sneak to
 * sink. prismarine-physics 1.11.1 does none of that: in water only YAW steers
 * (applyHeading ignores pitch), sprint changes nothing, sneak only slows you to
 * 30%, and the hitbox stays 1.8 tall. The only vertical controls that exist
 * are "jump" (rise, up to 3.5 b/s) and "nothing" (sink, 0.5 b/s). Measured by
 * running the real simulatePlayer — see test/waterSim.test.js, which pins
 * every one of those numbers so this can never drift back.
 *
 * What that cost, from 693 session logs:
 *   - three drownings, each with air one or two blocks away. 09-26 13:45: a
 *     pocket one across and one up; surfaceForAir only pressed forward when
 *     the xz distance to the pocket's CORNER exceeded 1 — from the cell
 *     centre that is 0.707, so it never swam toward it, and pressed its head
 *     into its own ceiling until it died;
 *   - a flooded ravine it could not leave: findShore offered banks up to
 *     three blocks above the water, and nothing can climb more than one;
 *   - leaveWater and unstick handing the wheel back and forth for up to
 *     fourteen minutes, 63% of escapes followed by walking straight back in.
 *
 * So the model here is taken from the physics, not from how swimming looks:
 *
 *   CLIMBING OUT   a bank whose top is one block above the water's top block
 *                  can be climbed (forward + jump; the 0.3 boost when pushing
 *                  a wall with free air above). Two blocks never — the jump
 *                  peaks at feet Y+1.59. CLIMBABLE_BANK_RISE.
 *   PILLARING      impossible in open water: floating with jump held, the
 *                  feet bob between Y-0.16 and Y+0.80 and never clear the
 *                  cell, which is every "the block is still water" refusal
 *                  in the logs. A LANDING block placed beside the bot is the
 *                  way up (leaveWater).
 *   DIGGING        stone with a stone pickaxe: 0.6 s dry, 2.85 s standing
 *                  underwater, 14.1 s floating with the eye under — the
 *                  whole air supply. So digging for air is budgeted, never
 *                  assumed.
 *
 * Three parts: the MODEL (this section), the ROUTERS (a surface search for
 * exits, a 3D one for breath), and the PILOT (one owner of the controls while
 * in water, driven by physics ticks).
 */

const Vec3 = require('vec3');
const logger = require('./logger');
const { timeScan } = require('./lag');
const { AbortError } = require('./task');

// ---- the model ----------------------------------------------------------------

// Air: 20 bubbles is 300 ticks; one bubble is fifteen ticks of breath. Past
// empty, vanilla hurts for 2 every twenty ticks — ten ticks per health point.
const AIR_FULL = 20;
const AIR_RESERVE = 8;
const AIR_CRITICAL = 4;
const AIR_TICKS_PER_BUBBLE = 15;
const DROWN_TICKS_PER_HP = 10;

// The tallest bank a swimmer can climb, in blocks above the top water block.
// Pinned in test/waterSim.test.js: +1 climbs, +2 never does.
const CLIMBABLE_BANK_RISE = 1;

// Route costs in ticks, from the measured speeds: 2 b/s across (10 ticks a
// block), 3.5 b/s up (6), and sinking at 0.5 b/s (40) — diving is expensive.
const SWIM_COST = { h: 10, diag: 14, up: 6, down: 40 };

// Search sizes. Exits are on the surface and can be a long way off in a
// ravine; breath is close or it is useless.
const EXIT_SURFACE_RADIUS = 40;
const EXIT_MAX_NODES = 5000;
const ROUTE_RADIUS = 12;
const ROUTE_HEIGHT = 8;
const ROUTE_MAX_NODES = 12000;
// Straight up, the surface can be further than the search height; oceans are
// about thirty deep.
const SURFACE_PROBE = 40;

const WATER_NAMES = new Set(['water', 'flowing_water', 'bubble_column']);
// Always water-filled. prismarine-physics counts all four as water for
// buoyancy, and vanilla counts them for breathing — an old isWater that only
// knew the water block read a bot drowning in a kelp forest as dry.
const WATER_PLANTS = new Set(['kelp', 'kelp_plant', 'seagrass', 'tall_seagrass']);
const LAVA_NAMES = new Set(['lava', 'flowing_lava']);

/** Does this block hold water, whatever else it is? */
function isWaterish(block) {
  if (!block) return false;
  return WATER_NAMES.has(block.name) || WATER_PLANTS.has(block.name) || block.isWaterlogged === true;
}

/** Could a body be in this cell: no collision shape, and not lava. */
function isPassable(block) {
  return !!block && block.boundingBox === 'empty' && !LAVA_NAMES.has(block.name);
}

/** A cell a body can occupy and breathe in. */
function isBreathable(block) {
  return isPassable(block) && !isWaterish(block);
}

/** A cell that holds water and a body: where swimming happens. */
function isSwimmable(block) {
  return isPassable(block) && isWaterish(block);
}

/** Solid enough to stand on or push against. */
function isSolid(block) {
  return !!block && block.boundingBox === 'block';
}

function waterLevel(block) {
  if (!block || !WATER_NAMES.has(block.name) || block.name === 'bubble_column') return 0;
  const props = typeof block.getProperties === 'function' ? block.getProperties() : null;
  const level = Number(props?.level ?? 0);
  return Number.isFinite(level) ? level : 0;
}

/**
 * How high the water in this cell reaches, as a fraction of the block.
 * Vanilla: full with water above it, otherwise (8 - level) / 9 — a source or a
 * falling column is 8/9.
 */
function fluidHeight(block, above) {
  if (!isWaterish(block)) return 0;
  if (isWaterish(above)) return 1;
  const level = waterLevel(block);
  return level >= 8 || level === 0 ? 8 / 9 : (8 - level) / 9;
}

const EYE_HEIGHT = 1.62;
// Vanilla tests the fluid 0.11111 below the eye (updateFluidOnEyes).
const EYE_FLUID_OFFSET = 0.11111;

/** The cell the air gauge actually depends on. */
function eyeCell(bot) {
  const p = bot.entity.position;
  return { x: Math.floor(p.x), y: Math.floor(p.y + EYE_HEIGHT - EYE_FLUID_OFFSET), z: Math.floor(p.z) };
}

/**
 * Is the bot breathing water? The vanilla rule, not "is the cell above the
 * feet wet" — the old test called a bot with its eyes clear of the surface
 * submerged whenever its feet dipped below the top water block.
 */
function eyeInWater(bot) {
  if (!bot.entity) return false;
  const p = bot.entity.position;
  const y = p.y + EYE_HEIGHT - EYE_FLUID_OFFSET;
  const cy = Math.floor(y);
  const block = blockAtXYZ(bot, Math.floor(p.x), cy, Math.floor(p.z));
  if (!isWaterish(block)) return false;
  const above = blockAtXYZ(bot, Math.floor(p.x), cy + 1, Math.floor(p.z));
  return y < cy + fluidHeight(block, above);
}

/** Bubbles left, clamped: mineflayer reports -1 while drowning. */
function airLeft(bot) {
  const air = bot.oxygenLevel ?? AIR_FULL;
  return Math.max(0, Math.min(AIR_FULL, air));
}

/** Ticks until the air runs out, and then until health does. */
function breathBudgetTicks(bot) {
  const health = Number.isFinite(bot.health) ? bot.health : 20;
  return airLeft(bot) * AIR_TICKS_PER_BUBBLE + Math.max(0, health - 2) * DROWN_TICKS_PER_HP;
}

// A real Vec3: prismarine-world stores pos.floored() as the block's position,
// and callers use block.position.offset() on what comes back.
function blockAtXYZ(bot, x, y, z) {
  if (typeof bot.blockAt !== 'function') return null;
  return bot.blockAt(new Vec3(x, y, z));
}

/**
 * A memo of cells for one plan. Routing reads the same cells many times over
 * (every neighbour of every node), and blockAt builds a Block object each
 * time; findShore's old ring scan cost up to 393ms in a single call.
 */
function cellReader(bot) {
  const memo = new Map();
  return (x, y, z) => {
    const key = `${x},${y},${z}`;
    if (memo.has(key)) return memo.get(key);
    const b = blockAtXYZ(bot, x, y, z);
    const cell = b ? {
      name: b.name,
      passable: isPassable(b),
      water: isWaterish(b),
      solid: isSolid(b),
      lava: LAVA_NAMES.has(b.name),
      drag: b.name === 'bubble_column' && String(b.getProperties?.().drag) === 'true',
      block: b,
    } : null;
    memo.set(key, cell);
    return cell;
  };
}

// ---- the routers --------------------------------------------------------------

const DIRS4 = [[1, 0], [-1, 0], [0, 1], [0, -1]];
const DIRS8 = [...DIRS4, [1, 1], [1, -1], [-1, 1], [-1, -1]];

class MinHeap {
  constructor() { this.items = []; }

  get size() { return this.items.length; }

  push(item, cost) {
    const a = this.items;
    a.push({ item, cost });
    let i = a.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (a[p].cost <= a[i].cost) break;
      [a[p], a[i]] = [a[i], a[p]];
      i = p;
    }
  }

  pop() {
    const a = this.items;
    const top = a[0];
    const last = a.pop();
    if (a.length) {
      a[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let m = i;
        if (l < a.length && a[l].cost < a[m].cost) m = l;
        if (r < a.length && a[r].cost < a[m].cost) m = r;
        if (m === i) break;
        [a[m], a[i]] = [a[i], a[m]];
        i = m;
      }
    }
    return top.item;
  }
}

const nodeKey = (n) => `${n.x},${n.y},${n.z}`;

function feetNode(bot) {
  const p = bot.entity.position;
  return { x: Math.floor(p.x), y: Math.floor(p.y), z: Math.floor(p.z) };
}

/**
 * The top water block of the column the bot is floating in, or null if the
 * column is capped (no air above the water) or the bot is not in water.
 */
function surfaceAbove(cell, x, y, z) {
  // Start from the feet, or the cell below them if the feet have bobbed up
  // into the air above the water.
  let top = null;
  let cy = y;
  const here = cell(x, cy, z);
  if (!here) return null;
  if (!here.water) {
    const below = cell(x, cy - 1, z);
    if (!below?.water || !below.passable) return null;
    cy -= 1;
  }
  for (let dy = 0; dy <= 40; dy++) {
    const c = cell(x, cy + dy, z);
    if (!c) return null;
    if (c.water && c.passable) {
      top = cy + dy;
      continue;
    }
    // First non-water cell above the column: air means a surface, rock means
    // a lid.
    return c.passable && !c.water ? top : null;
  }
  return null;
}

/** Is (x, y, z) the top water block of an open column: water here, air above? */
function isSurfaceCell(cell, x, y, z) {
  const c = cell(x, y, z);
  if (!c || !c.water || !c.passable || c.drag) return false;
  const above = cell(x, y + 1, z);
  return !!above && above.passable && !above.water;
}

/**
 * Where to step ashore from surface node (x, y, z) in direction (dx, dz), if
 * anywhere: the dry cell the feet end up in, or null.
 *
 * Climbable is the measured rule — the ground's top at most
 * CLIMBABLE_BANK_RISE above the water's top block — and there must be room
 * for the climb: the bot's own column clear three blocks up (the boost lifts
 * the body to Y+3.4) and the landing clear two up.
 */
function exitFrom(cell, x, y, z, dx, dz) {
  const sx = x + dx;
  const sz = z + dz;
  for (let groundY = y + CLIMBABLE_BANK_RISE - 1; groundY >= y - 1; groundY--) {
    const ground = cell(sx, groundY, sz);
    if (!ground?.solid) continue;
    const feet = cell(sx, groundY + 1, sz);
    const head = cell(sx, groundY + 2, sz);
    if (!feet?.passable || feet.water || !head?.passable || head.water) return null;
    if (groundY + 1 > y) {
      // A real climb: headroom over the bank and over our own column.
      const over = cell(sx, groundY + 3, sz);
      if (!over?.passable) return null;
      for (let h = 1; h <= 3; h++) {
        if (!cell(x, y + h, z)?.passable) return null;
      }
    }
    return new Vec3(sx, groundY + 1, sz);
  }
  return null;
}

/**
 * Breadth-first over the water's surface from the bot's column, asking
 * probe(cell, node) at every node; the first answer wins (nearest by swim
 * distance), or with score, the best-scoring answer found within slack
 * steps of the first. Returns { found, approach, path, steps } or null.
 */
function surfaceSearch(bot, probe, { radius = EXIT_SURFACE_RADIUS, maxNodes = EXIT_MAX_NODES, score = null, slack = 0 } = {}) {
  const cell = cellReader(bot);
  const f = feetNode(bot);
  const top = surfaceAbove(cell, f.x, f.y, f.z);
  if (top === null) return null;
  const start = { x: f.x, y: top, z: f.z };
  const prev = new Map([[nodeKey(start), null]]);
  const steps = new Map([[nodeKey(start), 0]]);
  const queue = [start];
  let best = null;
  let bestScore = Infinity;
  let firstSteps = null;
  for (let qi = 0; qi < queue.length && qi < maxNodes; qi++) {
    const n = queue[qi];
    const s = steps.get(nodeKey(n));
    if (firstSteps !== null && s > firstSteps + slack) break;
    const found = probe(cell, n);
    if (found) {
      if (firstSteps === null) firstSteps = s;
      const sc = score ? score(found, s) : s;
      if (sc < bestScore) {
        bestScore = sc;
        best = { found, approach: n };
      }
      if (!score) break;
    }
    for (const [dx, dz] of DIRS8) {
      if (Math.abs(n.x + dx - start.x) > radius || Math.abs(n.z + dz - start.z) > radius) continue;
      // Diagonals only between two open orthogonals, or the body clips a corner.
      if (dx && dz && !(isSurfaceCell(cell, n.x + dx, n.y, n.z) && isSurfaceCell(cell, n.x, n.y, n.z + dz))) continue;
      for (const dy of [0, -1, 1]) { // rivers step down, and occasionally up
        const m = { x: n.x + dx, y: n.y + dy, z: n.z + dz };
        const k = nodeKey(m);
        if (prev.has(k) || !isSurfaceCell(cell, m.x, m.y, m.z)) continue;
        prev.set(k, n);
        steps.set(k, s + 1);
        queue.push(m);
        break;
      }
    }
  }
  if (!best) return null;
  const path = [];
  for (let n = best.approach; n; n = prev.get(nodeKey(n))) path.unshift(n);
  return { found: best.found, approach: best.approach, path, steps: path.length - 1 };
}

/**
 * The nearest place the bot can actually get out of the water, by surface
 * swimming distance — not straight-line, which is what sent it toward the
 * far wall of a ravine that had no way up.
 *
 * With toward, among exits reachable not much further than the nearest, the
 * one closest to that point wins (a swim toward a destination should come
 * ashore on its side).
 *
 * Returns { stand, approach, path, steps } or null.
 */
function findExit(bot, { toward = null, radius = EXIT_SURFACE_RADIUS } = {}) {
  if (!bot.entity) return null;
  return timeScan('water findExit', () => {
    const hit = surfaceSearch(bot, (cell, n) => {
      let bestStand = null;
      for (const [dx, dz] of DIRS4) {
        const stand = exitFrom(cell, n.x, n.y, n.z, dx, dz);
        if (!stand) continue;
        if (!toward) return stand;
        if (!bestStand || stand.distanceTo(toward) < bestStand.distanceTo(toward)) bestStand = stand;
      }
      return bestStand;
    }, { radius, score: toward ? (stand, st) => st + stand.distanceTo(toward) : null, slack: toward ? 8 : 0 });
    return hit ? { stand: hit.found, approach: hit.approach, path: hit.path, steps: hit.steps } : null;
  });
}

// What a placed block may replace. Kelp is NOT replaceable in vanilla, and a
// bubble column would just rebuild itself.
const LANDING_REPLACEABLE = new Set(['water', 'flowing_water', 'seagrass', 'tall_seagrass']);

/**
 * Where to put a landing block from surface node (x, y, z): a water cell at
 * the surface beside the bot, with a solid face to click (a wall, or the floor
 * if the water is one deep), open air two above it so it can be stood on, and
 * the bot's own column clear three up so it can climb onto it.
 */
function landingFrom(cell, x, y, z) {
  for (let h = 1; h <= 3; h++) {
    if (!cell(x, y + h, z)?.passable) return null;
  }
  for (const [dx, dz] of DIRS4) {
    const lx = x + dx;
    const lz = z + dz;
    const l = cell(lx, y, lz);
    if (!l || !LANDING_REPLACEABLE.has(l.name) || l.drag) continue;
    const up1 = cell(lx, y + 1, lz);
    const up2 = cell(lx, y + 2, lz);
    if (!up1?.passable || up1.water || !up2?.passable || up2.water) continue;
    // A face to click: a wall beside the landing (not our own cell), else the floor.
    for (const [rx, rz] of DIRS4) {
      if (lx + rx === x && lz + rz === z) continue;
      const ref = cell(lx + rx, y, lz + rz);
      if (ref?.solid) {
        return { cell: new Vec3(lx, y, lz), ref: new Vec3(lx + rx, y, lz + rz), face: new Vec3(-rx, 0, -rz) };
      }
    }
    if (cell(lx, y - 1, lz)?.solid) {
      return { cell: new Vec3(lx, y, lz), ref: new Vec3(lx, y - 1, lz), face: new Vec3(0, 1, 0) };
    }
  }
  return null;
}

/** The nearest surface spot a landing can be built from. */
function findLanding(bot, { radius = EXIT_SURFACE_RADIUS } = {}) {
  if (!bot.entity) return null;
  return timeScan('water findLanding', () => {
    const hit = surfaceSearch(bot, (cell, n) => landingFrom(cell, n.x, n.y, n.z), { radius });
    return hit ? { ...hit.found, approach: hit.approach, path: hit.path, steps: hit.steps } : null;
  });
}

/**
 * With no blocks to build with: a notch cut into a wall beside surface node
 * (x, y, z) — the wall cells one, two and three above the water. The wall
 * block at water level becomes a bank one block up, which is climbable.
 */
function notchFrom(cell, x, y, z) {
  for (let h = 1; h <= 3; h++) {
    if (!cell(x, y + h, z)?.passable) return null;
  }
  for (const [dx, dz] of DIRS4) {
    const wx = x + dx;
    const wz = z + dz;
    if (!cell(wx, y, wz)?.solid) continue; // the step itself
    const cut = [];
    let ok = true;
    for (let h = 1; h <= 3; h++) {
      const c = cell(wx, y + h, wz);
      if (!c || c.water || c.lava || (c.solid && c.block?.diggable === false)) {
        ok = false;
        break;
      }
      if (c.solid) cut.push(new Vec3(wx, y + h, wz));
    }
    if (ok && cut.length) return { stand: new Vec3(wx, y + 1, wz), cut, heading: [dx, dz] };
  }
  return null;
}

function findNotch(bot, { radius = 12 } = {}) {
  if (!bot.entity) return null;
  return timeScan('water findNotch', () => {
    const hit = surfaceSearch(bot, (cell, n) => notchFrom(cell, n.x, n.y, n.z), { radius });
    return hit ? { ...hit.found, approach: hit.approach, path: hit.path, steps: hit.steps } : null;
  });
}

/**
 * Out, for a climb up from the water: a dry standable cell right beside the
 * feet, at the feet's level. "Clear sky above" cannot be the test — it is true
 * two blocks up an open ravine, with the rim still twelve blocks higher.
 */
function rimBeside(bot) {
  if (!bot.entity) return null;
  const f = feetNode(bot);
  for (const [dx, dz] of DIRS4) {
    const feet = blockAtXYZ(bot, f.x + dx, f.y, f.z + dz);
    const head = blockAtXYZ(bot, f.x + dx, f.y + 1, f.z + dz);
    const ground = blockAtXYZ(bot, f.x + dx, f.y - 1, f.z + dz);
    if (isBreathable(feet) && isBreathable(head) && isSolid(ground)) return new Vec3(f.x + dx, f.y, f.z + dz);
  }
  return null;
}

/**
 * The fastest this block can be broken with anything in the bag, in ticks,
 * with the water penalties as they stand right now. bot.digTime uses whatever
 * is in hand, and mineflayer's own "eye in water" test knows only the water
 * block — not kelp, seagrass or waterlogged blocks.
 */
function bestDigTicks(bot, block, { onGround = bot.entity.onGround } = {}) {
  if (typeof block?.digTime !== 'function') return Infinity;
  const inWater = eyeInWater(bot);
  const airborne = !onGround;
  const effects = bot.entity.effects ?? {};
  let best = block.digTime(null, false, inWater, airborne, [], effects);
  for (const item of bot.inventory?.items?.() ?? []) {
    const t = block.digTime(item.type, false, inWater, airborne, [], effects);
    if (t < best) best = t;
  }
  return Math.ceil(best / 50);
}

/** A body fits here: feet and head cells both passable. */
function fits(cell, x, y, z) {
  const feet = cell(x, y, z);
  const head = cell(x, y + 1, z);
  return !!feet?.passable && !!head?.passable;
}

/** In the water: the body touches water, so swimming moves apply. */
function wet(cell, x, y, z) {
  return !!(cell(x, y, z)?.water || cell(x, y + 1, z)?.water);
}

/**
 * The cheapest swim, in ticks, from where the bot is to a goal, through water
 * in three dimensions. Pathfinder cannot do this: it has no up or down moves
 * in water at all (movements.js getMoveUp/getMoveDown bail on liquid).
 *
 * goal: { type: 'breath' } — somewhere the head is in air;
 *       { type: 'dry' } — somewhere to stand out of the water entirely (the
 *         dry tunnel a flooded mine came from, a ledge in a cave);
 *       { type: 'point', target: Vec3, within }.
 * Returns { path: [nodes], ticks } or null.
 */
function planRoute(bot, goal, { radius = ROUTE_RADIUS, height = ROUTE_HEIGHT, maxNodes = ROUTE_MAX_NODES } = {}) {
  if (!bot.entity) return null;
  return timeScan('water planRoute', () => {
    const cell = cellReader(bot);
    const start = feetNode(bot);
    const breath = (n) => {
      const head = cell(n.x, n.y + 1, n.z);
      return !!head && head.passable && !head.water && !!cell(n.x, n.y, n.z)?.passable;
    };
    const dry = (n) => {
      const feet = cell(n.x, n.y, n.z);
      return breath(n) && !!feet && !feet.water && !!cell(n.x, n.y - 1, n.z)?.solid;
    };
    // Open water straight up is by far the commonest case, and it can be
    // deeper than the search's height: answer it with a probe, not a search.
    if (goal.type === 'breath') {
      const column = [];
      for (let dy = 0; dy <= SURFACE_PROBE; dy++) {
        const n = { x: start.x, y: start.y + dy, z: start.z };
        const feet = cell(n.x, n.y, n.z);
        if (!feet?.passable || feet.drag) break;
        column.push(n);
        if (breath(n)) return { path: column, ticks: dy * SWIM_COST.up };
        if (!cell(n.x, n.y + 1, n.z)?.passable) break; // a lid: search instead
      }
    }
    let isGoal;
    if (goal.type === 'breath') isGoal = breath;
    else if (goal.type === 'dry') isGoal = dry;
    else isGoal = (n) => new Vec3(n.x + 0.5, n.y, n.z + 0.5).distanceTo(goal.target) <= (goal.within ?? 1);
    const heuristic = goal.type === 'point'
      ? (n) => Math.max(0, (Math.max(Math.abs(n.x + 0.5 - goal.target.x), Math.abs(n.z + 0.5 - goal.target.z)) - (goal.within ?? 1)) * SWIM_COST.h)
      : () => 0;

    const cost = new Map([[nodeKey(start), 0]]);
    const prev = new Map([[nodeKey(start), null]]);
    const heap = new MinHeap();
    heap.push(start, heuristic(start));
    let expanded = 0;
    while (heap.size && expanded < maxNodes) {
      const n = heap.pop();
      const k = nodeKey(n);
      const g = cost.get(k);
      expanded++;
      if (isGoal(n)) {
        const path = [];
        for (let m = n; m; m = prev.get(nodeKey(m))) path.unshift(m);
        return { path, ticks: g };
      }
      // Only swim from a node that is actually in water; a dry node is a
      // destination, not a corridor (that is pathfinder's job).
      if (n !== start && !wet(cell, n.x, n.y, n.z)) continue;
      const moves = [];
      for (const [dx, dz] of DIRS8) {
        const diag = dx && dz;
        if (diag && !(fits(cell, n.x + dx, n.y, n.z) && fits(cell, n.x, n.y, n.z + dz))) continue;
        moves.push([dx, 0, dz, diag ? SWIM_COST.diag : SWIM_COST.h]);
      }
      moves.push([0, 1, 0, SWIM_COST.up]);
      // A downward bubble column drags harder than a swimmer can rise.
      moves.push([0, -1, 0, cell(n.x, n.y - 1, n.z)?.drag ? SWIM_COST.down * 10 : SWIM_COST.down]);
      for (const [dx, dy, dz, c] of moves) {
        const m = { x: n.x + dx, y: n.y + dy, z: n.z + dz };
        if (Math.abs(m.x - start.x) > radius || Math.abs(m.z - start.z) > radius || Math.abs(m.y - start.y) > height) continue;
        if (!fits(cell, m.x, m.y, m.z)) continue;
        const mk = nodeKey(m);
        const ng = g + c;
        if (ng >= (cost.get(mk) ?? Infinity)) continue;
        cost.set(mk, ng);
        prev.set(mk, n);
        heap.push(m, ng + heuristic(m));
      }
    }
    return null;
  });
}

/**
 * Is the water column above the eye capped by something solid before any
 * air? Under a lid, rising blindly just presses the head into it, so the
 * drowning escape starts at once instead of waiting for the air reserve.
 */
function cappedAbove(bot, maxUp = 24) {
  const e = eyeCell(bot);
  for (let dy = 0; dy <= maxUp; dy++) {
    const b = blockAtXYZ(bot, e.x, e.y + dy, e.z);
    if (!b) return false; // unloaded: do not guess
    if (isBreathable(b)) return false;
    if (!isPassable(b)) return true;
  }
  return false;
}

/**
 * What could be dug to reach air, and how long each would take in ticks, all
 * in: the dig with the best tool and today's water penalties, plus the swim
 * from there. Sorted cheapest first; only blocks that open straight onto air
 * or a route to it, and never one with sand or gravel on top (it would fall
 * into the hole and fill it).
 *
 * `route`, if given, is the breath route that was too long: the cells beside
 * its path are candidates too, since breaking one can cut a corner.
 */
const GRAVITY_BLOCKS = new Set(['sand', 'red_sand', 'gravel', 'suspicious_sand', 'suspicious_gravel', 'anvil']);
const NEVER_DIG_FOR_AIR = new Set(['bedrock', 'chest', 'trapped_chest', 'barrel', 'spawner', 'furnace', 'crafting_table', 'end_portal_frame']);

// Sinking, at the measured 0.5 b/s once it gets going.
const SINK_TICKS_PER_BLOCK = 40;
// Player reach, from the eye.
const REACH = 4.5;

/**
 * How far the feet are above a floor the bot could stand on to dig, or null.
 * Standing, a dig underwater is five times slower than dry; floating it is
 * twenty-five (mineflayer digging.js) — so for a lid, sinking to the floor
 * first is usually the faster way up.
 */
function floorBelow(bot) {
  const p = bot.entity.position;
  const fx = Math.floor(p.x);
  const fz = Math.floor(p.z);
  for (let y = Math.floor(p.y); y >= Math.floor(p.y) - 2; y--) {
    const b = blockAtXYZ(bot, fx, y, fz);
    if (isSolid(b)) return p.y - (y + 1);
    if (!isPassable(b)) return null;
  }
  return null;
}

function airDigOptions(bot) {
  const e = eyeCell(bot);
  const out = [];
  const drop = bot.entity.onGround ? null : floorBelow(bot);
  const consider = (x, y, z, afterTicks) => {
    const b = blockAtXYZ(bot, x, y, z);
    if (!b || !isSolid(b) || b.diggable === false || NEVER_DIG_FOR_AIR.has(b.name)) return;
    if (GRAVITY_BLOCKS.has(blockAtXYZ(bot, x, y + 1, z)?.name)) return;
    const ticks = bestDigTicks(bot, b);
    if (Number.isFinite(ticks)) out.push({ block: b, ticks: ticks + afterTicks, sinkFirst: false });
    if (drop !== null && drop > 0) {
      const standingEyeY = bot.entity.position.y - drop + 1.62;
      if (Math.abs(y + 0.5 - standingEyeY) <= REACH - 0.5) {
        const grounded = bestDigTicks(bot, b, { onGround: true });
        const sink = Math.ceil(drop * SINK_TICKS_PER_BLOCK) + 10;
        if (Number.isFinite(grounded)) {
          out.push({ block: b, ticks: grounded + sink + afterTicks + Math.ceil(drop * SWIM_COST.up), sinkFirst: true });
        }
      }
    }
  };
  // The lid over the head, when there is air right on the other side of it.
  if (isBreathable(blockAtXYZ(bot, e.x, e.y + 2, e.z))) consider(e.x, e.y + 1, e.z, SWIM_COST.up * 2);
  // A wall at head height with air behind it, or air above the cell behind it.
  for (const [dx, dz] of DIRS4) {
    const behind = blockAtXYZ(bot, e.x + 2 * dx, e.y, e.z + 2 * dz);
    const behindUp = blockAtXYZ(bot, e.x + dx, e.y + 1, e.z + dz);
    if (isBreathable(behind) || isBreathable(behindUp)) consider(e.x + dx, e.y, e.z + dz, SWIM_COST.h * 2);
  }
  return out.sort((a, b) => a.ticks - b.ticks);
}

// ---- the pilot ------------------------------------------------------------------

// Arrival and patience, in ticks and blocks.
const ARRIVE_H = 0.35; // horizontal, at the final node
const PASS_H = 0.6; // horizontal, at an intermediate node — cut corners, do not stop at each
const STALL_TICKS = 20;
const STALL_PROGRESS = 0.15;
const CLIMB_TIMEOUT_TICKS = 80;
const CLIMB_SETTLE_TICKS = 4;
const BODY_HEIGHT = 1.8;

function yawToward(from, x, z) {
  return Math.atan2(-(x - from.x), -(z - from.z));
}

/** The lowest solid cell above node (x, y, z)'s head, or Infinity. */
function ceilingOver(bot, x, y, z) {
  for (let dy = 2; dy <= 4; dy++) {
    const b = blockAtXYZ(bot, x, y + dy, z);
    if (b && !isPassable(b)) return y + dy;
  }
  return Infinity;
}

/**
 * One owner of the controls in water, driven by physics ticks.
 *
 * Before this, four things set `jump` while the bot swam: a 100ms watchdog
 * (always on), swimTo (never), nav's walkTheLastBit (off, every 50ms) and
 * pathfinder (on, every tick) — plus five clearControlStates calls that left
 * the watchdog believing it still held a jump someone else had cleared, so it
 * later released one it did not own. The pilot re-asserts every control every
 * tick while a behavior has claimed it, and otherwise only ever touches a jump
 * it set itself.
 */
function createPilot(bot, initialCtx = null) {
  let ctx = initialCtx;
  const state = {
    owner: null,
    job: null, // { kind, ..., resolve, reject }
    floatHeld: false,
    lastYaw: null,
  };
  const origSet = bot.setControlState.bind(bot);
  let selfSetting = false;

  // Anyone else touching `jump` takes it over: the float must not release a
  // jump that is no longer its own (a pillar step rising out of the water).
  bot.setControlState = (control, value) => {
    if (control === 'jump' && !selfSetting) state.floatHeld = false;
    return origSet(control, value);
  };
  const set = (control, value) => {
    selfSetting = true;
    try {
      origSet(control, value);
    } finally {
      selfSetting = false;
    }
  };
  const drive = ({ forward = false, jump = false, yaw = null }) => {
    set('forward', forward);
    set('jump', jump);
    set('back', false);
    set('left', false);
    set('right', false);
    // Sprint does nothing in water here and may put the server in swim pose;
    // sneak cuts swim speed to 30% and does NOT sink.
    set('sprint', false);
    set('sneak', false);
    if (yaw !== null && (state.lastYaw === null || Math.abs(yaw - state.lastYaw) > 0.02)) {
      state.lastYaw = yaw;
      Promise.resolve(bot.look(yaw, 0, true)).catch(() => {});
    }
  };

  function finish(result) {
    const job = state.job;
    state.job = null;
    if (job) job.resolve(result);
  }

  function floatTick() {
    const inWater = !!bot.entity?.isInWater;
    const under = inWater && eyeInWater(bot);
    const diving = !!bot.diveIntent && airLeft(bot) > AIR_RESERVE;
    if (ctx?.water) ctx.water.rescuing = under && airLeft(bot) <= AIR_RESERVE;
    if (under && !diving) {
      set('jump', true);
      state.floatHeld = true;
      bot.swimAssist = true;
    } else if (state.floatHeld) {
      set('jump', false);
      state.floatHeld = false;
      bot.swimAssist = false;
    }
  }

  function followTick(job) {
    const pos = bot.entity.position;
    const node = job.path[job.i];
    const last = job.i === job.path.length - 1;
    const cx = node.x + 0.5;
    const cz = node.z + 0.5;
    const hd = Math.hypot(cx - pos.x, cz - pos.z);

    const headAir = isBreathable(blockAtXYZ(bot, node.x, node.y + 1, node.z));
    const ceiling = ceilingOver(bot, node.x, node.y, node.z);
    const maxFeet = ceiling - BODY_HEIGHT - 0.05;
    // Rise toward the node's level (or float, if it is a surface node) but
    // never so high the body cannot fit under the next column's ceiling.
    let jump = headAir ? true : pos.y < node.y + 0.15;
    if (pos.y > maxFeet) jump = false;
    const tooHighToEnter = pos.y > maxFeet + 0.1;
    const arrive = last ? (job.arrive ?? ARRIVE_H) : PASS_H;
    const forward = hd > (last ? arrive * 0.6 : 0.2) && !tooHighToEnter;
    drive({ forward, jump, yaw: hd > 0.05 ? yawToward(pos, cx, cz) : null });

    const vOk = pos.y > node.y - 0.4 && pos.y < node.y + 1.0;
    if (hd < arrive && vOk) {
      job.i++;
      job.best = Infinity;
      job.bestAt = job.ticks;
      if (job.i >= job.path.length) finish('arrived');
      // Measure progress against the NEW node from the next tick on; scoring
      // this tick's distance to the node just passed made every next node look
      // like no progress at all.
      return;
    }
    // Progress counts both ways vertically: sinking to a lower node is slow
    // (0.5 b/s) but it is progress, not a stall.
    const d = Math.hypot(hd, node.y + 0.1 - pos.y);
    if (d < job.best - STALL_PROGRESS) {
      job.best = d;
      job.bestAt = job.ticks;
    } else if (job.ticks - job.bestAt >= STALL_TICKS) {
      finish('stalled');
    }
  }

  function climbTick(job) {
    const pos = bot.entity.position;
    const s = job.stand;
    const cx = s.x + 0.5;
    const cz = s.z + 0.5;
    const ashore = bot.entity.onGround && !bot.entity.isInWater && pos.y >= s.y - 0.05;
    if (ashore) {
      job.settle = (job.settle ?? 0) + 1;
      // A few more steps, so the body is on the bank, not overhanging the water.
      drive({ forward: Math.hypot(cx - pos.x, cz - pos.z) > 0.3, jump: false, yaw: yawToward(pos, cx, cz) });
      if (job.settle >= CLIMB_SETTLE_TICKS) finish('arrived');
      return;
    }
    drive({ forward: true, jump: true, yaw: yawToward(pos, cx, cz) });
    if (job.ticks >= CLIMB_TIMEOUT_TICKS) finish('stalled');
  }

  function holdTick(job) {
    drive({ forward: false, jump: job.jump, yaw: job.yaw ?? null });
    if (job.until && job.until()) finish('arrived');
    else if (job.ticks >= job.maxTicks) finish(job.until ? 'stalled' : 'arrived');
  }

  function onTick() {
    try {
      if (!bot.entity) return;
      if (!state.owner) {
        floatTick();
        return;
      }
      const job = state.job;
      if (!job) {
        // Claimed but idle: keep the head up, stay put.
        drive({ jump: !!bot.entity.isInWater });
        return;
      }
      job.ticks++;
      if (job.kind === 'follow') followTick(job);
      else if (job.kind === 'climb') climbTick(job);
      else if (job.kind === 'hold') holdTick(job);
    } catch (err) {
      // A throw here would unwind mineflayer's physics interval.
      logger.warn('Water pilot tick failed', { error: err.message });
      finish('stalled');
    }
  }
  bot.on('physicsTick', onTick);

  function start(kind, fields, task) {
    if (!state.owner) throw new Error('water pilot: claim() before driving');
    if (state.job) finish('superseded');
    return new Promise((resolve, reject) => {
      let unsubscribe = null;
      const job = {
        kind,
        ...fields,
        ticks: 0,
        best: Infinity,
        bestAt: 0,
        resolve: (v) => {
          if (unsubscribe) unsubscribe();
          resolve(v);
        },
        reject,
      };
      if (task) {
        if (task.aborted) {
          reject(new AbortError(task.reason));
          return;
        }
        unsubscribe = task.onAbort((reason) => {
          if (state.job === job) state.job = null;
          reject(new AbortError(reason));
        });
      }
      state.job = job;
    });
  }

  const pilot = {
    get owner() { return state.owner; },
    get busy() { return !!state.job; },
    /** Take the controls. Pathfinder is stopped: it forces jump and pitch 0 in water. */
    claim(owner) {
      if (bot.pathfinder?.goal) {
        try { bot.pathfinder.setGoal(null); } catch { /* not ours to fix here */ }
      }
      state.owner = owner;
      state.floatHeld = false;
      state.lastYaw = null;
    },
    /** Give the controls back, all released. */
    release(owner = null) {
      if (owner && state.owner !== owner) return;
      if (state.job) finish('released');
      state.owner = null;
      drive({ forward: false, jump: false });
    },
    /**
     * Swim a planned route; resolves 'arrived' | 'stalled' | 'superseded' |
     * 'released'. `arrive` tightens the final stop (placing a landing block
     * needs the body well inside its own cell).
     */
    follow(path, task, { arrive = null } = {}) {
      return start('follow', { path, i: path.length > 1 ? 1 : 0, arrive }, task);
    },
    /** Climb onto the dry cell `stand` from the water beside it. */
    climbOut(stand, task) {
      return start('climb', { stand }, task);
    },
    /**
     * Hold position for `ticks` (head up with jump, or sinking without), or
     * until `until()` holds — resolving 'stalled' if it never did.
     */
    hold(ticks, task, { jump = true, yaw = null, until = null } = {}) {
      return start('hold', {
        maxTicks: ticks, jump, yaw, until,
      }, task);
    },
    setCtx(next) { ctx = next; },
    detach() {
      bot.removeListener('physicsTick', onTick);
      bot.setControlState = origSet;
    },
  };
  return pilot;
}

/** Install the pilot once per bot; later calls return the same one. */
function installWater(bot, ctx = null) {
  if (!bot.waterPilot) bot.waterPilot = createPilot(bot, ctx);
  else if (ctx) bot.waterPilot.setCtx(ctx);
  return bot.waterPilot;
}

/**
 * Run `fn(pilot)` with the controls claimed, always giving them back. The
 * one way behaviors should drive in water.
 */
async function withPilot(bot, owner, fn) {
  const pilot = installWater(bot);
  pilot.claim(owner);
  try {
    return await fn(pilot);
  } finally {
    pilot.release(owner);
  }
}

// ---- composite moves ------------------------------------------------------------

const MAX_REPLANS = 3;

/**
 * Swim a route to `goal`, replanning when progress stalls. Resolves the last
 * follow result, or 'unroutable' when there is no route at all.
 */
async function swimRoute(bot, pilot, goal, task, { replans = MAX_REPLANS } = {}) {
  let result = 'unroutable';
  for (let attempt = 0; attempt <= replans; attempt++) {
    const route = planRoute(bot, goal);
    if (!route) return result;
    if (route.path.length <= 1) return 'arrived';
    result = await pilot.follow(route.path, task);
    if (result !== 'stalled') return result;
  }
  return result;
}

/** Surface-swim to the nearest climbable exit and climb out. */
async function swimAshore(bot, pilot, task, { toward = null, exit = null } = {}) {
  const found = exit ?? findExit(bot, { toward });
  if (!found) return { result: 'no exit' };
  if (found.path.length > 1) {
    const swam = await pilot.follow(found.path, task);
    if (swam !== 'arrived') return { result: swam, exit: found };
  }
  const climbed = await pilot.climbOut(found.stand, task);
  return { result: climbed === 'arrived' ? 'ashore' : climbed, exit: found };
}

/**
 * Get somewhere from in the water: to a dry target via the exit on its side,
 * or to a wet one directly. The swim fallback nav.js uses when pathfinder
 * gives up in water (it cannot climb out of deep water at all).
 */
async function swimToward(bot, target, task, { within = 1.2, owner = 'swimToward' } = {}) {
  if (!bot.entity?.isInWater) return bot.entity.position.distanceTo(target) <= within;
  return withPilot(bot, owner, async (pilot) => {
    const dryTarget = isBreathable(bot.blockAt(target)) && isSolid(bot.blockAt(target.offset(0, -1, 0)));
    if (dryTarget) {
      const out = await swimAshore(bot, pilot, task, { toward: target });
      if (out.result === 'ashore') return bot.entity.position.distanceTo(target) <= within;
      if (out.result !== 'no exit') return false;
    }
    const r = await swimRoute(bot, pilot, { type: 'point', target, within }, task);
    return r === 'arrived' || bot.entity.position.distanceTo(target) <= within;
  });
}

module.exports = {
  // model
  AIR_FULL, AIR_RESERVE, AIR_CRITICAL, AIR_TICKS_PER_BUBBLE, DROWN_TICKS_PER_HP,
  CLIMBABLE_BANK_RISE, SWIM_COST, EXIT_SURFACE_RADIUS, ROUTE_RADIUS, ROUTE_HEIGHT,
  isWaterish, isPassable, isBreathable, isSwimmable, isSolid, fluidHeight, waterLevel,
  eyeCell, eyeInWater, airLeft, breathBudgetTicks, cellReader, blockAtXYZ,
  // routers
  findExit, findLanding, findNotch, rimBeside, planRoute, cappedAbove, surfaceAbove, exitFrom, landingFrom,
  notchFrom, surfaceSearch, bestDigTicks, airDigOptions,
  // pilot
  installWater, createPilot, withPilot, swimRoute, swimAshore, swimToward,
  STALL_TICKS, CLIMB_TIMEOUT_TICKS,
};
