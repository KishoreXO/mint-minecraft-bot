/**
 * Not walking off things.
 *
 * Pathfinder respects its own maxDropDown and always has. Everything that
 * drives the control states by hand does not, and that is most of what this
 * bot does: the last two blocks of every journey, the last metre to a dropped
 * item, the whole of a melee fight, and the pvp engine's strafing. The damage
 * ledger records the result — "Took avoidable damage {cause: fall, lost: 4,
 * fellBlocks: 7}" mid-hunt, and a death logged as `killedBy: fall`.
 *
 * The guard has to be right in BOTH directions. A missed drop costs health; a
 * false positive freezes the bot at the lip of a perfectly ordinary step, and
 * a frozen bot has historically been the more expensive failure. So there are
 * as many checks here for "this is fine, leave it alone" as for "stop".
 *
 * Run with: node test/falls.test.js
 */

const assert = require('assert');
const Vec3 = require('vec3');
const { isDropAt, stepWouldFall, walkingIntoAFall } = require('../src/falls');

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

const SOLID = new Set(['stone', 'dirt', 'grass_block', 'deepslate']);

/**
 * `terrain(x, y, z)` returns a block name, or null for an unloaded chunk.
 * The bot stands at `pos` with its feet at that exact height.
 */
function ledgeBot(pos, terrain, { velocity = { x: 0, y: 0, z: 0 }, onGround = true, inWater = false } = {}) {
  return {
    entity: {
      position: new Vec3(pos[0], pos[1], pos[2]),
      velocity,
      onGround,
      isInWater: inWater,
    },
    controlState: {},
    setControlState() {},
    blockAt(p) {
      const name = terrain(p.x, p.y, p.z);
      if (name === null) return null;
      return {
        name,
        position: new Vec3(p.x, p.y, p.z),
        boundingBox: SOLID.has(name) ? 'block' : 'empty',
      };
    },
  };
}

/** Flat ground with its surface at `floorY` — the block AT floorY is solid. */
const flat = (floorY) => (x, y) => (y <= floorY ? 'stone' : 'air');

/** Flat ground, except a bottomless gap for x >= edgeX. */
function cliff(floorY, edgeX, bottomY = -100) {
  return (x, y) => {
    if (x >= edgeX) return y <= bottomY ? 'stone' : 'air';
    return y <= floorY ? 'stone' : 'air';
  };
}

console.log('how far down is too far');

// Fall damage starts ABOVE three blocks, so a three-block drop is free and
// refusing it would make the bot refuse ordinary terrain constantly.
check('level ground is not a drop', () => {
  const bot = ledgeBot([0, 64, 0], flat(63));
  assert.strictEqual(isDropAt(bot, new Vec3(1, 64, 0)), false);
});

check('a one-block step down is not a drop', () => {
  const bot = ledgeBot([0, 64, 0], (x, y) => {
    if (x >= 1) return y <= 62 ? 'stone' : 'air';
    return y <= 63 ? 'stone' : 'air';
  });
  assert.strictEqual(isDropAt(bot, new Vec3(1, 64, 0)), false);
});

check('a three-block drop is free damage-wise and is allowed', () => {
  const bot = ledgeBot([0, 64, 0], (x, y) => {
    if (x >= 1) return y <= 60 ? 'stone' : 'air'; // feet 64 -> lands on 61
    return y <= 63 ? 'stone' : 'air';
  });
  assert.strictEqual(isDropAt(bot, new Vec3(1, 64, 0)), false);
});

check('a four-block drop hurts and is refused', () => {
  const bot = ledgeBot([0, 64, 0], (x, y) => {
    if (x >= 1) return y <= 59 ? 'stone' : 'air'; // feet 64 -> lands on 60
    return y <= 63 ? 'stone' : 'air';
  });
  assert.strictEqual(isDropAt(bot, new Vec3(1, 64, 0)), true);
});

check('a ravine with no bottom in sight is refused', () => {
  const bot = ledgeBot([0, 64, 0], cliff(63, 1));
  assert.strictEqual(isDropAt(bot, new Vec3(1, 64, 0)), true);
});

console.log('\nwhen it deliberately does nothing');

// Landing in water is free, and refusing to enter it is exactly how the bot
// ended up bridging across lakes one block at a time...
check('a short drop into water is fine', () => {
  const bot = ledgeBot([0, 64, 0], (x, y) => {
    if (x >= 1) {
      if (y <= 50) return 'stone';
      if (y <= 61) return 'water';
      return 'air';
    }
    return y <= 63 ? 'stone' : 'air';
  });
  assert.strictEqual(isDropAt(bot, new Vec3(1, 64, 0)), false);
});

