const Vec3 = require('vec3');
const logger = require('../logger');
const { sleep, isInterruption } = require('../task');
const {
  digBlock, equipIfDifferent, bestToolOfType, tryPlaceBlock, toolIsWornOut, pillarItem,
} = require('../inventory');
const { groundUnder, feetCell, centreOnBlock } = require('../nav');
const { isUnderground, timeInfo } = require('../world');
const {
  digStaircaseDown, safeToDig, neededResource, ORE_DEPTH, stripMine, mine, descentShortfall,
  TRIP_DEPTH_Y,
} = require('./mine');
const { armorWorn } = require('../knowledge');
const { EDIBLE } = require('./survive');
const { countAny, woodUnits } = require('../inventory');
const { REGEN_FOOD_LEVEL } = require('../eating');
const { isHostileMob, isExplosive } = require('../entities');
// Line-of-sight, shared rather than re-implemented — see the note on
// countHostiles below.
const { hasLineOfSight } = require('./threat');

/**
 * Wait out the night in a hole, the way a player actually does.
 *
 * This exists because of a failure mode that nothing else could fix. At
 * night an unarmed bot is surrounded — observed live with seven hostiles
 * inside detection range at once — and `threat` sits at priority 90, so it
 * monopolises the scheduler. The bot spent entire nights doing nothing but
 * fight and flee: it never gathered wood, so it never crafted the sword that
 * would have let it stop running, so the next night went the same way.
 * Raising or lowering a priority just moves which half of the deadlock wins.
 *
 * The real answer is the one every Minecraft player learns on day one: don't
 * take the fight. Dig down two, seal the roof, wait for sunrise. Mobs burn
 * off or wander away, and the bot comes out with its health and its time.
 *
 * Deliberately NOT used when something is already adjacent — sealing a
 * creeper in with you is worse than being outside.
 */

/**
 * Three, not two — and the difference is the whole behavior working or not.
 *
 * A block can only be placed against the face of an existing one. Dig down 2
 * and the bot's feet are at S-2, its head at S-1, so the cell to seal is S:
 * ground level, whose four neighbours are the open air above the surface.
 * Nothing to place against, so every attempt was refused and the log read
 * "Underground but not sealed {sealedWith: dirt}" — holding the dirt, in the
 * hole, unable to put the lid on, which is how it died at 8 health with a
 * zombie standing over it.
 *
 * Dig down 3 and the seal cell is S-1, still inside the shaft, with solid
 * terrain on all four sides to place against. Same hole, one block deeper,
 * and the roof becomes placeable.
 */
const BURROW_DEPTH = 3;
const HOSTILE_SCAN_RANGE = 14;
// Below this, "underground at night" is a mine and needs no explanation —
// the same line resupply uses for "on a trip".
const SURFACE_LOG_Y = TRIP_DEPTH_Y;

/**
 * Only an EXPLOSIVE this close stops us digging in.
 *
 * This used to apply to any hostile at all, and it made the whole behavior
 * unreachable in exactly the situation it was written for. The bar to shelter
 * is "hostiles are on me"; the bar to refuse was "a hostile is within five
 * blocks" — and at night, being chased, those are the same condition. So the
 * bot fled at 3 health instead of burrowing, over and over, and died with a
 * stack of dirt in its hands. Three deaths in one session traced to this,
 * each one wiping the tool progression back to nothing.
 *
 * The original worry was real but specific: sealing a CREEPER into a one-by-one
 * hole with you is worse than being outside. A zombie or skeleton is a
 * different matter entirely — dig down two, put the lid on, and it is simply
 * left standing on top of the block. That is what a player does.
 */
const EXPLOSIVE_TOO_CLOSE = 6;

/**
 * Close enough to follow us down the hole, or to kill us digging it.
 *
 * Getting down three blocks and putting the lid on takes a few seconds. A
 * hostile inside this range spends those seconds either hitting us or
 * stepping into the shaft behind us, and a zombie sealed in a one-by-one
 * pit with the bot is far worse than one chasing it across open ground.
 *
 * Small on purpose. Too large and the behavior can never fire at night,
 * which is the mistake the previous version made.
 */
const FOLLOW_ME_IN_RANGE = 4;
const SWARM_SIZE = 2;
const LOW_HEALTH = 10;
const CHECK_INTERVAL_MS = 1000;
// Hard cap so a bugged day/night read can't entomb the bot forever.
const MAX_SHELTER_MS = 10 * 60 * 1000;

/**
 * Digging down uses the DENYLIST, not an allowlist of its own.
 *
 * This file used to carry a hand-written list of twenty-odd "safe" blocks,
 * which is the same mistake the descent code made and had to be fixed for:
 * there are thousands of harmless blocks and about six that matter, so any
 * allowlist is a list of the ones you happened to think of. Standing on a
 * fallen log, red sand, terracotta, calcite, dripstone, a dirt path or any
 * deepslate variant meant `digDown` refused outright — and it refuses
 * SILENTLY, which is why the log said only "Could not dig in, carrying on
 * above ground" three times while the bot was killed in the open.
 *
 * `safeToDig` already encodes the real rule: never bedrock, obsidian, a
 * container or a spawner; never a liquid; never anything with lava touching
 * it. That is the whole of what matters here.
 */

// `placeableItem` lives in inventory.js as `pillarItem` now — see
// PILLAR_MATERIAL there. This file, threat.js and inventory.js each used to
// carry their own list of blocks worth standing on, and they had drifted.
const placeableItem = pillarItem;

/**
 * Counted only if we could actually see it, not merely stand within range of
 * it through solid rock.
 *
 * threat.js had the identical gap in its own hostile-reaction check, and it is
 * what produced a bot frozen for five minutes reacting to a swarm that a
 * spectator watching over its shoulder could not see: the dashboard reported
 * ten to thirteen "near" hostiles while only one zombie was actually adjacent,
 * because straight-line distance through a cave wall counted the same as a
 * mob standing next to it. In a natural cavern that difference is the whole
 * question — most of what registers within sixteen blocks is on the other
 * side of solid stone.
 */
function countHostiles(bot, range) {
  let n = 0;
  let nearest = Infinity;
  let nearestExplosive = Infinity;
  const myEye = bot.entity.position.offset(0, 1.6, 0);
  for (const id of Object.keys(bot.entities)) {
    const e = bot.entities[id];
    if (e === bot.entity || !isHostileMob(e)) continue;
    const d = bot.entity.position.distanceTo(e.position);
    if (d <= range && hasLineOfSight(bot, myEye, e.position.offset(0, 1, 0))) {
      n++;
      if (d < nearest) nearest = d;
      if (isExplosive(e) && d < nearestExplosive) nearestExplosive = d;
    }
  }
  return { count: n, nearest, nearestExplosive };
}

/**
 * What is waiting at the top of the shaft, by distance alone.
 *
 * countHostiles asks for line of sight, which from the bottom of a sealed
 * hole sees nothing at all — so it cannot answer "is it safe to come up".
 */
