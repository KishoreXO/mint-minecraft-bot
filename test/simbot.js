/**
 * A bot on real physics, in a world described by a function.
 *
 * Not a test itself — the water tests build on it. The point is to run the
 * actual prismarine-physics simulatePlayer, tick by tick, against the same
 * prismarine-block objects mineflayer uses, so a swimming or climbing routine
 * can be tested the way it will really move, not the way a stub says it moves.
 * Every water behavior that ever looked right on paper and drowned the bot
 * live (see src/water.js) looked right against stubs.
 *
 * The code under test must wait in TICKS (task.js untilTick / waitTicks), not
 * wall-clock sleeps: the harness runs as fast as the event loop allows.
 *
 * gen(x, y, z) returns a block spec: 'stone', 'water' (a source), 'water:3'
 * (level 3), 'oak_slab[type=bottom,waterlogged=true]', or null (unloaded).
 */

const { EventEmitter } = require('events');
const Vec3 = require('vec3');
const registry = require('prismarine-registry')('1.21.9');
const Block = require('prismarine-block')(registry);
const Item = require('prismarine-item')(registry);
const { Physics, PlayerState } = require('prismarine-physics');
const { eyeInWater, isWaterish } = require('../src/water');

const stateIds = new Map();
function stateOf(spec) {
  if (!stateIds.has(spec)) {
    const level = /^(water|lava):(\d+)$/.exec(spec);
    let id;
    if (level) id = Block.fromProperties(level[1], { level: Number(level[2]) }, 0).stateId;
    else if (spec.includes('[')) id = Block.fromString(spec, 0).stateId;
    else {
      const def = registry.blocksByName[spec];
      if (!def) throw new Error(`simbot: unknown block ${spec}`);
      id = def.defaultState;
    }
    stateIds.set(spec, id);
  }
  return stateIds.get(spec);
}

// What a placement may overwrite. Kelp is NOT replaceable in vanilla.
const REPLACEABLE = new Set(['air', 'cave_air', 'water', 'seagrass', 'tall_seagrass', 'short_grass']);

function bodyBox(pos) {
  return { minX: pos.x - 0.3, maxX: pos.x + 0.3, minY: pos.y, maxY: pos.y + 1.8, minZ: pos.z - 0.3, maxZ: pos.z + 0.3 };
}

function bodyOverlapsCell(bot, cell) {
  const b = bodyBox(bot.entity.position);
  return b.maxX > cell.x && b.minX < cell.x + 1
    && b.maxY > cell.y && b.minY < cell.y + 1
    && b.maxZ > cell.z && b.minZ < cell.z + 1;
}

