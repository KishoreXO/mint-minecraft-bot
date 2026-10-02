const logger = require('../logger');
const worldMemory = require('../memory');
const { sleep, isInterruption } = require('../task');
const { goNear, goNearXZ, goToHeight, goToBlock } = require('../nav');
const { isFoodAnimal, nearestWithin } = require('../entities');
const { stopPvp } = require('../tactics');
const {
  countAny, equipBestWeapon, bestToolOfType, tierRank, digBlock, stepOntoDrop,
} = require('../inventory');
const { findPositions } = require('../blocks');
const { animalFacts } = require('../knowledge');
const { EDIBLE } = require('./survive');
// The descent's food requirement is the single source of truth for how much
// food is "enough" — see FOOD_STOCK_TARGET.
const { DEEP_TRIP_NEEDS, nightOnTheSurface } = require('./mine');
const { rawMeatCount } = require('../eating');
const { biomeName, isUnderground, SURFACE_Y: SEA_LEVEL } = require('../world');
const { wantsWool, insomniaRisk } = require('./bed');
// gear.js requires only stations and inventory, so this is cycle-free.
const { stoneKitDone } = require('./gear');

/**
 * Hunt an animal for food (and leather, which becomes armour).
 *
 * The old version used `entity.type === 'mob'`, which never matches on
 * modern versions, so the bot never hunted anything and never had food.
 * It also used bot.nearestEntity() with no distance cap, which would have
 * sent it marching across the map after the first cow it heard about.
 */

const HUNT_RANGE = 24;
/**
 * How much food to stop hunting at — DERIVED from what the descent asks for,
 * not a number that happens to be near it.
 *
 * This was 5 against a trip requirement of 3, which worked. Raising the trip
 * requirement to 6 — the bot should not have to surface mid-run for a meal —
 * silently broke it: `hunt` stops at 5, `goDeep` refuses below 6, and no
 * behavior in the set closes the gap. The bot would have hunted to exactly one
 * item short of a descent it was otherwise completely ready for, forever.
 *
 * That is the same shape as every other stall this project has had, and the
 * comment on STOCK_FOR_TRIP below already warned about it in so many words.
 * Two numbers that have to agree should not be written down twice.
 *
 * The +2 is hysteresis, not slack: stopping exactly at the bar means one eaten
 * pork chop re-blocks the descent and the bot turns round for another cow.
 */
const FOOD_STOCK_TARGET = DEEP_TRIP_NEEDS.food + 2;
// Enough uncooked meat in the bag that another hunt is pointless until the
// furnace has caught up.
const RAW_BACKLOG = 3;
/**
 * Small enough to kill with fists without it being a farce.
 *
 * Bare hands do 1 damage: a chicken (4) or rabbit (3) is three or four
 * swings, a cow or pig (10) is ten while it runs away between each one.
 */
const PUNCHABLE_HEALTH = 4;
const KILL_TIMEOUT_MS = 20000;
const PICKUP_WAIT_MS = 1500;

/**
 * Never chase prey up or down a cliff.
 *
 * Once a hunt starts, the combat engine drives the controls directly — forward,
 * sprint, jump — and it does no fall checking whatever. Pathfinder's maxDropDown
 * of 3 protects ordinary travel and protects nothing here, so an animal on the
 * far side of a ravine turns straight into a seven-block drop.
 *
 * Watched live, mid-hunt: "Took avoidable damage {cause: fall, lost: 4,
 * fellBlocks: 7}", and a death from the same cause in the session before it.
 * Animals are plentiful and interchangeable — the one across the gap is never
 * worth four hearts, let alone the run.
 */
const PREY_HEIGHT_LIMIT = 4;

/** Something we could actually reach without falling to get to it. */
function huntable(bot) {
  return (e) => isFoodAnimal(e)
    && Math.abs(e.position.y - bot.entity.position.y) <= PREY_HEIGHT_LIMIT;
}

function foodStock(bot) {
  return countAny(bot, EDIBLE);
}

/**
 * No hunting until there is a stone weapon — sword or axe, stone or better.
 *
 * Asked for directly: "make the bot get stone weapon first before the bot
 * starts [hunting] mobs for food please enforce it". Chasing a cow with fists
 * or a wooden sword is slow, and the chase is where the bot gets dragged off
 * ledges and caught out at dusk. Gear (40) outranks every routine food
 * behavior, so with the hunt gated here the sword comes first on its own.
 *
 * One exception: at or below the hunger where a player can no longer sprint,
 * the bot is a few minutes from starving damage, and a corpse never crafts
 * the sword. Only then may it hunt with whatever it has.
 */