function hostilesAround(bot, range) {
  let nearest = Infinity;
  let nearestExplosive = Infinity;
  for (const id of Object.keys(bot.entities ?? {})) {
    const e = bot.entities[id];
    if (e === bot.entity || !isHostileMob(e)) continue;
    const d = bot.entity.position.distanceTo(e.position);
    if (d > range) continue;
    if (d < nearest) nearest = d;
    if (isExplosive(e) && d < nearestExplosive) nearestExplosive = d;
  }
  return { nearest, nearestExplosive };
}

/**
 * Not yet — something is waiting up there.
 *
 * Fresh world, 09-25 17:13: the bot sat out the night at 6 health, dug out at
 * first light, and came up beside a creeper — which does not burn in daylight
 * the way the zombies do. "Backing off rather than trading {why: too hurt}",
 * then an explosion for exactly the 6 it had left. Everything else that spawns
 * at night burns or wanders off within a minute or two of dawn; waiting in a
 * sealed hole costs nothing.
 */
const MORNING_WAIT_RANGE = 8;
const MORNING_WAIT_MAX_MS = 3 * 60 * 1000;

/*
 * And not only when hurt. 09-26 07:27: out at dawn at 19 health, food 3, a
 * wooden sword, and a zombie standing in the pond by the shaft, where daylight
 * does not burn it. On Hard it took 9 health in five seconds; with food under
 * 7 none of it came back, and the bot died in the water it fled into. A fight
 * at the rim is only worth taking with a real weapon and a bar that heals —
 * otherwise the three minutes' wait is the cheaper side of the trade.
 */
function unsafeToSurface(bot) {
  const { nearest, nearestExplosive } = hostilesAround(bot, MORNING_WAIT_RANGE);
  if (nearestExplosive <= MORNING_WAIT_RANGE) return 'creeper';
  if (nearest > MORNING_WAIT_RANGE) return null;
  if (bot.health <= LOW_HEALTH) return 'hurt, with company';
  if (!armedWellEnough(bot)) return 'company, and no real weapon';
  const { CANNOT_SPRINT_FOOD } = require('./hunt');
  if ((bot.food ?? 20) <= CANNOT_SPRINT_FOOD) return 'company, and too hungry to heal';
  return null;
}

/** A weapon good enough that fighting the night is a reasonable plan. */
function armedWellEnough(bot) {
  const weapon = bestToolOfType(bot, 'sword') || bestToolOfType(bot, 'axe');
  if (!weapon) return false;
  // Wood tier against a horde is barely better than fists.
  return !weapon.name.startsWith('wooden');
}

/**
 * Is spending the night digging actually a good idea here?
 *
 * Deliberately a preference, not a rule. It needs a pickaxe that will
 * survive the trip and enough light to not be tunnelling blind into a cave
 * system — without either, waiting is the better plan and the bot just
 * waits. Nothing here forces it underground.
 */
const NIGHT_DIG_STEPS = 6;
const MIN_LEG_GAIN = 2;
const SHALLOW_LEGS_MAX = 2;
/** Enough food to work a ten-minute night shift and surface able to fight. */
const NIGHT_SHIFT_FOOD = 2;
/** How many times to resume a dig that stopped short of sealing depth. */
const DIG_RETRIES = 3;

/**
 * Why the bot will not mine tonight, or null if it will.
 *
 * A reason rather than a boolean, because this gate silently refused every
 * night shift the bot was ever offered and nothing in the log said so: across
 * every session on record, "Mining through the night" appears zero times,
 * while `shelter` took 40% of the wall clock sitting still in a hole.
 */
const TABLE_PLANKS = 4;
const STICK_RECIPE = { planks: 2, sticks: 4 };

function pickaxeWoodReserve(bot) {
  // Lazy: gear -> stations -> mine, and shelter is loaded alongside all three.
  const { TOOL_COST } = require('./gear');
  const table = countAny(bot, ['crafting_table']) > 0 ? 0 : TABLE_PLANKS;
  const stickCrafts = Math.ceil(TOOL_COST.pickaxe.sticks / STICK_RECIPE.sticks);
  return table + stickCrafts * STICK_RECIPE.planks;
}

function whyNotMineHere(bot, ctx = null) {
  const pick = bestToolOfType(bot, 'pickaxe');
  if (!pick) return 'no pickaxe';
  if (toolIsWornOut(bot, 'pickaxe')) return 'pickaxe worn out';
  // Hurt and underground with no way out is how a bad night becomes a death.
  if (bot.health <= LOW_HEALTH) return 'hurt';

  // Enough food to still be alive at dawn.
  //
  // A Minecraft night is ten real minutes and mining burns hunger the whole
  // way. Starting a shift with an empty larder means surfacing at first light
  // already starving, which is how the bot ended up dying to hunger with a
  // full inventory of cobblestone.
  //
  // But a full BAR is food too, and it was the bar that the bot actually had:
  // "Searching for food {food: 20, stock: 0}" ninety-nine times on the current
  // world. Counting only items in the bag meant a bot at 20/20 hunger — which
  // a night of digging takes down by a few points at most — was refused the
  // shift every single night. At or above the regeneration level it still
  // surfaces well fed; below it, the old item rule stands.
  if (countAny(bot, EDIBLE) < NIGHT_SHIFT_FOOD && (bot.food ?? 0) < REGEN_FOOD_LEVEL) return 'food';

  // Enough wood to make the NEXT pickaxe down there.
  //
  // 09-25: the staircase went on with a few planks, the stone pickaxe wore out
  // at y=55, and with too little wood for a table and sticks every route
  // through stone was "no route" — it starved in the dark with 203 cobble in
  // the bag. The reserve is read off the recipes: a table unless one is
  // carried, plus the planks that make a pickaxe's sticks.
  if (woodUnits(bot) < pickaxeWoodReserve(bot)) return 'wood';

  // And not before the trip kit. The staircase aims at iron's depth and the
  // morning carries on from wherever it ends, so a night shift IS a descent —
  // and it used to be the one descent with no gate at all: wooden pickaxe, no
  // cobble, no food, "Morning — carrying on below" with none of the kit goDeep
  // insists on. Before that phase the night is the workshop instead.
  if (ctx) {
    const progression = require('../progression');
    if (!progression.atLeast(bot, ctx, 'tripPrep')) {
      return `not ready for the deep (${progression.describe(bot, ctx).need ?? 'kit'})`;
    }
  }

  // And it has to actually be WORTH something. Digging for the sake of
  // digging is just a slower way to wait — if there is nothing the bot
  // currently needs from underground, the night is better spent resting.
  return neededResource(bot) ? null : 'nothing needed from below';
}


