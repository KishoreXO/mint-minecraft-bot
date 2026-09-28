const path = require('path');
const mineflayer = require('mineflayer');
const { pathfinder, Movements } = require('mineflayer-pathfinder');
const customPvp = require('@nxg-org/mineflayer-custom-pvp').default;
// Old-style plugin: the module is a FACTORY that takes mineflayer and
// returns the injector. Passing the module itself to loadPlugin silently
// does nothing — bot.bloodhound is simply never defined.
const bloodhound = require('mineflayer-bloodhound')(mineflayer);
const { plugin: toolPlugin } = require('mineflayer-tool');
const armorManager = require('mineflayer-armor-manager');
const { loader: autoEat } = require('mineflayer-auto-eat');
const config = require('./config');
const logger = require('./logger');
const { applyEatingPolicy } = require('./eating');
// One table decides which tool breaks which block — including for the digging
// pathfinder does on its own. See bestHarvestTool below.
const { toolTypeForBlock, bestToolOfType } = require('./inventory');
const { isWeaponOrGear } = require('./tools');
const { trackOwnAir } = require('./swim');
const { ORE_BLOCKS } = require('./knowledge');
const { lavaBeside } = require('./lava');
const { SAFE_DROP, MAX_DROP_DOWN } = require('./falls');
const memory = require('./memory');
const { eyeInWater } = require('./water');

/**
 * Combat tuning for @nxg-org/mineflayer-custom-pvp.
 *
 * Every value here is chosen to make the bot look and behave like a player
 * rather than a script — see the long note in createBot about fullStop.
 */
const SWORD_PVP_CONFIG = {
  genericConfig: {
    viewDistance: 32,
    // Reach abuse: a player's entity reach is 3.0 blocks, while a zombie's
    // is about 2.2 and a spider's about 2.0. Hovering at the outer edge of
    // OUR reach means we land hits inside theirs — the engine's backoff
    // mode keeps pushing back out after each swing.
    //
    // It is a preference, not a rule: tooCloseRange only makes the engine
    // prefer the outer edge, and it still closes and trades when the target
    // corners it or the terrain leaves no room.
    attackRange: 3,
    // Reach abuse has to stay SUBTLE, and my first attempt at it backfired.
    // Pushing tooCloseRange up to 2.6 against an attackRange of 3 left a
    // band only 0.4 blocks wide: the engine spent its time stepping in and
    // out of that sliver instead of swinging, and the bot "barely hit
    // anything". A wider band lands hits reliably and still drifts to the
    // outer edge, because onHitConfig backs off after each exchange.
    tooCloseRange: 2.0,
    missChancePerTick: 0,
    // What we assume the TARGET can reach. Most hostiles are around 2.2.
    enemyReach: 2.6,
    // Swinging at something through a wall is the single most obvious
    // "this is a bot" tell there is.
    hitThroughWalls: false,
  },
  // Real jump-criticals, the way a player gets them. The alternative
  // ("packet" mode) fakes them by writing position packets directly, which
  // is literally what an anticheat looks for.
  critConfig: {
    enabled: true,
    mode: 'hop',
    attemptRange: 2,
    reaction: {
      enabled: true, maxPreemptiveTicks: 1, maxWaitTicks: 5, maxWaitDistance: 5,
    },
  },
  // w-tap: release sprint on the hit, re-press after. A genuine technique
  // that increases the knockback WE deal.
  tapConfig: { enabled: true, mode: 'wtap', delay: 0 },
  strafeConfig: { enabled: true, mode: { mode: 'intelligent', maxOffset: Math.PI / 2 } },
  // Deliberately OFF. kbCancel fights the knockback the server applies to
  // us, and "the bot doesn't get knocked back" has been a standing
  // complaint — that motion is what makes a fight read as real.
  onHitConfig: {
    enabled: true, mode: 'backoff', kbCancel: { enabled: false, mode: 'jump' },
  },
  // Smooth, legit rotation. The default here is mode 'constant' with
  // smooth:false, which snaps the head instantly — indistinguishable from
  // an aimbot, and exactly the "uncanny" look reported.
  rotateConfig: {
    enabled: true, smooth: true, lookAtHidden: false, mode: 'legit',
  },
  shieldConfig: { enabled: true, mode: 'legit' },
  shieldDisableConfig: { enabled: true, mode: 'single' },
  // 'fullswing' respects the attack cooldown; 'killaura' does not.
  swingConfig: { mode: 'fullswing' },
  // distance 1 is deliberately SMALLER than attackRange (3).
  //
  // custom-pvp only uses pathfinder while further away than attackRange;
  // inside it, movement switches to manual control states. If the
  // pathfinder goal could be satisfied first, the path would empty and
  // pathfinder would fire fullStop() — teleporting the bot to the block
  // centre mid-fight. With the goal set closer than the handover point,
  // the path never completes and that never happens.
  followConfig: { mode: 'standard', distance: 1, predictTicks: 2 },
  cps: 12,
};

