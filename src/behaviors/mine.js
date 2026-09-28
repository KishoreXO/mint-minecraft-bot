const { Vec3 } = require('vec3');
const logger = require('../logger');
const config = require('../config');
const jevClient = require('../jevClient');
const { isInterruption, sleep } = require('../task');
const {
  goToBlock, goNear, stepTo, goToHeight, groundUnder, feetCell,
} = require('../nav');
const { isUnderground, timeInfo, SURFACE_Y } = require('../world');
const {
  canHarvest, TOOL_TIERS, ORE_BLOCKS, yieldOf,
} = require('../knowledge');
const { isUnwantedOre } = require('../stock');
const { MAX_BEHAVIOR_MS } = require('../director');
const memory = require('../memory');
const lag = require('../lag');
const { findNearestTiered } = require('../blocks');
const { touchingLava, lavaNearBody } = require('../lava');
const {
  digBlock, inventorySummary, bestToolOfType, countAny, stepOntoDrop,
  itemCount, toolIsWornOut, armorSummary, woodUnits, durabilityLeft, bestWeapon, GRAVEL_SETTLE_MS,
  STONE_MATERIAL,
} = require('../inventory');
const {
  ironInvested, diamondInvested, hasIronPickaxe, ironStillNeeded,
} = require('./gear');
const { EDIBLE } = require('./survive');

/**
 * Two different things, deliberately kept apart:
 *
 *  - `mine`  — ORES only. "I'm walking past iron ore and already have 12
 *    ingots, is the detour worth it?" is a genuine judgement call, so Jev
 *    decides.
 *  - `gatherStone` — plain stone, purely deterministic. "I need 8 cobblestone
 *    for a furnace" isn't a judgement call, it's arithmetic. Routing this
 *    through Jev would mean asking the model about the single most common
 *    block in the game over and over for no decision value (and a lot of
 *    API calls).
 */

// Derived from knowledge.js's ORE_YIELD, the one table of what ore drops.
const ORES = ORE_BLOCKS;

// ONLY blocks that actually yield usable stone material. Granite, diorite,
// andesite and tuff all *look* like stone and are everywhere underground,
// but they drop themselves — none of them satisfy the furnace recipe or the
// stone tool material tag. Including them meant the bot happily mined
// hundreds of blocks while its cobblestone count never moved.
const STONE = ['stone', 'cobblestone', 'deepslate', 'cobbled_deepslate', 'blackstone'];

// What counts toward the stone-material target once mined is inventory.js's
// STONE_MATERIAL — this file had its own copy of the same list.

// Stand this close before mining something we want to keep. Digging reach is
// 4.5, but an item dropped at that distance routinely lands somewhere the
// bot can't then walk to, and despawns.
const GATHER_REACH = 2.4;

/**
 * How far a player can dig: the block_interaction_range attribute, 4.5 by
 * default, measured from the EYES.
 *
 * The ore sweep measured from the feet to a block's corner against 4.2, which
 * is not the same shape at all. It read ore up in a wall, or on the −x/−z side
 * of the bot, as further than it was, and skipped it: live on 09-24 the bot
 * left a column of iron in the wall at y=18–19 beside a tunnel at y=16–17.
 */
const DIG_REACH = 4.5;
const EYE_HEIGHT = 1.62;

function eyeReachTo(bot, pos) {
  return bot.entity.position.offset(0, EYE_HEIGHT, 0).distanceTo(pos.offset(0.5, 0.5, 0.5));
}

// How far above our feet an ore can be and still be worth going for: close
// enough to dig from the floor directly beneath it. This was a flat 2 —
// "anything more means climbing" — but a block at +4 is within dig reach of a
// bot standing under it, and a cave wall's ore is mostly that high.
const UPWARD_ORE_LIMIT = Math.floor(DIG_REACH - 0.5);

/**
 * How long one mining run may take: well inside the director's deadlock
 * breaker, with room for the pickup after the last dig. A run cut off at
 * sixty seconds is scored as wedged and benched for fifteen — on 09-24 that
 * happened to `mine` halfway through a diamond vein, and the bot explored
 * away from the rest of it. Derived, so the two cannot drift apart.
 */
const WORK_BUDGET_MS = MAX_BEHAVIOR_MS - 15000;

/**
 * Close first, then wider — see findNearestTiered in blocks.js.
 *
 * findBlocks only stops early once it has enough hits AND has finished the
 * layer it is on, so a search that finds NOTHING scans every section in
 * range. Underground, where ore is sparse and most searches come up empty,
 * that is the worst case and it was running several times a second on the
 * same thread as pathfinding and combat.
 */
const ORE_SEARCH_RADII = [16, 32];
const STONE_SEARCH_RADII = [10, 24];
const SCAN_THROTTLE_MS = 700;
/**
 * Longer pause after a sweep that ran its radius out — the expensive case.
 *
 * Measured by the stall instrumentation at up to 1891ms for a single radius-16
 * sweep. At a 2.2-second throttle that was most of the bot's thread, so the
 * pause is now long AND, when there is also no answer to act on, gated on
 * having moved (see RESCAN_AFTER_MOVING).
 *
 * Safe to make this long only because dropCandidate re-opens the scan the
 * instant the cached answer stops being valid. Without that pairing a six
 * second throttle is six seconds of the bot insisting there is no ore.
 */
const EXHAUSTIVE_SCAN_THROTTLE_MS = 6000;
/** How far the bot must travel before an empty sweep is worth repeating. */
const RESCAN_AFTER_MOVING = 12;
const SKIP_MEMORY_MS = 30000;

/**
 * How long a target stays off the list after the way to it failed — which is
 * a fact about the route, and routes do not change in thirty seconds.
 *
 * SKIP_MEMORY_MS is right for Jev saying "skip": that is an opinion about this
 * ore, worth asking again soon. It was also what a navigation failure got, so
 * between 15:46 and 15:50 on 09-24 `valuables` walked at the same iron up a
 * ravine wall six times — "Going for it {distance: 31}", "no route" — with
 * `resupply` climbing back out between attempts.
 */
const UNREACHABLE_MEMORY_MS = 5 * 60 * 1000;
const UNREACHABLE = /no route|navigation stalled|navigation timed out/;
/**
 * ...and longer when the way there went through lava. At 15:36 on 09-24 the
 * bot was pulled out of a pool on the way to a diamond and `valuables` sent it
 * straight back along the same route a second later. It did not come out
 * twice.
 */
const LAVA_ROUTE_MEMORY_MS = 10 * 60 * 1000;

function burning(bot) {
  const flags = bot.entity?.metadata?.[0];
  return typeof flags === 'number' && (flags & 0x01) !== 0;
}

/** Keep a failed target off the list for as long as the failure says. */
/**
 * The rest of the vein a target belongs to: connected blocks of the same ore.
 *
 * A route failure is a fact about getting THERE, and every block in a vein is
 * there. Blacklisting only the one block that was aimed at meant the next pass
 * picked its neighbour and walked the same dead route again: live on 09-24,
 * `valuables` went for one iron vein six times in three minutes, "no route"
 * every time, each attempt a fresh block of the same cluster.
 *
 * Bounded both ways — a vein is small, and this runs on the bot's thread.
 */
const VEIN_RADIUS = 4;
const VEIN_MAX = 32;

function veinOf(bot, key) {
  const [x, y, z] = key.split(',').map(Number);
  const origin = bot.blockAt?.(new Vec3(x, y, z));
  if (!origin || !/_ore$/.test(origin.name)) return [key];
  const seen = new Set([key]);
  const queue = [origin.position];
  while (queue.length > 0 && seen.size < VEIN_MAX) {
    const at = queue.shift();
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        for (let dz = -1; dz <= 1; dz++) {
          const next = at.offset(dx, dy, dz);
          const k = posKey(next);
          if (seen.has(k)) continue;
          if (Math.abs(next.x - x) > VEIN_RADIUS || Math.abs(next.y - y) > VEIN_RADIUS
            || Math.abs(next.z - z) > VEIN_RADIUS) continue;
          if (bot.blockAt(next)?.name !== origin.name) continue;
          seen.add(k);
          queue.push(next);
        }
      }
    }
  }
  return [...seen];
}

function rememberFailedTarget(bot, ctx, key, err, interrupted) {
  let forMs = null;
  if (interrupted) {
    if (touchingLava(bot) || lavaNearBody(bot, 1) || burning(bot)) forMs = LAVA_ROUTE_MEMORY_MS;
  } else {
    forMs = UNREACHABLE.test(err?.message ?? '') ? UNREACHABLE_MEMORY_MS : SKIP_MEMORY_MS;
  }
  if (forMs === null) return;
  // A route problem rules out the whole vein; anything else is about this block.
  const keys = forMs === SKIP_MEMORY_MS ? [key] : veinOf(bot, key);
  for (const k of keys) ctx.mine.skipped.set(k, Date.now() + forMs);
  if (keys.length > 1) {
    logger.info('No way to that vein — leaving all of it', {
      at: key, blocks: keys.length, forMin: forMs / 60000,
    });
  }
  if (forMs === LAVA_ROUTE_MEMORY_MS) {
    logger.info('The way to that ore ran through lava — leaving it', { at: key, forMin: forMs / 60000 });
  }
}

/**
 * Enough for a furnace (8), a full set of stone tools, and the blocks the
 * descent needs to pillar and bridge with.
 *
 * Must not sit BELOW DEEP_TRIP_NEEDS.placeable. `goDeep` refuses to start while
 * `needsCobble` is true, and `deepTripShortfall` refuses while the blocks are
 * short — so a target lower than the requirement is a deadlock with each half
 * waiting on the other. Cobblestone is also the cheapest thing the bot gathers,
 * so the headroom costs almost nothing.
 */
const COBBLE_TARGET = 40;

function posKey(pos) {
  return `${pos.x},${pos.y},${pos.z}`;
}

/**
 * Throwing the candidate away and re-opening the scan are ONE action.
 *
 * findOre hands back `ctx.mine.candidate` unchanged while the throttle is
 * running, so clearing the candidate on its own does not mean "find me
 * another one" — it means "answer null for the next 700ms" (6000 after an
 * exhaustive sweep). Every site that drops a candidate does so because it
 * just blacklisted that ore, which is exactly the moment the cached answer
 * became known-wrong: the bot then reports nothing to mine while standing in
 * a vein it has not looked at yet.
 *
 * stripMine already knew this and reset both by hand (see the comment above
 * its findOre call). The three sites in `mine` itself reset only one. Making
 * it a single call is the only way the pair stops drifting apart.
 */
function dropCandidate(ctx) {
  ctx.mine.candidate = null;
  ctx.mine.lastScanAt = 0;
}

/**
 * Is this block actually approachable? Since pathfinder no longer tunnels,
 * ore fully encased in stone can't be reached — and repeatedly selecting it
 * meant asking Jev about it, walking at it, and timing out, over and over.
 */
function isExposed(bot, pos) {
  const sides = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];
  return sides.some(([dx, dy, dz]) => {
    const neighbour = bot.blockAt(pos.offset(dx, dy, dz));
    return neighbour && neighbour.boundingBox === 'empty' && neighbour.name !== 'lava';
  });
}

/**
 * The same questions, answered from state ids — for the filter a scan runs on
 * every ore it passes.
 *
 * Filtering inside the scan made count mean "ore we would actually take", which
 * is what found the diamond; it also means a scan that cannot fill its count
 * reads the whole radius. And the filter asked bot.blockAt for everything —
 * the name, then six neighbours for exposure — and each call builds a full
 * Block object. On the surface, where every stone wall is seeded with coal and
 * iron, that was thousands of hits and nine Block objects apiece: "Event loop
 * stalled … findBlocks r32 912ms worst / 2196ms in 5" at 15:47:27 on 09-24,
 * during `valuables`. A bot that cannot react for a second cannot react to
 * lava either.
 *
 * The scan already holds the state id of the ore; the neighbours are one
 * integer read each. Unloaded neighbours count as nothing, as blockAt's null
 * did — the world answers 0 (air) for them, which would call ore exposed.
 */
const openStatesByRegistry = new WeakMap();

function openStates(registry) {
  let open = openStatesByRegistry.get(registry);
  if (!open) {
    open = new Set();
    for (const block of registry.blocksArray ?? []) {
      if (block.boundingBox !== 'empty' || block.name === 'lava') continue;
      for (let id = block.minStateId; id <= block.maxStateId; id++) open.add(id);
    }
    openStatesByRegistry.set(registry, open);
  }
  return open;
}

function nameFromState(bot, pos, stateId) {
  if (stateId !== undefined) {
    const block = bot.registry?.blocksByStateId?.[stateId];
    if (block) return block.name;
  }
  return bot.blockAt(pos)?.name;
}

const SIDES = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];

function exposedFast(bot, pos) {
  const world = bot.world;
  if (typeof world?.getBlockStateId !== 'function' || typeof world.getColumnAt !== 'function'
    || !bot.registry?.blocksArray) {
    return isExposed(bot, pos);
  }
  const open = openStates(bot.registry);
  return SIDES.some(([dx, dy, dz]) => {
    const p = pos.offset(dx, dy, dz);
    if (!world.getColumnAt(p)) return false;
    return open.has(world.getBlockStateId(p));
  });
}

/**
 * Write down ore we can see and cannot yet collect.
 *
 * memory.noteOre was only ever called from digBlock's refusal, so ore the bot
 * merely SAW — a diamond in a cave wall, with a stone pickaxe in hand — was
 * forgotten the moment it turned away. The notebook is what brings it back
 * when the pickaxe improves (see the fallback at the end of findOre).
 */
function noteForLater(bot, pos) {
  const block = bot.blockAt(pos);
  if (!block) return; // noteOre ignores a position it already has
  memory.noteOre(pos, block.name, 'better pickaxe');
}

