/**
 * Swimming, and specifically the part of it that kills bots: finding air.
 *
 * "Swim up" is the obvious answer and it is wrong often enough to matter.
 * Under a frozen lake, inside a flooded cave, or beneath an overhanging cliff,
 * up is a ceiling — and a bot that only knows "up" presses itself against it
 * and drowns with a breathable pocket four blocks sideways. That specific
 * failure is what nearestBreath exists for, so that specific failure is what
 * these check.
 *
 * The rest of swimming is control states and look angles, which cannot be
 * meaningfully tested without a server. This is the part that is pure
 * reasoning about block data, and it is also the part that is silently wrong.
 *
 * Run with: node test/swim.test.js
 */

const assert = require('assert');
const Vec3 = require('vec3');
const {
  nearestBreath, isSubmerged, isWater, isBreathable,
} = require('../src/swim');

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

const SOLID = new Set(['stone', 'ice', 'packed_ice', 'dirt', 'deepslate']);

/**
 * A world described as a function of position, so an ocean does not have to
 * be written out block by block. The bot's FEET are at `pos`; its head — the
 * cell the air gauge actually cares about — is one above.
 */
function swimmer(pos, nameAt) {
  return {
    entity: {
      position: new Vec3(pos[0], pos[1], pos[2]),
      isInWater: true,
    },
    blockAt(p) {
      const name = nameAt(p.x, p.y, p.z);
      if (name === null) return null; // unloaded chunk
      return {
        name,
        position: new Vec3(p.x, p.y, p.z),
        boundingBox: SOLID.has(name) ? 'block' : 'empty',
      };
    },
  };
}

/** Open ocean: water up to `surfaceY`, air above, stone below. */
function ocean(surfaceY = 62, floorY = 40) {
  return (x, y) => {
    if (y <= floorY) return 'stone';
    if (y <= surfaceY) return 'water';
    return 'air';
  };
}

console.log('telling water from air from rock');

check('water is water, however it is flowing', () => {
  assert.ok(isWater({ name: 'water', boundingBox: 'empty' }));
  assert.ok(isWater({ name: 'flowing_water', boundingBox: 'empty' }));
  assert.ok(isWater({ name: 'bubble_column', boundingBox: 'empty' }));
});

check('water is not breathable, however empty its bounding box is', () => {
  // The trap: water's boundingBox IS 'empty', so any check that only looks at
  // that reports a drowning bot as standing in air.
  assert.ok(!isBreathable({ name: 'water', boundingBox: 'empty' }));
  assert.ok(isBreathable({ name: 'air', boundingBox: 'empty' }));
  assert.ok(!isBreathable({ name: 'stone', boundingBox: 'block' }));
  assert.ok(!isBreathable(null));
});

check('feet wet with a dry head is not submerged', () => {
  // Wading. The old watchdog treated this identically to being underwater and
  // held jump, so the bot bounced its way across every puddle in the world.
  const bot = swimmer([0, 62, 0], ocean(62));
  assert.strictEqual(isSubmerged(bot), false);
});

check('head under water is submerged', () => {
  const bot = swimmer([0, 55, 0], ocean(62));
  assert.strictEqual(isSubmerged(bot), true);
});

console.log('\nfinding air in open water');

check('straight up, to the surface', () => {
  const bot = swimmer([0, 50, 0], ocean(62));
  const air = nearestBreath(bot);
  assert.ok(air, 'found nothing');
  assert.strictEqual(air.x, 0);
  assert.strictEqual(air.z, 0);
  assert.strictEqual(air.y, 63); // first cell above the water
});

check('already breathing returns where we are', () => {
  const bot = swimmer([0, 62, 0], ocean(62));
  const air = nearestBreath(bot);
  assert.strictEqual(air.y, 63); // the head cell itself
});

console.log('\nfinding air when up is a ceiling');

// The one that actually drowns bots. A frozen lake is a solid lid: swimming
// up puts the bot's face against ice and holds it there until it dies.
check('under ice, it finds the hole rather than the lid', () => {
  const HOLE_X = 4;
  const bot = swimmer([0, 55, 0], (x, y, z) => {
    if (y <= 40) return 'stone';
    if (y <= 61) return 'water';
    if (y === 62) return (x === HOLE_X && z === 0) ? 'water' : 'ice';
    return 'air';
  });

  const air = nearestBreath(bot);
  assert.ok(air, 'found nothing under the ice');
  assert.strictEqual(air.x, HOLE_X);
  assert.strictEqual(air.z, 0);
  assert.strictEqual(air.y, 63);
});

check('a flooded cave finds the air pocket in the roof', () => {
  // Solid rock everywhere, water in a tunnel, one bubble of air off to one
  // side — which is exactly what an aquifer at mining depth looks like.
  const bot = swimmer([0, 16, 0], (x, y, z) => {
    const inTunnel = Math.abs(x) <= 6 && Math.abs(z) <= 1 && y >= 15 && y <= 18;
    if (!inTunnel) return 'stone';
    if (x === 5 && z === 0 && y === 18) return 'air'; // the pocket
    return 'water';
  });

  const air = nearestBreath(bot);
  assert.ok(air, 'found nothing in the flooded tunnel');
  assert.deepStrictEqual([air.x, air.y, air.z], [5, 18, 0]);
});

