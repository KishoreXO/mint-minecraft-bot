/**
 * Safety checks for digging at depth.
 *
 * These decide whether the bot survives the trip to y=-59. Dying there
 * doesn't just cost the run: the death site is unreachable within the
 * five-minute despawn window, so everything it was carrying is gone too.
 *
 * Run with: node test/mining.test.js
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const Vec3 = require('vec3');
const {
  safeToDig, hasFooting, lavaAdjacent, ORE_DEPTH, DIAMOND_GOAL,
  isFallingBlock, clearOverheadFalling,
  dropCandidate, SCAN_THROTTLE_MS, EXHAUSTIVE_SCAN_THROTTLE_MS, veinOf,
} = require('../src/behaviors/mine');
const { stepIsSafe, centreOnBlock, offCentre } = require('../src/nav');
const { Task, sleep } = require('../src/task');

let passed = 0;

/**
 * `await fn()` uniformly, so a synchronous assertion and a promise-returning
 * one are handled the same way. Every other test file in this project only
 * ever checks synchronous functions, so this was never needed before —
 * `clearOverheadFalling` is the first thing under test here that is genuinely
 * async (it digs, which is a real window transaction), and calling it without
 * awaiting would let a failing assertion inside its `.then()` slip past as an
 * unhandled rejection instead of a reported FAIL, and would let the final
 * tally print before the check had even resolved.
 */