function findOre(bot, ctx) {
  const now = Date.now();
  const throttle = ctx.mine.lastScanExhaustive
    ? EXHAUSTIVE_SCAN_THROTTLE_MS
    : SCAN_THROTTLE_MS;
  if (now - ctx.mine.lastScanAt < throttle) return ctx.mine.candidate;

  // AN EMPTY ANSWER FROM THE SAME SPOT IS STILL EMPTY.
  //
  // findBlocks walks whole 16-block sections and can only stop early once it
  // has enough HITS, so a sweep that finds nothing is the expensive one — and
  // on the surface, where there is no iron at all, every sweep finds nothing.
  // The stall instrumentation measured a single radius-16 ore sweep at 1891ms,
  // repeating on a 2.2-second throttle: nearly half the bot's thread spent
  // re-proving there is no iron at y=70.
  //
  // Standing still and asking again cannot produce a different answer. Moving
  // can. So after an empty sweep, wait until the bot has actually gone
  // somewhere before paying for another one.
  const from = ctx.mine.lastScanFrom;
  if (ctx.mine.lastScanEmpty
    && from
    && bot.entity.position.distanceTo(from) < RESCAN_AFTER_MOVING) {
    return null;
  }

  ctx.mine.lastScanAt = now;
  ctx.mine.lastScanFrom = bot.entity.position.clone();

  // X-ray widens the search and allows acting on ore the bot could not
  // legitimately see. findBlocks itself has ALWAYS been x-ray — it reads
  // block data with no line-of-sight check — so the switch controls what we
  // do with the result, not whether we get one.
  const { xray, xrayRadius } = config.cheats;
  const radii = xray
    ? [16, 32, Math.min(xrayRadius, 64)]
    : ORE_SEARCH_RADII;

  // What the search counts: an ore we have not blacklisted, that is worth
  // having, that is not well above us, and — without x-ray — that we can
  // actually see. Applied INSIDE the scan (see findPositions): filtering after
  // the fact let sixteen buried ore fill the list, and the exposed diamond
  // behind them was never considered. Live on 09-24: eight minutes, iron
  // pickaxe in hand, diamond in view.
  //
  // Ore the pickaxe cannot harvest yet is still ACCEPTED when it is important,
  // so the loop below can write it down — see noteForLater.
  const myYNow = bot.entity.position.y;
  const tierPick = bestToolOfType(bot, 'pickaxe')?.name.split('_')[0] ?? null;
  const wanted = new Map(); // per scan: stockOf is not free, and names repeat
  const worthHaving = (name) => {
    if (!wanted.has(name)) wanted.set(name, wantThisOre(bot, name));
    return wanted.get(name);
  };
  const harvestableName = (name) => !name || !tierPick || canHarvest(tierPick, name);
  const harvestable = (pos) => harvestableName(bot.blockAt(pos)?.name);

  const importance = new Map(); // same reasoning: neededResource per position adds up
  const importantName = (name = '') => {
    if (!importance.has(name)) importance.set(name, mustHave(bot, name));
    return importance.get(name);
  };
  const important = (pos) => importantName(bot.blockAt(pos)?.name);

  // Cheapest question first, and exposure — six reads — last. See exposedFast.
  const accept = (pos, stateId) => {
    const until = ctx.mine.skipped.get(posKey(pos));
    if (until && until >= now) return false;
    if (pos.y - myYNow > UPWARD_ORE_LIMIT) return false;
    const name = nameFromState(bot, pos, stateId);
    // Worth having AT ALL — lapis, copper, redstone and gold are none of them
    // a step toward a diamond kit, and walking to one only to decline it a
    // moment later is the same wasted trip with an extra decision in it.
    if (name && !worthHaving(name)) return false;
    if (!harvestableName(name) && !importantName(name)) return false;
    return xray || exposedFast(bot, pos);
  };

  const count = xray ? 48 : 16;
  const found = findNearestTiered(bot, ORES, radii, count, accept);

  // Fewer hits than asked for means the sweep ran to the end of its radius.
  //
  // findBlocks can only break early once it holds `count` positions, so the
  // cost of a sweep is not "how much ore is there" but "did it reach the
  // count" — a sweep that returns three ores did exactly the same work as one
  // that returned none. Underground that is the NORMAL case, not the edge
  // case: ore is sparse, sixteen of it inside sixteen blocks is rare, and the
  // whole cheap-first-tier idea quietly stops applying. The long throttle was
  // gated on finding nothing, which covered the loud version of this and
  // missed the common one.
  ctx.mine.lastScanEmpty = found.length === 0;
  ctx.mine.lastScanExhaustive = found.length < count;

  // The goal before the nearest. Diamond, and iron while the kit needs it,
  // are what the whole run is for — a coal seam two blocks closer must not
  // win the only slot. Stable, so distance still orders within each class.
  const ordered = [...found].sort((a, b) => Number(important(b)) - Number(important(a)));

  let buried = null;
  let pick = null;
  const pickTier = tierPick;

  for (const pos of ordered) {
    // Seen, important, and our pickaxe would destroy it for nothing — a
    // diamond under a stone pickaxe drops NOTHING. Never dig it; write it
    // down, so the notebook brings the bot back the moment the tier allows.
    if (!harvestable(pos)) {
      noteForLater(bot, pos);
      continue;
    }

    if (xray && !isExposed(bot, pos)) {
      // Buried ore is the x-ray-only case: nothing about it is visible from
      // where the bot stands. With x-ray on, everything is worth the trip —
      // the tunnel is short because we know exactly where to aim.
      if (!buried) buried = { pos, exposed: false };
      continue;
    }
    pick = { pos, exposed: true };
    break; // reachable ore always wins
  }

  // Nothing in range? Check the notebook.
  //
  // Ore the bot walked away from because its pickaxe was too soft is already
  // located, and finding ore is the expensive half of mining. The moment the
  // tier improves those notes become the cheapest ore in the world — no
  // searching, no strip mining, just a walk to a known coordinate. They
  // survive restarts, so a vein spotted an hour ago in a previous session is
  // still worth collecting.
  if (!pick && !buried && pickTier) {
    // Only ore still worth having — a note is a location, not a reason, and a
    // copper note from before this rule, or iron past its target, is neither.
    const worthIt = (ore) => canHarvest(pickTier, ore) && wantThisOre(bot, ore);
    for (const note of memory.harvestableNotes(worthIt)) {
      if (ctx.mine.skipped.get(posKey(note.pos))) continue;
      const block = bot.blockAt(note.pos);
      if (!block) continue;
      // It may have been mined, or have been a stale note from before.
      if (!/_ore$/.test(block.name)) {
        memory.forgetOre(note.pos);
        continue;
      }
      // findOre runs several times a second; say this once per vein, not
      // once per scan.
      if (ctx.mine.lastNoteLogged !== note.key) {
        ctx.mine.lastNoteLogged = note.key;
        logger.action('Going back for ore I noted earlier', {
          ore: block.name,
          at: note.pos,
          nowUsing: `${pickTier} pickaxe`,
        });
      }
      ctx.mine.candidate = { block, exposed: isExposed(bot, note.pos), fromNote: true };
      return ctx.mine.candidate;
    }
  }

  const chosen = pick || buried;
  ctx.mine.candidate = chosen
    ? { block: bot.blockAt(chosen.pos), exposed: chosen.exposed }
    : null;
  return ctx.mine.candidate;
}

/**
 * Whether a given ore is worth mining is a question about the ore TYPE and
 * our current stock — not about one specific block. Caching per block meant
 * re-asking for every block in a vein, roughly once a second, and getting
 * near-random low-confidence answers that contradicted each other.
 */
const ORE_VERDICT_TTL_MS = 25000;

function cachedOreVerdict(ctx, oreName) {
  const entry = ctx.mine.verdicts.get(oreName);
  if (!entry) return null;
  return Date.now() - entry.at < ORE_VERDICT_TTL_MS ? entry.decision : null;
}

/**
 * Where each ore actually is, post-1.18.
 *
 * The 1.18 "Caves & Cliffs" world generation replaced the old uniform ore
 * spread with triangular distributions that peak at specific depths, and
 * mining at the wrong Y is the single biggest time-waster available to a
 * Minecraft bot — you can strip-mine at y=40 for an hour and see one
 * diamond, because there essentially aren't any up there.
 *
 *   diamond/redstone  peak at y=-59 (and diamond only gets commoner all the
 *                     way down to bedrock)
 *   gold              peak at y=-16
 *   lapis             peak at y=0
 *   iron              two peaks: y=16 underground, y=232 in mountains
 *   copper            peak at y=48
 *   coal              peak at y=96, and absent below y=0
 *   emerald           mountains only, y=232
 *
 * `min`/`max` are the band worth being inside at all; `best` is where to
 * stand if we're going there deliberately.
 */
const ORE_DEPTH = {
  coal: { best: 96, min: 0, max: 190 },
  raw_iron: { best: 16, min: -24, max: 56 },
  raw_copper: { best: 48, min: -16, max: 112 },
  raw_gold: { best: -16, min: -64, max: 32 },
  redstone: { best: -59, min: -64, max: 15 },
  lapis_lazuli: { best: 0, min: -32, max: 32 },
  diamond: { best: -59, min: -64, max: 14 },
  emerald: { best: 232, min: 180, max: 320 },
};

// How much of a given resource is "enough". Past this the detour genuinely
// isn't worth it; below it, it is.
/**
 * Targets tuned for one goal: get a diamond.
 *
 * An iron pickaxe costs 3 ingots and is the ONLY gate on diamond — mined
 * with stone, a diamond block drops nothing at all. The old target of 24
 * iron was a long detour before the thing that actually matters, so this is
 * now sized at "pickaxe, plus a spare and a bit of armour": enough to be
 * safe at depth, not enough to turn into a mining career.
 */
const ENOUGH = {
  coal: 12,           // torches and smelting
  /**
   * A shield, an iron pickaxe, an iron sword and a full set of iron armour.
   *
   *   shield 1 + pickaxe 3 + sword 2 + chestplate 8 + leggings 7 + boots 4
   *   + helmet 5  =  30
   *
   * Twelve was "pickaxe plus a spare and a bit of armour", which is the right
   * target if dying is rare. It is not rare — losing the whole inventory to a
   * zombie or a pair of skeletons has cost this bot more progress than every
   * other failure combined, and each death is a full restart of the tool chain.
   * Iron armour is 24 ingots for 15 armour points, which is 60% less damage
   * taken from everything, forever, and iron at y=16 is the cheapest resource
   * the bot mines.
   *
   * So: kit up properly first, then go looking for diamond. That was the
   * user's own instinct and I agree with it — an unarmoured bot at y=-59 with
   * 29 diamonds' worth of walking still to do is a bot that will lose them.
   */
  //
  // Sized THREE ABOVE that kit, deliberately: the iron pickaxe is what the
  // whole run is gated on and it lasts 250 blocks, so the trip to diamond depth
  // wants a spare in the bag. Sizing this to exactly the kit leaves `gear`
  // wanting a piece it can never afford while `neededResource` has moved on.
  raw_iron: 33,
  raw_copper: 0,      // copper does nothing for us
  raw_gold: 0,        // only needed for the nether
  redstone: 0,
  lapis_lazuli: 0,
  diamond: 32,        // a full set is 29; leave headroom
  emerald: 0,
};

/**
 * The finish line: a complete diamond kit.
 *
 *   pickaxe 3 + sword 2 + helmet 5 + chestplate 8 + leggings 7 + boots 4
 *
 * That is a lot of diamond, and it is the whole reason `goDeep` and the
 * descent-safety work exist — you cannot casually stumble into 29 of them.
 */
const DIAMOND_GOAL = 29;

/**
 * Everything that counts toward a resource's stock, in every form it takes.
 *
 * Counting only the raw drop is the granite/cobblestone bug again in a
 * different costume: the moment the bot smelts its raw iron the counter
 * reads zero, so it would decide it needs iron and go mine 24 more, forever.
 * Tools already made out of it count too — the point is whether we still
 * need the resource, not how much of it is sitting loose.
 */
const STOCK_FORMS = {
  coal: ['coal', 'charcoal'],
  // Iron and diamond do not use this list — see stockOf, which asks gear.js
  // what the bot has SPENT as well as what it is holding. Listed here so the
  // shape of the table stays obvious, not because they are consulted.
  raw_iron: ['raw_iron', 'iron_ingot', 'iron_block'],
  raw_copper: ['raw_copper', 'copper_ingot'],
  raw_gold: ['raw_gold', 'gold_ingot'],
  redstone: ['redstone'],
  lapis_lazuli: ['lapis_lazuli'],
  diamond: ['diamond'],
  emerald: ['emerald'],
};

/** How much of a resource we hold, counting every form it can be in. */
function stockOf(bot, yieldName) {
  // Iron gets counted properly, including the iron we have already SPENT.
  //
  // STOCK_FORMS lists raw iron, ingots and blocks — and its own comment claims
  // "tools already made out of it count too", which was simply not true. So
  // every craft made the bot poorer by this measure: mine twelve iron, build a
  // pickaxe and a shield, and the counter reads eight. With a target of thirty
  // and a full armour set costing twenty-four, the target could never be
  // reached at all — the bot would mine iron, spend it, and conclude it needed
  // thirty more, forever. See ironInvested in behaviors/gear.js.
  if (yieldName === 'raw_iron') return ironInvested(bot);
  // Diamond had the identical hole: the kit is made OF the thing being
  // counted, so every piece crafted made the count fall, ENOUGH.diamond was
  // unreachable, and the bot would never have stopped digging for diamond
  // with the whole kit on its back. See diamondInvested.
  if (yieldName === 'diamond') return diamondInvested(bot);
  return countAny(bot, STOCK_FORMS[yieldName] ?? [yieldName]);
}

/**
 * What the bot most needs to dig for right now, in speedrun order.
 *
 * Iron first (tools, then armour), then diamond (the pickaxe that opens the
 * nether and the sword that ends fights quickly). Coal only if we can't make
 * torches, since charcoal covers us otherwise.
 */
function neededResource(bot) {
  // COAL IS NOT A GATE. This one line stopped the bot ever reaching iron.
  //
  // It used to return 'coal' whenever torches were short. Coal's band is
  // y=0..190, so standing on the surface at y=70 already counts as "at good
  // depth" for it — which meant `goDeep` saw nothing to descend for and
  // returned false, while `stripMine` saw the right depth and dug sideways.
  // The bot tunnelled along the surface hunting coal forever. Iron lives at
  // y<=56, so it was structurally impossible to reach: every session ended
  // at stone tier with `stripMine` running at y=69, and that was not bad
  // luck finding coal, it was a deadlock.
  //
  // Charcoal removes the need entirely — one log in a furnace, which the bot
  // can do anywhere, any time (see behaviors/smelt.js). Torches are still
  // made whenever the materials are to hand, opportunistically, by `gear`.
  // They are a comfort, not a prerequisite, and nothing should stop to go
  // prospecting for them.
  const ironShort = ironStillNeeded(bot) > 0;
  // Diamond needs an iron pickaxe to drop anything at all — going deep
  // before that is a wasted trip.
  const diamondShort = hasIronPickaxe(bot) && stockOf(bot, 'diamond') < ENOUGH.diamond;

  // BELOW IRON'S BAND, MINE WHERE YOU STAND.
  //
  // Iron first is the right order from the top, and it produced a dead zone
  // at the bottom. Caves drag the bot down; once it was below y=10 with iron
  // still short, `stripMine` refused (wrong depth for iron), `goDeep` refused
  // (it only goes DOWN, and iron is up), and nothing climbed back — so it fell
  // through to `explore` for 43% of the 09-24 session, iron pickaxe in hand,
  // at the depth where diamonds start. The user's call: carry on down for
  // diamond and take the iron that turns up on the way; deepslate has plenty.
  if (ironShort && diamondShort && belowIronBand(bot)) return 'diamond';
  if (ironShort) return 'raw_iron';
  if (diamondShort) return 'diamond';

  // Coal is FUEL now, and only fuel — the torch chain it used to serve is
  // gone. It is still worth a dedicated trip once iron and diamond are
  // satisfied, because a furnace with nothing to burn cannot cook or smelt,
  // and by then the bot is at depth anyway. Charcoal covers the same job
  // from logs, so this is never urgent.
  if (stockOf(bot, 'coal') < ENOUGH.coal && hasIronPickaxe(bot)) return 'coal';

  return null;
}

/**
 * Is the bot actually equipped to go underground for a long trip?
 *
 * Descending to y=-59 unprepared is how a run ends: no food means starving
 * in a tunnel with no animals for a hundred blocks, no torches means mobs
 * spawning in the corridor behind you, and a single nearly-dead pickaxe
 * means walking all the way back up. Everything here is cheap on the
 * surface and impossible to fix at depth.
 */
const DEEP_TRIP_NEEDS = {
  /**
   * Six meals, not three.
   *
   * Every one of these numbers was sized to "can the bot survive the first ten
   * minutes down there", and the answer the trip actually needs is "can it
   * finish the job without coming back up". Surfacing is the expensive thing —
   * it is forty blocks of climbing each way through a shaft that has to be
   * re-cut if pathfinder cannot route it — so the stock is now sized so the bot
   * does not have to. Reported plainly: make sure it has more than enough food,
   * wood and mining essentials before it goes down.
   *
   * Cheap to satisfy: a single cow or pig is two to three meals, and the bot
   * hunts on the surface anyway while it waits for stone tools.
   */
  food: 6,
  /**
   * Wood, counted in planks (a log is four) — and 6 was not enough to do the
   * job the trip exists for.
   *
   * Once at iron depth the bot has to: put down a crafting table (4 planks
   * if it is not carrying one), burn fuel to smelt what it mines (a plank
   * smelts 1.5 items, so eight iron costs about six), and keep something
   * back for tool handles when the pickaxe wears out. That is roughly
   * sixteen, and at six the bot arrived able to afford exactly one of those
   * three — then had to climb all the way back up.
   *
   * Cheap to satisfy now that the bot fells whole trees: a single tree is
   * four to seven logs, so one tree covers it — and thirty-two is two trees,
   * which is the difference between one descent and three.
   *
   * What the wood is actually FOR at depth: a crafting table (4), replacement
   * tool handles as pickaxes break (2 each, and a stone pickaxe lasts 131
   * blocks), and fuel for smelting what gets mined (a plank smelts 1.5 items,
   * so twenty iron costs about fourteen). At sixteen the bot could afford one
   * of those three.
   */
  planks: 32,
  /**
   * Cobblestone, for pillaring out of holes, bridging ravines and building the
   * furnaces that smelt what we came for. Eight of it IS a furnace.
   *
   * Deliberately the SAME NUMBER as COBBLE_TARGET rather than a second opinion
   * about it. `goDeep` refuses to start while `needsCobble` is true, and
   * `deepTripShortfall` refuses while the blocks are short — so if the gathering
   * target were the smaller of the two, the bot would stop gathering at a level
   * the descent then rejected, and neither behavior would ever move. That exact
   * shape — two individually reasonable thresholds that are jointly impossible
   * — is the most common bug this project has had, so the two now cannot drift.
   */
  placeable: COBBLE_TARGET,
};

