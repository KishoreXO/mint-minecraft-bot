const logger = require('../logger');
const { sleep, isInterruption } = require('../task');
const { goNear } = require('../nav');
const { sweepUntilClear, nearbyDropCount } = require('./collect');
const { bestToolOfType } = require('../inventory');
const { isUnderground } = require('../world');
const { isHostileMob } = require('../entities');

/**
 * After dying, walk back to where it happened so the dropped items get
 * picked up.
 *
 * Two things were wrong with the first version, and together they meant the
 * bot effectively never recovered anything:
 *
 *  1. It called goNear() once. goNear has a 20s overall timeout and a 6s
 *     stall detector, so any death site more than ~60 blocks away ALWAYS
 *     threw "navigation timed out" — and the catch block then cleared
 *     pendingPos, permanently abandoning the loot after a single attempt.
 *     Long walks now happen in legs, each with its own timeout, and a leg
 *     failing only costs us that leg.
 *
 *  2. It had no distance sanity check. Items despawn 5 minutes after
 *     dropping, so a trek the bot cannot finish in time is pure wasted
 *     time — it arrives at an empty field having ignored everything else.
 *     Now the trip is budgeted against the despawn clock before starting.
 *
 * Arriving is also not the same as collecting: drops scatter over several
 * blocks and Minecraft only picks an item up when the hitbox touches it.
 * Standing still at the centre for 2.5s got maybe half the pile. This hands
 * off to the collect behavior instead, which visits each drop individually.
 */

// Items despawn 5 minutes after they hit the ground. Stop a little short of
// that — walking the last 20s to watch them vanish on arrival is worse than
// not going.
const DESPAWN_MS = 5 * 60 * 1000;
const GIVE_UP_MARGIN_MS = 25000;
const RECOVERY_DEADLINE_MS = DESPAWN_MS - GIVE_UP_MARGIN_MS;

// Realistic travel rate including pathfinding detours, terrain and the odd
// stall. Sprinting is 5.6 b/s in a straight line; nothing about this bot's
// route is a straight line, so budget conservatively.
const TRAVEL_BLOCKS_PER_SEC = 2.5;

// Hard cap regardless of the clock. ~100 seconds of walking, which leaves
// real margin inside the despawn window for the collect sweep afterwards.
// Beyond this the route crosses enough unknown terrain that "will it even
// get there" stops being a question about time.
const MAX_RECOVERY_DISTANCE = 250;

/**
 * A pile below us is not a walk, it is a dig — and it needs a pickaxe, which
 * after a death is IN the pile.
 *
 * Recovery used to price every trip as a straight-line walk. At 15:36 on 09-24
 * the bot died at y=-36 and respawned at y=67: "121 blocks" by that measure,
 * comfortably inside the budget, so it set off with an empty inventory to walk
 * a hundred blocks straight down through stone. Three legs made no progress,
 * unstick fired twice at the spawn point, and it gave up 1 minute 50 later —
 * time it could have spent making the pickaxe it needed.
 *
 * So the estimate is made of the bot's own measured speeds:
 *   - walking, TRAVEL_BLOCKS_PER_SEC as before;
 *   - a staircase down: 0.34-0.42 blocks a second, every "Descending" line in
 *     the 13:15 and 13:38 logs on 09-24 (15 in 36s, 7 in 17s, 13 in 38s, 14 in
 *     39s, 10 in 26s). The slow end, because this is a promise to arrive;
 *   - a pickaxe from nothing: 37 seconds from the end of the failed trip to
 *     "Crafted wooden_pickaxe" in the same 09-24 run.
 * A drop this small is a walk down a slope or into a cave, not a dig.
 */
const DESCENT_BLOCKS_PER_SEC = 0.35;
const WALKABLE_DESCENT = 12;
const PICKAXE_FROM_NOTHING_SEC = 40;

function hasPickaxe(bot) {
  try {
    return !!bestToolOfType(bot, 'pickaxe');
  } catch {
    return false; // no inventory to look in
  }
}

/** How far below us the pile is, in blocks. */
function dropTo(bot, site) {
  return Math.max(0, bot.entity.position.y - site.pos.y);
}

function needsDigging(bot, site) {
  return dropTo(bot, site) > WALKABLE_DESCENT;
}

/** Seconds to reach the pile from here, tools included. */
function recoveryEtaSec(bot, site) {
  const here = bot.entity.position;
  const across = Math.hypot(site.pos.x - here.x, site.pos.z - here.z);
  const climb = Math.max(0, site.pos.y - here.y);
  const drop = dropTo(bot, site);
  let eta = (across + climb) / TRAVEL_BLOCKS_PER_SEC;
  if (needsDigging(bot, site)) {
    eta += drop / DESCENT_BLOCKS_PER_SEC;
    if (!hasPickaxe(bot)) eta += PICKAXE_FROM_NOTHING_SEC;
  } else {
    eta += drop / TRAVEL_BLOCKS_PER_SEC;
  }
  return eta;
}

