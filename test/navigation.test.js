/**
 * Can the bot notice that it cannot move?
 *
 * This suite exists because of one specific, very expensive failure. The bot
 * was found frozen at 434,64,486 for minutes at a time: every navigation leg
 * failed, `wood`, `gatherStone` and `mine` took turns discovering that and
 * backing off, and `unstick` — the one behavior that could have helped —
 * never ran, because it only ever asked "am I walled in?" and the answer was
 * no. It was standing in a clearing. It simply could not get anywhere.
 *
 * The leaf-canopy report is the same failure in its most obvious costume.
 *
 * Run with: node test/navigation.test.js
 */

const assert = require('assert');
const Vec3 = require('vec3');
const {
  unstick, isConfined, isSoftObstruction, STUCK_AFTER_MS, NAV_FAILURES_STUCK,
  canDigThrough,
} = require('../src/behaviors/unstick');
const { groundUnder } = require('../src/nav');
const { shelter } = require('../src/behaviors/shelter');
const { threat } = require('../src/behaviors/threat');

let passed = 0;
function check(label, fn) {
  try {
    fn();
    passed++;
    console.log(`  ok  ${label}`);
  } catch (err) {
    console.error(`  FAIL ${label}: ${err.message}`);
    process.exitCode = 1;
  }
}

const EMPTY = new Set(['air', 'cave_air', 'water', 'lava', 'tall_grass']);

/** A tiny world: "x,y,z" -> block name; everything unlisted is `fill`. */
function botAt(pos, overrides = {}, fill = 'air') {
  return {
    entity: { position: new Vec3(pos[0], pos[1], pos[2]) },
    blockAt(p) {
      const key = `${p.x},${p.y},${p.z}`;
      const name = Object.prototype.hasOwnProperty.call(overrides, key)
        ? overrides[key]
        : fill;
      if (name === null) return null;
      return {
        name,
        position: new Vec3(p.x, p.y, p.z),
        boundingBox: EMPTY.has(name) ? 'empty' : 'block',
      };
    },
  };
}

/** Ordinary ground at y=63 under an open sky, bot standing at y=64. */
function openGround() {
  const floor = {};
  for (let dx = -2; dx <= 2; dx++) {
    for (let dz = -2; dz <= 2; dz++) {
      floor[`${dx},63,${dz}`] = 'grass_block';
    }
  }
  return botAt([0, 64, 0], floor);
}

function freshCtx(overrides = {}) {
  return {
    currentBehavior: 'wood',
    stuck: { anchor: new Vec3(0, 64, 0), since: Date.now() - (STUCK_AFTER_MS + 1000) },
    ...overrides,
  };
}

console.log('recognising an obstruction');

check('leaves are something to cut through, not a wall to accept', () => {
  for (const name of ['oak_leaves', 'birch_leaves', 'spruce_leaves', 'azalea_leaves']) {
    assert.strictEqual(
      isSoftObstruction({ name }),
      true,
      `${name} should be clearable`,
    );
  }
});

// Only things with a real bounding box actually obstruct. Flowers, tall
// grass and saplings are walk-through in Minecraft, so they never reach this
// test in practice — the caller filters on boundingBox first.
check('vines, undergrowth and snow count too', () => {
  for (const name of ['vine', 'cave_vines', 'snow', 'tall_grass', 'large_fern']) {
    assert.strictEqual(isSoftObstruction({ name }), true, `${name} should be clearable`);
  }
});

check('stone and bedrock are not soft obstructions', () => {
  for (const name of ['stone', 'bedrock', 'deepslate', 'obsidian']) {
    assert.strictEqual(isSoftObstruction({ name }), false, `${name} is not soft`);
  }
});

// grass_block is the floor, not undergrowth. An unanchored /grass/ matched it.
check('grass_block is ground, not undergrowth', () => {
  for (const name of ['grass_block', 'snow_block', 'moss_block']) {
    assert.strictEqual(isSoftObstruction({ name }), false, `${name} is terrain`);
  }
});

console.log('\nfinding the floor under our own feet');

/**
 * A block at integer y occupies [y, y+1), so a player standing on the block
 * at y=83 has its feet at y=84.0 — but the server reports 83.99999 often
 * enough to matter, and that floors to 83. The naive floor(y)-1 probe then
 * lands on y=82: air, one block below the actual floor.
 *
 * This killed the bot. `shelter` refused to burrow at night ("Not digging
 * through that to shelter {block: air}") while it stood at 1 health next to
 * a zombie.
 */