/**
 * The weapon bar for going underground.
 *
 * Caves are where the hostiles are and the descent ends in one either way. A
 * wooden sword does 4 and breaks in 59 hits; a stone sword does 5 and lasts
 * 131, costs two cobblestone, and is available long before the bot has any
 * business at y=16. Instructed directly: use stone tools and weapons for the
 * bulk of the gathering, because they are fast to get.
 */
const DESCENT_WEAPON_TIERS = new Set(['stone', 'iron', 'diamond', 'netherite']);

function hasDescentWeapon(bot) {
  const weapon = bestWeapon(bot);
  if (!weapon) return false;
  return DESCENT_WEAPON_TIERS.has(weapon.name.split('_')[0]);
}

function deepTripShortfall(bot) {
  const missing = [];
  if (countAny(bot, EDIBLE) < DEEP_TRIP_NEEDS.food) missing.push('food');
  // Torches are deliberately absent from this list, and from the bot
  // entirely — see the note in gear.js. They were never a gate worth having
  // and the bot was never good at placing them.
  //
  // Count LOGS too. Every other place that measures wood does — gear.js
  // treats a log as four planks, and so does surfaceOnlyShortfall — but this
  // one looked only at planks and sticks. A bot carrying ten logs, which is
  // forty planks' worth, therefore reported "need: wood" and refused to
  // descend, forever. Watched live: `need: wood` on every status line while
  // it cycled between chopping more trees and smelting, with the descent it
  // was gathering for permanently one step away.
  if (woodUnits(bot) < DEEP_TRIP_NEEDS.planks) missing.push('wood');
  if (countAny(bot, STONE_MATERIAL) < DEEP_TRIP_NEEDS.placeable) missing.push('blocks');
  // A pickaxe about to break is the same as no pickaxe once you're 130
  // blocks down with no crafting table and no cobblestone left.
  if (toolIsWornOut(bot, 'pickaxe')) missing.push('pickaxe');
  // And a weapon, because the descent ends in a cave whether or not that was
  // the plan. Deliberately not "any sword": a wooden one loses to a zombie.
  if (!hasDescentWeapon(bot)) missing.push('weapon');
  return missing;
}

/** Are we inside the band where this ore exists at all? */
function atGoodDepth(bot, resource) {
  const band = ORE_DEPTH[resource];
  if (!band) return true;
  const y = bot.entity.position.y;
  return y >= band.min && y <= band.max;
}

/**
 * Are we at the depth actually worth DIGGING at?
 *
 * These are two different questions and treating them as one is why the
 * strip mining was worthless. Iron's band runs y=-24 to 56, so "at good
 * depth" was satisfied the moment the bot dropped below 56 — and it would
 * stop descending and start tunnelling there. Iron's distribution peaks at
 * y=16 and is very thin at 56, so that tunnel was being driven through
 * nearly empty rock. Diamond is worse: its band reaches up to y=14, but
 * essentially all of it is below -50.
 *
 * `best` is where the ore actually is. Anything more than a few blocks off
 * it means the answer is "keep descending", not "start digging sideways".
 */
const DEPTH_TOLERANCE = 6;

/**
 * Is this a depth worth tunnelling at for `resource`?
 *
 * The best level, as before — or anywhere below it that the ore still
 * generates. Only the best level used to count, and `goDeep` only ever goes
 * DOWN, so a bot a few blocks under iron's best (y=10–22) with iron still to
 * find had nothing it was allowed to do: too deep to strip, too deep for goDeep
 * to help. Iron is common all the way down to y=-24. Above the best level is
 * still goDeep's job; it digs down to where the ore is densest.
 */
function worthStripMiningHere(bot, resource) {
  if (atBestDepth(bot, resource)) return true;
  const band = ORE_DEPTH[resource];
  const y = bot.entity.position.y;
  return !!band && y < band.best && y >= band.min;
}

/** Below where iron is worth strip-mining — see atBestDepth. */
function belowIronBand(bot) {
  return bot.entity.position.y < ORE_DEPTH.raw_iron.best - DEPTH_TOLERANCE;
}

function atBestDepth(bot, resource) {
  const band = ORE_DEPTH[resource];
  if (!band) return true;
  return Math.abs(bot.entity.position.y - band.best) <= DEPTH_TOLERANCE;
}

/**
 * Deterministic mine/skip verdict, used when Jev doesn't answer fast enough.
 *
 * Standing next to an ore vein for four seconds waiting on an API call is
 * indistinguishable from being broken, and the block often stopped being
 * relevant by the time the answer came back. This is what "act now, learn
 * the model's opinion a moment later" looks like for mining.
 */
function instinctiveOreVerdict(bot, block, distance) {
  const yieldName = yieldOf(block.name);
  if (!yieldName) return 'mine'; // unknown ore: grab it, it's probably good

  const enough = ENOUGH[yieldName] ?? 0;
  if (enough === 0) return 'skip'; // nothing we currently need

  if (stockOf(bot, yieldName) >= enough) return 'skip';

  // Diamond is worth walking basically any distance for; everything else
  // has to be reasonably close to justify abandoning what we were doing.
  if (yieldName === 'diamond') return 'mine';
  return distance <= 20 ? 'mine' : 'skip';
}

/**
 * Get a mine/skip verdict without blocking on the network.
 *
 * Mirrors the combat path in behaviors/threat.js: race the Jev call against
 * a short deadline, act on instinct if it loses, and let the request finish
 * in the background so the verdict cache is warm for the rest of the vein.
 */
/**
 * Everything Jev needs to judge one ORE TYPE.
 *
 * Deliberately independent of any particular block so the background
 * prefetcher can ask the identical question ahead of time — see
 * src/prefetch.js. `distance` is optional for exactly that reason: when
 * warming the cache there is no specific block yet.
 */
function buildOreState(bot, oreName, distance = null) {
  const yieldName = yieldOf(oreName);
  return {
    block_type: oreName,
    ...(distance === null ? {} : { distance_blocks: Number(distance.toFixed(1)) }),
    pickaxe: bestToolOfType(bot, 'pickaxe')?.name || 'none',
    // Counts smelted and crafted forms too, not just the raw drop — see
    // STOCK_FORMS. Sending the raw count told Jev the bot had no iron
    // moments after it had smelted a full stack of it.
    already_held: yieldName ? stockOf(bot, yieldName) : 0,
    enough_would_be: ENOUGH[yieldName] ?? 0,
    at_good_depth: atGoodDepth(bot, yieldName),
    current_inventory: inventorySummary(bot),
  };
}

/**
 * Everything Jev needs to decide what the bot should be focusing on.
 *
 * Deliberately the whole picture rather than one slice: this is the question
 * where weighing many factors at once is the point, so it gets time of day,
 * supplies, tier, depth, threats and goal distance together. Hardcoded
 * priorities can only express one fixed ordering; the model can notice that
 * "it is nearly dark AND we have no shelter AND health is low" outranks the
 * usual mining order.
 */
function buildStrategyState(bot, ctx) {
  const pick = bestToolOfType(bot, 'pickaxe');
  const weapon = bestToolOfType(bot, 'sword') || bestToolOfType(bot, 'axe');
  const time = timeInfo(bot);
  const resource = neededResource(bot);

  // How much pickaxe is actually left, in blocks rather than as a fraction.
  //
  // "0.31 durability" means nothing without knowing the tier: a third of a
  // stone pickaxe is 43 blocks and will not survive a descent, while a third
  // of a diamond one is 515 and will survive several. The descent decision is
  // exactly where that difference matters, and it was the one fact about the
  // pickaxe not being sent.
  const tier = pick ? pick.name.split('_')[0] : null;
  const maxDurability = tier ? TOOL_TIERS[tier]?.durability ?? null : null;
  const blocksLeft = pick && maxDurability
    ? Math.round(durabilityLeft(pick) * maxDurability)
    : null;

  return {
    health: Math.round(bot.health ?? 20),
    hunger: bot.food ?? 20,
    food_items: countAny(bot, EDIBLE),
    pickaxe: pick?.name ?? 'none',
    weapon: weapon?.name ?? 'none',
    has_shield: itemCount(bot, 'shield') > 0,
    armour_pieces: armorSummary(bot).length,
    wood_units: woodUnits(bot),
    cobblestone: countAny(bot, STONE_MATERIAL),
    iron_held: stockOf(bot, 'raw_iron'),
    diamonds_held: stockOf(bot, 'diamond'),
    current_y: Math.round(bot.entity.position.y),
    target_y_for_next_goal: resource ? (ORE_DEPTH[resource]?.best ?? null) : null,
    seeking: resource ?? 'nothing specific',
    underground: isUnderground(bot),
    is_night: time.isNight,
    seconds_until_dark: time.isNight ? 0 : time.secondsUntilDusk,
    hostiles_nearby: Object.values(bot.entities)
      .filter((e) => e !== bot.entity && e.isValid && e.type === 'hostile'
        && bot.entity.position.distanceTo(e.position) <= 16).length,
    missing_for_deep_trip: deepTripShortfall(bot),
    pickaxe_blocks_left: blocksLeft,
    // What the bot is doing right now, and what last hurt it. Strategy is a
    // question about whether to CHANGE course, and neither half of that was
    // being sent: the model was picking a focus with no idea what focus was
    // already in force, so it had no way to express "carry on" distinctly
    // from "start over", and no way to notice that the last three answers had
    // been undone by the same zombie.
    currently_doing: ctx?.currentBehavior ?? 'nothing',
    last_hurt_by: ctx?.damage?.lastCause ?? 'nothing yet',
    deaths_this_world: memory.summary().deaths,
    goal: 'a full diamond kit: 29 diamonds',
    // The plan the director is enforcing (src/progression.js). A focus
    // outside the current phase only reorders what the phase allows, so the
    // model does best when it knows what the phase is and what it lacks.
    ...strategyPhase(bot, ctx),
  };
}

function strategyPhase(bot, ctx) {
  if (!ctx) return {};
  try {
    const { label, need } = require('../progression').describe(bot, ctx);
    return { phase: label, phase_still_needs: need ?? 'nothing' };
  } catch {
    return {};
  }
}

/**
 * Ore types currently within scan range, for the prefetcher to warm.
 *
 * Runs on the prefetcher's own timer, independently of `mine`, so it is a
 * second full ore sweep on top of findOre's — tiered for the same reason, and
 * with a smaller count because it only needs the distinct TYPES, and a vein
 * of twelve blocks is one type however many of them come back.
 */
function visibleOreTypes(bot) {
  // Four, not twelve. This wants the distinct TYPES near the bot, and a vein of
  // twelve blocks is one type however many come back — but `count` is what
  // lets findBlocks stop early, so asking for three times as many as the answer
  // needs is three times the scan for nothing.
  //
  // Only ore whose verdict `mine` will actually READ. Three kinds never are:
  //  - ore we would not take at all (wantThisOre) — the warmer was spending API
  //    calls on copper and lapis every few seconds to fill a cache `mine`
  //    discarded unread;
  //  - ore `mustHave` answers without asking — diamond, and the iron the kit
  //    needs. 30 diamond verdicts in one session on 09-24, none of them used;
  //  - ore findOre would never pick: buried, or too far above us. The warmer
  //    asked about a diamond eight times a minute that `mine` could not see.
  const myY = bot.entity.position.y;
  const { xray } = config.cheats;
  // Per name, not per hit: wantThisOre and mustHave read the whole inventory,
  // and this runs on every ore the scan passes. Exposure last — see exposedFast.
  const worthAsking = new Map();
  const askable = (pos, stateId) => {
    if (pos.y - myY > UPWARD_ORE_LIMIT) return false;
    const name = nameFromState(bot, pos, stateId);
    if (!name) return false;
    if (!worthAsking.has(name)) worthAsking.set(name, wantThisOre(bot, name) && !mustHave(bot, name));
    if (!worthAsking.get(name)) return false;
    return xray || exposedFast(bot, pos);
  };
  const found = findNearestTiered(bot, ORES, ORE_SEARCH_RADII, 4, askable);
  return [...new Set(found.map((pos) => bot.blockAt(pos)?.name).filter(Boolean))];
}

async function oreVerdict(bot, ctx, block, distance, task) {
  const cached = cachedOreVerdict(ctx, block.name);
  if (cached) {
    // Counted so the status line tells the truth about who is running the
    // bot. Only combat was being tallied, so a session that spent its time
    // mining reported "jev 0/0" no matter how many verdicts the model had
    // actually supplied — which is precisely the question this counter
    // exists to answer.
    ctx.jev.usedCached++;
    return { decision: cached, source: 'cache' };
  }

  const state = buildOreState(bot, block.name, distance);
  const oreName = block.name;
  // Same subject as the prefetcher's: a verdict already being asked for is
  // awaited, not asked for twice.
  const pending = jevClient.assessResource(state, { subject: `ore:${oreName}` })
    .then((result) => {
      // A failed call returns a conservative 'skip' fallback. That must NOT
      // reach the verdict cache: one API timeout poisoned coal_ore for the
      // next 25 seconds, so the bot walked away from a vein it was halfway
      // through. Treat a fallback as no answer and let instinct decide —
      // instinct knows what we're carrying; a blanket 'skip' knows nothing.
      // Below the confidence floor counts as no answer too.
      if (!jevClient.confident(result)) return null;

      ctx.mine.verdicts.set(oreName, { decision: result.decision, at: Date.now(), held: state.already_held });
      logger.decision('Resource decision', {
        input: { block_type: oreName, already_held: state.already_held },
        decision: result.decision,
        confidence: result.confidence,
        source: result.source,
        latencyMs: result.latencyMs,
      });
      return result;
    })
    .catch(() => null);

  const answered = await Promise.race([
    pending,
    sleep(config.typesafe.resourceDeadlineMs, task).then(() => null),
  ]);
  if (answered) {
    ctx.jev.usedCached++; // the model decided this one, just in time
    return { decision: answered.decision, source: answered.source };
  }

  ctx.jev.usedInstinct++;
  const instinct = instinctiveOreVerdict(bot, block, distance);
  logger.info('Jev slow on resource call — acting on instinct', {
    block: oreName,
    decision: instinct,
  });
  return { decision: instinct, source: 'instinct' };
}

const mine = {
  name: 'mine',
  priority: 25,
  shouldRun(bot, ctx) {
    // Ore drops nothing without a pickaxe, so don't bother looking.
    if (!bestToolOfType(bot, 'pickaxe')) return false;
    return !!findOre(bot, ctx);
  },
  async run(bot, ctx, task) {
    const candidate = findOre(bot, ctx);
    if (!candidate || !candidate.block) return false;
    return mineOreTarget(bot, ctx, task, candidate);
  },
};

/**
 * Go and get one ore, then the rest of its vein. Shared by `mine` and by
 * `valuables`, which is the same errand started for a better reason.
 */