/**
 * ONE definition of night, shared with everything else that has an opinion.
 *
 * This used to read `!bot.time.isDay`, which mineflayer computes as
 * `timeOfDay < 13000` — so it calls everything from dusk right up to tick
 * 24000 night. src/world.js ends night at 23000, when the sun is already up
 * and the undead are already burning. The thousand-tick disagreement is only
 * fifty seconds, but it is fifty seconds at exactly the wrong moment, and it
 * made the dashboard and the bot contradict each other: the status file said
 * "day — dusk in 678s" while the bot was reporting "Digging in for the
 * night", which reads as a scheduler bug and is not one.
 *
 * Two sources of truth for the same fact is how that happens. There is now
 * one, and 23000 is the right end of it — daylight is what makes the surface
 * safe again, not midnight-plus-twelve-hours.
 */
function isNight(bot) {
  return timeInfo(bot).isNight;
}

/**
 * GET UNDER BEFORE DARK, not once the dark has found you.
 *
 * shelter used to wait for night AND for hostiles to turn up, and not dig in
 * at all for a bot "armed well enough" — which a stone sword counted as. On
 * the first Hard world (09-25, 02:19) dusk found the bot smelting and hunting
 * on a mountain with a stone sword and leather boots; zombies hit for 4.5 on
 * Hard, it fought, and it died seven times in five minutes, respawning into
 * the same crowd each time. The dig-in, when it finally fired, was preempted
 * by the fight it was meant to avoid.
 *
 * So the bot now goes down while the surface is still empty: this many
 * seconds before dusk, and at any point in the night it is found up top. The
 * burrow takes seconds; the night shift below it (whyNotMineHere) turns the dark
 * into mining time rather than waiting time, which is where the ore is anyway.
 */
const DUSK_PREP_SEC = 45;

// Jev says "danger": start getting under cover half as early again.
const DANGER_DUSK_FACTOR = 1.5;

function nightComing(bot, ctx = null) {
  if (isNight(bot)) return true;
  const time = timeInfo(bot);
  const danger = require('../director').currentRisk(ctx) === 'danger';
  const prep = danger ? DUSK_PREP_SEC * DANGER_DUSK_FACTOR : DUSK_PREP_SEC;
  return time.known && time.secondsUntilDusk <= prep;
}

/**
 * Armoured enough to hold the surface through a Hard night: an iron-or-better
 * sword and at least the protection of a full iron set (15 points). Anything
 * less goes underground at dusk — the fight it would otherwise take is the
 * one that killed it.
 */
const NIGHT_PROOF_ARMOR = 15;

function nightProof(bot) {
  const sword = bestToolOfType(bot, 'sword');
  if (!sword || /^(wooden|stone|golden)_/.test(sword.name)) return false;
  try {
    return armorWorn(bot).points >= NIGHT_PROOF_ARMOR;
  } catch {
    return false; // cannot read the armour slots — assume the worst
  }
}

/** Seal the 1x1 shaft above our head by placing against a side wall. */
async function sealRoof(bot, task) {
  const item = placeableItem(bot);
  if (!item) {
    logger.info('Nothing to seal the roof with', { holding: bot.heldItem?.name ?? 'nothing' });
    return false;
  }
  // Settle first. Every coordinate below is relative to where our feet are,
  // and mid-fall that is a block too high — which puts the roof cell at
  // ground level, where all four "walls" are open sky and there is nothing to
  // place against. sealRoof then returns false having tried nothing at all,
  // which is exactly what it did live: no "Placement failed" line anywhere,
  // because no placement was ever attempted.
  await settle(bot, task);
  await equipIfDifferent(bot, item);

  // feetCell, not position.floored(). With the raw floor the target lands on
  // the bot's own head whenever its Y sits just under the integer, and every
  // placement is refused — which is exactly what "Underground but not sealed
  // {sealedWith: dirt}" was: a bot in a hole, holding the dirt, unable to put
  // the lid on. See nav.js.
  const target = feetCell(bot).offset(0, 2, 0);
  // Already closed — by an earlier attempt, or by gravel settling into it. A
  // retry for the WALLS must not fail on the roof it already has.
  if (isSolid(bot.blockAt(target))) return true;

  // Side walls first: place into the gap from an adjacent block.
  let walls = 0;
  for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
    task.throwIfAborted();
    const ref = bot.blockAt(target.offset(dx, 0, dz));
    if (!ref || ref.boundingBox !== 'block') continue;
    walls++;
    // Face vector points from the reference block back toward the gap.
    if (await tryPlaceBlock(bot, ref, new Vec3(-dx, 0, -dz))) return true;
  }

  // Say so when there was nothing to place against at all. Without this the
  // failure is indistinguishable from a refused placement, and the two have
  // completely different causes: no walls means we are at the wrong depth,
  // a refusal means the placement itself is the problem.
  if (walls === 0) {
    logger.info('No wall to seal against — the hole is not deep enough', {
      roofCell: target,
      feet: feetCell(bot),
    });
  }

  // Then the ceiling: place onto the UNDERSIDE of the block above the gap.
  //
  // Worth trying separately because the side-wall placements kept being
  // refused ("the block is still air") — in a one-wide shaft the bot is
  // often not able to address a side face cleanly, whereas looking straight
  // up at the ceiling is unobstructed by definition.
  task.throwIfAborted();
  const above = bot.blockAt(target.offset(0, 1, 0));
  if (above && above.boundingBox === 'block') {
    if (await tryPlaceBlock(bot, above, new Vec3(0, -1, 0))) return true;
  }

  return false;
}

/**
 * Close the sides of the hole, not just the top.
 *
 * sealRoof assumed the shaft's walls were solid because the shaft was dug into
 * the ground. On flat ground they are. On a slope the downhill side of a
 * three-deep hole is open air at body height — reported with a screenshot as
 * "he doesn't cover himself properly": a dirt lid overhead, and the bot's legs
 * plainly visible through the missing wall, where anything can walk up and
 * hit it all night.
 *
 * So every one of the eight cells around the body (four sides, feet and head)
 * must be solid, and any that is not gets a block. Feet level goes first, so
 * a head-level gap can be placed on top of the block that just filled the one
 * beneath it. For each gap, anything solid touching it will do as the thing to
 * place against: below, beyond, either side, or above.
 */
const SIDES = [[1, 0], [-1, 0], [0, 1], [0, -1]];

function isSolid(block) {
  return !!block && block.boundingBox === 'block';
}

function openWalls(bot) {
  const feet = feetCell(bot);
  const gaps = [];
  for (const dy of [0, 1]) {
    for (const [dx, dz] of SIDES) {
      const cell = feet.offset(dx, dy, dz);
      if (!isSolid(bot.blockAt(cell))) gaps.push({ cell, dx, dz });
    }
  }
  return gaps;
}

async function fillGap(bot, { cell, dx, dz }) {
  const references = [
    [cell.offset(0, -1, 0), new Vec3(0, 1, 0)],
    [cell.offset(dx, 0, dz), new Vec3(-dx, 0, -dz)],
    [cell.offset(dz, 0, dx), new Vec3(-dz, 0, -dx)],
    [cell.offset(-dz, 0, -dx), new Vec3(dz, 0, dx)],
    [cell.offset(0, 1, 0), new Vec3(0, -1, 0)],
  ];
  for (const [pos, face] of references) {
    const ref = bot.blockAt(pos);
    if (!isSolid(ref)) continue;
    if (await tryPlaceBlock(bot, ref, face) && isSolid(bot.blockAt(cell))) return true;
  }
  return false;
}

