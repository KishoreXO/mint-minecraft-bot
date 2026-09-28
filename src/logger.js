const fs = require('fs');
const path = require('path');

const LOG_DIR = path.join(__dirname, '..', 'logs');

/**
 * A test run must not leave a session log behind.
 *
 * Every test file transitively requires this module, and the first line any
 * of them logged created its own `session-*.log` — one file per test
 * process, twenty-five per full suite run. That had quietly accumulated 662
 * files and 13.5MB, burying the handful that are real bot sessions among
 * fixture noise like "Gave up on a death pile {x:1,y:64,z:0}". Diagnosing a
 * live death means reading these; they have to be sessions, not test output.
 *
 * Detected from the process entry point rather than an env var so it needs
 * no cooperation from the test files or from however they get invoked. The
 * real bot enters through index.js, so it is never caught by this.
 */
const IS_TEST = require.main?.filename?.endsWith('.test.js') === true;

const LOG_FILE = IS_TEST
  ? null
  : path.join(LOG_DIR, `session-${new Date().toISOString().replace(/[:.]/g, '-')}.log`);

// Only the real bot needs the directory — creating it on require meant a
// test run recreated `logs/` even after it had been cleaned out.
if (!IS_TEST) fs.mkdirSync(LOG_DIR, { recursive: true });

const COLORS = {
  info: '\x1b[36m',
  decision: '\x1b[35m',
  action: '\x1b[32m',
  status: '\x1b[90m',
  warn: '\x1b[33m',
  error: '\x1b[31m',
  reset: '\x1b[0m',
};

function timeOfDay(ts) {
  return ts.slice(11, 19); // HH:MM:SS — the full ISO stamp is noise on screen
}

// Live listeners — the web dashboard's story feed. Kept to a bare list so the
// logger stays dependency-free and a listener can never delay the file write.
const subscribers = new Set();

/** Calls fn(entry) for every line logged from now on; returns an unsubscribe. */
function subscribe(fn) {
  subscribers.add(fn);
  return () => subscribers.delete(fn);
}

function write(level, message, data) {
  const ts = new Date().toISOString();
  const entry = { ts, level, message, ...(data !== undefined ? { data } : {}) };

  for (const fn of subscribers) {
    try {
      fn(entry);
    } catch {
      // A broken dashboard must never be able to stop the bot logging.
    }
  }

  const color = COLORS[level] || '';
  const dataStr = data !== undefined ? ` ${JSON.stringify(data)}` : '';
  console.log(`${color}${timeOfDay(ts)} [${level.toUpperCase()}] ${message}${dataStr}${COLORS.reset}`);

  // Console output stays on under test — seeing what a behavior logged while
  // a check runs is useful, and it costs nothing on disk.
  if (!LOG_FILE) return;

  fs.appendFile(LOG_FILE, `${JSON.stringify(entry)}\n`, (err) => {
    if (err) console.error('Failed to write log file:', err.message);
  });
}

module.exports = {
  info: (message, data) => write('info', message, data),
  decision: (message, data) => write('decision', message, data),
  action: (message, data) => write('action', message, data),
  status: (message, data) => write('status', message, data),
  warn: (message, data) => write('warn', message, data),
  error: (message, data) => write('error', message, data),
  logFile: LOG_FILE,
  subscribe,
};