function createSimBot(gen, {
  pos, yaw = 0, items = [], air = 300, health = 20, placeLatencyTicks = 1,
} = {}) {
  const edits = new Map();
  const key = (x, y, z) => `${x},${y},${z}`;
  const specAt = (x, y, z) => (edits.has(key(x, y, z)) ? edits.get(key(x, y, z)) : gen(x, y, z));
  const world = {
    getBlock(p) {
      const x = Math.floor(p.x);
      const y = Math.floor(p.y);
      const z = Math.floor(p.z);
      const spec = specAt(x, y, z);
      if (spec == null) return null;
      const b = Block.fromStateId(stateOf(spec), 0);
      b.position = new Vec3(x, y, z);
      return b;
    },
    set(p, spec) { edits.set(key(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z)), spec); },
    specAt,
  };
  const physics = Physics(registry, world);
  const bot = new EventEmitter();
  bot.setMaxListeners(100);
  const controlState = {
    forward: false, back: false, left: false, right: false, jump: false, sprint: false, sneak: false,
  };
  Object.assign(bot, {
    version: '1.21.9',
    registry,
    world,
    controlState,
    health,
    food: 20,
    game: { gameMode: 'survival', minY: -64 },
    entities: {},
    jumpTicks: 0,
    jumpQueued: false,
    fireworkRocketDuration: 0,
    quickBarSlot: 0,
    ticks: 0,
    entity: {
      id: 1,
      height: 1.8,
      eyeHeight: 1.62,
      position: new Vec3(...pos),
      velocity: new Vec3(0, 0, 0),
      yaw,
      pitch: 0,
      onGround: false,
      isInWater: false,
      isInLava: false,
      isInWeb: false,
      isCollidedHorizontally: false,
      isCollidedVertically: false,
      elytraFlying: false,
      attributes: {},
      effects: {},
    },
    pathfinder: {
      goal: null, setGoal(g) { this.goal = g; }, isMoving: () => false, stop() {},
    },
  });

  // mineflayer physics.js semantics: jump=true queues a jump.
  bot.setControlState = (control, state) => {
    if (!(control in controlState)) throw new Error(`simbot: no control ${control}`);
    if (controlState[control] === state) return;
    controlState[control] = state;
    if (control === 'jump' && state) bot.jumpQueued = true;
  };
  bot.getControlState = (control) => controlState[control];
  bot.clearControlStates = () => {
    for (const c of Object.keys(controlState)) bot.setControlState(c, false);
  };
  bot.look = async (y, p) => {
    bot.entity.yaw = y;
    bot.entity.pitch = p;
  };
  bot.lookAt = async (point) => {
    const d = point.minus(bot.entity.position.offset(0, 1.62, 0));
    bot.entity.yaw = Math.atan2(-d.x, -d.z);
    bot.entity.pitch = Math.atan2(d.y, Math.hypot(d.x, d.z));
  };
  bot.blockAt = (p) => world.getBlock(p);

  // Inventory: a hotbar is enough for these tests.
  const slots = new Array(46).fill(null);
  items.forEach(([name, count], i) => {
    const item = new Item(registry.itemsByName[name].id, count);
    item.slot = 36 + i;
    slots[36 + i] = item;
  });
  bot.inventory = {
    slots,
    items: () => slots.slice(9, 45).filter(Boolean),
    emptySlotCount: () => slots.slice(9, 45).filter((s) => !s).length,
  };
  Object.defineProperty(bot, 'heldItem', { get: () => slots[36 + bot.quickBarSlot] ?? null });
  bot.equip = async (item) => {
    if (item.slot >= 36 && item.slot <= 44) bot.quickBarSlot = item.slot - 36;
  };

  // Air as vanilla keeps it: -1 a tick with the eye in water, 2 damage every
  // time it reaches -20, +4 a tick in air.
  let airTicks = air;
  Object.defineProperty(bot, 'oxygenLevel', { get: () => Math.round(airTicks / 15) });
  bot.drowningDamage = 0;

  bot.digTime = (b) => b.digTime(bot.heldItem?.type ?? null, false, eyeInWater(bot), !bot.entity.onGround, [], bot.entity.effects);
  bot.canDigBlock = (b) => !!b && b.diggable;
  bot.targetDigBlock = null;
  bot.dig = async (b) => {
    const ticks = Math.ceil(bot.digTime(b) / 50);
    bot.targetDigBlock = b;
    await bot.waitForTicks(ticks);
    bot.targetDigBlock = null;
    const p = b.position;
    const above = world.getBlock(p.offset(0, 1, 0));
    const side = [[1, 0], [-1, 0], [0, 1], [0, -1]].some(([dx, dz]) => isWaterish(world.getBlock(p.offset(dx, 0, dz))));
    world.set(p, isWaterish(above) ? 'water' : (side ? 'water:1' : 'air'));
  };
  bot.stopDigging = () => {};
  bot.placeBlock = async (ref, face) => {
    const dest = ref.position.plus(face);
    const current = world.getBlock(dest);
    if (!ref.shapes || !ref.shapes.length) throw new Error('no face to click');
    if (!bot.heldItem) throw new Error('must be holding an item to place');
    if (!REPLACEABLE.has(current.name) || bodyOverlapsCell(bot, dest)) {
      throw new Error(`Server refused to place ${bot.heldItem.name} at ${dest}: the block is still ${current.name}`);
    }
    await bot.waitForTicks(placeLatencyTicks);
    world.set(dest, bot.heldItem.name);
    bot.heldItem.count--;
    if (bot.heldItem.count <= 0) slots[36 + bot.quickBarSlot] = null;
  };
  bot.waitForTicks = (n) => new Promise((resolve) => {
    let left = n;
    const onTick = () => {
      if (--left <= 0) {
        bot.removeListener('physicsTick', onTick);
        resolve();
      }
    };
    bot.on('physicsTick', onTick);
  });

  bot.tick = () => {
    // mineflayer's order: simulate, apply, then emit (plugins/physics.js).
    physics.simulatePlayer(new PlayerState(bot, controlState), world).apply(bot);
    bot.ticks++;
    if (eyeInWater(bot)) {
      airTicks--;
      if (airTicks <= -20) {
        airTicks = 0;
        bot.health -= 2;
        bot.drowningDamage += 2;
      }
    } else {
      airTicks = Math.min(300, airTicks + 4);
    }
    bot.emit('physicsTick');
  };
  return bot;
}

/**
 * Tick until `done()` holds, letting awaiting code run between ticks.
 * Returns the tick it held on, or -1 after `maxTicks`.
 */
async function runUntil(bot, done, maxTicks) {
  for (let t = 0; t < maxTicks; t++) {
    if (done()) return t;
    bot.tick();
    // Several microtask/macrotask turns, so a chain of awaits advances.
    await new Promise((r) => { setImmediate(r); });
  }
  return done() ? maxTicks : -1;
}

/** Run a promise-returning routine against the sim until it settles. */
async function drive(bot, promise, maxTicks) {
  let settled = false;
  let value;
  let error;
  promise.then((v) => { settled = true; value = v; }, (e) => { settled = true; error = e; });
  const t = await runUntil(bot, () => settled, maxTicks);
  if (error) throw error;
  return { settled, value, ticks: t };
}

module.exports = { createSimBot, runUntil, drive, stateOf, REPLACEABLE };
