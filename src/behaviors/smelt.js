const logger = require('../logger');
const { withDeadline, isInterruption, AbortError } = require('../task');

/**
 * How long any single furnace slot move may take.
 *
 * mineflayer waits on an inventory-update packet for its own twenty seconds,
 * and a window that has desynced never sends one — so a bot at a furnace could
 * stand motionless for a minute working through four slots while the director
 * had no way to take the wheel back. Three seconds is several times a real
 * round trip on a LAN world.
 */
const SLOT_TIMEOUT_MS = 3000;

function slotOp(promise, label, task) {
  return withDeadline(promise, SLOT_TIMEOUT_MS, label, task);
}
const { goToBlock } = require('../nav');
const { ensureTable, ensureSmelter, ensurePlanks } = require('../stations');
const { knownBase } = require('../base');
const {
  findItem, plankNames, hasItem, countAny, itemCount, STONE_MATERIAL,
} = require('../inventory');
const { hasProperFood, COOKED } = require('../eating');
const { larderEmergency, larderShortForTrip } = require('./hunt');
const { foodFacts } = require('../knowledge');
const { missingIronPieces } = require('./gear');

const RAW_TO_COOKED = {
  beef: 'cooked_beef',
  porkchop: 'cooked_porkchop',
  chicken: 'cooked_chicken',
  mutton: 'cooked_mutton',
  rabbit: 'cooked_rabbit',
  cod: 'cooked_cod',
  salmon: 'cooked_salmon',
  potato: 'baked_potato', // 1 hunger raw, 5 baked
};

/**
 * Only iron. Gold and copper were here and neither is on the path to a
 * diamond kit — smelting them costs a furnace trip, a slot, and fuel the bot
 * had to make charcoal for. Watched live: the bot mining copper, carrying
 * copper, and burning logs to turn it into copper ingots it would never spend.
 *
 * Kept as a table rather than a constant because gold becomes worth smelting
 * the moment the nether is in scope, and that is a one-line change here.
 */
const ORE_TO_INGOT = {
  raw_iron: 'iron_ingot',
};

const SMELTABLE = { ...RAW_TO_COOKED, ...ORE_TO_INGOT };

/**
 * Charcoal: fuel the bot can make from logs, with no coal ore at all.
 *
 * It was first added when torches gated the descent (they no longer exist in
 * this bot — see gear.js), and nothing in the bot ever MADE charcoal, so the
 * only fuel and torch route was finding coal ore.
 * Watched live: 120 blocks of strip mining at y=63 hunting for coal, which is
 * exactly the wrong depth to look, while the bot carried logs and stood next
 * to a working furnace the whole time. Iron and diamond sit behind that gate,
 * so it could never get past stone tier.
 *
 * Burning a log is cheap and instant by comparison. The reserve keeps enough
 * back for planks, sticks and fuel so this can't eat the wood supply.
 */
const CHARCOAL_TARGET = 4;
const LOG_RESERVE = 6;

function logStacks(bot) {
  return bot.inventory.items().filter((i) => i.name.endsWith('_log'));
}

function charcoalCandidate(bot) {
  if (countAny(bot, ['coal', 'charcoal']) >= CHARCOAL_TARGET) return null;
  const stacks = logStacks(bot);
  const total = stacks.reduce((sum, i) => sum + i.count, 0);
  if (total <= LOG_RESERVE) return null;
  return stacks[0];
}

/** What a given input turns into, including the log -> charcoal case. */
function smeltOutputName(name) {
  if (name.endsWith('_log')) return 'charcoal';
  return SMELTABLE[name];
}
// How long to stand at the furnace before going and doing something else.
// The furnace keeps working while we're away; a later run collects.
const SMELT_WAIT_MS = 5000;
const OPEN_TIMEOUT_MS = 3000;

/**
 * The raw meat worth cooking FIRST.
 *
 * `findItem` returns whatever sits in the lowest inventory slot, so the bot
 * would cook two mutton before a stack of beef purely by accident. Cooked
 * beef is 8 hunger and 12.8 saturation against mutton's 6 and 9.6, and the
 * furnace is a bottleneck the bot walks back to — so the order genuinely
 * matters. Values from src/knowledge.js.
 */