function secondsLeft(site) {
  return (RECOVERY_DEADLINE_MS - (Date.now() - site.diedAt)) / 1000;
}

/** Say a thing about a pile once, not on every scheduling round. */
function sayOnce(site, key, say) {
  site.said = site.said ?? new Set();
  if (site.said.has(key)) return;
  site.said.add(key);
  say();
}

// One navigation leg. Short enough that a stall costs little, long enough to
// make real progress.
const LEG_TIMEOUT_MS = 15000;
const LEG_LENGTH = 40;
const MAX_STALLED_LEGS = 3;

const ARRIVE_WITHIN = 3;
const LINGER_MS = 1200;

// How long to let the respawn settle before trusting bot.entity.position.
const RESPAWN_SETTLE_MS = 800;

/** How far we can still expect to travel before THIS pile is gone. */
function travelBudget(site) {
  const remainingMs = RECOVERY_DEADLINE_MS - (Date.now() - site.diedAt);
  if (remainingMs <= 0) return 0;
  return Math.min((remainingMs / 1000) * TRAVEL_BLOCKS_PER_SEC, MAX_RECOVERY_DISTANCE);
}

/**
 * ONE PENDING SITE WAS NOT ENOUGH, and the case it missed is the common one.
 *
 * Recovery used to hang on a single `pendingPos`. Die on the way back to your
 * corpse — which is exactly what happens, because you are unarmed and walking
 * toward the thing that killed you — and the new death site overwrote the old
 * one. The first pile, the one with all the tools in it, was forgotten the
 * instant the second death happened, and nothing ever went back for it.
 *
 * A queue costs almost nothing and turns a chain of deaths from "everything is
 * lost" into "collect them in order". Capped, because items live five minutes
 * and anything older than that is not a pile, it is a memory.
 */
const MAX_SITES = 4;

function pruneSites(ctx) {
  const now = Date.now();
  ctx.death.sites = (ctx.death.sites ?? []).filter((site) => {
    // Items that land in lava are destroyed on contact. A player who dies in
    // it drops everything where it stands, so the pile is gone before the
    // respawn screen is — walking back is a trip to look at the lava that
    // killed us, and a second chance for it to.
    if (site.inLava) {
      logger.info('Died in lava — anything that fell in has burned; not going back', { at: site.pos });
      return false;
    }
    if (now - site.diedAt > RECOVERY_DEADLINE_MS) {
      logger.info('Gave up on a death pile — it will have despawned', { at: site.pos });
      return false;
    }
    if (site.stalledLegs >= MAX_STALLED_LEGS) {
      logger.warn('Gave up on a death pile — cannot make progress toward it', { at: site.pos });
      return false;
    }
    return true;
  });
  return ctx.death.sites;
}

/**
 * Which pile to go for.
 *
 * Soonest-to-despawn first, not nearest. A pile dropped four minutes ago has
 * one minute left and a pile dropped ten seconds ago has five — walking past
 * the urgent one to collect the safe one loses the urgent one, and the nearest
 * pile is usually the newest because it is where we just died.
 *
 * Anything out of travel range is skipped rather than dropped: the bot may be
 * closer to it later.
 */
function chooseSite(bot, ctx) {
  const viable = pruneSites(ctx).filter((site) => {
    if (bot.entity.position.distanceTo(site.pos) > travelBudget(site)) return false;

    const eta = recoveryEtaSec(bot, site);
    const left = secondsLeft(site);
    if (eta > left) {
      // Skipped, not dropped — as for distance, being nearer later changes
      // the answer. But said, so the rebuild that follows reads as a decision.
      sayOnce(site, 'out of time', () => logger.info('Writing off the death pile — cannot get there before it despawns', {
        at: site.pos,
        blocksDown: Math.round(dropTo(bot, site)),
        needsPickaxe: needsDigging(bot, site) && !hasPickaxe(bot),
        etaSec: Math.round(eta),
        leftSec: Math.round(left),
      }));
      return false;
    }

    // Reachable in time, but not with bare hands. Wait for the pickaxe
    // rather than spending the clock proving that fists do not dig stone —
    // after a respawn woodUrgent and gear are making one anyway, and loot
    // outranks them, so running now would only stand in their way.
    if (needsDigging(bot, site) && !hasPickaxe(bot)) {
      sayOnce(site, 'pickaxe first', () => logger.info('Deep pile — making a pickaxe first', {
        at: site.pos,
        blocksDown: Math.round(dropTo(bot, site)),
        leftSec: Math.round(left),
      }));
      return false;
    }
    return true;
  });
  if (viable.length === 0) return null;
  return viable.sort((a, b) => a.diedAt - b.diedAt)[0];
}

