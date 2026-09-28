const logger = require('./logger');
const config = require('./config');
const { knownBase } = require('./base');
const { goNear } = require('./nav');
const { Task, sleep } = require('./task');
const {
  inventorySummary, armorSummary, bestToolOfType, countAny, woodUnits,
  STONE_MATERIAL,
} = require('./inventory');
const { isHostileMob, isFoodAnimal, isOtherPlayer } = require('./entities');
const { describeDamage } = require('./damage');
const difficulty = require('./difficulty');
const lag = require('./lag');
const memory = require('./memory');
const {
  timeInfo, biomeName, isUnderground, structureNearby,
} = require('./world');
const { EDIBLE } = require('./behaviors/survive');
const { ironInvested, diamondInvested } = require('./behaviors/gear');
const { DIAMOND_GOAL } = require('./behaviors/mine');
const { describeFocus } = require('./statusFile');

/**
 * In-game chat control. Testing this bot by squinting at a log file in
 * another window is miserable — this lets you just ask it what it's doing
 * from inside Minecraft.
 *
 * Two levels of answer, because they are wanted at different moments:
 *
 *   status   one dense line. What you type while something is happening.
 *   report   the whole picture across a dozen lines — task, why that task,
 *            health, supplies, progression, damage, world, memory. What you
 *            type when you come back and want to know how it has been doing.
 *
 * And `watch`, which is `report` on a timer, for leaving running in a corner
 * of the screen. Asked for directly: "I want whole of information on request
 * or frequently."
 *
 * Commands: status, report, watch [secs|off], inv, plan, why, hurt, diff,
 *           where, base, come, stop, resume, cheats, xray, fullbright, help
 */

// Minecraft refuses chat messages longer than this, silently.
const MAX_CHAT = 250;
// Gap between the lines of a multi-line report. Servers kick for chat spam,
// and a dozen messages in one tick is exactly what that check is looking for.
const CHAT_GAP_MS = 260;
// A report is long. Anything beyond this is a bug in the report, not a world
// worth describing, and flooding the chat log is its own kind of unusable.
const MAX_REPORT_LINES = 20;

const WATCH_MIN_SEC = 5;
const WATCH_MAX_SEC = 600;
const WATCH_DEFAULT_SEC = 30;

/**
 * Counts what the bot can actually see, per category. Worth surfacing:
 * a silently-broken entity filter is exactly the bug that made the bot
 * appear to ignore every mob in the game, and a visible count makes that
 * class of failure obvious instead of invisible.
 */
function nearbyCounts(bot, range = 24) {
  const counts = { hostile: 0, animal: 0, player: 0 };
  for (const id of Object.keys(bot.entities)) {
    const e = bot.entities[id];
    if (e === bot.entity) continue;
    if (bot.entity.position.distanceTo(e.position) > range) continue;
    if (isHostileMob(e)) counts.hostile++;
    else if (isFoodAnimal(e)) counts.animal++;
    else if (isOtherPlayer(bot, e)) counts.player++;
  }
  return counts;
}

/**
 * How much of the full diamond kit is actually being worn/held.
 *
 * Six pieces: pickaxe, sword, and four armour slots. Counting diamonds in
 * the inventory isn't the goal — wearing them is.
 */
function diamondKit(bot, armor) {
  const has = (name) => bot.inventory.items().some((i) => i.name === name);
  const worn = new Set(armor);
  const pieces = [
    ['pick', has('diamond_pickaxe')],
    ['sword', has('diamond_sword')],
    ['chest', worn.has('diamond_chestplate')],
    ['legs', worn.has('diamond_leggings')],
    ['helm', worn.has('diamond_helmet')],
    ['boots', worn.has('diamond_boots')],
  ];
  const done = pieces.filter(([, ok]) => ok);
  return `${done.length}/6${done.length ? ` (${done.map(([n]) => n).join(',')})` : ''}`;
}