function bestRawToCook(bot) {
  return bot.inventory.items()
    .filter((i) => RAW_TO_COOKED[i.name])
    .sort((a, b) => {
      const va = foodFacts(RAW_TO_COOKED[a.name])?.saturation ?? 0;
      const vb = foodFacts(RAW_TO_COOKED[b.name])?.saturation ?? 0;
      return vb - va;
    })[0] || null;
}

/**
 * Ore in batches, not one lump at a time.
 *
 * Each smelt is a walk to the furnace, a window transaction and a five-second
 * wait, and the 13:38 session on 09-24 paid that eight times for batches of
 * one and two raw iron — smelt and stripMine taking turns nine times in thirty
 * seconds. So wait for ORE_BATCH, unless what is in the bag would finish the
 * cheapest kit piece still missing and the ingots alone would not: the first
 * iron pickaxe must never wait for eight.
 */
const ORE_BATCH = 8;

function oreWorthABatch(bot) {
  const raw = itemCount(bot, 'raw_iron');
  if (raw === 0) return false;
  if (raw >= ORE_BATCH) return true;
  const missing = missingIronPieces(bot);
  if (missing.length === 0) return false; // nothing left to make: no hurry
  const cheapest = Math.min(...missing);
  const ingots = itemCount(bot, 'iron_ingot');
  return ingots < cheapest && ingots + raw >= cheapest;
}

function smeltableItem(bot) {
  const rawFood = bestRawToCook(bot);
  if (rawFood && !hasProperFood(bot)) return rawFood;

  // Otherwise ore first (it's the progression gate), then food, then wood for
  // charcoal — which is last because it is the least urgent: it is fuel for
  // the next batch, not progress in itself.
  return (oreWorthABatch(bot) ? findItem(bot, (i) => ORE_TO_INGOT[i.name]) : null)
    || rawFood
    || charcoalCandidate(bot)
    || null;
}

/**
 * Fuel, cheapest-first.
 *
 * Coal is deliberately LAST. It is the densest fuel the bot finds (eight
 * items per piece against a plank's one and a half), so it is kept for ore
 * batches — burning it to cook three steaks when there's a stack of logs in
 * the bag is a bad trade.
 */
function fuelItem(bot, excludeType = null) {
  const planks = plankNames(bot);
  // `excludeType` matters when the INPUT is a log: feeding the same stack in
  // as both fuel and input is a window transaction fighting itself, and the
  // furnace ends up with one of the two missing.
  const usable = (i) => i.type !== excludeType;
  return findItem(bot, (i) => i.name === 'charcoal' && usable(i))
    || findItem(bot, (i) => i.name.endsWith('_log') && usable(i))
    || findItem(bot, (i) => planks.includes(i.name) && usable(i))
    || findItem(bot, (i) => i.name === 'coal' && usable(i));
}

/**
 * Can we burn something, even if it needs one crafting step first?
 *
 * The gap this closes: making charcoal means the INPUT is a log, and
 * `fuelItem` then excludes that whole stack from being fuel as well — quite
 * correctly, since one stack cannot be both. A bot whose only fuel-shaped
 * item is the log it wants to smelt therefore reports "no fuel" and never
 * starts, even though four planks are one craft away and planks burn
 * perfectly well.
 *
 * That matters because coal is no longer something the bot goes prospecting
 * for. Charcoal from logs is the fuel supply, and a supply that cannot
 * bootstrap itself is no supply at all — no fuel means no cooked food and no
 * smelted iron.
 */
function canFuel(bot, excludeType = null) {
  if (fuelItem(bot, excludeType)) return true;

  // The input is a log, and it is the only log we hold.
  //
  // That stack can still fuel its own smelting: one of it becomes four
  // planks, and planks are a DIFFERENT item, so they are no longer excluded.
  // Only needs more than one log — and charcoal is never attempted below the
  // six-log reserve anyway, so in practice there is always plenty.
  const sameStack = findItem(bot, (i) => i.name.endsWith('_log') && i.type === excludeType);
  return !!sameStack && sameStack.count > 1;
}

