/**
 * The web dashboard, and the two hooks it reads from the bot.
 *
 * The page itself is only checkable by looking at it. What can go wrong in a
 * way a test catches: the server listening on the whole network instead of
 * this computer, the stream not carrying log lines, a broken page listener
 * taking the logger down with it, the icons 404ing, and the director's
 * decision record — which the "brain" panel is drawn from — not saying what
 * the director actually asked.
 *
 * Run with: node test/dashboard.test.js
 */

const assert = require('assert');
const http = require('http');
const logger = require('../src/logger');
const { startDashboard } = require('../src/dashboard');
const { pickBehavior } = require('../src/director');
const {
  buildStateMap, translateChunkJson, rendererVersion,
} = require('../src/viewerTranslate');

let passed = 0;
async function check(label, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ok  ${label}`);
  } catch (err) {
    console.error(`  FAIL ${label}: ${err.message}`);
    process.exitCode = 1;
  }
}

function get(port, path) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, type: res.headers['content-type'], body: Buffer.concat(chunks) }));
    }).on('error', reject);
  });
}

/** Opens the SSE stream and collects `event` frames until one satisfies `done`. */
function framesUntil(port, event, done, trigger, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.get({
      host: '127.0.0.1', port, path: '/stream', headers,
    }, (res) => {
      let buf = '';
      const seen = [];
      res.on('data', (c) => {
        buf += c;
        const frames = buf.split('\n\n');
        buf = frames.pop();
        for (const f of frames) {
          // Field by field: an `id:` line may come first.
          const fields = Object.fromEntries(f.split('\n').map((l) => [l.slice(0, l.indexOf(':')), l.slice(l.indexOf(':') + 2)]));
          if (fields.event !== event) continue;
          const data = JSON.parse(fields.data);
          if (fields.id) data.$id = Number(fields.id);
          seen.push(data);
          if (done(data)) {
            req.destroy();
            resolve(seen);
            return;
          }
        }
      });
      trigger();
    });
    req.on('error', (err) => { if (err.code !== 'ECONNRESET') reject(err); });
  });
}

async function main() {
  console.log('the server');
  const dash = startDashboard({ port: 0, viewer: false });
  const addr = await dash.ready;
  const { port } = addr;

  await check('listens on this computer only', () => {
    assert.strictEqual(addr.address, '127.0.0.1');
  });

  await check('state with no world reads as offline, not as an error', async () => {
    const res = await get(port, '/api/state');
    assert.strictEqual(res.status, 200);
    const state = JSON.parse(res.body);
    assert.strictEqual(state.connected, false);
    assert.ok(Array.isArray(state.behaviors));
  });

  await check('the page and its script are served', async () => {
    const page = await get(port, '/');
    assert.strictEqual(page.status, 200);
    assert.ok(String(page.body).includes('js/main.js'));
    assert.strictEqual((await get(port, '/js/main.js')).status, 200);
  });

  await check('item icons resolve by name, whichever folder they live in', async () => {
    const item = await get(port, '/icon/diamond');
    assert.strictEqual(item.status, 200);
    assert.ok(item.type.includes('png'));
    const block = await get(port, '/icon/oak_log');
    assert.strictEqual(block.status, 200, 'a block with no item sprite falls back to its face');
    assert.strictEqual((await get(port, '/icon/not_a_real_thing')).status, 404);
  });

  await check('log lines reach the stream as they happen', async () => {
    const seen = await framesUntil(port, 'event', (e) => e.message === 'Chopped tree', () => logger.action('Chopped tree', { logs: 6 }));
    const entry = seen.at(-1);
    assert.strictEqual(entry.message, 'Chopped tree');
    assert.strictEqual(entry.data.logs, 6);
  });

  await check('status heartbeats stay out of the story feed', async () => {
    logger.status('hp 20/20 | heartbeat');
    const seen = await framesUntil(port, 'event', (e) => e.message === 'After the heartbeat', () => logger.info('After the heartbeat'));
    // The backlog replays first; the heartbeat must not be anywhere in it.
    assert.ok(seen.length >= 2, 'the backlog was replayed');
    assert.ok(!seen.some((e) => e.level === 'status'));
  });

  // Every reconnect used to replay all eighty backlog lines, doubling the
  // decision stream each time the connection blinked.
  await check('a reconnect gets only what it missed', async () => {
    const first = await framesUntil(port, 'event', (e) => e.message === 'Before the blink', () => logger.info('Before the blink'));
    const lastId = first.at(-1).$id;
    assert.ok(lastId > 0, 'frames carry ids');
    const again = await framesUntil(port, 'event', (e) => e.message === 'After the blink', () => logger.info('After the blink'), { 'Last-Event-ID': String(lastId) });
    assert.deepStrictEqual(again.map((e) => e.message), ['After the blink']);
  });

  await check('the state says how far the radar reaches, and counts spawns', async () => {
    const state = JSON.parse((await get(port, '/api/state')).body);
    assert.ok(Number.isFinite(state.radarRange));
    assert.ok(Number.isFinite(state.spawns));
  });

  await dash.close();

  console.log('\nthe logger');

  await check('a listener that throws cannot stop the bot logging', () => {
    let after = 0;
    const offBad = logger.subscribe(() => { throw new Error('broken page'); });
    const offGood = logger.subscribe(() => { after++; });
    logger.info('still logging');
    offBad();
    offGood();
    assert.strictEqual(after, 1);
  });

  console.log('\nthe brain panel');

  const behavior = (name, priority, wants) => ({ name, priority, shouldRun: () => wants });

  await check('records who said no, who was backed off, and who won', () => {
    const ctx = { backoff: new Map([['gear', { until: Date.now() + 5000 }]]) };
    const list = [behavior('shelter', 91, false), behavior('gear', 40, true), behavior('mine', 25, true), behavior('wood', 10, true)];
    const chosen = pickBehavior({}, ctx, list);
    assert.strictEqual(chosen.name, 'mine');
    const { pick } = ctx.decisionBoard;
    assert.strictEqual(pick.chosen, 'mine');
    assert.deepStrictEqual(pick.asked.map((a) => [a.name, a.verdict]), [
      ['shelter', 'no'], ['gear', 'backed-off'], ['mine', 'yes'],
    ]);
    assert.ok(pick.asked[1].backoffMs > 0);
    assert.strictEqual(ctx.decisionBoard.recent.at(-1).chosen, 'mine');
  });

  await check('asks nothing below the winner — no extra shouldRun calls', () => {
    let belowAsked = false;
    const ctx = { backoff: new Map() };
    pickBehavior({}, ctx, [behavior('gear', 40, true), { name: 'wood', priority: 10, shouldRun: () => { belowAsked = true; return true; } }]);
    assert.strictEqual(belowAsked, false);
  });

  console.log('\nthe 3D view\'s pace');

  await check('columns are queued and sent one at a time, not in a burst', async () => {
    const { PacedWorldView } = require('../src/dashboard');
    const Vec3 = require('vec3');
    const sent = [];
    const column = { toJson: () => '{}' };
    const world = { getColumnAt: async () => column };
    const emitter = { on() {}, emit: (event, data) => { if (event === 'loadChunk') sent.push(`${data.x},${data.z}`); } };
    const view = new PacedWorldView(world, 6, new Vec3(0, 64, 0), emitter);
    for (let i = 0; i < 4; i++) view.loadChunk(new Vec3(i * 16, 0, 0));
    view.unloadChunk(new Vec3(16, 0, 0)); // left the view before its turn
    assert.strictEqual(sent.length, 0, 'nothing is serialised on the spot');
    view.pump();
    await new Promise((r) => { setImmediate(r); });
    assert.deepStrictEqual(sent, ['0,0']);
    view.pump(); view.pump();
    await new Promise((r) => { setImmediate(r); });
    assert.deepStrictEqual(sent, ['0,0', '32,0', '48,0'], 'the unloaded column was never sent');
    view.stop();
  });

  console.log('\nthe 3D view\'s version bridge');

  await check('1.21.9 is drawn with the newest renderer that is not newer', () => {
    assert.strictEqual(rendererVersion('1.21.9', ['1.20.1', '1.21.1', '1.21.4']), '1.21.4');
    assert.strictEqual(rendererVersion('1.21.10', ['1.21.4', '1.21.9']), '1.21.9');
    assert.strictEqual(rendererVersion('1.8', ['1.21.4']), null);
  });

  await check('blocks keep their name and state across the bridge, including busy sections', () => {
    const Vec3 = require('vec3');
    const from = require('minecraft-data')('1.21.9');
    const to = require('minecraft-data')('1.21.4');
    const map = buildStateMap(from, to);
    const C9 = require('prismarine-chunk')('1.21.9');
    const C4 = require('prismarine-chunk')('1.21.4');
    const column = new C9({ minY: -64, worldHeight: 384 });
    column.setBlockStateId(new Vec3(0, 10, 0), from.blocksByName.diamond_ore.defaultState);
    column.setBlockStateId(new Vec3(1, 10, 0), from.blocksByName.oak_stairs.minStateId + 5);
    column.setBlockStateId(new Vec3(2, 10, 0), from.blocksByName.leaf_litter.defaultState);
    // 300 kinds of block in one section: too many for a palette, so the
    // server sends it "direct" — the encoding prismarine-chunk's JSON loses.
    const known = from.blocksArray.filter((b) => to.blocksByName[b.name]).slice(10, 310);
    known.forEach((b, i) => column.setBlockStateId(new Vec3(i % 16, 20, Math.floor(i / 16)), b.defaultState));

    const out = C4.fromJson(translateChunkJson(column.toJson(), map));
    assert.strictEqual(out.getBlock(new Vec3(0, 10, 0)).name, 'diamond_ore');
    const stairs = out.getBlock(new Vec3(1, 10, 0));
    assert.strictEqual(stairs.name, 'oak_stairs');
    assert.deepStrictEqual(stairs.getProperties(), column.getBlock(new Vec3(1, 10, 0)).getProperties());
    assert.strictEqual(out.getBlock(new Vec3(2, 10, 0)).name, 'air', 'unknown to 1.21.4: a stand-in, not a wrong block');
    const wrong = known.filter((b, i) => out.getBlock(new Vec3(i % 16, 20, Math.floor(i / 16))).name !== b.name);
    assert.deepStrictEqual(wrong.map((b) => b.name), []);
  });

  console.log(`\n${passed} checks passed`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