check('a bot standing cleanly on a block finds it', () => {
  const bot = botAt([0, 84, 0], { '0,83,0': 'grass_block' });
  const ground = groundUnder(bot);
  assert.ok(ground, 'should find the floor');
  assert.strictEqual(ground.name, 'grass_block');
  assert.strictEqual(ground.position.y, 83);
});

check('a Y a hair under the integer still finds the same block', () => {
  const bot = botAt([0, 83.99999, 0], { '0,83,0': 'grass_block' });
  const ground = groundUnder(bot);
  assert.ok(ground, 'should still find the floor');
  assert.strictEqual(ground.position.y, 83, 'must not be off by one');
});

check('the block above the floor is never mistaken for it', () => {
  const bot = botAt([0, 84, 0], { '0,83,0': 'stone', '0,84,0': 'air' });
  assert.strictEqual(groundUnder(bot).name, 'stone');
});

check('nothing solid below means no ground, not a wrong answer', () => {
  assert.strictEqual(groundUnder(botAt([0, 84, 0], {}, 'air')), null);
});

check('water underfoot is not ground', () => {
  const bot = botAt([0, 84, 0], { '0,83,0': 'water', '0,82,0': 'water' }, 'air');
  assert.strictEqual(groundUnder(bot), null);
});

console.log('\nbeing walled in');

check('open ground is not confinement', () => {
  assert.strictEqual(isConfined(openGround()), false);
});

// The reported trap, modelled directly: standing inside a tree with leaves
// filling every cell the bot could step into.
check('a leaf canopy packed around the bot IS confinement', () => {
  const bot = botAt([0, 64, 0], {}, 'oak_leaves');
  assert.strictEqual(isConfined(bot), true);
});

check('a sealed stone pocket is confinement', () => {
  const bot = botAt([0, 64, 0], {}, 'stone');
  assert.strictEqual(isConfined(bot), true);
});

check('one walkable gap is enough to not be confined', () => {
  // Solid everywhere except a single standable cell to the east.
  const bot = botAt([0, 64, 0], {
    '1,64,0': 'air',
    '1,65,0': 'air',
    '1,63,0': 'stone',
  }, 'stone');
  assert.strictEqual(isConfined(bot), false);
});

check('a gap floored with lava is not an escape route', () => {
  const bot = botAt([0, 64, 0], {
    '1,64,0': 'air',
    '1,65,0': 'air',
    '1,63,0': 'lava',
  }, 'stone');
  assert.strictEqual(isConfined(bot), true);
});

console.log('\nnoticing that nothing can be reached');

// This is the bug. The bot is NOT walled in — there is grass in every
// direction — but no leg it attempts succeeds. Before, shouldRun returned
// false here and the bot stood there indefinitely.
check('repeated navigation failures in open ground count as stuck', () => {
  const bot = openGround();
  bot.navHealth = { failures: NAV_FAILURES_STUCK, lastFailAt: Date.now(), lastOkAt: 0 };
  assert.strictEqual(unstick.shouldRun(bot, freshCtx()), true);
});

check('standing still with working navigation is not stuck', () => {
  const bot = openGround();
  bot.navHealth = { failures: 0, lastFailAt: 0, lastOkAt: Date.now() };
  assert.strictEqual(unstick.shouldRun(bot, freshCtx()), false);
});

check('one or two failed legs is just bad luck, not a trap', () => {
  const bot = openGround();
  bot.navHealth = { failures: NAV_FAILURES_STUCK - 1, lastFailAt: Date.now(), lastOkAt: 0 };
  assert.strictEqual(unstick.shouldRun(bot, freshCtx()), false);
});

check('old failures expire — a bot that has since moved is fine', () => {
  const bot = openGround();
  bot.navHealth = {
    failures: NAV_FAILURES_STUCK + 5,
    lastFailAt: Date.now() - 60000,
    lastOkAt: 0,
  };
  assert.strictEqual(unstick.shouldRun(bot, freshCtx()), false);
});

check('a bot with no navigation history yet is not stuck', () => {
  assert.strictEqual(unstick.shouldRun(openGround(), freshCtx()), false);
});

console.log('\nnot firing when standing still is correct');