/** Items smelted per unit of fuel, so we don't burn a stack of coal on one steak. */
function itemsPerFuel(name) {
  if (name === 'coal' || name === 'charcoal') return 8;
  if (name === 'lava_bucket') return 100;
  if (name.endsWith('_log') || name.endsWith('_planks')) return 1.5;
  return 1;
}

/**
 * Is a furnace actually obtainable right now? Without this check the
 * behavior would keep being selected, walk to the crafting table, discover
 * it has no cobblestone, and return — over and over, blocking the very
 * gathering behavior that would fix it.
 */
function furnaceReachable(bot) {
  return !!knownBase.furnacePos || hasItem(bot, 'furnace') || countAny(bot, STONE_MATERIAL) >= 8;
}

/**
 * How long a furnace actually takes, so the bot can come back on time.
 *
 * Vanilla: 10 seconds per item in a furnace, 5 in a smoker or blast furnace.
 * The bot used to load the furnace, wait an arbitrary 5 seconds, wander off,
 * and only collect when some unrelated run of `smelt` happened to fire again
 * — which meant cooked food sat in a furnace it had effectively forgotten
 * while the bot went hungry somewhere else.
 *
 * Knowing the finish time turns that into an appointment it can keep.
 */
const SECONDS_PER_ITEM = { furnace: 10, smoker: 5, blast_furnace: 5 };

function cookMs(kindBlockName, count) {
  const each = SECONDS_PER_ITEM[kindBlockName] ?? 10;
  return each * 1000 * Math.max(1, count);
}

/** Is there a batch we put in earlier that should be done by now? */
function collectionDue(ctx) {
  const pending = ctx.smelt?.pending;
  return !!pending && Date.now() >= pending.readyAt;
}

/**
 * The one place a batch is written down or crossed off.
 *
 * Mirrored onto the bot because iron in a furnace is still iron: the ledger
 * that decides whether to keep mining (gear.ironStillNeeded) has no ctx, and
 * without this the count fell by the batch size the moment ore went in —
 * 11 → 9 on 09-24 — and the bot went looking for iron it already had.
 */
function setPending(bot, ctx, batch) {
  ctx.smelt.pending = batch;
  bot.smeltingBatch = batch;
}

/**
 * Walk to the exact station holding our pending batch.
 *
 * Returns null — and lets the caller fall back — if the block is gone, which
 * happens if the bot packed the furnace up or something else broke it. In
 * that case the appointment is stale and should be dropped rather than
 * chased.
 */
const SMELTER_NAMES = ['furnace', 'smoker', 'blast_furnace'];

async function goToPendingStation(bot, ctx, task) {
  const pending = ctx.smelt?.pending;
  if (!pending?.at) return null;

  const block = bot.blockAt(pending.at);
  if (!block || !SMELTER_NAMES.includes(block.name)) {
    logger.info('The furnace I left a batch in is gone', { at: pending.at });
    setPending(bot, ctx, null);
    return null;
  }

  try {
    await goToBlock(bot, block, task, { timeoutMs: 30000 });
  } catch (err) {
    if (isInterruption(err)) throw err;
    logger.info('Could not get back to the furnace', { at: pending.at, reason: err.message });
    return null;
  }
  return block;
}

