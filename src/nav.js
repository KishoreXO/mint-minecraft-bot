const { goals } = require('mineflayer-pathfinder');
const { Vec3 } = require('vec3');
const {
  AbortError, isInterruption, sleep, untilTick, waitTicks,
} = require('./task');
const logger = require('./logger');
const { stepWouldFall } = require('./falls');
// Safe: swim (and water.js behind it) never requires this module at load.
const { swimTo } = require('./swim');

/** How long to spend swimming a leg pathfinder gave up on. */
const SWIM_LEG_MS = 8000;

/**
 * All movement goes through here, and it deliberately does NOT use
 * bot.pathfinder.goto().
 *
 * Why: when a path runs to completion, pathfinder calls its internal
 * fullStop(), which does two destructive things —
 *
 *   bot.entity.velocity.x = 0        // wipes server-applied knockback
 *   bot.entity.velocity.z = 0
 *   bot.entity.position.x = blockX   // teleports up to ~0.3 blocks
 *   bot.entity.position.z = blockZ
 *
 * ("Kind of cheaty, but the server will not tell the difference" — its own
 * comment. The server does in fact notice: it disagrees with the client and
 * sends a correction, which is the rubber-banding/phasing people see.)
 *
 * Since it fires on *every arrival*, and this bot arrives somewhere every few
 * seconds, it was the single biggest cause of the movement looking hacked and
 * of knockback never registering.
 *
 * The workaround: drive pathfinder with a dynamic goal (which skips the
 * goal_reached path) and cancel it ourselves as soon as we're close enough,
 * *before* its path array empties — so fullStop is never reached. The last
 * block or two is covered by ordinary walking, which physics handles
 * normally and which collides with the world properly.
 */

// One Minecraft tick. At 60 the loop drifted against the server's 50ms tick,
// so roughly one poll in six landed a whole tick late — which on the final
// approach is the difference between stopping on the block and overshooting
// it, and across a whole journey is a steady tax on every leg.
const POLL_MS = 50;
const DEFAULT_TIMEOUT_MS = 20000;
// Hand over from pathfinder to manual walking at this range. Comfortably
// more than one node so the path never empties out underneath us.
const HANDOVER_DISTANCE = 2.2;
const MANUAL_WALK_TIMEOUT_MS = 2500;

/**
 * How long the bot may make no progress at all before we give up on a leg.
 *
 * Deliberately shorter than the old 6000: with progress now measured
 * correctly (see below) a genuine freeze is obvious almost immediately, and
 * every second spent confirming it is a second the bot stands still.
 */
const PROGRESS_GRACE_MS = 3500;
// Once pathfinder has said there is no route, waiting the full grace period
// only delays the retry — the bot has already gone as far as it can.
const NO_ROUTE_GRACE_MS = 700;
// Movement smaller than this is drift — turning on the spot, being nudged by
// a mob — not travel.
const MIN_PROGRESS_BLOCKS = 0.6;
// Sprint the manual leg while there's room to; walking the last stretch of
// EVERY journey at 4.3 m/s instead of 5.6 is a tax on the whole run.
const SPRINT_ABOVE = 1.6;
/**
 * How long to hold a jump once committed to it.
 *
 * A Minecraft jump arc is roughly twelve ticks. Cancelling partway through
 * leaves the bot back on the block it started from, which is what produced
 * the reported "jumps on the current block like 15 times" — each attempt was
 * aborted by the tiny forward drift the jump itself created.
 */
const JUMP_HOLD_MS = 500;

function horizontalDistance(a, b) {
  const dx = a.x - b.x;
  const dz = a.z - b.z;
  return Math.sqrt(dx * dx + dz * dz);
}

/**
 * Navigation health, parked on the bot so `unstick` can see it.
 *
 * A bot can be completely unable to travel while standing somewhere that is
 * not enclosed at all — which is exactly the state the stuck-detector was
 * blind to, because it only ever asked "am I walled in?". Counting failed
 * legs gives it the other half of the question: "can I actually get
 * anywhere?".
 */
