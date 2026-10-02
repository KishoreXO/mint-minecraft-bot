/**
 * Cleaning up after a plugin that does not clean up after itself.
 *
 * A run ended with "FATAL ERROR: Ineffective mark-compacts near heap limit"
 * at 2GB after five minutes, and the 400-800ms event-loop stalls that had been
 * reported alongside it were the garbage collector losing, not expensive
 * scans. The bot had said what was wrong once, in a line easy to scroll past:
 *
 *   MaxListenersExceededWarning: 11 entity_status listeners added to [Client]
 *
 * mineflayer-auto-eat's buildEatingListener subscribes to `entity_status` and
 * `updateSlot` and unsubscribes on three of its four exits. The fourth — its
 * own timeout — rejects without removing either. This bot eats on a timer, so
 * that leaks forever and gets slower as it goes, because every packet is then
 * dispatched to every corpse.
 *
 * The guard prunes from outside, which means it is removing listeners it did
 * not add. That is worth testing carefully: pruning mineflayer's own would
 * break entity tracking, and pruning an eat in flight would break eating.
 *
 * Run with: node test/leakguard.test.js
 */

const assert = require('assert');
const { EventEmitter } = require('events');
const { startLeakGuard } = require('../src/leakguard');

let passed = 0;
function check(label, fn) {
  try {
    fn();
    passed++;
    console.log(`  ok  ${label}`);
  } catch (err) {
    console.error(`  FAIL ${label}: ${err.message}`);
    process.exitCode = 1;
  }
}

/**
 * A stand-in bot whose client and inventory are plain emitters, so listener
 * bookkeeping is exactly what the real thing does.
 */
function fakeBot() {
  const client = new EventEmitter();
  const inventory = new EventEmitter();
  client.setMaxListeners(0);
  inventory.setMaxListeners(0);
  return { _client: client, inventory };
}

/** Run the guard's timers by hand rather than waiting four seconds. */
function runGuard(bot, { addBefore = () => {}, addAfter = () => {} } = {}) {
  const ctx = { connected: true };
  const realSetTimeout = global.setTimeout;
  const realSetInterval = global.setInterval;
  let baselineFn = null;
  let tickFn = null;

  global.setTimeout = (fn) => { baselineFn = fn; return { unref() {} }; };
  global.setInterval = (fn) => { tickFn = fn; return { unref() {} }; };
  let stop;
  try {
    stop = startLeakGuard(bot, ctx);
  } finally {
    global.setTimeout = realSetTimeout;
    global.setInterval = realSetInterval;
  }

  addBefore(bot);
  baselineFn();      // the plugins have loaded; record what normal looks like
  addAfter(bot);
  tickFn();          // one sweep
  stop();
}

console.log('knowing what normal looks like');

check('mineflayer\'s own listeners are never touched', () => {
  const bot = fakeBot();
  const core = [() => {}, () => {}];
  runGuard(bot, {
    addBefore: (b) => core.forEach((fn) => b._client.on('entity_status', fn)),
  });
  const left = bot._client.listeners('entity_status');
  for (const fn of core) {
    assert.ok(left.includes(fn), 'a core listener was pruned');
  }
});

check('a bot with nothing leaked is left entirely alone', () => {
  const bot = fakeBot();
  const core = [() => {}, () => {}];
  runGuard(bot, {
    addBefore: (b) => core.forEach((fn) => b._client.on('entity_status', fn)),
  });
  assert.strictEqual(bot._client.listenerCount('entity_status'), core.length);
});

console.log('\npruning the corpses');

check('leaked listeners are removed', () => {
  const bot = fakeBot();
  runGuard(bot, {
    addBefore: (b) => {
      b._client.on('entity_status', () => {});
      b._client.on('entity_status', () => {});
    },
    // Eight timed-out eats, each leaving a listener behind.
    addAfter: (b) => {
      for (let i = 0; i < 8; i++) b._client.on('entity_status', () => {});
    },
  });
  // Baseline of two, plus one allowance for an eat genuinely in flight.
  assert.strictEqual(bot._client.listenerCount('entity_status'), 3);
});

