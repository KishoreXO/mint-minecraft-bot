const Vec3 = require('vec3');
const logger = require('../logger');
const { isHostileMob } = require('../entities');
const { escapeHazard, escapeDrowning } = require('../behaviors/survive');
const { walkingIntoAFall } = require('../falls');

/**
 * The reflex layer: tick-level trip-wires, bound to physicsTick.
 *
 * Three of the four conditions this covers already have a tuned, live-tested
 * implementation, at the TOP of director.js's priority list: escapeHazard
 * (97), escapeDrowning (95), defend (94). Those stay exactly as they are —
 * this layer does not re-fight lava, water or mobs, it just notices sooner.
 *
 * director's own supervisor polls on a setInterval every 60ms, which drifts
 * under event-loop lag — this project's own logs carry repeated "Event loop
 * stalled" warnings, at the exact moments a reflex matters most.
 * bot.physicsTick fires once per server tick (50ms), driven by the server
 * rather than a JS timer, and is mineflayer's own hook for "must not be
 * late". Hooking these checks to it and running the director's preemption
 * check the instant one trips shaves the scheduling gap down without touching
 * the logic that actually resolves each case — see hurryArbitration for why
 * it asks rather than aborting.
 *
 * The one genuinely NEW behavior is the void/large-drop reflex placing a
 * block underfoot — src/falls.js's watchdog only ever clears movement
 * controls; it has never been able to catch a fall, only refuse to start one.
 */

const HOSTILE_REFLEX_RANGE = 3;
const HOSTILE_REFLEX_COOLDOWN_MS = 500; // let the hand-off it triggers actually take effect
const LOW_HEALTH_REFLEX = 6; // out of 20
const LOW_HEALTH_HOSTILE_RANGE = 12;
const VOID_PLACE_COOLDOWN_MS = 1500;
const VOID_PROBE_DEPTH = 24; // deeper than this and it isn't an ordinary ledge

const SCAFFOLD_BLOCKS = ['cobblestone', 'dirt', 'netherrack', 'cobbled_deepslate', 'stone'];

function nearestHostileWithin(bot, range) {
  const me = bot.entity?.position;
  if (!me) return null;
  let nearest = null;
  let nearestDist = Infinity;
  for (const id of Object.keys(bot.entities)) {
    const e = bot.entities[id];
    if (!e || e === bot.entity || !isHostileMob(e)) continue;
    const d = me.distanceTo(e.position);
    if (d <= range && d < nearestDist) {
      nearest = e;
      nearestDist = d;
    }
  }
  return nearest;
}

/** Is there anything solid (or water) within `maxDepth` blocks straight down? */
function hasGroundBelow(bot, maxDepth) {
  const pos = bot.entity.position.floored();
  for (let dy = 1; dy <= maxDepth; dy++) {
    const block = bot.blockAt(pos.offset(0, -dy, 0));
    if (!block) return true; // unloaded chunk — not this layer's business
    if (block.name === 'water' || block.name === 'flowing_water') return true;
    if (block.boundingBox === 'block') return true;
  }
  return false;
}

function placeableBlock(bot) {
  return bot.inventory.items().find((item) => item.name.endsWith('_planks')
    || SCAFFOLD_BLOCKS.includes(item.name));
}

/**
 * Hurry the director's own arbitration. Never abort blindly.
 *
 * This used to abort `ctx.currentTask` outright, whatever it was. But every
 * condition below already has an OWNER in the behavior list — escapeHazard
 * owns lava, escapeDrowning owns air, defend owns a hostile in reach — so the
 * task the reflex most often aborted was that owner, in the middle of the
 * very job the reflex had noticed:
 *
 *   - standing in lava, escapeHazard was restarted every 50ms until it died
 *     of it, and each restart of escapeDrowning re-ran the air-pocket scan
 *   - the melee standoff is 2.65–2.85 blocks, inside the three-block
 *     trip-wire, so every fight was torn down and re-engaged twice a second
 *   - at six health with anything inside twelve blocks, EVERY task was
 *     aborted on EVERY tick, fleeing and fighting included — a bot frozen at
 *     exactly the moment it most needed to act
 *
 * None of that showed up in a log, because no fight had happened since the
 * layer went in. It is visible in the code, and in what the code would do.
 *
 * The reflex's stated job was only ever to notice SOONER than the supervisor's
 * 60ms poll. So it now asks the supervisor's own question on the physics tick
 * — does anything that outranks what is running want the wheel? — through the
 * hook director.js leaves on ctx. When the owner is already running the answer
 * is no and nothing happens; when it is not, the owner gets the wheel a tick
 * earlier. That is the whole of what this layer was for.
 */