function noteNavResult(bot, ok) {
  const health = bot.navHealth || (bot.navHealth = { failures: 0, lastFailAt: 0, lastOkAt: 0 });
  if (ok) {
    health.failures = 0;
    health.lastOkAt = Date.now();
  } else {
    health.failures += 1;
    health.lastFailAt = Date.now();
  }
}

/**
 * Pathfinder is breaking or placing a block on the route.
 *
 * The bot stands still while it does, and every check in driveTo that reads
 * "not moving" as "stuck" then cancelled the path — and pathfinder's path
 * reset calls bot.stopDigging(), which wipes the crack on the server. The next
 * attempt dug the same block again from nothing. Reported exactly like that:
 * "at the last tick of mining that block it stops and then fully mines it
 * again", and only for some blocks — the slow ones. Deepslate, ore, anything
 * under a stone pickaxe: a dig longer than the 0.7s no-route grace, or two in
 * a column longer than the 3.5s one.
 */
function pathfinderWorking(bot) {
  try {
    return !!(bot.pathfinder?.isMining?.() || bot.pathfinder?.isBuilding?.());
  } catch {
    return false;
  }
}

function cancelPathing(bot) {
  try {
    // setGoal(null) resets the path and clears control states, but does NOT
    // go through stop()/fullStop() — verified against pathfinder's resetPath.
    bot.pathfinder.setGoal(null);
  } catch {
    // pathfinder may not be ready yet
  }
}

/** Walk the last short hop under our own control, so physics stays honest. */
async function walkTheLastBit(bot, target, task, arriveWithin) {
  const deadline = Date.now() + MANUAL_WALK_TIMEOUT_MS;
  let lastDistance = Infinity;
  let stuckSince = Date.now();
  let jumpUntil = 0;
  try {
    while (Date.now() < deadline) {
      if (task) task.throwIfAborted();
      const distance = horizontalDistance(bot.entity.position, target);
      if (distance <= arriveWithin) return;

      // The last two blocks of EVERY journey are walked by hand, at a sprint,
      // aimed at a point — with no idea what is between here and there. That
      // is how a bot ends a perfectly routed path by running off a cliff, and
      // the damage ledger has it: `killedBy: fall` on a bot that started the
      // drop at y=68. Pathfinder's maxDropDown never applied to this stretch
      // because pathfinder is no longer steering it.
      //
      // Stop rather than nudge: the caller re-checks whether it arrived, and
      // being two blocks short is recoverable in a way that a seven-block
      // drop onto a cave floor is not.
      if (stepWouldFall(bot, target)) {
        logger.info('Not walking the last bit — there is a drop or lava in the way', {
          target: target.floored(),
          from: bot.entity.position.floored(),
        });
        return;
      }

      await bot.lookAt(target.offset(0, 1.2, 0), false).catch(() => {});
      bot.setControlState('forward', true);
      // Sprinting is 30% faster and is what a player does; drop out of it on
      // the final approach so we don't overshoot the block we're aiming at.
      bot.setControlState('sprint', distance > SPRINT_ABOVE);

      // A one-block lip is the usual reason the last two blocks don't
      // happen, and it used to burn the entire timeout. Jumping clears it —
      // but only if the jump is allowed to FINISH.
      //
      // The obvious version cancels the jump the moment any progress appears,
      // and a jump makes progress immediately: the bot rises, drifts forward a
      // tenth of a block, the jump is cancelled, it drops back onto the step
      // it was trying to clear, and 350ms later it tries again. That is the
      // reported "jumps on the current block like 15 times and then proceeds
      // to jump on the higher block" — fifteen aborted jumps and one that
      // happened to be left alone long enough to land.
      //
      // Once committed, hold it for a full hop. A jump arc is about half a
      // second; anything shorter is not a jump, it is a twitch.
      if (Date.now() < jumpUntil) {
        bot.setControlState('jump', true);
      } else if (distance < lastDistance - 0.1) {
        lastDistance = distance;
        stuckSince = Date.now();
        bot.setControlState('jump', false);
      } else if (Date.now() - stuckSince > 350) {
        jumpUntil = Date.now() + JUMP_HOLD_MS;
        bot.setControlState('jump', true);
      }

      await sleep(POLL_MS, task);
    }
  } finally {
    bot.setControlState('forward', false);
    bot.setControlState('sprint', false);
    bot.setControlState('jump', false);
  }
}

