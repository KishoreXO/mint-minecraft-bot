/**
 * Shared aiming.
 *
 * Swing timing used to live here too. It's now mineflayer-pvp's job, for
 * both fighting and hunting — Minecraft 1.9+ scales damage by the attack
 * cooldown, and pvp's MaxDamageOffset timing solver gets that right where
 * our hand-rolled per-weapon table was guessing. Keeping our own copy around
 * for hunting only meant the bot swung differently at a cow than at a
 * zombie, which is exactly the "attack spam looks uncanny" problem.
 */

/**
 * Turn toward a point without the instant head-snap.
 *
 * bot.lookAt(pos, true) forces the rotation into a single packet, which from
 * the outside looks like an aimbot. Letting mineflayer interpolate the turn
 * costs nothing and reads as a player.
 */
async function lookAtSmoothly(bot, position) {
  try {
    await bot.lookAt(position, false);
  } catch {
    // Looking failing shouldn't abort a fight.
  }
}

module.exports = { lookAtSmoothly };