async function mineOreTarget(bot, ctx, task, candidate) {
  const deadline = Date.now() + WORK_BUDGET_MS;
  const { block, exposed } = candidate;
  const key = posKey(block.position);
  const distance = bot.entity.position.distanceTo(block.position);

  // Not a judgement call, and therefore not Jev's to make. Copper, lapis,
  // redstone and gold are worth nothing to a diamond run whatever the model
  // thinks of them, and asking costs an API call to be told something we
  // already know.
  if (!wantThisOre(bot, block.name)) {
    ctx.mine.skipped.set(key, Date.now() + SKIP_MEMORY_MS);
    dropCandidate(ctx);
    return false;
  }

  // THE THING WE CAME DOWN HERE FOR IS NOT A JUDGEMENT CALL.
  //
  // Watched on the live log, with the bot holding two iron against a target
  // of thirty: `Resource decision {block_type: iron_ore, already_held: 2,
  // decision: skip, confidence: 0.01}`. Jev is a fast typed model and it is
  // wrong sometimes; that is fine everywhere except here, where "skip" on the
  // one resource the whole run is gated behind stops the progression dead and
  // the cached verdict then suppresses the next twenty-five seconds of iron
  // as well.
  //
  // So the model is asked about detours — is this coal worth leaving the
  // tunnel for — and not about the critical path. Below target on the
  // resource `neededResource` has named, the answer is arithmetic.
  const decision = mustHave(bot, block.name)
    ? 'mine'
    : (await oreVerdict(bot, ctx, block, distance, task)).decision;

  if (decision !== 'mine') {
    ctx.mine.skipped.set(key, Date.now() + SKIP_MEMORY_MS);
    dropCandidate(ctx);
    return false;
  }

  try {
    if (exposed) {
      // Ore too high to stand within GATHER_REACH of is approached to dig
      // reach instead: standing under it is as close as the floor allows,
      // and asking for 2.4 there fails every time. The drop falls to us.
      const rise = block.position.y + 0.5 - bot.entity.position.y;
      const within = rise > GATHER_REACH ? DIG_REACH : GATHER_REACH;
      await goToBlock(bot, block, task, { within });
    } else {
      logger.action('Tunnelling to buried ore', { block: block.name, pos: block.position });
      const reached = await tunnelToward(bot, block.position, task);
      if (!reached) {
        ctx.mine.skipped.set(key, Date.now() + SKIP_MEMORY_MS);
        return false;
      }
    }

    const dug = await digBlock(bot, block, task);
    if (dug) {
      await stepOntoDrop(bot, block.position, task);
      memory.forgetOre(block.position); // collected; stop remembering it
      logger.action('Mined ore', { block: block.name, pos: block.position });
      announceDiamond(bot, block);
      // The rest of the vein. Ore comes in clusters, and this used to take
      // one block and drop the target — the next block of the same vein
      // waited for another scan, another decision and another walk.
      await grabOreInReach(bot, task, deadline);
    }
    return dug;
  } catch (err) {
    const interrupted = isInterruption(err);
    rememberFailedTarget(bot, ctx, key, err, interrupted);
    throw err;
  } finally {
    dropCandidate(ctx);
  }
}

/**
 * Shout about the one that matters — after the pickup, so the count is true.
 *
 * It used to log `held` straight after the dig, before the drop was in the
 * bag: "*** DIAMOND *** held: 0" at 14:37:30 on 09-24, with the diamond
 * lying at its feet. And only `mine` logged it, so every diamond taken by the
 * vein sweep went unannounced.
 */
function announceDiamond(bot, block) {
  if (!block.name.endsWith('diamond_ore')) return;
  const held = stockOf(bot, 'diamond');
  logger.action('*** DIAMOND ***', {
    held,
    goal: DIAMOND_GOAL,
    reached: held >= DIAMOND_GOAL,
    y: Math.round(block.position.y),
  });
}

/**
 * Take what the run is FOR, whatever else the bot happens to be doing.
 *
 * `mine` sits at 25 and has no canInterrupt, and the director lets a lower
 * priority take over only when the running behavior returns. So a diamond in
 * plain view waited behind a smelt, a tidy, a stone run or a whole explore leg
 * — and when the next leg carried the bot away, it simply never happened. Live
 * on 09-24 the bot walked past one for eight minutes.
 *
 * Priority 42: above gear, smelt, tidy, gatherStone and every mining and
 * wandering behavior; below collect (a drop despawns), resupply and the food
 * and wood emergencies (45–47), and everything that keeps the bot alive (50+).
 *
 * "Important" is `mustHave` — diamond, and the iron the kit still needs. Coal
 * and the rest wait for ordinary mining. Harvestable only: a diamond under a
 * stone pickaxe drops nothing, and findOre has already written it down.
 */
const VALUABLE_SIGHT = 32;

/**
 * After a route to one valuable fails, stop chasing sightings for a while.
 *
 * Each failure already rules out its own vein (rememberFailedTarget), but the
 * next sighting is usually the same cave seen from the same spot: on 09-26
 * the bot spent 18:34–18:36 on four different iron veins and 20:02–20:04 on
 * five, twenty seconds of "navigation timed out" each, all from ore visible
 * through a cave it had no way into. Ordinary mining still takes them when a
 * route opens up.
 */
const VALUABLES_ROUTE_PAUSE_MS = 2 * 60 * 1000;

function valuablesPaused(ctx) {
  return (ctx.mine?.valuablesPausedUntil ?? 0) > Date.now();
}

function importantOreInView(bot, ctx) {
  const pick = bestToolOfType(bot, 'pickaxe');
  if (!pick) return null;
  const candidate = findOre(bot, ctx);
  if (!candidate?.block || !candidate.exposed || candidate.fromNote) return null;
  const { block } = candidate;
  if (!mustHave(bot, block.name)) return null;
  if (!canHarvest(pick.name.split('_')[0], block.name)) return null;
  if (bot.entity.position.distanceTo(block.position) > VALUABLE_SIGHT) return null;
  return candidate;
}

const valuables = {
  name: 'valuables',
  priority: 42,
  shouldRun: (bot, ctx) => !valuablesPaused(ctx) && !!importantOreInView(bot, ctx),
  canInterrupt: (bot, ctx) => !valuablesPaused(ctx) && !!importantOreInView(bot, ctx),
  async run(bot, ctx, task) {
    const candidate = importantOreInView(bot, ctx);
    if (!candidate) return false;
    logger.action('Going for it — worth more than what I was doing', {
      ore: candidate.block.name,
      distance: Math.round(bot.entity.position.distanceTo(candidate.block.position)),
    });
    try {
      return await mineOreTarget(bot, ctx, task, candidate);
    } catch (err) {
      if (!isInterruption(err) && UNREACHABLE.test(err?.message ?? '')) {
        ctx.mine.valuablesPausedUntil = Date.now() + VALUABLES_ROUTE_PAUSE_MS;
        logger.info('No way to that ore — leaving sightings to ordinary mining for a while', {
          ore: candidate.block.name, forSec: VALUABLES_ROUTE_PAUSE_MS / 1000,
        });
      }
      throw err;
    }
  },
};

/** Do we actually need more stone material right now? */
function needsCobble(bot) {
  return countAny(bot, STONE_MATERIAL) < COBBLE_TARGET;
}

/**
 * The nearest stone block whose drop we can actually pick up.
 *
 * This was the single worst bug in the resource loop, and it hid perfectly:
 * `findNearest` returns the closest stone block, which on the surface is
 * buried several blocks deep inside solid ground. goToBlock then reports
 * "arrived" at up to 4.2 blocks because that's within digging reach — so the
 * bot mined a block sealed inside rock, the cobblestone dropped into a
 * one-block pocket it could never enter, and the item quietly despawned.
 *
 * The symptoms looked like anything but this: mining succeeded, the right
 * tool was in hand, the inventory had 28 free slots, and the cobblestone
 * counter sat at exactly 0 forever — while logs and mob drops (both mined
 * or dropped in open air) were collected perfectly normally. Without
 * cobblestone there is no furnace, no stone tools and no iron, so the whole
 * progression stalled at wood.
 *
 * `mine` already required ore to be exposed for the same reason. This is
 * that check, applied where it was missing.
 */
/**
 * Throttled and cached, like the ore and log scans, and for the same reason.
 *
 * This one was not, and it is called from `gatherStone.shouldRun` — which the
 * director's main loop evaluates every time it picks a behavior, i.e.
 * continuously. A full section-walking findBlocks sweep, several times a
 * second, synchronously, on the thread that also runs pathfinding and combat.
 * The lag meter had the bot's own event loop 101ms behind on a typical tick,
 * which is two dropped ticks all the time, plus a 2.1-second peak.
 *
 * Stone does not move. Half a second of staleness costs nothing.
 */
const STONE_SCAN_THROTTLE_MS = 500;

function findExposedStone(bot, ctx = null) {
  const now = Date.now();
  if (ctx?.mine && now - (ctx.mine.lastStoneScanAt ?? 0) < STONE_SCAN_THROTTLE_MS) {
    return ctx.mine.stoneCandidate ?? null;
  }
  const answer = scanForExposedStone(bot);
  if (ctx?.mine) {
    ctx.mine.lastStoneScanAt = now;
    ctx.mine.stoneCandidate = answer;
  }
  return answer;
}

function scanForExposedStone(bot) {
  // Stone is everywhere, so the close tier nearly always answers — and when
  // it does not, the bot is standing somewhere with no stone at all and the
  // right move is to dig down, which is what the caller does next.
  const found = findNearestTiered(bot, STONE, STONE_SEARCH_RADII, 24);
  const myY = bot.entity.position.y;
  for (const pos of found) {
    if (!isExposed(bot, pos)) continue;

    if (Math.abs(pos.y - myY) > 3) continue;

    // Exposed isn't enough — the exposed face is often a CAVE CEILING. Mine
    // that and the cobblestone falls into the cavern below, out of reach and
    // gone. The bot was standing next to a large cave system (28 hostiles in
    // range) doing exactly this, over and over, with a permanently empty
    // inventory. A drop only stays put if something solid is underneath it.
    //
    // The exception is stone we are practically standing on: the drop lands
    // at our feet and is collected whatever is below it. Demanding solid
    // ground under THAT too was over-strict, and it deadlocked the bot on a
    // stone ledge — standing on stone, unable to find any stone to mine.
    const closeEnoughToCatchIt = bot.entity.position.xzDistanceTo(pos) <= 2;

    if (!closeEnoughToCatchIt) {
      const under = bot.blockAt(pos.offset(0, -1, 0));
      if (!under || under.boundingBox !== 'block') continue;
    }

    return bot.blockAt(pos);
  }
  return null;
}

/**
 * Descent safety, as a DENYLIST.
 *
 * This used to be an allowlist of a dozen surface blocks, which made the
 * trip to diamond depth impossible: below y=0 the bot meets deepslate
 * variants, tuff, calcite, dripstone, amethyst and — most ironically —
 * ore blocks, none of which were listed, so the first `deepslate_iron_ore`
 * in the way aborted the whole descent. It could never get past the top of
 * the deepslate layer.
 *
 * An allowlist is the wrong shape for this. There are thousands of harmless
 * blocks and about six that actually matter, so name those instead.
 */
const NEVER_DIG = new Set([
  'bedrock', 'obsidian', 'crying_obsidian', 'reinforced_deepslate',
  'ancient_debris', 'spawner', 'end_portal_frame', 'budding_amethyst',
  // Containers: breaking them scatters loot and wastes time.
  'chest', 'trapped_chest', 'barrel', 'shulker_box', 'ender_chest',
]);

function isLiquid(block) {
  if (!block) return false;
  const n = block.name;
  return n === 'lava' || n === 'water' || n === 'flowing_lava' || n === 'flowing_water'
    || n === 'bubble_column';
}

function isLava(block) {
  return !!block && (block.name === 'lava' || block.name === 'flowing_lava');
}

/**
 * Is there lava touching this block?
 *
 * Checking only the block directly beneath a step is not enough — at
 * diamond depth lava sits in pockets and lakes, and breaking into one from
 * the SIDE floods the tunnel just as fatally. Dying at y=-59 also means
 * losing everything, with a loot walk that can't be completed in time. So
 * every face of every block gets checked before the pickaxe touches it.
 */
function lavaAdjacent(bot, pos) {
  const faces = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];
  return faces.some(([dx, dy, dz]) => isLava(bot.blockAt(pos.offset(dx, dy, dz))));
}

/** Safe to break while digging our way down or along. */
function safeToDig(bot, block) {
  if (!block) return false;
  if (NEVER_DIG.has(block.name)) return false;
  if (isLiquid(block)) return false;
  return !lavaAdjacent(bot, block.position);
}

/**
 * Gravity-affected blocks that fall the instant the space under them opens up.
 *
 * Concrete powder is included for completeness even though it is not a
 * natural spawn underground — a player-built structure could still have it,
 * and the check costs nothing extra either way.
 */
const FALLING_BLOCKS = new Set([
  'gravel', 'sand', 'red_sand', 'white_concrete_powder', 'anvil',
]);

function isFallingBlock(block) {
  return !!block && FALLING_BLOCKS.has(block.name);
}

/**
 * A PLAYER CLEARS THE GRAVEL BEFORE WALKING UNDER IT. This is what that looks
 * like for the bot, and its absence is what killed it.
 *
 * Every corridor dig checked every face for lava before breaking a block, on
 * the reasoning that breaking into a lava pocket from the side is exactly as
 * fatal as breaking into one from below. Nothing did the same for gravel —
 * and a hanging gravel deposit is not a hazard beside the tunnel, it is one
 * sitting directly overhead, invisible until the bot steps underneath it and
 * the ceiling comes down.
 *
 * Watched live, killing the bot outright: fifteen points of suffocation damage
 * over roughly a minute while `stripMine` kept advancing, each step exposing
 * a fresh face of the same deposit and re-triggering the collapse. The
 * reactive fix (src/behaviors/survive.js digging the bot's head out) stops the
 * bleeding once it has already started; this is what stops it starting.
 *
 * Bounded, because a genuine deposit rarely runs more than a few blocks and an
 * unbounded upward dig is its own kind of trap — carve a chimney into an
 * unrelated cavern above and the bot has made its problem worse, not better.
 */
const OVERHEAD_CLEAR_LIMIT = 4;

async function clearOverheadFalling(bot, task, headPos) {
  let cleared = 0;
  for (let dy = 1; dy <= OVERHEAD_CLEAR_LIMIT; dy++) {
    task.throwIfAborted();
    const above = bot.blockAt(headPos.offset(0, dy, 0));
    if (!isFallingBlock(above)) break;
    if (!safeToDig(bot, above)) break;
    if (await digBlock(bot, above, task)) cleared++;
    else break;
  }
  return cleared;
}

/**
 * Is there solid footing under this spot, or are we about to walk off a
 * ledge into a cave? A fall from the top of a large cavern at depth is
 * simply death.
 */
function hasFooting(bot, pos) {
  for (let dy = 1; dy <= 3; dy++) {
    const under = bot.blockAt(pos.offset(0, -dy, 0));
    if (!under) return false;
    if (isLava(under)) return false;
    if (under.boundingBox === 'block') return true;
  }
  return false;
}

const MAX_DIG_DOWN = 12;
const MAX_TUNNEL_STEPS = 24;
const DESCENT_RETRY_MS = 20000;

/** Quarter-turn, so a blocked direction becomes a detour rather than a dead end. */
function turnRight([dx, dz]) {
  return [-dz, dx];
}

/**
 * The cells a stair step has to clear, for a bot that is TWO BLOCKS TALL.
 *
 * Written as a pure function of the feet cell and the heading so the rule can
 * be stated once and checked directly — see test/staircase.test.js. Getting it
 * wrong does not throw, it just produces a bot that walks into a wall on every
 * step and concludes it is boxed in, which is what "his digging down method is
 * so weird" actually was.
 *
 *   stepOver   feet+1 ahead — head height. The DOORWAY. Without this the bot
 *              cannot enter the next column at all, whatever is dug below it.
 *   stepHead   feet+0 ahead — headroom once standing on the new step.
 *   stepDown   feet-1 ahead — the step itself.
 */
function stairCells(feet, [dx, dz]) {
  return {
    stepOver: feet.offset(dx, 1, dz),
    stepHead: feet.offset(dx, 0, dz),
    stepDown: feet.offset(dx, -1, dz),
  };
}

/**
 * ...and the same going up, which has the mirror-image omission.
 *
 *   ceiling    feet+2, straight up. A step up is a JUMP, and a jump needs
 *              somewhere to put your head. In the 2-high corridor the bot cut
 *              on the way down, this is solid stone.
 *   riseFeet   feet+1 ahead — where the feet land.
 *   riseHead   feet+2 ahead — headroom at the top of the step.
 */
function climbCells(feet, [dx, dz]) {
  return {
    ceiling: feet.offset(0, 2, 0),
    riseFeet: feet.offset(dx, 1, dz),
    riseHead: feet.offset(dx, 2, dz),
  };
}

/**
 * Dig a tunnel toward a target block.
 *
 * Pathfinder can't reach anything encased in stone now that its own digging
 * is off (it snapped the bot's position around and clobbered tool choice).
 * Without this the bot could see iron ore ten blocks away and simply never
 * get to it — it would plateau on stone tools and wander forever, which is
 * exactly what "doesn't feel productive" looked like.
 */