/**
 * Move until `isSatisfied()` reports done.
 *
 * `target` is used for the close-range handover and for progress checks;
 * `isSatisfied` decides what "arrived" actually means for this goal type.
 */
async function driveTo(bot, {
  goal, target, isSatisfied, arriveWithin, timeoutMs = DEFAULT_TIMEOUT_MS, task, manualFinish = true,
}) {
  if (task) task.throwIfAborted();

  // Released in the finally. driveTo runs many times inside ONE task — a
  // strip mine is dozens of legs, retreatFrom tries three — and every leg that
  // kept its listener left a closure over the bot on that task until it ended,
  // then fired them all at once on abort. See Task.onAbort.
  const unwatchAbort = task ? task.onAbort(() => cancelPathing(bot)) : () => {};

  const deadline = Date.now() + timeoutMs;
  let lastProgressAt = Date.now();

  // Progress is measured from a moving ANCHOR, not from a best-ever distance.
  //
  // The old test was `distance < lastDistance - 0.4`, where lastDistance only
  // ever shrank. That made two entirely normal situations look identical to a
  // freeze: a detour (walking around a lake, a cliff or a tree puts the bot
  // FURTHER from the target for several seconds by design), and any slight
  // overshoot (after which no future distance could ever beat the record, so
  // the leg was doomed from that moment on). Both threw 'navigation stalled',
  // and with every leg failing the bot stood in one place while `wood`,
  // `mine` and `gatherStone` took turns discovering they couldn't move.
  //
  // Walking IS progress, whichever way it goes. Closing on the target is also
  // progress. Only doing neither, for several seconds, is a stall.
  let anchor = bot.entity.position.clone();
  let anchorDistance = target ? horizontalDistance(anchor, target) : Infinity;

  // mineflayer-pathfinder cannot report this itself: when getPathTo finds no
  // route it sets its internal pathUpdated flag and then returns early on
  // every subsequent tick forever — no event, no error, and its own 3.5s
  // stuck-detector sits below that early return so it never fires either. The
  // bot simply stands still until something else times out. The one signal it
  // does emit is this result object, so watch for it.
  //
  // 'noPath' does NOT mean "don't move": astar.js:121 returns the path to the
  // best node it found, so the bot still walks as close as it can get — which
  // is often close enough to satisfy the goal outright. So this doesn't abort
  // on the spot; it shortens the patience, and the ordinary progress check
  // below does the rest. 'timeout' is excluded deliberately for the same
  // reason (astar.js:74 also hands back a usable partial path) — treating it
  // as failure would abandon every leg that is merely long.
  // The manual finish is a one-shot. If it cannot close the gap — a drop in
  // the way, a lip it cannot clear — pathfinder gets the rest of the leg, and
  // re-entering the manual walk from the same spot would just repeat it.
  let handedOver = false;

  let unroutable = false;
  const onPathUpdate = (result) => {
    if (!result) return;
    if (result.status === 'noPath') unroutable = true;
    else if (result.status === 'success') unroutable = false;
  };
  bot.on('path_update', onPathUpdate);

  try {
    // Check BEFORE asking pathfinder for anything. Mining a vein and chopping
    // a trunk both call this repeatedly from a spot that already satisfies the
    // goal, and setting a goal kicks off an A* search that runs synchronously
    // on the event loop in 20ms slices. Cancelling it a moment later doesn't
    // give that time back — not starting it does.
    if (isSatisfied(bot)) {
      noteNavResult(bot, true);
      return;
    }

    bot.pathfinder.setGoal(goal, true); // dynamic: skips pathfinder's goal_reached handling

    while (true) {
      if (task) task.throwIfAborted();

      if (isSatisfied(bot)) {
        noteNavResult(bot, true);
        return;
      }

      if (Date.now() > deadline) throw new Error('navigation timed out');

      const pos = bot.entity.position;
      const distance = target ? horizontalDistance(pos, target) : null;

      // Not mid-dig: cancelling now throws the half-broken block away. The
      // handover waits a tick or two for the block to finish.
      if (target && manualFinish && !handedOver && distance <= HANDOVER_DISTANCE
        && !pathfinderWorking(bot)) {
        // Close enough — take over before pathfinder can finish the path
        // and trigger its position-snapping fullStop().
        handedOver = true;
        cancelPathing(bot);
        await walkTheLastBit(bot, target, task, arriveWithin ?? 1.0);

        // Arriving is not the same as having WALKED, and reporting success
        // unconditionally hid that. walkTheLastBit now refuses to cross a
        // drop, and it can also simply run out of its 2.5s budget against a
        // lip it cannot clear — in both cases the old code announced a
        // successful arrival from wherever it happened to be standing.
        if (isSatisfied(bot)) {
          noteNavResult(bot, true);
          return;
        }
        // Hand back to pathfinder for the rest. It can route around the drop,
        // step down it safely, or tell us there is no way — all of which are
        // better than claiming we are there. `handedOver` stops us bouncing
        // straight back into the manual walk and repeating this forever.
        bot.pathfinder.setGoal(goal, true);
        // Give it a clean slate to be judged on. The manual walk may have
        // spent a couple of seconds achieving nothing, and carrying that
        // against pathfinder would abandon the leg before it has taken a
        // single step.
        anchor = bot.entity.position.clone();
        anchorDistance = target ? horizontalDistance(anchor, target) : Infinity;
        lastProgressAt = Date.now();
      }

      // 3D on purpose. goToHeight has no target point at all and is satisfied
      // purely by climbing, so measuring travel horizontally would score a
      // bot going straight up a staircase as making no progress whatsoever
      // and abandon the leg 3.5 seconds in. Any real movement counts.
      const travelled = pos.distanceTo(anchor);
      const closedIn = distance !== null && distance <= anchorDistance - MIN_PROGRESS_BLOCKS;

      // Digging or building the route IS progress. The leg's own timeoutMs
      // still bounds the whole thing, so a dig that never ends cannot hold it.
      if (travelled >= MIN_PROGRESS_BLOCKS || closedIn || pathfinderWorking(bot)) {
        anchor = pos.clone();
        anchorDistance = distance ?? Infinity;
        lastProgressAt = Date.now();
      } else {
        // Once pathfinder has told us there is no route, a bot that has also
        // stopped moving is finished — it has walked as far toward the goal
        // as it ever will. No point spending the full grace period proving
        // it; the caller wants to blacklist this target and try another.
        const patience = unroutable ? NO_ROUTE_GRACE_MS : PROGRESS_GRACE_MS;
        if (Date.now() - lastProgressAt > patience) {
          throw new Error(unroutable ? 'no route' : 'navigation stalled');
        }
      }

      // Respect recoil: while being knocked back, stop steering so the
      // server's velocity actually moves us instead of being fought.
      if (bot.recoilUntil && Date.now() < bot.recoilUntil && !pathfinderWorking(bot)) {
        cancelPathing(bot);
        await sleep(POLL_MS, task);
        bot.pathfinder.setGoal(goal, true);
      }

      await sleep(POLL_MS, task);
    }
  } catch (err) {
    if (task && task.aborted) throw new AbortError(task.reason);

    // PATHFINDER CANNOT SWIM, so when the bot is in water, finish the leg by
    // hand rather than reporting the journey impossible.
    //
    // mineflayer-pathfinder's move generators bail on water in several places
    // ("dont go underwater", "cant jump from water"), so a bot that has waded
    // in — chasing a pig, fleeing a creeper, following a shoreline — gets 'no
    // route' for every destination on the far side, or even for one it could
    // reach with four strokes. Every behavior that needed to move then failed
    // in turn, which from the outside is a bot bobbing in a lake doing nothing.
    //
    // swimTo steers by looking, which is how the game actually moves a swimmer,
    // and it watches its own air — so this cannot turn a failed walk into a
    // drowning.
    if (target && bot.entity?.isInWater && !isInterruption(err)) {
      try {
        const arrived = await swimTo(bot, target, task, {
          within: arriveWithin ?? 1.2,
          timeoutMs: SWIM_LEG_MS,
        });
        if (arrived || isSatisfied(bot)) {
          noteNavResult(bot, true);
          return;
        }
      } catch (swimErr) {
        if (task && task.aborted) throw new AbortError(task.reason);
        if (isInterruption(swimErr)) throw swimErr;
      }
    }

    if (!isInterruption(err)) noteNavResult(bot, false);
    throw err;
  } finally {
    unwatchAbort();
    bot.removeListener('path_update', onPathUpdate);
    cancelPathing(bot);
    bot.clearControlStates();
  }
}

