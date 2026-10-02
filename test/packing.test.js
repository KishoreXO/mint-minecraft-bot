/**
 * Deciding when to pick the workshop up and carry it.
 *
 * The bot places a crafting table, uses it, and walks off — so next time it
 * needs one it is a hundred blocks away and builds another. Carrying it is
 * the fix, and it is also the single most dangerous small behavior in the
 * project: get the condition wrong and it breaks the table it is about to
 * use, or destroys a furnace with the bot's iron still inside.
 *
 * Two failure modes this pins down, both found by reading the code back
 * rather than by watching it:
 *
 *  - "nothing left to craft" fires the INSTANT gear finishes, while the bot
 *    is still standing at the table. That is place, craft, pack, place,
 *    craft, pack — every cycle.
 *  - a furnace packed mid-cook takes the contents with it.
 *
 * Run with: node test/packing.test.js
 */

const assert = require('assert');
const { Vec3 } = require('vec3');
const { stationToPack, STATION_IDLE_BEFORE_PACKING_MS, toDiscard } = require('../src/behaviors/tidy');
const { findPlacementSpot, PLACE_ATTEMPTS } = require('../src/stations');
const { knownBase } = require('../src/base');

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

const ITEM_NAMES = [
  'crafting_table', 'furnace', 'oak_log', 'oak_planks', 'stick', 'cobblestone',
  'wooden_pickaxe', 'stone_pickaxe', 'wooden_sword', 'stone_sword',
  'wooden_axe', 'stone_axe', 'torch', 'iron_ingot', 'diamond', 'shield',
];
const itemsByName = Object.fromEntries(ITEM_NAMES.map((n, i) => [n, { id: i, name: n }]));

/** A bot standing next to its own crafting table at 0,64,0. */
function botAtTable(items = {}) {
  const list = Object.entries(items).map(([name, count], i) => ({ name, count, type: 300 + i }));
  return {
    entity: { position: new Vec3(1, 64, 0) },
    inventory: { items: () => list, slots: [] },
    getEquipmentDestSlot: () => 5,
    registry: { itemsByName },
    blockAt: (p) => (p.x === 0 && p.y === 64 && p.z === 0
      ? { name: 'crafting_table', position: p, boundingBox: 'block' }
      : { name: 'air', position: p, boundingBox: 'empty' }),
  };
}

const longIdle = () => Date.now() - STATION_IDLE_BEFORE_PACKING_MS - 1000;
const ctxWith = (over = {}) => ({
  smelt: { pending: null },
  stations: { lastUsedAt: longIdle() },
  ...over,
});

// A fully equipped bot with nothing left to build, that has not touched the
// table in a minute, has genuinely finished here.
const FULLY_EQUIPPED = {
  stone_pickaxe: 1, stone_sword: 1, stone_axe: 1, cobblestone: 40, oak_planks: 20,
};

function setTable(pos) {
  knownBase.tablePos = pos;
  knownBase.furnacePos = null;
  knownBase.smokerPos = null;
  knownBase.blastPos = null;
}

console.log('packing up when genuinely finished');

check('a long-idle table with nothing left to craft gets packed', () => {
  setTable(new Vec3(0, 64, 0));
  const got = stationToPack(botAtTable(FULLY_EQUIPPED), ctxWith());
  assert.ok(got, 'should want to pack it');
  assert.strictEqual(got.key, 'tablePos');
});

console.log('\nand never while the work is still going');

// The thrash: gear crafts its last tool, nextGoal goes null that instant,
// and tidy breaks the table the bot is still standing at.
check('a table used seconds ago is left alone', () => {
  setTable(new Vec3(0, 64, 0));
  const ctx = ctxWith({ stations: { lastUsedAt: Date.now() - 2000 } });
  assert.strictEqual(stationToPack(botAtTable(FULLY_EQUIPPED), ctx), null);
});

check('still something to craft means still needed', () => {
  setTable(new Vec3(0, 64, 0));
  // Logs and cobblestone but no tools — gear has plenty to do.
  const bot = botAtTable({ oak_log: 10, cobblestone: 20 });
  assert.strictEqual(stationToPack(bot, ctxWith()), null);
});

// Packing a furnace mid-cook takes the contents with it.
check('a furnace with a batch inside is never touched', () => {
  setTable(new Vec3(0, 64, 0));
  const ctx = ctxWith({ smelt: { pending: { readyAt: Date.now() + 5000 } } });
  assert.strictEqual(stationToPack(botAtTable(FULLY_EQUIPPED), ctx), null);
});

console.log('\nand never the wrong one');

