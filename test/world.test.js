/**
 * Reading the world the way a player reads F3.
 *
 * Everything here replaced a guess. "Is it night" was a hardcoded tick range,
 * "am I underground" was `y < 50`, and "is it dark here" was a twenty-second
 * timer — so the bot lit tunnels that were already lit on schedule while the
 * pitch-black side passage it had just opened stayed dark, which is where the
 * thing that kills it spawns.
 *
 * The light checks matter most, and they have a specific trap: prismarine
 * returns 15 for a position whose lighting section is missing, so BAD DATA
 * LOOKS BRIGHT. Acting on it can only ever place too few torches, never
 * carpet the world — but the probe that detects the uniform case has to
 * actually work, or the fallback never engages.
 *
 * Run with: node test/world.test.js
 */

const assert = require('assert');
const Vec3 = require('vec3');
const {
  timeInfo, lightingUsable, isSpawnableSpot, nearestDarkSpot, darkSpotCount,
  isUnderground, lightAt, DUSK, DAWN,
} = require('../src/world');

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

/**
 * `lights` maps "x,y,z" -> { light, sky, solid }. Anything unlisted takes the
 * defaults, which mirror a lit, open, empty world.
 */
function worldBot(pos, lights = {}, defaults = { light: 15, sky: 15, solid: false }) {
  return {
    entity: { position: new Vec3(pos[0], pos[1], pos[2]) },
    time: { timeOfDay: 1000, day: 3 },
    game: { difficulty: 'normal' },
    blockAt(p) {
      const key = `${p.x},${p.y},${p.z}`;
      const cell = Object.prototype.hasOwnProperty.call(lights, key)
        ? { ...defaults, ...lights[key] }
        : defaults;
      return {
        name: cell.solid ? 'stone' : 'air',
        position: new Vec3(p.x, p.y, p.z),
        boundingBox: cell.solid ? 'block' : 'empty',
        light: cell.light,
        skyLight: cell.sky,
      };
    },
  };
}

console.log('telling the time');

check('midday is not night', () => {
  const bot = worldBot([0, 64, 0]);
  bot.time.timeOfDay = 6000;
  assert.strictEqual(timeInfo(bot).isNight, false);
});

check('dusk onward is night', () => {
  const bot = worldBot([0, 64, 0]);
  bot.time.timeOfDay = DUSK + 100;
  assert.strictEqual(timeInfo(bot).isNight, true);
});

// The bot needs to know how long it is committing to when it seals itself in.
check('it knows how long until dawn', () => {
  const bot = worldBot([0, 64, 0]);
  bot.time.timeOfDay = 18000; // midnight
  const t = timeInfo(bot);
  assert.strictEqual(t.isNight, true);
  assert.strictEqual(t.ticksUntilDawn, DAWN - 18000);
  assert.strictEqual(t.secondsUntilDawn, Math.round((DAWN - 18000) / 20));
});

check('and how long until dark, wrapping past midnight correctly', () => {
  const bot = worldBot([0, 64, 0]);
  bot.time.timeOfDay = 1000; // morning
  assert.strictEqual(timeInfo(bot).ticksUntilDusk, DUSK - 1000);
});

check('no time data is reported as unknown, not as daytime', () => {
  const bot = worldBot([0, 64, 0]);
  bot.time = {};
  assert.strictEqual(timeInfo(bot).known, false);
});

console.log('\nknowing whether the light data is real');

// The trap: a server that sends no lighting makes every block read 15.
check('uniformly bright readings are recognised as no data', () => {
  const bot = worldBot([0, 64, 0]);
  assert.strictEqual(lightingUsable(bot), false);
  assert.strictEqual(lightAt(bot, new Vec3(0, 64, 0)), null);
});

check('any variation at all means the data is genuine', () => {
  // A single darker cell anywhere in the sampled neighbourhood is enough —
  // a real world is never uniformly lit.
  const bot = worldBot([0, 64, 0], { '2,64,2': { light: 4 } });
  assert.strictEqual(lightingUsable(bot), true);
});

// The probe has to look at the cells immediately around the bot, not a
// coarse lattice that steps over them. An earlier version sampled every
// second Y and missed the head cell entirely, so a world whose only
// variation was overhead read as "no lighting data".
check('variation directly overhead is not stepped over', () => {
  const bot = worldBot([0, 64, 0], { '0,65,0': { light: 2 } });
  assert.strictEqual(lightingUsable(bot), true);
});