/**
 * Climb to roughly a given height, by any route pathfinder can find.
 *
 * A hungry bot underground is in real trouble: no animals spawn in its own
 * tunnels, so wandering horizontally at y=63 searches a volume that by
 * definition contains no food. Getting back to the surface is the whole
 * move, and "up" is the only part of it that matters — which is exactly
 * what GoalY expresses and what a point-to-point goal cannot.
 */
function goToHeight(bot, y, task, opts = {}) {
  return driveTo(bot, {
    goal: new goals.GoalY(y),
    target: null, // a height goal has no single point to walk at
    isSatisfied: (b) => b.entity.position.y >= y - 1,
    timeoutMs: 15000,
    manualFinish: false,
    task,
    ...opts,
  });
}

/** Walk to within `range` blocks of a position. */
function goNear(bot, pos, range, task, opts = {}) {
  const wanted = Math.max(range, 0.9);
  return driveTo(bot, {
    goal: new goals.GoalNear(pos.x, pos.y, pos.z, Math.max(range, 1)),
    target: pos,
    arriveWithin: wanted,
    isSatisfied: (b) => horizontalDistance(b.entity.position, pos) <= wanted
      && Math.abs(b.entity.position.y - pos.y) <= 3,
    task,
    ...opts,
  });
}

/**
 * Travel toward a heading — somewhere on the map, not a particular block.
 *
 * Every "walk off in some direction" leg in the bot (foraging, exploring, the
 * idle fallback) picked its destination as a point N blocks away AT THE BOT'S
 * OWN HEIGHT, then handed it to goNear — which only counts as arrived within
 * three blocks vertically. On flat ground that is harmless. On a hill it is a
 * point in the air over the valley, or inside the next hill, that no walk can
 * ever satisfy: every leg fails, the failures pile up on navHealth, and
 * `unstick` fires on a bot standing in open grass. Watched live: foraging on
 * a hillside at y=87, seven failed legs, "Stuck — getting out" twice in
 * twenty seconds with nothing around it but sky.
 *
 * The height of a direction is not a thing, so this goal does not have one.
 */