check('a table too far away is not packed', () => {
  setTable(new Vec3(400, 64, 400));
  assert.strictEqual(stationToPack(botAtTable(FULLY_EQUIPPED), ctxWith()), null);
});

// Twice on 09-24: "Could not get back to the station to pack it — no route",
// a furnace six to nine blocks above the bot, twenty seconds each.
check('a station well above the bot is not worth climbing back for', () => {
  setTable(new Vec3(0, 64, 0));
  const below = botAtTable(FULLY_EQUIPPED);
  below.entity.position = new Vec3(1, 56, 0);
  assert.strictEqual(stationToPack(below, ctxWith()), null);
});

check('a table we do not remember placing is left alone', () => {
  setTable(null);
  assert.strictEqual(stationToPack(botAtTable(FULLY_EQUIPPED), ctxWith()), null);
});

check('already carrying one means leave this one standing', () => {
  setTable(new Vec3(0, 64, 0));
  const bot = botAtTable({ ...FULLY_EQUIPPED, crafting_table: 1 });
  assert.strictEqual(stationToPack(bot, ctxWith()), null);
});

check('a remembered spot that is no longer a table is not packed', () => {
  setTable(new Vec3(5, 64, 5)); // botAtTable only reports a table at 0,64,0
  assert.strictEqual(stationToPack(botAtTable(FULLY_EQUIPPED), ctxWith()), null);
});

check('a missing ctx does not throw', () => {
  setTable(new Vec3(0, 64, 0));
  assert.doesNotThrow(() => stationToPack(botAtTable(FULLY_EQUIPPED), undefined));
});

/**
 * Where a station can go, and what a retry is allowed to do about it.
 *
 * A 1-wide tunnel is where the bot spends most of its life, and it is the
 * case that broke: exactly one legal spot, so the second attempt used to walk
 * off the end of the candidate list and report "nowhere", abandoning the
 * craft over a single refusal.
 */
const AIR = { boundingBox: 'empty', name: 'air' };

/**
 * A bot at 0,64,0 with solid floor everywhere and air only at `open` — and in
 * its own column, which the real bot is standing in. (This used to leave the
 * bot's own column solid, which nothing noticed while spots were probed from
 * the raw position; they are now probed from the cell the feet are in.)
 */
function botInTunnel(...open) {
  const openSet = new Set(['0,0', ...open]);
  return {
    entity: { position: new Vec3(0.5, 64, 0.5) }, // where a player stands: mid-cell
    blockAt(p) {
      if (p.y === 63) return { boundingBox: 'block', name: 'stone', position: p };
      return openSet.has(`${p.x},${p.z}`)
        ? { ...AIR, position: p }
        : { boundingBox: 'block', name: 'stone', position: p };
    },
  };
}

console.log('\nstation placement spots');

check('a sealed-in bot genuinely has nowhere', () => {
  assert.strictEqual(findPlacementSpot(botInTunnel(), 0), null);
});

check('the only spot in a 1-wide tunnel survives every retry', () => {
  const bot = botInTunnel('1,0');
  for (let attempt = 0; attempt < PLACE_ATTEMPTS; attempt++) {
    const spot = findPlacementSpot(bot, attempt);
    assert.ok(spot, `attempt ${attempt} gave up on the one spot that exists`);
    assert.strictEqual(spot.position.x, 1);
  }
});

// Live on 09-24: the bot stood at x≈65.75, the table was refused at x=66, and
// the furnace was refused at the SAME cell a second later. Its body — 0.6 wide
// — reached into the cell it kept offering itself.
check('never a cell the bot\'s own body is standing in', () => {
  const bot = botInTunnel('1,0', '-1,0');
  bot.entity.position = new Vec3(0.75, 64, 0.5); // reaching 0.3 into x=1
  for (let attempt = 0; attempt < PLACE_ATTEMPTS; attempt++) {
    assert.notStrictEqual(findPlacementSpot(bot, attempt)?.position.x, 1);
  }
});

check('retries move on when there is somewhere else to go', () => {
  const bot = botInTunnel('1,0', '-1,0');
  const first = findPlacementSpot(bot, 0);
  const second = findPlacementSpot(bot, 1);
  assert.notStrictEqual(first.position.x, second.position.x, 'a retry reused the refused spot');
  assert.strictEqual(findPlacementSpot(bot, 2).position.x, first.position.x, 'skip must wrap');
});