// Sealed in a hole on purpose, or asleep. unstick outranks both, so without
// this it digs the bot straight back up into whatever it was hiding from.
check('deliberately stationary behaviors are left alone', () => {
  for (const name of ['shelter', 'bed', 'smelt', 'gear', 'tidy']) {
    const bot = botAt([0, 64, 0], {}, 'stone'); // genuinely walled in
    bot.navHealth = { failures: 9, lastFailAt: Date.now(), lastOkAt: 0 };
    assert.strictEqual(
      unstick.shouldRun(bot, freshCtx({ currentBehavior: name })),
      false,
      `${name} should not trigger unstick`,
    );
  }
});

check('the stuck-watch is reset while a stationary behavior runs', () => {
  const bot = openGround();
  const ctx = freshCtx({ currentBehavior: 'smelt' });
  const staleSince = ctx.stuck.since;
  unstick.shouldRun(bot, ctx);
  assert.ok(ctx.stuck.since > staleSince, 'since should have been refreshed');
});

check('being walled in is not enough on its own — it has to last', () => {
  const bot = botAt([0, 64, 0], {}, 'stone');
  const ctx = freshCtx({ stuck: { anchor: new Vec3(0, 64, 0), since: Date.now() } });
  assert.strictEqual(unstick.shouldRun(bot, ctx), false);
});

check('having moved away resets the watch rather than firing', () => {
  const bot = openGround();
  bot.entity.position = new Vec3(40, 64, 40); // well past STUCK_CHECK_RADIUS
  bot.navHealth = { failures: 9, lastFailAt: Date.now(), lastOkAt: 0 };
  const ctx = freshCtx();
  assert.strictEqual(unstick.shouldRun(bot, ctx), false);
  assert.strictEqual(ctx.stuck.anchor.x, 40, 'anchor should follow the bot');
});

console.log('\ndigging in when cornered');

/**
 * The bar to shelter is "hostiles are on me". The bar to REFUSE used to be
 * "a hostile is within five blocks" — and at night, being chased, those are
 * the same condition, so the behavior could never run when it was needed.
 * Three deaths in one session traced to it, each wiping the tool progression
 * back to nothing.
 */
function nightBot(hostiles, { health = 20, items = [], y = 64, sky = 15 } = {}) {
  const entities = {};
  hostiles.forEach(([name, distance], i) => {
    entities[i] = {
      id: i,
      name,
      isValid: true,
      type: 'hostile',
      position: new Vec3(distance, y, 0),
    };
  });
  return {
    health,
    // Midnight, as a TICK. shelter used to read bot.time.isDay and now shares
    // world.js's one definition of night, which is computed from timeOfDay —
    // so a mock that only sets isDay describes a bot whose clock has not been
    // set at all, and everything that depends on the time quietly stops
    // firing. That is precisely the bug the shared definition exists to
    // prevent, so the mock has to carry the real field.
    time: { isDay: false, timeOfDay: 18000, day: 1 },
    entity: { position: new Vec3(0, y, 0) },
    entities,
    inventory: { items: () => items.map((name, i) => ({ name, count: 1, type: i })) },
    // world.js reads light to decide whether we are already underground.
    // A uniform sample means "no usable lighting data", which makes it fall
    // back to the depth heuristic — exactly the path a real server without
    // per-block light would take.
    blockAt: (p) => ({
      name: 'air',
      position: p,
      boundingBox: 'empty',
      light: 0,
      skyLight: sky,
    }),
  };
}

const shelterCtx = () => ({ shelter: { until: 0 } });

check('hostiles closing in, with room to work, is exactly when to dig', () => {
  const bot = nightBot([['zombie', 7], ['zombie', 9]]);
  assert.strictEqual(shelter.shouldRun(bot, shelterCtx()), true);
});

check('hurt with one hostile around is enough', () => {
  const bot = nightBot([['skeleton', 7]], { health: 6 });
  assert.strictEqual(shelter.shouldRun(bot, shelterCtx()), true);
});

// Getting down three blocks and sealing takes a few seconds. Something
// already adjacent spends them either hitting us or stepping into the shaft
// behind us — and a zombie sealed into a 1x1 pit with the bot is far worse
// than one chasing it across open ground. `threat` runs next and makes the
// distance; this fires on the following pass.
check('something already on top of us means run first, dig second', () => {
  const bot = nightBot([['zombie', 2], ['zombie', 8]]);
  assert.strictEqual(shelter.shouldRun(bot, shelterCtx()), false);
});

