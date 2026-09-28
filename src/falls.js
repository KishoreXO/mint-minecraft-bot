const logger = require('./logger');
const { isWaterish } = require('./water');
const { touchingLava, lavaAtBody, isLavaBlock } = require('./lava');

/**
 * Stop the bot walking off things.
 *
 * Pathfinder has its own drop limit (maxDropDown = 3) and respects it, so
 * routed travel was never the problem. The problem is everything that drives
 * the control states BY HAND, which is most of what this bot does:
 *
 *   nav.walkTheLastBit   the final 2.2 blocks of every single journey,
 *                        sprinting, aimed at a point with no terrain check
 *   inventory.walkOnto   the last metre to a dropped item, same
 *   tactics.fightMelee   forward, back, and a strafe that flips every 900ms,
 *                        all of it manual, none of it looking at the floor
 *   swordpvp             the engine takes over inside three blocks and
 *                        strafes and hops with no idea where the edge is
 *
 * Every one of those can sprint a bot off a cliff, and the damage ledger says
 * they do: "Took avoidable damage {cause: fall, lost: 4, fellBlocks: 7}" in
 * the middle of a hunt, and a death recorded as `killedBy: fall` at y=61 on a
 * bot that started the drop at y=68.
 *
 * Guarding each caller separately would mean four copies of the same check
 * and would still miss the pvp engine, whose movement code is not ours. So
 * this watches the bot's actual VELOCITY instead of any particular caller's
 * intent: whichever piece of code is steering, if the bot is about to walk
 * into a drop that would hurt, the movement controls come off for that tick.
 *
 * Deliberately biased toward doing nothing. A false positive is a bot frozen
 * at the lip of a harmless step, which is the failure mode this project has
 * suffered from most, so every uncertain case — an unloaded chunk, water, a
 * bot already airborne — is treated as "not my business".
 */

// Fall damage starts above three blocks, so a drop of exactly three is free.
const SAFE_DROP = 3;

/**
 * The deepest drop worth walking off, onto ground or into water alike — and
 * pathfinder's maxDropDown (src/bot.js sets it from this, so the two cannot
 * disagree about the same ledge). See isDropAt for why water gets no more.
 */
const MAX_DROP_DOWN = 4;
// How far below the safe drop to keep looking before calling it a real fall.
// Past this it is a ravine and the exact depth stops mattering.
const DEEP_PROBE = 8;
// Slower than this is drift — turning on the spot, being nudged by a mob.
const MIN_SPEED = 0.08;
/**
 * How far ahead to look, in blocks.
 *
 * A sprinting player covers 0.28 blocks per tick and does not stop dead, so
 * the check has to fire before the edge rather than at it. Much more than
 * this and the bot starts refusing to walk near perfectly ordinary terrain.
 */
const LOOK_AHEAD = 1.3;
/**
 * ...and further when moving faster, because stopping is not instant.
 *
 * A fixed distance is the wrong shape for this. Releasing the movement keys
 * does not stop a Minecraft player dead — it coasts, and how far it coasts
 * depends entirely on how fast it was going. A sprinting bot covers 0.28 blocks
 * per tick and the guard polls once per tick, so at 1.3 blocks of warning it
 * has about four ticks to shed all of that, which it does not reliably manage.
 *
 * Measured: the guard fired ("Stopped at a ledge") and one second later the
 * damage ledger recorded a sixteen-block fall for 13 health, during ordinary
 * travel on flat-looking ground.
 *
 * Scaling with speed keeps the WARNING TIME roughly constant instead of the
 * distance, which is the thing that actually matters. Capped, because looking
 * too far ahead makes the bot refuse perfectly ordinary terrain, and a frozen
 * bot has cost this project far more than fall damage ever has.
 */
const LOOK_AHEAD_PER_SPEED = 4.5;
const LOOK_AHEAD_MAX = 2.4;

function lookAheadFor(speed) {
  return Math.min(LOOK_AHEAD_MAX, Math.max(LOOK_AHEAD, 0.9 + speed * LOOK_AHEAD_PER_SPEED));
}

const WATCHDOG_MS = 50;
const MOVEMENT_CONTROLS = ['forward', 'back', 'left', 'right', 'sprint'];

/**
 * Is this column a fall worth avoiding?
 *
 * Water counts as a floor — landing in it is free, and refusing to enter water
 * is how the bot ended up bridging across lakes — but only up to MAX_DROP_DOWN.
 * It used to count at ANY depth, and a landing being free is not the same as
 * being able to leave: nothing climbs more than one block out of water. On
 * 09-26 the bot walked off a ravine rim at y=80 into water at y=62, over and
 * over (33 re-entries in one session), after pathfinder had already been told
 * not to (infiniteLiquidDropdownDistance).
 */