function describeStatus(bot, ctx) {
  const weapon = bestToolOfType(bot, 'sword') || bestToolOfType(bot, 'axe');
  const armor = armorSummary(bot);
  const pos = bot.entity.position;
  const near = nearbyCounts(bot);
  const inv = inventorySummary(bot);
  const pick = bestToolOfType(bot, 'pickaxe');

  return [
    `hp ${Math.round(bot.health)}/20`,
    `food ${bot.food ?? '?'}/20`,
    `doing: ${ctx.paused ? 'PAUSED' : ctx.currentBehavior || 'idle'}`,
    `weapon: ${weapon ? weapon.name : 'none'}`,
    `pick: ${pick ? pick.name.replace('_pickaxe', '') : 'none'}`,
    `armor: ${armor.length ? armor.join(',') : 'none'}`,
    // The goal, and the resource chain that leads to it. Seeing these move
    // is the whole point — a frozen "got" counter is how the broken
    // collection loop was eventually spotted.
    // ironInvested, not loose ingots: the count must not drop to zero the
    // moment the bot spends it on the pickaxe it was mining for.
    `got: cobble ${inv.cobblestone ?? 0} iron ${ironInvested(bot)} DIAMOND ${diamondInvested(bot)}/${DIAMOND_GOAL}`,
    `kit: ${diamondKit(bot, armor)}`,
    `picked ${ctx.collect.picked || 0}`,
    // jev: how many decisions the MODEL made (prefetched into cache) vs how
    // many instinct had to make because no answer was ready.
    // `warm` is how many answers the prefetcher has banked. Without it a
    // quiet spell reads as "jev 0/0" and looks like the model is not being
    // consulted at all, when in fact it is being asked constantly and simply
    // has not been needed to decide anything yet.
    `jev ${ctx.jev.usedCached}/${ctx.jev.usedCached + ctx.jev.usedInstinct} warm ${ctx.jev.prefetched}`,
    ...(ctx.mine.lastShortfall ? [`need: ${ctx.mine.lastShortfall}`] : []),
    // Where the health actually went. A line reading "hurt: fall 24" turns
    // "he keeps dying to mobs" into a pathfinding bug in one glance.
    ...(describeDamage(ctx) ? [`hurt: ${describeDamage(ctx)}`] : []),
    `near: ${near.hostile}h/${near.animal}a/${near.player}p`,
    `at ${Math.round(pos.x)},${Math.round(pos.y)},${Math.round(pos.z)}`,
  ].join(' | ');
}

function describeInventory(bot) {
  const counts = inventorySummary(bot);
  const entries = Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 12);
  if (entries.length === 0) return 'inventory is empty';
  return entries.map(([name, n]) => `${name} x${n}`).join(', ');
}

/**
 * The whole picture, as chat lines.
 *
 * Ordered by what you actually want to know first when you come back to a bot
 * that has been running unattended: what is it doing, is it alive, is it
 * getting anywhere, and what has been hurting it. Each line stands alone, so
 * losing one to the chat scrollback costs nothing.
 */