function hurryArbitration(ctx, reason) {
  if (typeof ctx.requestPreemptionCheck !== 'function') return; // no director running
  ctx.requestPreemptionCheck(`reflex:${reason}`);
}

/**
 * The one reflex that acts instead of arbitrating.
 *
 * Nothing in the behavior list owns "about to walk off into a void", so there
 * is no arbitration to hurry: whatever is steering is the problem, and it is
 * stopped here while a block goes down underfoot.
 */
function stopForVoid(bot, ctx) {
  try {
    bot.pathfinder?.stop();
  } catch {
    // pathfinder may be gone if we're mid-disconnect
  }
  if (ctx.currentTask && !ctx.currentTask.aborted) {
    ctx.currentTask.abort('reflex:void');
  }
}

function installReflexLayer(bot, ctx) {
  let lastVoidPlaceAt = 0;
  let lastHostileReflexAt = 0;
  let lastLowHealthReflexAt = 0;

  const onTick = () => {
    if (!ctx.connected || !bot.entity || bot.health <= 0) return;

    // 1. Hazard: lava, fire, suffocation.
    if (escapeHazard.shouldRun(bot)) {
      hurryArbitration(ctx, 'hazard');
      return;
    }

    // 2. Drowning.
    if (escapeDrowning.shouldRun(bot, ctx)) {
      hurryArbitration(ctx, 'drowning');
      return;
    }

    // 3. A real void, not the ordinary ledge falls.js already stops the bot
    // at — nothing to land on within VOID_PROBE_DEPTH blocks. Catch it.
    if (walkingIntoAFall(bot)
      && !hasGroundBelow(bot, VOID_PROBE_DEPTH)
      && Date.now() - lastVoidPlaceAt > VOID_PLACE_COOLDOWN_MS) {
      const block = placeableBlock(bot);
      if (block) {
        lastVoidPlaceAt = Date.now();
        stopForVoid(bot, ctx);
        bot.clearControlStates();
        logger.warn('Reflex: bridging an open drop underfoot', {
          at: bot.entity.position.floored(),
        });
        const below = bot.blockAt(bot.entity.position.offset(0, -1, 0));
        bot.equip(block, 'hand')
          .then(() => (below ? bot.placeBlock(below, new Vec3(0, 1, 0)) : null))
          .catch(() => {
            // Missed the placement window. The ledge watchdog still has the
            // controls cleared for this tick, which is the fallback.
          });
        return;
      }
    }

    // 4. A hostile already inside melee range, right now. director's
    // defend/threat own the actual fight-or-flee judgement (line-of-sight,
    // per-mob tactics — see tactics.js); this only gets them the wheel
    // faster when something is already close enough to hit us.
    if (nearestHostileWithin(bot, HOSTILE_REFLEX_RANGE)
      && Date.now() - lastHostileReflexAt > HOSTILE_REFLEX_COOLDOWN_MS) {
      lastHostileReflexAt = Date.now();
      hurryArbitration(ctx, 'hostile-adjacent');
      return;
    }

    // 5. Critically low health with something already nearby. Eating is
    // mineflayer-auto-eat's job (see eating.js) and runs on its own clock;
    // this is the "or flee" half of the reflex — get the hand-off to defend
    // or threat a tick sooner than the supervisor would.
    //
    // Same cooldown as the hostile reflex. This one had none, and while it
    // aborted blindly that meant every task, every tick, for as long as the
    // bot stayed hurt. Asking the arbitration question twenty times a second
    // is merely wasteful rather than paralysing, but it is still twenty times
    // more than an answer that changes on the scale of seconds needs.
    if ((bot.health ?? 20) <= LOW_HEALTH_REFLEX
      && Date.now() - lastLowHealthReflexAt > HOSTILE_REFLEX_COOLDOWN_MS
      && nearestHostileWithin(bot, LOW_HEALTH_HOSTILE_RANGE)) {
      lastLowHealthReflexAt = Date.now();
      hurryArbitration(ctx, 'low-health');
    }
  };

  bot.on('physicsTick', onTick);
  return () => bot.removeListener('physicsTick', onTick);
}

module.exports = {
  installReflexLayer,
  // Exported for the tests — the pure checks are what's worth testing here;
  // the physicsTick wiring itself needs a live bot.
  nearestHostileWithin,
  hasGroundBelow,
  placeableBlock,
};