const HUNT_WEAPON_TIER = tierRank('stone_sword');
const CANNOT_SPRINT_FOOD = 6;

function armedForHunting(bot) {
  return ['sword', 'axe'].some((type) => {
    const weapon = bestToolOfType(bot, type);
    return !!weapon && tierRank(weapon.name) <= HUNT_WEAPON_TIER;
  });
}

function mayHunt(bot) {
  return armedForHunting(bot) || (bot.food ?? 20) <= CANNOT_SPRINT_FOOD;
}

/**
 * Stocking up waits for the whole stone kit, not just the weapon.
 *
 * "Make it enough food after it gets stone stuff." A hungry bot still hunts
 * as soon as it has a stone weapon (forage, huntUrgent); building a larder for
 * the trip (hunt, forageTopUp) is the step AFTER the pickaxe, sword and axe.
 * Watched live on the new world before this: seven minutes of chasing rabbits
 * bare-handed, most hunts "killed: false", one tree chopped, and night fell
 * with no weapon and no pickaxe.
 */
function mayStockFood(bot) {
  return (stoneKitDone(bot) && armedForHunting(bot)) || (bot.food ?? 20) <= CANNOT_SPRINT_FOOD;
}

/**
 * Hunting is split in two on purpose.
 *
 * As a single high-priority behavior it deadlocked the bot: it hunted until
 * it had 5 food, ate some (dropping below 5), hunted again... while sitting
 * above `wood` in the priority order the whole time. The bot spent six real
 * minutes cycling hunt→eat and didn't craft its first sword until it
 * happened to get a gap.
 *
 * So: only outrank toolmaking when genuinely short of food. Otherwise top up
 * opportunistically, below the work that actually makes the bot capable.
 */
const STARVING_HUNGER = 12;

function needsFoodUrgently(bot) {
  return foodStock(bot) === 0 && (bot.food ?? 20) <= STARVING_HUNGER;
}

/**
 * Which animal to kill, when several are in range.
 *
 * Two different answers depending on what we are holding:
 *
 *  - UNARMED, the only thing that matters is whether the kill is achievable
 *    at all. Fists do 1 damage, so the choice is between a three-swing
 *    chicken and an eight-swing sheep that runs between every one.
 *  - ARMED, everything in range dies easily, so the choice is about what it
 *    drops — and a sheep's wool is a bed, which skips an entire night.
 *
 * Both are opportunism rather than goals: neither ever sends the bot looking
 * for a particular animal, they only choose among what is already standing
 * in front of it.
 */
function pickPrey(bot, ctx = {}) {
  const armed = !!(bestToolOfType(bot, 'sword') || bestToolOfType(bot, 'axe'));
  // Not an animal we just failed to kill (noteFailedKill), or could not reach.
  const prey = (e) => huntable(bot)(e) && chaseable(ctx)(e);

  // UNARMED: take whatever dies fastest.
  //
  // Bare fists do 1 damage, so a sheep is eight swings and a chicken is
  // three — while the animal runs between each one. A starving bot at 0 food
  // chasing sheep it cannot kill was exactly what this produced: six hunts
  // in one minute, no meat, and the hunger bar still falling. When we have
  // nothing, the cheapest kill is the only kill.
  if (!armed) {
    const reachable = nearbyPrey(bot, prey);
    if (reachable.length === 0) return null;
    // Health first, then distance. Without the tie-break two chickens twenty
    // blocks apart were indistinguishable, and the bot would just as happily
    // set off after the far one.
    const me = bot.entity.position;
    return reachable.sort((a, b) => (animalFacts(a.name).health - animalFacts(b.name).health)
      || (me.distanceTo(a.position) - me.distanceTo(b.position)))[0];
  }

  // ARMED: a sheep is worth more than a pig to a bot with no bed, because
  // three wool skips an entire night. Opportunism only — it never sends the
  // bot looking, it just breaks the tie among animals already in range.
  if (wantsWool(bot)) {
    const sheep = nearestWithin(bot, (e) => e.name === 'sheep' && prey(e), HUNT_RANGE);
    if (sheep) {
      // Worth saying out loud when the clock is running: phantoms start at
      // three days awake and a bed is the only thing that stops them.
      const risk = insomniaRisk(bot);
      if (risk.imminent) {
        logger.action('Taking the sheep — phantoms are close', { daysAwake: risk.days });
      }
      return sheep;
    }
  }
  return nearestWithin(bot, prey, HUNT_RANGE);
}