/** Roof AND sides. A lid over a hole with a missing wall is not a shelter. */
async function sealShelter(bot, task) {
  const roof = await sealRoof(bot, task);
  const { open } = await sealWalls(bot, task);
  return roof && open === 0;
}

async function sealWalls(bot, task) {
  const gaps = openWalls(bot);
  if (gaps.length === 0) return { open: 0, filled: 0 };
  let filled = 0;
  for (const gap of gaps) {
    task.throwIfAborted();
    const item = placeableItem(bot);
    if (!item) break;
    await equipIfDifferent(bot, item);
    if (await fillGap(bot, gap)) filled++;
  }
  const open = openWalls(bot).length;
  logger.action(open === 0 ? 'Walled in the sides of the shelter' : 'Shelter still has open sides', {
    gapsFound: gaps.length,
    filled,
    stillOpen: open,
  });
  return { open, filled };
}

/**
 * Dig straight down, and report HOW FAR it actually got.
 *
 * It used to return a bare true/false, where false meant "not a single
 * block". Any partial dig therefore counted as success — and a partial dig
 * is precisely the case sealRoof cannot handle: the roof cell it aims at is
 * two above the bot's feet, so at the intended depth of three it sits inside
 * the shaft with solid walls to place against, while at one or two it is at
 * ground level surrounded by open air with nothing to place against at all.
 *
 * That is the whole of "Underground but not sealed {sealedWith: dirt}" — a
 * bot standing in a shallow scrape holding the dirt, unable to put a lid on
 * something that has no walls. It was then shot where it stood.
 */
/**
 * Wait until we have actually landed.
 *
 * Breaking the block under your feet starts a fall, and everything after it —
 * where the floor is, where the roof cell is — is nonsense until it finishes.
 * Watching Y alone is not enough: the bot can be a hair past the threshold and
 * still moving, so this waits for the server to say we are on the ground.
 */
const SETTLE_MS = 600;
const SETTLE_STEP_MS = 60;

async function settle(bot, task) {
  for (let waited = 0; waited < SETTLE_MS; waited += SETTLE_STEP_MS) {
    if (bot.entity?.onGround) return true;
    await sleep(SETTLE_STEP_MS, task);
  }
  return !!bot.entity?.onGround;
}

/**
 * Health we are willing to spend digging in and closing a roof before walking
 * away. One budget for the whole commitment, dig and seal alike.
 */
const UNSEALED_DAMAGE_BUDGET = 6;

/**
 * Has digging in already cost more health than it is worth?
 *
 * The seal loop always had this bound; the dig before it did not, and it
 * needs one now that `defend` leaves a dig-in alone — see digInProgress.
 */
function digBudgetSpent(bot, ctx) {
  const start = ctx?.shelter?.digStartHealth;
  return typeof start === 'number' && start - bot.health >= UNSEALED_DAMAGE_BUDGET;
}

/**
 * A dig-in that `defend` must not break into.
 *
 * Three of the seven deaths in the 09-25 02:09 session were this exact
 * sequence: "Digging in for the night", then "Preempting {running: shelter,
 * preemptedBy: defend}", then "Could not break the floor to shelter {held:
 * bare hands, dug: 0}" — and an unarmed bot turned to box a skeleton and died.
 * Being hit while digging is the risk sheltering already accepted; aborting
 * the dig throws away the only answer an unarmed bot has. The commitment is
 * bounded by the same damage budget as the seal: past it, defend takes over.
 */
function digInProgress(bot, ctx) {
  return ctx?.currentBehavior === 'shelter' && !!ctx.shelter?.digging && !digBudgetSpent(bot, ctx);
}

/**
 * How often the sealed-in bot checks whether it can make something.
 * Crafting from a full bag is quick; this only stops a goal that keeps failing
 * from being retried every second of the night.
 */
const WORKSHOP_EVERY_MS = 20000;
/** Slack on top of a full ore batch's cook time. */
const SMELT_MARGIN_MS = 5000;

/**
 * Craft whatever `gear` wants, from where we stand, without leaving the hole.
 *
 * `gear` sits at 40 and `shelter` at 91, so nothing the bot could make ever
 * got made at night. On the current world that was a wooden pickaxe at
 * 15:36:33, a sealed hole nineteen seconds later, and nine minutes of sitting
 * in it before a stone pickaxe at 15:50. stayingPut keeps every station call
 * within arm's reach — a walk from here would be a walk out through the lid.
 */
async function nightWorkshop(bot, ctx, task) {
  // Lazy: gear pulls in stations, which reaches back into this module's
  // neighbours; loading it at the top would be a cycle.
  const { gear } = require('./gear');
  const {
    smelt, oreIsNext, cookMs, ORE_BATCH,
  } = require('./smelt');
  const { stayingPut } = require('../stations');

  // Ore first: an iron pickaxe waits on the ingots. Only when no batch is
  // pending elsewhere, because collecting that one means walking to it — and
  // stayingPut would instead put a second furnace down here and forget the
  // first. The wait covers the whole batch: there is nowhere else to be.
  if (!ctx.smelt?.pending && oreIsNext(bot) && smelt.shouldRun(bot, ctx)) {
    logger.action('Smelting in the shelter');
    try {
      await stayingPut(() => smelt.run(bot, ctx, task, {
        waitMs: cookMs('furnace', ORE_BATCH) + SMELT_MARGIN_MS,
      }));
    } catch (err) {
      if (isInterruption(err)) throw err;
      logger.info('Could not smelt in the shelter', { reason: err.message });
    }
  }

  if (!gear.shouldRun(bot, ctx)) {
    await packUpStations(bot, ctx, task);
    return false;
  }
  logger.action('Crafting in the shelter');
  try {
    return !!(await stayingPut(() => gear.run(bot, ctx, task)));
  } catch (err) {
    if (isInterruption(err)) throw err;
    logger.info('Could not craft in the shelter', { reason: err.message });
    return false;
  } finally {
    await packUpStations(bot, ctx, task);
  }
}

/**
 * Take the table (and an empty furnace) along to the next leg down.
 *
 * The staircase moves the bot a few blocks every leg, so the table it put
 * down last time is out of reach by the next workshop — and stayingPut, quite
 * rightly, will not walk back up for it. It built a new one instead: three
 * tables in one night on 09-25, four planks each, and by 18:11 there was no
 * wood left for the two sticks an iron pickaxe needs. Five ingots in the bag,
 * "Could not make that: iron_pickaxe" three times running. Picking the table
 * up costs a second with an axe and keeps the wood for tools.
 */
const PACK_REACH = 4;

// How long a broken station's drop gets to reach the bag.
const PACK_PICKUP_MS = 1500;

