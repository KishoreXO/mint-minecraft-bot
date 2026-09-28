/**
 * Swimming — the older entry points, now backed by src/water.js.
 *
 * This module used to hold the whole of the bot's relationship with water,
 * built on the idea that a swimmer steers by LOOKING: pitch down and forward
 * to dive, sprint to swim faster, jump or sneak to rise and sink. None of that
 * is true of the physics this client runs (prismarine-physics 1.11.1: only yaw
 * steers, sprint does nothing, sneak only slows you) — see water.js for the
 * measurements and what they cost. The routing, the air budget and the
 * control of the body in water all live there now.
 *
 * What stays here: tracking the bot's own air (a mineflayer bug, not water),
 * and thin wrappers so the callers that grew up around this module — combat,
 * nav, shelter, the tests — keep their names.
 */

const Vec3 = require('vec3');
const water = require('./water');

const {
  AIR_FULL, AIR_RESERVE, AIR_CRITICAL, AIR_TICKS_PER_BUBBLE,
} = water;

/**
 * Our own air, and nobody else's.
 *
 * mineflayer 4.39 sets bot.oxygenLevel from the `air_supply` metadata of EVERY
 * entity, not only the bot's (lib/plugins/entities.js:498 has no
 * `entity === bot.entity` check). Live on 09-24, beside a lush cave, the log
 * read "air: 375" then "air: 400": an axolotl's 6000-tick air, divided by 15.
 * It cuts both ways. A zombie drowning nearby reads as the bot out of breath
 * and fires escapeDrowning for nothing; a fish or axolotl reads as full lungs
 * while the bot is actually drowning, and escapeDrowning never fires at all.
 *
 * So take the bubble count only from metadata about our own entity, and make
 * mineflayer's writes to the property go nowhere. Installed right after
 * createBot, before any packet can arrive. Clamped to 0–20: the server's air
 * goes to -20 while drowning, which the logs printed as "air: -1".
 */
function trackOwnAir(bot) {
  let own = AIR_FULL;
  Object.defineProperty(bot, 'oxygenLevel', {
    configurable: true,
    enumerable: true,
    get: () => own,
    set: () => {}, // mineflayer's, reporting whichever entity spoke last
  });
  bot._client.on('entity_metadata', (packet) => {
    if (!bot.entity || packet.entityId !== bot.entity.id) return;
    // By name where the registry has it — the index moves between versions —
    // and key 1 before that, as mineflayer's old breath.js did.
    const keys = bot.registry?.entitiesByName?.player?.metadataKeys;
    const airKey = keys ? keys.indexOf('air_supply') : 1;
    for (const entry of packet.metadata) {
      if (entry.key === airKey) own = Math.max(0, Math.min(AIR_FULL, Math.round(entry.value / AIR_TICKS_PER_BUBBLE)));
    }
  });
  // A respawn is a fresh pair of lungs; the server does not always say so.
  bot.on('respawn', () => { own = AIR_FULL; });
}

/** Is the head underwater? The vanilla eye rule — see water.eyeInWater. */
function isSubmerged(bot) {
  return water.eyeInWater(bot);
}

/**
 * The nearest cell the bot could breathe in, by an actual swim route (a
 * pocket behind a wall is not "near" if the way round is long), or null.
 */
function nearestBreath(bot) {
  const route = water.planRoute(bot, { type: 'breath' });
  if (!route) return null;
  const end = route.path[route.path.length - 1];
  return new Vec3(end.x, end.y + 1, end.z);
}

/** Dry land the bot can actually climb onto from the water, or null. */
function findShore(bot, radius = water.EXIT_SURFACE_RADIUS) {
  return water.findExit(bot, { radius })?.stand ?? null;
}

/**
 * Swim to `target`: ashore on its side if it is dry land, otherwise through
 * the water. Resolves true on arrival. `timeoutMs` bounds the whole swim.
 */
async function swimTo(bot, target, task, { within = 1.5, timeoutMs = 15000 } = {}) {
  const { withDeadline, isInterruption } = require('./task');
  try {
    return await withDeadline(water.swimToward(bot, target, task, { within, owner: 'swimTo' }), timeoutMs, 'swim', task);
  } catch (err) {
    if (isInterruption(err)) throw err;
    return false;
  }
}

/** Get the head into air, by a route; true when breathing. */
async function surfaceForAir(bot, task) {
  await water.withPilot(bot, 'surfaceForAir', (pilot) => water.swimRoute(bot, pilot, { type: 'breath' }, task));
  return !water.eyeInWater(bot);
}

/**
 * The passive float that used to be a 100ms watchdog interval: now the water
 * pilot's idle mode, on physics ticks. Returns a stop function.
 */
function startSwimWatchdog(bot, ctx) {
  const pilot = water.installWater(bot, ctx);
  return () => {
    pilot.detach();
    if (bot.waterPilot === pilot) bot.waterPilot = null;
  };
}

module.exports = {
  trackOwnAir,
  startSwimWatchdog,
  swimTo,
  surfaceForAir,
  nearestBreath,
  findShore,
  isSubmerged,
  isWater: water.isWaterish,
  isBreathable: water.isBreathable,
  AIR_RESERVE,
  AIR_CRITICAL,
  AIR_FULL,
};
