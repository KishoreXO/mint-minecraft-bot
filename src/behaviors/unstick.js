const logger = require('../logger');
const { isInterruption, waitTicks } = require('../task');
const {
  digBlock, pillarItem, jumpAndPlaceBelow, landed, PILLAR_MATERIAL,
} = require('../inventory');
const { stepTo, groundUnder, feetCell } = require('../nav');

/**
 * Last-resort recovery for a bot that has stopped getting anywhere.
 *
 * This exists because a stuck bot is indistinguishable from a broken one:
 * it was found at the bottom of its own mineshaft cycling through compass
 * headings forever, unable to climb out. Nothing else in the behavior set
 * could notice, because every individual behavior was "working" — they just
 * couldn't move.
 *
 * Detection is deliberately position-based rather than trusting any
 * behavior to report failure.
 */

const STUCK_CHECK_RADIUS = 3;      // moved less than this counts as stuck
// 25s was a long time to watch a bot do nothing, and everything that
// legitimately stands still is already excluded by name below.
const STUCK_AFTER_MS = 15000;
const MAX_PILLAR_STEPS = 28;
const CLEAR_ABOVE_NEEDED = 4;      // this much open air overhead = we're out

/**
 * Consecutive failed navigation legs that mean "this bot cannot travel".
 *
 * Being walled in is only ONE way to be stuck, and it turned out to be the
 * rarer one. The bot was found frozen at a single coordinate for minutes in
 * open ground: every leg `wood`, `mine` and `gatherStone` attempted failed,
 * they took turns failing, and because there was walkable floor all around it
 * `isConfined` said everything was fine — so the one behavior that could have
 * helped never ran. nav.js now counts failed legs on bot.navHealth, which
 * makes that state visible.
 */
const NAV_FAILURES_STUCK = 3;
const NAV_FAILURE_FRESH_MS = 20000;

const DIGGABLE_ESCAPE = new Set([
  'dirt', 'grass_block', 'coarse_dirt', 'rooted_dirt', 'podzol', 'mycelium',
  'sand', 'sandstone', 'gravel', 'clay', 'stone', 'cobblestone', 'deepslate',
  'cobbled_deepslate', 'andesite', 'granite', 'diorite', 'tuff', 'snow_block',
  'snow', 'moss_block', 'mud', 'packed_mud',
]);

/**
 * Only dig through what the tools we CARRY can break quickly.
 *
 * DIGGABLE_ESCAPE says stone and deepslate are fine to cut through, and with a
 * pickaxe they are. Without one, stone is seven and a half seconds a block by
 * hand and deepslate far longer — and a staircase escape is up to twenty-eight
 * steps of two blocks each. The logs show exactly that: unstick cut off by the
 * sixty-second deadlock breaker twice running, on a bot with `pick: none`,
 * starving, while forage waited behind it. Digging that slowly is not an
 * escape, it is the bot standing still with its arm moving.
 *
 * So ask the game how long the block takes with the best thing in the bag,
 * and treat anything slower than this as a wall.
 */
const ESCAPE_DIG_MAX_MS = 2500;

function bestDigTime(bot, block) {
  if (typeof block.digTime !== 'function') return 0; // not a real block — let it through
  let best = block.digTime(null, false, false, false);
  for (const item of bot.inventory?.items?.() ?? []) {
    const t = block.digTime(item.type, false, false, false);
    if (t < best) best = t;
  }
  return best;
}

function canDigThrough(bot, block) {
  if (!DIGGABLE_ESCAPE.has(block.name) && !isSoftObstruction(block)) return false;
  return bestDigTime(bot, block) <= ESCAPE_DIG_MAX_MS;
}

/**
 * The one block over our head is a different question from a tunnel.
 *
 * ESCAPE_DIG_MAX_MS bounds an escape made of dozens of digs; a lid is a single
 * block, and ten seconds of punching is a small price for the only way out.
 * It also has to cover what the bot BUILDS with, not only what the ground is
 * made of: shelter seals its shaft with whatever it holds, planks included.
 *
 * Live on 09-25, peeked at directly: the bot two blocks down its own shelter,
 * stone on all four sides, one jungle_planks lid, open sky above it — and
 * "Blocked overhead by something we cannot dig {jungle_planks}" every twenty
 * seconds for five minutes. Pathfinder would not break it either (water beside
 * it, and it will not open a flow), and a restart had wiped shelter's own
 * memory of the lid it meant to take off in the morning.
 */
