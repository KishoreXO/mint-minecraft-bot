/**
 * Turn a session log into the handful of numbers a live check actually needs.
 *
 * A twelve-minute run writes several hundred JSON lines, and every question
 * worth asking of one — did the fix hold, did the stall move, did the loop come
 * back — is a count, a grouping or a "did X happen within N seconds of Y". Done
 * by eye that is error-prone, and done with ad-hoc greps it is a different
 * command every time, which makes two sessions hard to compare. This does the
 * same tally the same way every time.
 *
 * The SIGNALS section is the part that matters: one line per bug this project
 * has fixed where the log is the only proof the fix held — each is a pattern
 * that used to appear and should now read zero (or at least fall).
 *
 * Run with:
 *   npm run logs                     newest session
 *   npm run logs -- --all            every session, merged
 *   npm run logs -- logs/a.log ...   specific files, merged
 *
 * The tally itself is a pure function of the parsed lines (see summarize), so
 * test/logsummary.test.js can pin it down with fixtures.
 */

const fs = require('fs');
const path = require('path');

const LOG_DIR = path.join(__dirname, '..', 'logs');

// Anything that means the bot has started or run from a fight, used to spot a
// reaction to damage that nothing dealt.
const COMBAT_REACTIONS = new Set([
  'Engaging', 'Committing to fight', 'Reflex attack', 'Fleeing',
  'Cannot escape — turning to fight', 'Too hurt to fight — retreating',
]);

// How close in time two lines must be to count as cause and effect.
const TOO_FAR_THEN_COLLECT_MS = 5000;
const WATER_REENTRY_MS = 30000;
const WATER_THEN_UNSTICK_MS = 20000;
const WATER_GAVE_UP_FAST_MS = 1000;
const ENGAGE_REPEAT_MS = 1000;
const REACTION_AFTER_DAMAGE_MS = 3000;

/** One JSON object per line; anything that does not parse is skipped, not fatal. */
function parseLines(text) {
  const out = [];
  for (const line of String(text).split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line);
      if (!entry || typeof entry.message !== 'string') continue;
      out.push({
        at: Date.parse(entry.ts) || 0,
        level: entry.level,
        message: entry.message,
        data: entry.data ?? {},
      });
    } catch {
      // a half-written last line from a killed process — ignore it
    }
  }
  return out;
}

function bump(map, key, by = 1) {
  map.set(key, (map.get(key) ?? 0) + by);
}

/**
 * "findBlocks r16 213ms worst / 806ms in 6" -> { name, worstMs, totalMs, calls }.
 * The lag meter's fallback line ("nothing over 60ms — ...") becomes 'unattributed'.
 */
function parseSlowest(text) {
  const m = /^(.*?) (\d+)ms worst \/ (\d+)ms in (\d+)$/.exec(String(text));
  if (!m) return { name: 'unattributed', worstMs: 0, totalMs: 0, calls: 0 };
  return {
    name: m[1], worstMs: Number(m[2]), totalMs: Number(m[3]), calls: Number(m[4]),
  };
}

/**
 * Everything the report prints, as plain data.
 *
 * Sorted by time first: the logger appends asynchronously, so lines written in
 * the same millisecond can land out of order, and every "X then Y" signal below
 * depends on the order being real.
 */