/**
 * What a step beside lava costs, in pathfinder's units (a plain step is 1).
 *
 * Pathfinder never steps INTO lava, and that is where its care ends. A diagonal
 * move only needs one of its two side cells open, so it happily cuts the
 * corner of a lava cell — and a 0.6-wide body passing a corner overlaps it.
 * Walking the lip of a pool is the same: centred on the bank, edge over the
 * lava. The bot died that way at 15:36 on 09-24 heading for a diamond.
 *
 * Priced, not forbidden: forty blocks of detour is worth one lava-side step,
 * and when the only way through runs along a pool the route still exists.
 */
const LAVA_EDGE_COST = 40;

function lavaEdgeCost(bot, block) {
  return block?.position && lavaBeside(bot, block.position) ? LAVA_EDGE_COST : 0;
}

/**
 * Water the bot has had to build its way out of is priced like a lava edge:
 * still usable if it is genuinely the only way, never the convenient one.
 *
 * 09-26: out of a flooded ravine by pillar, and back in it within minutes —
 * 33 re-entries in one session — because nothing on the rim knew. Remembered
 * per world in memory.noteWaterTrap; only the cells down at the water count,
 * so a path along the rim above is untouched.
 */
const WATER_TRAP_COST = 60;

function waterTrapCost(block) {
  return block?.position && memory.inWaterTrap(block.position) ? WATER_TRAP_COST : 0;
}

/**
 * A jump is only worth taking if missing it is survivable.
 *
 * Fresh world, 09-25 17:01: `valuables` routed to an iron vein on the far
 * side of a ravine, and the fall guard fired "Stopped at a ledge" seventeen
 * times in ten seconds before the bot went in — 11 blocks, 8 health, and a
 * skeleton at the bottom took most of the rest. Pathfinder was planning a
 * parkour jump across the gap; the guard (src/falls.js) sees a sprint toward
 * a drop and takes forward and sprint off, which turns the jump into a hop
 * straight up at the lip. Each is right on its own, and together they
 * produce the one outcome both exist to prevent.
 *
 * So the gap has to be shallow: solid ground or water within a free fall
 * under every column the jump passes over. The ravine is then routed round,
 * dug down into, or bridged — all slower than a jump that works, and all
 * better than one that does not.
 */
const PARKOUR_GAP_COLUMNS = 3;

function gapIsHarmless(m, node, dir) {
  for (let d = 1; d <= PARKOUR_GAP_COLUMNS; d++) {
    let floor = false;
    for (let dy = 1; dy <= SAFE_DROP + 1; dy++) {
      const block = m.getBlock(node, dir.x * d, -dy, dir.z * d);
      if (block.physical || block.liquid) {
        floor = true;
        break;
      }
    }
    if (!floor) return false;
  }
  return true;
}

function parkourOnlyOverShallowGaps(m) {
  const jump = m.getMoveParkourForward.bind(m);
  m.getMoveParkourForward = (node, dir, neighbors) => {
    if (!gapIsHarmless(m, node, dir)) return;
    jump(node, dir, neighbors);
  };
}