// The other exception: sealing a creeper into the hole with you.
check('a creeper nearby still blocks it', () => {
  const bot = nightBot([['creeper', 5], ['zombie', 7]]);
  assert.strictEqual(shelter.shouldRun(bot, shelterCtx()), false);
});

check('a creeper far away does not block it', () => {
  const bot = nightBot([['creeper', 12], ['zombie', 7], ['zombie', 8]]);
  assert.strictEqual(shelter.shouldRun(bot, shelterCtx()), true);
});

check('daytime is never sheltering weather', () => {
  const bot = nightBot([['zombie', 2], ['zombie', 3]]);
  bot.time.isDay = true;
  bot.time.timeOfDay = 6000; // noon
  assert.strictEqual(shelter.shouldRun(bot, shelterCtx()), false);
});

// The fifty seconds that made the dashboard and the bot disagree. mineflayer
// calls tick 23500 night (isDay is timeOfDay < 13000); world.js ends night at
// 23000, when the sun is up and the undead are already burning. Sharing one
// definition means the bot comes out at first light instead of standing in a
// hole for another minute — and means the status line stops saying "day"
// while the bot says "digging in for the night".
check('first light ends the night, not midnight-plus-twelve', () => {
  const bot = nightBot([['zombie', 7], ['zombie', 8]]);
  bot.time.timeOfDay = 23500;
  assert.strictEqual(shelter.shouldRun(bot, shelterCtx()), false);
});

// Digging in is a COMMITMENT, and the scheduler compares raw priorities when
// deciding whether to preempt. At 89 against threat's 90 the sequence was:
// start digging (only ever with the nearest hostile more than four blocks
// off), it closes to three, threat preempts, the bot flees, shelter is picked
// again somewhere new and digs a fresh hole from scratch. It never finished
// one. Three deaths in ninety seconds on a new world, all of them this.
check('sheltering outranks fighting, so a half-dug hole is never abandoned', () => {
  assert.ok(
    shelter.priority > threat.priority,
    `shelter ${shelter.priority} must outrank threat ${threat.priority}`,
  );
});

/** Wearing a full set of `tier` armour — what nightProof reads. */
function wearing(bot, tier) {
  const slots = { head: 5, torso: 6, legs: 7, feet: 8 };
  const pieces = { head: 'helmet', torso: 'chestplate', legs: 'leggings', feet: 'boots' };
  bot.getEquipmentDestSlot = (slot) => slots[slot];
  bot.inventory.slots = [];
  for (const [slot, index] of Object.entries(slots)) bot.inventory.slots[index] = { name: `${tier}_${pieces[slot]}` };
  return bot;
}

// The rule this replaced: a bot "armed well enough" — a stone sword counted —
// took the night fight instead of burrowing. On the first Hard world (09-25,
// 02:19) that was a stone sword and leather boots against zombies hitting for
// 4.5: seven deaths in five minutes. Only a bot that can actually hold the
// surface stays up there.
check('a sword alone is not enough to spend a Hard night on the surface', () => {
  const bot = nightBot([['zombie', 7], ['zombie', 8]], { items: ['iron_sword'] });
  assert.strictEqual(shelter.shouldRun(bot, shelterCtx()), true);
});

check('full iron and an iron sword takes the fight instead', () => {
  const bot = wearing(nightBot([['zombie', 7], ['zombie', 8]], { items: ['iron_sword'] }), 'iron');
  assert.strictEqual(shelter.shouldRun(bot, shelterCtx()), false);
});

check('a wooden sword does not count as armed', () => {
  const bot = nightBot([['zombie', 7], ['zombie', 8]], { items: ['wooden_sword'] });
  assert.strictEqual(shelter.shouldRun(bot, shelterCtx()), true);
});

check('one distant hostile is reason enough when the bot cannot hold the surface', () => {
  const bot = nightBot([['zombie', 12]], { items: ['stone_sword'] });
  assert.strictEqual(shelter.shouldRun(bot, shelterCtx()), true);
});

console.log('\ngetting under before dark');

// Burrowing only once the mobs had arrived meant digging with them on top of
// the bot — and `defend` preempting the dig. Before dusk the surface is empty.
check('it goes down before dusk, with nothing around yet', () => {
  const bot = nightBot([], { items: ['stone_sword', 'stone_pickaxe'] });
  bot.time.timeOfDay = 12400; // thirty seconds before dusk
  assert.strictEqual(shelter.shouldRun(bot, shelterCtx()), true);
});