function summarize(entries) {
  const lines = [...entries].sort((a, b) => a.at - b.at);

  const messages = new Map();
  const stallByDoing = new Map();
  const stallBySlowest = new Map();
  const failures = new Map();
  const backoffs = new Map();
  const overruns = new Map();
  const damage = new Map();
  const deaths = [];
  const stuck = new Map();
  const hungryY = new Map();
  const nowhereTried = new Map();
  const notMiningWhy = new Map();
  const phases = [];
  const outOfOrder = new Map();
  const craftFailedWhy = new Map();
  let jevUsage = null;

  let statusLines = 0;
  let stalls = 0;
  let stallMs = 0;
  let worstStallMs = 0;
  let diggingAborted = 0;
  let tooFarThenCollect = 0;
  let engageRepeats = 0;
  let reactionsAfterEnvDamage = 0;

  // Water (see src/water.js). Every one of these was a real pattern on 09-26:
  // back in the water 6-8 s after getting out (63% of escapes), unstick taking
  // the wheel from leaveWater (46 times), leaveWater giving up in the same
  // second it started, pillar steps from a floating bot, drowning.
  let reenteredWater = 0;
  let waterThenUnstick = 0;
  let leaveWaterGaveUpFast = 0;
  let pillarRefusedInWater = 0;
  let drownings = 0;
  let lastDryLandAt = -Infinity;
  let lastWaterStartAt = -Infinity;

  // State for the "X then Y" signals.
  let lastTooFarAt = -Infinity;
  const lastEngage = new Map(); // target -> at
  let lastEnvDamageAt = -Infinity;

  for (const e of lines) {
    if (e.level === 'status') {
      statusLines++;
      continue;
    }
    bump(messages, e.message);
    const d = e.data;

    if (e.message.startsWith('Out of order: ')) bump(outOfOrder, e.message.slice('Out of order: '.length));

    if (e.message.startsWith('Stuck in water')) {
      // Trapped again within 30s of an escape. The "Re-entered water" line
      // only names who walked back in; counting it too would count wading.
      if (e.at - lastDryLandAt <= WATER_REENTRY_MS) reenteredWater++;
      lastWaterStartAt = e.at;
    }
    if (e.message === 'Reached dry land' || e.message === 'Climbed out of the water') lastDryLandAt = e.at;
    if (e.message === 'Still in water, will retry' && e.at - lastWaterStartAt <= WATER_GAVE_UP_FAST_MS) leaveWaterGaveUpFast++;
    if (e.message === 'Stuck — getting out' && e.at - lastWaterStartAt <= WATER_THEN_UNSTICK_MS) waterThenUnstick++;
    if (e.message === 'Pillar step refused' && d?.inWater) pillarRefusedInWater++;
    if (e.message === 'Bot died' && d?.killedBy === 'drowning') drownings++;

    switch (e.message) {
      case 'Phase complete':
        phases.push(`${d.phase} (${d.tookSec}s)`);
        break;
      case 'Back to an earlier phase':
        phases.push(`back to ${d.to}`);
        break;
      case 'Jev usage':
        jevUsage = d; // the last one is the session total
        break;
      case 'Could not make that — leaving it a moment':
        if (d.why) bump(craftFailedWhy, `${d.item}: ${typeof d.why === 'string' ? d.why : JSON.stringify(d.why)}`);
        break;
      case 'Event loop stalled — the bot could not react': {
        stalls++;
        stallMs += d.forMs ?? 0;
        worstStallMs = Math.max(worstStallMs, d.forMs ?? 0);
        bump(stallByDoing, d.doing ?? 'unknown');
        for (const s of d.slowest ?? []) bump(stallBySlowest, parseSlowest(s).name);
        break;
      }
      case 'Behavior failed':
        bump(failures, `${d.behavior}: ${d.error}`);
        if (String(d.error).includes('Digging aborted')) diggingAborted++;
        break;
      case 'Behavior kept doing nothing — backing it off':
      case 'Behavior wedged — benching it before it can take the bot again':
        bump(backoffs, d.behavior ?? '?');
        break;
      case 'Behavior ran too long — cutting it off':
        bump(overruns, d.behavior ?? '?');
        break;
      case 'Took avoidable damage': {
        const entry = damage.get(d.cause) ?? { hits: 0, lost: 0 };
        entry.hits++;
        entry.lost += d.lost ?? 0;
        damage.set(d.cause, entry);
        lastEnvDamageAt = e.at;
        break;
      }
      case 'Bot died':
        deaths.push({ at: e.at, killedBy: d.killedBy ?? '?' });
        break;
      case 'Stuck — getting out':
        bump(stuck, d.reason ?? '?');
        break;
      case 'Hungry underground — heading for the surface':
        bump(hungryY, d.y ?? '?');
        break;
      case 'Not mining tonight':
        bump(notMiningWhy, d.reason ?? '?');
        break;
      case 'Nowhere clear to place block':
        bump(nowhereTried, d.tried ?? '?');
        break;
      case 'The old crafting table is too far to be worth the walk':
      case 'The old furnace is too far to be worth the walk':
        lastTooFarAt = e.at;
        break;
      default:
        break;
    }

    if (e.message.startsWith('Going to collect the old ')
      && e.at - lastTooFarAt <= TOO_FAR_THEN_COLLECT_MS) {
      tooFarThenCollect++;
    }

    if (e.message === 'Engaging') {
      const target = d.target ?? '?';
      if (e.at - (lastEngage.get(target) ?? -Infinity) <= ENGAGE_REPEAT_MS) engageRepeats++;
      lastEngage.set(target, e.at);
    }

    if (COMBAT_REACTIONS.has(e.message) && e.at - lastEnvDamageAt <= REACTION_AFTER_DAMAGE_MS) {
      reactionsAfterEnvDamage++;
      // One reaction per hit is the finding; the lines that follow the first
      // are the same fight, not a second bug.
      lastEnvDamageAt = -Infinity;
    }
  }

  const first = lines.find((e) => e.at)?.at ?? 0;
  const last = lines.length ? lines[lines.length - 1].at : 0;

  return {
    lines: lines.length,
    statusLines,
    spanMs: Math.max(0, last - first),
    messages,
    stalls: {
      count: stalls, totalMs: stallMs, worstMs: worstStallMs, byDoing: stallByDoing, bySlowest: stallBySlowest,
    },
    failures,
    backoffs,
    overruns,
    damage,
    deaths,
    // What the night was spent on. Before 09-25 it was all waiting: the night
    // shift had never once run, and nothing said why.
    // The progression, as it happened (src/progression.js), and what jumped it.
    progression: { phases, outOfOrder, craftFailedWhy },
    jev: jevUsage,
    nights: {
      mined: messages.get('Mining through the night') ?? 0,
      crafted: messages.get('Crafting in the shelter') ?? 0,
      notMining: notMiningWhy,
    },
    signals: {
      diggingAborted,
      hungryUnderground: hungryY,
      tooFarThenCollect,
      nowhereClear: nowhereTried,
      engageRepeats,
      reactionsAfterEnvDamage,
      stuck,
      couldNotReachDrop: messages.get('Could not reach the drop') ?? 0,
      reenteredWater,
      waterThenUnstick,
      leaveWaterGaveUpFast,
      pillarRefusedInWater,
      drownings,
      drowningDamage: damage.get('drowning')?.lost ?? 0,
    },
  };
}