const smelt = {
  name: 'smelt',
  priority: 38,
  shouldRun(bot, ctx) {
    // A batch we already started and that should be finished is worth a trip
    // on its own — there may be nothing left to load, and the whole point is
    // not to abandon food in a furnace.
    if (collectionDue(ctx)) return furnaceReachable(bot);

    // A BATCH ALREADY COOKING IS A REASON TO GO AWAY, not a reason to run.
    //
    // Without this the behavior spun. run() opens the furnace, finds its own
    // input already in there, "resumes" it, waits five seconds, gives up with
    // "still smelting — will collect later" and reports success — which is
    // honest, loading a furnace IS work, but it also clears the no-op backoff.
    // So the director picks `smelt` again immediately and the whole thing
    // repeats. Watched live on the very first minute of a run: four rounds of
    // `Smelting {resumed: true}` in twenty seconds, with the appointment being
    // rewritten each time and nothing else getting a turn.
    //
    // The appointment already says when to come back. Until then there is
    // nothing this behavior can usefully do.
    if (ctx.smelt?.pending) return false;

    // Ask about fuel with the SAME exclusion run() will use, or this says yes
    // to a job run() then refuses — which the director scores as a no-op and
    // backs the behavior off for.
    const raw = smeltableItem(bot);
    if (!raw || !canFuel(bot, raw.type)) return false;
    return furnaceReachable(bot);
  },
  // `waitMs` is for the night workshop in shelter.js, which has nowhere to be
  // and waits for the whole batch rather than leaving an appointment behind.
  async run(bot, ctx, task, { waitMs = SMELT_WAIT_MS } = {}) {
    const raw = smeltableItem(bot);
    let fuel = fuelItem(bot, raw?.type ?? null);
    const due = collectionDue(ctx);

    // Nothing burnable in hand, but a log we could turn into planks — do it.
    // See canFuel: without this the charcoal supply cannot bootstrap itself.
    if (raw && !fuel && canFuel(bot, raw.type)) {
      await ensurePlanks(bot, 2);
      task.throwIfAborted();
      fuel = fuelItem(bot, raw.type);
      if (fuel) logger.info('Made planks to burn', { for: raw.name });
    }

    // Nothing new to load, but a batch we started earlier is ready — go and
    // get it. Without this branch the bot could only ever collect by
    // accident, on some later run that happened to have something else to
    // smelt, and food it had already cooked sat forgotten in the furnace.
    if ((!raw || !fuel) && !due) return false;

    // A pure collection trip needs no crafting table.
    //
    // ensureTable walks the bot all the way to one, and on a trip whose only
    // purpose is emptying a furnace that is a detour to a building we do not
    // need — sometimes a long one, since the table and the furnace are not
    // always together. It is only needed when a smelter might have to be
    // CRAFTED, which is exactly the case where there is something to load.
    //
    // And even then only if one actually gets crafted, so it is handed over as
    // a getter rather than fetched up front. Fetching it first meant every
    // loading trip began by walking to, retrieving or building a table, with a
    // furnace standing right there — see NO_TABLE in src/stations.js.
    const needsTable = !!raw && !!fuel;
    let tableLookup = null;
    const getTable = needsTable
      ? () => {
        tableLookup = tableLookup ?? ensureTable(bot, ctx, task);
        return tableLookup;
      }
      : async () => null;

    // Pick the smelter that suits the job — a smoker cooks food twice as
    // fast as a furnace, which is the difference between keeping up with
    // hunting and constantly falling back on raw meat. ensureSmelter walks us
    // there and falls back to a plain furnace if the fast one isn't
    // available, so this never blocks progress.
    //
    // A smoker only cooks food and a blast furnace only does ores — neither
    // will take a log, so wood falls through to that plain-furnace default.
    let kind = 'wood';
    if (raw && RAW_TO_COOKED[raw.name]) kind = 'food';
    else if (raw && ORE_TO_INGOT[raw.name]) kind = 'ore';

    // Collecting a pending batch goes to the REMEMBERED station, not to
    // whichever one `kind` would pick.
    //
    // The appointment records where the batch actually is, and that is the
    // only address that can collect it. Re-deriving the station from `kind`
    // sends the bot to the wrong building whenever the batch is in a smoker
    // or blast furnace — and when there is nothing new to smelt, `raw` is
    // null and `kind` falls through to 'wood', i.e. a plain furnace, every
    // single time. The whole point of the appointment is not to forget where
    // the food is; walking confidently to the wrong place is the same
    // failure wearing a schedule.
    const furnaceBlock = due
      ? (await goToPendingStation(bot, ctx, task)
        ?? await ensureSmelter(bot, ctx, task, getTable, kind))
      : await ensureSmelter(bot, ctx, task, getTable, kind);
    if (!furnaceBlock) return false;

    task.throwIfAborted();

    // Opening a container waits on a window packet and can hang if the
    // server never sends one — the same class of stall as craft and equip.
    let furnace;
    try {
      furnace = await withDeadline(
        bot.openFurnace(furnaceBlock), OPEN_TIMEOUT_MS, 'open furnace', task,
      );
    } catch (err) {
      logger.info('Could not open the furnace', { error: err.message });
      return false;
    }
    let onUpdate = null;
    // Whether this visit actually moved anything — see the catch below.
    let didSomething = false;
    try {
      // A furnace we've used before may still hold output, fuel, or a
      // half-finished input. Blindly putting more in fails with "destination
      // full", and a failed attempt leaves its items behind — so every
      // subsequent try failed the same way, forever. Clear it out first.
      if (furnace.outputItem()) {
        // Every furnace slot move is a window transaction with mineflayer's
        // own twenty-second internal timeout, and all of these were bare. A
        // desynced window therefore froze the bot at the furnace for twenty
        // seconds per slot, with the director unable to take the wheel back —
        // the same shape of stall as the crafting hang.
        const got = await slotOp(furnace.takeOutput(), 'take output', task);
        didSomething = true;
        setPending(bot, ctx, null); // appointment kept
        logger.action('Collected from the furnace', {
          item: got?.name ?? 'output',
          count: got?.count ?? 1,
        });
      }

      // Came back purely to collect and there is nothing to load — done.
      if (!raw || !fuel) {
        setPending(bot, ctx, null);
        return true;
      }

      const alreadySmelting = furnace.inputItem();
      const batch = alreadySmelting
        ? alreadySmelting.count
        : Math.min(raw.count, 8);

      if (!furnace.fuelItem()) {
        // Size the fuel to the job. The old `ceil(batch / 2)` burned four
        // coal on an eight-item batch that one coal covers.
        const needed = Math.max(1, Math.ceil(batch / itemsPerFuel(fuel.name)));
        await slotOp(furnace.putFuel(fuel.type, null, Math.min(needed, fuel.count)), 'put fuel', task);
      }
      if (!alreadySmelting) {
        await slotOp(furnace.putInput(raw.type, null, batch), 'put input', task);
      }
      // Write down when this will be ready and where it is, so the trip back
      // is a decision rather than a coincidence.
      const readyInMs = cookMs(furnaceBlock.name, batch);
      setPending(bot, ctx, {
        at: furnaceBlock.position.clone(),
        readyAt: Date.now() + readyInMs,
        expecting: smeltOutputName(raw.name),
        count: batch,
      });
      didSomething = true; // the furnace is loaded and cooking

      logger.action('Smelting', {
        input: raw.name,
        count: batch,
        in: furnaceBlock.name,
        resumed: !!alreadySmelting,
        readyInSec: Math.round(readyInMs / 1000),
      });

      const expected = smeltOutputName(raw.name);

      // Wait only a short while, then walk away.
      //
      // Smelting a stack takes minutes of game time, and standing at the
      // furnace for all of it is dead time — the furnace keeps burning
      // whether the bot watches it or not. This behavior re-runs later and
      // collects whatever finished (the "resume" path above handles a
      // furnace that's already loaded), so a short visit is strictly better
      // than a long vigil.
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('still smelting — will collect later')), waitMs);
        let unwatchAbort = null;
        const finish = (fn, arg) => {
          clearTimeout(timer);
          // The listener MUST be removed — the old code left one attached per
          // smelt, which leaked and let stale listeners resolve later runs.
          if (onUpdate) furnace.removeListener('update', onUpdate);
          // ...and so must the abort listener, which was not. It stayed on the
          // task for the rest of the behavior, holding the furnace and this
          // whole closure alive.
          if (unwatchAbort) unwatchAbort();
          fn(arg);
        };
        onUpdate = () => {
          const out = furnace.outputItem();
          if (out && out.count >= batch) finish(resolve);
        };
        furnace.on('update', onUpdate);
        unwatchAbort = task.onAbort(() => finish(reject, new Error('aborted')));
        onUpdate(); // in case it's already done
      });

      await slotOp(furnace.takeOutput(), 'take output', task);
      // Collected in the same visit, so there is no appointment to keep. Left
      // set, it sent the bot back later to an empty furnace — and blocked the
      // night workshop from starting another batch.
      setPending(bot, ctx, null);
      logger.action('Collected smelted output', { output: expected });
      return true;
    } catch (err) {
      // Preempted: hand the wheel back NOW. This used to go on to empty the
      // output slot first — a window transaction of up to three seconds — for
      // a behavior that had just been told something more urgent was waiting,
      // and then report the interruption as ordinary success. The output is
      // safe where it is; the appointment still points at it.
      if (task.aborted) throw new AbortError(task.reason);

      // Grab whatever finished before walking away.
      try {
        if (furnace.outputItem()) {
          await slotOp(furnace.takeOutput(), 'take output', null);
          didSomething = true;
        }
      } catch {
        // nothing to collect
      }
      // Not finishing in one visit is the normal case now, not a failure —
      // loading the furnace IS work, and the director must not back the
      // behavior off for it. But only if something was actually loaded or
      // collected: a fuel or input move that timed out left the furnace
      // exactly as it was, and "success" then had smelt picked straight back
      // up to fail the same way, again and again, with the backoff never
      // engaging.
      logger.info(didSomething ? 'Leaving the furnace running' : 'Could not load the furnace', {
        reason: err.message,
      });
      return didSomething;
    } finally {
      if (onUpdate) furnace.removeListener('update', onUpdate);
      furnace.close();
    }
  },
};