function buildMovements(bot) {
  const m = new Movements(bot);
  m.exclusionAreasStep.push((block) => lavaEdgeCost(bot, block));
  m.exclusionAreasStep.push(waterTrapCost);

  // Parkour is back ON.
  //
  // It was disabled for looking erratic, and that was the wrong trade. A
  // player jumps gaps constantly — it is ordinary movement, not a tell — and
  // refusing to meant the bot walked the long way round every ravine and
  // stream, or worse, bridged across.
  //
  // But only over gaps a miss would not hurt — see parkourOnlyOverShallowGaps.
  // maxDropDown does NOT cap this, as was assumed here: it limits where a
  // jump lands, not what is underneath it on the way.
  m.allowParkour = true;
  parkourOnlyOverShallowGaps(m);
  m.allowSprinting = true;

  // Bridging should be a last resort, and at the default it was a first one.
  //
  // placeCost ships at 1, which prices putting a block down exactly the same
  // as walking across one — so pathfinder would happily build a causeway
  // over a pond rather than walk ten blocks around it. That is slow, it
  // spends the cobblestone the bot needs for tools, and it looks nothing
  // like a player. At 12 it still bridges when there is genuinely no route,
  // which is the only time it should.
  m.placeCost = 12;

  // Water is slower than land, not forbidden.
  //
  // I raised this to 40 to stop the drowning, and that was the wrong lever:
  // it made the bot refuse water so completely that it bridged across lakes
  // block by block instead of swimming, which is slower and looks nothing
  // like a player. Staying afloat is the water pilot's job (src/water.js,
  // which holds jump on physics ticks whenever the eye is under), and
  // getting out again is leaveWater's — pathfinder cannot climb out of deep
  // water at all. What keeps it out of water it cannot leave is the drop
  // limit below (infiniteLiquidDropdownDistance) and waterTrapCost.
  //
  // So water stays merely slower than land: walk around a pond, swim a river
  // rather than building over it.
  m.liquidCost = 8;

  // Pathfinder MUST be allowed to dig. Turning it off was the single most
  // damaging setting in the project, and it took a live freeze to see why.
  //
  // The original reasoning was sound as far as it went: every obstacle dig
  // calls pathfinder's internal fullStop(), which zeroes horizontal velocity
  // and teleports the bot to the block centre, and pathfinder also swaps
  // tools itself while clearing obstacles. Both are real (verified at
  // index.js:489 and :505 in the installed copy).
  //
  // What that missed is what happens when a path CANNOT be found. From
  // index.js:456-476: getPathTo returns noPath, pathfinder sets its internal
  // pathUpdated flag, leaves the path empty, and from then on returns early
  // on every single tick — forever. It emits nothing. Its own 3.5s stuck
  // detector (line 632) sits *below* that early return, so it never runs
  // either. The bot simply stands still, permanently, with no way to notice.
  //
  // With digging off AND parkour off, noPath is not an edge case, it is the
  // normal outcome: a one-block lip, a fallen log, or a tree's leaves are
  // each enough to make a target unreachable. Caught live — the bot sat at
  // 434,64,486 for the entire log, every leg failing, cycling wood ->
  // gatherStone -> mine and back. Leaves are the worst version of it, since
  // a canopy encloses the bot completely and nothing in the move set can cut
  // through it. That is the "boxed in by leaves and did nothing" report.
  //
  // So: digging is back on, and the original three concerns are handled
  // where they actually belong —
  //
  //  1. Snapping: digCost makes pathfinder treat breaking a block as a last
  //     resort, so it walks around obstacles when a route exists and only
  //     digs when the alternative is not moving at all.
  //  2. Tools: digBlock() re-equips immediately before every deliberate dig,
  //     so a pathfinder tool swap is transient and never affects what we
  //     mine with.
  //  3. Valuables: blocksCantBreak below keeps it away from anything we care
  //     about, so it can never tunnel through our own diamonds or a chest.
  m.canDig = true;

  // 1 is the default and means "digging is as cheap as walking", which gets
  // us a bot that tunnels through a hill rather than walking around it. High
  // enough to be a genuine last resort, low enough that being trapped is
  // always worse.
  m.digCost = 8;

  // Never break these to make a path. Ore is the entire point of the run and
  // pathfinder does not collect what it breaks, so a tunnel through a
  // diamond vein would destroy the goal to save a few steps. Containers
  // scatter their loot.
  //
  // EVERY ore, from knowledge.js's table rather than a hand-kept list. The
  // hand-kept one had the valuable ores and not copper, redstone or lapis, so
  // a route through a copper vein was dug and the raw copper handed to tidy
  // to throw away. Ore we want is wasted when pathfinder breaks it; ore we
  // don't want is junk when it does. Either way, walk round.
  const offLimits = [
    ...ORE_BLOCKS,
    'ancient_debris', 'chest', 'trapped_chest', 'barrel', 'ender_chest',
    'furnace', 'blast_furnace', 'smoker', 'crafting_table', 'spawner',
  ];
  for (const name of offLimits) {
    const id = bot.registry.blocksByName[name]?.id;
    if (id !== undefined) m.blocksCantBreak.add(id);
  }

  // What pathfinder may pillar with.
  //
  // It ships with exactly two: dirt and cobblestone. That is fine on the
  // surface and useless at depth, where everything the bot is carrying is
  // cobbled_deepslate — so `allow1by1towers` was silently a no-op in the one
  // place the bot actually needs to climb out of a hole. Give it everything
  // we might plausibly be holding.
  for (const name of [
    'cobbled_deepslate', 'stone', 'deepslate', 'tuff', 'andesite', 'diorite',
    'granite', 'netherrack', 'sandstone', 'gravel', 'sand', 'blackstone',
  ]) {
    const id = bot.registry.itemsByName[name]?.id;
    if (id !== undefined && !m.scafoldingBlocks.includes(id)) m.scafoldingBlocks.push(id);
  }

  // Towers stay ENABLED even though placing also triggers fullStop. Without
  // them the bot cannot climb out of any hole it ends up in, and with
  // digging off too it becomes permanently trapped — observed live, stuck at
  // the bottom of its own mineshaft oscillating between four positions
  // forever. Occasional snapping while climbing out beats that.
  m.allow1by1towers = true;

  // Fall damage starts above three blocks, and 3 was the value here to keep
  // that damage at literally zero. That traded one problem for a worse one:
  // getLandingBlock (mineflayer-pathfinder's movements.js:467) refuses to
  // generate ANY drop-down move once the ledge is taller than maxDropDown —
  // not "costed higher", genuinely absent from the graph. So a routine
  // four-block ledge, the kind a player hops off without thinking, left
  // pathfinder with no walking route at all, and placeCost=12 for scaffolding
  // beat the cost of the long way round. Watched live and confirmed by
  // screenshot: the bot bridging across ordinary sloped terrain it could
  // "easily go down", over and over, leaving dirt causeways behind like nothing
  // happened.
  //
  // Back to 4 (the mineflayer default). That's one point of fall damage at
  // most for a ledge this size — the "heart and a half, over and over" bleed
  // from before was real, but it came from ROUTINE travel repeatedly picking
  // the cheap drop over a walk-around even on paths a few blocks longer. A
  // four-block ledge is not "over and over"; it is the one specific height
  // class that was previously impossible to walk down and always got bridged
  // instead. Bridging is still what happens beyond that, which is correct —
  // an actual cliff should cost a resource, not a sliver of health.
  m.maxDropDown = MAX_DROP_DOWN;

  // ...and the same four blocks when the landing is WATER.
  //
  // Pathfinder ships with infiniteLiquidDropdownDistance on: water breaks a
  // fall, so any drop into it is "safe" and costs nothing extra. Safe to land,
  // yes; not safe to be in. The move set cannot swim up a ravine wall, so every
  // such drop is a one-way door. 09-26: the bot foraged along the rim of a
  // flooded ravine at y=80, dropped eighteen blocks into the water at y=62,
  // pillared fourteen blocks out, walked straight back in on the next forage
  // leg, and spent eight minutes cycling leaveWater -> unstick -> forage down
  // there before it drowned two blocks under an air pocket. A route that needs
  // a deep drop into water now has to find another way, like any other cliff.
  m.infiniteLiquidDropdownDistance = false;

  // Pathfinder already avoids fire, lava and cobwebs. These two also hurt
  // and it happily walks through them by default — small, constant damage
  // for no gain.
  for (const name of ['cactus', 'sweet_berry_bush']) {
    const id = bot.registry.blocksByName[name]?.id;
    if (id !== undefined) m.blocksToAvoid.add(id);
  }

  return m;
}