function goNearXZ(bot, pos, range, task, opts = {}) {
  const wanted = Math.max(range, 0.9);
  return driveTo(bot, {
    goal: new goals.GoalNearXZ(pos.x, pos.z, Math.max(range, 1)),
    target: pos,
    arriveWithin: wanted,
    isSatisfied: (b) => horizontalDistance(b.entity.position, pos) <= wanted,
    task,
    ...opts,
  });
}

/**
 * Walk to a block so it's reachable/interactable.
 *
 * `within` defaults to 4.2 — digging reach — which is right when all we want
 * is to break something. It is WRONG when we want what the block drops:
 * mining at the far edge of reach leaves the item three or four blocks away,
 * frequently on the other side of terrain the bot then can't walk through,
 * and it despawns there. Diagnostics showed eight drops spawn at 2.8–4.0
 * blocks and not one of them collected.
 *
 * Gathering behaviors pass a tighter `within` so the drop lands at the bot's
 * feet and is picked up automatically, the way it works for a player.
 */
function goToBlock(bot, block, task, opts = {}) {
  const { within = 4.2, ...rest } = opts;
  const p = block.position;
  const centre = p.offset(0.5, 0, 0.5);
  return driveTo(bot, {
    goal: new goals.GoalNear(p.x, p.y, p.z, within <= 2.5 ? 1 : 2),
    target: centre,
    arriveWithin: Math.min(1.8, within),
    isSatisfied: (b) => b.entity.position.distanceTo(p.offset(0.5, 0.5, 0.5)) <= within,
    task,
    ...rest,
  });
}