/**
 * Cooked food we already made, sitting in our own furnace, while we go hungry.
 *
 * Fresh world, 09-25 17:00:52: three chickens into a furnace, ready in thirty
 * seconds, and the bot walked off to hunt and then to an iron vein. Collecting
 * is `smelt`'s job at 38, below `valuables`, `gear`, `huntUrgent` and
 * `forage` — so it never got the wheel back. By dusk the larder was empty,
 * food was 10, health 6, and the bot had spent two minutes chasing live
 * chickens while three cooked ones waited in its own furnace. It went into
 * the night too hurt to do anything but wait.
 *
 * So when the larder is short, the trip back to a finished batch of food is
 * its own behavior, above foraging and above wood: it is the cheapest food
 * there is. Bounded by distance so a furnace left at the far end of the map
 * does not drag the bot back across it.
 */
const FETCH_COOKED_MAX_DISTANCE = 64;

function cookedFoodWaiting(bot, ctx) {
  const pending = ctx.smelt?.pending;
  if (!pending?.at || !COOKED.includes(pending.expecting)) return false;
  if (!collectionDue(ctx)) return false;
  return bot.entity.position.distanceTo(pending.at) <= FETCH_COOKED_MAX_DISTANCE;
}

const fetchCooked = {
  name: 'fetchCooked',
  priority: 48,
  shouldRun(bot, ctx) {
    if (!larderEmergency(bot) && !larderShortForTrip(bot)) return false;
    return cookedFoodWaiting(bot, ctx);
  },
  // Actually hungry with food ready: worth breaking off a dig for.
  canInterrupt: (bot, ctx) => larderEmergency(bot) && cookedFoodWaiting(bot, ctx),
  run: (bot, ctx, task) => smelt.run(bot, ctx, task),
};

/** Is the next thing smelt would load ore — the batch a new pickaxe waits on? */
function oreIsNext(bot) {
  const raw = smeltableItem(bot);
  return !!raw && !!ORE_TO_INGOT[raw.name];
}

module.exports = {
  smelt,
  fetchCooked,
  oreIsNext, cookMs,
  // Exported for the tests: what goes in the furnace, and what burns, decides
  // how fast raw iron becomes a pickaxe.
  smeltableItem, oreWorthABatch, ORE_BATCH,
  fuelItem,
  canFuel,
  smeltOutputName,
  LOG_RESERVE,
};