/**
 * Evidence about digs that go wrong, whoever started them.
 *
 * Reported live: some blocks crack all the way, stop, and are dug again from
 * nothing. The cause found in the code (driveTo cancelling pathfinder mid-dig,
 * fixed in nav.js) left no trace in any log — an aborted dig was silent. And
 * one diamond at arm's length took 35 seconds to come out at 15:35 on 09-24,
 * with nothing logged to say why.
 *
 * Wrapped here, once, so pathfinder's own digs are covered as well as ours.
 * A stop the director asked for (digBlock marks it) is an ordinary preemption
 * and is not reported.
 */
const DIG_REPORT_GAP_MS = 5000;

function instrumentDigs(bot) {
  if (bot._digsInstrumented || typeof bot.dig !== 'function') return;
  bot._digsInstrumented = true;
  const dig = bot.dig;
  let lastReportAt = 0;
  const report = (message, data) => {
    if (Date.now() - lastReportAt < DIG_REPORT_GAP_MS) return;
    lastReportAt = Date.now();
    logger.info(message, data);
  };

  bot.dig = async (block, ...rest) => {
    const startedAt = Date.now();
    let expectedMs = null;
    try {
      expectedMs = bot.digTime(block);
    } catch {
      // not a block mineflayer can time; nothing to compare against
    }
    const byPathfinder = !!bot.pathfinder?.isMining?.();
    bot._digStopReason = null;
    try {
      const result = await dig(block, ...rest);
      const tookMs = Date.now() - startedAt;
      if (expectedMs && tookMs > expectedMs * 2 + 1000) {
        report('Dig took far longer than expected', {
          block: block?.name,
          expectedMs: Math.round(expectedMs),
          tookMs,
          onGround: !!bot.entity?.onGround,
          inWater: !!bot.entity?.isInWater,
          byPathfinder,
        });
      }
      return result;
    } catch (err) {
      if (err?.message === 'Digging aborted' && bot._digStopReason !== 'preempted') {
        const tookMs = Date.now() - startedAt;
        report('Dig cut short', {
          block: block?.name,
          doneFraction: expectedMs ? Number((tookMs / expectedMs).toFixed(2)) : null,
          byPathfinder,
        });
      }
      throw err;
    }
  };
}

