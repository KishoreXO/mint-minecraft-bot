const logger = require('./logger');
const difficulty = require('./difficulty');
const { isOtherPlayer, isHostileMob } = require('./entities');
const { touchingLava } = require('./lava');

/**
 * Work out WHY the bot just lost health, and keep score.
 *
 * "He keeps dying to mobs" was the report, and it turned out to be only
 * partly true — the bot also bled health steadily to falls, fire and its own
 * tunnels, arriving at every fight already half dead. There was no way to
 * see that, because mineflayer's `health` event says the number changed and
 * nothing else: no cause, no attacker, no amount.
 *
 * So this reconstructs the cause from state the bot already has. None of it
 * is guesswork about game internals — each check corresponds to a specific,
 * observable condition at the moment the damage lands:
 *
 *   fall         we were airborne, just landed, and fell more than 3 blocks
 *   lava / fire  we are standing in lava, or the on-fire metadata flag is set
 *   drowning     oxygen is at or near zero
 *   starving     food is empty
 *   suffocation  a solid block occupies our head
 *   cactus       one is touching us
 *   explosion    a creeper was fusing within blast range a moment ago
 *   melee        a hostile is within its own reach
 *   ranged       an arrow is in flight nearby, or an archer has a clear shot
 *   void         below the bottom of the world
 *
 * The tally is what makes it actionable: a session that reads
 * "fall 9, melee 3" is a pathfinding problem wearing a combat problem's
 * clothes, and would have been fixed months earlier if anyone could see it.
 */

// Fall damage starts above three blocks.
const SAFE_FALL_BLOCKS = 3;
// How recently something must have happened to be blamed for this hit.
const RECENT_MS = 700;
const BLAST_RANGE = 7;
const MELEE_REACH = 4.5;
const ARROW_RANGE = 6;

const LAVA = new Set(['lava', 'flowing_lava']);
const BURNING = new Set(['fire', 'soul_fire', 'campfire', 'soul_campfire', 'magma_block', 'lava']);

function blockName(bot, offset) {
  try {
    const block = bot.blockAt(bot.entity.position.offset(...offset));
    return block ? block.name : null;
  } catch {
    return null;
  }
}

/** The shared entity flags byte; bit 0 is "on fire". */
function isOnFire(bot) {
  const meta = bot.entity?.metadata;
  const flags = Array.isArray(meta) ? meta[0] : null;
  return typeof flags === 'number' && (flags & 0x01) !== 0;
}

function touchingCactus(bot) {
  for (const off of [[1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1], [0, 1, 0]]) {
    if (blockName(bot, off) === 'cactus') return true;
  }
  return false;
}

function headBlocked(bot) {
  const name = blockName(bot, [0, 1, 0]);
  if (!name) return false;
  if (name === 'air' || name === 'cave_air' || name === 'void_air') return false;
  try {
    const block = bot.blockAt(bot.entity.position.offset(0, 1, 0));
    // Only a full solid block suffocates; water and plants do not.
    return !!block && block.boundingBox === 'block';
  } catch {
    return false;
  }
}

function nearbyEntities(bot, predicate, range) {
  const out = [];
  for (const id of Object.keys(bot.entities)) {
    const e = bot.entities[id];
    if (!e || e === bot.entity || !e.isValid) continue;
    try {
      if (bot.entity.position.distanceTo(e.position) <= range && predicate(e)) out.push(e);
    } catch {
      // entity disappeared mid-scan
    }
  }
  return out;
}

/**
 * Track the fall so we can measure it.
 *
 * bot.entity.fallDistance is not reliably populated for the local player, so
 * this watches the apex instead: the highest point reached since last being
 * on the ground, minus where we landed.
 */
function createTracker(bot) {
  const state = {
    airborneFrom: null,
    lastFall: 0,
    lastFallAt: 0,
    fusingCreeperAt: 0,
  };

  const onMove = () => {
    const entity = bot.entity;
    if (!entity) return;

    if (entity.onGround) {
      if (state.airborneFrom !== null) {
        const dropped = state.airborneFrom - entity.position.y;
        if (dropped > 0) {
          state.lastFall = dropped;
          state.lastFallAt = Date.now();
        }
        state.airborneFrom = null;
      }
    } else if (state.airborneFrom === null || entity.position.y > state.airborneFrom) {
      state.airborneFrom = entity.position.y;
    }
  };

  bot.on('move', onMove);
  return { state, stop: () => bot.removeListener('move', onMove) };
}

/**
 * Which mob landed that melee hit — or null when we cannot be sure.
 *
 * Certainty is the whole point. This feeds the difficulty inference (see
 * src/difficulty.js), which works backwards from "a zombie hit me for 4.5" to
 * "this world is on Hard" — and a wrong attribution does not produce a missing
 * answer, it produces a confident wrong one that then steers every subsequent
 * fight. So this refuses far more often than it needs to:
 *
 *   - bloodhound's correlation is preferred, because it is a real observation
 *     of a swing rather than an inference from proximity
 *   - failing that, a single mob in reach is attributable; two are not, and
 *     "probably the nearest" is exactly the guess worth not making
 *   - a player is never a difficulty sample: their damage depends on what
 *     they are holding, which we cannot see
 */
