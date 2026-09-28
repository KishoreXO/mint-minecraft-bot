const fs = require('fs');
const path = require('path');
const {
  inventorySummary, armorSummary, bestToolOfType, countAny, woodUnits,
  STONE_MATERIAL,
} = require('./inventory');
const {
  timeInfo, structureNearby, biomeName, isUnderground, lightingUsable,
} = require('./world');
const { describeDamage } = require('./damage');
const difficulty = require('./difficulty');
const lag = require('./lag');
const { EDIBLE } = require('./behaviors/survive');
const { ironInvested, diamondInvested, ironStillNeeded } = require('./behaviors/gear');
const { DEEP_TRIP_NEEDS, DIAMOND_GOAL } = require('./behaviors/mine');
const memory = require('./memory');

/**
 * A live, human-readable dump of what the bot is doing right now.
 *
 * Asked for directly: "are there any ways that I can actively know what real
 * time task is for the bot and can I see the inventory as well". The chat
 * commands can do it, but they need you to be in the game, standing near the
 * bot, typing — which is exactly when you are busy watching it die.
 *
 * So this writes the whole picture to a file, once a second. Watch it with:
 *
 *   Get-Content -Wait -Tail 40 bot-status.txt
 *
 * ...in a spare terminal and you have a live dashboard: current task, why it
 * chose that task, full inventory, health, where the damage has gone, what it
 * remembers about this world, and how long until dark.
 *
 * Deliberately a whole-file rewrite rather than an append — it is a snapshot
 * of NOW, not a log. The log already exists for history.
 *
 * The web dashboard (src/dashboard.js) shows the same snapshot — both render
 * collectStatus(), so the two can never disagree about a number.
 */

const FILE = path.join(__dirname, '..', 'bot-status.txt');
const INTERVAL_MS = 1000;

function bar(value, max, width = 20) {
  const filled = Math.max(0, Math.min(width, Math.round((value / max) * width)));
  return `[${'#'.repeat(filled)}${'.'.repeat(width - filled)}] ${Math.round(value)}/${max}`;
}

function inventoryBlock(counts) {
  const entries = Object.entries(counts).sort((a, b) => b[1] - a[1]);
  if (entries.length === 0) return '  (empty)';
  // Three columns so a full inventory still fits on a screen.
  const lines = [];
  for (let i = 0; i < entries.length; i += 3) {
    lines.push(`  ${entries.slice(i, i + 3)
      .map(([name, n]) => `${name} x${n}`.padEnd(26))
      .join('')}`.trimEnd());
  }
  return lines.join('\n');
}

/**
 * Is Jev's last focus being applied, and if not, why not? The director's own
 * limits, not a copy: this said "30" and "0.35" in its own right, and so did
 * the dashboard, which is how paired numbers drift apart in this project.
 */
function focusVerdict(ctx) {
  const s = ctx.strategy;
  if (!s) return null;
  // Lazy: the director pulls in the behaviors, which pull in this module's
  // neighbours.
  const { FOCUS_TTL_MS, FOCUS_MIN_CONFIDENCE } = require('./director');
  const ageMs = Date.now() - s.at;
  const stale = ageMs > FOCUS_TTL_MS;
  const weak = (s.confidence ?? 0) < FOCUS_MIN_CONFIDENCE;
  return {
    applied: !stale && !weak,
    why: stale ? 'stale' : (weak ? 'low confidence' : null),
    ageSec: Math.round(ageMs / 1000),
  };
}

/** What Jev last advised, and whether that advice is still being applied. */
function describeFocus(ctx) {
  const s = ctx.strategy;
  if (!s) return 'nothing yet';
  const v = focusVerdict(ctx);
  return `focus on ${s.focus} (${Math.round((s.confidence ?? 0) * 100)}% confident, `
    + `risk ${s.risk}, ${v.ageSec}s ago) — ${v.applied ? 'APPLIED' : `ignored: ${v.why}`}`;
}

/** The water state, for the dashboard's chip: what the bot is doing about it. */
function waterStatus(bot, ctx) {
  const { eyeInWater, airLeft, AIR_RESERVE } = require('./water');
  const inWater = !!bot.entity?.isInWater;
  const submerged = inWater && eyeInWater(bot);
  const pilot = bot.waterPilot?.owner ?? null;
  const escape = ctx.water?.escape ?? null;
  let mode = null;
  if (escape) mode = escape.how === 'notch' ? 'cutting its way up' : 'pillaring out';
  else if (pilot === 'escapeDrowning') mode = 'surfacing for air';
  else if (pilot === 'leaveWater') mode = 'getting out';
  else if (pilot) mode = 'swimming';
  else if (submerged) mode = 'under water';
  else if (inWater) mode = 'in water';
  return {
    inWater,
    submerged,
    air: airLeft(bot),
    airReserve: AIR_RESERVE,
    mode,
    escape: escape ? escape.how : null,
    trapsRemembered: memory.waterTraps().length,
  };
}