// ...but free to land is not free to leave. 09-26: off a ravine rim at y=80
// into water at y=62, 33 times in one session.
check('a tall drop into water is a drop — nothing climbs back out', () => {
  const bot = ledgeBot([0, 64, 0], (x, y) => {
    if (x >= 1) {
      if (y <= 50) return 'stone';
      if (y <= 55) return 'water';
      return 'air';
    }
    return y <= 63 ? 'stone' : 'air';
  });
  assert.strictEqual(isDropAt(bot, new Vec3(1, 64, 0)), true);
});

check('the walking guard and pathfinder use one drop limit', () => {
  const { MAX_DROP_DOWN } = require('../src/falls');
  const { buildMovements } = require('../src/bot');
  const registry = require('minecraft-data')('1.21.9');
  assert.strictEqual(buildMovements({ registry, version: '1.21.9' }).maxDropDown, MAX_DROP_DOWN);
});

// A false positive freezes the bot, which has historically cost more than the
// damage. At a chunk border we have no data, so we do not get an opinion.
check('an unloaded chunk is not treated as a hole', () => {
  const bot = ledgeBot([0, 64, 0], (x, y) => {
    if (x >= 1) return null;
    return y <= 63 ? 'stone' : 'air';
  });
  assert.strictEqual(isDropAt(bot, new Vec3(1, 64, 0)), false);
});

console.log('\nreading where the bot is actually heading');

check('standing still is never walking into anything', () => {
  const bot = ledgeBot([0, 64, 0], cliff(63, 1), { velocity: { x: 0, y: 0, z: 0 } });
  assert.strictEqual(walkingIntoAFall(bot), false);
});

check('sprinting at a cliff edge is caught', () => {
  const bot = ledgeBot([0, 64, 0], cliff(63, 1), { velocity: { x: 0.28, y: 0, z: 0 } });
  assert.strictEqual(walkingIntoAFall(bot), true);
});

check('sprinting away from the same cliff is fine', () => {
  const bot = ledgeBot([0, 64, 0], cliff(63, 1), { velocity: { x: -0.28, y: 0, z: 0 } });
  assert.strictEqual(walkingIntoAFall(bot), false);
});

// Running ALONG an edge is normal and must not be blocked, or the bot cannot
// walk on a plateau at all.
check('running parallel to an edge is not walking off it', () => {
  const bot = ledgeBot([0, 64, 0], cliff(63, 2), { velocity: { x: 0, y: 0, z: 0.28 } });
  assert.strictEqual(walkingIntoAFall(bot), false);
});

// Swimming and falling are both states where there is nothing left to
// prevent — and clamping movement in water would stop the bot swimming at all.
check('in water it keeps out of the way', () => {
  const bot = ledgeBot([0, 64, 0], cliff(63, 1), {
    velocity: { x: 0.28, y: 0, z: 0 },
    inWater: true,
  });
  assert.strictEqual(walkingIntoAFall(bot), false);
});

check('already airborne, there is nothing left to stop', () => {
  const bot = ledgeBot([0, 64, 0], cliff(63, 1), {
    velocity: { x: 0.28, y: -0.4, z: 0 },
    onGround: false,
  });
  assert.strictEqual(walkingIntoAFall(bot), false);
});

console.log('\naiming at a destination, before moving at all');

check('a target across flat ground is fine', () => {
  const bot = ledgeBot([0, 64, 0], flat(63));
  assert.strictEqual(stepWouldFall(bot, new Vec3(3, 64, 0)), false);
});

check('a target on the far side of a chasm is refused', () => {
  const bot = ledgeBot([0, 64, 0], cliff(63, 1));
  assert.strictEqual(stepWouldFall(bot, new Vec3(4, 64, 0)), true);
});

check('a target we are already standing on is not a fall', () => {
  const bot = ledgeBot([0, 64, 0], cliff(63, 1));
  assert.strictEqual(stepWouldFall(bot, new Vec3(0, 64, 0)), false);
});

// The look-ahead is capped at the real distance, so a drop BEYOND a close
// target does not stop the bot reaching the target.
check('a drop past a nearby target does not block reaching it', () => {
  const bot = ledgeBot([0, 64, 0], cliff(63, 3));
  assert.strictEqual(stepWouldFall(bot, new Vec3(1, 64, 0)), false);
});

console.log(`\n${passed} checks passed`);
