const logger = require('./logger');
const { sleep, isInterruption } = require('./task');
const { retreatFrom } = require('./nav');
const { isExplosive, isRangedAttacker, eyePos } = require('./entities');
const {
  equipBestWeapon, holdingBestWeapon, findItem, equipTo,
} = require('./inventory');
const { mobFacts } = require('./knowledge');
const { findShore, swimTo, AIR_RESERVE } = require('./swim');

/**
 * Weapon in the main hand, shield in the off-hand, before the first swing.
 *
 * The shield half matters more than it looks. SWORD_PVP_CONFIG already has
 * shieldConfig enabled, so the combat engine will raise and lower one all by
 * itself — but only if the bot is actually holding it. It blocks skeleton
 * arrows outright and cuts creeper blast damage by roughly two thirds, which
 * covers the two things that were killing this bot most often.
 */
/**
 * Raising and lowering the shield ourselves.
 *
 * The combat engine's shieldConfig handles the ordinary melee case, but the
 * two situations that actually hurt this bot — a creeper about to detonate,
 * and closing the gap on an archer — are ones WE drive the controls for, so
 * the engine is not running at all. Those are precisely the moments a shield
 * is worth the most: it stops an arrow outright and cuts blast damage by
 * roughly two thirds.
 *
 * Mechanics that matter here: the shield takes a moment to come up before it
 * protects, blocking slows movement to a sneak, and the bot cannot swing
 * while it is raised. So it goes up when we are retreating or approaching
 * and comes down to attack — the block-hit-block cycle a player uses.
 */
function hasShieldUp(bot) {
  return bot._shieldRaised === true;
}

function shieldInOffHand(bot) {
  const offHand = bot.inventory?.slots?.[45];
  return !!offHand && offHand.name === 'shield';
}

function raiseShield(bot) {
  if (!shieldInOffHand(bot) || hasShieldUp(bot)) return;
  try {
    bot.activateItem(true); // true = off-hand
    bot._shieldRaised = true;
  } catch {
    // Some versions refuse; fighting without it still works.
  }
}

function lowerShield(bot) {
  if (!hasShieldUp(bot)) return;
  try {
    bot.deactivateItem();
  } catch {
    // nothing raised after all
  }
  bot._shieldRaised = false;
}

/** How long a control-holding loop waits between reassertions. */
const TICK_MS = 100;

async function equipForFight(bot) {
  await equipBestWeapon(bot);

  const shield = findItem(bot, (i) => i.name === 'shield');
  if (!shield) return;
  const offHand = bot.inventory.slots[45];
  if (offHand && offHand.name === 'shield') return; // already up
  // Deadlined: some servers refuse the off-hand slot and simply never reply,
  // and an unbounded await here freezes the bot at the start of every fight.
  await equipTo(bot, shield, 'off-hand');
}

/**
 * A SHIELD ONLY BLOCKS WHAT IS IN FRONT OF YOU.
 *
 * This is the single fact the whole shield implementation was missing, and it
 * turned every defensive move into a decorative one. Reported exactly: the bot
 * held its shield up while a creeper was blowing up, then TURNED AROUND —
 * because retreating means walking away, and walking away means facing away —
 * and took the full blast in the back.
 *
 * `flee` had the same hole, with a comment claiming arrows were "stopped
 * outright" while the bot sprinted off with its back to the archer.
 *
 * So a retreat that is meant to be shielded walks BACKWARDS. It is slower than
 * sprinting, which is the trade: reversing at 1.3 blocks a second behind a
 * raised shield beats sprinting at 5.6 with nothing between you and the blast.
 * When there is no shield to hold up, turning and running is strictly better
 * and this is not used.
 */
async function backAwayFacing(bot, entity, task, ms) {
  const deadline = Date.now() + ms;
  try {
    bot.setControlState('forward', false);
    bot.setControlState('sprint', false);
    bot.setControlState('back', true);
    while (Date.now() < deadline && entity.isValid) {
      task.throwIfAborted();
      // Keep the shield between us and it, every tick — the mob moves too.
      await bot.lookAt(eyePos(entity), true).catch(() => {});
      raiseShield(bot);
      await sleep(TICK_MS, task);
    }
  } finally {
    bot.setControlState('back', false);
  }
}

/**
 * Is something shooting at us right now?
 *
 * The old rule raised the shield only once a mob was inside its own melee
 * reach, which for a skeleton is a range it never chooses to be at — so against
 * three of them the shield went up exactly zero times, which is what was
 * reported. The rule that replaces it is the one a player uses: put the shield
 * up when an arrow is actually in the air, and take it down again straight
 * after, so the sprint that closes the gap is not sacrificed for a threat that
 * is not currently live.
 *
 * A projectile stuck in a block has almost no velocity, so the speed floor
 * keeps spent arrows from pinning the shield up forever.
 */