/** Every food animal within hunting range that `prey` accepts. */
function nearbyPrey(bot, prey = huntable(bot)) {
  const out = [];
  for (const id of Object.keys(bot.entities)) {
    const e = bot.entities[id];
    if (!prey(e)) continue;
    if (bot.entity.position.distanceTo(e.position) <= HUNT_RANGE) out.push(e);
  }
  return out;
}

async function doHunt(bot, ctx, task) {
  // Both callers' shouldRun already checked; this is the one place that
  // swings at an animal, so the rule is held here too.
  if (!mayHunt(bot)) return false;
  const animal = pickPrey(bot, ctx);
  if (!animal) return false;

  // Bare hands are fine for SOME animals, and refusing outright was costing
  // the bot its food supply.
  //
  // The old rule was "no weapon, no hunting unless already starving", which
  // sounds prudent and means the bot can never build a buffer — it waits
  // until it is desperate and then has to succeed on the first try. But a
  // chicken has 4 health and a rabbit 3, so bare fists kill either in three
  // or four swings; only the 10-health animals are genuinely not worth
  // punching. So the bar is the ANIMAL, not the weapon.
  const armed = !!(bestToolOfType(bot, 'sword') || bestToolOfType(bot, 'axe'));
  const easy = animalFacts(animal.name).health <= PUNCHABLE_HEALTH;
  if (!armed && !easy && !needsFoodUrgently(bot)) return false;

  logger.action('Hunting', {
    animal: animal.name,
    hits: Math.ceil(animalFacts(animal.name).health / (bestToolOfType(bot, 'sword') ? 5 : 1)),
  });

  // Equip before engaging, not once per swing. mineflayer-pvp handles the
  // chase and the swinging from here, which matters because the hand-rolled
  // version swung on a flat timer — Minecraft scales damage by the attack
  // cooldown, so spamming is both weaker AND the thing that makes a bot look
  // obviously non-human.
  await equipBestWeapon(bot);

  // Drops land where the animal DIES, not where it was standing when we
  // first saw it — and a panicking cow covers a lot of ground. Tracking the
  // start position meant walking back to an empty patch of grass and
  // leaving the meat behind, every single hunt.
  let deathPos = animal.position.clone();

  const startedAt = Date.now();
  // Released in the finally — see Task.onAbort for why a kept listener is a leak.
  const unwatchAbort = task.onAbort(() => stopPvp(bot));

  try {
    bot.swordpvp.attack(animal);
    while (animal.isValid && Date.now() - startedAt < KILL_TIMEOUT_MS) {
      task.throwIfAborted();
      deathPos = animal.position.clone();
      // The engine drops its target on its own once something dies or
      // leaves range; re-assert while the animal is still alive.
      if (!bot.swordpvp.target) bot.swordpvp.attack(animal);
      await sleep(150, task);
    }
  } finally {
    unwatchAbort();
    stopPvp(bot);
  }

  const killed = !animal.isValid;
  // A rabbit that outran the timeout is still there, still nearest, and was
  // picked again: 08:43–08:47 on 10-02, eleven "Hunting {rabbit}" in a row,
  // each "Hunt finished {killed: false}" after ~24 s, while food went 18 -> 4.
  if (killed) chaseMemory(ctx).strikes.delete(animal.id);
  else if (animal.isValid) noteFailedKill(ctx, animal);

  // Walk over the drops so they get picked up. `collect` sweeps up anything
  // that scattered further than this.
  try {
    await goNear(bot, deathPos, 1, task);
    await sleep(PICKUP_WAIT_MS, task);
  } catch (err) {
    if (isInterruption(err)) throw err;
  }

  logger.action('Hunt finished', {
    killed,
    animal: animal.name,
    foodStock: foodStock(bot),
  });

  // REPORT THE TRUTH. This returned true whatever happened, so a chase that
  // timed out without a kill was scored as productive work: the commitment
  // bonus was granted, the no-op backoff never engaged, and the bot looked
  // busy while its larder stayed empty. Reported as running at a cow, not
  // killing it, and wandering back to the crafting table — the middle step
  // is this, quietly counting as a success.
  return killed;
}