/**
 * Is it safe to put our feet here?
 *
 * Every manual step the bot takes — staircases, tunnels, strip mining,
 * escaping a pit, walking onto a drop — used to move blind. Pathfinder has
 * its own drop limits, but none of that applies when we drive the controls
 * ourselves, and the two things that kill a bot at depth are walking into
 * lava and walking off a ledge. Both are cheap to check first.
 */
const MAX_SAFE_DROP = 3;

function isLavaBlock(block) {
  return !!block && (block.name === 'lava' || block.name === 'flowing_lava');
}

/**
 * The block the bot is actually standing on.
 *
 * `position.floored().offset(0, -1, 0)` is the obvious way to ask this and it
 * is wrong roughly whenever the bot has just landed. A block at integer y
 * occupies [y, y+1), so a player on top of the block at y=83 has its feet at
 * y=84.0 and the arithmetic works — but the server routinely reports 83.99999
 * instead, which floors to 83 and makes the probe land on y=82: empty air one
 * block BELOW the floor.
 *
 * Caught live, and it was fatal. `shelter` refused to dig in at night with
 * "Not digging through that to shelter {block: air}", so a bot at 1 health
 * surrounded by zombies stood in the open instead of burrowing, and died.
 *
 * Scanning down from the feet cell handles both cases: at 84.0 the feet cell
 * is air and the next one down is the floor; at 83.99999 the feet cell IS the
 * floor. Two blocks of tolerance covers the rest without ever reaching past a
 * genuine drop.
 */
function groundUnder(bot) {
  const feet = bot.entity.position.floored();
  for (let dy = 0; dy <= 2; dy++) {
    const block = bot.blockAt(feet.offset(0, -dy, 0));
    if (block && block.boundingBox === 'block') return block;
  }
  return null;
}

/**
 * The integer cell the bot's feet occupy, immune to the same rounding.
 *
 * Anything reasoning about the shaft above the bot's head — sealing a shelter
 * roof, breaking back out of one — counts upward from here, so an off-by-one
 * aims a block at the bot's own head instead of at the hole. That is why
 * `shelter` dug itself in and then reported "Underground but not sealed"
 * while holding a stack of dirt: every placement was refused because the
 * target cell was the one the bot was standing in.
 */
function feetCell(bot) {
  const ground = groundUnder(bot);
  if (ground) return ground.position.offset(0, 1, 0);
  return bot.entity.position.floored();
}

function stepIsSafe(bot, pos) {
  // Lava at head or foot height, or immediately below.
  for (const off of [[0, 0, 0], [0, 1, 0], [0, -1, 0]]) {
    if (isLavaBlock(bot.blockAt(pos.offset(...off)))) return false;
  }

  // Solid ground within a survivable drop.
  for (let dy = 1; dy <= MAX_SAFE_DROP; dy++) {
    const under = bot.blockAt(pos.offset(0, -dy, 0));
    if (!under) return false;              // unloaded — assume the worst
    if (isLavaBlock(under)) return false;
    if (under.boundingBox === 'block') return true;
  }
  return false; // nothing solid within MAX_SAFE_DROP: that's a fall
}

/**
 * Walk one short hop under our own control, refusing unsafe destinations.
 *
 * Returns true if we actually moved. Pathfinder is deliberately not involved:
 * it routinely refuses single-block steps into freshly dug tunnels, which is
 * what made the bot dig a step and then stand in it forever.
 */