const PROJECTILES = new Set([
  'arrow', 'spectral_arrow', 'trident', 'fireball', 'small_fireball',
  'dragon_fireball', 'wither_skull', 'llama_spit', 'shulker_bullet',
]);
const PROJECTILE_WATCH_RANGE = 18;
/** cos of the cone we count as "aimed at us" — about 25 degrees. */
const AIMED_AT_US = 0.9;

function projectileIncoming(bot) {
  const me = bot.entity.position;
  for (const id of Object.keys(bot.entities)) {
    const e = bot.entities[id];
    if (!e || !e.isValid || e === bot.entity) continue;
    if (!PROJECTILES.has(String(e.name ?? '').toLowerCase())) continue;

    const toUs = me.minus(e.position);
    const range = toUs.norm();
    if (range > PROJECTILE_WATCH_RANGE || range < 0.2) continue;

    const v = e.velocity;
    if (!v) continue;
    const speed = Math.sqrt(v.x * v.x + v.y * v.y + v.z * v.z);
    if (speed < 0.1) continue; // already landed, or stuck in a wall

    const closing = (v.x * toUs.x + v.y * toUs.y + v.z * toUs.z) / (speed * range);
    if (closing >= AIMED_AT_US) return true;
  }
  return false;
}

/**
 * Mob-specific fighting.
 *
 * The mechanics of a swing — attack-cooldown timing, critical hits, reach
 * checks, strafing, aiming, closing the last few blocks — belong to
 * @nxg-org/mineflayer-custom-pvp. Hand-rolling them produced flat swing
 * timers and instant head-snapping, and the previous plugin
 * (mineflayer-pvp) drove all its movement through pathfinder, which
 * teleported the bot to block centres mid-fight.
 *
 * What stays here is the judgement the combat engine has no opinion about:
 *  - creeper discipline: it will stand and trade, which is fatal
 *  - skeleton discipline: close the gap, never back away from an archer
 *  - detecting an unreachable target instead of re-engaging it forever
 *  - which mob to fight and when to stop (see behaviors/threat.js)
 */

// How long the engine can fail to close the gap before we call it unreachable.
const UNREACHABLE_AFTER_MS = 6000;
/**
 * How long we may fail to LAND a hit before giving the target up.
 *
 * Deliberately longer than any single approach and shorter than the fight
 * timeout. A real fight lands something every second or two; eight seconds of
 * swinging at air means the geometry is against us — the thing is on a wall,
 * behind a fence or a block above — and no amount of persistence changes that.
 */
const NO_SWING_GIVE_UP_MS = 8000;

const PROFILES = {
  creeper: {
    label: 'creeper',
    // Explodes at ~3 blocks after a ~1.5s fuse. Strike-and-withdraw is the
    // only safe melee — standing in range waiting out a cooldown, which is
    // what any combat engine does left to itself, gets the bot killed.
    hitAndRun: true,
    safeDistance: 5,
  },
  skeleton: {
    label: 'skeleton',
    // Arrows hurt at range and it kites, so closing is right. Backing off
    // just donates free shots.
    closeFast: true,
  },
  spider: { label: 'spider' },
  witch: { label: 'witch', closeFast: true },
  zombie: { label: 'zombie' },
};

const DEFAULT_PROFILE = { label: 'generic' };

/**
 * WATER IS A DIFFERENT GAME, and pretending otherwise got the bot killed.
 *
 * `drowned` was aliased to `zombie`, so it was fought with the land tactic:
 * sprint in, hit, back off through the knockback window, close again. Every
 * clause of that is false in water.
 *
 *   - You cannot sprint in water, so there is no sprint-hit and none of the
 *     extra knockback the whole combo is built on.
 *   - Knockback in water is damped to almost nothing, so the gap the bot
 *     backs into never opens.
 *   - You cannot land a critical hit while in water at all.
 *   - A swimming player covers about 0.11 blocks a tick; a drowned covers
 *     0.15. Backing off donates free hits to something that closes faster
 *     than we retreat.
 *
 * So the water tactic is the opposite of the land one: get to land if there
 * is any, and if there is not, close and STAY closed, swinging on cooldown,
 * with the head held above the surface so the air gauge never starts.
 */
const WATER_PROFILE = {
  label: 'in water',
  // Never retreat: we are slower than everything that lives here.
  closeFast: true,
  inWater: true,
};

// Variants that fight identically to their base mob.
const ALIASES = {
  husk: 'zombie',
  zombie_villager: 'zombie',
  zombified_piglin: 'zombie',
  stray: 'skeleton',
  bogged: 'skeleton',
  wither_skeleton: 'skeleton',
  pillager: 'skeleton',
  cave_spider: 'spider',
};

/**
 * `bot` is optional so the profile can account for where the fight is
 * actually happening. Being in water overrides every land profile, because
 * the physics the land profiles are built on do not apply there.
 */