/** Record a death site to come back to. Called from the death handler. */
function noteDeathSite(ctx, pos, { inLava = false } = {}) {
  if (!pos) return;
  ctx.death.sites = ctx.death.sites ?? [];
  ctx.death.sites.push({
    pos: pos.clone ? pos.clone() : pos, diedAt: Date.now(), stalledLegs: 0, inLava,
  });
  // Oldest first, so trimming drops the one closest to despawning anyway.
  while (ctx.death.sites.length > MAX_SITES) ctx.death.sites.shift();
}

/**
 * Next waypoint on the way to the death site.
 *
 * Pathfinder is asked for at most LEG_LENGTH blocks at a time. Handing it a
 * 300-block goal makes it think for its whole timeout and then usually fail;
 * a chain of short goals gets there.
 */
function nextLeg(bot, target) {
  const here = bot.entity.position;
  const delta = target.minus(here);
  if (delta.norm() <= LEG_LENGTH) return { pos: target, final: true };

  // normalize() mutates in place, but `delta` is already a throwaway from
  // minus(), so this is safe. (It would not be on a live entity position.)
  const step = delta.normalize().scaled(LEG_LENGTH);
  return { pos: here.plus(step), final: false };
}

/**
 * Whatever killed us is still standing on the pile.
 *
 * 09-25 17:13: killed by a creeper at dawn, respawned, walked straight back —
 * and died again twenty-four seconds later, on fire, fighting the same crowd
 * with whatever it had just picked up. Dawn is the one time waiting is free:
 * the zombies and skeletons burn within a minute or two. So the pile waits
 * while hostiles are on it — unless the bot is kitted for that fight, or the
 * items are about to despawn, when going now is the only way to get them.
 */
const PILE_GUARD_RANGE = 10;
const PILE_LAST_CHANCE_SEC = 90;

function pileStillGuarded(bot, site) {
  const { nightProof } = require('./shelter');
  if (nightProof(bot) || secondsLeft(site) <= PILE_LAST_CHANCE_SEC) return false;
  for (const id of Object.keys(bot.entities ?? {})) {
    const e = bot.entities[id];
    if (e === bot.entity || !isHostileMob(e)) continue;
    if (e.position.distanceTo(site.pos) <= PILE_GUARD_RANGE) {
      sayOnce(site, 'guarded', () => logger.info('Waiting for the mobs on the pile to clear', {
        mob: e.name,
        leftSec: Math.round(secondsLeft(site)),
      }));
      return true;
    }
  }
  return false;
}