check('...but not with the afternoon still ahead of it', () => {
  const bot = nightBot([], { items: ['stone_sword', 'stone_pickaxe'] });
  bot.time.timeOfDay = 9000;
  assert.strictEqual(shelter.shouldRun(bot, shelterCtx()), false);
});

// Bare fists do 1 damage against 20 health, so any fight is lost by
// definition — and losing it costs everything the bot is carrying. That is
// how whole sessions went: rebuild wooden tools, die, rebuild, die, never
// accumulating enough to reach iron.
check('with no weapon at all, one hostile is already enough', () => {
  const bot = nightBot([['zombie', 9]]);
  assert.strictEqual(shelter.shouldRun(bot, shelterCtx()), true);
});

// Respawned at night with nothing: it walked back to its pile through the mobs
// that killed it and died again, twice, on 09-25. The hole comes first.
check('an unarmed bot at night burrows even before anything shows up', () => {
  const bot = nightBot([]);
  assert.strictEqual(shelter.shouldRun(bot, shelterCtx()), true);
});

// Night underground is work time, not hiding time. Without this the bot
// abandoned a dig to burrow into the floor it was already standing inside,
// every time something spawned in an unlit stretch of its own tunnel.
check('already underground means already sheltered', () => {
  const bot = nightBot([['zombie', 2], ['zombie', 3]], { y: 30 });
  assert.strictEqual(shelter.shouldRun(bot, shelterCtx()), false);
});

// A heading-leg target 20 blocks up a hill. driveTo checks arrival before it
// ever sets a goal, synchronously, so a stub pathfinder that records goals
// shows which of the two travel calls considers the bot already there.
{
  const { goNear, goNearXZ } = require('../src/nav');
  const { EventEmitter } = require('events');
  const botBelowTarget = () => {
    const bot = new EventEmitter();
    bot.entity = { position: new Vec3(10.5, 64, 10.5) };
    bot.goals = [];
    bot.pathfinder = { setGoal: (g) => bot.goals.push(g) };
    bot.clearControlStates = () => {};
    return bot;
  };
  const upTheHill = new Vec3(11, 84, 11);

  check('a heading leg that has covered the ground has arrived, whatever the height', () => {
    const bot = botBelowTarget();
    goNearXZ(bot, upTheHill, 3, null).catch(() => {});
    assert.deepStrictEqual(bot.goals.filter(Boolean), [], 'set off again for a point in the sky');
  });

  check('while goNear still insists on the height (which is why legs used it wrongly)', () => {
    const bot = botBelowTarget();
    goNear(bot, upTheHill, 3, null).catch(() => {});
    assert.ok(bot.goals.filter(Boolean).length > 0);
  });
}

// The 09-25 death: standing at a lip with a zombie behind, and "away" was
// fourteen blocks straight down.
{
  const { safeRetreatTarget } = require('../src/nav');
  const cliffBot = (floorAt) => ({
    entity: { position: new Vec3(0.5, 64, 0.5), isInLava: false },
    blockAt: (p) => {
      const floor = floorAt(p.x, p.z);
      const solid = p.y < floor;
      return { name: solid ? 'stone' : 'air', boundingBox: solid ? 'block' : 'empty', position: p };
    },
  });
  // Ground at y=64 for x <= 0; a 14-block drop beyond it.
  const edgeAtX1 = (x) => (x >= 1 ? 50 : 64);
  const awayFromZombie = new Vec3(1, 0, 0); // zombie at -x

  check('fleeing does not take the step off the ledge', () => {
    const target = safeRetreatTarget(cliffBot(edgeAtX1), awayFromZombie, 8);
    assert.ok(target, 'there is solid ground either side — a way out exists');
    assert.ok(target.x < 1, `fled straight over the drop to x=${target.x.toFixed(1)}`);
  });

  check('flat ground still flees straight away', () => {
    const target = safeRetreatTarget(cliffBot(() => 64), awayFromZombie, 8);
    assert.ok(Math.abs(target.x - 8.5) < 1e-9 && Math.abs(target.z - 0.5) < 1e-9, 'veered for no reason');
  });

  check('a pillar with drops all round admits there is no retreat', () => {
    const pillar = (x, z) => (x === 0 && z === 0 ? 64 : 50);
    assert.strictEqual(safeRetreatTarget(cliffBot(pillar), awayFromZombie, 8), null);
  });
}