/**
 * Go and FIND something to eat.
 *
 * The gap that killed the bot: `huntUrgent` can only act on an animal
 * already within 24 blocks. With an empty larder and no animal in sight,
 * nothing in the entire behavior set was responsible for fixing that — so
 * the bot carried on mining, hunger ticked down, and it starved to death
 * standing on a pile of cobblestone.
 *
 * Being hungry with no food is an emergency that requires TRAVEL, so this
 * outranks ordinary work and deliberately moves the bot to new ground.
 */
const SEARCH_RADIUS = 64;
const FORAGE_LEG = 24;
// Roughly grass level — two above sea level, the one surface height in
// world.js. Above this there is sky, daylight and animals; below it the bot
// is in its own tunnels, where nothing edible spawns.
const SURFACE_Y = SEA_LEVEL + 2;
/**
 * Climb past the threshold, not to it.
 *
 * goToHeight considers itself arrived at `y >= target - 1`, so a bot at y=64
 * asking for 65 is already there. Overshooting is what makes the climb a real
 * movement rather than a goal that is satisfied before it starts.
 */
const CLIMB_OVERSHOOT = 4;
/**
 * Start looking while there is still time to succeed.
 *
 * At 15 the bot began searching with three quarters of its hunger already
 * gone, and finding an animal, chasing it, killing it and collecting the drop
 * routinely takes longer than that leaves. Traced from a death: the ledger
 * read `starving 20` — a full health bar lost to hunger — and the bot spent
 * the whole of it wandering, found nothing, died, respawned with nothing at
 * night, and was killed again before it could recover. The entire spiral
 * started with looking too late.
 *
 * Only ever fires with a completely empty larder, so this is not the bot
 * abandoning work to snack; it is the bot noticing it has no food at all.
 */
const HUNGRY_ENOUGH_TO_LOOK = 17;

/**
 * Is the bot actually UNDERGROUND, and not merely low?
 *
 * The climb used to fire on height alone — anywhere below y=65 — and sea
 * level is 63. Beaches, swamps, river banks and most plains sit right there,
 * so a hungry bot standing in open grass announced "Hungry underground —
 * heading for the surface" and set off uphill looking for sky it was already
 * under. In the logs, 44 of the 48 times it said that it was at y=62–64 with
 * nothing overhead: hunger 0, starving damage ticking, climbing hills instead
 * of looking for animals, round and round. Being under something is what
 * "underground" means, and world.isUnderground asks exactly that.
 */
function shouldClimbForFood(bot) {
  return bot.entity.position.y < SURFACE_Y && isUnderground(bot);
}

/**
 * Biomes with no land animals in them. Walking a hungry bot into one is a
 * wasted leg at exactly the moment it can least afford one.
 */
const BARREN = /ocean|river|desert|badlands|beach|deep_|frozen_|ice_|mushroom/;

/**
 * Pick somewhere to look for food: keep going the same way, into new ground.
 *
 * It used to pick a fresh random heading every 24-block leg, and a random walk
 * goes nowhere — its distance from the start only grows with the square root
 * of the legs walked. Live on 09-26 (22:06–22:33) the bot starved to death
 * three times in the same hunted-out 200 blocks, "near: 0a" on every status
 * line, while untouched ground with animals on it lay a few hundred blocks off
 * in any direction. Animals come with the chunks and barely respawn, so the
 * food is where the bot has not been.
 *
 * So it commits to a heading and keeps it, leg after leg. It turns only when
 * a leg gets nowhere, or the next leg would end in a biome with no land
 * animals, and a new heading is scored by how far it leads from the spots
 * already searched and found empty (memory.emptyFoodSpots, kept per world).
 */
const HEADING_SAMPLES = 12;
// How far ahead a heading is judged: a few legs, not just the next one.
const LOOKAHEAD_LEGS = 4;

function legEnd(bot, heading, legs = 1) {
  return bot.entity.position.offset(
    Math.cos(heading) * FORAGE_LEG * legs,
    0,
    Math.sin(heading) * FORAGE_LEG * legs,
  );
}