function isDropAt(bot, pos) {
  for (let dy = 1; dy <= SAFE_DROP + DEEP_PROBE; dy++) {
    const block = bot.blockAt(pos.offset(0, -dy, 0));
    // No data. Guessing here means freezing the bot at a chunk border, which
    // is worse than the hit it might take.
    if (!block) return false;
    if (isWaterish(block)) {
      if (dy <= MAX_DROP_DOWN) return false;
      continue; // deep water under a tall drop: keep looking for the bottom
    }
    if (block.boundingBox === 'block') return dy > SAFE_DROP + 1;
  }
  // Nothing solid for eleven blocks. Whatever that is, do not walk into it.
  return true;
}

/**
 * Lava on the way, for the same hand-driven walks the drop check covers.
 *
 * isDropAt looks straight through a lava surface to the floor under it and
 * calls that ground, so every manual walk — the last 2.2 blocks of every trip,
 * the step onto a drop, the fight footwork — would walk into a pool it was
 * pointed at. Pathfinder avoids lava; nothing driving the controls by hand did.
 *
 * Body-wide, sampled every half block: lava where the body would be, or lava
 * where the floor should be. Walking PAST a pool one cell over is untouched —
 * the 0.6-wide body centred in the next cell never overlaps it.
 */
const LAVA_SAMPLE_STEP = 0.5;

function lavaAt(bot, point) {
  if (lavaAtBody(bot, point)) return true;
  try {
    return isLavaBlock(bot.blockAt(point.floored().offset(0, -1, 0)));
  } catch {
    return false;
  }
}

function lavaAlong(bot, from, ux, uz, reach) {
  for (let d = LAVA_SAMPLE_STEP; d <= reach + 1e-9; d += LAVA_SAMPLE_STEP) {
    if (lavaAt(bot, from.offset(ux * d, 0, uz * d))) return true;
  }
  return false;
}

/**
 * Heading into lava. Stands aside once the bot is already touching it: the way
 * out of a pool can run through more of the pool, and escapeHazard owns that.
 */
function walkingIntoLava(bot) {
  const entity = bot.entity;
  if (!entity?.position || touchingLava(bot)) return false;
  const v = entity.velocity;
  if (!v) return false;
  const speed = Math.hypot(v.x, v.z);
  if (speed < MIN_SPEED) return false;
  return lavaAlong(bot, entity.position, v.x / speed, v.z / speed, lookAheadFor(speed));
}

/** Where the bot is actually heading, and whether the floor runs out there. */
function walkingIntoAFall(bot) {
  const entity = bot.entity;
  if (!entity) return false;
  // Already falling, swimming or climbing: nothing left to prevent.
  if (entity.isInWater || !entity.onGround) return false;

  const v = entity.velocity;
  if (!v) return false;
  const speed = Math.hypot(v.x, v.z);
  if (speed < MIN_SPEED) return false;

  const reach = lookAheadFor(speed);
  const ahead = entity.position.offset(
    (v.x / speed) * reach,
    0,
    (v.z / speed) * reach,
  );
  // Check the whole path to that point, not only its far end. At sprint speed
  // the look-ahead spans two blocks, and testing only the last one steps
  // straight over a one-block-wide shaft — which is exactly what the bot digs.
  for (let d = 1; d <= reach; d += 1) {
    const at = entity.position.offset((v.x / speed) * d, 0, (v.z / speed) * d);
    if (isDropAt(bot, at.floored())) return true;
  }
  return isDropAt(bot, ahead.floored());
}

/**
 * The same question for a specific destination, for callers that know where
 * they are trying to go before they start moving. Cheaper and earlier than
 * waiting for the velocity to point at the edge.
 */
function stepWouldFall(bot, target) {
  const here = bot.entity.position;
  const dx = target.x - here.x;
  const dz = target.z - here.z;
  const distance = Math.hypot(dx, dz);
  if (distance < 0.1) return false;

  const reach = Math.min(LOOK_AHEAD, distance);
  const ahead = here.offset((dx / distance) * reach, 0, (dz / distance) * reach);
  if (isDropAt(bot, ahead.floored())) return true;
  // The whole way to the target for lava, not just the look-ahead: this is
  // asked before setting off, and a pool two blocks out is still in the way.
  return !touchingLava(bot) && lavaAlong(bot, here, dx / distance, dz / distance, distance);
}

/**
 * How long the guard may hold the bot before it stands down.
 *
 * A guard that can freeze the bot indefinitely is worse than the damage it
 * prevents — a stuck bot has cost this project far more than fall damage ever
 * has. If it has been refusing movement for this long, either the only route
 * out genuinely is down, or something is driving into the edge over and over
 * and the guard is not the thing that will fix it. Either way, let go and let
 * `unstick` take it.
 */
const MAX_HOLD_MS = 3000;
const STAND_DOWN_MS = 5000;
/**
 * How long a standoff has to last before we take the pathfinder goal away.
 *
 * Long enough that an ordinary clipped edge — a strafe, a mob nudge, the last
 * step of an approach — resolves itself without cancelling anybody's journey.
 * Short enough to be well inside the coast of a sprinting player.
 */