// Real blocks and real break times, not mocks: the whole point is what the
// game says a dig costs with what the bot is actually carrying.
{
  const registry = require('prismarine-registry')('1.21.9');
  const Block = require('prismarine-block')(registry);
  const real = (name) => Block.fromStateId(registry.blocksByName[name].defaultState, 0);
  const carrying = (...names) => ({
    inventory: { items: () => names.map((n) => ({ type: registry.itemsByName[n].id, name: n })) },
  });

  check('no pickaxe: stone is a wall, not an escape route', () => {
    assert.strictEqual(canDigThrough(carrying(), real('stone')), false);
    assert.strictEqual(canDigThrough(carrying('stick'), real('deepslate')), false);
  });

  check('with any pickaxe, stone is fair to cut through', () => {
    assert.strictEqual(canDigThrough(carrying('wooden_pickaxe'), real('stone')), true);
  });

  check('dirt and gravel give way by hand', () => {
    assert.strictEqual(canDigThrough(carrying(), real('dirt')), true);
    assert.strictEqual(canDigThrough(carrying(), real('gravel')), true);
  });

  check('never anything off the escape list, however fast', () => {
    assert.strictEqual(canDigThrough(carrying('diamond_pickaxe'), real('chest')), false);
  });

  // 09-25: sealed in its own shaft under one jungle_planks lid, no tools,
  // "Blocked overhead" for five minutes with open sky one block up.
  check('the lid the bot built itself can always come off', () => {
    const { canBreakLid } = require('../src/behaviors/unstick');
    for (const lid of ['jungle_planks', 'oak_planks', 'dirt', 'cobblestone', 'oak_log']) {
      assert.strictEqual(canBreakLid(carrying(), real(lid)), true, `trapped under its own ${lid}`);
    }
  });

  check('but a lid is not a licence to punch through anything', () => {
    const { canBreakLid } = require('../src/behaviors/unstick');
    assert.strictEqual(canBreakLid(carrying(), real('obsidian')), false);
    assert.strictEqual(canBreakLid(carrying('diamond_pickaxe'), real('chest')), false);
  });
}

/**
 * Fleeing is a direction, and a direction has no height.
 *
 * retreatFrom aimed each hop at a point at the bot's OWN height and asked goNear
 * to reach it — which is only satisfied within three blocks vertically. On a
 * hillside the point is in the air over the slope, so every hop ran its six
 * seconds out with something chasing the bot, and the retreat reported failure
 * having actually got away. Forage, explore and idle had exactly this fixed
 * with goNearXZ; the flee path had not.
 *
 * The fake world here walks the bot to wherever pathfinder is aimed, ten
 * blocks DOWNHILL of where it started — a slope.
 */