async function tunnelToward(bot, targetPos, task) {
  for (let step = 0; step < MAX_TUNNEL_STEPS; step++) {
    task.throwIfAborted();

    const from = feetCell(bot);
    const delta = targetPos.minus(from);
    if (delta.norm() <= 1.7) return true; // close enough to mine it directly

    // Step along the dominant axis so the tunnel stays straight-ish — unless
    // that is through ore we would only throw away and the other axis also
    // closes the distance. See steerAroundUnwantedOre.
    const alongX = { x: Math.sign(delta.x), y: 0, z: 0 };
    const alongZ = { x: 0, y: 0, z: Math.sign(delta.z) };
    let stepDir = Math.abs(delta.x) >= Math.abs(delta.z) ? alongX : alongZ;
    const other = stepDir === alongX ? alongZ : alongX;
    if ((other.x || other.z)
      && unwantedOreAhead(bot, from, [stepDir.x, stepDir.z])
      && !unwantedOreAhead(bot, from, [other.x, other.z])) {
      stepDir = other;
    }

    // Once lined up horizontally, work vertically instead.
    const useVertical = stepDir.x === 0 && stepDir.z === 0 && delta.y !== 0;
    const dir = useVertical ? { x: 0, y: Math.sign(delta.y), z: 0 } : stepDir;

    // Clear head and body height so the bot can actually walk in.
    const targets = useVertical
      ? [from.offset(dir.x, dir.y, dir.z)]
      : [from.offset(dir.x, 0, dir.z), from.offset(dir.x, 1, dir.z)];

    let progressed = false;
    for (const pos of targets) {
      const block = bot.blockAt(pos);
      if (!block || (block.boundingBox === 'empty' && !isLiquid(block))) continue;
      // Same rule as the descent: check every face for lava, not just the
      // block itself. Breaking into a lava pocket from the side at diamond
      // depth kills the bot and loses the entire run.
      if (!safeToDig(bot, block)) {
        logger.warn('Stopping tunnel — unsafe block ahead', { block: block.name });
        return false;
      }
      const dug = await digBlock(bot, block, task);
      if (!dug) return false;
      progressed = true;
    }

    // Same gravel-overhead check the branch tunnel uses — see
    // clearOverheadFalling. A vertical step has no "ahead", only up; the
    // horizontal case checks above the head cell it just opened.
    if (!useVertical) {
      await clearOverheadFalling(bot, task, from.offset(dir.x, 1, dir.z));
    }

    // Walk into the space we just opened — manually, not via pathfinder,
    // which routinely refuses a single-block step into a fresh tunnel and
    // left the bot standing in the step it had just dug. stepTo refuses
    // lava and anything that would be a fall.
    const target = from.offset(dir.x, dir.y, dir.z);
    const moved = await stepTo(bot, target, task, { jump: dir.y > 0 });

    // If we dug nothing AND went nowhere, this route is not working.
    if (!progressed && !moved) return false;
  }
  return false;
}

/**
 * Descend toward buried stone as a STAIRCASE, never a vertical shaft.
 *
 * This matters enormously: a 1x1 hole straight down is a trap. Pathfinder
 * can't dig (we turned that off because its fullStop teleports the bot) and
 * can't pillar either, so a bot at the bottom of its own shaft is stuck
 * there permanently — observed live, oscillating between four positions at
 * y=48 forever. A staircase is walkable in both directions.
 */
async function digStaircaseDown(bot, task, opts = {}) {
  const { targetY = null, maxSteps = MAX_DIG_DOWN, startHeading = null } = opts;
  /**
   * KEEP THE SAME DIRECTION ACROSS RUNS.
   *
   * This picked a fresh random heading every call, and `goDeep` calls it once
   * per scheduling round — so the descent from y=70 to y=16 was not a
   * staircase at all, it was a dozen disconnected flights pointing in random
   * directions, each one starting wherever the last happened to stop. That is
   * the "his mining method is so weird when he is going down" report: twice
   * the digging, a shaft that cannot be walked back up, and a bot that
   * repeatedly cut across its own workings.
   *
   * The caller hands back the heading this run ended on, and passes it in
   * next time — so the flights join up into one staircase.
   */
  let heading = startHeading;
  let blockedTurns = 0;

  // Measure real descent, not loop iterations.
  //
  // `depth` used to be the loop counter, which is a count of ATTEMPTS — so a
  // run that turned twelve times without going down a single block returned
  // {ok: true, depth: 12} and the caller believed it had worked. That is
  // what pinned the bot at y=70 logging "no exposed stone nearby, digging
  // down" every five seconds while its Y never changed.
  const startY = bot.entity.position.y;
  const descended = () => Math.max(0, Math.round(startY - bot.entity.position.y));

  for (let attempt = 0; attempt < maxSteps; attempt++) {
    task.throwIfAborted();

    // A staircase is cut with a pickaxe, and pickaxes break mid-flight — this
    // one did, at y=41, and the descent carried on by hand: stone at seven
    // and a half seconds a block, until the sixty-second deadlock breaker cut
    // it off and benched it. Stop the moment there is nothing to dig with and
    // let `gear` make another; the heading is kept, so the stairs resume.
    if (!bestToolOfType(bot, 'pickaxe')) {
      return {
        ok: descended() > 0, reason: 'no pickaxe', depth: descended(), heading,
      };
    }

    const feet = feetCell(bot);
    if (targetY !== null && feet.y <= targetY) return { ok: true, depth: descended(), heading };

    // groundUnder rather than feet-1: the naive probe misses by a block
    // whenever the bot's Y sits just under the integer, which made "am I
    // already standing on stone?" answer at random. See nav.js.
    let below = groundUnder(bot);
    if (!below) {
      // Almost never an unloaded chunk — it is us, still falling into the
      // step we just cut. groundUnder finds nothing solid because there IS
      // nothing solid yet; a moment later there is. Reporting that as
      // "chunk not loaded below" aborted the descent and put it on a 20
      // second cooldown, over and over, so the bot never got more than a
      // block or two down before starting again.
      await sleep(250, task);
      below = groundUnder(bot);
      if (!below) return { ok: descended() > 0, reason: 'nothing solid below', depth: descended(), heading };
    }
    // When we're heading for a specific depth, hitting stone is the start of
    // the journey, not the end of it.
    if (targetY === null && STONE.includes(below.name)) return { ok: descended() > 0, depth: descended(), heading };

    // Keep one direction for the whole descent so the stairs are usable.
    if (!heading) {
      const options = [[1, 0], [-1, 0], [0, 1], [0, -1]];
      heading = options[Math.floor(Math.random() * options.length)];
    }

    // A STAIR STEP IS THREE BLOCKS, NOT TWO. This is the bug.
    //
    // The bot is two blocks tall. To get from where it stands to the step
    // below-and-forward, it first has to move HORIZONTALLY into the next
    // column, and while it does that its feet are at the current level and its
    // head is one above. So the column it walks through has to be clear at both
    // of those heights before it can enter at all.
    //
    // This dug only the destination — the cell that becomes the new floor and
    // the one above it — and left the block at the bot's own head height
    // standing. The bot then walked face-first into solid stone every single
    // step: stepTo made no progress, the staircase turned right, turned right
    // again, reported "could not step down" after four turns, and put the whole
    // descent on a twenty-second cooldown. From outside that is exactly the
    // report: the digging-down method is strange and the bot barely gets
    // anywhere. It also never left a shaft it could walk back UP, which is the
    // other half of the same complaint, and why every trip to the surface had
    // to be re-cut by hand.
    //
    //   stepOver   head height, straight ahead — the doorway
    //   stepHead   feet height, straight ahead — headroom over the new floor
    //   stepDown   one below that — the step itself
    //
    // Cutting all three leaves an ordinary 2-high staircase: walkable down,
    // walkable back up, and routable by pathfinder in both directions.
    const { stepOver, stepHead, stepDown } = stairCells(feet, heading);

    // Never walk off into a cavern — at this depth the fall IS the death.
    // Turning costs a step; falling costs the run.
    if (!hasFooting(bot, stepDown)) {
      heading = turnRight(heading);
      blockedTurns++;
      if (blockedTurns > 4) return { ok: descended() > 0, reason: 'boxed in', depth: descended(), heading };
      continue;
    }

    let blocked = false;
    for (const pos of [stepOver, stepHead, stepDown]) {
      const block = bot.blockAt(pos);
      if (!block) return { ok: descended() > 0, reason: 'chunk not loaded', depth: descended(), heading };
      if (block.boundingBox === 'empty' && !isLiquid(block)) continue;

      if (!safeToDig(bot, block)) {
        // Turning beats giving up: lava pockets are local, and a descent
        // that aborts on the first one never reaches diamond depth.
        logger.info('Digging around an obstacle', { block: block.name, at: pos });
        heading = turnRight(heading);
        blockedTurns++;
        blocked = true;
        break;
      }

      if (!(await digBlock(bot, block, task))) {
        // A dig that failed because we were PREEMPTED is not a broken
        // descent, it is a descent that was interrupted — and the two need
        // opposite responses. digBlock swallows the abort and returns false,
        // so without this check a zombie wandering past looked identical to
        // hitting bedrock: goDeep put the descent on a 20 second cooldown
        // and the bot restarted from the surface. With combat happening
        // every minute or so it could never string enough uninterrupted
        // steps together to actually get down.
        task.throwIfAborted();
        return {
          ok: descended() > 0,
          reason: `could not dig ${block.name}`,
          depth: descended(),
          heading,
        };
      }
    }

    // We turned instead of digging, so the step we were aiming at is stale —
    // re-plan from the top rather than walking at it anyway.
    if (blocked) {
      if (blockedTurns > 4) return { ok: descended() > 0, reason: 'boxed in', depth: descended(), heading };
      continue;
    }
    blockedTurns = 0;

    // CLEAR THE GRAVEL BEFORE WALKING UNDER IT — the staircase had been missed.
    //
    // The branch tunnel and tunnelToward both do this; the descent did not,
    // and it is the one that cuts through the most ground. Opening stepOver
    // (the doorway at head height) takes away the support of anything above
    // it, and the bot then steps straight underneath. Watched live on the way
    // from y=94 to y=41: twenty-eight suffocation hits in three bursts, each
    // ended by a single "Buried — digging my head out {gravel}" that took four
    // and a half seconds, because a bot with gravel in its head is not on the
    // ground and digs at a fifth of the speed. See clearOverheadFalling.
    //
    // Clearing it drops the rest of the column into the step we just cut, not
    // onto us — we are standing one column back. So when anything came down,
    // go round again on the SAME heading: the next pass digs the fallen gravel
    // back out of the step and checks overhead again, until the column is
    // spent. Turning instead would abandon a perfectly good staircase for a
    // pile of gravel. Bounded by maxSteps like every other pass.
    if (await clearOverheadFalling(bot, task, stepOver) > 0) continue;

    // Step into the hole MANUALLY rather than asking pathfinder, which
    // frequently refuses a one-block diagonal drop and left the bot
    // standing at the top of its own staircase. stepTo also refuses lava
    // and anything that would be a fall rather than a step.
    const before = bot.entity.position.y;
    await stepTo(bot, stepDown, task, { ms: 400 });

    if (bot.entity.position.y >= before - 0.4) {
      heading = turnRight(heading);
      blockedTurns++;
      if (blockedTurns > 4) {
        return { ok: descended() > 0, reason: 'could not step down', depth: descended(), heading };
      }
      continue;
    }
  }
  // Ran out of attempts. Whether that counts as success depends entirely on
  // whether we actually went anywhere.
  return { ok: descended() > 0, depth: descended(), heading };
}

/**
 * Travel to the depth where the resource we need actually exists.
 *
 * Without this the bot mines wherever it happens to be standing, which for a
 * surface spawn means strip-mining at y≈70 — a band that contains no
 * diamond at all and very little iron. Digging to the right Y first is the
 * difference between "mining" and "mining productively".
 */
const DESCENT_STEPS_PER_RUN = 16;

/**
 * Walk somewhere a staircase can actually be cut.
 *
 * "Boxed in" does not mean the world is solid, it means THIS SPOT is: a lake
 * shore, the lip of a ravine, a one-block ledge. Every one of those is fixed by
 * walking a short distance, and none of them is fixed by waiting.
 *
 * Deliberately modest — far enough to be genuinely different ground, near
 * enough that it costs a few seconds and does not turn into exploration.
 */
const RELOCATE_DISTANCE = 14;
const RELOCATE_TRIES = 6;

async function relocateForDescent(bot, ctx, task) {
  const origin = bot.entity.position;
  for (let i = 0; i < RELOCATE_TRIES; i++) {
    task.throwIfAborted();
    const angle = Math.random() * Math.PI * 2;
    const spot = origin.offset(
      Math.cos(angle) * RELOCATE_DISTANCE,
      0,
      Math.sin(angle) * RELOCATE_DISTANCE,
    ).floored();

    // Somewhere with solid, dry ground to start cutting from. Checking before
    // walking is the whole point: arriving and finding another lake is the
    // failure we are recovering from.
    // hasFooting takes the cell the FEET would occupy and looks downward from
    // it — passing the ground block instead probes three blocks below the
    // floor, which is a different question and usually the wrong answer.
    const under = bot.blockAt(spot.offset(0, -1, 0));
    if (!under || under.boundingBox !== 'block' || isLiquid(under)) continue;
    if (!hasFooting(bot, spot)) continue;

    try {
      await goNear(bot, spot, 2, task, { timeoutMs: 12000 });
    } catch (err) {
      if (isInterruption(err)) throw err;
      continue;
    }

    if (bot.entity.position.distanceTo(origin) < 4) continue; // did not actually move
    ctx.mine.descentHeading = null; // this staircase is finished; start a new one
    logger.action('Nowhere to cut stairs here — moving to firmer ground', {
      from: origin.floored(),
      to: bot.entity.position.floored(),
    });
    return true;
  }
  return false;
}