async function stepTo(bot, pos, task, { jump = false, ms = 350 } = {}) {
  if (!stepIsSafe(bot, pos)) return false;

  const before = bot.entity.position.clone();
  const target = pos.offset(0.5, 0.5, 0.5);

  // Poll for arrival instead of sleeping a fixed slice.
  //
  // One block at walking pace takes about 230ms; this used to hold forward
  // for 350ms and then sleep another 120 regardless, so every step cost
  // roughly double what it needed to. Tunnelling, strip mining and every
  // staircase are built out of these, and at 24 steps a run the waste was
  // measured in whole seconds per behavior — the single largest source of
  // the bot looking sluggish while it was working perfectly well.
  const deadline = Date.now() + ms;
  try {
    await bot.lookAt(target, true).catch(() => {});
    bot.setControlState('forward', true);
    if (jump) bot.setControlState('jump', true);

    // Horizontal only: stepping DOWN a staircase means the vertical gap
    // closes last, and waiting for it wastes the fall.
    const arrived = () => horizontalDistance(bot.entity.position, target) <= 0.45;
    if (typeof bot.on === 'function') {
      // On physics ticks, bounded in ticks as well as time: a step is a few
      // ticks of walking, and a busy event loop (or a physics simulation
      // running faster than real time) must not turn it into a sprint off
      // into the distance.
      await untilTick(bot, arrived, { maxTicks: Math.ceil(ms / 50), maxMs: ms + 500, task });
    } else {
      while (Date.now() < deadline) {
        await sleep(POLL_MS, task);
        if (arrived()) break;
      }
    }
  } finally {
    bot.setControlState('forward', false);
    bot.setControlState('jump', false);
  }
  // Just long enough to land and for the position to settle. One tick —
  // tunnelling, strip mining and every staircase are built out of these, so a
  // 30ms saving here is paid back twenty-four times in a single descent.
  if (typeof bot.on === 'function') await waitTicks(bot, 1, task);
  else await sleep(50, task);
  return bot.entity.position.distanceTo(before) > 0.3;
}

/**
 * Stand in the middle of the block we are on, so its column is the only one
 * holding us up.
 *
 * The player hitbox is 0.6 wide, so a bot more than 0.2 off-centre on either
 * axis overlaps the next column and is held up by it. Digging straight down
 * from there opens a hole the bot does not fall into: it stands on the rim,
 * `onGround` stays true, and everything that then looks for "the floor under
 * us" in our own column finds air. That is `shelter`'s "Cannot shelter — no
 * solid floor underneath {dug: 2}", still happening after a wait was added for
 * it, because the bot was never falling in the first place.
 *
 * Sneaking keeps the correction small (no overshoot at a tick's poll) and
 * cannot walk us off anything — the target is inside the block we are on, or,
 * if we are perched on a rim, directly over the hole we meant to drop into.
 */
const CENTRE_TOLERANCE = 0.2;
const CENTRE_TIMEOUT_MS = 900;

function offCentre(bot) {
  const p = bot.entity.position;
  const dx = p.x - (Math.floor(p.x) + 0.5);
  const dz = p.z - (Math.floor(p.z) + 0.5);
  return Math.max(Math.abs(dx), Math.abs(dz));
}

async function centreOnBlock(bot, task, cell = bot.entity.position.floored()) {
  if (offCentre(bot) <= CENTRE_TOLERANCE
    && Math.floor(bot.entity.position.x) === cell.x
    && Math.floor(bot.entity.position.z) === cell.z) return true;
  const target = new Vec3(cell.x + 0.5, bot.entity.position.y, cell.z + 0.5);
  const deadline = Date.now() + CENTRE_TIMEOUT_MS;
  try {
    bot.setControlState('sneak', true);
    while (Date.now() < deadline) {
      const p = bot.entity.position;
      if (Math.abs(p.x - target.x) <= CENTRE_TOLERANCE && Math.abs(p.z - target.z) <= CENTRE_TOLERANCE) {
        return true;
      }
      await bot.lookAt(target.offset(0, bot.entity.height ?? 1.62, 0), true).catch(() => {});
      bot.setControlState('forward', true);
      await sleep(POLL_MS, task);
    }
    return false;
  } finally {
    bot.setControlState('forward', false);
    bot.setControlState('sneak', false);
  }
}