// The newest listener is the one most likely to belong to an eat that is
// actually happening, so it is spared. Sparing the wrong one costs a single
// timed-out eat; pruning it costs every eat.
check('the most recent listener survives, because it may be a live eat', () => {
  const bot = fakeBot();
  const liveEat = () => {};
  runGuard(bot, {
    addBefore: (b) => {
      b._client.on('entity_status', () => {});
      b._client.on('entity_status', () => {});
    },
    addAfter: (b) => {
      for (let i = 0; i < 5; i++) b._client.on('entity_status', () => {});
      b._client.on('entity_status', liveEat);
    },
  });
  assert.ok(
    bot._client.listeners('entity_status').includes(liveEat),
    'the in-flight eat listener was pruned',
  );
});

check('the inventory side leaks too, and is swept the same way', () => {
  const bot = fakeBot();
  runGuard(bot, {
    addBefore: (b) => b.inventory.on('updateSlot', () => {}),
    addAfter: (b) => {
      for (let i = 0; i < 6; i++) b.inventory.on('updateSlot', () => {});
    },
  });
  assert.strictEqual(bot.inventory.listenerCount('updateSlot'), 2);
});

console.log('\nand it never makes things worse');

check('a disconnected bot is not swept', () => {
  const bot = fakeBot();
  const ctx = { connected: false };
  const realSetTimeout = global.setTimeout;
  const realSetInterval = global.setInterval;
  let baselineFn = null;
  let tickFn = null;
  global.setTimeout = (fn) => { baselineFn = fn; return { unref() {} }; };
  global.setInterval = (fn) => { tickFn = fn; return { unref() {} }; };
  const stop = startLeakGuard(bot, ctx);
  global.setTimeout = realSetTimeout;
  global.setInterval = realSetInterval;

  baselineFn();
  for (let i = 0; i < 9; i++) bot._client.on('entity_status', () => {});
  tickFn();
  stop();
  assert.strictEqual(bot._client.listenerCount('entity_status'), 9);
});

/**
 * Our own version of the same leak.
 *
 * Task.onAbort hands back an unsubscribe, and six call sites threw it away —
 * nav's driveTo among them, which runs dozens of times inside a single strip
 * mine. Each kept a closure over the bot on the task until the task ended, and
 * all of them fired together on abort. Caught by reading, so pinned by reading:
 * every registration outside task.js must keep its handle.
 */
check('every task.onAbort keeps its unsubscribe', () => {
  const fs = require('fs');
  const path = require('path');
  const srcDir = path.join(__dirname, '..', 'src');
  const offenders = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.js') && entry.name !== 'task.js') {
        fs.readFileSync(full, 'utf8').split('\n').forEach((line, i) => {
          // A call whose result is not assigned is a listener nobody can remove.
          if (/^\s*(if \([^)]*\)\s*)?task\??\.onAbort\(/.test(line)) {
            offenders.push(`${path.relative(srcDir, full)}:${i + 1}`);
          }
        });
      }
    }
  };
  walk(srcDir);
  assert.deepStrictEqual(offenders, [], `discarded unsubscribe at ${offenders.join(', ')}`);
});

/**
 * The in-flight version of the same mistake: a WALK nobody can stop.
 *
 * withDeadline races a promise against a timer and gives up waiting — it does
 * not cancel the thing it was waiting for. Wrapped around goNear, the walk
 * carried on: its pathfinder goal stayed set for up to twenty seconds, and its
 * `finally` then cleared the goal and every control state in the middle of
 * whatever the bot had moved on to. Pathfinder's resetPath also calls
 * bot.stopDigging() when it was digging, which is where the logged
 * "gatherStone — Digging aborted" failures came from, each ~130ms after a drop
 * approach had timed out. Navigation carries its own deadline (`timeoutMs`),
 * and that one cleans up after itself.
 */
check('no navigation call is wrapped in withDeadline', () => {
  const fs = require('fs');
  const path = require('path');
  const srcDir = path.join(__dirname, '..', 'src');
  const offenders = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.js')) {
        const text = fs.readFileSync(full, 'utf8');
        // Whole-file match: the wrapped call is often split across lines.
        const re = /withDeadline\(\s*(goNear|goNearXZ|goToBlock|goToHeight|retreatFrom|driveTo)\(/g;
        let m = re.exec(text);
        while (m) {
          const lineNo = text.slice(0, m.index).split('\n').length;
          offenders.push(`${path.relative(srcDir, full)}:${lineNo} (${m[1]})`);
          m = re.exec(text);
        }
      }
    }
  };
  walk(srcDir);
  assert.deepStrictEqual(offenders, [], `orphanable navigation at ${offenders.join(', ')}`);
});

console.log(`\n${passed} checks passed`);