const goDeep = {
  name: 'goDeep',
  // BELOW ordinary ore mining on purpose. Ore we can already see beats a
  // speculative trip downwards, and at 26 (above `mine`) this hijacked the
  // schedule and dragged the bot underground before it had done anything
  // useful on the surface.
  priority: 24,
  shouldRun(bot, ctx) {
    if (Date.now() < (ctx.mine.descentBlockedUntil || 0)) return false;

    // Don't go deep on a wooden pickaxe. It cannot mine iron at all, so the
    // whole trip is wasted — and this fired from the very first minute of a
    // fresh world, before the bot had wood, stone or a shelter. Earn the
    // stone tier on the surface first.
    const pick = bestToolOfType(bot, 'pickaxe');
    if (!pick || pick.name.startsWith('wooden')) return false;

    // Stone first: a furnace and a spare pickaxe matter more than depth.
    if (needsCobble(bot)) return false;

    // Supplies before depth.
    //
    // The full kit is only demanded for the diamond trip, but EVERY descent
    // needs food and wood: there are no trees at y=16, so a bot that goes
    // down without sticks cannot craft a replacement when its pickaxe
    // breaks, and nothing underground will ever fix that. Gate the cheap
    // essentials on every trip and the whole list on the deep one.
    const resource = neededResource(bot);
    if (!resource) return false;

    // The strict kit list on the surface, the survival list once already
    // underground — see descentShortfall. Re-asking the strict question on
    // every step down is what turned every descent into a yo-yo.
    const shortfall = descentShortfall(bot);
    // A weapon is on the cheap list too. The descent ends in a cave one way or
    // another, and arriving there with a wooden sword is how a run ends —
    // "there was a zombie, the bot did nothing, and it died" was reported with
    // full iron in the bag, but the same trip with no sword at all is worse.
    const blocking = resource === 'diamond'
      ? shortfall
      : shortfall.filter((m) => m === 'food' || m === 'wood' || m === 'weapon');
    if (blocking.length > 0) {
      ctx.mine.lastShortfall = blocking.join(',');
      return false;
    }

    ctx.mine.lastShortfall = null; // kitted out; stop reporting a shortage

    // Descend until we are at the depth the ore actually PEAKS at, not merely
    // inside the band where it can exist. Stopping at band.max put the bot at
    // y=56 for iron, forty blocks above where iron is common, and it then
    // strip-mined there through almost empty rock.
    if (atBestDepth(bot, resource)) return false;

    // Only ever dig DOWN; climbing to y=232 for emeralds is not something
    // this bot should be attempting.
    const band = ORE_DEPTH[resource];
    return !!band && bot.entity.position.y > band.best;
  },
  async run(bot, ctx, task) {
    const resource = neededResource(bot);
    if (!resource) return false;
    const band = ORE_DEPTH[resource];

    logger.action('Digging down to the right level', {
      resource,
      targetY: band.best,
      currentY: Math.round(bot.entity.position.y),
    });

    const result = await digStaircaseDown(bot, task, {
      targetY: band.best,
      maxSteps: DESCENT_STEPS_PER_RUN,
      // Continue the staircase we were already cutting, rather than starting
      // a fresh one in a random direction on every scheduling round.
      startHeading: ctx.mine.descentHeading,
    });
    ctx.mine.descentHeading = result.heading ?? ctx.mine.descentHeading;

    // Nothing to dig with is not an obstacle to route around — no cave or
    // fresh ground will help. Hand the wheel back so `gear` can make a new
    // pickaxe; the stairs resume on the same heading afterwards.
    if (result.reason === 'no pickaxe') return result.depth > 0;

    if (!result.ok) {
      // A CAVE UNDER US IS NOT AN OBSTACLE. It is the way down.
      //
      // hasFooting refuses to step into open air, which is right — the drop
      // into a cavern at depth is simply death — but the conclusion drawn
      // from it was wrong. The staircase turns, turns again, reports "boxed
      // in", and the descent goes on a twenty-second cooldown. Watched live:
      // the bot pinned at y=34 for minutes with four hostiles below it,
      // cycling goDeep and idle, cobblestone climbing and iron at zero. It
      // was standing on the roof of exactly what it was looking for.
      //
      // A cave is hundreds of blocks of pre-exposed wall, it goes downward,
      // and pathfinder can walk into it safely because it respects its own
      // drop limit. So when the staircase fails, go and find the way in.
      const cave = findCave(bot);
      if (cave && cave.y < bot.entity.position.y - 1) {
        logger.action('Descent blocked, but there is a cave below — going in', {
          at: cave,
          y: Math.round(cave.y),
          insteadOf: result.reason ?? 'a blocked staircase',
        });
        try {
          await goNear(bot, cave, 2, task, { timeoutMs: 20000 });
          await grabOreInReach(bot, task);
          return true;
        } catch (err) {
          if (isInterruption(err)) throw err;
          logger.info('Could not get into the cave either', { reason: err.message });
        }
      }

      // BOXED IN IS ABOUT WHERE WE ARE STANDING, so stand somewhere else.
      //
      // Watched live: "Could not dig deeper {reason: boxed in, y: 62}" twice in
      // two minutes, with "Stuck in water — swimming out manually" between them.
      // The bot was on a lake shore, where `hasFooting` correctly refuses every
      // direction — water below, or a drop into it — so the staircase turned
      // four times and gave up. The old answer was a twenty-second cooldown,
      // after which `explore` wandered off and the bot tried again from
      // wherever it happened to end up.
      //
      // Twenty paces inland is a better answer than twenty seconds of nothing,
      // and it is what a player does without thinking about it. The heading is
      // cleared too, so the next staircase starts fresh rather than resuming
      // one that was cut in an unworkable spot.
      if (result.reason === 'boxed in' || result.reason === 'could not step down') {
        if (await relocateForDescent(bot, ctx, task)) return true;
      }

      // Only cool down on a GENUINE obstruction. A descent that merely ran
      // out of steps, or was cut short having already made progress, should
      // simply carry on next time — blocking for twenty seconds after every
      // hiccup is what kept the bot oscillating around y=65 instead of
      // arriving at y=16.
      ctx.mine.descentBlockedUntil = Date.now() + DESCENT_RETRY_MS;
      logger.info('Could not dig deeper', {
        reason: result.reason,
        y: Math.round(bot.entity.position.y),
        retryInMs: DESCENT_RETRY_MS,
      });
      return false;
    }

    logger.action('Descending', {
      reached: Math.round(bot.entity.position.y),
      target: band.best,
      thisRun: result.depth,
    });
    return result.depth > 0;
  },
};

/**
 * Dig a corridor at depth to expose fresh rock.
 *
 * `mine` can see ore through solid stone (findBlocks scans world data, not
 * line of sight) and will tunnel to anything worthwhile within 32 blocks.
 * But once it has cleared everything in that sphere it stalls: there is
 * nothing exposed to walk to, and at y=-59 there is usually nowhere to walk
 * either — it's solid deepslate in every direction.
 *
 * So the bot does what a player does and drives a branch tunnel, which both
 * moves the 32-block scan window into virgin rock and exposes ore in the
 * walls as it goes. This is the difference between finding a handful of
 * diamonds and finding the twenty-nine a full set needs.
 */
const STRIP_LENGTH = 12;

/**
 * Caves are ore, already exposed, for free.
 *
 * Strip mining drives a corridor through solid rock and reveals whatever
 * happens to touch it — roughly one block of wall per block dug. A cave has
 * done that work already, over hundreds of blocks of surface area, and the
 * ore in its walls needs no digging to find. A player heading for diamonds
 * goes caving; only when there is no cave do they cut a branch tunnel.
 *
 * Detection is by air where air should not be. Below the surface every
 * open block is either a cave or a tunnel the bot dug itself, so anything
 * far enough away to not be our own workings is a cave. Deliberately
 * conservative about distance for that reason.
 *
 * The danger is real and is handled by the rest of the system rather than
 * here: caves are dark and unlit ones spawn mobs, which is what `threat`,
 * the shield and the light checks are for.
 */
const CAVE_SEARCH_RADIUS = 40;
const OUR_OWN_TUNNEL = 10; // closer than this is probably something we dug
const CAVE_MIN_VOLUME = 14; // open blocks nearby before it counts as a cave

function looksLikeCave(bot, pos) {
  let open = 0;
  for (let dx = -2; dx <= 2; dx++) {
    for (let dy = -1; dy <= 2; dy++) {
      for (let dz = -2; dz <= 2; dz++) {
        const b = bot.blockAt(pos.offset(dx, dy, dz));
        if (b && b.boundingBox === 'empty' && !isLiquid(b)) open++;
      }
    }
  }
  return open >= CAVE_MIN_VOLUME;
}

/**
 * Sampled outward rather than via findBlocks.
 *
 * The obvious implementation — findBlocks for air — does not work, and fails
 * in a way that looks like "there are never any caves". findBlocks returns
 * the NEAREST matches, and underground the nearest air is always the tunnel
 * the bot is standing in: asking for sixty air blocks returns sixty blocks of
 * our own corridor, every one of which then gets discarded for being too
 * close. It would never once have found a cave.
 *
 * So this samples a coarse grid at genuine distance instead, and tests each
 * candidate for open volume. Far cheaper too — a few hundred block lookups
 * against a findBlocks sweep of a 40-block sphere.
 */
/**
 * Hard cap on the expensive check.
 *
 * The cheap filters (is this cell open, is there a floor) reject most of the
 * grid, but `looksLikeCave` inspects a 5x4x5 volume — a hundred block lookups
 * each — and in genuinely cavernous terrain a great many candidates pass the
 * cheap filters. Unbounded, the worst case is a quarter of a million lookups
 * on the same thread that runs pathfinding and combat, from a function called
 * every time strip mining starts. The cap keeps it to a few thousand.
 */
const CAVE_VOLUME_CHECKS = 25;

// `ctx` lets the scan pass over caves already written off. Without it the
// nearest cave won even when it was one the bot had just failed to reach, and
// caveWorthEntering then declined it — hiding a reachable second cave behind it.
function findCave(bot, ctx = null) {
  return lag.timeScan('findCave', () => caveScan(bot, ctx));
}

function caveScan(bot, ctx) {
  const me = bot.entity.position.floored();
  // Only caves at a depth worth being at. Cave work kept the bot following
  // floors downward — y=10 strip mining, a cave at -2, then -9, then -19 —
  // until nothing it needed was at that depth and it wandered.
  const band = ORE_DEPTH[neededResource(bot)] ?? null;
  let best = null;
  let bestDistance = Infinity;
  let volumeChecks = 0;

  for (let dx = -CAVE_SEARCH_RADIUS; dx <= CAVE_SEARCH_RADIUS; dx += 4) {
    for (let dz = -CAVE_SEARCH_RADIUS; dz <= CAVE_SEARCH_RADIUS; dz += 4) {
      for (let dy = -12; dy <= 4; dy += 3) {
        if (volumeChecks >= CAVE_VOLUME_CHECKS) return best;

        const pos = me.offset(dx, dy, dz);
        const distance = me.distanceTo(pos);
        if (distance < OUR_OWN_TUNNEL || distance > CAVE_SEARCH_RADIUS) continue;
        // Already found something closer — nothing further out can beat it.
        if (distance >= bestDistance) continue;

        const at = bot.blockAt(pos);
        const head = bot.blockAt(pos.offset(0, 1, 0));
        const under = bot.blockAt(pos.offset(0, -1, 0));
        if (!at || !head || !under) continue;
        if (at.boundingBox !== 'empty' || head.boundingBox !== 'empty') continue;
        if (isLiquid(at) || isLiquid(under)) continue;
        if (under.boundingBox !== 'block') continue; // need a floor to stand on
        if (ctx && caveIsDone(ctx, pos)) continue;
        if (band && (pos.y < band.min || pos.y > band.max)) continue;

        volumeChecks++;
        if (!looksLikeCave(bot, pos)) continue;

        best = pos;
        bestDistance = distance;
      }
    }
  }
  return best;
}

/**
 * Caves, properly: go in equipped, clear them out, and never come back.
 *
 * What this replaces was barely cave mining at all. It walked to the mouth,
 * took whatever ore happened to be within arm's reach, and returned — then
 * found the same cave on the next pass and did it again. Three things were
 * missing, and all three were reported.
 *
 *  1. IT NEVER WENT IN. One `grabOreInReach` at the entrance is not mining a
 *     cave, it is glancing at one. A cave is hundreds of blocks of
 *     pre-exposed wall and the whole reason to prefer it over a tunnel.
 *  2. IT WENT IN UNARMED. Caves are where the hostiles are. Walking into one
 *     with a wooden sword and no shield is how a session ends.
 *  3. IT KEPT GOING BACK. Nothing remembered a cave had been worked, so the
 *     bot could ping-pong between the same two forever.
 */
const CAVE_DONE_MS = 10 * 60 * 1000;
const CAVE_SAME_PLACE = 12;
/** How long to work one cave before handing the wheel back. */
const CAVE_SESSION_MS = 25000;
/** Give up on a cave once this many sweeps in a row find nothing. */
const CAVE_EMPTY_SWEEPS = 2;
/** Hostiles nearby that make an unshielded trip a bad idea. */
const CAVE_CROWD = 2;

function caveIsDone(ctx, pos) {
  const now = Date.now();
  ctx.mine.cavesDone = (ctx.mine.cavesDone ?? []).filter((c) => c.until > now);
  return ctx.mine.cavesDone.some((c) => c.pos.distanceTo(pos) <= CAVE_SAME_PLACE);
}

function noteCaveDone(ctx, pos) {
  ctx.mine.cavesDone = ctx.mine.cavesDone ?? [];
  ctx.mine.cavesDone.push({ pos: pos.clone(), until: Date.now() + CAVE_DONE_MS });
  // Bounded, so a long session cannot grow an unbounded blacklist.
  ctx.mine.cavesDone = ctx.mine.cavesDone.slice(-20);
}

/**
 * Are we equipped to go in, or is this a cave to walk past?
 *
 * The bar is a real weapon plus either a shield or an empty-looking cave.
 * A stone sword and a shield is the point at which a zombie in the dark is an
 * inconvenience rather than the end of the run.
 */
function readyForACave(bot) {
  const weapon = bestToolOfType(bot, 'sword');
  if (!weapon || weapon.name.startsWith('wooden')) return false;
  if (bot.health <= 12) return false;
  if (itemCount(bot, 'shield') > 0) return true;

  // No shield: only if it looks quiet in there.
  const hostiles = Object.values(bot.entities).filter(
    (e) => e !== bot.entity && e.isValid && e.type === 'hostile'
      && bot.entity.position.distanceTo(e.position) <= 20,
  ).length;
  return hostiles < CAVE_CROWD;
}

function caveWorthEntering(bot, ctx) {
  if (!readyForACave(bot)) return null;
  return findCave(bot, ctx);
}

/**
 * Work a cave until it stops paying, then write it off.
 *
 * Deliberately time-boxed rather than run to completion: the director must
 * get the wheel back so hunger, threats and the descent still get a look in.
 * Progress is remembered through the blacklist, so the next pass picks a
 * different cave rather than re-entering this one.
 */
// Long enough for any cave in CAVE_SEARCH_RADIUS that has a route; the ones
// that don't were costing the full twenty seconds to say so.
const CAVE_APPROACH_MS = 12000;

async function workTheCave(bot, ctx, task, entrance) {
  await goNear(bot, entrance, 2, task, { timeoutMs: CAVE_APPROACH_MS });

  const deadline = Date.now() + CAVE_SESSION_MS;
  let taken = 0;
  let emptySweeps = 0;

  while (Date.now() < deadline) {
    task.throwIfAborted();

    // Anything the cave has already laid bare is free.
    const got = await grabOreInReach(bot, task);
    taken += got;

    // Then walk to the nearest exposed ore the cave has revealed and take
    // that too. This is the part that was missing: `mine` would eventually
    // find it, but only after stripMine had returned and the scheduler had
    // gone round again — by which time the bot had usually wandered off.
    //
    // Force a fresh scan each pass. findOre is throttled and hands back its
    // cached candidate in between, which inside a tight loop means being
    // handed the block we just mined: the dig fails because it is gone, we
    // blacklist it, and the next pass is handed the same stale answer again.
    // That spins for the whole cave session achieving nothing.
    dropCandidate(ctx);
    const next = findOre(bot, ctx);
    if (!next?.block) {
      emptySweeps++;
      if (emptySweeps >= CAVE_EMPTY_SWEEPS) break;
      // Move deeper in and look again before giving up on it.
      const deeper = findCave(bot, ctx);
      if (!deeper || deeper.distanceTo(bot.entity.position) < 3) break;
      await goNear(bot, deeper, 2, task, { timeoutMs: 12000 })
        .catch((err) => { if (isInterruption(err)) throw err; });
      continue;
    }

    emptySweeps = 0;
    if (!wantThisOre(bot, next.block.name)) {
      ctx.mine.skipped.set(posKey(next.block.position), Date.now() + SKIP_MEMORY_MS);
      continue;
    }

    await goToBlock(bot, next.block, task, { within: GATHER_REACH })
      .catch((err) => { if (isInterruption(err)) throw err; });
    if (await digBlock(bot, next.block, task)) {
      taken++;
      await stepOntoDrop(bot, next.block.position, task);
    } else {
      ctx.mine.skipped.set(posKey(next.block.position), Date.now() + SKIP_MEMORY_MS);
    }
  }

  noteCaveDone(ctx, entrance);
  logger.action('Worked the cave out', {
    ore: taken,
    at: entrance,
    note: 'will not come back to this one',
  });
  return taken;
}

/**
 * How long one strip run may take: well inside the director's deadlock
 * breaker, with room left for the ore sweep and drop pickup that follow the
 * last step. Derived, so raising one cannot quietly break the other.
 */
const STRIP_BUDGET_MS = WORK_BUDGET_MS;

function turnLeft([dx, dz]) {
  return [dz, -dx];
}

/**
 * Tunnel round copper, not through it.
 *
 * Every other path already refused to go LOOKING for ore the bot has no use
 * for, but the corridor dug whatever stood in front of it — and in a copper
 * seam that is most of what it dug, each block handing tidy another stack to
 * throw away. The user's call: steer round it, and only dig through when every
 * way on is ore or unsafe.
 */
function unwantedOreAhead(bot, feet, [dx, dz]) {
  return [feet.offset(dx, 0, dz), feet.offset(dx, 1, dz)]
    .some((pos) => isUnwantedOre(bot.blockAt(pos)?.name));
}

function steerAroundUnwantedOre(bot, feet, heading) {
  if (!unwantedOreAhead(bot, feet, heading)) return heading;
  const around = [turnLeft(heading), turnRight(heading)].find((h) => !unwantedOreAhead(bot, feet, h)
    && [feet.offset(h[0], 0, h[1]), feet.offset(h[0], 1, h[1])].every((pos) => {
      const block = bot.blockAt(pos);
      return !block || block.boundingBox === 'empty' || safeToDig(bot, block);
    }));
  return around ?? heading; // boxed in by it: dig through after all
}