function reportLines(bot, ctx) {
  const pos = bot.entity.position;
  const time = timeInfo(bot);
  const inv = inventorySummary(bot);
  const armor = armorSummary(bot);
  const pick = bestToolOfType(bot, 'pickaxe');
  const weapon = bestToolOfType(bot, 'sword') || bestToolOfType(bot, 'axe');
  const near = nearbyCounts(bot);
  const mem = memory.summary();
  const struct = structureNearby(bot);
  const hurt = describeDamage(ctx);
  // The same ledgers as `status` and the dashboard. This one summed loose raw
  // iron and ingots, so `report` and `status` could disagree about the same
  // bot in the same second by a whole pickaxe's worth.
  const iron = ironInvested(bot);

  const lines = [
    `== ${bot.username} ==`,
    `DOING: ${ctx.paused ? 'PAUSED' : ctx.currentBehavior || 'choosing'}`
      + `${ctx.mine?.lastShortfall ? ` | waiting on: ${ctx.mine.lastShortfall}` : ''}`,
    `WHY: jev ${describeFocus(ctx)}`,
    `HP ${Math.round(bot.health)}/20 | food ${bot.food ?? '?'}/20 | air ${bot.oxygenLevel ?? 20}/20`
      + `${bot.entity.isInWater ? ' | IN WATER' : ''}`,
    `GEAR: pick ${pick ? pick.name.replace('_pickaxe', '') : 'none'}`
      + ` | weapon ${weapon ? weapon.name.replace('_', ' ') : 'NONE'}`
      + ` | shield ${bot.inventory?.slots?.[45]?.name === 'shield' ? 'yes' : 'no'}`
      + ` | armour ${armor.length}/4`,
    // The progression, in one line. Every number here is a gate on the next
    // one, so a frozen counter says exactly where the run is stuck.
    `PROGRESS: wood ${woodUnits(bot)} | cobble ${countAny(bot, STONE_MATERIAL)}`
      + ` | food ${countAny(bot, EDIBLE)} | coal ${(inv.coal ?? 0) + (inv.charcoal ?? 0)}`
      + ` | iron ${iron} | DIAMOND ${diamondInvested(bot)}/${DIAMOND_GOAL}`,
    // No torches field: the bot neither crafts nor places them any more, and a
    // count here implies a supply it is managing.
    `KIT: ${diamondKit(bot, armor)} | picked up ${ctx.collect.picked || 0}`,
    `WHERE: ${Math.round(pos.x)},${Math.round(pos.y)},${Math.round(pos.z)}`
      + ` | ${biomeName(bot) ?? '?'} | ${isUnderground(bot) ? 'underground' : 'surface'}`,
    `TIME: day ${time.day}, ${time.isNight
      ? `NIGHT, dawn in ${time.secondsUntilDawn}s`
      : `day, dusk in ${time.secondsUntilDusk}s`}`
      + ` | difficulty ${difficulty.describe(ctx)}`,
    `NEAR: ${near.hostile} hostile, ${near.animal} animal, ${near.player} player`
      + `${struct ? ` | ${struct.name} (${struct.worth})` : ''}`,
    `HURT: ${hurt || 'nothing yet'}`
      + `${ctx.damage.lastCause ? ` | last: ${ctx.damage.lastCause}` : ''}`,
    `JEV: ${ctx.jev.usedCached} decided / ${ctx.jev.usedInstinct} instinct`
      + ` | ${ctx.jev.prefetched} warmed`,
    `MEMORY: session ${mem.sessions} here | deepest y=${mem.deepestY ?? '?'}`
      + ` | ${mem.deaths} deaths | ${mem.oreNotes} ore noted`,
    `BAG: ${describeInventory(bot)}`,
  ];

  return lines
    .slice(0, MAX_REPORT_LINES)
    .map((line) => (line.length > MAX_CHAT ? `${line.slice(0, MAX_CHAT - 1)}…` : line));
}

/**
 * Send several lines without being kicked for spam.
 *
 * Deliberately fire-and-forget rather than awaited by the caller: the chat
 * handler must not block the bot for three seconds while a report goes out,
 * and a report that is one line short because the bot disconnected mid-send
 * is not worth an error path.
 */
async function say(bot, ctx, lines) {
  for (const line of lines) {
    if (!ctx.connected) return;
    try {
      bot.chat(line);
    } catch {
      return; // disconnected mid-report
    }
    await sleep(CHAT_GAP_MS);
  }
}

/**
 * Build and send the report, never throwing.
 *
 * Every caller is fire-and-forget — the chat handler and a timer — so a
 * report that throws while the bot is mid-respawn would surface as an
 * unhandled rejection and tell nobody anything useful. Reporting is a
 * read-only convenience and must never be able to disturb the bot.
 */
function sendReport(bot, ctx) {
  let lines;
  try {
    lines = reportLines(bot, ctx);
  } catch (err) {
    try {
      bot.chat(`could not build the report: ${err.message}`);
    } catch {
      // gone
    }
    return;
  }
  say(bot, ctx, lines).catch(() => {});
}

/**
 * What the bot is working toward, and what is stopping it.
 *
 * Distinct from `status` on purpose. The status line says what it is doing;
 * this says why that is the right thing and what would have to change for it
 * to do something better — which is the question being asked when someone
 * watches a bot wander and says "it is not making progress".
 */