// The false negative that disabled the whole feature on a working server:
// outdoors at night with no torches down, block light is legitimately 0
// everywhere, so probing block light alone concluded "no data". Sky light
// still varies with terrain, which is what rescues it.
check('night-time outdoors is still usable data', () => {
  const cells = {};
  for (let dx = -4; dx <= 4; dx++) {
    for (let dz = -4; dz <= 4; dz++) {
      for (let dy = -2; dy <= 3; dy++) {
        const y = 64 + dy;
        // Solid ground below, open sky above — block light 0 throughout.
        cells[`${dx},${y},${dz}`] = y < 64
          ? { light: 0, sky: 0, solid: true }
          : { light: 0, sky: 15 };
      }
    }
  }
  assert.strictEqual(lightingUsable(worldBot([0, 64, 0], cells)), true);
});

console.log('\nfinding the dark');

/**
 * An enclosed, lit room with one unlit block in it. Sky light is 0
 * throughout, i.e. underground — which is where torch decisions actually
 * matter.
 */
function roomWithDarkSpotAt(darkKey) {
  const cells = {};
  for (let dx = -8; dx <= 8; dx++) {
    for (let dz = -8; dz <= 8; dz++) {
      cells[`${dx},62,${dz}`] = { solid: true, light: 0, sky: 0 }; // floor
      cells[`${dx},63,${dz}`] = { light: 14, sky: 0 };
      cells[`${dx},64,${dz}`] = { light: 14, sky: 0 };
    }
  }
  cells[darkKey] = { light: 0, sky: 0 };
  return worldBot([0, 63, 0], cells);
}

check('an unlit spot with a floor is where a mob would spawn', () => {
  const bot = roomWithDarkSpotAt('3,63,0');
  assert.strictEqual(isSpawnableSpot(bot, new Vec3(3, 63, 0)), true);
});

check('a lit spot is not', () => {
  const bot = roomWithDarkSpotAt('3,63,0');
  assert.strictEqual(isSpawnableSpot(bot, new Vec3(-3, 63, 0)), false);
});

check('mid-air is not a spawn spot however dark it is', () => {
  const bot = worldBot([0, 64, 0], { '2,64,0': { light: 0 } });
  assert.strictEqual(isSpawnableSpot(bot, new Vec3(2, 64, 0)), false);
});

check('the nearest dark spot is the one it finds', () => {
  const bot = roomWithDarkSpotAt('2,63,0');
  const spot = nearestDarkSpot(bot);
  assert.ok(spot, 'should find the dark patch');
  assert.strictEqual(spot.x, 2);
  assert.strictEqual(spot.z, 0);
});

check('a fully lit room has nothing to torch', () => {
  const cells = {};
  for (let dx = -8; dx <= 8; dx++) {
    for (let dz = -8; dz <= 8; dz++) {
      cells[`${dx},62,${dz}`] = { solid: true, light: 0, sky: 0 };
      cells[`${dx},63,${dz}`] = { light: 14, sky: 0 };
      cells[`${dx},64,${dz}`] = { light: 14, sky: 0 };
    }
  }
  // One varying value so the probe accepts the data as real.
  cells['2,64,2'] = { light: 9, sky: 0 };
  assert.strictEqual(nearestDarkSpot(worldBot([0, 63, 0], cells)), null);
});

// Measured live: a bot standing in a forest at midday reported 49 spawnable
// spots, because a canopy gives a block light of 0 almost everywhere. It
// would have burned its whole torch supply lighting a wood that was in no
// way dangerous. Sunlight is what suppresses those spawns.
check('a shaded forest floor in daylight is not a spawn risk', () => {
  const cells = {};
  for (let dx = -8; dx <= 8; dx++) {
    for (let dz = -8; dz <= 8; dz++) {
      cells[`${dx},62,${dz}`] = { solid: true, light: 0, sky: 0 };
      cells[`${dx},63,${dz}`] = { light: 0, sky: 12 }; // shade, but daylight
      cells[`${dx},64,${dz}`] = { light: 0, sky: 12 };
    }
  }
  cells['2,64,2'] = { light: 5, sky: 12 }; // variation for the probe
  const bot = worldBot([0, 63, 0], cells);
  bot.time.timeOfDay = 6000; // midday
  assert.strictEqual(nearestDarkSpot(bot), null);
});