/** Everything the dashboards show, as plain data. */
function collectStatus(bot, ctx) {
  const time = timeInfo(bot);
  const struct = structureNearby(bot);

  // Deliberately NOT snapshot().
  //
  // snapshot() computes darkSpotCount, which scans an 11x11x4 volume and
  // does four block lookups per position — roughly 1,900 lookups. Calling it
  // once a second for a dashboard that does not even display the number was
  // pure waste on the same thread that runs pathfinding and combat. The
  // fields actually shown here are cheap on their own.
  const pos = bot.entity.position;
  const pick = bestToolOfType(bot, 'pickaxe');
  const weapon = bestToolOfType(bot, 'sword') || bestToolOfType(bot, 'axe');
  const inv = inventorySummary(bot);

  // The progression, as the chain of gates it actually is. Each of these
  // unlocks the next, so a counter that is not moving names the stuck step
  // directly — which is the question every session eventually comes down to.
  //
  // The targets are READ from the requirement, not written down beside it.
  // The dashboard was still showing 16 wood, 20 cobble and 3 food long after
  // the descent started asking for 32, 40 and 6 — so the one screen meant to
  // answer "why is it not going down yet" was reporting every gate as
  // comfortably met while `goDeep` refused. See test/thresholds.test.js.
  const progress = {
    wood: { have: woodUnits(bot), need: DEEP_TRIP_NEEDS.planks },
    cobble: { have: countAny(bot, STONE_MATERIAL), need: DEEP_TRIP_NEEDS.placeable },
    food: { have: countAny(bot, EDIBLE), need: DEEP_TRIP_NEEDS.food },
    coal: { have: (inv.coal ?? 0) + (inv.charcoal ?? 0) },
    // Iron the bot has MINED, not iron it is still holding loose. The old sum
    // read zero the moment a pickaxe was crafted out of it, so the dashboard
    // and the mining target disagreed by the whole kit — see stockOf in
    // behaviors/mine.js. What is left is gear.ironStillNeeded, not a total.
    iron: { have: ironInvested(bot), stillToMine: ironStillNeeded(bot) },
    // Diamonds the bot OWNS, in any form — the kit is made of them, and a
    // loose count fell by three the moment the pickaxe was crafted.
    diamond: { have: diamondInvested(bot), need: DIAMOND_GOAL },
  };

  return {
    at: Date.now(),
    username: bot.username ?? 'bot',
    doing: ctx.paused ? 'PAUSED' : ctx.currentBehavior || null,
    doingSince: ctx.currentStartedAt || null,
    priority: ctx.currentPriority ?? null,
    blocked: ctx.mine?.lastShortfall ?? null,
    // Jev's focus steers the scheduler, so it is half the answer to "why is
    // it doing that".
    jevFocus: describeFocus(ctx),
    strategy: ctx.strategy ? {
      focus: ctx.strategy.focus,
      confidence: ctx.strategy.confidence ?? 0,
      risk: ctx.strategy.risk ?? null,
      ...focusVerdict(ctx),
    } : null,
    water: waterStatus(bot, ctx),
    vitals: {
      health: bot.health ?? 0,
      food: bot.food ?? 0,
      saturation: bot.foodSaturation ?? 0,
      air: Math.max(0, Math.min(20, bot.oxygenLevel ?? 20)),
      inWater: !!bot.entity?.isInWater,
      swimmingForAir: !!ctx.water?.rescuing,
      xpLevel: bot.experience?.level ?? 0,
    },
    progress,
    world: {
      pos: { x: pos.x, y: pos.y, z: pos.z },
      yaw: bot.entity.yaw,
      biome: biomeName(bot),
      underground: isUnderground(bot),
      lighting: lightingUsable(bot) ? 'per-block' : 'unavailable (using depth/time)',
      dimension: bot.game?.dimension ?? null,
    },
    time: {
      day: time.day,
      isNight: time.isNight,
      timeOfDay: bot.time?.timeOfDay ?? null,
      secondsUntilDawn: time.secondsUntilDawn,
      secondsUntilDusk: time.secondsUntilDusk,
    },
    // How hard things hit here, and how we know. Every damage figure the bot
    // plans against is the Normal value, so this is the multiplier on all of
    // them — see src/difficulty.js.
    difficulty: difficulty.describe(ctx),
    lastHit: ctx.difficulty?.lastSample ?? null,
    structure: struct ? `${struct.name} (${struct.worth}) — ${struct.why ?? struct.danger ?? ''}` : null,
    gear: {
      weapon: weapon?.name ?? null,
      held: bot.heldItem?.name ?? null,
      pickaxe: pick?.name ?? null,
      armor: armorSummary(bot),
      shield: bot.inventory?.slots?.[45]?.name === 'shield',
    },
    damage: describeDamage(ctx) || null,
    pickups: ctx.collect?.picked ?? 0,
    jev: {
      usedCached: ctx.jev?.usedCached ?? 0,
      usedInstinct: ctx.jev?.usedInstinct ?? 0,
      prefetched: ctx.jev?.prefetched ?? 0,
    },
    // Network lag and self-inflicted lag, side by side. They look identical
    // from the outside and need opposite fixes — see src/lag.js.
    speed: lag.describe(bot, ctx),
    lag: lag.summary(ctx),
    backedOff: [...ctx.backoff.keys()],
    memory: memory.summary(),
    inventory: inv,
  };
}