const stripMine = {
  name: 'stripMine',
  // Below `mine`: ore we already know about always beats digging blind.
  priority: 23,
  shouldRun(bot, ctx) {
    const pick = bestToolOfType(bot, 'pickaxe');
    if (!pick || pick.name.startsWith('wooden')) return false;

    const resource = neededResource(bot);
    if (!resource) return false;
    // Only strip-mine at the depth the ore actually peaks at. Digging inside
    // the wider band is the classic way to waste an hour for one diamond —
    // and it is precisely what this used to do, tunnelling at y=56 for iron
    // that is forty blocks lower down.
    if (!worthStripMiningHere(bot, resource)) return false;

    // Never strip-mine while short of food or wood.
    //
    // This is the bottleneck, and it is a priority inversion: stripMine sits
    // at 23 and `wood` at 10 (and `hunt` was once at 12), so once it started digging it
    // outranked the only two behaviors that could fix what was blocking it.
    // Watched live — the bot drove a 60-block tunnel at y=69 hunting coal
    // with "need: food,wood" on every status line, while the charcoal that
    // would have ended the search needs logs it was too busy to go and cut.
    //
    // Deliberately only food and wood: cobblestone and coal are down here,
    // and stopping for those would be the same mistake in reverse. And the
    // SURVIVAL bar, not the trip bar — by the time we are strip mining at
    // ore depth, "go up because you are one plank short" is nonsense.
    const blocking = descentShortfall(bot).filter((m) => m === 'food' || m === 'wood');
    if (blocking.length > 0) {
      ctx.mine.lastShortfall = blocking.join(',');
      return false;
    }

    // If there's ore to go and get, go and get it instead.
    return !findOre(bot, ctx);
  },
  async run(bot, ctx, task) {
    // A cave beats a tunnel, every time.
    //
    // Strip mining exposes about one block of wall per block dug. A cave has
    // already exposed hundreds, and the ore in them costs nothing to find.
    // So before cutting a fresh corridor, check whether there is one nearby
    // to walk into instead.
    const cave = caveWorthEntering(bot, ctx);
    if (cave) {
      logger.action('Cave nearby — mining that instead of digging blind', {
        at: cave,
        distance: Math.round(bot.entity.position.distanceTo(cave)),
        y: Math.round(cave.y),
      });
      try {
        const got = await workTheCave(bot, ctx, task, cave);
        return got > 0 || !!findOre(bot, ctx);
      } catch (err) {
        if (isInterruption(err)) throw err;
        // Couldn't reach it — fall through and dig the corridor after all.
        logger.info('Could not get into the cave, tunnelling instead', {
          reason: err.message,
        });
        noteCaveDone(ctx, cave);
      }
    }

    if (!ctx.mine.stripHeading) {
      const options = [[1, 0], [-1, 0], [0, 1], [0, -1]];
      ctx.mine.stripHeading = options[Math.floor(Math.random() * options.length)];
    }

    const startedAt = Date.now();
    let dug = 0;
    for (let i = 0; i < STRIP_LENGTH; i++) {
      task.throwIfAborted();
      // Hand back before the director's deadlock breaker does. Cut off at
      // sixty seconds, a run is scored as wedged and benched for fifteen more
      // — twice on 09-24, both times mid-tunnel with nothing wrong. Ending the
      // run here costs nothing: the next one carries on from where this stood.
      if (Date.now() - startedAt > STRIP_BUDGET_MS) break;
      // Same rule as the staircase: a broken pickaxe ends the tunnel rather
      // than turning it into minutes of digging by hand.
      if (!bestToolOfType(bot, 'pickaxe')) break;
      const feet = feetCell(bot);
      ctx.mine.stripHeading = steerAroundUnwantedOre(bot, feet, ctx.mine.stripHeading);
      const [dx, dz] = ctx.mine.stripHeading;

      // A 1x2 corridor: body height and head height.
      let blocked = false;
      let dugFalling = false;
      for (const pos of [feet.offset(dx, 0, dz), feet.offset(dx, 1, dz)]) {
        const block = bot.blockAt(pos);
        if (!block || (block.boundingBox === 'empty' && !isLiquid(block))) continue;
        if (!safeToDig(bot, block)) {
          blocked = true;
          break;
        }
        if (await digBlock(bot, block, task)) {
          dug++;
          if (isFallingBlock(block)) dugFalling = true;
        }
      }
      if (blocked) {
        // Sweep before turning away. Turning used to skip the sweep, and the
        // corner a tunnel turns at is as likely to hold ore as anywhere.
        dug += await grabOreInReach(bot, task);
        ctx.mine.stripHeading = turnRight(ctx.mine.stripHeading);
        continue;
      }

      // Clear any gravel or sand hanging over the space we are about to walk
      // into, BEFORE walking into it — see clearOverheadFalling.
      dug += await clearOverheadFalling(bot, task, feet.offset(dx, 1, dz));

      // A gravel column does not come down all at once. Dig the bottom block
      // and the rest is a falling ENTITY for a few ticks — the cell above reads
      // as air, clearOverheadFalling finds nothing, the bot steps in, and the
      // column lands in its head cell. Buried three times on 09-24 exactly so.
      // Let it land, then go round again to dig out whatever came down.
      if (dugFalling) {
        await sleep(GRAVEL_SETTLE_MS, task);
        const settled = [feet.offset(dx, 0, dz), feet.offset(dx, 1, dz)]
          .every((pos) => bot.blockAt(pos)?.boundingBox !== 'block');
        if (!settled) continue;
      }

      // Walk into the space we just opened.
      const ahead = feet.offset(dx, 0, dz);
      if (!(await stepTo(bot, ahead, task))) {
        dug += await grabOreInReach(bot, task);
        ctx.mine.stripHeading = turnRight(ctx.mine.stripHeading);
        continue;
      }

      // Whatever the corridor just uncovered, take it now rather than
      // hoping a later behavior cycle comes back for it.
      dug += await grabOreInReach(bot, task);

      // Bail out early if the scan now shows ore further off — that's the
      // whole point of driving the tunnel.
      if (findOre(bot, ctx)) break;
    }

    if (dug > 0) logger.action('Strip mining', { blocks: dug, y: Math.round(bot.entity.position.y) });
    return dug > 0;
  },
};

/**
 * Clear the stone immediately around a block we just mined.
 *
 * Bounded deliberately: enough to make the trip worthwhile, not so much that
 * the bot disappears into a quarry and stops re-checking its priorities. It
 * refuses anything unsafe or unfooted for the same reasons the staircase
 * does — an unlucky neighbour is a lava pocket or the ceiling of a cavern.
 */
const NEIGHBOUR_BATCH = 5;

/**
 * Take any ore already within arm's reach, whatever we were doing.
 *
 * Reported directly: the bot had iron ore in plain view while gathering
 * stone and walked past it. The cause is a priority inversion — gatherStone
 * sits at 28 and `mine` at 25, so once the bot is gathering stone nothing
 * can interrupt it to go and take the vein it just exposed. And exposing
 * veins is precisely what stone gathering and strip mining DO.
 *
 * Rather than fight the priorities, every mining action now sweeps its own
 * surroundings. Ore in reach is free — no pathing, no decision, no detour —
 * and skipping it is how a bot strip-mines past the iron it is looking for.
 *
 * Deliberately no Jev call: a block already at arm's length is not a
 * judgement call, it is arithmetic, and the model is for the cases where
 * walking somewhere is at stake.
 */
// Measured from the eyes to the block's centre — see eyeReachTo — so this is
// the game's own dig reach rather than a second, differently-shaped guess.
const OPPORTUNIST_REACH = DIG_REACH;

// Enough for any real vein, bounded so a corrupted chunk or a vast one cannot
// hold the bot here forever.
const MAX_VEIN_DIGS = 24;

/**
 * Every ore block within arm's reach, scanned directly rather than through
 * findBlocks.
 *
 * findBlocks is the wrong tool at this radius and it is called on every step
 * of every strip-mining run. It works in 16x16x16 sections: ask it for a
 * 4-block radius and it still walks whole sections, running the full
 * 4096-position inner loop for each one whose palette contains an ore. A
 * direct 9x9x9 sweep is 729 lookups, exact, and cannot surprise us.
 */
function oresInReach(bot, reach) {
  return lag.timeScan('oresInReach', () => oreSweep(bot, reach));
}

function oreSweep(bot, reach) {
  const origin = bot.entity.position.floored();
  const r = Math.ceil(reach);
  const out = [];
  for (let dx = -r; dx <= r; dx++) {
    // Reach is from the eyes, so it extends further up than down.
    for (let dy = -r + 1; dy <= r + 1; dy++) {
      for (let dz = -r; dz <= r; dz++) {
        const pos = origin.offset(dx, dy, dz);
        if (eyeReachTo(bot, pos) > reach) continue;
        const block = bot.blockAt(pos);
        if (block && ORES.includes(block.name)) out.push(pos);
      }
    }
  }
  return out;
}

/**
 * Is this ore on the path to a diamond kit, or merely shiny?
 *
 * ENOUGH already answers this — copper, lapis, redstone, gold and emerald are
 * all zero, because none of them is a step toward 29 diamonds. `mine` honours
 * it through instinctiveOreVerdict; `grabOreInReach` did not, and it is the
 * one that fires on every step of every tunnel. So the bot spent its time
 * mining lapis, carrying lapis, and burning furnace fuel smelting copper it
 * would never use.
 */
/**
 * Is this the resource the run is currently gated on?
 *
 * Diamond is always on that list — it is the goal — and so is whatever
 * `neededResource` has named, which is iron until the kit is built. Everything
 * else is a detour, and detours are what Jev is for.
 */
function mustHave(bot, blockName) {
  const yieldName = yieldOf(blockName);
  if (!yieldName) return false;
  if (!wantThisOre(bot, blockName)) return false;
  // Iron the kit still needs is important at ANY depth — below iron's band
  // neededResource says diamond, but a bag short of armour still wants every
  // iron it passes.
  if (yieldName === 'raw_iron') return true;
  return yieldName === 'diamond' || yieldName === neededResource(bot);
}

function wantThisOre(bot, blockName) {
  // Before any target: tidy would throw the drop straight back out.
  if (isUnwantedOre(blockName)) return false;
  const yieldName = yieldOf(blockName);
  if (!yieldName) return true; // unknown ore: probably worth having
  // What the kit still lacks, not a fixed total — see gear.ironStillNeeded.
  if (yieldName === 'raw_iron') return ironStillNeeded(bot) > 0;
  const enough = ENOUGH[yieldName] ?? 0;
  if (enough === 0) return false;
  return stockOf(bot, yieldName) < enough;
}

/**
 * The nearest ore in reach that is worth digging right now, or null.
 */
function nextOreInReach(bot, refused) {
  const pickTier = bestToolOfType(bot, 'pickaxe')?.name.split('_')[0] ?? null;
  if (!pickTier) return null;
  let best = null;
  let bestReach = Infinity;
  for (const pos of oresInReach(bot, OPPORTUNIST_REACH)) {
    if (refused.has(posKey(pos))) continue;
    const block = bot.blockAt(pos);
    if (!block) continue;
    // Free is not the same as worth having. A block in arm's reach still
    // costs a dig, a pickup, a slot and a pickaxe swing.
    if (!wantThisOre(bot, block.name)) continue;
    // digBlock refuses ore we cannot harvest, but checking here too keeps
    // the log quiet and saves the tool swap.
    if (!canHarvest(pickTier, block.name)) continue;
    if (!isExposed(bot, pos) || !safeToDig(bot, block)) continue;
    const reach = eyeReachTo(bot, pos);
    if (reach < bestReach) {
      best = block;
      bestReach = reach;
    }
  }
  return best;
}

function noteRestOfVein(bot, refused) {
  let left = 0;
  let next = nextOreInReach(bot, refused);
  while (next && left < MAX_VEIN_DIGS) {
    memory.noteOre(next.position, next.name, 'unfinished vein');
    left++;
    refused.add(posKey(next.position));
    next = nextOreInReach(bot, refused);
  }
  if (left) logger.info('Out of time on this vein — noted the rest to come back for', { left });
}

/**
 * Take every wanted ore in reach — including the ones that taking the first
 * one uncovers.
 *
 * This made ONE pass over a list it built once, and that is why veins were
 * left half-mined. The list is ordered by offset, so ore in the floor beneath
 * ore at foot level was checked first, found buried, and skipped; the block
 * above it was then dug, uncovering it, and nothing looked again. At the end of
 * a tunnel there is no next step to look from, so it stayed — live on 09-24,
 * two iron ore left in the floor at the very end of a strip tunnel.
 *
 * So: take the nearest, look again, repeat. Every dig exposes the next block of
 * the vein, which is all following a vein is.
 */
async function grabOreInReach(bot, task, deadline = Infinity) {
  const refused = new Set(); // digBlock said no; asking again changes nothing
  let taken = 0;
  while (taken < MAX_VEIN_DIGS) {
    task.throwIfAborted();
    const block = nextOreInReach(bot, refused);
    if (!block) break;
    // Out of time: hand back BEFORE the director has to cut us off, and write
    // down what is left so the next run comes back for it. Cut off mid-vein on
    // 09-24, the bot was benched, explored away, and left a diamond in the wall.
    if (Date.now() > deadline) {
      noteRestOfVein(bot, refused);
      break;
    }
    const pos = block.position;
    if (!(await digBlock(bot, block, task))) {
      refused.add(posKey(pos));
      continue;
    }
    taken++;
    await stepOntoDrop(bot, pos, task);
    logger.action('Took the ore while I was here', {
      ore: block.name,
      y: Math.round(pos.y),
    });
    announceDiamond(bot, block);
  }
  return taken;
}

async function mineNeighbours(bot, origin, task) {
  const offsets = [
    [1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1],
    [1, 1, 0], [-1, 1, 0], [0, 1, 1], [0, 1, -1],
  ];

  let mined = 0;
  for (const [dx, dy, dz] of offsets) {
    if (mined >= NEIGHBOUR_BATCH) break;
    task.throwIfAborted();

    const pos = origin.offset(dx, dy, dz);
    const block = bot.blockAt(pos);
    if (!block || !STONE.includes(block.name)) continue;
    if (bot.entity.position.distanceTo(pos) > 4.2) continue;
    if (!safeToDig(bot, block)) continue;
    // Never mine out our own floor — found with groundUnder, not floor(y)-1,
    // which at y=N.99999 names the block BELOW the floor and lets the real one
    // be dug out from under us. See nav.js.
    const floor = groundUnder(bot);
    if (floor && pos.equals(floor.position)) continue;

    if (await digBlock(bot, block, task)) {
      mined++;
      await stepOntoDrop(bot, pos, task);
    }
  }
  return mined;
}

/**
 * Knowing when to come back up.
 *
 * `goDeep` has always known when to descend — `deepTripShortfall` lists what
 * the trip needs and refuses to start without it. Nothing knew when to STOP,
 * so the bot would go down properly equipped, burn through its food and its
 * pickaxe, and then keep tunnelling at depth with no way to fix either: there
 * are no animals at y=16 and no trees at y=-59. It would mine until it
 * starved or until its last pickaxe broke, and then stand there.
 *
 * These are the two things that genuinely cannot be solved underground. Stone
 * and coal are down there; food and wood are not.
 */
const RESUPPLY_FOOD = 2;
/**
 * Deliberately well below DEEP_TRIP_NEEDS.planks.
 *
 * The descent gate and the come-back-up gate must not overlap, or the bot
 * yo-yos: it surfaces because wood is low, tops up to just past the trip
 * threshold, descends, spends a little, and immediately surfaces again. The
 * gap between DEEP_TRIP_NEEDS.planks and RESUPPLY_WOOD is the working margin that stops that.
 */