const LID_DIG_MAX_MS = 12000;

function canBreakLid(bot, block) {
  const buildable = PILLAR_MATERIAL.has(block.name) || /_(planks|log|wood)$/.test(block.name);
  if (!buildable && !DIGGABLE_ESCAPE.has(block.name) && !isSoftObstruction(block)) return false;
  return bestDigTime(bot, block) <= LID_DIG_MAX_MS;
}

/**
 * Behaviors during which standing still is the correct thing to be doing.
 *
 * Without this the stuck-detector fires on a bot that's perfectly fine:
 * crafting and smelting park it in one place for a while, and it would try
 * to dig its way out of a situation it wasn't in.
 *
 * Three entries are deliberately ABSENT, each for a reason learned the hard
 * way:
 *
 *  - 'threat': combat moves — it closes, strafes and retreats. A fight where
 *    the bot hasn't moved for 25 seconds isn't a fight, it's a bot sealed in
 *    a pocket swinging at mobs it can't reach while they can't reach it.
 *    Observed live as 90 unbroken seconds at one coordinate.
 *  - 'idle': the fallback used to stand and turn on the spot, so listing it
 *    was right. It now WALKS, so a bot that falls back to idle and fails to
 *    move is a bot that is genuinely trapped — and listing it here reset the
 *    stuck-watch on every attempt, meaning unstick could never fire. That is
 *    the trap the bot starved to death in.
 *  - 'explore': same reasoning; its whole job is covering ground.
 *
 * 'shelter' and 'bed' ARE here and matter most: they deliberately sit still
 * (sealed in a hole, or asleep) and without them unstick outranks both and
 * digs the bot straight back up into whatever it was hiding from.
 */
const STATIONARY_BEHAVIORS = new Set([
  'smelt', 'gear', 'tidy', 'unstick', 'shelter', 'bed',
]);

/**
 * Undergrowth: breakable in a fraction of a second and never worth respecting
 * as a wall.
 *
 * Anchored at the END of the name on purpose. The previous pattern tested for
 * `grass` anywhere, which also matched `grass_block` — ordinary ground, and
 * the single most common block the bot stands on. It is diggable either way
 * (DIGGABLE_ESCAPE lists it), so nothing broke, but calling the floor "soft
 * undergrowth" meant the clearing pass would happily chew through solid
 * terrain it had no reason to touch.
 */
function isSoftObstruction(block) {
  return /(_leaves|_sapling|vines?|grass|fern|snow|moss_carpet)$/.test(block.name);
}

/**
 * Is the bot actually walled in, as opposed to merely standing still?
 *
 * Checks the eight positions it could step to. If any is walkable — floor
 * underfoot, two blocks of clearance — the bot can leave under its own power
 * and does not need to tunnel out of anything.
 */
/**
 * Liquids read as "empty" to the block model, which is a trap here.
 *
 * `boundingBox === 'empty'` is how we ask "could the bot's body be in this
 * cell", and for lava the answer is technically yes and practically fatal.
 * Checking only the block UNDERFOOT for lava (which is what this used to do)
 * missed it entirely, because lava is never a 'block' bounding box — so that
 * test could never fire, while the cell the bot would actually stand IN went
 * unchecked. A pocket whose only opening was a lava pool therefore counted as
 * "not confined", and the bot was left to walk into it.
 */
function isStandableSpace(block) {
  return !!block
    && block.boundingBox === 'empty'
    && block.name !== 'lava'
    && block.name !== 'flowing_lava'
    && block.name !== 'water'
    && block.name !== 'flowing_water';
}

/**
 * Cached for a fraction of a second, because of who asks and how often.
 *
 * `unstick.shouldRun` is evaluated by the director's supervisor every 60ms —
 * it sits above the interrupt floor — and this walks twenty-four block reads
 * every time. That is four hundred block lookups a second, each one
 * constructing a Block object, purely to answer a question whose answer
 * cannot change while the bot is standing still. And standing still is the
 * only situation in which it is asked.
 */
const CONFINED_CACHE_MS = 400;

function isConfined(bot) {
  const now = Date.now();
  const cached = bot._confinedCache;
  if (cached
    && now - cached.at < CONFINED_CACHE_MS
    && bot.entity.position.distanceTo(cached.from) < 1) {
    return cached.value;
  }
  const value = probeConfinement(bot);
  bot._confinedCache = { at: now, from: bot.entity.position.clone(), value };
  return value;
}