async function packUpStations(bot, ctx, task) {
  const { findNearest } = require('../blocks');
  const { itemCount } = require('../inventory');
  const { untilTick } = require('../task');
  const names = ctx.smelt?.pending ? ['crafting_table'] : ['crafting_table', 'furnace'];
  for (const name of names) {
    const block = findNearest(bot, [name], PACK_REACH);
    if (!block) continue;
    // Only one we can SEE from inside. Within four blocks includes the table
    // left on the surface above the sealed lid: breaking it through the rock
    // dropped it outside, out of reach for the night — and "Packed it" was
    // logged anyway. 09-26 14:55: packed, then "no crafting table" sixteen
    // times until dawn.
    if (typeof bot.canSeeBlock === 'function' && !bot.canSeeBlock(block)) continue;
    const before = itemCount(bot, name);
    try {
      if (!(await digBlock(bot, block, task))) continue;
      const got = await untilTick(bot, () => itemCount(bot, name) > before, { maxTicks: 30, maxMs: PACK_PICKUP_MS, task });
      if (got) logger.action('Packed it to take down with me', { station: name });
      else logger.info('Broke the station but its drop did not reach the bag', { station: name, at: block.position });
    } catch (err) {
      if (isInterruption(err)) throw err;
    }
  }
}

/**
 * Strip-mine from the bottom of the night's staircase, if that is worth doing.
 *
 * Only through stripMine's own gate — right depth for what we need, a pickaxe
 * that is not wood, no known ore to go for instead — so this is the same work
 * the bot would choose by day, just without leaving the shelter's ownership:
 * nothing below it (`resupply` in particular) can pull it back up to the
 * surface in the middle of the night.
 */
async function nightTunnel(bot, ctx, task) {
  if (!ctx.mine) return false;
  // Ore already in sight first — stripMine declines exactly then, leaving it
  // to `mine`, which by day would be the one to take it.
  const job = [mine, stripMine].find((b) => b.shouldRun(bot, ctx));
  if (!job) return false;
  try {
    const worked = await job.run(bot, ctx, task);
    if (worked) logger.action('Tunnelling through the night', { via: job.name, y: Math.round(bot.entity.position.y) });
    return !!worked;
  } catch (err) {
    if (isInterruption(err)) throw err;
    logger.info('Could not tunnel here tonight', { reason: err.message });
    return false;
  }
}

async function digDown(bot, task, depth, ctx) {
  // The column we are digging. Fixed at the start so a perched bot is steered
  // back over THIS hole rather than recentred on the rim it is standing on.
  const column = bot.entity.position.floored();
  for (let i = 0; i < depth; i++) {
    task.throwIfAborted();
    if (digBudgetSpent(bot, ctx)) {
      logger.info('Taking too much damage to finish digging in', {
        dug: i,
        health: Math.round(bot.health),
      });
      return i;
    }
    // Dead centre first, so the hole we open is the only thing under us —
    // see centreOnBlock for the rim this bot kept standing on.
    await centreOnBlock(bot, task, column);
    // groundUnder, not floor(y)-1 — see the note in nav.js. The naive version
    // reported "air" underfoot whenever the bot's Y landed a hair under the
    // integer, so sheltering failed outright and the bot died in the open.
    let below = groundUnder(bot);
    if (!below) {
      // Almost never an unloaded chunk. It is us, still falling into the block
      // we just cut — there genuinely is nothing solid underneath yet, and a
      // moment later there is. digStaircaseDown already learned this the hard
      // way; this function did not, and the consequence was worse.
      //
      // Watched live on a fresh world: "Cannot shelter — no solid floor
      // underneath {dug: 2}" followed by "Could not dig deep enough to seal
      // {reached: 2, needed: 3}", three nights running. Two blocks down is the
      // one depth that cannot be sealed — the roof cell sits at ground level
      // with open air on all four sides and nothing to place against — so the
      // bot abandoned the hole, stood up in the open, and was beaten to death.
      // Three deaths in ninety seconds, all of them this.
      await sleep(250, task);
      below = groundUnder(bot);
    }
    if (!below && bot.entity?.onGround) {
      // Standing, yet nothing under us in our own column: we are on the rim of
      // the hole, held up by the next block over. Step out over it and drop.
      await centreOnBlock(bot, task, column);
      await settle(bot, task);
      below = groundUnder(bot);
    }
    if (!below) {
      logger.info('Cannot shelter — no solid floor underneath', { dug: i });
      return i;
    }
    if (!safeToDig(bot, below)) {
      logger.info('Not digging through that to shelter', { block: below.name, dug: i });
      return i;
    }
    // Never open into a liquid or a cave we can't see the bottom of.
    const beneath = bot.blockAt(below.position.offset(0, -1, 0));
    if (!beneath || beneath.name === 'lava' || beneath.name === 'water') {
      logger.info('Cannot shelter — something wrong below', { beneath: beneath?.name ?? 'unloaded', dug: i });
      return i;
    }
    // Every failure here used to be silent, so "Could not dig in" never said
    // which of six things went wrong.
    if (!(await digBlock(bot, below, task))) {
      logger.info('Could not break the floor to shelter', {
        block: below.name,
        held: bot.heldItem?.name ?? 'bare hands',
        dug: i,
      });
      return i;
    }

    // Wait for the LANDING, not for a Y threshold. Dropping one block takes
    // roughly a quarter of a second, so this is still far quicker than the
    // flat 400ms it replaced — but "Y has moved far enough" is true a tick
    // before the fall finishes, and the next iteration then probes for a floor
    // that is not there yet. See settle().
    await settle(bot, task);
  }
  return depth;
}

/** Break back out at sunrise: clear the roof, then pillar up to ground level. */
/**
 * Is there water close enough to pour into a shaft dug here?
 *
 * 09-26: dug in at the edge of a pond at sea level. The night was fine; the
 * morning was not. Breaking the lid let the pond into the shaft, the pillar
 * step refused ("the block is still water") four times, and the bot spent the
 * next six minutes wading in and out of its own flooded pit while its food
 * ran from 12 to 6. Checked down the whole depth of the shaft, since an
 * aquifer beside its walls floods it the same way.
 */
const DRY_RADIUS = 2;
const DRY_SEARCH = [3, 5, 8];
const DRY_WALK_MS = 7000;

function waterBeside(bot, feet) {
  const { isWater } = require('../swim');
  for (let dy = -BURROW_DEPTH; dy <= 1; dy++) {
    for (let dx = -DRY_RADIUS; dx <= DRY_RADIUS; dx++) {
      for (let dz = -DRY_RADIUS; dz <= DRY_RADIUS; dz++) {
        if (isWater(bot.blockAt(feet.offset(dx, dy, dz)))) return true;
      }
    }
  }
  return false;
}