check('the same forest floor after dark IS a spawn risk', () => {
  const cells = {};
  for (let dx = -8; dx <= 8; dx++) {
    for (let dz = -8; dz <= 8; dz++) {
      cells[`${dx},62,${dz}`] = { solid: true, light: 0, sky: 0 };
      cells[`${dx},63,${dz}`] = { light: 0, sky: 12 };
      cells[`${dx},64,${dz}`] = { light: 0, sky: 12 };
    }
  }
  cells['2,64,2'] = { light: 5, sky: 12 };
  const bot = worldBot([0, 63, 0], cells);
  bot.time.timeOfDay = DUSK + 500;
  assert.ok(nearestDarkSpot(bot), 'should want a torch once the sun is down');
});

check('darkness is counted, not just found', () => {
  const bot = roomWithDarkSpotAt('2,63,0');
  assert.strictEqual(darkSpotCount(bot), 1);
});

check('with no usable light data the count is unknown, never zero', () => {
  // Zero would read as "perfectly safe" and suppress every torch.
  assert.strictEqual(darkSpotCount(worldBot([0, 64, 0])), null);
});

console.log('\nknowing whether we are underground');

/**
 * Answered by looking UP, not by reading sky light.
 *
 * Caught live and it was costing deaths: the bot stood in plains at y=70 on
 * a clear night and reported "underground", so `shelter` declined to run —
 * it skips burrowing when already underground — while Jev was telling it to
 * shelter and calling the situation dangerous. It fought instead of hiding.
 *
 * The cause was that the server reports skyLight as 0 everywhere. The
 * lighting probe passed anyway, because BLOCK light varies perfectly well
 * and that alone makes the pair look varied, so the broken channel went
 * straight through the check meant to catch exactly this. Block data is
 * never ambiguous that way.
 */
check('open sky overhead means outside, even at a low Y', () => {
  // Deep in a ravine, but nothing above — still outside.
  const bot = worldBot([0, 40, 0], {}, { light: 0, sky: 0, solid: false });
  assert.strictEqual(isUnderground(bot), false);
});

check('a roof means underground, even high up', () => {
  const bot = worldBot([0, 90, 0], { '0,95,0': { solid: true } });
  assert.strictEqual(isUnderground(bot), true);
});

// This is the specific false positive that disabled sheltering.
check('sky light of zero does NOT by itself mean underground', () => {
  const bot = worldBot([0, 70, 0], {}, { light: 8, sky: 0, solid: false });
  assert.strictEqual(isUnderground(bot), false, 'a broken sky-light channel must not hide the sky');
});

// A canopy is cover, but the bot can still be reached from every side —
// which is the actual question shelter is asking.
check('a leaf canopy is not underground', () => {
  const bot = worldBot([0, 70, 0], {});
  const plain = bot.blockAt;
  bot.blockAt = (p) => (p.y === 74
    ? { name: 'oak_leaves', position: p, boundingBox: 'block', light: 0, skyLight: 0 }
    : plain(p));
  assert.strictEqual(isUnderground(bot), false);
});

// Standing in the gap where a trunk's lowest logs were, with the rest of the
// trunk overhead: the exact spot `wood` leaves the bot in at dusk.
check('the trunk of a half-felled tree is not underground either', () => {
  for (const name of ['oak_log', 'stripped_birch_log', 'spruce_wood', 'crimson_stem', 'mushroom_stem']) {
    const bot = worldBot([0, 65, 0], {});
    const plain = bot.blockAt;
    bot.blockAt = (p) => (p.x === 0 && p.z === 0 && p.y >= 67 && p.y <= 71
      ? { name, position: p, boundingBox: 'block', light: 0, skyLight: 0 }
      : plain(p));
    assert.strictEqual(isUnderground(bot), false, `${name} overhead read as a roof`);
  }
});

check('unloaded chunks fall back to the depth rule rather than guessing', () => {
  const nowhere = (y) => ({
    entity: { position: new Vec3(0, y, 0) },
    time: { timeOfDay: 1000, day: 1 },
    blockAt: () => null,
  });
  assert.strictEqual(isUnderground(nowhere(30)), true);
  assert.strictEqual(isUnderground(nowhere(70)), false);
});

console.log(`\n${passed} checks passed`);