function probeConfinement(bot) {
  const feet = feetCell(bot);
  const around = [
    [1, 0], [-1, 0], [0, 1], [0, -1],
    [1, 1], [1, -1], [-1, 1], [-1, -1],
  ];

  for (const [dx, dz] of around) {
    // Allow a step up or down as well as level ground.
    for (const dy of [0, 1, -1]) {
      const at = bot.blockAt(feet.offset(dx, dy, dz));
      const head = bot.blockAt(feet.offset(dx, dy + 1, dz));
      const under = bot.blockAt(feet.offset(dx, dy - 1, dz));
      if (!at || !head || !under) continue;
      if (isStandableSpace(at)
        && isStandableSpace(head)
        && under.boundingBox === 'block') {
        return false; // somewhere to walk — not confined
      }
    }
  }
  return true;
}

/**
 * Break the soft stuff packed around us — which in practice means LEAVES.
 *
 * Reported directly: "he got boxed by tree leaves and he didn't do anything."
 * A canopy encloses the bot on every side with blocks that are individually
 * trivial to break (leaves have hardness 0.2 and come off in a fraction of a
 * second by hand), but while pathfinder could not dig, they formed a wall it
 * had no move for — so it stood inside the tree until something killed it.
 *
 * Pathfinder can dig again, which fixes the common case. This runs first
 * anyway, because it is cheap, it cannot fail dangerously, and it turns the
 * most likely trap into open air before any of the expensive escapes are
 * attempted. Vines, tall grass, saplings and snow layers all qualify too.
 */
async function clearSoftObstructions(bot, task) {
  const feet = feetCell(bot);
  let broken = 0;

  for (let dy = 0; dy <= 2; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      for (let dz = -1; dz <= 1; dz++) {
        // Skip the two cells our own body occupies; they are air by
        // definition and blockAt on them tells us nothing.
        if (dx === 0 && dz === 0 && dy < 2) continue;
        task.throwIfAborted();

        const block = bot.blockAt(feet.offset(dx, dy, dz));
        if (!block || block.boundingBox === 'empty') continue;
        if (!isSoftObstruction(block)) continue;
        if (await digBlock(bot, block, task)) broken++;
      }
    }
  }

  if (broken > 0) logger.action('Cut through the undergrowth', { blocks: broken });
  return broken;
}