/** A standable, dry cell a few blocks away — the nearest ring that has one. */
function dryGroundNear(bot) {
  const feet = feetCell(bot);
  for (const r of DRY_SEARCH) {
    for (let i = 0; i < 16; i++) {
      const a = (i / 16) * Math.PI * 2;
      const base = feet.offset(Math.round(Math.cos(a) * r), 0, Math.round(Math.sin(a) * r));
      for (const dy of [0, 1, -1]) {
        const at = base.offset(0, dy, 0);
        const floor = bot.blockAt(at.offset(0, -1, 0));
        const body = bot.blockAt(at);
        const head = bot.blockAt(at.offset(0, 1, 0));
        if (!floor || floor.boundingBox !== 'block') continue;
        if (!body || body.boundingBox !== 'empty' || !head || head.boundingBox !== 'empty') continue;
        if (waterBeside(bot, at)) continue;
        return at;
      }
    }
  }
  return null;
}

async function moveToDryGround(bot, task) {
  const dry = dryGroundNear(bot);
  if (!dry) {
    // Not 'digging in here anyway': ten times in the 09-26 logs, and the last
    // one sealed the bot into ground that flooded. A night in the open with
    // threat on watch is survivable; a flooded hole with a lid on is not.
    logger.info('Water all around — not digging in beside it');
    return false;
  }
  logger.action('Moving off the water\'s edge to dig in', { to: { x: dry.x, y: dry.y, z: dry.z } });
  try {
    const { goNear } = require('../nav');
    await goNear(bot, dry.offset(0.5, 0, 0.5), 0.9, task, { timeoutMs: DRY_WALK_MS });
    return true;
  } catch (err) {
    if (isInterruption(err)) throw err;
    return false;
  }
}

async function digOut(bot, task, depth) {
  for (let i = 0; i < depth + 1; i++) {
    task.throwIfAborted();
    const head = bot.blockAt(feetCell(bot).offset(0, 2, 0));
    if (head && head.boundingBox === 'block') {
      if (!(await digBlock(bot, head, task))) break;
    }

    const filler = placeableItem(bot);
    const standingOn = groundUnder(bot);
    if (!filler || !standingOn) break;

    try {
      await equipIfDifferent(bot, filler);
      bot.setControlState('jump', true);
      await sleep(180, task);
      await tryPlaceBlock(bot, standingOn, new Vec3(0, 1, 0));
    } catch (err) {
      if (isInterruption(err)) throw err;
    } finally {
      bot.setControlState('jump', false);
    }
    await sleep(220, task);
  }
}

/**
 * How long to keep trying to get a lid on, before giving the hole up.
 *
 * This is the pressure valve that makes the priority above safe. An unsealed
 * shaft is not a shelter, it is a pit the bot is standing still in, and every
 * second of it is free hits — so the commitment has to be bounded, and
 * bounded tightly.
 */
const SEAL_ATTEMPTS = 3;
const SHELTER_RETRY_MS = 30000;

/**
 * Say WHY shelter is standing aside at night — it cost the bot its life once
 * without a single line explaining itself.
 *
 * 09-25: dusk fell with the bot foraging in a forest at y=70, stone sword, no
 * armour — a bot that is not night-proof, which by the rule below means "go
 * down now". Shelter never ran. Two and a half minutes later three zombies, a
 * skeleton and a creeper killed it, and the log held nothing about sheltering
 * at all, so which of the refusals below fired could not be told after the
 * fact. Throttled, because this is asked every supervisor tick.
 */
const DECLINE_LOG_MS = 60000;

function declineAtNight(bot, ctx, reason, data = {}) {
  const now = Date.now();
  if (ctx.shelter.declineReason !== reason || now - (ctx.shelter.declineLoggedAt ?? 0) >= DECLINE_LOG_MS) {
    ctx.shelter.declineReason = reason;
    ctx.shelter.declineLoggedAt = now;
    logger.info('Night, and not sheltering', {
      reason,
      y: Math.round(bot.entity.position.y),
      ...data,
    });
  }
  return false;
}

/**
 * shelter.shouldRun without the side effects, for anything else that needs to
 * know whether digging in is the plan — see defend.shouldRun in threat.js.
 * `decline` is what a refusal at night does: log it (shouldRun) or nothing.
 */
function wantsShelter(bot, ctx, decline = () => false) {
  if (bot.health <= 0) return false;
  // WET FIRST, SHELTER SECOND. Outranking leaveWater (91 against 85), this
  // used to dig in wherever the night found the bot — including the flooded
  // pocket of 09-26 14:28, sealed in with water all round, which is how that
  // drowning began. Get out of the water (or finish climbing out of it), then
  // dig in on dry ground.
  if (bot.entity?.isInWater || ctx.water?.escape) {
    return nightComing(bot, ctx) ? decline(bot, ctx, 'in the water — getting out first') : false;
  }
  if (ctx.shelter.until && Date.now() < ctx.shelter.until) {
    return nightComing(bot, ctx) && !isUnderground(bot)
      ? decline(bot, ctx, 'waiting out the retry cooldown', {
        forMs: ctx.shelter.until - Date.now(),
      })
      : false;
  }
  if (!nightComing(bot, ctx)) return false;

  // Deliberately NOT requiring a placeable block up front. Digging two
  // blocks down yields two blocks of dirt or stone, which is exactly what
  // sealing the roof needs — so demanding one beforehand locked the
  // behaviour out of the situation it exists for: a bot with nothing,
  // at night, being killed repeatedly. It needs a pickaxe or its hands
  // and somewhere soft to dig, both of which it always has.

  // Already underground and working? Then we are ALREADY sheltered, and
  // stopping to dig a second hole is pure loss.
  //
  // This was a real waste loop: the bot would be mining at depth, a zombie
  // would spawn in an unlit stretch of its own tunnel, the hostile count
  // would tick over, and `shelter` — which outranks all mining — would
  // preempt the dig to burrow into the floor it was already standing
  // inside. Night underground is just work time; the surface is the only
  // place where night means danger.
  if (isUnderground(bot)) {
    // Only worth saying up where the fatal case happened. Deep in a mine at
    // night this is simply correct and would otherwise log once a minute.
    return bot.entity.position.y >= SURFACE_LOG_Y
      ? decline(bot, ctx, 'something solid overhead counts as underground')
      : false;
  }

  const { count, nearest, nearestExplosive } = countHostiles(bot, HOSTILE_SCAN_RANGE);
  // A creeper is the one thing we must not seal in with us. Everything else
  // is precisely what we are hiding FROM, so its presence can't be a reason
  // to refuse — see the note on EXPLOSIVE_TOO_CLOSE.
  if (nearestExplosive <= EXPLOSIVE_TOO_CLOSE) {
    return decline(bot, ctx, 'creeper too close to seal in with', {
      creeperAt: Math.round(nearestExplosive),
    });
  }

  // Burrowing takes a few seconds, and those seconds are the risk.
  //
  // Something already on top of us produces the two failures reported: it
  // kills the bot part-way down, or — worse — it simply walks into the hole
  // after it, which turns a shelter into a pit with a zombie in it. Either
  // way the hole was the wrong move.
  //
  // This is deliberately NOT the blanket "no hostile within five blocks"
  // rule that used to be here, which made the behavior unreachable: at
  // night, being chased, that condition is always true. The bar is only
  // "not already adjacent", and when it fails the bot does not simply give
  // up — `threat` (one priority below) takes over, puts distance between
  // them, and then this fires on the next pass with room to work. Run
  // first, dig second.
  if (nearest <= FOLLOW_ME_IN_RANGE) {
    return decline(bot, ctx, 'hostile close enough to follow us down', {
      nearest: Math.round(nearest * 10) / 10,
      hostiles: count,
    });
  }

  // Not armoured for a night up here: go down now, hostiles or no hostiles.
  // Before they arrive is the only time burrowing is cheap.
  if (!nightProof(bot)) return true;
  if (armedWellEnough(bot)) return false; // we can handle ourselves

  // With NOTHING in hand, one hostile is already too many.
  //
  // The normal bar is two hostiles, or one while hurt — sensible for a bot
  // with a stone sword. For a bot with no weapon at all it is far too high:
  // bare fists do 1 damage against 20 health, so any fight is lost by
  // definition, and the damage ledger showed a single skeleton taking 15
  // health off an unarmed bot before it died. That death costs everything
  // it was carrying, which is how the bot spent whole sessions cycling
  // between rebuilding wooden tools and losing them again, never once
  // accumulating enough to reach iron.
  //
  // Unarmed and something is out there: get in a hole. The night costs ten
  // minutes; the death costs the run.
  const unarmed = !bestToolOfType(bot, 'sword') && !bestToolOfType(bot, 'axe');
  if (unarmed && count >= 1) return true;

  return count >= SWARM_SIZE || (count >= 1 && bot.health <= LOW_HEALTH);
}