function meleeAttacker(bot) {
  const reported = bot.lastAttacker;
  if (reported && Date.now() - reported.at < RECENT_MS) {
    const entity = bot.entities[reported.id];
    if (entity && entity.type !== 'player' && entity.name) return entity;
  }

  const inReach = nearbyEntities(
    bot,
    (e) => (e.type === 'hostile' || e.type === 'mob') && !!e.name,
    MELEE_REACH,
  );
  return inReach.length === 1 ? inReach[0] : null;
}

/**
 * `state` is the fall/fuse history from createTracker. Taken directly rather
 * than as a tracker object so the tests can drive it without a live bot.
 */
function classify(bot, state) {
  const now = Date.now();

  if (bot.entity.position.y < -64) return 'void';

  if (state.lastFall > SAFE_FALL_BLOCKS && now - state.lastFallAt < RECENT_MS) {
    return 'fall';
  }

  const feet = blockName(bot, [0, 0, 0]);
  const below = blockName(bot, [0, -1, 0]);
  // The whole body: half of it in a pool with the centre on the bank is
  // lava damage, and booking it as 'fire' hid the 09-24 death's real cause.
  if (touchingLava(bot) || LAVA.has(feet) || LAVA.has(below)) return 'lava';
  if (isOnFire(bot) || BURNING.has(feet) || BURNING.has(below)) return 'fire';

  if ((bot.oxygenLevel ?? 20) <= 1) return 'drowning';
  if ((bot.food ?? 20) <= 0) return 'starving';
  if (headBlocked(bot)) return 'suffocation';
  if (touchingCactus(bot)) return 'cactus';

  // A creeper that was fusing within blast range just before the hit is the
  // only thing that produces a single large chunk of damage out of nowhere.
  if (now - state.fusingCreeperAt < RECENT_MS) return 'explosion';

  const arrows = nearbyEntities(
    bot,
    (e) => e.name === 'arrow' || e.name === 'spectral_arrow' || e.name === 'trident',
    ARROW_RANGE,
  );
  if (arrows.length > 0) return 'ranged';

  const closeMobs = nearbyEntities(
    bot,
    (e) => e.type === 'hostile' || e.type === 'mob' || e.type === 'player',
    MELEE_REACH,
  );
  if (closeMobs.length > 0) return 'melee';

  return 'unknown';
}

/**
 * Causes that mean something HIT us, as opposed to the world hurting us.
 *
 * Only these reach the combat side. It used to be every point of damage:
 * index.js stamped `lastDamageAt` on any health drop, and everything in
 * threat.js read that stamp as "we are under attack" — `defend` took the
 * wheel, the nearest hostile within eight blocks became worth fighting with
 * no line-of-sight check, and any PLAYER within five blocks became a suspect.
 * So a fall, a starvation tick or a gravel collapse with you standing nearby
 * was enough for the bot to turn on you. The logs have it doing exactly that
 * shape of thing: `Took avoidable damage {suffocation}` followed at once by
 * "Committing to fight", twice; `{starving}` followed by "Fleeing".
 *
 * `unknown` stays in deliberately: a hit nothing could explain is at least as
 * likely to be a mob we failed to attribute as anything else, and treating it
 * as scenery would reopen the "stood there being hit and did nothing" hole.
 */
const ATTACK_CAUSES = new Set(['melee', 'ranged', 'explosion', 'unknown']);
/**
 * ...and the ones where "whoever is standing next to us did it" is a fair
 * guess. Not ranged — the archer is by definition somewhere else — and not an
 * explosion, whose author no longer exists.
 */
const PROXIMITY_BLAME_CAUSES = new Set(['melee', 'unknown']);

// How long after a hit we stop steering, so knockback can play out. Only for
// hits — a fall has no knockback to wait for.
const RECOIL_MS = 400;
// bloodhound's correlation has to be this fresh to be the answer for THIS hit.
const REPORTED_ATTACKER_MS = 1500;
// Close enough to have landed a melee hit, with a little slack for lag.
const BLAME_RANGE = 5;

/**
 * Something hit us: start the combat clock, hold off steering for the
 * knockback, and work out who it was.
 *
 * Moved here from index.js, which ran on every health drop BEFORE this module
 * had classified it, and so could not tell a zombie from the floor.
 */