function profileFor(entity, bot = null) {
  if (bot?.entity?.isInWater) return WATER_PROFILE;

  const name = entity.name;
  const profile = PROFILES[ALIASES[name] || name];
  if (profile) return profile;
  // Anything unknown that shoots should still be closed on rather than kited.
  if (isRangedAttacker(entity)) return { label: name || 'ranged', closeFast: true };
  if (isExplosive(entity)) return PROFILES.creeper;
  return DEFAULT_PROFILE;
}

/**
 * Is this creeper actually about to detonate?
 *
 * Metadata index 16 is the "ignited/fuse" flag. Knowing the difference
 * between a creeper walking toward us and one that has started its fuse is
 * the whole game against them: the first is a mob to be killed, the second
 * is a bomb to be away from.
 */
function creeperIsFusing(entity) {
  const meta = entity?.metadata;
  if (!Array.isArray(meta)) return false;
  // The state index shifts between versions, so check the plausible ones
  // rather than hardcoding a single slot.
  return meta[16] === 1 || meta[15] === 1 || meta[17] === 1;
}

// (applyProfileToEngine and startPvp lived here and have been deleted.)
//
// Both drove the combat engine, and both became unreachable the moment
// fightMelee took over every melee fight. applyProfileToEngine was also
// still carrying the "raise the shield while closing on an archer"
// behaviour — the one that cancels sprint and crawls the bot into arrow
// fire at 1.3 blocks/second. A fixed bug preserved inside code that no
// longer runs is the worst of both worlds: it reads as if it were the
// current behaviour.
//
// What it was trying to express — never back away from something that
// shoots — now lives in fightMelee, where it actually executes.

/**
 * Break off cleanly.
 *
 * bot.pathfinder.stop is redirected in bot.js so this cannot reach
 * pathfinder's fullStop() (which teleports the bot to the block centre and
 * wipes knockback).
 */
function stopPvp(bot) {
  try {
    bot.swordpvp.stop();
  } catch {
    // not currently attacking
  }
  try {
    const standard = bot.movementProfiles?.standard;
    if (standard) bot.pathfinder.setMovements(standard);
  } catch {
    // pathfinder may be gone if we disconnected mid-fight
  }
}

/**
 * Fight one target using its profile.
 *
 * `shouldContinue` is supplied by the caller and enforces the chase leash,
 * health bail-out and retargeting — this function executes the tactic and
 * returns when told to stop.
 */
async function engage(bot, entity, task, { shouldContinue, since }) {
  const profile = profileFor(entity, bot);

  // Everything that fights in melee — which is everything except a creeper —
  // goes through the hand-driven duel. The engine's crits and strafing were
  // good; its distance keeping was not, and distance is the whole fight
  // against a mob whose reach is shorter than ours. See fightMelee.
  if (!isExplosive(entity)) {
    logger.action('Engaging', {
      target: profile.label,
      tactic: `duel at ${standoffFor(bot, entity).toFixed(2)} (its reach ${mobFacts(entity.name).reach})`,
      ...(since ? { reactionMs: Date.now() - since } : {}),
    });
    // Scoped to the fight it guards. It used to be registered at the top of
    // the function and never released, so every engagement in a long `threat`
    // run left one behind — see Task.onAbort.
    const unwatchAbort = task.onAbort(() => stopPvp(bot));
    try {
      return await fightMelee(bot, entity, task, shouldContinue);
    } finally {
      unwatchAbort();
      lowerShield(bot);
      stopPvp(bot);
    }
  }

  // Unreachable in practice, and kept only as a guard.
  //
  // Everything that reaches this function is non-explosive (the check above
  // returns for all of those), and creepers never arrive here at all —
  // threat.run routes them to fightCreeper before fightTarget is called, and
  // fightTarget's retarget rule breaks off rather than switching onto one.
  //
  // There used to be a large combat-engine path below this point: startPvp,
  // per-profile option overrides, hit-and-run for creepers, shield handling
  // for archers. All of it became dead the moment fightMelee took over, and
  // it was still carrying the old "raise the shield while closing on an
  // archer" bug — the one that crawled the bot toward a skeleton at sneak
  // speed. Dead code that contains a fixed bug is worse than no code, so it
  // is gone rather than left to be read as if it ran.
  logger.warn('engage() reached its unreachable branch', { target: entity.name });
  return { broke: 'unhandled target type' };
}

/**
 * Creepers, properly.
 *
 * The previous answer was "always walk away", which came from a real failure:
 * the pvp engine only swings inside 3 blocks while the creeper profile's safe
 * distance was 5, so the bot oscillated in the gap between the two and never
 * landed a hit. Retreating always is at least safe — but it is slow, it hands
 * the creeper the initiative, and it does not help at all when the bot is
 * cornered, which is when creepers actually kill it.
 *
 * So this drives the controls directly instead of asking the engine to
 * reconcile two contradictory numbers. It is the technique a player uses:
 *
 *   - the fuse takes 1.5s and RESETS if you leave the 3-block trigger radius
 *   - a creeper walks at 0.25 blocks/tick; a sprinting player does 0.28
 *
 * so strike, immediately withdraw past 3 blocks to reset the fuse, and come
 * back in. The bot is never inside blast range with a lit fuse, which is the
 * only way creepers do damage.
 *
 * A lit fuse is always answered by leaving, never by one more hit.
 */