check('sealed in solid rock, it admits there is nothing', () => {
  const bot = swimmer([0, 16, 0], (x, y) => {
    if (y >= 16 && y <= 17) return 'water';
    return 'stone';
  });
  assert.strictEqual(nearestBreath(bot), null);
});

console.log('\nnot guessing about chunks it has not been sent');

check('an unloaded column stops the probe rather than reading air into it', () => {
  // blockAt returning null means "no data", and treating that as air would
  // send the bot swimming at a chunk boundary forever.
  const bot = swimmer([0, 50, 0], (x, y) => {
    if (y <= 40) return 'stone';
    if (y <= 54) return 'water';
    return null; // everything above is unloaded
  });
  assert.strictEqual(nearestBreath(bot), null);
});

console.log('\nwhen there is no way round, digging toward the air');

// On real blocks (test/simbot.js), because the answer depends on dig times.
{
  const { createSimBot } = require('./simbot');
  const { airDigOptions } = require('../src/water');

  check('a lid with air on the other side is an option; bedrock never is', () => {
    const lidded = (lid) => (x, y, z) => {
      if (x === 0 && z === 0 && (y === 60 || y === 61)) return 'water';
      if (x === 0 && z === 0 && y === 62) return lid;
      if (x === 0 && z === 0 && y >= 63) return 'air';
      return 'stone';
    };
    const dirt = airDigOptions(createSimBot(lidded('dirt'), { pos: [0.5, 60.2, 0.5] }));
    assert.ok(dirt.some((o) => o.block.name === 'dirt' && o.block.position.y === 62), 'the lid was not offered');
    const bedrock = airDigOptions(createSimBot(lidded('bedrock'), { pos: [0.5, 60.2, 0.5] }));
    assert.deepStrictEqual(bedrock, []);
  });

  check('sand on top of the lid is never dug from under — it would fill the hole', () => {
    const bot = createSimBot((x, y, z) => {
      if (x === 0 && z === 0 && (y === 60 || y === 61)) return 'water';
      if (x === 0 && z === 0 && y === 62) return 'dirt';
      if (x === 0 && z === 0 && y === 63) return 'sand';
      return 'stone';
    }, { pos: [0.5, 60.2, 0.5] });
    assert.ok(!airDigOptions(bot).some((o) => o.block.position.y === 62));
  });

  check('standing on the floor to dig is costed, and cheaper than floating', () => {
    const bot = createSimBot((x, y, z) => {
      if (x === 0 && z === 0 && (y === 60 || y === 61)) return 'water';
      if (x === 0 && z === 0 && y === 62) return 'dirt';
      if (x === 0 && z === 0 && y >= 63) return 'air';
      return 'stone';
    }, { pos: [0.5, 60.4, 0.5] });
    const opts = airDigOptions(bot).filter((o) => o.block.position.y === 62);
    const floating = opts.find((o) => !o.sinkFirst);
    const standing = opts.find((o) => o.sinkFirst);
    assert.ok(floating && standing, 'both ways should be costed');
    assert.ok(standing.ticks < floating.ticks, `standing ${standing.ticks} vs floating ${floating.ticks}`);
  });
}

console.log('\nits own air, not the nearest axolotl\'s');

{
  const { EventEmitter } = require('events');
  const { trackOwnAir } = require('../src/swim');
  const registry = require('minecraft-data')('1.21.9');
  const AIR_KEY = registry.entitiesByName.player.metadataKeys.indexOf('air_supply');

  // What mineflayer 4.39's entities.js does with EVERY entity_metadata
  // packet: credit its air_supply to the bot, whoever it describes.
  function breathingBot() {
    const bot = new EventEmitter();
    bot._client = new EventEmitter();
    bot.registry = registry;
    bot.entity = { id: 7 };
    bot._client.on('entity_metadata', (packet) => {
      for (const m of packet.metadata) if (m.key === AIR_KEY) bot.oxygenLevel = Math.round(m.value / 15);
    });
    trackOwnAir(bot);
    return bot;
  }
  const air = (bot, entityId, ticks) => bot._client.emit('entity_metadata', {
    entityId, metadata: [{ key: AIR_KEY, type: 'int', value: ticks }],
  });

  check('an axolotl at full air does not read as the bot\'s lungs', () => {
    const bot = breathingBot();
    air(bot, 7, 60); // the bot: four bubbles left
    air(bot, 99, 6000); // live on 09-24 this read back as "air: 400"
    assert.strictEqual(bot.oxygenLevel, 4);
  });

  check('a drowning zombie does not fake an emergency', () => {
    const bot = breathingBot();
    air(bot, 99, 0);
    assert.strictEqual(bot.oxygenLevel, 20);
  });

  check('a respawn restores full air', () => {
    const bot = breathingBot();
    air(bot, 7, 0);
    bot.emit('respawn');
    assert.strictEqual(bot.oxygenLevel, 20);
  });
}

console.log(`\n${passed} checks passed`);