function noteAttack(bot, ctx, cause, now) {
  if (!ctx.threat) return;
  ctx.threat.lastAttackedAt = now;

  // Global recoil window. nav.js checks this and stops steering while it's
  // active, so the server's knockback velocity actually carries the bot
  // instead of being immediately overridden by our own pathing. Parked on the
  // bot object so every navigation call sees it without plumbing ctx through
  // the movement layer.
  bot.recoilUntil = now + RECOIL_MS;

  // Who hit us? mineflayer-bloodhound correlates the damage event with nearby
  // swings and reports the real attacker, which bot.js parks on
  // bot.lastAttacker. Prefer that over guessing.
  const reported = bot.lastAttacker;
  if (reported && now - reported.at < REPORTED_ATTACKER_MS && bot.entities[reported.id]) {
    ctx.threat.lastAttackerId = reported.id;
    ctx.threat.lastAttackAt = reported.at;
    return;
  }

  // Bloodhound is explicitly best-effort ("not 100% reliable ... at the mercy
  // of latency"), so keep a proximity fallback for when it can't correlate —
  // but only for the hits where proximity means anything.
  if (!PROXIMITY_BLAME_CAUSES.has(cause)) return;
  const attacker = Object.values(bot.entities).find(
    (e) => e !== bot.entity
      && (isOtherPlayer(bot, e) || isHostileMob(e))
      && bot.entity.position.distanceTo(e.position) <= BLAME_RANGE,
  );
  if (attacker) {
    ctx.threat.lastAttackerId = attacker.id;
    ctx.threat.lastAttackAt = now;
  }
}

/**
 * Start watching. Returns a stop function and the live tally.
 *
 * This is also the one place that decides whether a health drop was an
 * ATTACK, because it is the one place that knows what the drop was — see
 * ATTACK_CAUSES and noteAttack.
 */
function startDamageWatch(bot, ctx) {
  const tracker = createTracker(bot);
  let lastHealth = bot.health ?? 20;

  // Watching for a lit fuse has to be continuous — by the time the damage
  // lands the creeper is gone, along with any evidence it was ever there.
  const fuseTimer = setInterval(() => {
    if (!ctx.connected || !bot.entity) return;
    const fusing = nearbyEntities(bot, (e) => {
      if (e.name !== 'creeper') return false;
      const meta = e.metadata;
      return Array.isArray(meta) && (meta[16] === 1 || meta[15] === 1 || meta[17] === 1);
    }, BLAST_RANGE);
    if (fusing.length > 0) tracker.state.fusingCreeperAt = Date.now();
  }, 100);
  if (fuseTimer.unref) fuseTimer.unref();

  const onHealth = () => {
    if (!ctx.connected || !bot.entity) return;
    const health = bot.health ?? 20;
    const lost = lastHealth - health;
    lastHealth = health;
    if (lost <= 0) return;

    const cause = classify(bot, tracker.state);
    const now = Date.now();
    ctx.damage.total[cause] = (ctx.damage.total[cause] || 0) + lost;
    if (ctx.damage.life) ctx.damage.life[cause] = (ctx.damage.life[cause] || 0) + lost;
    ctx.damage.hits[cause] = (ctx.damage.hits[cause] || 0) + 1;
    ctx.damage.lastCause = cause;
    ctx.damage.lastAt = now;

    if (ATTACK_CAUSES.has(cause)) noteAttack(bot, ctx, cause, now);

    // Every melee hit is also a measurement. How much a known mob takes off
    // us is the one observable that says which difficulty this world is on,
    // and the ledger is already standing at exactly the right moment to read
    // it — see src/difficulty.js for why that matters.
    if (cause === 'melee') {
      const attacker = meleeAttacker(bot);
      if (attacker) difficulty.observe(bot, ctx, attacker.name, lost);
    }

    // Environmental damage is nearly always preventable and nearly always a
    // bug in our own movement or digging, so it gets said out loud. Combat
    // damage is expected and would just be noise.
    if (!['melee', 'ranged', 'unknown'].includes(cause)) {
      logger.warn('Took avoidable damage', {
        cause,
        lost: Number(lost.toFixed(1)),
        health: Math.round(health),
        ...(cause === 'fall' ? { fellBlocks: Math.round(tracker.state.lastFall) } : {}),
        // Which behavior was driving. A 28-block fall on 09-25 left no other
        // trace of what walked the bot off the edge.
        doing: ctx.currentBehavior ?? 'unknown',
      });
    }
  };

  bot.on('health', onHealth);

  return () => {
    clearInterval(fuseTimer);
    bot.removeListener('health', onHealth);
    tracker.stop();
  };
}

/** "fall 12 / melee 7 / fire 3", worst first — empty when nothing has hurt us. */
function describeDamage(ctx) {
  const entries = Object.entries(ctx.damage.total)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([cause, amount]) => `${cause} ${Math.round(amount)}`);
  return entries.join('/');
}

module.exports = {
  startDamageWatch, describeDamage, classify,
  // For test/damage.test.js: which causes count as being attacked is the
  // difference between defending ourselves and turning on a bystander.
  ATTACK_CAUSES,
};