/**
 * Strike at the OUTER EDGE of our reach, not from on top of it.
 *
 * A player's entity reach in Java is 3.0 blocks; a creeper's blast does full
 * damage inside 3 and falls off sharply beyond it, and its fuse only lights
 * when a player is within 3. Those numbers line up almost exactly, which is
 * what makes the fight winnable: a hit landed at 2.9 is a hit landed from
 * the furthest point that still connects, and every centimetre of that is
 * damage not taken when it detonates.
 *
 * Hitting from 2.0 (which is where the engine's tooCloseRange used to put
 * the bot) gives away a whole block of that margin for nothing.
 */
// Our reach is 3.0, and this is just inside it: at exactly 3.0 a swing misses
// whenever latency moves either party a fraction of a block, and a missed
// swing next to a creeper costs the whole exchange.
const CREEPER_STRIKE_RANGE = 2.85;
const CREEPER_RESET_RANGE = 5.0;
const CREEPER_PANIC_RANGE = 3.5;
const CREEPER_DUEL_MS = 20000;

async function fightCreeper(bot, entity, task, shouldContinue) {
  await equipForFight(bot);
  const startedAt = Date.now();

  try {
    while (!task.aborted && entity.isValid) {
      const stop = shouldContinue();
      if (stop) return { broke: stop };
      if (Date.now() - startedAt > CREEPER_DUEL_MS) return { broke: 'creeper timeout' };

      const distance = bot.entity.position.distanceTo(entity.position);
      const fusing = creeperIsFusing(entity);

      // A lit fuse is not a fight any more, it is a countdown.
      //
      // Which retreat to make depends entirely on whether we have a shield,
      // because a shield only covers the direction we are LOOKING:
      //
      //   with a shield    reverse, facing it. Slower, but the blast lands on
      //                    wood. This is the case that was getting the bot
      //                    killed — it raised the shield and then turned its
      //                    back to run, which is the same as not having one.
      //   without one      turn and sprint. Distance is the only defence
      //                    available and every metre of it counts, since blast
      //                    damage falls off sharply past three blocks.
      if (fusing || distance < CREEPER_PANIC_RANGE) {
        bot.clearControlStates();
        if (shieldInOffHand(bot)) {
          await backAwayFacing(bot, entity, task, fusing ? 1600 : 700);
          lowerShield(bot);
        } else {
          lowerShield(bot);
          await retreatFrom(bot, entity.position, [8, 6, 4], task)
            .catch((e) => { if (isInterruption(e)) throw e; });
          await sleep(fusing ? 800 : 200, task);
        }
        continue;
      }

      if (distance <= CREEPER_STRIKE_RANGE) {
        // Shield must be down to swing.
        lowerShield(bot);
        await bot.lookAt(entity.position.offset(0, 1.2, 0), true).catch(() => {});
        try {
          bot.attack(entity);
        } catch {
          // target died between the check and the swing
        }
        // Withdraw on the same beat as the swing. Standing still to wait out an
        // attack cooldown next to a creeper is what the engine was doing, and
        // it is what gets a bot blown up.
        //
        // Facing it on the way out, when we have a shield to face it with —
        // see backAwayFacing. Without one, turn and run; speed is all there is.
        bot.clearControlStates();
        if (shieldInOffHand(bot)) {
          await backAwayFacing(bot, entity, task, 600);
          lowerShield(bot);
        } else {
          await retreatFrom(bot, entity.position, [CREEPER_RESET_RANGE + 1, 4], task)
            .catch((e) => { if (isInterruption(e)) throw e; });
          await sleep(250, task);
        }
        continue;
      }

      // Too far to hit and no fuse lit — close the gap under our own control.
      lowerShield(bot); // blocking halves our speed; we need to cover ground
      await bot.lookAt(entity.position.offset(0, 1.2, 0), false).catch(() => {});
      bot.setControlState('forward', true);
      bot.setControlState('sprint', true);
      await sleep(TICK_MS, task);
      bot.setControlState('forward', false);
      bot.setControlState('sprint', false);
    }
  } finally {
    lowerShield(bot);
    bot.clearControlStates();
  }
  return { broke: entity.isValid ? null : 'creeper dead' };
}

