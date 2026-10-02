/**
 * Working out what actually hurt the bot.
 *
 * "He keeps dying to mobs" was the report. It was only half right — the bot
 * also bled health to falls, fire and its own tunnels, and arrived at every
 * fight already half dead. Nothing could see that, because mineflayer's
 * `health` event reports that the number changed and nothing else: no cause,
 * no attacker, no amount.
 *
 * Attribution has to be right or the ledger is worse than useless — it would
 * send someone tuning combat when the real problem is a pathfinder dropping
 * the bot off ledges. So each cause gets a check.
 *
 * Run with: node test/damage.test.js
 */

const assert = require('assert');
const Vec3 = require('vec3');
const { classify } = require('../src/damage');

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

const SOLID = new Set(['stone', 'dirt', 'gravel']);

/**
 * `blocks` maps "x,y,z" -> block name relative to the WORLD, and the bot sits
 * at the given position. Everything unlisted is air.
 */
function hurtBot({
  pos = [0, 64, 0],
  blocks = {},
  entities = [],
  food = 20,
  oxygen = 20,
  onFire = false,
} = {}) {
  return {
    food,
    oxygenLevel: oxygen,
    entity: {
      position: new Vec3(pos[0], pos[1], pos[2]),
      // Bit 0 of the shared flags byte is "on fire".
      metadata: [onFire ? 0x01 : 0x00],
    },
    entities: Object.fromEntries(entities.map((e, i) => [i, {
      id: i,
      isValid: true,
      ...e,
      position: new Vec3(...e.at),
    }])),
    blockAt(p) {
      const name = blocks[`${p.x},${p.y},${p.z}`] || 'air';
      return {
        name,
        position: new Vec3(p.x, p.y, p.z),
        boundingBox: SOLID.has(name) ? 'block' : 'empty',
      };
    },
  };
}

const quiet = () => ({ lastFall: 0, lastFallAt: 0, fusingCreeperAt: 0 });

console.log('environmental damage');

// Falls were the hidden cost. They never produce a log line of their own, so
// a session that lost 24 health to ledges looked identical to one that lost
// it to zombies.
check('a long fall that just landed is a fall', () => {
  const state = { ...quiet(), lastFall: 7, lastFallAt: Date.now() };
  assert.strictEqual(classify(hurtBot(), state), 'fall');
});

check('a three-block drop is survivable and is not blamed', () => {
  const state = { ...quiet(), lastFall: 3, lastFallAt: Date.now() };
  assert.notStrictEqual(classify(hurtBot(), state), 'fall');
});

check('an old fall is not blamed for damage taken much later', () => {
  const state = { ...quiet(), lastFall: 9, lastFallAt: Date.now() - 5000 };
  assert.notStrictEqual(classify(hurtBot(), state), 'fall');
});

check('standing in lava is lava', () => {
  const bot = hurtBot({ blocks: { '0,64,0': 'lava' } });
  assert.strictEqual(classify(bot, quiet()), 'lava');
});

check('lava underfoot counts too', () => {
  const bot = hurtBot({ blocks: { '0,63,0': 'lava' } });
  assert.strictEqual(classify(bot, quiet()), 'lava');
});

check('burning is fire, even standing on nothing in particular', () => {
  assert.strictEqual(classify(hurtBot({ onFire: true }), quiet()), 'fire');
});

check('a magma block is fire, not lava', () => {
  const bot = hurtBot({ blocks: { '0,63,0': 'magma_block' } });
  assert.strictEqual(classify(bot, quiet()), 'fire');
});

check('empty lungs is drowning', () => {
  assert.strictEqual(classify(hurtBot({ oxygen: 0 }), quiet()), 'drowning');
});

check('empty hunger bar is starving', () => {
  assert.strictEqual(classify(hurtBot({ food: 0 }), quiet()), 'starving');
});

// The bot digs constantly and gravel falls; being buried is a real, silent
// source of damage it had no handler for.
check('a solid block in our head is suffocation', () => {
  const bot = hurtBot({ blocks: { '0,65,0': 'gravel' } });
  assert.strictEqual(classify(bot, quiet()), 'suffocation');
});

check('open air overhead is not suffocation', () => {
  assert.strictEqual(classify(hurtBot(), quiet()), 'unknown');
});

check('a cactus touching us is the cactus', () => {
  const bot = hurtBot({ blocks: { '1,64,0': 'cactus' } });
  assert.strictEqual(classify(bot, quiet()), 'cactus');
});

check('below the world is the void', () => {
  assert.strictEqual(classify(hurtBot({ pos: [0, -70, 0] }), quiet()), 'void');
});

console.log('\ncombat damage');

// By the time the damage lands the creeper is gone, along with any evidence
// it was ever there — so the fuse has to be remembered, not looked up.
check('a fuse lit moments ago is the explosion', () => {
  const state = { ...quiet(), fusingCreeperAt: Date.now() };
  assert.strictEqual(classify(hurtBot(), state), 'explosion');
});

check('a fuse from ten seconds ago is not', () => {
  const state = { ...quiet(), fusingCreeperAt: Date.now() - 10000 };
  assert.notStrictEqual(classify(hurtBot(), state), 'explosion');
});

check('an arrow in flight nearby is ranged damage', () => {
  const bot = hurtBot({ entities: [{ name: 'arrow', type: 'other', at: [3, 64, 0] }] });
  assert.strictEqual(classify(bot, quiet()), 'ranged');
});