const loot = {
  name: 'loot',
  priority: 60,
  shouldRun(bot, ctx) {
    // Wait for the respawn. Before it lands, bot.entity.position is still the
    // corpse's position — standing on the death site by definition — so this
    // behavior would instantly declare itself finished and throw the loot
    // away. The settle gives the server a moment to place us properly.
    if (!ctx.death.respawnedAt) return false;
    if (Date.now() - ctx.death.respawnedAt < RESPAWN_SETTLE_MS) return false;

    // Not across the surface at night without the kit to survive it. A night
    // death leaves the pile among the mobs that caused it, and the bot comes
    // back with nothing: on 09-25 it walked back unarmed three times and died
    // three more times, once to a creeper standing on the pile. The things in
    // that pile are worth less than the next death costs.
    // Required here: shelter depends on mine, which is heavier than loot needs.
    const { nightComing, nightProof } = require('./shelter');
    if (nightComing(bot) && !isUnderground(bot) && !nightProof(bot)) return false;

    const site = chooseSite(bot, ctx);
    if (!site) return false;
    return !pileStillGuarded(bot, site);
  },
  async run(bot, ctx, task) {
    const site = chooseSite(bot, ctx);
    if (!site) return false;
    const target = site.pos;

    /**
     * Sweep the ground here and close the recovery out.
     *
     * Deliberately does the sweep itself rather than handing off and hoping.
     * This used to clear pendingPos, log "leaving pickup to collect" and
     * finish — giving an entire scattered inventory to a behavior with a
     * per-run cap that anything could preempt. Watched live: the bot walked
     * all the way back to its corpse, picked up a sword, and left the rest to
     * despawn. Nobody owned the sweep, so it did not happen.
     *
     * A death is the single biggest loot event the bot ever has and the items
     * live five minutes. Staying until the ground is clear is worth far more
     * than whatever it would otherwise be doing.
     */
    const sweepHere = async (why) => {
      await sleep(LINGER_MS, task);
      const got = await sweepUntilClear(bot, ctx, task);
      logger.action('Cleared the death site', {
        itemsRecovered: got,
        stillOnGround: nearbyDropCount(bot, ctx),
        ...(why ? { note: why } : {}),
      });
      ctx.death.sites = ctx.death.sites.filter((s) => s !== site);
      if (ctx.death.sites.length === 0) ctx.death.respawnedAt = 0;
      else logger.info('Still have piles to collect', { remaining: ctx.death.sites.length });
      return true;
    };

    const distance = bot.entity.position.distanceTo(target);
    if (distance <= ARRIVE_WITHIN) return sweepHere(null);

    // Far below: dig down to it before walking. Pathfinder does not route a
    // hundred blocks down through solid stone; a staircase does, and it is
    // walkable back up afterwards.
    if (needsDigging(bot, site)) {
      // Required here, not at the top: mine.js is large and pulls in most of
      // the project, and loot must not depend on it at load time.
      const { digStaircaseDown } = require('./mine');
      const dx = target.x - bot.entity.position.x;
      const dz = target.z - bot.entity.position.z;
      const toward = Math.abs(dx) >= Math.abs(dz) ? [Math.sign(dx) || 1, 0] : [0, Math.sign(dz) || 1];
      logger.action('Digging down to the death pile', {
        blocksDown: Math.round(dropTo(bot, site)),
        leftSec: Math.round(secondsLeft(site)),
      });
      const result = await digStaircaseDown(bot, task, {
        targetY: Math.floor(target.y),
        startHeading: site.heading ?? toward,
      });
      site.heading = result.heading;
      if (result.depth === 0) {
        site.stalledLegs += 1;
        logger.warn('Loot descent made no progress', { reason: result.reason, strikes: site.stalledLegs });
      } else {
        site.stalledLegs = 0;
      }
      return true;
    }

    const { pos, final } = nextLeg(bot, target);
    logger.action('Heading back for dropped loot', {
      remaining: Math.round(distance),
      leg: final ? 'final' : `${LEG_LENGTH} blocks`,
    });

    const before = bot.entity.position.clone();
    try {
      await goNear(bot, pos, final ? ARRIVE_WITHIN : 2, task, { timeoutMs: LEG_TIMEOUT_MS });
    } catch (err) {
      if (isInterruption(err)) throw err;
      // A failed leg is normal over long distances — pathfinder gives up on
      // awkward terrain and we simply try again from wherever we ended up.
      // Only repeated *no-progress* legs mean the site is unreachable.
      const moved = bot.entity.position.distanceTo(before);
      if (moved < 3) {
        site.stalledLegs += 1;
        logger.warn('Loot leg made no progress', {
          error: err.message,
          strikes: site.stalledLegs,
        });
      } else {
        site.stalledLegs = 0;
      }
      return true; // still working on it; don't let the director back us off
    }

    // The leg SUCCEEDED. That is not the same as having arrived, and the gap
    // between those two is a livelock.
    //
    // goNear's goal is satisfied inside a radius measured from block centres,
    // while the arrival check above measures true entity distance — so at a
    // true 3.4 blocks pathfinder says "already there" and returns instantly,
    // the arrival check says "not yet", and the behavior is re-picked and does
    // it again. It reports success every time, so the no-op backoff never
    // engages and nothing else ever gets the wheel. Watched live: sixteen
    // "Heading back for dropped loot {remaining: 3, leg: final}" lines inside
    // one second, forever, with the loot four blocks away.
    //
    // On the final leg the answer is simply to stop measuring: we are within a
    // few blocks and sweepUntilClear walks to each drop individually anyway.
    const stillAway = bot.entity.position.distanceTo(target);
    if (final && stillAway > ARRIVE_WITHIN) {
      return sweepHere(`swept from ${Math.round(stillAway)} blocks out`);
    }

    // On an intermediate leg, a "successful" leg that went nowhere is the same
    // livelock wearing a longer walk, so it counts as a stall.
    if (bot.entity.position.distanceTo(before) < 1) {
      site.stalledLegs += 1;
      logger.warn('Loot leg reported success without moving', {
        strikes: site.stalledLegs,
        remaining: Math.round(stillAway),
      });
      return true;
    }

    site.stalledLegs = 0;
    return true;
  },
};

module.exports = {
  loot,
  // The death handler in index.js records sites through this, and the tests
  // exercise the queue directly — losing the FIRST pile because a second
  // death overwrote it was the whole bug.
  noteDeathSite,
  chooseSite,
  recoveryEtaSec,
  MAX_SITES,
  WALKABLE_DESCENT,
};