const shelter = {
  name: 'shelter',
  /**
   * ABOVE threat, and this is the fix for a specific observed death loop.
   *
   * It was 89, one above threat's 88 — but the scheduler compares RAW
   * priorities when deciding whether to preempt. So the sequence was: shelter
   * starts digging (it only starts when the nearest hostile is more than four
   * blocks off), the zombie closes to three, threat preempts the dig, the bot
   * flees, shelter is picked again somewhere new, and digs a fresh hole from
   * scratch. It never once finished one. Watched live on a new world: flee,
   * dig, flee, dig, dead — three times in ninety seconds.
   *
   * Digging in is a commitment. Two seconds of a zombie hitting a bot that is
   * about to be behind a lid is a far better trade than an endless cycle of
   * half-dug holes, and the whole premise of the behavior is that we have
   * decided NOT to take this fight.
   *
   * What makes that safe is that the commitment is bounded at both ends:
   * shouldRun still refuses to start with anything adjacent or a creeper in
   * range, and run() abandons a hole it cannot seal within a few seconds or
   * six health, whichever comes first — at which point threat gets the wheel
   * back. Still below escapeDrowning (95) and escapeHazard (97): drowning and
   * lava do not wait, and below bed and unstick for the reasons above.
   */
  priority: 91,
  shouldRun(bot, ctx) {
    return wantsShelter(bot, ctx, declineAtNight);
  },
  async run(bot, ctx, task) {
    const { count } = countHostiles(bot, HOSTILE_SCAN_RANGE);
    // Never at the water's edge — see waterBeside.
    if (waterBeside(bot, feetCell(bot)) && !(await moveToDryGround(bot, task))) {
      ctx.shelter.until = Date.now() + SHELTER_RETRY_MS;
      return false;
    }
    logger.action('Digging in for the night', {
      hostiles: count,
      health: Math.round(bot.health),
    });

    // Keep digging until we are ACTUALLY deep enough to seal.
    //
    // A partial hole is the worst of both outcomes: the bot is committed,
    // standing still, in a scrape with no walls to place a roof against —
    // and it dies there. So a short dig is retried rather than accepted,
    // usually because the first attempt hit gravel or was interrupted.
    //
    // While this is in progress `defend` stays out of it — see digInProgress.
    ctx.shelter.digging = true;
    ctx.shelter.digStartHealth = bot.health;
    let dug = 0;
    try {
      dug = await digDown(bot, task, BURROW_DEPTH, ctx);
      for (let retry = 0; dug < BURROW_DEPTH && retry < DIG_RETRIES; retry++) {
        task.throwIfAborted();
        if (digBudgetSpent(bot, ctx)) break;
        const more = await digDown(bot, task, BURROW_DEPTH - dug, ctx);
        if (more === 0) break; // genuinely cannot go deeper here
        dug += more;
      }
    } finally {
      ctx.shelter.digging = false;
    }

    if (dug < BURROW_DEPTH) {
      // Not deep enough to put a lid on, so this is not a shelter. Climbing
      // back out and moving is better than sitting in an open pit.
      ctx.shelter.until = Date.now() + SHELTER_RETRY_MS;
      logger.info('Could not dig deep enough to seal — staying above ground', {
        reached: dug,
        needed: BURROW_DEPTH,
      });
      return false;
    }

    // The blocks just dug out are the roof. That's the whole trick, and why
    // this doesn't need to arrive carrying materials.
    //
    // From here until we climb out, BEING WALLED IN IS THE PLAN — and that has
    // to be said out loud, because `unstick` sits one priority above this and
    // its entire job is to notice a bot that is walled in and dig it out.
    // Neither behavior was wrong on its own and together they were a machine
    // for wasting a night: shelter seals the roof, unstick sees a confined bot
    // and breaks it open, shelter seals it again. Reported exactly as watched —
    // "breaking and placing a dirt block 20 times in the same place for no
    // reason". It was one dirt block, and there was a reason; it was just a
    // disagreement between two behaviors about what the hole was for.
    ctx.shelter.sealedIn = false;
    let sealed = await sealShelter(bot, task);
    ctx.shelter.sealedIn = sealed;
    logger.action(sealed ? 'Sealed in — waiting out the night' : 'Underground but not sealed', {
      sealedWith: placeableItem(bot)?.name,
    });

    const deadline = Date.now() + MAX_SHELTER_MS;
    const healthOnArrival = bot.health;
    let sealAttempts = 0;

    let descended = 0;
    let saidWhyNot = false;
    let saidStairsStopped = false;
    let stairsStoppedAt = null;
    let shallowLegs = 0;
    let lastWorkshopAt = 0;
    while (Date.now() < deadline) {
      task.throwIfAborted();
      // The whole night, including the minute before it we dug in for.
      if (!nightComing(bot, ctx)) break;

      // Keep trying to close the roof rather than settling for an open hole.
      //
      // An unsealed shaft is a funnel, not a shelter — a zombie walks in and
      // the bot is cornered at the bottom of its own hole, which is strictly
      // worse than being in the open. A retry costs one block placement and
      // the situation changes constantly (gravel settles, a mob moves off the
      // spot we were aiming at), so it is usually the second attempt that
      // takes.
      //
      // But it cannot be retried forever, and forever is what it used to do:
      // the bot sat at the bottom of an open shaft re-attempting the roof
      // while a zombie stood on the rim hitting it, and died there. Now this
      // outranks threat, so nothing else will step in — which makes bounding
      // it not a nicety but the thing that keeps the priority safe.
      if (!sealed) {
        sealed = await sealShelter(bot, task);
        ctx.shelter.sealedIn = sealed;
        sealAttempts++;
        if (sealed) {
          logger.action('Got the roof on at last', { attempts: sealAttempts });
        } else if (sealAttempts >= SEAL_ATTEMPTS
          || healthOnArrival - bot.health >= UNSEALED_DAMAGE_BUDGET) {
          logger.warn('Cannot get a roof on this hole — giving it up', {
            attempts: sealAttempts,
            healthSpent: Math.round(healthOnArrival - bot.health),
            next: 'letting threat handle it instead',
          });
          ctx.shelter.until = Date.now() + SHELTER_RETRY_MS;
          return false;
        }
      }

      // Sealed in with a pickaxe? Then this is mining time, not waiting time.
      //
      // A Minecraft night is ten real minutes. Spending it motionless in a
      // hole is ten minutes of nothing, repeated every day — and the bot's
      // actual problem has always been that it gets to depth too slowly. A
      // sealed shaft is the safest place it will ever dig from: walls on
      // every side, a lid overhead, and every block downward is progress
      // toward the ore it needs.
      //
      // Strictly opportunistic. No pickaxe, or an unsafe descent, and it
      // simply goes back to waiting the night out.
      // Anything the bag can now be turned into — a stone pickaxe from the
      // cobble this shift just cut, most often — is made here and now, not at
      // dawn. See nightWorkshop.
      if (sealed && Date.now() - lastWorkshopAt >= WORKSHOP_EVERY_MS) {
        lastWorkshopAt = Date.now();
        await nightWorkshop(bot, ctx, task);
      }

      const whyNot = sealed ? whyNotMineHere(bot, ctx) : 'not sealed';
      if (whyNot && sealed && !saidWhyNot) {
        saidWhyNot = true;
        logger.info('Not mining tonight', { reason: whyNot });
      }
      // Not from the spot it already refused. Re-asked every second, a
      // staircase that said "boxed in" said it again — four turns into the
      // same water, logged each time, sixty lines a minute until dawn.
      // Within two blocks, not the exact cell: each turn into the water shifts
      // the bot a cell (-5,18,12 / -3,17,12 / -4,17,13 on 09-25 18:12), so an
      // exact match never matched and the refusal was re-asked 256 times.
      const here = bot.entity.position.floored();
      const stairsRefusedHere = !!stairsStoppedAt && stairsStoppedAt.distanceTo(here) <= 2;
      if (sealed && !whyNot && !stairsRefusedHere) {
        // Aimed at the ore, and continuing goDeep's staircase — with no target
        // the staircase stops at the first stone, so the "night shift" was a
        // couple of blocks and then nine minutes of waiting.
        const band = ORE_DEPTH[neededResource(bot)];
        const result = await digStaircaseDown(bot, task, {
          maxSteps: NIGHT_DIG_STEPS,
          targetY: band ? band.best : null,
          startHeading: ctx.mine?.descentHeading ?? null,
        });
        if (ctx.mine && result.heading) ctx.mine.descentHeading = result.heading;
        descended += result.depth;
        if (result.depth > 0) {
          logger.action('Mining through the night', {
            descended: result.depth,
            y: Math.round(bot.entity.position.y),
          });
          // A leg that barely goes down is a staircase fighting water or a
          // cave edge, not descending: 09-26 logged "descended 1" thirteen
          // times at y=46-47 over six minutes. Two in a row ends it.
          shallowLegs = result.depth < MIN_LEG_GAIN ? shallowLegs + 1 : 0;
          if (shallowLegs < SHALLOW_LEGS_MAX) continue; // straight back down
          stairsStoppedAt = bot.entity.position.floored();
          saidStairsStopped = true;
          logger.info('Staircase stopped for the night', {
            reason: 'barely getting deeper', y: Math.round(bot.entity.position.y),
          });
          await sleep(CHECK_INTERVAL_MS, task);
          continue;
        }

        // The staircase is done — at the ore's depth, or stopped by a cave or
        // a floor it will not step onto. Live on 09-25 it went 19 blocks down
        // to y=28, squarely inside iron's band, and then sat there idle for
        // the rest of the night because this loop had nothing else to offer.
        // Down here it is ordinary mining time: tunnel for the ore instead.
        if (result.reason) stairsStoppedAt = bot.entity.position.floored();
        if (!saidStairsStopped) {
          saidStairsStopped = true;
          logger.info('Staircase stopped for the night', {
            reason: result.reason ?? 'reached the ore depth',
            y: Math.round(bot.entity.position.y),
          });
        }
        // ...but only when the stairs ended because the ore's depth was
        // reached. "boxed in", "nothing solid below", "could not step down" all
        // mean drops or liquid on every side — caves — and tunnelling there
        // at night is how the bot walked off a 28-block edge on 09-25, four
        // seconds after the staircase had said exactly that.
        if (!result.reason && await nightTunnel(bot, ctx, task)) {
          descended = Math.max(descended, 1);
          continue;
        }
      }

      await sleep(CHECK_INTERVAL_MS, task);
    }

    ctx.shelter.sealedIn = false;
    // Mined down through the night? Then morning finds the bot where the work
    // is, and digging three blocks up out of a staircase is pointless — as
    // long as it is carrying what the trip needs to CONTINUE (the lenient
    // underground bar), or the first thing morning does is climb back up.
    if (descended > 0 && descentShortfall(bot).length === 0) {
      logger.action('Morning — carrying on below', { descended, y: Math.round(bot.entity.position.y) });
      ctx.shelter.until = Date.now() + 20000;
      return true;
    }
    const waitUntil = Date.now() + MORNING_WAIT_MAX_MS;
    let waitingFor = unsafeToSurface(bot);
    if (waitingFor) logger.info('Waiting for the coast to clear before digging out', { reason: waitingFor });
    while (waitingFor && Date.now() < waitUntil) {
      await sleep(CHECK_INTERVAL_MS, task);
      waitingFor = unsafeToSurface(bot);
    }
    logger.action('Morning — digging out');
    await digOut(bot, task, BURROW_DEPTH);
    // Don't immediately re-shelter if it's somehow still dark.
    ctx.shelter.until = Date.now() + 20000;
    return true;
  },
};

module.exports = {
  shelter, nightComing, nightProof, DUSK_PREP_SEC,
  // For test/combatscheduling.test.js: defend must leave a dig-in alone while
  // it is still inside its damage budget.
  digInProgress, wantsShelter, unsafeToSurface, packUpStations,
  // For test/mining.test.js: which gate keeps the night shift from running.
  whyNotMineHere, pickaxeWoodReserve, waterBeside, dryGroundNear,
  // For test/mining.test.js: a lid over a hole with a missing wall is not a
  // shelter, and these are what decide whether the walls are closed.
  openWalls, sealWalls,
};