function sortedEntries(map) {
  return [...map.entries()].sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0])));
}

// Long tails are noise in a summary; the top of each list is the finding.
const LIST_LIMIT = 10;

function listOf(map) {
  const entries = sortedEntries(map);
  if (!entries.length) return 'none';
  const shown = entries.slice(0, LIST_LIMIT).map(([k, v]) => `${k} ×${v}`).join(', ');
  return entries.length > LIST_LIMIT ? `${shown} (+${entries.length - LIST_LIMIT} more)` : shown;
}

function describeSources(sources) {
  if (sources.length === 0) return 'log';
  if (sources.length <= 3) return sources.join(', ');
  return `${sources.length} files, ${sources[0]} … ${sources[sources.length - 1]}`;
}

function render(summary, sources = []) {
  const minutes = (summary.spanMs / 60000).toFixed(1);
  const out = [];
  out.push(`== ${describeSources(sources)}`);
  out.push(`   ${summary.lines} lines (+${summary.statusLines} status) over ${minutes} min`);
  out.push('');

  const s = summary.signals;
  const hungry = sortedEntries(s.hungryUnderground);
  out.push('SIGNALS (each used to be a bug; lower is better, most should be 0)');
  out.push(`  Digging aborted (orphaned navigation)      ${s.diggingAborted}`);
  out.push(`  "too far" then "Going to collect" (<5s)    ${s.tooFarThenCollect}`);
  out.push(`  Engaging same target again within 1s       ${s.engageRepeats}`);
  out.push(`  fight/flee within 3s of non-combat damage  ${s.reactionsAfterEnvDamage}`);
  out.push(`  Hungry underground (by y)                  ${hungry.length ? listOf(s.hungryUnderground) : '0'}`);
  out.push(`  Nowhere clear to place block (by tried)    ${s.nowhereClear.size ? listOf(s.nowhereClear) : '0'}`);
  out.push(`  Could not reach the drop                   ${s.couldNotReachDrop}`);
  out.push(`  Stuck — getting out (by reason)            ${s.stuck.size ? listOf(s.stuck) : '0'}`);
  out.push(`  Stuck in water again within 30s of escaping ${s.reenteredWater}`);
  out.push(`  unstick within 20s of being stuck in water ${s.waterThenUnstick}`);
  out.push(`  leaveWater gave up within 1s               ${s.leaveWaterGaveUpFast}`);
  out.push(`  Pillar step refused while in water         ${s.pillarRefusedInWater}`);
  out.push(`  Drowned / drowning damage                  ${s.drownings} / ${Math.round(s.drowningDamage)}`);
  out.push('');

  const n = summary.nights;
  out.push(`NIGHTS    mined ${n.mined} legs, crafted ${n.crafted} times, not mining: ${listOf(n.notMining)}`);
  const p = summary.progression;
  out.push(`PHASES    ${p.phases.length ? p.phases.join(' -> ') : 'none completed'}`);
  out.push(`  out of order: ${p.outOfOrder.size ? listOf(p.outOfOrder) : 'none'}`);
  if (p.craftFailedWhy.size) out.push(`  crafts short of: ${listOf(p.craftFailedWhy)}`);
  const j = summary.jev;
  if (j) {
    const kinds = Object.entries(j.calls ?? {})
      .map(([kind, c]) => `${kind} ${c.ok}/${c.calls} p50 ${c.p50 ?? '?'}ms p90 ${c.p90 ?? '?'}ms${c.failed ? ` (${c.failed} failed${c.failedDuringStall ? `, ${c.failedDuringStall} during stalls` : ''})` : ''}`)
      .join(', ');
    const used = j.warmed ? Math.round((100 * j.decidedByJev) / j.warmed) : 0;
    out.push(`JEV       decided ${j.decidedByJev}, instinct ${j.byInstinct}, warmed ${j.warmed} (${used}% used) | ${kinds}`);
  }
  out.push('');

  const st = summary.stalls;
  out.push(`STALLS  ${st.count} over 400ms, ${st.totalMs}ms total, worst ${st.worstMs}ms`);
  out.push(`  while doing:  ${listOf(st.byDoing)}`);
  out.push(`  slowest scan: ${listOf(st.bySlowest)}`);
  out.push('');
  out.push(`FAILED    ${listOf(summary.failures)}`);
  out.push(`BACKOFF   ${listOf(summary.backoffs)}`);
  out.push(`OVERRUN   ${listOf(summary.overruns)}`);
  const dmg = [...summary.damage.entries()]
    .sort((a, b) => b[1].lost - a[1].lost)
    .map(([cause, v]) => `${cause} ${Math.round(v.lost)} in ${v.hits}`);
  out.push(`AVOIDABLE DAMAGE  ${dmg.length ? dmg.join(', ') : 'none'}`);
  const deathsBy = new Map();
  for (const death of summary.deaths) bump(deathsBy, death.killedBy);
  out.push(`DEATHS    ${summary.deaths.length} — ${listOf(deathsBy)}`);
  out.push('');
  out.push('TOP MESSAGES');
  for (const [message, count] of sortedEntries(summary.messages).slice(0, 25)) {
    out.push(`  ${String(count).padStart(5)}  ${message}`);
  }
  return out.join('\n');
}

function sessionFiles() {
  if (!fs.existsSync(LOG_DIR)) return [];
  return fs.readdirSync(LOG_DIR)
    .filter((f) => /^session-.*\.log$/.test(f))
    .sort()
    .map((f) => path.join(LOG_DIR, f));
}

function main(argv) {
  const all = argv.includes('--all');
  const named = argv.filter((a) => !a.startsWith('--'));
  const available = sessionFiles();
  let files;
  if (named.length) files = named;
  else if (all) files = available;
  else files = available.slice(-1);

  if (files.length === 0) {
    console.log('No session logs found in logs/.');
    return;
  }

  const entries = [];
  for (const file of files) entries.push(...parseLines(fs.readFileSync(file, 'utf8')));
  console.log(render(summarize(entries), files.map((f) => path.basename(f))));
}

if (require.main === module) main(process.argv.slice(2));

module.exports = {
  parseLines, summarize, render, parseSlowest,
};