// The float position the server sends for a bot standing on a block is often
// a hair under the integer. Probed from it, every spot's "floor" was one block
// too low and every spot was rejected: `Nowhere clear to place block {tried: 0}`.
check('a bot reported a hair under the block top still finds its spot', () => {
  const bot = botInTunnel('1,0');
  bot.entity.position = new Vec3(0.5, 63.99999, 0.5);
  const spot = findPlacementSpot(bot, 0);
  assert.ok(spot, 'the rounding must not hide the spot');
  assert.strictEqual(spot.position.x, 1);
  assert.strictEqual(spot.position.y, 63, 'the floor beside us, not the block under it');
});

// Inside the bot's own staircase there is no level ground at all — ahead is
// the next step down, behind is the step it came from — and live, that left a
// bot with a broken pickaxe and a table in its bag unable to put the table down.
check('inside a staircase the step behind is a place for the table', () => {
  // Feet at (0,64,0) on stone at y=63. The step behind is one higher: its
  // floor (-1,64,0) is stone and the two cells above it are open. Everything
  // else at and above the feet is rock.
  const open = new Set(['0,64,0', '0,65,0', '-1,65,0', '-1,66,0', '0,66,0']);
  const bot = {
    entity: { position: new Vec3(0.5, 64, 0.5) },
    blockAt(p) {
      const key = `${p.x},${p.y},${p.z}`;
      return open.has(key)
        ? { ...AIR, position: p }
        : { boundingBox: 'block', name: 'stone', position: p };
    },
  };
  const spot = findPlacementSpot(bot, 0);
  assert.ok(spot, 'a staircase must not be "nowhere"');
  assert.deepStrictEqual([spot.position.x, spot.position.y, spot.position.z], [-1, 64, 0]);
});

check('level ground still wins over a step when there is any', () => {
  const bot = botInTunnel('1,0', '-1,0');
  assert.strictEqual(findPlacementSpot(bot, 0).position.y, 63, 'same level first');
});

// Leave the shared module state clean for anything that runs after us.
setTable(null);

console.log('\nthrowing things away');

// Live on 09-24 the same wheat seed was thrown six times in a strip mine: the
// server hands a tossed stack straight back to a bot walking over it.
const junkBot = (extraSlots = 0) => {
  const list = [{ name: 'wheat_seeds', count: 1, type: 900 }];
  for (let i = 0; i < extraSlots; i++) list.push({ name: 'oak_log', count: 1, type: 901 + i });
  return { entity: { position: new Vec3(0, 14, 0) }, inventory: { items: () => list, slots: [] } };
};
const threwSeedsAt = (pos, ago = 5000) => ({
  tidy: { discarded: [{ pos, at: Date.now() - ago, item: 'wheat_seeds' }] },
});

// 34 cobblestone throws in the 13:38 session, some of two or seven blocks.
check('a stack over the cap before throwing, and then the biggest stack', () => {
  const { surplusCandidates, CAPS, CAP_SLACK } = require('../src/stock');
  const cap = CAPS.get('cobblestone');
  const bag = (...counts) => ({
    inventory: { items: () => counts.map((count, i) => ({ name: 'cobblestone', count, type: 50 + i })), slots: [] },
  });
  assert.deepStrictEqual(surplusCandidates(bag(64, 64, 2)), [], `${cap + 2} is not worth a throw`);
  const over = surplusCandidates(bag(64, 64, 64, 10));
  assert.ok(64 * 3 + 10 > cap + CAP_SLACK);
  assert.strictEqual(over.length, 1);
  assert.strictEqual(over[0].count, 64, 'throw a whole stack, not the ten');
});

check('junk is thrown back down the tunnel, not into the next step', () => {
  const { throwYaw } = require('../src/behaviors/tidy');
  const yaw = throwYaw({ entity: { position: new Vec3(0, 14, 0) } }, { mine: { stripHeading: [1, 0] } });
  // mineflayer faces (−sin yaw, −cos yaw): digging towards +x, throw towards −x.
  assert.ok(Math.abs(-Math.sin(yaw) - -1) < 1e-9 && Math.abs(-Math.cos(yaw)) < 1e-9);
});

check('junk is thrown the first time', () => {
  assert.strictEqual(toDiscard(junkBot(), {})?.name, 'wheat_seeds');
});

check('the same junk come straight back is kept rather than thrown again', () => {
  assert.strictEqual(toDiscard(junkBot(), threwSeedsAt(new Vec3(3, 14, 0))), null);
});

check('...unless the bag is short of room', () => {
  assert.strictEqual(toDiscard(junkBot(31), threwSeedsAt(new Vec3(3, 14, 0), 60000))?.name, 'wheat_seeds');
});