check('a hostile within reach is melee', () => {
  const bot = hurtBot({ entities: [{ name: 'zombie', type: 'hostile', at: [2, 64, 0] }] });
  assert.strictEqual(classify(bot, quiet()), 'melee');
});

check('a hostile across the clearing did not melee us', () => {
  const bot = hurtBot({ entities: [{ name: 'zombie', type: 'hostile', at: [20, 64, 0] }] });
  assert.strictEqual(classify(bot, quiet()), 'unknown');
});

console.log('\nwhat wins when several could apply');

// Ordering matters: lava while a zombie happens to be standing nearby is
// still lava, and fixing the lava is what saves the bot.
check('lava beats a nearby zombie', () => {
  const bot = hurtBot({
    blocks: { '0,64,0': 'lava' },
    entities: [{ name: 'zombie', type: 'hostile', at: [2, 64, 0] }],
  });
  assert.strictEqual(classify(bot, quiet()), 'lava');
});

check('a fresh fall beats a nearby zombie', () => {
  const bot = hurtBot({ entities: [{ name: 'zombie', type: 'hostile', at: [2, 64, 0] }] });
  const state = { ...quiet(), lastFall: 8, lastFallAt: Date.now() };
  assert.strictEqual(classify(bot, state), 'fall');
});

// Every health drop used to count as an attack: index.js stamped the combat
// clock and blamed whoever stood within five blocks before anything had
// worked out what the drop was. A fall with a player standing nearby made that
// player the attacker. Only hits count now, and only a melee-shaped hit is
// pinned on whoever happens to be close.
console.log('\nonly a hit counts as being attacked');

const { EventEmitter } = require('events');
const { startDamageWatch, ATTACK_CAUSES } = require('../src/damage');
const difficultyState = require('../src/difficulty').createState;

/** A live-enough bot: hurtBot's world, plus the events startDamageWatch listens to. */
function watchedBot(opts) {
  const bot = Object.assign(new EventEmitter(), hurtBot(opts), { health: 20, username: 'Mint' });
  bot.entity.onGround = true;
  const ctx = {
    connected: true,
    damage: {
      total: {}, hits: {}, lastCause: null, lastAt: 0,
    },
    difficulty: difficultyState(),
    threat: { lastAttackedAt: 0, lastAttackerId: null, lastAttackAt: 0 },
  };
  const stop = startDamageWatch(bot, ctx);
  const hurt = (to) => {
    bot.health = to;
    bot.emit('health');
  };
  return {
    bot, ctx, stop, hurt,
  };
}

const standingPlayer = { name: 'player', type: 'player', username: 'you', at: [2, 64, 0] };

check('only melee, ranged, explosion and unexplained hits are attacks', () => {
  assert.deepStrictEqual([...ATTACK_CAUSES].sort(), ['explosion', 'melee', 'ranged', 'unknown']);
});

check('starving next to a player is not an attack, and the player is not blamed', () => {
  const {
    bot, ctx, stop, hurt,
  } = watchedBot({ food: 0, entities: [standingPlayer] });
  try {
    hurt(19);
    assert.strictEqual(ctx.damage.lastCause, 'starving');
    assert.strictEqual(ctx.threat.lastAttackedAt, 0, 'hunger must not start the combat clock');
    assert.strictEqual(ctx.threat.lastAttackerId, null, 'a bystander must not become the attacker');
    assert.strictEqual(bot.recoilUntil, undefined, 'there is no knockback to wait out');
  } finally {
    stop();
  }
});

check('a fall next to a player is not an attack either', () => {
  const {
    bot, ctx, stop, hurt,
  } = watchedBot({ pos: [0, 70, 0], entities: [standingPlayer] });
  try {
    bot.entity.onGround = false;
    bot.emit('move');
    bot.entity.position = new Vec3(0, 64, 0);
    bot.entity.onGround = true;
    bot.emit('move'); // landed six blocks down
    hurt(17);
    assert.strictEqual(ctx.damage.lastCause, 'fall');
    assert.strictEqual(ctx.threat.lastAttackedAt, 0);
    assert.strictEqual(ctx.threat.lastAttackerId, null);
  } finally {
    stop();
  }
});

check('a melee hit starts the clock, the recoil, and names the mob', () => {
  const {
    bot, ctx, stop, hurt,
  } = watchedBot({ entities: [{ name: 'zombie', type: 'hostile', at: [2, 64, 0] }] });
  try {
    hurt(17);
    assert.strictEqual(ctx.damage.lastCause, 'melee');
    assert.ok(Date.now() - ctx.threat.lastAttackedAt < 1000, 'the combat clock must start');
    assert.ok(bot.recoilUntil > Date.now(), 'knockback gets its window');
    assert.strictEqual(ctx.threat.lastAttackerId, 0, 'the zombie is the attacker');
  } finally {
    stop();
  }
});

check('an arrow counts as an attack but is not pinned on whoever is standing close', () => {
  const {
    ctx, stop, hurt,
  } = watchedBot({ entities: [{ name: 'arrow', type: 'other', at: [3, 64, 0] }, standingPlayer] });
  try {
    hurt(16);
    assert.strictEqual(ctx.damage.lastCause, 'ranged');
    assert.ok(ctx.threat.lastAttackedAt > 0, 'being shot is being attacked');
    assert.strictEqual(ctx.threat.lastAttackerId, null, 'the archer is somewhere else');
  } finally {
    stop();
  }
});

console.log(`\n${passed} checks passed`);