async function checkAsync(label, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ok  ${label}`);
  } catch (err) {
    console.error(`  FAIL ${label}: ${err.message}`);
    process.exitCode = 1;
  }
}

// 09-25 17:01: a parkour jump planned across a ravine, the fall guard cutting
// the sprint at the lip, and an 11-block fall. Jumps only over gaps where a
// miss lands within a free fall (or in water).
console.log('\nparkour only where a miss is harmless');

function parkourWorld(columns) {
  // columns: dx -> depth of the first solid block below the take-off level
  // (1 = a normal floor; Infinity = a ravine; 'water' = water at depth 2).
  return {
    getBlock(node, dx, dy) {
      const spec = columns[Math.abs(dx)] ?? 1;
      if (spec === 'water') return { physical: false, liquid: dy === -2 };
      return { physical: -dy >= spec, liquid: false };
    },
  };
}

const { gapIsHarmless, parkourOnlyOverShallowGaps } = require('../src/bot');
const east = { x: 1, z: 0 };

check('a one-block gap with a floor three down is jumped', () => {
  assert.strictEqual(gapIsHarmless(parkourWorld({ 1: 4 }), {}, east), true);
});

check('a gap over a ravine is not', () => {
  assert.strictEqual(gapIsHarmless(parkourWorld({ 1: Infinity }), {}, east), false);
});

check('water under the gap catches a miss', () => {
  assert.strictEqual(gapIsHarmless(parkourWorld({ 1: 'water' }), {}, east), true);
});

check('a long jump is judged over every column it crosses', () => {
  assert.strictEqual(gapIsHarmless(parkourWorld({ 1: 2, 2: Infinity }), {}, east), false);
});

check('the wrapped move generator skips the ravine and keeps the rest', () => {
  const m = parkourWorld({ 1: Infinity });
  let calls = 0;
  m.getMoveParkourForward = () => { calls++; };
  parkourOnlyOverShallowGaps(m);
  m.getMoveParkourForward({}, east, []);
  assert.strictEqual(calls, 0);
  const ok = parkourWorld({ 1: 2 });
  ok.getMoveParkourForward = () => { calls++; };
  parkourOnlyOverShallowGaps(ok);
  ok.getMoveParkourForward({}, east, []);
  assert.strictEqual(calls, 1);
});

function hillsideBot() {
  const { EventEmitter } = require('events');
  const bot = new EventEmitter();
  bot.entity = { position: new Vec3(0.5, 70, 0.5) };
  bot.clearControlStates = () => {};
  bot.setControlState = () => {};
  bot.lookAt = async () => {};
  // The slope itself: a block lower for every block east, down to y=60 — steep,
  // but never a fall, which is what retreatFrom now checks before it sets off.
  bot.blockAt = (p) => {
    const floor = p.x <= 0 ? 70 : 70 - Math.min(10, p.x);
    const solid = p.y < floor;
    return { name: solid ? 'stone' : 'air', boundingBox: solid ? 'block' : 'empty', position: p };
  };
  bot.pathfinder = {
    setGoal(goal) {
      if (!goal) return;
      // Arrive at the goal's column — ten blocks further down the slope.
      bot.entity.position = new Vec3(goal.x, 60, goal.z);
    },
  };
  return bot;
}

async function runAsyncChecks() {
  const { retreatFrom } = require('../src/nav');
  console.log('\nfleeing down a slope');

  await checkAsync('a retreat that got away downhill counts as getting away', async () => {
    const bot = hillsideBot();
    const startedAt = Date.now();
    const got = await retreatFrom(bot, new Vec3(-5, 70, 0.5), [12, 8], null);
    assert.strictEqual(got, true, 'the bot is twelve blocks from the threat');
    assert.ok(Date.now() - startedAt < 2000, 'and it did not wait out the hop timeout to find out');
  });

  // "At the last tick of mining that block it stops and then fully mines it
  // again." Pathfinder digging a block on the route leaves the bot standing
  // still, the stall check called that stuck, and the cancel wiped the crack.
  console.log('\nnot cancelling a dig halfway through');

  const { goNear } = require('../src/nav');

  function diggingBot({ start, miningForMs, arriveAt }) {
    const { EventEmitter } = require('events');
    const bot = new EventEmitter();
    bot.entity = { position: start.clone(), onGround: true };
    bot.clearControlStates = () => {};
    bot.lookAt = async () => {};
    bot.blockAt = () => null;
    const began = Date.now();
    const mining = () => Date.now() - began < miningForMs;
    bot.cancelledWhileMining = 0;
    bot.setControlState = (control, on) => {
      if (control === 'forward' && on && !mining()) bot.entity.position = arriveAt.clone();
    };
    bot.pathfinder = {
      isMining: mining,
      isBuilding: () => false,
      setGoal(goal) {
        if (goal === null) {
          if (mining()) bot.cancelledWhileMining++;
          return;
        }
        // Only a partial route: the case with the 0.7-second patience.
        setImmediate(() => bot.emit('path_update', { status: 'noPath' }));
      },
    };
    // The block breaks, and the bot walks on to where it was going.
    setTimeout(() => { bot.entity.position = arriveAt.clone(); }, miningForMs + 100);
    return bot;
  }

  await checkAsync('a slow block on a partial route is dug, not abandoned at 0.7s', async () => {
    const target = new Vec3(10.5, 64, 0.5);
    const bot = diggingBot({ start: new Vec3(0.5, 64, 0.5), miningForMs: 1200, arriveAt: target });
    await goNear(bot, target, 1, null, { timeoutMs: 5000 });
    assert.strictEqual(bot.cancelledWhileMining, 0, 'the path was cancelled mid-dig, wiping the crack');
  });

  await checkAsync('the hand-walked last bit waits for the dig in front of it', async () => {
    const target = new Vec3(2.5, 64, 0.5);
    const bot = diggingBot({ start: new Vec3(0.5, 64, 0.5), miningForMs: 400, arriveAt: target });
    await goNear(bot, target, 0.5, null, { timeoutMs: 5000 });
    assert.strictEqual(bot.cancelledWhileMining, 0, 'the handover cancelled pathfinder mid-dig');
  });
}

runAsyncChecks().then(() => console.log(`\n${passed} checks passed`));