const CANCEL_PATH_AFTER_MS = 400;

function startFallGuard(bot, ctx) {
  let lastLogAt = 0;
  let stops = 0;
  let holdingSince = 0;
  let standDownUntil = 0;

  const timer = setInterval(() => {
    if (!ctx.connected || !bot.entity) return;
    // An explicit opt-out, for the rare case where a behavior has decided a
    // drop is the right move and knows what it is doing.
    if (bot.allowFalls) return;
    if (Date.now() < standDownUntil) return;

    // Deliberately NOT exempt while pathfinder holds a goal, and that was a
    // wrong turn worth recording.
    //
    // The reasoning for exempting it was sound as far as it went: pathfinder's
    // maxDropDown is 3, its move generators only land on ground they have
    // checked, and a routed path therefore never walks into a damaging fall —
    // so the guard would only ever be fighting it for no reason.
    //
    // What that misses is who else sets a pathfinder goal. The pvp engine
    // holds a GoalFollow for the whole chase and then switches to MANUAL
    // control states inside three blocks, without clearing it. So "pathfinder
    // has a goal" was true for exactly the case the guard exists for, and
    // exempting it turned the protection off during every hunt and every
    // fight. Measured immediately: `damage fall 13` on a bot chasing a pig.
    //
    // And the conflict it was meant to avoid cannot actually arise, for the
    // same reason it was proposed: pathfinder never creates a drop over three
    // blocks, and a three-block drop is one this guard allows. If the guard
    // fires while pathfinder is steering, something else is steering too.
    // The stand-down below is what bounds the risk, rather than a blanket
    // exemption that also removes the point.
    const intoLava = walkingIntoLava(bot);
    if (!intoLava && !walkingIntoAFall(bot)) {
      holdingSince = 0;
      return;
    }

    for (const control of MOVEMENT_CONTROLS) {
      if (bot.controlState?.[control]) bot.setControlState(control, false);
    }
    stops++;

    if (!holdingSince) holdingSince = Date.now();

    // CLEARING THE CONTROLS IS NOT ENOUGH ON ITS OWN.
    //
    // Whatever is steering re-asserts `forward` on its next tick, and this
    // clears it again fifty milliseconds later: a tug of war at twenty hertz,
    // during which the bot is still moving, because releasing the key does not
    // stop a sprinting player dead — it coasts for the best part of a block.
    // So the bot inches over the lip while the guard is "working".
    //
    // Measured: "Stopped at a ledge {timesSoFar: 1}" at 20:12:10, then "Took
    // avoidable damage {cause: fall, lost: 13, fellBlocks: 16}" at 20:12:11.
    // The guard fired and the bot went over anyway.
    //
    // A brief standoff is ordinary — a mob nudge, a strafe that clipped an
    // edge. A sustained one means something upstream genuinely wants to walk
    // off this cliff, and the only way to stop asking is to take the goal away.
    // The caller sees its leg stall, blacklists the target and picks another,
    // which is the correct outcome and costs seconds rather than hearts.
    if (Date.now() - holdingSince > CANCEL_PATH_AFTER_MS) {
      try {
        if (bot.pathfinder?.goal) bot.pathfinder.setGoal(null);
      } catch {
        // pathfinder not active; the control clear above is all there is
      }
    }

    // Never for lava. Standing down trades a frozen bot for a fall of a few
    // hearts, which is sometimes worth it; for lava it trades it for the run.
    if (!intoLava && Date.now() - holdingSince > MAX_HOLD_MS) {
      standDownUntil = Date.now() + STAND_DOWN_MS;
      holdingSince = 0;
      logger.warn('Held at a ledge too long — standing down rather than freezing', {
        at: bot.entity.position.floored(),
        doing: ctx.currentBehavior ?? 'unknown',
      });
      return;
    }

    // Once per few seconds, not once per tick — the guard fires repeatedly
    // for as long as the bot faces the edge, and that is by design.
    if (Date.now() - lastLogAt > 4000) {
      lastLogAt = Date.now();
      logger.info(intoLava ? 'Stopped short of lava' : 'Stopped at a ledge', {
        at: bot.entity.position.floored(),
        doing: ctx.currentBehavior ?? 'unknown',
        timesSoFar: stops,
      });
    }
  }, WATCHDOG_MS);

  if (timer.unref) timer.unref();
  return () => clearInterval(timer);
}

module.exports = {
  startFallGuard,
  stepWouldFall,
  walkingIntoAFall,
  walkingIntoLava,
  isDropAt,
  // The one definition of a free fall — src/bot.js prices parkour with it.
  SAFE_DROP,
  // ...and of the tallest drop worth taking; bot.js sets maxDropDown from it.
  MAX_DROP_DOWN,
};