function barrenAt(bot, pos) {
  const biome = biomeName(bot, pos.floored());
  return !!biome && BARREN.test(biome);
}

/** Distance from where this heading leads to the nearest searched-empty spot. */
function freshness(bot, heading, empties) {
  if (empties.length === 0) return Infinity;
  const ahead = legEnd(bot, heading, LOOKAHEAD_LEGS);
  let nearest = Infinity;
  for (const spot of empties) nearest = Math.min(nearest, Math.hypot(spot.x - ahead.x, spot.z - ahead.z));
  return nearest;
}

function pickForageTarget(bot, ctx = {}) {
  const memory = chaseMemory(ctx);
  if (typeof memory.heading === 'number' && !barrenAt(bot, legEnd(bot, memory.heading))) {
    memory.legs = (memory.legs ?? 0) + 1;
    return legEnd(bot, memory.heading);
  }

  const empties = worldMemory.emptyFoodSpots();
  const offset = Math.random() * Math.PI * 2;
  let best = null;
  for (let i = 0; i < HEADING_SAMPLES; i++) {
    const heading = offset + (i / HEADING_SAMPLES) * Math.PI * 2;
    const barren = barrenAt(bot, legEnd(bot, heading));
    // Fresh ground first; barren only if everything is barren.
    const score = (barren ? -1e6 : 0) + Math.min(freshness(bot, heading, empties), 1e5);
    if (!best || score > best.score) best = { heading, score, barren };
  }
  memory.heading = best.heading;
  memory.legs = 1;
  logger.info(best.barren
    ? 'Nothing but barren ground nearby — heading out regardless'
    : 'Foraging toward new ground', {
    heading: Math.round((best.heading * 180) / Math.PI) % 360,
    emptySpots: empties.length,
  });
  return legEnd(bot, best.heading);
}

/** A leg that got nowhere: turn next time. */
function abandonHeading(ctx) {
  const memory = chaseMemory(ctx);
  memory.heading = null;
  memory.legs = 0;
}

/**
 * Food that grows, for when there is nothing to hunt.
 *
 * Plants need no weapon, do not run away, and a village field is a dozen meals
 * standing still. Only what is edible as picked: carrots, potatoes and
 * beetroot when fully grown, ripe sweet berries, and melon (a block is several
 * slices). Wheat is left, since bread needs a crafting table and three of it.
 */
const PLANT_SEARCH_RADIUS = 32;
const PLANT_BATCH = 6;
const RIPE_AGE = { carrots: 7, potatoes: 7, beetroots: 3, sweet_berry_bush: 2 };
const PLANT_FOOD = [...Object.keys(RIPE_AGE), 'melon'];

function isRipe(block) {
  if (!block) return false;
  if (block.name === 'melon') return true;
  const need = RIPE_AGE[block.name];
  if (need === undefined) return false;
  const age = Number(block.getProperties?.().age ?? -1);
  return age >= need;
}

function ripePlants(bot, radius = PLANT_SEARCH_RADIUS) {
  return findPositions(bot, PLANT_FOOD, radius, PLANT_BATCH, (pos) => isRipe(bot.blockAt(pos)))
    .filter((pos) => !worldMemory.inWaterTrap(pos));
}

async function harvestPlants(bot, task) {
  const spots = ripePlants(bot);
  if (spots.length === 0) return 0;
  let picked = 0;
  for (const pos of spots) {
    const block = bot.blockAt(pos);
    if (!isRipe(block)) continue;
    try {
      // Sweet berry bushes hurt to walk into: pick them from beside.
      await goToBlock(bot, block, task, { within: block.name === 'sweet_berry_bush' ? 2.5 : 2.2, timeoutMs: 15000 });
      if (block.name === 'sweet_berry_bush') {
        await bot.activateBlock(block);
        await sleep(300, task);
        await stepOntoDrop(bot, pos, task);
      } else if (await digBlock(bot, block, task)) {
        await stepOntoDrop(bot, pos, task);
      } else {
        continue;
      }
      picked++;
    } catch (err) {
      if (isInterruption(err)) throw err;
      // Unreachable plant: try the next one.
    }
  }
  if (picked > 0) {
    logger.action('Picked food growing nearby', { plants: picked, stock: foodStock(bot) });
  }
  return picked;
}