/**
 * Move away from a threat. A single long path frequently fails outright in
 * awkward terrain, leaving the bot exactly where it started — so fall back
 * through progressively shorter hops until something works.
 */
/**
 * Straight away from the threat, unless straight away is off a ledge.
 *
 * Live on 09-25: the fall guard had just stopped the bot at the lip of a
 * drop, a zombie came into view, and the bot fled — directly away from it,
 * which was directly over that lip. It went from a standstill, so the guard's
 * velocity look-ahead had nothing to read until the bot was already over:
 * "Took avoidable damage {cause: fall, lost: 11, fellBlocks: 14}", and a
 * creeper finished it at the bottom. Fleeing a zombie cost the run.
 *
 * A player veers. Try the direct heading, then 45 and 90 degrees either side,
 * and take the first whose opening steps stay on the ground. If none does,
 * there is no retreat at this range; standing and fighting on solid ground
 * beats a fourteen-block drop with the mob still up top.
 */
const RETREAT_TURNS = [0, Math.PI / 4, -Math.PI / 4, Math.PI / 2, -Math.PI / 2];

function safeRetreatTarget(bot, dir, dist) {
  for (const turn of RETREAT_TURNS) {
    const cos = Math.cos(turn);
    const sin = Math.sin(turn);
    const heading = new Vec3(dir.x * cos - dir.z * sin, 0, dir.x * sin + dir.z * cos);
    const target = bot.entity.position.plus(heading.scaled(dist));
    if (!stepWouldFall(bot, target)) return target;
  }
  return null;
}

async function retreatFrom(bot, threatPos, distances, task) {
  // NOTE: vec3's normalize() mutates in place and returns `this` (unlike
  // scaled(), which returns a new vector). Safe here only because minus()
  // already handed us a throwaway — never call it on a live entity position.
  const away = bot.entity.position.minus(threatPos);

  // Flatten to horizontal FIRST. Retreat is a walk, and you cannot walk
  // upwards away from something — but the vector maths doesn't know that.
  // With a mob in a cave below (or on a ledge above) the difference is
  // almost entirely vertical, so normalising in 3D produced a retreat target
  // at essentially our own feet: goNear reported "arrived" instantly, flee
  // returned success, and the director immediately re-ran threat. Observed
  // live as four "Fleeing" lines inside one second with the bot's position
  // frozen to the decimal while a creeper closed in.
  away.y = 0;
  if (away.norm() < 0.01) {
    // Directly above, below, or exactly on top of us — any horizontal
    // direction is as good as another, so commit to one.
    const angle = Math.random() * Math.PI * 2;
    away.x = Math.cos(angle);
    away.z = Math.sin(angle);
  }
  const dir = away.normalize();

  const startedAt = bot.entity.position.clone();
  for (const dist of distances) {
    if (task) task.throwIfAborted();
    const target = safeRetreatTarget(bot, dir, dist);
    if (!target) continue; // every way out at this range starts with a fall
    try {
      // A DIRECTION, not a place — the same mistake goNearXZ was written for.
      // The retreat point sits at the bot's own height, which on a hillside
      // is in the air over the slope or inside the rise, and goNear refuses
      // to call that arrived until it is within three blocks vertically. Every
      // hop of a flee on uneven ground then ran its whole six seconds out, with
      // something chasing us, before failing over to a shorter one.
      await goNearXZ(bot, target, 2, task, { timeoutMs: 6000 });
      // "Arrived" without having moved is not an escape. Treat it as a
      // failed hop so we try a different distance instead of reporting
      // success and being handed the same situation again.
      if (horizontalDistance(bot.entity.position, startedAt) >= 1.5) return true;
    } catch (err) {
      if (isInterruption(err)) throw err;
      // try a shorter hop
    }
  }
  return false;
}

// goFollow used to live here for chasing animals; mineflayer-pvp does the
// pursuing now, for both fighting and hunting, so it was dead weight.
module.exports = {
  goNear, goNearXZ, goToBlock, goToHeight, retreatFrom, safeRetreatTarget, stepTo, stepIsSafe,
  groundUnder, feetCell, goals, centreOnBlock, offCentre,
};
