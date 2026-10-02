/**
 * Rebuild stats.json from every session log.
 *
 * stats.json is a cache of the logs (see src/stats.js), so this can always be
 * run again: it replays every entry, oldest session first, through the same
 * Recorder the live bot uses. History from logs written before the bot said
 * which world it was in is marked `approx` — worlds there are told apart by
 * "New world" and "I have been in this world before".
 *
 *   node tools/backfill-stats.js          rebuild and print a summary
 *   npm run stats                         the same
 */

const fs = require('fs');
const path = require('path');
const stats = require('../src/stats');

const LOG_DIR = path.join(__dirname, '..', 'logs');

function sessionFiles(exclude = null) {
  if (!fs.existsSync(LOG_DIR)) return [];
  return fs.readdirSync(LOG_DIR)
    .filter((f) => /^session-.*\.log$/.test(f))
    .sort() // ISO timestamps in the names sort oldest first
    .map((f) => path.join(LOG_DIR, f))
    .filter((f) => !exclude || path.resolve(f) !== path.resolve(exclude));
}

/** Replay the logs into a fresh store. `exclude` skips the live session's own file. */
function rebuild({ exclude = null } = {}) {
  const store = stats.blankStore();
  const recorder = new stats.Recorder(store, { approx: true });
  for (const file of sessionFiles(exclude)) {
    let text;
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    for (const raw of text.split('\n')) {
      if (!raw || raw.includes('"level":"status"')) continue;
      let entry;
      try {
        entry = JSON.parse(raw);
      } catch {
        continue; // a line cut off by a crash
      }
      recorder.ingest(entry);
    }
    // A log that ends without a death ended with the process — at its own
    // last line, not the newest line of any file read so far.
    recorder.endOfSession();
  }
  return store;
}

function formatMs(ms) {
  if (ms === null || ms === undefined) return '—';
  const s = Math.round(ms / 1000);
  return s >= 3600 ? `${Math.floor(s / 3600)}h${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}m`
    : `${Math.floor(s / 60)}m${String(s % 60).padStart(2, '0')}s`;
}

function main() {
  const startedAt = Date.now();
  const store = rebuild();
  fs.writeFileSync(stats.FILE, JSON.stringify(store));
  const s = stats.summarize(store);
  const t = s.totals;
  console.log(`Rebuilt ${stats.FILE} from ${sessionFiles().length} logs in ${Date.now() - startedAt}ms`);
  console.log(`${t.worlds} worlds, ${t.lives} lives (${t.freshLives} fresh starts), ${t.deaths} deaths, `
    + `${formatMs(t.playMs)} played, ${t.deathsPerHour} deaths/hour, best ever: ${t.bestEver ?? 'none'}`);
  console.log('\nFrom a fresh start (all worlds):');
  for (const m of s.overall) {
    console.log(`  ${m.label.padEnd(16)} reached ${String(m.reached).padStart(3)}/${m.of}`
      + `  median ${formatMs(m.median).padStart(7)}  best ${formatMs(m.best).padStart(7)}`);
  }
  console.log('\nDeaths by cause:', s.deathsByCause.slice(0, 6).map((d) => `${d.key} ×${d.count}`).join(', '));
}

if (require.main === module) main();

module.exports = { rebuild, sessionFiles };