/**
 * How much food the bot must BANK, not just how hungry it is.
 *
 * These are different numbers and conflating them deadlocked the descent.
 * `goDeep` refuses to go underground without three food items, because there
 * is nothing to eat at y=16 — but this function only went looking when the
 * larder was at exactly ZERO and the hunger bar was already low. With one or
 * two items in the bag and a full bar, nothing in the entire behavior set
 * would go and get a third: `hunt` needs an animal already within 24 blocks,
 * and `forage` is the only thing that travels to find one.
 *
 * So the bot sat at 22 cobblestone and stone tools with `need: food` on
 * every status line, cycling explore/smelt/collect, permanently one item
 * short of a trip it was otherwise completely ready for. Matching this to
 * what the trip actually requires is what lets it leave.
 */
const STOCK_FOR_TRIP = DEEP_TRIP_NEEDS.food;

/**
 * Two reasons to go looking for food, and only one of them is an emergency.
 *
 * They used to be one behavior at one priority, 46 — above smelting and
 * toolmaking, on the grounds that tools are useless to a corpse. That is true
 * of an EMPTY larder and a falling hunger bar. It is not true of a bot with a
 * full bar and two cooked steaks that would merely like six before a descent.
 *
 * Live on 09-25 the second case ran for six unbroken minutes: full hunger, a
 * stone sword, NINE iron in the bag that smelt and gear never got the wheel to
 * turn into a pickaxe, and "Heading for food {cow, distance 44}" every twenty
 * seconds after the same unreachable cow. Night fell during it; the bot was
 * caught in a forest by three zombies, a skeleton and a creeper and died with
 * the iron still unsmelted.
 *
 * So the emergency keeps its rank and the top-up waits behind the work that
 * actually makes the bot capable. Together they still cover every larder
 * below the trip's requirement — test/thresholds.test.js holds that line.
 */
function larderEmergency(bot) {
  return foodStock(bot) === 0 && (bot.food ?? 20) <= HUNGRY_ENOUGH_TO_LOOK;
}

function larderShortForTrip(bot) {
  return foodStock(bot) < STOCK_FOR_TRIP && !larderEmergency(bot);
}

/**
 * An animal we keep walking toward and never get closer to is not food.
 *
 * "Heading for food" counted as success whenever the bot MOVED, and a leg that
 * fails against a cliff still moves it a few blocks — so the same cow, 44
 * blocks off across terrain pathfinder could not route, was chosen again on
 * every pass for six minutes. Two legs that do not close the gap mean the
 * route is not there; leave that animal alone for a while and look elsewhere.
 */
const CHASE_MIN_GAIN = 4;
const CHASE_STRIKES = 2;
const CHASE_IGNORE_MS = 3 * 60 * 1000;

function chaseMemory(ctx) {
  if (!ctx.forage) ctx.forage = { strikes: new Map(), ignoredUntil: new Map() };
  return ctx.forage;
}

function chaseable(ctx) {
  const memory = chaseMemory(ctx);
  const now = Date.now();
  // An animal down in a remembered water trap is not dinner, it is the way
  // back into the trap.
  return (e) => isFoodAnimal(e) && !((memory.ignoredUntil.get(e.id) ?? 0) > now)
    && !worldMemory.inWaterTrap(e.position);
}

function noteChase(ctx, animal, before, after) {
  const memory = chaseMemory(ctx);
  if (after !== null && before - after >= CHASE_MIN_GAIN) {
    memory.strikes.delete(animal.id);
    return;
  }
  strike(ctx, animal, 'Cannot get any closer to that animal — looking elsewhere', {
    distance: after === null ? 'gone' : Math.round(after),
  });
}

/**
 * A hunt that ran out of time with the animal still alive. Same memory and
 * same two strikes as a chase that gets nowhere: either way, that animal is
 * not dinner, and the next hunt should be after a different one.
 */
function noteFailedKill(ctx, animal) {
  strike(ctx, animal, 'Could not kill that animal — hunting a different one');
}