function describePlan(bot, ctx) {
  const out = [];
  const pick = bestToolOfType(bot, 'pickaxe');
  const tier = pick ? pick.name.split('_')[0] : 'none';

  if (!pick) out.push('need a pickaxe: 3 planks + 2 sticks at a table');
  else if (tier === 'wooden') out.push('need a STONE pickaxe — wood cannot collect iron');
  else if (tier === 'stone') out.push('need iron: descend to y=16 and strip mine');
  else out.push('need diamond: descend to y=-59');

  if (ctx.mine?.lastShortfall) out.push(`blocked on: ${ctx.mine.lastShortfall}`);
  const backedOff = [...ctx.backoff.keys()];
  if (backedOff.length) out.push(`backed off: ${backedOff.join(',')}`);
  out.push(`at y=${Math.round(bot.entity.position.y)}`);
  return out.join(' | ');
}

function describeBase() {
  const fmt = (p) => (p ? `${Math.round(p.x)},${Math.round(p.y)},${Math.round(p.z)}` : 'none');
  return `table: ${fmt(knownBase.tablePos)} | furnace: ${fmt(knownBase.furnacePos)}`;
}

function startChatCommands(bot, ctx) {
  // The `watch` timer. Held here rather than on ctx because it belongs to this
  // listener's lifetime — a reconnect builds a fresh one, and a timer left
  // running against a dead bot would throw on every tick.
  let watchTimer = null;

  const stopWatch = () => {
    if (watchTimer) clearInterval(watchTimer);
    watchTimer = null;
  };

  const startWatch = (seconds) => {
    stopWatch();
    watchTimer = setInterval(() => {
      if (!ctx.connected || !bot.entity) return;
      sendReport(bot, ctx);
    }, seconds * 1000);
    if (watchTimer.unref) watchTimer.unref();
  };

  /**
   * Send one line, trimmed to what the server will actually accept.
   *
   * Minecraft drops an over-length chat message silently, which is the worst
   * possible failure for a diagnostic command: you type `status`, nothing
   * comes back, and the obvious conclusion is that the bot has hung. The
   * status line grows every time a field is added to it, so this is not a
   * hypothetical — it is the line most likely to cross the limit, and the one
   * you are most likely to be typing when something is already wrong.
   */
  const line = (text) => {
    try {
      bot.chat(text.length > MAX_CHAT ? `${text.slice(0, MAX_CHAT - 1)}…` : text);
    } catch {
      // disconnected between the command and the reply
    }
  };

  const onChat = async (username, message) => {
    if (username === bot.username) return;
    const cmd = message.trim().toLowerCase();

    // Reporting must never be able to break the bot, and every command below
    // reads live world state that can vanish mid-read — bot.entity is null
    // between the killing blow and the respawn packet, and that is exactly
    // when someone is most likely to be typing `status`.
    if (!bot.entity) {
      if (cmd === 'status' || cmd === 'report' || cmd === 'where') {
        line('dead at the moment — respawning');
      }
      return;
    }

    // `watch`, `watch 15`, `watch off` — handled before the switch because it
    // is the one command that carries an argument.
    if (cmd === 'watch' || cmd.startsWith('watch ')) {
      const arg = cmd.slice(5).trim();
      if (arg === 'off' || arg === 'stop' || arg === '0') {
        stopWatch();
        line('watch off');
        return;
      }
      const requested = arg ? Number(arg) : WATCH_DEFAULT_SEC;
      if (!Number.isFinite(requested)) {
        line('say: watch, watch <seconds>, or watch off');
        return;
      }
      const seconds = Math.min(WATCH_MAX_SEC, Math.max(WATCH_MIN_SEC, Math.round(requested)));
      startWatch(seconds);
      line(`watching — full report every ${seconds}s (say "watch off" to stop)`);
      sendReport(bot, ctx); // one immediately, don't wait
      logger.info('Chat watch started', { seconds, by: username });
      return;
    }

    switch (cmd) {
      case 'status':
        line(describeStatus(bot, ctx));
        break;

      case 'report':
      case 'all':
      case 'full':
        sendReport(bot, ctx);
        break;

      case 'plan':
      case 'goal':
        line(describePlan(bot, ctx));
        break;

      case 'why':
        line(`doing ${ctx.currentBehavior || 'nothing'} — jev ${describeFocus(ctx)}`);
        break;

      case 'hurt':
      case 'damage':
        line(`${describeDamage(ctx) || 'nothing has hurt me'}`
          + `${ctx.damage.lastCause ? ` | last: ${ctx.damage.lastCause}` : ''}`);
        break;

      case 'diff':
      case 'difficulty':
        line(`difficulty: ${difficulty.describe(ctx)}`
          + ` | source: ${difficulty.source(ctx)}`
          + `${ctx.difficulty.lastSample
            ? ` | last hit: ${JSON.stringify(ctx.difficulty.lastSample)}` : ''}`);
        break;

      case 'lag':
      case 'speed':
        line(lag.describe(bot, ctx));
        break;

      case 'where': {
        const p = bot.entity.position;
        const t = timeInfo(bot);
        line(`${Math.round(p.x)},${Math.round(p.y)},${Math.round(p.z)}`
          + ` | ${biomeName(bot) ?? '?'} | ${isUnderground(bot) ? 'underground' : 'surface'}`
          + ` | day ${t.day} ${t.isNight ? 'NIGHT' : 'day'}`);
        break;
      }

      case 'inv':
        line(describeInventory(bot));
        break;

      case 'base':
        line(describeBase());
        break;

      case 'stop':
        ctx.paused = true;
        if (ctx.currentTask) ctx.currentTask.abort('paused by chat command');
        line('paused — say resume to continue');
        logger.info('Paused by chat command', { username });
        break;

      case 'resume':
        ctx.paused = false;
        line('resuming');
        logger.info('Resumed by chat command', { username });
        break;

      case 'come': {
        const player = bot.players[username]?.entity;
        if (!player) {
          line("can't see you");
          return;
        }
        if (ctx.manualTask) {
          line('already on my way');
          return;
        }
        line('coming');

        // Remember whether the bot was ALREADY paused. Forcing paused=false
        // afterwards meant "stop" followed by "come" silently un-paused it,
        // overriding an explicit instruction.
        const wasPaused = ctx.paused;
        ctx.paused = true;
        if (ctx.currentTask) ctx.currentTask.abort('come command');
        const task = new Task('come');
        ctx.manualTask = task;
        try {
          await goNear(bot, player.position, 2, task);
          line('here');
        } catch (err) {
          line(`could not reach you: ${err.message}`);
        } finally {
          ctx.manualTask = null;
          ctx.paused = wasPaused;
        }
        break;
      }

      // Live toggles for the two capabilities. Being able to flip these
      // without restarting matters because the difference they make is only
      // visible over minutes of mining.
      case 'xray on':
      case 'xray off': {
        config.cheats.xray = cmd.endsWith('on');
        line(config.cheats.xray
          ? 'xray ON — tunnelling straight to buried ore'
          : 'xray off — exposed ore only');
        logger.info('X-ray toggled', { xray: config.cheats.xray, by: username });
        break;
      }

      case 'fullbright on':
      case 'fullbright off': {
        config.cheats.fullBright = cmd.endsWith('on');
        line(`fullbright ${config.cheats.fullBright ? 'ON' : 'off'}`);
        logger.info('Fullbright toggled', { fullBright: config.cheats.fullBright, by: username });
        break;
      }

      case 'cheats':
        line(`xray: ${config.cheats.xray ? 'ON' : 'off'} | fullbright: ${config.cheats.fullBright ? 'ON' : 'off'}`);
        break;

      case 'help':
        line('info: status, report, watch [secs|off], plan, why, hurt, diff, lag, where, inv, base');
        line('control: come, stop, resume, cheats, xray on|off, fullbright on|off');
        break;

      default:
        break;
    }
  };

  /**
   * A failed command must answer, not vanish.
   *
   * onChat is async, so anything it throws becomes a rejected promise that
   * surfaces minutes later in the log as a bare "Unhandled rejection" with no
   * hint that a chat command caused it — and in the game, typing `status` and
   * getting silence is indistinguishable from the bot having frozen, which is
   * the one thing these commands exist to rule out.
   */
  const handler = (username, message) => {
    Promise.resolve()
      .then(() => onChat(username, message))
      .catch((err) => {
        logger.warn('Chat command failed', { message, error: err.message });
        line(`that command errored: ${err.message}`);
      });
  };

  bot.on('chat', handler);
  return () => {
    stopWatch();
    bot.removeListener('chat', handler);
  };
}

module.exports = { startChatCommands, describeStatus };