async function check(label, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ok  ${label}`);
  } catch (err) {
    console.error(`  FAIL ${label}: ${err.message}`);
    process.exitCode = 1;
  }
}

/** A tiny world: a map of "x,y,z" -> block name, everything else is stone. */
function worldOf(overrides = {}, fill = 'stone') {
  return {
    blockAt(pos) {
      const key = `${pos.x},${pos.y},${pos.z}`;
      const name = Object.prototype.hasOwnProperty.call(overrides, key)
        ? overrides[key]
        : fill;
      if (name === null) return null; // unloaded chunk
      const empty = name === 'air' || name === 'lava' || name === 'water';
      return { name, position: new Vec3(pos.x, pos.y, pos.z), boundingBox: empty ? 'empty' : 'block' };
    },
  };
}

const at = (x, y, z) => new Vec3(x, y, z);

async function main() {
  console.log('digging safety');

  // The whole reason the old allowlist was wrong: below y=0 almost everything
  // is a deepslate variant or an ore, and refusing to dig them meant the bot
  // could never get past the top of the deepslate layer.
  await check('ordinary deep blocks and ores are diggable', () => {
    const bot = worldOf();
    for (const name of ['deepslate', 'cobbled_deepslate', 'tuff', 'calcite',
      'dripstone_block', 'deepslate_iron_ore', 'deepslate_diamond_ore', 'gravel']) {
      const block = { name, position: at(0, 0, 0), boundingBox: 'block' };
      assert.strictEqual(safeToDig(bot, block), true, `${name} should be diggable`);
    }
  });

  await check('bedrock and containers are never dug', () => {
    const bot = worldOf();
    for (const name of ['bedrock', 'obsidian', 'spawner', 'chest', 'reinforced_deepslate']) {
      const block = { name, position: at(0, 0, 0), boundingBox: 'block' };
      assert.strictEqual(safeToDig(bot, block), false, `${name} must not be dug`);
    }
  });

  await check('liquids are never dug', () => {
    const bot = worldOf();
    assert.strictEqual(safeToDig(bot, { name: 'lava', position: at(0, 0, 0) }), false);
    assert.strictEqual(safeToDig(bot, { name: 'water', position: at(0, 0, 0) }), false);
    assert.strictEqual(safeToDig(bot, { name: 'flowing_lava', position: at(0, 0, 0) }), false);
  });

  // The important one. Checking only the block itself, or only what's beneath
  // it, lets the bot break into a lava pocket from the side.
  await check('a block with lava on ANY face is left alone', () => {
    const faces = {
      '1,0,0': 'lava',
      '-1,0,0': 'lava',
      '0,1,0': 'lava',
      '0,-1,0': 'lava',
      '0,0,1': 'lava',
      '0,0,-1': 'lava',
    };
    for (const key of Object.keys(faces)) {
      const bot = worldOf({ [key]: 'lava' });
      const block = { name: 'deepslate', position: at(0, 0, 0), boundingBox: 'block' };
      assert.strictEqual(lavaAdjacent(bot, block.position), true, `lava at ${key} not detected`);
      assert.strictEqual(safeToDig(bot, block), false, `dug next to lava at ${key}`);
    }
  });

  await check('stone surrounded by stone is fine', () => {
    const bot = worldOf();
    const block = { name: 'deepslate', position: at(0, 0, 0), boundingBox: 'block' };
    assert.strictEqual(lavaAdjacent(bot, block.position), false);
    assert.strictEqual(safeToDig(bot, block), true);
  });

  console.log('\nfooting');

  await check('solid ground underfoot is footing', () => {
    assert.strictEqual(hasFooting(worldOf(), at(0, 0, 0)), true);
  });

  await check('a cavern below is not footing', () => {
    const bot = worldOf({ '0,-1,0': 'air', '0,-2,0': 'air', '0,-3,0': 'air' });
    assert.strictEqual(hasFooting(bot, at(0, 0, 0)), false, 'would have walked into a fall');
  });

  await check('a short drop onto solid ground is acceptable', () => {
    const bot = worldOf({ '0,-1,0': 'air' });
    assert.strictEqual(hasFooting(bot, at(0, 0, 0)), true);
  });

  await check('lava below is never footing', () => {
    const bot = worldOf({ '0,-1,0': 'lava' });
    assert.strictEqual(hasFooting(bot, at(0, 0, 0)), false);
  });

  await check('an unloaded chunk is not assumed safe', () => {
    const bot = worldOf({ '0,-1,0': null, '0,-2,0': null, '0,-3,0': null });
    assert.strictEqual(hasFooting(bot, at(0, 0, 0)), false);
  });

  console.log('\nstepping (fall + lava safety)');

  // Every manual step the bot takes — staircases, tunnels, strip mining,
  // escaping a pit — used to move blind. Pathfinder's drop limits don't apply
  // when we drive the controls ourselves.
  function botAt(overrides) {
    const world = worldOf(overrides);
    return { ...world, entity: { position: at(0, 0, 0) } };
  }

  await check('a normal step onto solid ground is safe', () => {
    assert.strictEqual(stepIsSafe(botAt({ '1,0,0': 'air', '1,1,0': 'air' }), at(1, 0, 0)), true);
  });

  await check('stepping into lava is refused', () => {
    assert.strictEqual(stepIsSafe(botAt({ '1,0,0': 'lava' }), at(1, 0, 0)), false);
  });

  await check('lava at head height is refused', () => {
    assert.strictEqual(stepIsSafe(botAt({ '1,0,0': 'air', '1,1,0': 'lava' }), at(1, 0, 0)), false);
  });

  await check('lava underfoot is refused', () => {
    assert.strictEqual(stepIsSafe(botAt({ '1,0,0': 'air', '1,-1,0': 'lava' }), at(1, 0, 0)), false);
  });

  await check('stepping into a deep pit is refused', () => {
    const pit = {
      '1,0,0': 'air', '1,-1,0': 'air', '1,-2,0': 'air', '1,-3,0': 'air', '1,-4,0': 'air',
    };
    assert.strictEqual(stepIsSafe(botAt(pit), at(1, 0, 0)), false, 'that is a fall, not a step');
  });

  await check('a survivable drop is still a step', () => {
    assert.strictEqual(stepIsSafe(botAt({ '1,0,0': 'air', '1,-1,0': 'air' }), at(1, 0, 0)), true);
  });

  await check('unloaded ground is treated as unsafe', () => {
    const unknown = {
      '1,0,0': 'air', '1,-1,0': null, '1,-2,0': null, '1,-3,0': null,
    };
    assert.strictEqual(stepIsSafe(botAt(unknown), at(1, 0, 0)), false);
  });

  console.log('\nthe gravel collapse that killed a bot');

  /**
   * The failure this section guards against: fifteen points of suffocation
   * damage over roughly a minute, watched live, while `stripMine` kept
   * advancing into the same hanging gravel deposit and the reactive dig-out in
   * survive.js cleared one block at a time — never fast enough to win, because
   * a fresh gravel block fell into the cleared space before the next check.
   *
   * `clearOverheadFalling` is the proactive half: check what is hanging above
   * the space about to be walked into, and clear it BEFORE stepping in, the
   * way a player does without thinking about it.
   */

  await check('gravel and sand are recognised; ordinary stone is not', () => {
    for (const name of ['gravel', 'sand', 'red_sand']) {
      assert.strictEqual(isFallingBlock({ name }), true, `${name} should be recognised as falling`);
    }
    for (const name of ['stone', 'deepslate', 'dirt', 'cobblestone']) {
      assert.strictEqual(isFallingBlock({ name }), false, `${name} is not gravity-affected`);
    }
  });

  /** A digBlock-compatible fake bot backed by a mutable column of blocks. */
  function diggableBot(column) {
    const map = { ...column };
    return {
      canDigBlock: () => true,
      heldItem: undefined,
      inventory: { items: () => [] },
      stopDigging() {},
      blockAt(pos) {
        const key = `${pos.x},${pos.y},${pos.z}`;
        const name = Object.prototype.hasOwnProperty.call(map, key) ? map[key] : 'stone';
        return { name, position: new Vec3(pos.x, pos.y, pos.z), boundingBox: 'block' };
      },
      async dig(block) {
        const key = `${block.position.x},${block.position.y},${block.position.z}`;
        map[key] = 'air';
      },
    };
  }

  await check('a hanging gravel deposit is dug out before the bot would walk under it', async () => {
    const head = at(5, 10, 5);
    const bot = diggableBot({
      '5,11,5': 'gravel', // directly above the head cell — this is what falls
      '5,12,5': 'gravel', // and this, once the first is gone
      '5,13,5': 'stone',  // the ceiling of the actual deposit
    });
    const task = new Task('test');
    const cleared = await clearOverheadFalling(bot, task, head);
    assert.strictEqual(cleared, 2, 'both gravel blocks should be cleared, and no further');
    assert.strictEqual(bot.blockAt(at(5, 11, 5)).name, 'air');
    assert.strictEqual(bot.blockAt(at(5, 12, 5)).name, 'air');
    assert.strictEqual(bot.blockAt(at(5, 13, 5)).name, 'stone', 'stops at ordinary stone');
  });

  await check('ordinary rock overhead costs nothing — no digging at all', async () => {
    const head = at(5, 10, 5);
    const bot = diggableBot({});
    let digCalls = 0;
    const realDig = bot.dig.bind(bot);
    bot.dig = async (block) => { digCalls++; return realDig(block); };
    const task = new Task('test');
    const cleared = await clearOverheadFalling(bot, task, head);
    assert.strictEqual(cleared, 0);
    assert.strictEqual(digCalls, 0, 'stone overhead should never trigger a dig');
  });

  /**
   * A world that can be dug and walked in — just enough for the staircase and
   * the pillar. Stone below y=70 and in listed cells, air elsewhere; digging
   * turns a cell to air. Nothing moves the bot, which is fine: these checks are
   * about what gets dug BEFORE a step, not whether the step lands.
   */
  function workingBot({ cells = {}, inventory = [] } = {}) {
    const map = { ...cells };
    const nameAt = (p) => {
      const key = `${p.x},${p.y},${p.z}`;
      if (Object.prototype.hasOwnProperty.call(map, key)) return map[key];
      return p.y < 70 ? 'stone' : 'air';
    };
    const bot = {
      entity: {
        position: at(0.5, 70, 0.5), onGround: true, isInWater: false, velocity: at(0, 0, 0),
      },
      heldItem: undefined,
      inventory: { items: () => inventory },
      canDigBlock: () => true,
      stopDigging() {},
      setControlState() {},
      clearControlStates() {},
      async lookAt() {},
      async equip(item) { bot.heldItem = item; },
      async placeBlock() {},
      blockAt(pos) {
        const p = pos.floored();
        const name = nameAt(p);
        const empty = name === 'air' || name === 'lava' || name === 'water';
        return {
          name, position: p, boundingBox: empty ? 'empty' : 'block', digTime: () => 400,
        };
      },
      async dig(block) {
        map[`${block.position.x},${block.position.y},${block.position.z}`] = 'air';
      },
    };
    return bot;
  }

  const stonePick = {
    name: 'stone_pickaxe', type: 1, count: 1, maxDurability: 131, durabilityUsed: 0,
  };

  // The staircase was the one corridor that never checked overhead. Live, it
  // cut from y=94 to y=41 through a gravel deposit and took twenty-eight
  // suffocation hits doing it.
  await check('the staircase clears hanging gravel before stepping under it', async () => {
    const { digStaircaseDown } = require('../src/behaviors/mine');
    // Heading +x from feet (0,70,0): stepOver is (1,71,0) — make the doorway
    // stone so it has to be dug — and hang gravel directly above it.
    const bot = workingBot({
      cells: { '1,71,0': 'stone', '1,70,0': 'stone', '1,72,0': 'gravel' },
      inventory: [stonePick],
    });
    await digStaircaseDown(bot, new Task('test'), { targetY: -64, maxSteps: 2, startHeading: [1, 0] });
    assert.strictEqual(bot.blockAt(at(1, 72, 0)).name, 'air', 'the gravel over the doorway must go first');
  });

  await check('with no pickaxe left the staircase stops instead of digging by hand', async () => {
    const { digStaircaseDown } = require('../src/behaviors/mine');
    const bot = workingBot({ cells: { '1,71,0': 'stone', '1,70,0': 'stone' } });
    const result = await digStaircaseDown(bot, new Task('test'), { targetY: -64, maxSteps: 4, startHeading: [1, 0] });
    assert.strictEqual(result.reason, 'no pickaxe');
    assert.strictEqual(bot.blockAt(at(1, 71, 0)).name, 'stone', 'nothing may be dug bare-handed');
  });

  // pillarUp never cleared the cell its head had to rise into, so in a two-high
  // tunnel the jump went nowhere and every placement was refused — `gained: 0`
  // in 25 of 35 logged attempts.
  await check('pillaring clears the ceiling it has to rise into', async () => {
    const { pillarUp } = require('../src/inventory');
    const bot = workingBot({
      cells: { '0,72,0': 'stone' }, // the tunnel ceiling, two above the feet
      inventory: [stonePick, { name: 'dirt', type: 2, count: 16 }],
    });
    await pillarUp(bot, new Task('test'), 1);
    assert.strictEqual(bot.blockAt(at(0, 72, 0)).name, 'air');
  });

  await check('...but never opens a ceiling with liquid behind it', async () => {
    const { pillarUp } = require('../src/inventory');
    const bot = workingBot({
      cells: { '0,72,0': 'stone', '0,73,0': 'lava' },
      inventory: [stonePick, { name: 'dirt', type: 2, count: 16 }],
    });
    await pillarUp(bot, new Task('test'), 1);
    assert.strictEqual(bot.blockAt(at(0, 72, 0)).name, 'stone', 'lava would pour straight in');
  });

  /**
   * A bot that really jumps. Feet start at y=70 on a stone column; holding
   * jump while on the ground starts vanilla's arc (per-tick heights below),
   * and landing needs the arc to fall back onto the floor. placeBlock behaves
   * like the server: it refuses while the feet are still inside the target
   * cell, and refuses a cell holding a non-replaceable plant.
   */
  function jumpingBot({ airborneForMs = 0, feetCellBlock = 'air' } = {}) {
    const ARC = [0, 0.42, 0.7532, 1.0013, 1.1661, 1.2522, 1.2492, 1.1708, 1.0156, 0.787, 0.4906, 0.1226];
    let floor = 70;
    let jumpHeld = false;
    let jump = null; // { at, base }
    const airUntil = Date.now() + airborneForMs;
    const plants = { [`0,${floor},0`]: feetCellBlock };
    const placed = [];

    const settle = () => {
      if (jump) {
        const tick = Math.floor((Date.now() - jump.at) / 50);
        const falling = tick > 5;
        if (tick >= ARC.length || (falling && jump.base + ARC[tick] <= floor)) jump = null;
      }
      if (!jump && jumpHeld && Date.now() >= airUntil) jump = { at: Date.now(), base: floor };
    };
    const y = () => {
      settle();
      if (Date.now() < airUntil) return floor + 0.6;
      if (!jump) return floor;
      return jump.base + ARC[Math.floor((Date.now() - jump.at) / 50)];
    };

    const bot = {
      placed,
      entity: {
        get position() { return at(0.5, y(), 0.5); },
        get onGround() { y(); return Date.now() >= airUntil && !jump; },
        isInWater: false,
        velocity: at(0, 0, 0),
      },
      heldItem: undefined,
      inventory: { items: () => [{ name: 'dirt', type: 2, count: 16 }] },
      canDigBlock: () => true,
      stopDigging() {},
      setControlState(control, on) { if (control === 'jump') { jumpHeld = on; settle(); } },
      clearControlStates() {},
      async lookAt() {},
      async equip(item) { bot.heldItem = item; },
      blockAt(pos) {
        const p = pos.floored();
        const key = `${p.x},${p.y},${p.z}`;
        let name = 'air';
        if (p.x === 0 && p.z === 0 && p.y < floor) name = 'stone';
        else if (plants[key]) name = plants[key];
        const solid = name === 'stone';
        return {
          name, position: p, boundingBox: solid ? 'block' : 'empty', digTime: () => 0,
        };
      },
      async dig(block) { delete plants[`${block.position.x},${block.position.y},${block.position.z}`]; },
      async placeBlock(ref) {
        const cell = ref.position.y + 1;
        const plant = plants[`0,${cell},0`];
        if (plant && plant !== 'air') throw new Error(`the block is still ${plant}`);
        if (bot.entity.position.y < cell + 1) throw new Error('the block is still air');
        placed.push(cell);
        floor = cell + 1;
      },
    };
    return bot;
  }

  // Live 09-24: five of six attempts out in the open gained nothing — the
  // placement went out 180ms after pressing jump, while the bot was still
  // coming down from walkOnto's hop, and each next step jumped before the last
  // one had landed.
  await check('pillaring gains every block it is asked for', async () => {
    const { pillarUp } = require('../src/inventory');
    const bot = jumpingBot();
    const gained = await pillarUp(bot, new Task('test'), 3);
    assert.deepStrictEqual(bot.placed, [70, 71, 72]);
    assert.strictEqual(gained, 3, 'measured standing on the top block');
  });

  await check('pillaring that starts in mid-air waits to land first', async () => {
    const { pillarUp } = require('../src/inventory');
    const bot = jumpingBot({ airborneForMs: 300 });
    assert.strictEqual(await pillarUp(bot, new Task('test'), 2), 2);
  });

  await check('...which the old fixed 180ms timing could not do', async () => {
    const bot = jumpingBot({ airborneForMs: 300 });
    bot.setControlState('jump', true);
    await sleep(180);
    await assert.rejects(bot.placeBlock({ position: at(0, 69, 0) }), /still air/);
  });

  // Live on 09-24 the first two and a half minutes went to a bot floating in
  // its flooded staircase, and this used to test that it pillared out. It
  // cannot: there is no jump in water, only a swim-up, and a floating body
  // bobs below the top of its own cell (pinned on the real physics in
  // test/waterSim.test.js). Every attempt was a refusal — "the block is still
  // water", again and again in the 09-26 ravine. So it does not try; getting
  // out of water is leaveWater's job.
  await check('pillaring refuses in water, where the feet can never clear the cell', async () => {
    const { pillarUp } = require('../src/inventory');
    const bot = jumpingBot();
    Object.defineProperty(bot.entity, 'isInWater', { get: () => true });
    Object.defineProperty(bot.entity, 'onGround', { get: () => false });
    assert.strictEqual(await pillarUp(bot, new Task('test'), 1), 0);
    assert.deepStrictEqual(bot.placed, [], 'it tried to place into its own water cell');
  });

  await check('a mushroom where the block goes is broken first', async () => {
    const { pillarUp } = require('../src/inventory');
    const bot = jumpingBot({ feetCellBlock: 'brown_mushroom' });
    assert.strictEqual(await pillarUp(bot, new Task('test'), 1), 1);
  });

  // Live on 09-24: iron mined out of a tunnel ceiling fell straight into the
  // bot, and it then pillared up at the empty hole three times running.
  await check('a drop mined from the ceiling is looked for on the floor, not in the hole', async () => {
    const { stepOntoDrop } = require('../src/inventory');
    const bot = workingBot({ inventory: [{ name: 'dirt', type: 2, count: 16 }] });
    bot.entities = {}; // it has already been picked up
    let moved = false;
    bot.setControlState = (control, on) => { if (on) moved = true; };
    await stepOntoDrop(bot, at(0, 72, 0), new Task('test'));
    assert.strictEqual(moved, false, 'it landed where the bot stands; there is nothing to walk or build to');
  });

  // A workingBot that can also be asked to walk to a drop — it never arrives,
  // which is fine: these checks are about which blocks get DUG.
  function miningBot(cells) {
    const bot = workingBot({ cells, inventory: [stonePick] });
    bot.entities = {};
    bot.pathfinder = { setGoal() {}, goto: async () => { throw new Error('no route'); }, isMoving: () => false };
    bot.dug = [];
    const dig = bot.dig;
    bot.dig = async (block) => { bot.dug.push(`${block.position.x},${block.position.y},${block.position.z}`); await dig(block); };
    return bot;
  }

  // Live on 09-24: two iron left in the floor at the very end of a strip
  // tunnel. The sweep made one pass over a list built once, in offset order, so
  // the lower block was checked while still buried and never looked at again.
  await check('a vein running down into the floor is taken all the way', async () => {
    const { grabOreInReach } = require('../src/behaviors/mine');
    const bot = miningBot({ '1,69,0': 'iron_ore', '1,68,0': 'iron_ore' });
    await grabOreInReach(bot, new Task('test'));
    assert.deepStrictEqual(bot.dug.sort(), ['1,68,0', '1,69,0']);
  });

  // ...and a column of iron left in a tunnel wall two and three blocks up:
  // measured from the feet to the block's corner, it read as out of reach.
  await check('ore high in the wall on the far side is within reach', async () => {
    const { grabOreInReach } = require('../src/behaviors/mine');
    // Feet at (0,70,0); the ore faces the open tunnel at head height +2.
    const bot = miningBot({ '-3,72,-2': 'iron_ore', '-2,72,-2': 'air' });
    await grabOreInReach(bot, new Task('test'));
    assert.deepStrictEqual(bot.dug, ['-3,72,-2']);
  });

  await check('ore up a cave wall is worth walking under — within dig reach', async () => {
    const { UPWARD_ORE_LIMIT, DIG_REACH } = require('../src/behaviors/mine');
    assert.ok(UPWARD_ORE_LIMIT >= 3, 'ore three blocks up is in reach from the floor');
    // ...but only as high as reach from standing directly beneath it.
    assert.ok(UPWARD_ORE_LIMIT + 0.5 <= DIG_REACH);
  });

  await check('the tunnel steers round copper when there is a way round', async () => {
    const { steerAroundUnwantedOre } = require('../src/behaviors/mine');
    const bot = miningBot({ '1,70,0': 'copper_ore' });
    const heading = steerAroundUnwantedOre(bot, at(0, 70, 0), [1, 0]);
    assert.notDeepStrictEqual(heading, [1, 0]);
  });

  await check('...and digs through when copper is the only way on', async () => {
    const { steerAroundUnwantedOre } = require('../src/behaviors/mine');
    const bot = miningBot({ '1,70,0': 'copper_ore', '0,70,1': 'copper_ore', '0,71,-1': 'deepslate_copper_ore' });
    assert.deepStrictEqual(steerAroundUnwantedOre(bot, at(0, 70, 0), [1, 0]), [1, 0]);
  });

  await check('iron ahead is not steered round', async () => {
    const { steerAroundUnwantedOre } = require('../src/behaviors/mine');
    const bot = miningBot({ '1,70,0': 'iron_ore' });
    assert.deepStrictEqual(steerAroundUnwantedOre(bot, at(0, 70, 0), [1, 0]), [1, 0]);
  });

  /**
   * A miningBot that can also be SEARCHED — findOre goes through blocks.js,
   * which falls back to bot.findBlocks for a world it cannot read directly.
   * Only the listed cells hold ore; everything else is stone below y=70 and
   * air above, as in workingBot.
   */
  function searchableBot(cells, pickaxe) {
    const registry = require('minecraft-data')('1.21.9');
    const bot = miningBot(cells);
    bot.registry = registry;
    bot.inventory.items = () => [pickaxe];
    bot.findBlocks = ({ matching, maxDistance, count }) => {
      const ids = new Set(matching);
      return Object.entries(cells)
        .map(([k, name]) => ({ pos: at(...k.split(',').map(Number)), id: registry.blocksByName[name]?.id }))
        .filter(({ pos, id }) => ids.has(id) && pos.distanceTo(bot.entity.position) <= maxDistance)
        .map(({ pos }) => pos)
        .sort((a, b) => a.distanceTo(bot.entity.position) - b.distanceTo(bot.entity.position))
        .slice(0, count);
    };
    return bot;
  }
  const freshMineCtx = () => ({ mine: { skipped: new Map(), lastScanAt: 0 } });
  const ironPick = { name: 'iron_pickaxe', type: 3, count: 1, maxDurability: 250, durabilityUsed: 0 };

  // Live on 09-24: an iron pickaxe, an exposed diamond in view, and eight
  // minutes of `explore`. The sixteen nearest ore were all buried, so the
  // diamond never made the list findOre then filtered.
  await check('buried ore nearer than an exposed diamond does not hide it', async () => {
    const { findOre } = require('../src/behaviors/mine');
    const cells = {};
    for (let i = 0; i < 20; i++) cells[`${(i % 5) - 2},${60 - Math.floor(i / 5)},${(i % 3) - 1}`] = 'deepslate_iron_ore';
    cells['12,70,0'] = 'deepslate_diamond_ore'; // on the floor, open air above: exposed
    const bot = searchableBot(cells, ironPick);
    const found = findOre(bot, freshMineCtx());
    assert.strictEqual(found?.block?.name, 'deepslate_diamond_ore');
  });

  await check('a diamond beside a stone pickaxe is noted, never chosen', async () => {
    const { findOre } = require('../src/behaviors/mine');
    const memory = require('../src/memory');
    const noted = [];
    const realNote = memory.noteOre;
    memory.noteOre = (pos, ore) => noted.push(ore);
    try {
      const bot = searchableBot({ '6,70,0': 'deepslate_diamond_ore' }, stonePick);
      const found = findOre(bot, freshMineCtx());
      assert.notStrictEqual(found?.block?.name, 'deepslate_diamond_ore', 'a stone pickaxe destroys diamond ore');
      assert.deepStrictEqual(noted, ['deepslate_diamond_ore'], 'and it should be written down for later');
    } finally {
      memory.noteOre = realNote;
    }
  });

  await check('a diamond in view interrupts whatever routine work is running', async () => {
    const { valuables } = require('../src/behaviors/mine');
    const { pickBehavior } = require('../src/director');
    const bot = searchableBot({ '8,70,0': 'deepslate_diamond_ore' }, ironPick);
    const ctx = { ...freshMineCtx(), backoff: new Map() };
    assert.strictEqual(valuables.canInterrupt(bot, ctx), true);
    // The director, mid-smelt (38), asked whether anything outranks it.
    const smelting = { name: 'smelt', priority: 38, shouldRun: () => true };
    const got = pickBehavior(bot, ctx, [valuables, smelting], { interruptiveOnly: true, above: 38 });
    assert.strictEqual(got?.name, 'valuables');
  });

  await check('...but not for coal, and not with a pickaxe that would waste it', async () => {
    const { valuables } = require('../src/behaviors/mine');
    const coal = searchableBot({ '8,70,0': 'coal_ore' }, ironPick);
    assert.strictEqual(valuables.canInterrupt(coal, freshMineCtx()), false, 'coal waits for ordinary mining');
    const memory = require('../src/memory');
    const realNote = memory.noteOre;
    memory.noteOre = () => {};
    try {
      const soft = searchableBot({ '8,70,0': 'deepslate_diamond_ore' }, stonePick);
      assert.strictEqual(valuables.canInterrupt(soft, freshMineCtx()), false, 'a stone pickaxe destroys diamond ore');
    } finally {
      memory.noteOre = realNote;
    }
  });

  // 15:46-15:50 on 09-24: the same iron up a ravine wall, six walks, six
  // "no route" — each forgotten after thirty seconds.
  await check('ore it could not get to stays off the list for minutes, not seconds', async () => {
    const { rememberFailedTarget, UNREACHABLE_MEMORY_MS } = require('../src/behaviors/mine');
    const ctx = freshMineCtx();
    rememberFailedTarget(miningBot({}), ctx, '8,80,0', new Error('no route'), false);
    assert.ok(ctx.mine.skipped.get('8,80,0') - Date.now() > 4 * 60 * 1000, 'back on the list within the minute');
    assert.strictEqual(UNREACHABLE_MEMORY_MS >= 5 * 60 * 1000, true);
  });

  await check('...while a Jev "skip" is still only an opinion, asked again soon', async () => {
    const { rememberFailedTarget } = require('../src/behaviors/mine');
    const ctx = freshMineCtx();
    rememberFailedTarget(miningBot({}), ctx, '8,80,0', new Error('Jev said skip'), false);
    assert.ok(ctx.mine.skipped.get('8,80,0') - Date.now() <= 30000);
  });

  // 15:36 on 09-24: pulled out of lava on the way to a diamond, and sent
  // straight back the same way a second later.
  await check('a target whose route ran into lava is left alone for ten minutes', async () => {
    const { rememberFailedTarget, LAVA_ROUTE_MEMORY_MS } = require('../src/behaviors/mine');
    const ctx = freshMineCtx();
    const bot = miningBot({});
    bot.entity.isInLava = true; // interrupted by escapeHazard, still in it
    rememberFailedTarget(bot, ctx, '8,70,0', new Error('preempted'), true);
    assert.ok(ctx.mine.skipped.get('8,70,0') - Date.now() > LAVA_ROUTE_MEMORY_MS - 1000);
  });

  await check('an ordinary preemption forgets nothing', async () => {
    const { rememberFailedTarget } = require('../src/behaviors/mine');
    const ctx = freshMineCtx();
    rememberFailedTarget(miningBot({}), ctx, '8,70,0', new Error('preempted'), true);
    assert.strictEqual(ctx.mine.skipped.has('8,70,0'), false, 'a smelt finishing is not a reason to give up on ore');
  });

  // Cut off at sixty seconds mid-vein on 09-24, benched, and the bot explored
  // away from a diamond still in the wall.
  await check('out of time mid-vein, it stops and writes down what is left', async () => {
    const { grabOreInReach } = require('../src/behaviors/mine');
    const memory = require('../src/memory');
    const noted = [];
    const realNote = memory.noteOre;
    memory.noteOre = (pos, ore, why) => noted.push(`${ore}:${why}`);
    try {
      const bot = miningBot({ '1,69,0': 'iron_ore', '2,70,1': 'iron_ore' });
      const taken = await grabOreInReach(bot, new Task('test'), Date.now() - 1);
      assert.strictEqual(taken, 0);
      assert.deepStrictEqual(bot.dug, []);
      assert.deepStrictEqual(noted.sort(), ['iron_ore:unfinished vein', 'iron_ore:unfinished vein']);
    } finally {
      memory.noteOre = realNote;
    }
  });

  await check('a cave just written off does not hide the next one', () => {
    const { findCave, noteCaveDone } = require('../src/behaviors/mine');
    const bot = miningBot({});
    // Nothing left to mine for, so no depth band applies — this check is
    // about the written-off list alone.
    bot.inventory.items = () => [stonePick, { name: 'iron_ingot', count: 64, type: 9 }];
    const ctx = { mine: {} };
    const first = findCave(bot, ctx);
    assert.ok(first, 'the fake world is all floor and air — there is a cave');
    noteCaveDone(ctx, first);
    const second = findCave(bot, ctx);
    assert.ok(second, 'another cave further off should be offered');
    assert.ok(second.distanceTo(first) > 12, 'and not the written-off one again');
  });

  // Cave work dragged the bot from y=10 to y=-19 on 09-24, floor by floor,
  // until nothing it needed was at that depth.
  await check('caves outside the needed resource\'s band are not offered', () => {
    const { findCave } = require('../src/behaviors/mine');
    const bot = miningBot({}); // stone pickaxe, no iron: needs raw_iron, band up to y=56
    assert.strictEqual(findCave(bot, { mine: {} }), null, 'every cave in this world is at y=70');
  });

  await check('a strip run hands back before the director would cut it off', () => {
    const { STRIP_BUDGET_MS } = require('../src/behaviors/mine');
    const { MAX_BEHAVIOR_MS } = require('../src/director');
    assert.ok(STRIP_BUDGET_MS <= MAX_BEHAVIOR_MS - 10000, 'leave room for the sweep and pickup after the last step');
  });

  // "Built up to reach a drop" gained nothing in 10 of 16 tries on 09-24, each
  // chase up to six seconds, for single items on ledges three to five blocks up.
  await check('a drop on a ledge higher than one pillar is left, not chased', async () => {
    const { stepOntoDrop } = require('../src/inventory');
    const bot = workingBot({ inventory: [{ name: 'dirt', type: 2, count: 16 }] });
    bot.entities = { 7: { name: 'item', isValid: true, position: at(1.5, 74.1, 0.5) } };
    let moved = false;
    bot.setControlState = (control, on) => { if (on) moved = true; };
    await stepOntoDrop(bot, at(1, 74, 0), new Task('test'));
    assert.strictEqual(moved, false);
  });

  await check('a deposit taller than the clear limit does not dig forever', async () => {
    const head = at(5, 10, 5);
    // Six blocks of gravel stacked above the head — deeper than any real
    // deposit is likely to be, and deeper than OVERHEAD_CLEAR_LIMIT (4).
    const column = {};
    for (let dy = 1; dy <= 6; dy++) column[`5,${10 + dy},5`] = 'gravel';
    const bot = diggableBot(column);
    const task = new Task('test');
    const cleared = await clearOverheadFalling(bot, task, head);
    assert.ok(cleared <= 4, 'bounded, so a corrupted or unusually deep deposit cannot loop forever');
  });

  console.log('\nore depths');

  await check('diamond targets the bedrock-adjacent band', () => {
    assert.strictEqual(ORE_DEPTH.diamond.best, -59);
    assert.ok(ORE_DEPTH.diamond.max < 16, 'diamond is not worth looking for above y=16');
  });

  await check('iron targets its underground peak', () => {
    assert.strictEqual(ORE_DEPTH.raw_iron.best, 16);
  });

  // pickaxe 3 + sword 2 + chestplate 8 + leggings 7 + helmet 5 + boots 4
  await check('the goal is a full diamond kit', () => {
    assert.strictEqual(DIAMOND_GOAL, 29, 'a complete diamond set costs exactly 29');
  });

  console.log('\nore scan throttle');

  await check('dropping a candidate also re-opens the scan', () => {
    const ctx = { mine: { candidate: { block: {} }, lastScanAt: Date.now() } };
    dropCandidate(ctx);
    assert.strictEqual(ctx.mine.candidate, null);
    assert.strictEqual(
      ctx.mine.lastScanAt,
      0,
      'clearing the candidate without clearing lastScanAt makes findOre answer '
      + 'null for the rest of the throttle window',
    );
  });

  // The invariant, not an instance of it. Three sites in mine.js used to clear
  // the candidate by hand and only one of them reset the throttle with it; the
  // point of dropCandidate is that there is nowhere left for that to drift.
  await check('nothing clears ctx.mine.candidate except dropCandidate', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'behaviors', 'mine.js'), 'utf8');
    const assignments = src.match(/ctx\.mine\.candidate\s*=\s*null/g) ?? [];
    assert.strictEqual(
      assignments.length,
      1,
      `found ${assignments.length} direct clears of ctx.mine.candidate — every one `
      + 'outside dropCandidate leaves the scan throttled against a stale answer',
    );
  });

  await check('an exhausted sweep waits longer than a cheap one', () => {
    assert.ok(
      EXHAUSTIVE_SCAN_THROTTLE_MS > SCAN_THROTTLE_MS,
      'a sweep that ran its whole radius out is the expensive one — repeating it '
      + 'sooner than a cheap sweep is backwards',
    );
  });

  console.log('\nroutes that do not exist');

  // Iron at 0,40,0 / 1,40,0 / 2,41,1 (diagonal), coal beside it, and iron
  // far off. Everything else is stone.
  const veinWorld = () => {
    const ore = {
      '0,40,0': 'iron_ore', '1,40,0': 'iron_ore', '2,41,1': 'iron_ore',
      '0,40,1': 'coal_ore', '9,40,0': 'iron_ore',
    };
    return {
      blockAt: (p) => ({ name: ore[`${p.x},${p.y},${p.z}`] ?? 'stone', position: p }),
      entity: { position: new Vec3(0, 60, 0) },
    };
  };

  await check('the whole vein shares a route, so it is found as one', () => {
    const vein = veinOf(veinWorld(), '0,40,0').sort();
    assert.deepStrictEqual(vein, ['0,40,0', '1,40,0', '2,41,1'], 'missed the vein, or took the coal or the far iron');
  });

  await check('no route to one block of a vein benches all of it', () => {
    const { rememberFailedTarget } = require('../src/behaviors/mine');
    const ctx = { mine: { skipped: new Map() } };
    rememberFailedTarget(veinWorld(), ctx, '0,40,0', new Error('no route'), false);
    for (const k of ['0,40,0', '1,40,0', '2,41,1']) {
      assert.ok(ctx.mine.skipped.get(k) > Date.now(), `${k} left to walk the same dead route again`);
    }
    assert.ok(!ctx.mine.skipped.has('0,40,1'), 'the coal beside it is a different target');
  });

  await check('a failure that is not about the route stays about the one block', () => {
    const { rememberFailedTarget } = require('../src/behaviors/mine');
    const ctx = { mine: { skipped: new Map() } };
    rememberFailedTarget(veinWorld(), ctx, '0,40,0', new Error('Digging aborted'), false);
    assert.deepStrictEqual([...ctx.mine.skipped.keys()], ['0,40,0']);
  });

  console.log('\nsheltering with walls, not just a lid');

  // The screenshot: a three-deep hole on a slope. Bot's feet at 0,64,0; all
  // ground solid below y=64 and to the uphill side, but the downhill side
  // (+x) is open air at feet and head height. Placing makes the target cell
  // solid, the way the game does.
  const holeOnSlope = () => {
    const solid = new Set();
    for (let x = -3; x <= 3; x++) {
      for (let z = -3; z <= 3; z++) {
        for (let y = 60; y <= 66; y++) {
          const inShaft = x === 0 && z === 0 && y >= 64;
          const downhill = x >= 1 && y >= 64;
          if (!inShaft && !downhill) solid.add(`${x},${y},${z}`);
        }
      }
    }
    const blockAt = (p) => ({
      name: solid.has(`${p.x},${p.y},${p.z}`) ? 'dirt' : 'air',
      boundingBox: solid.has(`${p.x},${p.y},${p.z}`) ? 'block' : 'empty',
      position: p,
    });
    const dirt = { name: 'dirt', type: 9, count: 16 };
    return {
      entity: { position: new Vec3(0.5, 64, 0.5) },
      heldItem: dirt,
      inventory: { items: () => [dirt], slots: [] },
      blockAt,
      placed: [],
      placeBlock(ref, face) {
        const dest = ref.position.plus(face);
        solid.add(`${dest.x},${dest.y},${dest.z}`);
        this.placed.push(`${dest.x},${dest.y},${dest.z}`);
        return Promise.resolve();
      },
    };
  };

  await check('a hole on a slope is found to have open sides', () => {
    const { openWalls } = require('../src/behaviors/shelter');
    const gaps = openWalls(holeOnSlope()).map((g) => `${g.cell.x},${g.cell.y},${g.cell.z}`).sort();
    assert.deepStrictEqual(gaps, ['1,64,0', '1,65,0'], 'the downhill wall at feet and head height');
  });

  await check('and both are filled — feet first, so the head block has something under it', async () => {
    const { sealWalls, openWalls } = require('../src/behaviors/shelter');
    const bot = holeOnSlope();
    const result = await sealWalls(bot, new Task('shelter'));
    assert.strictEqual(result.open, 0, 'a side left open all night');
    assert.strictEqual(openWalls(bot).length, 0);
    assert.deepStrictEqual(bot.placed, ['1,64,0', '1,65,0']);
  });

  await check('a hole in flat ground needs no extra blocks', async () => {
    const { sealWalls } = require('../src/behaviors/shelter');
    const bot = holeOnSlope();
    const flat = bot.blockAt;
    bot.blockAt = (p) => (p.x === 1 && p.z === 0 && (p.y === 64 || p.y === 65)
      ? { name: 'dirt', boundingBox: 'block', position: p }
      : flat(p));
    await sealWalls(bot, new Task('shelter'));
    assert.deepStrictEqual(bot.placed, [], 'wasted blocks on walls that were already there');
  });

  console.log('\ndigging straight down');

  // A walking bot: while `forward` is held it moves toward whatever it last
  // looked at, at sneaking speed — enough physics to see where it stops.
  const walker = (x, z) => {
    const bot = {
      entity: { position: new Vec3(x, 64, z), height: 1.62, onGround: true },
      controls: {},
      look: null,
      setControlState(k, v) { this.controls[k] = v; },
      lookAt(t) { this.look = t; return Promise.resolve(); },
    };
    bot.timer = setInterval(() => {
      if (!bot.controls.forward || !bot.look) return;
      const p = bot.entity.position;
      const dx = bot.look.x - p.x;
      const dz = bot.look.z - p.z;
      const d = Math.hypot(dx, dz);
      const step = Math.min(0.065, d);
      if (d > 0) { p.x += (dx / d) * step; p.z += (dz / d) * step; }
    }, 10);
    return bot;
  };

  await check('a bot on the edge of its block is walked to the middle before digging', async () => {
    const bot = walker(10.92, 10.1); // hitbox overlapping two neighbours
    try {
      assert.ok(offCentre(bot) > 0.2, 'fixture should start off-centre');
      assert.strictEqual(await centreOnBlock(bot, null), true);
      assert.ok(offCentre(bot) <= 0.2, `still ${offCentre(bot).toFixed(2)} off — it would stay on the rim`);
      assert.strictEqual(Math.floor(bot.entity.position.x), 10, 'wandered into the next block');
      assert.strictEqual(bot.controls.forward, false, 'left walking');
      assert.strictEqual(bot.controls.sneak, false, 'left sneaking');
    } finally {
      clearInterval(bot.timer);
    }
  });

  await check('a perched bot is steered back over the hole it dug, not the rim', async () => {
    // Dug at 10,10; now standing across the edge in block 11 — the rim.
    const bot = walker(11.15, 10.5);
    try {
      await centreOnBlock(bot, null, new Vec3(10, 63, 10));
      assert.strictEqual(Math.floor(bot.entity.position.x), 10, 'recentred on the rim instead of the hole');
    } finally {
      clearInterval(bot.timer);
    }
  });

  await check('an already-centred bot is not touched', async () => {
    const bot = walker(10.5, 10.5);
    try {
      await centreOnBlock(bot, null);
      assert.strictEqual(bot.controls.forward, undefined);
    } finally {
      clearInterval(bot.timer);
    }
  });

  // ---------------------------------------------------------------------------
  console.log('\nthe night shift');

  // Never once ran: every session on record, "Mining through the night" zero
  // times, because the gate counted food ITEMS and the bot sat at 20/20 hunger
  // with an empty bag.
  // Two logs: eight planks, past the pickaxe reserve with room to spare.
  const twoLogs = { name: 'oak_log', count: 2, type: 2 };
  function nightBot({ food = 20, health = 20, items } = {}) {
    return {
      health,
      food,
      entity: { position: at(0.5, 70, 0.5) },
      inventory: { items: () => items ?? [stonePick, twoLogs], slots: [] },
      registry: { itemsByName: {} },
    };
  }

  await check('a full hunger bar is enough to mine the night, with nothing in the bag', () => {
    const { whyNotMineHere } = require('../src/behaviors/shelter');
    assert.strictEqual(whyNotMineHere(nightBot()), null);
  });

  await check('...but a low bar and an empty bag is not', () => {
    const { whyNotMineHere } = require('../src/behaviors/shelter');
    assert.strictEqual(whyNotMineHere(nightBot({ food: 10 })), 'food');
  });

  await check('no pickaxe and hurt are still reasons to wait it out', () => {
    const { whyNotMineHere } = require('../src/behaviors/shelter');
    assert.strictEqual(whyNotMineHere(nightBot({ items: [] })), 'no pickaxe');
    assert.strictEqual(whyNotMineHere(nightBot({ health: 5 })), 'hurt');
  });

  // The night staircase is a descent, and it used to be the only one with no
  // kit check: wooden pickaxe, no cobble, no food, "carrying on below".
  await check('no night staircase before the trip kit — the night is the workshop instead', () => {
    const { whyNotMineHere } = require('../src/behaviors/shelter');
    const why = whyNotMineHere(nightBot(), {});
    assert.ok(why && why.startsWith('not ready for the deep'), `got ${why}`);
    assert.ok(why.includes('planks'), 'and it says what is missing');
    assert.strictEqual(whyNotMineHere(nightBot()), null, 'without a ctx (the old callers) nothing changes');
  });

  // 09-26: dug in at the edge of a pond; the morning's dig-out let it pour in.
  await check('no shelter at the water\'s edge: it finds dry ground a few blocks off', () => {
    const { waterBeside, dryGroundNear } = require('../src/behaviors/shelter');
    // Grass at y=62 everywhere, a pond filling x in [-4, -1] at y=62.
    const pond = (x) => x >= -4 && x <= -1;
    const bot = {
      entity: { position: at(0.5, 63, 0.5), onGround: true },
      blockAt: (p) => {
        let name = 'air';
        if (p.y < 62) name = 'dirt';
        else if (p.y === 62) name = pond(p.x) ? 'water' : 'grass_block';
        const solid = name === 'dirt' || name === 'grass_block';
        return { name, position: p, boundingBox: solid ? 'block' : 'empty' };
      },
    };
    assert.strictEqual(waterBeside(bot, at(0, 63, 0)), true, 'a block from the pond');
    const dry = dryGroundNear(bot);
    assert.ok(dry, 'found somewhere');
    assert.strictEqual(waterBeside(bot, dry), false);
    assert.strictEqual(dry.y, 63, 'standing on the grass, not in it');
    assert.ok(dry.x >= 2, `away from the pond, got x=${dry.x}`);
  });

  // 09-25: the pickaxe wore out at y=55 with too little wood for a table and
  // sticks, and the bot starved underground with 203 cobble.
  await check('no night staircase without the wood for the next pickaxe', () => {
    const { whyNotMineHere, pickaxeWoodReserve } = require('../src/behaviors/shelter');
    assert.strictEqual(whyNotMineHere(nightBot({ items: [stonePick] })), 'wood');
    const bot = nightBot();
    assert.strictEqual(pickaxeWoodReserve(bot), 6, 'a table (4) and one batch of sticks (2)');
    const carrying = nightBot({ items: [stonePick, { name: 'crafting_table', count: 1, type: 3 }] });
    assert.strictEqual(pickaxeWoodReserve(carrying), 2, 'a carried table is already paid for');
  });

  // 09-25 17:13: dug out at first light at 6 health beside a creeper, which
  // does not burn in daylight, and died to it.
  function atTheRim(health, mobs, { food = 20, items } = {}) {
    const bot = nightBot({ health, food, items });
    bot.entity = { position: at(0.5, 67, 0.5) };
    bot.entities = Object.fromEntries(mobs.map(([name, x], i) => [i + 1, {
      id: i + 1, name, type: 'hostile', position: at(x, 70, 0), isValid: true, metadata: [],
    }]));
    return bot;
  }

  await check('a creeper by the shaft at dawn: stay down', () => {
    const { unsafeToSurface } = require('../src/behaviors/shelter');
    assert.strictEqual(unsafeToSurface(atTheRim(20, [['creeper', 4]])), 'creeper');
  });

  await check('hurt, with a zombie up there: stay down', () => {
    const { unsafeToSurface } = require('../src/behaviors/shelter');
    assert.strictEqual(unsafeToSurface(atTheRim(6, [['zombie', 3]])), 'hurt, with company');
  });

  const stoneSword = { name: 'stone_sword', count: 1, type: 4 };
  const woodenSword = { name: 'wooden_sword', count: 1, type: 5 };

  await check('healthy, fed and armed with a zombie, or nothing nearby: come up', () => {
    const { unsafeToSurface } = require('../src/behaviors/shelter');
    assert.strictEqual(unsafeToSurface(atTheRim(20, [['zombie', 3]], { items: [stonePick, stoneSword] })), null);
    assert.strictEqual(unsafeToSurface(atTheRim(6, [['zombie', 30]])), null);
  });

  // 09-26 07:27: out at dawn, food 3, wooden sword, a zombie in the pond.
  await check('a zombie at the rim and only a wooden sword, or no food to heal: stay down', () => {
    const { unsafeToSurface } = require('../src/behaviors/shelter');
    assert.strictEqual(unsafeToSurface(atTheRim(19, [['zombie', 3]], { items: [stonePick, woodenSword] })),
      'company, and no real weapon');
    assert.strictEqual(unsafeToSurface(atTheRim(19, [['zombie', 3]], { food: 3, items: [stonePick, stoneSword] })),
      'company, and too hungry to heal');
  });

  // ---------------------------------------------------------------------------
  console.log('\na place for the table at the bottom of a shaft');

  // "Nowhere clear to place block {tried: 0}" thirty-four times on one world:
  // a 1x1 shaft has no air beside it, so the stone pickaxe was never made.
  const SHAFT = {
    '1,70,0': 'stone', '-1,70,0': 'stone', '0,70,1': 'stone', '0,70,-1': 'stone',
  };

  await check('a one-wide shaft gets a niche cut into its wall', async () => {
    const { carvePlacementSpot } = require('../src/stations');
    const bot = workingBot({ cells: { ...SHAFT }, inventory: [stonePick] });
    const ref = await carvePlacementSpot(bot, new Task('test'));
    assert.ok(ref, 'there is a wall to cut into');
    const niche = ref.position.offset(0, 1, 0);
    assert.strictEqual(bot.blockAt(niche).name, 'air', 'the cell above the reference is the niche');
    assert.strictEqual(niche.y, 70, 'at feet level');
  });

  await check('never a wall with water behind it', async () => {
    const { carvePlacementSpot } = require('../src/stations');
    const bot = workingBot({
      cells: {
        ...SHAFT, '2,70,0': 'water', '-1,70,0': 'bedrock', '0,70,1': 'bedrock', '0,70,-1': 'bedrock',
      },
      inventory: [stonePick],
    });
    assert.strictEqual(await carvePlacementSpot(bot, new Task('test')), null);
    assert.strictEqual(bot.blockAt(at(1, 70, 0)).name, 'stone', 'the wet wall is untouched');
  });

  await check('never a wall with gravel hanging over it', async () => {
    const { carvePlacementSpot } = require('../src/stations');
    const bot = workingBot({
      cells: {
        ...SHAFT, '1,71,0': 'gravel', '-1,70,0': 'bedrock', '0,70,1': 'bedrock', '0,70,-1': 'bedrock',
      },
      inventory: [stonePick],
    });
    assert.strictEqual(await carvePlacementSpot(bot, new Task('test')), null);
  });

  // 09-25 night: three tables built in one shaft, no wood left for the sticks
  // of an iron pickaxe with five ingots in the bag.
  function stationBot(cells) {
    const bot = workingBot({ cells, inventory: [stonePick] });
    bot.registry = { blocksByName: { crafting_table: { id: 1 }, furnace: { id: 2 } } };
    bot.findBlocks = ({ matching }) => Object.entries(bot.cellsForTest)
      .filter(([, name]) => (name === 'crafting_table' && matching.includes(1))
        || (name === 'furnace' && matching.includes(2)))
      .map(([k]) => at(...k.split(',').map(Number)));
    bot.cellsForTest = cells;
    const dig = bot.dig;
    bot.dig = async (block) => {
      delete bot.cellsForTest[`${block.position.x},${block.position.y},${block.position.z}`];
      return dig(block);
    };
    return bot;
  }

  await check('the table goes down the staircase with the bot', async () => {
    const { packUpStations } = require('../src/behaviors/shelter');
    const bot = stationBot({ '1,70,0': 'crafting_table', '-1,70,0': 'furnace' });
    await packUpStations(bot, { smelt: { pending: null } }, new Task('test'));
    assert.strictEqual(bot.blockAt(at(1, 70, 0)).name, 'air', 'table packed');
    assert.strictEqual(bot.blockAt(at(-1, 70, 0)).name, 'air', 'empty furnace packed');
  });

  await check('...but never a furnace with a batch still in it', async () => {
    const { packUpStations } = require('../src/behaviors/shelter');
    const bot = stationBot({ '-1,70,0': 'furnace' });
    await packUpStations(bot, { smelt: { pending: { at: at(-1, 70, 0) } } }, new Task('test'));
    assert.strictEqual(bot.blockAt(at(-1, 70, 0)).name, 'furnace');
  });

  await check('in stay-put mode a station out of reach is not walked to', async () => {
    const { stayingPut, standAt } = require('../src/stations');
    const bot = workingBot({ inventory: [stonePick] });
    let walked = false;
    bot.pathfinder = { goto: async () => { walked = true; }, setGoal() {}, stop() {} };
    const far = { name: 'crafting_table', position: at(10, 70, 0) };
    const got = await stayingPut(() => standAt(bot, far, new Task('test')));
    assert.strictEqual(got, null);
    assert.strictEqual(walked, false, 'a walk from a sealed shelter is a walk out of it');
  });

  console.log(`\n${passed} checks passed`);
}

main();