function strike(ctx, animal, message, details = {}) {
  const memory = chaseMemory(ctx);
  const strikes = (memory.strikes.get(animal.id) ?? 0) + 1;
  if (strikes < CHASE_STRIKES) {
    memory.strikes.set(animal.id, strikes);
    return;
  }
  memory.strikes.delete(animal.id);
  memory.ignoredUntil.set(animal.id, Date.now() + CHASE_IGNORE_MS);
  logger.info(message, {
    animal: animal.name,
    ...details,
    ignoringForSec: CHASE_IGNORE_MS / 1000,
  });
}

/**
 * `why` only changes what the log says. "Hungry underground" was printed
 * ninety-seven times on one world with `food: 20` beside it, because the
 * top-up shares this search — a bot stocking up for a trip is not hungry.
 */
async function searchForFood(bot, ctx, task, why = 'hungry') {
  // Foraging is TRAVEL, so "did it work" means "did we get anywhere".
  //
  // Every branch below used to return true on its own terms, and one of
  // them could satisfy itself without the bot moving a block. Watched live
  // for an entire night: "Heading for food {animal: chicken, distance: 36}"
  // and "Hungry underground — heading for the surface {y: 64}" alternating
  // every three seconds, forever, while the larder stayed at zero. Both
  // reported success, so the no-op backoff never engaged and nothing else
  // ever got the wheel.
  const startedAt = bot.entity.position.clone();
  const moved = () => bot.entity.position.distanceTo(startedAt) > 2;

  // Animals we can see but aren't close enough to hunt yet — minus any we
  // have already proved we cannot close on.
  const distant = nearestWithin(bot, chaseable(ctx), SEARCH_RADIUS);
  // Something growing within reach is a surer meal than an animal to chase.
  if (!distant && await harvestPlants(bot, task) > 0) return true;

  if (distant) {
    const gap = () => bot.entity.position.distanceTo(distant.position);
    const before = gap();
    logger.action('Heading for food', {
      animal: distant.name,
      distance: Math.round(before),
      food: bot.food,
    });
    let reached = false;
    try {
      await goNear(bot, distant.position, 2, task);
      reached = true;
    } catch (err) {
      if (isInterruption(err)) throw err;
      // Couldn't reach it — fall through and search new ground.
    }
    noteChase(ctx, distant, before, distant.isValid ? gap() : null);
    if (reached && moved()) return true;
  }

  // Underground with nothing in sight? Go UP before going anywhere.
  //
  // Animals spawn on grass in daylight, never in the bot's own tunnels, so
  // a horizontal random walk at y=63 searches a volume that by definition
  // contains no food. Observed live: starving at y=63 in a cave system,
  // "Searching for food" over and over while its hunger ran to zero.
  if (shouldClimbForFood(bot)) {
    logger.action(why === 'stocking'
      ? 'Going up to stock food for the trip'
      : 'Hungry underground — heading for the surface', {
      y: Math.round(bot.entity.position.y),
      food: bot.food,
    });
    try {
      // ABOVE the trigger height, not to it. goToHeight is satisfied at
      // `y >= target - 1`, so asking for SURFACE_Y from y=64 is a goal the
      // bot already meets: it returned instantly, having gone nowhere, and
      // the branch above then sent it back to the unreachable chicken. The
      // same mistake, with the same symptom, is documented in resupply.
      await goToHeight(bot, SURFACE_Y + CLIMB_OVERSHOOT, task);
    } catch (err) {
      if (isInterruption(err)) throw err;
      // Couldn't climb — fall through and try moving horizontally.
    }
    if (moved()) return true;
  }

  // Nothing in sight at all: walk somewhere new. Animals spawn on grass in
  // the open, so any movement beats standing still and starving — but not
  // every direction is equally worth walking. Checking the biome a leg ends
  // in is exactly what a player does with F3 open, and it rules out the two
  // headings that waste the most time: an ocean (no land animals, and
  // "water is where this bot goes to die") and a desert (nothing spawns).
  // Nothing to hunt within sight of here: remember it, so no heading leads
  // back this way while the bot is looking.
  worldMemory.noteNoFood(bot.entity.position);
  const target = pickForageTarget(bot, ctx);
  logger.action('Searching for food', {
    food: bot.food, stock: foodStock(bot), legs: chaseMemory(ctx).legs,
  });
  try {
    // A direction, not a place — see goNearXZ for the hillside this broke on.
    await goNearXZ(bot, target, 3, task);
  } catch (err) {
    if (isInterruption(err)) throw err;
  }
  const went = moved();
  if (!went) abandonHeading(ctx);
  return went;
}

