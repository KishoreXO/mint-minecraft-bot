/**
 * Wipe every scrap of state from previous worlds, then start the bot.
 *
 * The bot keys its memory to a world signature (host plus spawn point) and
 * clears it automatically when that changes — but two freshly generated
 * worlds can share a spawn point, and "automatically" is not the guarantee
 * worth having before a clean-run test. This removes the files outright, so
 * the next session provably begins knowing nothing.
 *
 * What gets cleared:
 *   known-base.json    where a crafting table and furnace were placed
 *   world-memory.json  depth reached, ore noted, deaths, structures, sleep
 *   bot-status.txt     the live dashboard, so a stale one is never misread
 *
 * Logs are deliberately kept: they are the record of what happened, and a
 * new session opens its own file anyway.
 *
 * Run with:  node fresh-start.js
 */

const fs = require('fs');
const path = require('path');

const STATE_FILES = ['known-base.json', 'world-memory.json', 'bot-status.txt'];

let removed = 0;
for (const name of STATE_FILES) {
  const file = path.join(__dirname, name);
  try {
    if (fs.existsSync(file)) {
      fs.unlinkSync(file);
      console.log(`cleared  ${name}`);
      removed++;
    } else {
      console.log(`absent   ${name}`);
    }
  } catch (err) {
    console.error(`FAILED to clear ${name}: ${err.message}`);
    process.exitCode = 1;
  }
}

console.log(`\n${removed} file(s) cleared — the bot will start knowing nothing about any world.\n`);

// Hand straight over to the bot so there is no window in which a stale file
// could be recreated by something else.
require('./index.js');