/**
 * What mineflayer thinks is at eye level, for its dig timer.
 *
 * mineflayer's digTime applies the five-times underwater penalty only when
 * the block at the eye is literally named water — not kelp, seagrass or a
 * waterlogged block, and not "above the fluid in a partly filled cell" either.
 * A client that expects a dig to take a fifth of what the server allows sends
 * "finished" early and the server rejects the dig; one that expects five
 * times too long just waits. The vanilla rule (src/water.js eyeInWater)
 * answers both ways.
 */
function eyeLevelByVanillaRule(bot) {
  bot._getBlockAtEyeLevel = () => {
    if (!bot.entity?.position) return null;
    return eyeInWater(bot) ? { name: 'water' } : { name: 'air' };
  };
}

function createBot() {
  const online = config.mc.auth === 'microsoft';

  const bot = mineflayer.createBot({
    host: config.mc.host,
    port: config.mc.port,
    username: config.mc.username,
    version: config.mc.version,
    auth: config.mc.auth,
    // Where the Microsoft token is cached. Without a stable folder every
    // restart re-runs the device-code flow, which needs a human with a
    // browser — unusable for a bot meant to reconnect on its own.
    ...(online ? { profilesFolder: path.join(__dirname, '..', 'authCache') } : {}),
    checkTimeoutInterval: config.mc.connectTimeoutMs,
    viewDistance: config.mc.viewDistance,
    // mineflayer's own error logging is a bare console.log(err), which dumps
    // a ~30 line AggregateError for every failed connection attempt and
    // buries the readable log. index.js already reports these properly
    // (throttled, one line, with the host/port), so turn the raw dump off.
    logErrors: false,
    hideErrors: true,
  });
  // Before any packet: mineflayer credits every entity's air to the bot.
  trackOwnAir(bot);
  eyeLevelByVanillaRule(bot);

  // Microsoft auth is interactive exactly once. The code appears on stderr
  // from prismarine-auth by default, which is easy to miss in a busy log, so
  // say it plainly and say what to do with it.
  if (online) {
    bot.on('microsoft_auth_code', (data) => {
      logger.warn('SIGN IN TO CONTINUE — one time only', {
        openThis: data?.verification_uri || 'https://microsoft.com/link',
        enterThisCode: data?.user_code,
        note: 'the token is cached in ./authCache; restarts will not ask again',
      });
    });
  }

  // Ecosystem plugins, all maintained alongside mineflayer itself. Each of
  // these replaces something that was hand-rolled here and getting it subtly
  // wrong — combat timing, tool choice, armour, eating. Battle-tested code
  // beats our own for problems this well-trodden.
  bot.loadPlugin(pathfinder);
  bot.loadPlugin(customPvp);    // crits, strafing, w-tap, smooth rotation
  bot.loadPlugin(bloodhound);   // works out who actually hit us
  bot.loadPlugin(toolPlugin);   // best-tool-for-block selection
  bot.loadPlugin(armorManager); // wears the best armour it picks up
  bot.loadPlugin(autoEat);

  // Belt and braces on error listeners. Node throws on an 'error' event with
  // no listener, and with logErrors off mineflayer no longer attaches one of
  // its own — index.js attaches the real reporter, but only after createBot
  // returns, and a connection can fail before that. Repeated ECONNREFUSED
  // during the reconnect loop was killing the process outright (exit code 4),
  // which is the "bot leaves and never comes back" symptom.
  //
  // The process-level net-error guard in index.js is the actual safety net;
  // these two just make sure the events are never unhandled in the first place.
  bot.on('error', () => {});
  bot._client.on('error', () => {});

  bot.once('spawn', () => {
    // ONE movement profile, and it is worth saying why there is not a second.
    //
    // There used to be a "combat" profile here, built alongside this one and
    // described by a comment as the thing that stopped the bot mining straight
    // down while a zombie chewed on it. It did nothing of the sort:
    // buildMovements ignored the flag entirely, so the two objects were
    // identical, and nothing in the live code ever switched to the second one
    // — only _superseded/mobThreat.js did, and that has not run in a long
    // time. A comment describing a protection that is not there is worse than
    // no comment, because it is what the next person reads when the bot does
    // exactly the thing it claims to prevent.
    //
    // Building a genuine non-digging combat profile is deliberately NOT the
    // fix. Turning canDig off is what produced the worst bug this project has
    // had: with digging disabled, pathfinder's noPath outcome becomes routine,
    // and on noPath it sets its internal pathUpdated flag and returns early on
    // every tick afterwards, forever, emitting nothing. The bot simply stops.
    // Reintroducing that inside combat, where a failure is a death, is not a
    // trade worth making for a symptom that has not recurred since digCost
    // made tunnelling a last resort.
    const standard = buildMovements(bot);
    bot.movementProfiles = { standard };
    bot.pathfinder.setMovements(standard);

    // Search limits — a straight speed fix.
    //
    // searchRadius ships as -1, meaning "no limit". That is only ever felt on
    // FAILURE: a reachable target is found quickly, but an unreachable one
    // makes A* expand every loaded node it can reach until thinkTimeout, and
    // it does that 40ms at a time on the main event loop. So each impossible
    // target cost a full 5 seconds of a mostly-frozen bot — and unreachable
    // targets are common (ore inside rock, a tree across a ravine).
    //
    // Bounding the search makes those give up almost immediately, which is
    // what lets the caller blacklist the target and move on to a real one.
    bot.pathfinder.thinkTimeout = 2000;
    bot.pathfinder.tickTimeout = 20;   // leave the event loop room to breathe
    bot.pathfinder.searchRadius = 96;  // comfortably past any scan radius we use

    // PATHFINDER PICKS ITS OWN DIGGING TOOL, and it was picking the sword.
    //
    // This is the missing half of the "stop breaking blocks with the sword"
    // fix, and it is why that kept coming back after being fixed. src/tools.js
    // is consulted by every dig THIS project makes — but pathfinder digs blocks
    // out of its own way (canDig is on, deliberately), and it chooses the tool
    // itself, from mineflayer-pathfinder/index.js:45:
    //
    //   for (const tool of bot.inventory.items()) {
    //     if (block.digTime(tool.type, ...) < fastest) bestTool = tool
    //   }
    //
    // Purely dig time, across the whole bag. A sword genuinely IS the fastest
    // thing in the game for leaves and cobwebs, so it gets equipped — and
    // breaking a block with a sword costs TWO durability instead of one. The
    // bot's only weapon was being ground down clearing its own path.
    //
    // Worse is the tie. `<` is strict, so when everything digs a block at the
    // same rate — dirt, sand, gravel, with no shovel — nothing ever beats the
    // FIRST item scanned, whatever that happens to be. That is the reported
    // "he used an axe to mine a dirt block", and it is also how a pickaxe ends
    // up chewing durability on grass.
    //
    // So our table decides when it has an opinion, and when it does not we fall
    // back to pathfinder's own choice with weapons and shields excluded.
    const originalBestTool = bot.pathfinder.bestHarvestTool;
    bot.pathfinder.bestHarvestTool = (block) => {
      const wanted = toolTypeForBlock(bot, block);
      if (wanted === null) return null; // bare hands are correct here
      const ours = bestToolOfType(bot, wanted);
      if (ours) return ours;
      const fallback = originalBestTool(block);
      return fallback && isWeaponOrGear(fallback.name) ? null : fallback;
    };

    // A plugin failing to attach must be loud. Everything below configures
    // one, and an exception thrown inside an event handler here would leave
    // the bot connected but half-set-up — fighting with default movements,
    // or not eating — which is miserable to diagnose from the symptoms.
    const missing = ['pathfinder', 'swordpvp', 'tool', 'armorManager', 'autoEat', 'bloodhound']
      .filter((name) => !bot[name]);
    if (missing.length > 0) {
      logger.error('Plugins failed to load — bot will behave badly', { missing });
      return;
    }

    // ---------------------------------------------------------------
    // THE fix for "hacker movement", especially in combat.
    //
    // mineflayer-pathfinder has an internal fullStop():
    //
    //   bot.entity.velocity.x = 0          // wipes server knockback
    //   bot.entity.velocity.z = 0
    //   bot.entity.position.x = blockX     // TELEPORTS to block centre
    //   bot.entity.position.z = blockZ
    //
    // ("Kind of cheaty, but the server will not tell the difference" — its
    // own comment. The server absolutely notices and sends a correction,
    // which is the rubber-banding people see.)
    //
    // It runs from two places, and swapping combat plugins fixes neither:
    //
    //  1. bot.pathfinder.stop(), which sets stopPathing = true and makes the
    //     movement monitor call its internal stop() -> fullStop(). Every
    //     combat plugin calls this to disengage.
    //  2. the movement monitor itself, whenever a path runs out of nodes —
    //     and crucially it does NOT skip this for dynamic goals; `dynamic`
    //     only suppresses the goal_reached *event*. So every time a chase
    //     path completed, the bot teleported. In melee, against a target
    //     that keeps stopping and starting, that is constant.
    //
    // (1) is fixed here by redirecting stop() to setGoal(null), which goes
    // through resetPath() — it clears the path and control states but never
    // reaches fullStop().
    //
    // (2) is fixed by configuration: SWORD_PVP_CONFIG sets the follow goal
    // CLOSER than the range at which combat switches to manual control, so
    // the path is always abandoned before it can empty. nav.js already does
    // the same thing for ordinary travel by handing over to manual walking
    // ~2 blocks out.
    const originalStop = bot.pathfinder.stop.bind(bot.pathfinder);
    bot.pathfinder.stop = () => {
      try {
        bot.pathfinder.setGoal(null);
      } catch {
        originalStop();
      }
    };

    // Combat movement is manual inside melee range, but the approach still
    // uses pathfinder — with the one standard profile (digging on), for the
    // reasons given where it is built above. There is no no-dig profile.
    bot.pathfinder.setMovements(standard);
    bot.swordpvp.options = { ...bot.swordpvp.options, ...SWORD_PVP_CONFIG };

    // Bloodhound correlates damage events to work out who actually hit us,
    // instead of our old guess of "nearest player within 6 blocks" — which
    // was wrong whenever anything else was nearby, and is a large part of
    // why retargeting behaved so badly.
    bot.on('onCorrelateAttack', (attacker, victim) => {
      if (!attacker || !victim || victim.id !== bot.entity.id) return;
      bot.lastAttacker = { id: attacker.id, at: Date.now() };
    });

    // Eat before hunger bites, and never eat anything with a downside.
    // The banned list is not static — eating.js swaps raw meat in and out
    // depending on whether anything cooked is left (cooking doubles a piece
    // of meat, so eating it raw means hunting twice as often).
    instrumentDigs(bot);

    bot.eatingPolicyAllowsRaw = null; // force the first apply to take effect
    applyEatingPolicy(bot);
    bot.autoEat.enableAuto();
    bot.autoEat.on('eatStart', (opts) => logger.action('Eating', { item: opts?.food?.name }));
    bot.autoEat.on('eatFinish', (opts) => logger.action('Ate', { item: opts?.food?.name, food: bot.food }));
    bot.autoEat.on('eatFail', (err) => logger.info('Eating failed', { error: err?.message }));

    logger.info('Bot spawned', {
      username: bot.username,
      version: bot.version,
      pos: bot.entity.position,
      gameMode: bot.game?.gameMode,
    });

    // Creative and spectator break the entire resource loop: blocks mined in
    // creative drop NOTHING, so mining "works", the tool is right, the
    // inventory has room — and the cobblestone counter never leaves zero.
    // That is indistinguishable from a bot bug unless it's called out.
    if (bot.game?.gameMode && bot.game.gameMode !== 'survival') {
      logger.warn('Bot is NOT in survival mode — blocks will not drop items', {
        gameMode: bot.game.gameMode,
        fix: `run  /gamemode survival ${bot.username}  in the world`,
      });
    }
    logger.info('Capabilities', {
      // Stated plainly because one of these is cheating and the other is
      // mostly a no-op for a headless bot — see config.js.
      fullBright: config.cheats.fullBright
        ? 'on — sees at any light level (it always could); torches gate nothing and are never placed'
        : 'off (will gather and place torches before going deep)',
      xray: config.cheats.xray
        ? `ON — will tunnel to ore inside solid rock, radius ${config.cheats.xrayRadius}`
        : 'off (exposed ore only; strip mining reveals the rest)',
    });
    logger.info('Combat engine ready', {
      engine: 'swordpvp',
      crits: bot.swordpvp.options.critConfig.mode,
      rotation: `${bot.swordpvp.options.rotateConfig.mode}${bot.swordpvp.options.rotateConfig.smooth ? '+smooth' : ''}`,
      strafe: bot.swordpvp.options.strafeConfig.mode.mode,
      tap: bot.swordpvp.options.tapConfig.mode,
      followDistance: bot.swordpvp.options.followConfig.distance,
      attackRange: bot.swordpvp.options.genericConfig.attackRange,
    });
  });

  // Connection lifecycle is owned by index.js — it has to react across the
  // whole behavior set, not just log a line.
  return bot;
}

module.exports = {
  createBot,
  // For the tests: what pathfinder may break is a policy, and it drifted once.
  buildMovements, gapIsHarmless, parkourOnlyOverShallowGaps,
  instrumentDigs,
  lavaEdgeCost,
  waterTrapCost,
  WATER_TRAP_COST,
  LAVA_EDGE_COST,
};