/** No food and getting hungry: this outranks everything but survival. */
const forage = {
  name: 'forage',
  // Above gear/smelting: tools are useless to a corpse.
  priority: 46,
  shouldRun(bot) {
    if (!larderEmergency(bot)) return false;
    if (!mayHunt(bot)) return false;
    // If something edible is already close, huntUrgent handles it.
    return !nearestWithin(bot, huntable(bot), HUNT_RANGE);
  },
  run: searchForFood,
};

/**
 * Stocking up for the descent: real work, but not more important than tools.
 *
 * Below gear (40) and smelt (38) so iron in the bag becomes a pickaxe before
 * the bot goes wandering; above everything that digs, because the descent it
 * is stocking for refuses to start without the food.
 */
const forageTopUp = {
  name: 'forageTopUp',
  priority: 34,
  shouldRun(bot) {
    if (!larderShortForTrip(bot)) return false;
    if (!mayStockFood(bot)) return false;
    // Stocking up is not worth climbing out into the night for — the same
    // rule as resupply's, and the same reason: see nightOnTheSurface.
    if (isUnderground(bot) && nightOnTheSurface(bot)) return false;
    return !nearestWithin(bot, huntable(bot), HUNT_RANGE);
  },
  run: (bot, ctx, task) => searchForFood(bot, ctx, task, 'stocking'),
};

/** Out of food and actually hungry — this outranks toolmaking. */
const huntUrgent = {
  name: 'huntUrgent',
  priority: 45,
  shouldRun(bot) {
    if (!needsFoodUrgently(bot)) return false;
    if (!mayHunt(bot)) return false;
    return !!nearestWithin(bot, huntable(bot), HUNT_RANGE);
  },
  run: doHunt,
};

/**
 * Topping up the larder.
 *
 * Priority raised from 12, which put it below every gathering behavior —
 * gatherStone at 28, mine at 25, stripMine at 23. The consequence was
 * visible on the status line: the bot mined 40 cobblestone while its food
 * bar fell from 20 to 1 with an empty larder and cows standing next to it,
 * because nothing would let it stop. By the time `huntUrgent` fired at 12
 * hunger it had to find and kill something while starving.
 *
 * 31 sits above all the gathering and below smelting and crafting, which is
 * the right order: cook and build with what you already have, but if the
 * larder is empty and there is an animal right there, take it before mining
 * another rock.
 *
 * The old hunt-eat deadlock this was demoted for is prevented by the two
 * conditions below, not by the priority — it stops at FOOD_STOCK_TARGET, and stops
 * entirely if there is uncooked meat waiting for the furnace.
 */
const hunt = {
  name: 'hunt',
  priority: 31,
  shouldRun(bot) {
    if (foodStock(bot) >= FOOD_STOCK_TARGET) return false;
    if (!mayStockFood(bot)) return false;

    // Already carrying meat? Cook it rather than killing more animals.
    // Cooking doubles each piece, so a furnace trip is worth more than
    // another hunt — and hunting is the most interruptible thing the bot
    // does, so fewer trips is strictly better.
    if (rawMeatCount(bot) >= RAW_BACKLOG) return false;

    return !!nearestWithin(bot, huntable(bot), HUNT_RANGE);
  },
  run: doHunt,
};

module.exports = {
  hunt,
  huntUrgent,
  forage,
  forageTopUp,
  // For the tests: which larder counts as an emergency decides what outranks
  // toolmaking, and the chase memory decides whether one cow can eat a night.
  larderEmergency, larderShortForTrip, noteChase, noteFailedKill, chaseable, pickPrey,
  // For test/thresholds.test.js: both of these have to stay at or above the
  // descent's food requirement or the bot hunts to one meal short of a trip it
  // is otherwise ready for, forever.
  FOOD_STOCK_TARGET,
  STOCK_FOR_TRIP,
  // For test/progression.test.js: low ground is not underground.
  shouldClimbForFood,
  // For the tests: the search keeps a heading, and knows what is ripe.
  pickForageTarget, abandonHeading, isRipe, RIPE_AGE,
  // For the tests: no hunting before a stone weapon (the user's rule).
  armedForHunting, mayHunt, mayStockFood, CANNOT_SPRINT_FOOD,
};