check('...but back within half a minute, it is held however full the bag is', () => {
  assert.strictEqual(toDiscard(junkBot(31), threwSeedsAt(new Vec3(3, 14, 0), 5000)), null);
});

// Live on 09-24 almost every repeated throw was beside the furnace and table,
// which the bot walks back to on every smelt.
check('junk waits until the bot has left the workshop', () => {
  setTable(new Vec3(2, 14, 0));
  try {
    assert.strictEqual(toDiscard(junkBot(), {}), null);
    assert.strictEqual(toDiscard(junkBot(31), {})?.name, 'wheat_seeds', 'short of room, it goes anyway');
  } finally {
    setTable(null);
  }
});

check('...or the bot has moved well away from where it was thrown', () => {
  assert.strictEqual(toDiscard(junkBot(), threwSeedsAt(new Vec3(40, 14, 0)))?.name, 'wheat_seeds');
});

// tidy now keeps its marks for five minutes to spot bounces; collect must not
// inherit that as a five-minute blackout on real drops lying nearby.
check('collect\'s pickup blackout still ends after two minutes', () => {
  const { nearADiscard } = require('../src/behaviors/collect');
  const mark = (ago) => ({
    tidy: {
      discarded: [{
        pos: new Vec3(0, 14, 0), at: Date.now() - ago, item: 'wheat_seeds', pickupBlockedUntil: Date.now() - ago + 120000,
      }],
    },
  });
  assert.strictEqual(nearADiscard(null, mark(10000), new Vec3(1, 14, 0), 'wheat_seeds'), true);
  assert.strictEqual(nearADiscard(null, mark(200000), new Vec3(1, 14, 0), 'wheat_seeds'), false);
});

check('...or it was thrown long enough ago to be a different stack', () => {
  assert.strictEqual(toDiscard(junkBot(), threwSeedsAt(new Vec3(3, 14, 0), 10 * 60000))?.name, 'wheat_seeds');
});

// known-base.json was found EMPTY after the 09-24 15:35 run: the shutdown
// save was an async write, and the process was gone before it finished.
check('the station file is complete the moment save() returns', () => {
  const fs = require('fs');
  const base = require('../src/base');
  const original = fs.existsSync(base.FILE) ? fs.readFileSync(base.FILE) : null;
  const was = base.knownBase.homePos;
  try {
    base.knownBase.homePos = new Vec3(123, 45, -678);
    base.save();
    const onDisk = JSON.parse(fs.readFileSync(base.FILE, 'utf8'));
    assert.deepStrictEqual(onDisk.homePos, { x: 123, y: 45, z: -678 }, 'a process exiting now would leave it unwritten');
  } finally {
    base.knownBase.homePos = was;
    if (original === null) fs.rmSync(base.FILE, { force: true });
    else fs.writeFileSync(base.FILE, original);
  }
});

// Live on 09-25: "EPERM: operation not permitted, rename known-base.json.tmp
// -> known-base.json" — Windows holding the file for a moment — and the save
// was dropped.
function withRenameFailing(times, code, fn) {
  const fs = require('fs');
  const real = fs.renameSync;
  let calls = 0;
  fs.renameSync = (...args) => {
    calls++;
    if (calls <= times) {
      const err = new Error(`${code}: operation not permitted, rename`);
      err.code = code;
      throw err;
    }
    return real(...args);
  };
  try {
    return fn(() => calls);
  } finally {
    fs.renameSync = real;
  }
}

function savedHome(point, failTimes) {
  const fs = require('fs');
  const base = require('../src/base');
  const original = fs.existsSync(base.FILE) ? fs.readFileSync(base.FILE) : null;
  const was = base.knownBase.homePos;
  try {
    base.knownBase.homePos = point;
    withRenameFailing(failTimes, 'EPERM', () => base.save());
    return JSON.parse(fs.readFileSync(base.FILE, 'utf8')).homePos;
  } finally {
    base.knownBase.homePos = was;
    if (original === null) fs.rmSync(base.FILE, { force: true });
    else fs.writeFileSync(base.FILE, original);
    fs.rmSync(`${base.FILE}.tmp`, { force: true });
  }
}

check('a rename Windows refuses for a moment is retried', () => {
  assert.deepStrictEqual(savedHome(new Vec3(1, 2, 3), 2), { x: 1, y: 2, z: 3 });
});

check('a rename that never goes through still saves, in place', () => {
  assert.deepStrictEqual(savedHome(new Vec3(4, 5, 6), 99), { x: 4, y: 5, z: 6 });
});

console.log(`\n${passed} checks passed`);