const RESUPPLY_WOOD = 6;
/**
 * How far below the surface counts as being on a TRIP.
 *
 * `resupply` exists for one situation: the bot is deep, it is short of
 * something that only exists up top, and the right move is to climb. Gated at
 * y<63 it also fired for the shallow hole `gatherStone` digs looking for
 * stone — and then the two fought. Watched live at y=61: resupply climbs
 * three blocks and reports success, gatherStone immediately digs back down
 * because it still wants five more cobblestone, resupply fires again. Neither
 * behavior was wrong on its own; the trigger was simply measuring the wrong
 * thing.
 *
 * Eight blocks down is the difference between "in a hole I just dug" and "on
 * a trip". Above that the surface is a few steps away and the ordinary
 * gathering behaviors can reach it without a dedicated climb.
 */
const TRIP_DEPTH_Y = SURFACE_Y - 8;

function surfaceOnlyShortfall(bot) {
  const missing = [];
  if (countAny(bot, EDIBLE) < RESUPPLY_FOOD) missing.push('food');

  // Wood is what a replacement tool handle is made of. Out of it at depth
  // means the next broken pickaxe ends the trip regardless of how much
  // cobblestone is in the bag. Same measure as deepTripShortfall — see
  // woodUnits for why that consistency matters.
  if (woodUnits(bot) < RESUPPLY_WOOD) missing.push('wood');

  return missing;
}

/**
 * The dead zone between "enough to keep working" and "enough to descend".
 *
 * These are two different thresholds and the gap between them is deliberate —
 * they must not overlap, or the bot yo-yos to the surface every time it burns
 * a plank. But a gap has an inside, and the inside is a deadlock:
 *
 *   underground at y=48 with 7 wood
 *   goDeep wants 16 and refuses, reporting "need: wood"
 *   stripMine wants to be at y=16 and refuses
 *   resupply wants wood below 6 and refuses
 *   there are no trees at y=48
 *
 * Nothing moves. The bot has everything it needs except the one thing that
 * only exists 25 blocks above it, and not one behavior is willing to go and
 * get it. That is the same shape as every other stall this project has had:
 * two thresholds that are individually reasonable and jointly impossible.
 *
 * So the second trigger is the honest one — go up when being down here is
 * what is BLOCKING us, not merely when we have run out. The yo-yo is still
 * prevented, by the fact that surfacing sends `wood` to fell whole trees:
 * one tree is four to seven logs, sixteen to twenty-eight units, so the bot
 * comes back down well clear of the threshold rather than one plank over it.
 */
function blockedFromDescending(bot) {
  const resource = neededResource(bot);
  if (!resource) return [];
  // Already where the ore is — nothing is blocked, so there is nothing to go
  // up for. This is what stops it firing forever once the trip is done.
  if (atBestDepth(bot, resource)) return [];
  return descentShortfall(bot).filter((m) => m === 'food' || m === 'wood');
}

/**
 * STARTING a trip and CONTINUING one are different questions, and asking the
 * strict one on every step is what has kept the bot at stone tier.
 *
 * `deepTripShortfall` is the kit list: DEEP_TRIP_NEEDS' food, planks' worth
 * of wood, and blocks to climb out with. That is the right bar to set off
 * from the surface with — everything on it is cheap up there and impossible
 * to get at depth.
 *
 * But `goDeep` re-evaluates it on every single scheduling round, all the way
 * down. So the moment the bot burned one plank at y=34 it dropped to fifteen,
 * the descent stopped, `resupply` fired, and it climbed forty blocks to fetch
 * a log — then descended again, spent another plank, and climbed again. Its
 * deepest point all session was y=34 against a target of 16, with a hundred
 * and eighty cobblestone in the bag and no iron at all.
 *
 * Once underground the only question worth asking is whether it can survive
 * finishing the job, which is the far lower bar `surfaceOnlyShortfall`
 * already defines: genuinely out of food, or genuinely out of wood. Climbing
 * forty blocks to top up one plank is never the right answer.
 */
function descentShortfall(bot) {
  // Open sky counts as the surface too, whatever the height. SURFACE_Y is sea
  // level, and beaches, swamps and river valleys sit at 62 — where the lenient
  // continue-the-trip bar let a bot START a descent on two food and six wood,
  // with no weapon check at all, from ground where the full kit was a short
  // walk away. The same rule as the forage climb: low is not underground.
  const onSurface = bot.entity.position.y >= SURFACE_Y || !isUnderground(bot);
  return onSurface ? deepTripShortfall(bot) : surfaceOnlyShortfall(bot);
}

/**
 * Not up into the dark for a top-up.
 *
 * Underground at night is the safe place and the surface is the dangerous
 * one, so climbing out to restock at night walks straight into what `shelter`
 * exists to avoid — and then `shelter` digs a fresh hole at the top, and the
 * whole descent is thrown away. Live on 09-25 the bot was 19 blocks down its
 * night staircase with "need: food" on the status line, four meals short of
 * a six-meal trip, at full hunger. That can wait for the morning. Actually
 * starving cannot, and is let through.
 */
function nightOnTheSurface(bot) {
  // Lazy: shelter and hunt both require this module.
  const { nightComing, nightProof } = require('./shelter');
  const { larderEmergency } = require('./hunt');
  return nightComing(bot) && !nightProof(bot) && !larderEmergency(bot);
}

const resupply = {
  name: 'resupply',
  // Above gear and smelting: there is no point crafting at depth when the
  // materials for it are all on the surface. Below collect, because drops
  // underfoot are worth two seconds on the way out.
  priority: 43,
  shouldRun(bot) {
    if (bot.entity.position.y >= TRIP_DEPTH_Y) return false;
    if (!isUnderground(bot)) return false;
    if (nightOnTheSurface(bot)) return false;
    return surfaceOnlyShortfall(bot).length > 0 || blockedFromDescending(bot).length > 0;
  },
  async run(bot, ctx, task) {
    const missing = surfaceOnlyShortfall(bot).length
      ? surfaceOnlyShortfall(bot)
      : blockedFromDescending(bot);
    const startY = bot.entity.position.y;

    logger.action('Heading back up to restock', {
      missing,
      y: Math.round(startY),
      // Say the rule out loud, so the decision is auditable rather than
      // something the bot appears to do at random.
      because: 'neither food nor wood exists at this depth',
    });

    try {
      // Climb ABOVE the trigger height, not to it.
      //
      // Targeting SURFACE_Y exactly was a hot loop: goToHeight is satisfied
      // at `y >= target - 1`, so standing at 62 with a target of 63 counted
      // as already arrived. It returned success without moving, the director
      // scored that as work done, and shouldRun — which fires below 63 — was
      // still true. The bot sat at 437,62,489 running `resupply` forever.
      await goToHeight(bot, SURFACE_Y + 4, task);
    } catch (err) {
      if (isInterruption(err)) throw err;
      // Couldn't climb — a staircase is the reliable way out when pathfinder
      // can't find one, and it's the same move that got us down here.
      logger.info('No route up — cutting a staircase out', { error: err.message });
      // Retrace the descent rather than cutting a second shaft beside it.
      await digStaircaseUp(bot, task, { startHeading: ctx.mine.descentHeading });
    }

    // Report honestly, and "honestly" means GOT THERE, not "went up a bit".
    //
    // Gaining one block counted as success, so a climb that stopped four
    // blocks short still cleared the no-op backoff — and the bot was then
    // free to be pulled straight back down by the next behavior and try
    // again. Arriving at the surface is the only outcome that actually fixes
    // what this behavior fired for.
    const climbed = bot.entity.position.y - startY;
    const arrived = bot.entity.position.y >= SURFACE_Y;
    if (!arrived) {
      logger.info('Did not make it back to the surface', {
        y: Math.round(bot.entity.position.y),
        climbed: Math.round(climbed),
        wanted: SURFACE_Y,
      });
      // Real height gained is still progress worth keeping — it just is not
      // finished, so let it be picked again rather than backed off.
      return climbed >= 3;
    }
    return true;
  },
};

/** Cut steps upward when pathfinder can't find a way out. */
const MAX_CLIMB_STEPS = 20;

async function digStaircaseUp(bot, task, opts = {}) {
  const { targetY = SURFACE_Y, startHeading = null } = opts;
  const startY = bot.entity.position.y;
  /**
   * Climb back the way we came in.
   *
   * This started east, every time, regardless of which way the staircase down
   * actually went — so the way out was a brand new shaft cut through virgin
   * rock rather than the flight of stairs already standing right there. Twice
   * the digging for the same trip, and the two workings crossed each other.
   */
  let heading = startHeading ? [-startHeading[0], -startHeading[1]] : [1, 0];
  let blockedTurns = 0;

  for (let step = 0; step < MAX_CLIMB_STEPS; step++) {
    task.throwIfAborted();
    const feet = feetCell(bot);

    // THE CEILING OVER OUR OWN HEAD COUNTS.
    //
    // A step up is a jump, and a jump needs somewhere to put your head. In a
    // corridor the bot cut itself — two blocks tall, because that is all
    // walking needs — the block at feet+2 is solid stone, so every jump landed
    // straight into it and the bot went nowhere. It dug the two blocks ahead
    // perfectly correctly and then could not use them.
    //
    // This is the mirror of the missing block on the way down, and it is the
    // rest of "his going up method is so weird".
    //
    //   feet+2          the ceiling, so we can rise at all
    //   ahead+1/ahead+2 the doorway we are rising into
    let blocked = false;
    const { ceiling, riseFeet, riseHead } = climbCells(feet, heading);
    for (const pos of [ceiling, riseFeet, riseHead]) {
      const block = bot.blockAt(pos);
      if (!block || block.boundingBox === 'empty') continue;
      if (!safeToDig(bot, block) || !(await digBlock(bot, block, task))) {
        task.throwIfAborted();
        heading = turnRight(heading);
        blocked = true;
        blockedTurns++;
        break;
      }
    }
    if (blocked) {
      if (blockedTurns > 4) break;
      continue;
    }
    blockedTurns = 0;

    // The same gravel rule as the way down. Both columns just lost their
    // support: the ceiling over our own head, and the one over the step we are
    // about to rise into. Whatever comes down lands in cells this loop digs
    // anyway, so go round again rather than jumping up into it.
    const fell = await clearOverheadFalling(bot, task, ceiling)
      + await clearOverheadFalling(bot, task, riseHead);
    if (fell > 0) continue;

    const before = bot.entity.position.y;
    await stepTo(bot, riseFeet, task, { jump: true, ms: 600 });
    if (bot.entity.position.y <= before + 0.4) {
      heading = turnRight(heading);
      blockedTurns++;
      if (blockedTurns > 4) break;
    }
    if (bot.entity.position.y >= targetY) break;
  }
  return Math.max(0, Math.round(bot.entity.position.y - startY));
}

const gatherStone = {
  name: 'gatherStone',
  priority: 28, // just above ore mining: it unblocks the furnace/stone tools
  shouldRun(bot, ctx) {
    if (!bestToolOfType(bot, 'pickaxe')) return false;
    if (!needsCobble(bot)) return false;

    // Exposed only — stone sealed inside rock drops into a pocket we can't
    // reach, so mining it is worse than useless.
    if (findExposedStone(bot, ctx)) return true;

    // Otherwise digging down is the only option, so respect the cooldown
    // from the last failed descent rather than retrying every tick.
    return Date.now() > (ctx.mine.descentBlockedUntil || 0);
  },
  async run(bot, ctx, task) {
    const block = findExposedStone(bot, ctx);

    const descend = async () => {
      const result = await digStaircaseDown(bot, task);
      if (!result.ok) {
        // Remember the failure so we don't immediately try the same thing
        // from the same spot — that produced a steady drip of no-op runs.
        ctx.mine.descentBlockedUntil = Date.now() + DESCENT_RETRY_MS;
        logger.info('Could not dig down to stone', { reason: result.reason });
        return false;
      }

      // ok with zero depth means "you are already standing on stone" — which
      // is success for the descent and NOTHING for this behavior. Reporting
      // it as work meant gatherStone never backed off: it logged "no exposed
      // stone nearby, digging down" every five seconds for minutes while the
      // bot's Y never changed and nothing else got a turn.
      if (!result.depth) {
        ctx.mine.descentBlockedUntil = Date.now() + DESCENT_RETRY_MS;
        logger.info('Already at stone level but nothing minable here — moving on');
        return false;
      }
      return true;
    };

    if (!block) {
      // No stone in sight — it's under our feet, so go down to it.
      logger.action('No exposed stone nearby, digging down');
      return descend();
    }

    try {
      // Stand right next to it: we want the cobblestone, not just the hole.
      await goToBlock(bot, block, task, { within: GATHER_REACH });
    } catch (err) {
      if (isInterruption(err)) throw err;
      // Can't walk to it (it's buried and we no longer tunnel) — dig down.
      return descend();
    }
    const dug = await digBlock(bot, block, task);
    if (dug) {
      await stepOntoDrop(bot, block.position, task);
      // Take the neighbours too while we are standing here.
      //
      // Same economics as felling a whole tree: the walk costs seconds and
      // the block costs a fraction of one, so one block per trip paid the
      // travel cost twenty times over to reach a target of twenty
      // cobblestone. Cobble gates the furnace, stone tools and the first
      // real pickaxe, so every trip saved here moves the entire progression
      // forward.
      const extra = await mineNeighbours(bot, block.position, task);
      // Anything we just exposed is free to take.
      await grabOreInReach(bot, task);
      logger.action('Gathered stone', {
        block: block.name,
        blocks: 1 + extra,
        stoneMaterial: countAny(bot, STONE_MATERIAL),
        target: COBBLE_TARGET,
        // Diagnostics: the counter sat at 0 while the bot mined stone over
        // and over. Mining stone bare-handed still BREAKS it (so the dig
        // reports success) but drops nothing, and a full inventory silently
        // refuses pickups — these two fields tell the two apart.
        held: bot.heldItem?.name ?? 'nothing',
      });
    }
    return dug;
  },
};

module.exports = {
  mine, gatherStone, goDeep, stripMine, resupply,
  // hunt.js holds its top-up to the same rule.
  nightOnTheSurface,
  // Exported for the tests — these decide whether the bot survives at
  // diamond depth and whether the progression can deadlock, so they're
  // worth exercising directly.
  safeToDig, hasFooting, lavaAdjacent, ORE_DEPTH, DIAMOND_GOAL,
  rememberFailedTarget, UNREACHABLE_MEMORY_MS, LAVA_ROUTE_MEMORY_MS,
  neededResource, deepTripShortfall, DEEP_TRIP_NEEDS, ENOUGH,
  // Exported for test/thresholds.test.js, which asserts the relationships
  // between the numbers that have to agree across files. Five separate stalls
  // in this project have been two such numbers drifting apart.
  COBBLE_TARGET, RESUPPLY_FOOD, RESUPPLY_WOOD,
  // shelter.js drives this to spend the night making progress instead of
  // sitting in a hole waiting for a sunrise it cannot see.
  digStaircaseDown,
  // For src/prefetch.js — same questions, asked early.
  buildOreState, visibleOreTypes, buildStrategyState,
  // The geometry of a step, up and down. Getting it wrong does not throw — it
  // produces a bot that walks into a wall on every step and then reports itself
  // boxed in, which is what "his digging method is so weird" turned out to be.
  // See test/staircase.test.js.
  stairCells, climbCells,
  // The proactive half of the gravel-collapse fix — see mining.test.js.
  isFallingBlock, clearOverheadFalling,
  // The scan-throttle pair. Dropping a candidate and re-opening the scan have
  // to happen together, and the long throttle is only safe because they do —
  // mining.test.js asserts both halves, including that no other site in this
  // file clears the candidate on its own.
  dropCandidate, SCAN_THROTTLE_MS, EXHAUSTIVE_SCAN_THROTTLE_MS,
  // A route failure rules out the whole vein — see veinOf.
  veinOf,
  // Ore left in veins, walls and floors — see grabOreInReach. And copper dug
  // because it stood in the way — see steerAroundUnwantedOre.
  grabOreInReach, steerAroundUnwantedOre, UPWARD_ORE_LIMIT, DIG_REACH, STRIP_BUDGET_MS,
  findCave, noteCaveDone, findOre, valuables, WORK_BUDGET_MS, worthStripMiningHere,
  // For src/progression.js: the continue-the-trip bar, and what valuables would
  // go for — the cheap-win bypass measures its distance.
  descentShortfall, importantOreInView,
  // src/prefetch.js refreshes a verdict just before this runs out.
  ORE_VERDICT_TTL_MS,
  // shelter.js logs "underground at night" only above this.
  TRIP_DEPTH_Y,
};