function render(bot, ctx) {
  const s = collectStatus(bot, ctx);
  const p = s.progress;
  const { world, time, gear, memory: mem } = s;
  const progress = [
    `wood ${p.wood.have}/${p.wood.need}`,
    `cobble ${p.cobble.have}/${p.cobble.need}`,
    `food ${p.food.have}/${p.food.need}`,
    `coal ${p.coal.have}`,
    `iron ${p.iron.have} (${p.iron.stillToMine} still to mine)`,
    `DIAMOND ${p.diamond.have}/${p.diamond.need}`,
  ].join('   ');

  return [
    `=== ${s.username} — ${new Date().toLocaleTimeString()} ===`,
    '',
    `DOING      ${s.doing || 'choosing...'}`,
    `  blocked  ${s.blocked ? `waiting on: ${s.blocked}` : 'nothing reported'}`,
    `  jev says ${s.jevFocus}`,
    '',
    `health     ${bar(s.vitals.health, 20)}`,
    `food       ${bar(s.vitals.food, 20)}`,
    `air        ${bar(s.vitals.air, 20)}`
      + `${s.vitals.inWater ? '   IN WATER' : ''}`
      + `${s.vitals.swimmingForAir ? ' — swimming for air' : ''}`,
    '',
    `PROGRESS   ${progress}`,
    '',
    `position   ${Math.round(world.pos.x)},${Math.round(world.pos.y)},${Math.round(world.pos.z)}   biome ${world.biome ?? '?'}`,
    `time       day ${time.day}, ${time.isNight ? `NIGHT — dawn in ${time.secondsUntilDawn}s` : `day — dusk in ${time.secondsUntilDusk}s`}`,
    `terrain    ${world.underground ? 'underground' : 'surface'}, lighting ${world.lighting}`,
    `difficulty ${s.difficulty}${s.lastHit ? `   last hit: ${JSON.stringify(s.lastHit)}` : ''}`,
    `structure  ${s.structure ?? 'none nearby'}`,
    '',
    `weapon     ${gear.weapon ?? 'NONE'}${gear.held ? `   (holding ${gear.held})` : '   (empty hand)'}`,
    `pickaxe    ${gear.pickaxe ?? 'NONE'}`,
    `armour     ${gear.armor.length ? gear.armor.join(', ') : 'none'}`,
    `shield     ${gear.shield ? 'in off-hand' : 'no'}`,
    // Torches are gone from the bot entirely — no crafting, no placement, no
    // prerequisite on the descent. A dashboard line counting them implies a
    // supply the bot is managing, which is the kind of stale detail that sends
    // the next person reading it looking for a behavior that no longer exists.
    `coal/fuel  ${p.coal.have}`,
    '',
    `damage     ${s.damage || 'none taken'}`,
    `pickups    ${s.pickups}`,
    `jev        ${s.jev.usedCached}/${s.jev.usedCached + s.jev.usedInstinct} decided, ${s.jev.prefetched} prefetched`,
    `speed      ${s.speed}`,
    `backed off ${s.backedOff.join(', ') || 'nothing'}`,
    '',
    `remembers  session ${mem.sessions} in this world; deepest y=${mem.deepestY ?? '?'}; `
      + `${mem.oreNotes} ore noted; ${mem.deaths} deaths; slept day ${mem.lastSleptDay ?? 'never'}`,
    '',
    'INVENTORY',
    inventoryBlock(s.inventory),
    '',
  ].join('\n');
}

function startStatusFile(bot, ctx) {
  const timer = setInterval(() => {
    if (!ctx.connected || !bot.entity) return;
    try {
      fs.writeFile(FILE, render(bot, ctx), () => {});
    } catch {
      // A status dashboard must never be able to disturb the bot.
    }
  }, INTERVAL_MS);
  if (timer.unref) timer.unref();

  return () => clearInterval(timer);
}

module.exports = {
  startStatusFile,
  STATUS_FILE: FILE,
  // Shared with the chat commands: "why is it doing that" should give the
  // same answer whether you read the file or ask the bot in game.
  describeFocus,
  // The web dashboard renders the same snapshot — see src/dashboard.js.
  collectStatus,
};