function shuffled(list) {
  const out = [...list];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/**
 * Shoulder our way out sideways, without asking pathfinder.
 *
 * Deliberately manual. The situation this runs in is precisely the one where
 * pathfinder has given up — it has decided there is no route and gone quiet —
 * so handing the problem back to it achieves nothing. Walking one block at a
 * time, breaking what is directly in the way, needs no route at all.
 *
 * stepTo refuses lava and anything that would be a fall, so "barge" only ever
 * means through terrain, never off a ledge.
 */
const BARGE_HEADINGS = [
  [1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1],
];

/**
 * Moving is not the same as leaving.
 *
 * 09-26: walled in at the bottom of a flooded ravine, a shove moved the bot a
 * block and a bit along the water, "Shoved my way out" was logged, and unstick
 * returned — without ever reaching pillarOut, the one escape that had actually
 * worked there (fourteen blocks, twenty minutes earlier). Water is never
 * somewhere to stand, so down there every cell is still "walled in". When the
 * bot started walled in, a shove only counts if it is not walled in any more.
 */
async function bargeOut(bot, task, { walledIn = false } = {}) {
  const start = bot.entity.position.clone();

  for (const [dx, dz] of shuffled(BARGE_HEADINGS)) {
    task.throwIfAborted();
    const feet = feetCell(bot);

    // Clear body and head height in that direction, but only things we're
    // willing to break — never a chest, never bedrock, never an ore vein.
    for (const dy of [0, 1]) {
      const block = bot.blockAt(feet.offset(dx, dy, dz));
      if (!block || block.boundingBox === 'empty') continue;
      if (!canDigThrough(bot, block)) break;
      await digBlock(bot, block, task);
    }

    await stepTo(bot, feet.offset(dx, 0, dz), task, { ms: 500 });
    if (bot.entity.position.distanceTo(start) > 1.2) {
      if (walledIn && probeConfinement(bot)) {
        logger.info('Shoved along, but still walled in', { heading: [dx, dz] });
        return false;
      }
      logger.action('Shoved my way out', { heading: [dx, dz] });
      return true;
    }
  }
  return false;
}

/** Is there enough open air above us to call ourselves out in the open? */
function hasClearSkyAbove(bot) {
  const feet = feetCell(bot);
  for (let dy = 2; dy <= CLEAR_ABOVE_NEEDED + 1; dy++) {
    const block = bot.blockAt(feet.offset(0, dy, 0));
    if (block && block.boundingBox === 'block') return false;
  }
  return true;
}

/**
 * Pillar straight up out of a hole, placing a block underfoot each jump.
 *
 * This is what a player does, and it's far more reliable than trying to cut
 * a staircase up through solid rock — the bot was found 17 blocks down, and
 * a staircase escape would need dozens of successful digs in a row, any one
 * of which failing leaves it stuck. Pillaring only needs blocks, which it
 * has plenty of after any mining session.
 */
/**
 * Cut a staircase upward and walk out.
 *
 * The bot's own mining leaves it at the bottom of pits, and pillaring needs
 * blocks it does not always have — "out of blocks to pillar with" was a dead
 * end that left it trapped, which is how it ended up standing still long
 * enough to starve to death. A pickaxe is one thing it always has, so
 * carving steps is the escape that can't run out of materials.
 */
async function digOutUpward(bot, task, { heading: forced = null, done = null } = {}) {
  const startY = bot.entity.position.y;
  const options = [[1, 0], [-1, 0], [0, 1], [0, -1]];
  let heading = forced ?? options[Math.floor(Math.random() * options.length)];

  for (let step = 0; step < MAX_PILLAR_STEPS; step++) {
    task.throwIfAborted();
    const feet = feetCell(bot);
    const [dx, dz] = heading;

    // A step up is: the block ahead at head height, the one above it, and
    // the one we'll stand on top of.
    const ahead = feet.offset(dx, 1, dz);
    const aheadHead = feet.offset(dx, 2, dz);

    let blocked = false;
    for (const pos of [ahead, aheadHead]) {
      const block = bot.blockAt(pos);
      if (!block || block.boundingBox === 'empty') continue;
      if (!canDigThrough(bot, block)) {
        heading = [-dz, dx]; // turn and try another wall
        blocked = true;
        break;
      }
      if (!(await digBlock(bot, block, task))) {
        heading = [-dz, dx];
        blocked = true;
        break;
      }
    }
    if (blocked) continue;

    // Jump up onto the step we just cut. In ticks: a jump is eight of them,
    // and a wall-clock sleep over- or under-shoots it whenever the event loop
    // is busy.
    try {
      await bot.lookAt(ahead.offset(0.5, 0.5, 0.5), true);
      bot.setControlState('forward', true);
      bot.setControlState('jump', true);
      await waitTicks(bot, 8, task);
    } finally {
      bot.setControlState('jump', false);
      bot.setControlState('forward', false);
    }
    await waitTicks(bot, 3, task);

    if (done && done(bot)) {
      logger.action('Cut my way out', { risenBy: Math.round(bot.entity.position.y - startY) });
      return true;
    }
    if (!done && bot.entity.position.y - startY >= 2 && hasClearSkyAbove(bot)) {
      logger.action('Cut my way out', { risenBy: Math.round(bot.entity.position.y - startY) });
      return true;
    }
  }
  return bot.entity.position.y > startY + 1;
}

/**
 * Steps in a row that gain nothing before pillaring is given up as futile.
 *
 * A failed placement is worth one retry — a jump mistimed, a block that did
 * not arrive — but not twenty-eight. Twenty-eight futile steps are the whole
 * sixty-second budget, and that is how the bot spent its first minute of
 * 09-24 floating in a flooded staircase: the director cut unstick off with
 * nothing logged, then benched it, and the only thing that finally worked,
 * barging sideways, had to wait for the next turn.
 */
const FUTILE_PILLAR_STEPS = 3;

async function pillarOut(bot, task, { done = null, fallbackHeading = null } = {}) {
  const startY = bot.entity.position.y;
  let futile = 0;

  for (let step = 0; step < MAX_PILLAR_STEPS; step++) {
    const stepStartY = bot.entity.position.y;
    task.throwIfAborted();
    // feetCell and groundUnder below read the cell the bot is in, which in
    // mid-air is whichever one it is falling past. See jumpAndPlaceBelow.
    await landed(bot, task);

    // Clear anything directly overhead first, or we can't rise.
    // feetCell, not a raw float offset — blockAt floors what it is given, so
    // at y=83.99999 this probed the bot's own head cell (air, so "nothing
    // overhead") while the real obstruction sat one block higher and stopped
    // every pillar attempt.
    const head = bot.blockAt(feetCell(bot).offset(0, 2, 0));
    if (head && head.boundingBox === 'block') {
      // The lid allowance is for the FIRST block only. Past it, this is a
      // climb through the ground, and a slow block every step is exactly the
      // sixty-second overrun canDigThrough exists to prevent.
      const mayBreak = step === 0 ? canBreakLid : canDigThrough;
      if (!mayBreak(bot, head)) {
        logger.warn('Blocked overhead by something we cannot dig', {
          block: head.name,
          digMs: Math.round(bestDigTime(bot, head)),
        });
        return false;
      }
      if (!(await digBlock(bot, head, task))) return false;
    }

    // PILLAR_MATERIAL, not a fourth private copy of the same list. This file,
    // shelter.js, threat.js and inventory.js each carried one, and they had
    // drifted — this one was missing sandstone and blackstone, so a bot in a
    // desert or the deepslate layer with a full inventory of exactly those
    // reported "no blocks to pillar with" and fell back to cutting a
    // staircase out of solid rock.
    const filler = pillarItem(bot);
    if (!filler) {
      logger.info('No blocks to pillar with — cutting a staircase out instead', {
        risenBy: Math.round(bot.entity.position.y - startY),
      });
      return digOutUpward(bot, task, { done, heading: fallbackHeading });
    }

    // Not position.offset(0, -1, 0): that is a float position, and blockAt
    // floors it — so a bot standing at y=83.99999 probed y=82, found air, and
    // gave up on pillaring out of the hole it was trapped in.
    const standingOn = groundUnder(bot);
    if (!standingOn) return false;

    try {
      // A failed placement isn't fatal; try again next step. What IS fatal
      // is a placement that never resolves, which would freeze the bot in
      // the pit this is trying to escape — hence the deadline inside.
      await jumpAndPlaceBelow(bot, standingOn, filler, task);
    } catch (err) {
      if (isInterruption(err)) throw err;
    }

    await landed(bot, task);

    // Once we're in the open with real headroom, we're free — or, when the
    // caller knows better what "out" means, when it says so. Clear sky is
    // true two blocks up an open ravine; out is the rim.
    if (done ? done(bot) : (bot.entity.position.y - startY >= 2 && hasClearSkyAbove(bot))) {
      logger.action('Pillared clear', { risenBy: Math.round(bot.entity.position.y - startY) });
      return true;
    }

    futile = bot.entity.position.y - stepStartY < 0.5 ? futile + 1 : 0;
    if (futile >= FUTILE_PILLAR_STEPS) {
      logger.info('Pillaring is getting nowhere — giving up on it', {
        risenBy: Math.round(bot.entity.position.y - startY),
        inWater: !!bot.entity.isInWater,
      });
      break;
    }
  }
  return bot.entity.position.y > startY + 1;
}

const unstick = {
  name: 'unstick',
  // Above combat, sheltering and sleeping on purpose. A bot that cannot move
  // cannot fight, cannot dig in and cannot place a bed either, and combat
  // outranking this caused a deadlock: trapped in a mineshaft, it kept
  // "engaging" a creeper 12 blocks away that it had no route to, re-attempting
  // every 12 seconds and never once getting to dig itself out.
  priority: 93,
  shouldRun(bot, ctx) {
    const now = Date.now();
    const pos = bot.entity.position;

    // SEALED IN ON PURPOSE IS NOT STUCK.
    //
    // `shelter` digs three blocks down and puts a lid on, which is a bot with
    // solid blocks on all six sides — the exact thing isConfined() below is
    // written to detect. Sitting one priority above it, this preempted the
    // shelter, broke the roof open, and handed the wheel back to shelter, which
    // sealed it again. All night. That is the "breaking and placing a dirt
    // block 20 times in the same place for no reason" that was reported: one
    // dirt block, two behaviors, and no way for either to know the other
    // disagreed about what the hole was for.
    //
    // Deliberately conditional on shelter being the thing currently RUNNING, so
    // the flag cannot strand the bot: the moment shelter is done, finished or
    // preempted, this goes back to watching normally and will happily dig out a
    // roof that was left behind.
    if (ctx.shelter?.sealedIn && ctx.currentBehavior === 'shelter') return false;

    // WATER IS NOT BEING STUCK — it is leaveWater's problem, and only it can
    // solve it. Here, every water cell reads as "walled in" (water is not
    // standable), and outranking leaveWater (93 against 85) this preempted it
    // 46 times in the 09-26 logs and then spent 870 seconds trying to pillar
    // where pillaring is physically impossible. Likewise while a water escape
    // is climbing out of a ravine on its own blocks.
    if (bot.entity?.isInWater || ctx.water?.escape) {
      ctx.stuck.anchor = null;
      return false;
    }

    // Standing at a furnace or crafting table isn't being stuck.
    if (STATIONARY_BEHAVIORS.has(ctx.currentBehavior)) {
      ctx.stuck.anchor = pos.clone();
      ctx.stuck.since = now;
      return false;
    }

    if (!ctx.stuck.anchor) {
      ctx.stuck.anchor = pos.clone();
      ctx.stuck.since = now;
      return false;
    }

    if (pos.distanceTo(ctx.stuck.anchor) > STUCK_CHECK_RADIUS) {
      // Made real progress — reset the watch.
      ctx.stuck.anchor = pos.clone();
      ctx.stuck.since = now;
      return false;
    }

    if (now - ctx.stuck.since <= STUCK_AFTER_MS) return false;

    // Standing still is not the same as being TRAPPED.
    //
    // Climbing out is only the answer when the bot is actually in a hole. It
    // fired during a standoff with a skeleton it couldn't reach, pillared
    // three blocks up, and `gatherStone` immediately dug back down — up,
    // down, up, down, achieving nothing. If there's open ground to walk to,
    // the bot isn't stuck in the sense this behavior fixes, and something
    // else (or simply moving) is the right answer.
    if (isConfined(bot)) return true;

    // ...but "there is open ground next to me" is not the same as "I can get
    // anywhere". Standing in a clearing with every single navigation leg
    // failing is just as stuck, and it is the state the bot was actually
    // found in. Trust the record of what happened when it tried to move.
    const health = bot.navHealth;
    return !!health
      && health.failures >= NAV_FAILURES_STUCK
      && now - health.lastFailAt < NAV_FAILURE_FRESH_MS;
  },
  async run(bot, ctx, task) {
    const confined = isConfined(bot);
    logger.warn('Stuck — getting out', {
      at: bot.entity.position.floored(),
      stuckForMs: Date.now() - ctx.stuck.since,
      reason: confined ? 'walled in' : 'cannot navigate anywhere',
      failedLegs: bot.navHealth?.failures ?? 0,
    });

    // Reset the watch first, so a failed escape doesn't immediately re-fire.
    ctx.stuck.anchor = bot.entity.position.clone();
    ctx.stuck.since = Date.now();

    // Cheapest first, and the one that fixes the reported trap: leaves.
    await clearSoftObstructions(bot, task);

    // Then simply leave. Going sideways is nearly always the right answer —
    // climbing is only correct in an actual pit, and pillaring out of level
    // ground just to walk back down was its own waste loop.
    if (await bargeOut(bot, task, { walledIn: confined })) {
      // Give pathfinder a clean slate; its stored "no route" verdict was
      // reached from a position we are no longer standing in.
      if (bot.navHealth) bot.navHealth.failures = 0;
      return true;
    }

    const escaped = await pillarOut(bot, task);
    if (escaped && bot.navHealth) bot.navHealth.failures = 0;
    logger.action(escaped ? 'Climbed clear of the hole' : 'Could not get out, will retry');
    return true;
  },
};

module.exports = {
  unstick,
  // For leaveWater, which climbs out of a ravine from its landing block.
  pillarOut,
  digOutUpward,
  // By name, so test/priorities.test.js checks every name is a real behavior.
  STATIONARY_BEHAVIORS,
  // Exported for the tests. These two decide whether a stuck bot is ever
  // noticed at all, which is the failure that cost whole sessions.
  isConfined,
  isSoftObstruction,
  canDigThrough,
  canBreakLid,
  ESCAPE_DIG_MAX_MS,
  STUCK_AFTER_MS,
  NAV_FAILURES_STUCK,
};