/**
 * Melee, driven by hand, at the outer edge of our reach.
 *
 * The engine was losing fights it should have won, and the reason is a
 * single number. A player's entity reach is 3.0 blocks. A zombie's is 2.2, a
 * spider's 2.0. That gap is not a detail — it is the entire fight. Standing
 * at 2.6 means we hit them and they cannot reach us at all; standing at 2.0,
 * which is where `tooCloseRange` parked the bot, means we trade evenly with
 * something that has more health than we do. "Killed by a spider and a
 * zombie in an open field while holding a stone sword" is that number.
 *
 * So this holds a band instead: never closer than their reach plus a margin,
 * never further than ours. Knockback does most of the work — a hit pushes
 * them out to ~3.3, we step back in to 2.85, and hit again the moment the
 * cooldown allows. That in-and-out is the combo, and while it is running the
 * mob spends the whole fight a fraction of a block short of us.
 *
 * Latency is accounted for explicitly, because every position we read is
 * already stale by one round trip. At 200ms a sprinting zombie has moved
 * nearly a block since the packet we are looking at, so the standoff grows
 * with ping rather than assuming the world is where it says it is.
 */
const MAX_STRIKE = 2.85;      // just inside our 3.0 so lag cannot make it whiff
const REACH_MARGIN = 0.45;    // how far outside THEIR reach to sit
const SWORD_COOLDOWN_MS = 625;  // 1.6 attacks/sec; swinging sooner does less damage
const AXE_COOLDOWN_MS = 1000;
const STRAFE_FLIP_MS = 900;
/**
 * How long to withdraw after landing a sprint-hit.
 *
 * Long enough for the knockback to carry the mob out and for us to add a
 * little distance of our own; short enough that we are closing again well
 * before the attack cooldown expires, so no swing is ever wasted waiting.
 * A sword's cooldown is 625ms, so this sits comfortably inside it.
 */
const KNOCKBACK_WINDOW_MS = 320;

/**
 * Combat polls every game tick, not every fifth.
 *
 * At the 100ms used elsewhere a zombie covers 0.46 blocks between checks —
 * more than the entire margin the standoff is built on. So the bot could be
 * correctly positioned at one poll and already inside the mob's reach at the
 * next, having done nothing wrong. That is the "when the bot lags the mob
 * gets to it and attacks" report, and it is a sampling problem rather than a
 * latency one: the world moved while we were not looking.
 *
 * 50ms is one Minecraft tick — there is no finer granularity to be had, and
 * it halves the distance anything can travel unobserved.
 */
const COMBAT_TICK_MS = 50;
/** How often to confirm the right weapon is still in hand mid-fight. */
const WEAPON_RECHECK_MS = 1000;

function attackCooldownMs(bot) {
  const held = bot.heldItem?.name ?? '';
  if (held.endsWith('_axe')) return AXE_COOLDOWN_MS;
  if (held.endsWith('_sword')) return SWORD_COOLDOWN_MS;
  return SWORD_COOLDOWN_MS;
}

/** How far a mob travels during one round trip, so we stand off by that much more. */
function latencyAllowance(bot, entity) {
  const ping = bot.player?.ping ?? 0;
  if (!ping) return 0;
  const speed = mobFacts(entity.name).speed; // blocks per tick
  return Math.min(0.6, speed * 20 * (ping / 1000));
}

/**
 * The closest we are willing to be to this particular mob.
 *
 * Exported because it is the number the whole fight turns on: sit above the
 * mob's own reach and it cannot touch us, sit below it and we trade evenly
 * with something that has more health. Capped just under our own reach so
 * there is always a band left to stand in.
 */
function standoffFor(bot, entity) {
  const facts = mobFacts(entity.name);
  return Math.min(
    MAX_STRIKE - 0.1,
    facts.reach + REACH_MARGIN + latencyAllowance(bot, entity),
  );
}

/**
 * How close land has to be before it is worth leaving the water to fight.
 *
 * A fight on the bank is one the bot can sprint in, crit in and knock things
 * back in; the same fight in the water is one where it can do none of those
 * and is the slower swimmer. So getting out is worth a couple of seconds —
 * but only a couple. Swimming twenty blocks to a beach while a drowned chews
 * on us is the old mistake in a better disguise.
 */
const FIGHT_FROM_LAND_WITHIN = 6;
const REACH_LAND_MS = 3000;

/**
 * How long we tolerate being unable to close on something that shoots before
 * we stop paying for speed and put the shield up instead.
 *
 * Short, because the whole argument for keeping it down is that sprinting
 * across the gap costs fewer arrows than crawling across it. Once the gap has
 * stopped shrinking, that argument is simply false.
 */
const PINNED_MS = 1200;

async function fightMelee(bot, entity, task, shouldContinue) {
  await equipForFight(bot);

  // Take the fight ashore if the shore is right there.
  if (bot.entity.isInWater) {
    const shore = findShore(bot, FIGHT_FROM_LAND_WITHIN);
    if (shore) {
      logger.action('Getting out of the water to fight', {
        target: entity.name,
        shore,
        why: 'no sprint, no crits and no knockback while swimming',
      });
      await swimTo(bot, shore, task, { within: 1.2, timeoutMs: REACH_LAND_MS })
        .catch((err) => { if (isInterruption(err)) throw err; });
    }
  }
  // `closeFast` marks anything that attacks at range — see PROFILES. Against
  // those the whole tactic changes: get inside its reach and stay glued.
  const profile = profileFor(entity, bot);

  let lastSwing = 0;
  let backOffUntil = 0;
  let strafe = Math.random() < 0.5 ? 'left' : 'right';
  let strafeSince = Date.now();
  // Unreachable-target detection. I dropped this when replacing the engine
  // and it cost a death: against something it could not get to — across a
  // ravine, behind a wall, on a ledge — the bot sprinted at it for the full
  // 45-second fight timeout without moving. That is a behavior that never
  // returns, so the scheduler could not run anything else either, and the
  // log showed "bot is idle, forMs 52341" at the exact moment a creeper
  // reached it. Standing still for 45 seconds IS the AFK.
  let noProgressSince = null;
  let closestSeen = Infinity;
  let lastWeaponCheck = Date.now();
  // When we last actually LANDED a swing. The distance-based check below has
  // a blind spot and this closes it — see NO_SWING_GIVE_UP_MS.
  const fightStartedAt = Date.now();
  let lastLandedSwing = 0;

  const clearMove = () => {
    for (const c of ['forward', 'back', 'left', 'right', 'sprint', 'jump']) {
      bot.setControlState(c, false);
    }
  };

  try {
    while (!task.aborted && entity.isValid) {
      const stop = shouldContinue();
      if (stop) return { broke: stop };

      const distance = bot.entity.position.distanceTo(entity.position);
      const standoff = standoffFor(bot, entity);

      // Are we actually closing? If we have spent several seconds unable to
      // get any nearer, this target is not reachable and the caller needs to
      // know so it can blacklist it rather than re-engaging forever.
      if (distance < closestSeen - 0.35) {
        closestSeen = distance;
        noProgressSince = null;
      } else if (distance > MAX_STRIKE + 1.5) {
        noProgressSince = noProgressSince ?? Date.now();
        if (Date.now() - noProgressSince > UNREACHABLE_AFTER_MS) {
          return { unreachable: true };
        }
      } else {
        noProgressSince = null;
      }

      // The blind spot in the check above, and it is a big one.
      //
      // That test only fires beyond 4.35 blocks. A target sitting between our
      // strike range of 2.85 and that — on a wall, behind a fence, on a ledge,
      // one block up — is neither close enough to hit nor far enough to count
      // as unreachable, so the bot stands there swinging at nothing until the
      // 45-second fight timeout, and then RE-ENGAGES.
      //
      // Watched live against a spider, which climbs: "Engaging {target:
      // spider}" at 18:36:18, 18:37:03, 18:38:33 — the same fight, restarting
      // every forty-five seconds, for minutes, while the bot made no progress
      // toward iron and could not be scheduled to do anything else.
      //
      // Counting landed swings catches every variant of it: whatever the
      // geometry, a fight where we have not connected in eight seconds is one
      // we are not winning by staying.
      if (Date.now() - (lastLandedSwing || fightStartedAt) > NO_SWING_GIVE_UP_MS) {
        logger.info('Cannot land a hit on that — giving it up', {
          target: entity.name,
          distance: Number(distance.toFixed(1)),
          needToBeWithin: MAX_STRIKE,
        });
        return { unreachable: true };
      }

      // Face them at all times; a swing that is not aimed does nothing.
      await bot.lookAt(eyePos(entity), true).catch(() => {});

      // Re-check the weapon mid-fight, not just at the start.
      //
      // A stone sword lasts 131 hits and this bot swings constantly. When one
      // breaks, mineflayer leaves the hand EMPTY and every swing after that
      // does 1 damage — the bot fights on with fists and no error anywhere.
      // Cheap to check, and it also recovers from an equip that silently
      // failed at the start of the fight.
      if (Date.now() - lastWeaponCheck > WEAPON_RECHECK_MS) {
        lastWeaponCheck = Date.now();
        if (!holdingBestWeapon(bot)) {
          const got = await equipBestWeapon(bot);
          logger.info('Re-armed mid-fight', {
            now: bot.heldItem?.name ?? 'fists',
            wanted: got?.name ?? 'nothing available',
          });
        }
      }

      // KNOCKBACK makes the gap, not walking backwards.
      //
      // My first version tried to hold the band by reversing whenever the mob
      // got inside our standoff, and that cannot work: a zombie moves 4.6
      // blocks per second and walking backwards is about 4.3. The bot was
      // being run down every time, which is where `melee 27` in the damage
      // ledger came from despite the band being computed correctly.
      //
      // What a player actually does is sprint-hit. Striking while sprinting
      // applies roughly a block of extra knockback, which opens the gap the
      // bot cannot open with its legs — then it backs off through the moment
      // the mob is recovering, and closes again for the next swing. That
      // in-and-out IS the combo, and the mob spends it out of range.
      // ...none of which is true IN WATER, so none of it happens there.
      //
      // Sprinting does not apply, knockback is damped to nearly nothing, and
      // everything that lives in water swims faster than we do. The in-and-out
      // combo therefore degenerates into standing still being hit: the bot
      // backs off, the gap does not open, the drowned closes anyway, and the
      // next swing is late because we spent the window reversing. Two deaths
      // came from exactly that, with the bot floating at the surface.
      //
      // In water the answer is to close and stay closed, swinging on cooldown,
      // with jump held so our head stays out of the water and the air gauge
      // never starts running.
      const inWater = bot.entity.isInWater;
      const inKnockbackWindow = !inWater && Date.now() < backOffUntil;
      // Recomputed every tick, not once before the loop.
      //
      // `equipForFight` puts the shield in the off-hand and can lose that race
      // — the equip is a window transaction that sometimes lands a moment
      // later, and sometimes not at all. Reading it once meant a fight that
      // started a fraction of a second early spent its entire length believing
      // the bot had no shield, and never raised one. Reported as "there were
      // three skeletons and it never held the shield up a single time".
      const hasShield = shieldInOffHand(bot);

      if (inWater) {
        bot.setControlState('sprint', false);
        bot.setControlState('back', false);

        // GO DOWN AFTER IT.
        //
        // The old water branch held jump unconditionally, to keep the bot's
        // head above the surface so the air gauge never started. That is right
        // when the fight is at the surface and catastrophic when it is not:
        // two skeletons followed the bot into a lake, sank, and shot it from
        // below while it bobbed on top holding forward against a target it
        // could never reach, because the jump it was holding cancelled every
        // attempt to descend. It died there twice.
        //
        // In this client's physics jump is the only way up and letting go of it
        // is the only way down (0.5 b/s; pitch steers nothing, sneak only
        // slows you — measured in test/waterSim.test.js). So diving is not
        // holding jump. `diveIntent` tells the water pilot's float the same
        // thing, since it holds jump on its own whenever the eye goes under
        // (src/water.js); the air reserve is still its to enforce, so the dive
        // ends automatically when the bubbles run low.
        const depthBelow = bot.entity.position.y - entity.position.y;
        const air = bot.oxygenLevel ?? 20;
        const dive = depthBelow > 1 && air > AIR_RESERVE + 2;
        bot.diveIntent = dive;
        bot.setControlState('jump', !dive);
        bot.setControlState('forward', dive || distance > standoff);
      } else if (inKnockbackWindow) {
        bot.setControlState('forward', false);
        bot.setControlState('sprint', false);
        bot.setControlState('back', true);
      } else if (distance > standoff) {
        // Close, sprinting — we need the sprint up at the moment of impact.
        bot.setControlState('back', false);
        bot.setControlState('forward', true);
        bot.setControlState('sprint', true);
      } else {
        bot.setControlState('forward', false);
        bot.setControlState('back', false);
      }

      // BLOCK-HIT-BLOCK.
      //
      // With a shield, the correct melee is not a race to out-damage — it is
      // a trade the bot always wins. The shield is up by default whenever the
      // mob is close enough to swing, so its hits land on wood and do
      // nothing. It comes down only for the instant we swing, and goes
      // straight back up. The mob's own attack cooldown (about a second for
      // a zombie) is far longer than the ~150ms we spend exposed, so in
      // practice it never connects.
      //
      // Facing matters: a shield only blocks from the front, which is why
      // lookAt runs every tick above. Blocking also halves our speed, so it
      // stays down while we are closing the gap.
      if (hasShield) {
        const facts = mobFacts(entity.name);
        const inTheirMelee = distance <= facts.reach + 0.6;
        // An arrow in the air is worth a fifth of a second of sneak speed.
        //
        // The rule used to be melee range and nothing else, which against an
        // archer means never: a skeleton's whole tactic is to stay at eight
        // blocks, so it was never "in its melee" and the shield was never
        // raised. Watching for the projectile itself costs one pass over the
        // entity list and only while we are not already in a brawl.
        const underFire = !inTheirMelee && projectileIncoming(bot);
        // And when we plainly cannot close on something that shoots, standing
        // there taking it is the worst of both worlds. Speed was the reason to
        // keep the shield down; if the speed is not buying ground, put it up.
        const pinned = profile.closeFast
          && distance > MAX_STRIKE
          && noProgressSince !== null
          && Date.now() - noProgressSince > PINNED_MS;

        // ONLY in melee range. Never while closing.
        //
        // I had this raising the shield for the whole approach against
        // archers, reasoning that arrows are worth blocking. The reasoning
        // was right and the move was fatal, because BLOCKING CANCELS SPRINT
        // and drops you to sneak speed — about 1.3 blocks per second. So the
        // bot set off toward a skeleton at a crawl, never covered the ground
        // to its 2.85 strike range, and therefore never attacked at all: it
        // stood there holding a shield up, making particles, while being
        // shot. That is the "holds the shield but doesn't attack and looks
        // AFK" report, and it ended in a death.
        //
        // Crossing the gap fast means eating maybe one arrow. Crossing it at
        // sneak speed means eating all of them. Speed wins; the shield goes
        // up when we arrive.
        if ((inTheirMelee || underFire || pinned) && !inKnockbackWindow) raiseShield(bot);
        else lowerShield(bot);
      }

      // (No elevation handling here, deliberately.)
      //
      // There was a block here nudging the bot to fight on level ground,
      // which did nothing at all: it cleared the jump control, and nothing in
      // this loop ever sets jump. Worse, the reasoning behind it was wrong.
      // Reach is three-dimensional for BOTH sides — a mob's reach is measured
      // the same way ours is — so standing a block above a zombie puts us
      // further from it by exactly the amount it puts it further from us. The
      // 3D distance used throughout this function already accounts for height
      // correctly, and no separate rule is needed.

      // Circle rather than stand still, so a second mob cannot line up on us
      // and so their pathing keeps having to correct.
      if (Date.now() - strafeSince > STRAFE_FLIP_MS) {
        strafe = strafe === 'left' ? 'right' : 'left';
        strafeSince = Date.now();
        bot.setControlState(strafe === 'left' ? 'right' : 'left', false);
      }
      bot.setControlState(strafe, true);

      // Swing only when the cooldown is up: an early swing does a fraction of
      // the damage, which is how a stone sword stops being able to win.
      if (distance <= MAX_STRIKE
        && !inKnockbackWindow
        && Date.now() - lastSwing >= attackCooldownMs(bot)) {
        // Shield down for the swing — you cannot attack while blocking — and
        // back up immediately after. This is the only moment in the whole
        // fight the bot is exposed.
        lowerShield(bot);
        // Sprint must be UP at the moment of impact — that is what makes it a
        // sprint-hit and roughly doubles the knockback. Then withdraw through
        // the window the knockback just bought us.
        //
        // Not in water: sprinting does nothing there (prismarine-physics reads
        // sprint only on land), and it may put the server's idea of us into the
        // swimming pose.
        if (!inWater) bot.setControlState('sprint', true);
        try {
          bot.attack(entity);
        } catch {
          // died between the check and the swing
        }
        lastSwing = Date.now();
        // Only a swing thrown from inside strike range counts as landing —
        // this is the clock the give-up check above runs on.
        lastLandedSwing = lastSwing;

        // How long to withdraw depends on what we are fighting and what we
        // are carrying.
        //
        //  - Against something that SHOOTS, never withdraw. Backing off an
        //    archer is the worst move available: it cannot hit us properly in
        //    melee and can hit us perfectly from four blocks, so every step
        //    back converts a fight we are winning into a fight we cannot
        //    answer. This is what the old `closeFast` profile flag meant, and
        //    it lived in engine config that no longer ran.
        //
        //  - With a SHIELD, a short withdraw is enough: the shield covers the
        //    rest of the cooldown, so there is no reason to give up ground we
        //    would only have to retake.
        //
        //  - With NO shield, stay out of reach for almost the whole cooldown.
        //    Standing in a zombie's range doing nothing for 300ms per swing
        //    is just donating hits; there is nothing to gain from being close
        //    until the next swing is actually ready.
        //  - IN WATER, never withdraw either, for the same reason as an
        //    archer but worse: a drowned swims at 0.15 blocks a tick against
        //    our 0.11, so every step back is a step it closes and a half.
        if (inWater || profile.closeFast) {
          backOffUntil = 0;
        } else if (hasShield) {
          backOffUntil = Date.now() + KNOCKBACK_WINDOW_MS;
        } else {
          backOffUntil = Date.now() + Math.max(KNOCKBACK_WINDOW_MS, attackCooldownMs(bot) - 150);
        }

        if (hasShield) raiseShield(bot);
      }

      await sleep(COMBAT_TICK_MS, task);
    }
  } finally {
    lowerShield(bot);
    // Hand the air gauge back to the watchdog unconditionally. Leaving
    // diveIntent set means the next time the bot so much as wades through a
    // stream, nothing holds it up.
    bot.diveIntent = false;
    clearMove();
  }
  return { broke: entity.isValid ? null : 'target dead' };
}


module.exports = {
  engage, stopPvp, creeperIsFusing, fightCreeper, raiseShield, lowerShield,
  // A shield only covers what the bot is looking at, so anything that retreats
  // behind one has to reverse rather than turn — see backAwayFacing.
  backAwayFacing, shieldInOffHand, projectileIncoming,
  // So callers can report whether the shield actually went up, rather than
  // whether they asked for it — raiseShield is a no-op without one.
  hasShieldUp,
  // Exported for the tests: this is the number the whole melee turns on.
  standoffFor, attackCooldownMs, MAX_STRIKE,
};
