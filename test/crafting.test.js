/**
 * Did a craft happen? The answer decides whether the materials get spent again.
 *
 * Live on 09-26 20:47:20 a stone sword was reported as "nothing appeared", and
 * was in the bot's hand by 20:49:03. In between, gear struck it out as
 * "no crafting table" four times and re-crafted planks it already had. The
 * ingredients leaving the bag is proof the server made the item even when the
 * bag has not caught up.
 *
 * Run with: node test/crafting.test.js
 */

const assert = require('assert');
const { craftItem } = require('../src/inventory');

let passed = 0;
async function check(label, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ok  ${label}`);
  } catch (err) {
    console.error(`  FAIL  ${label}\n        ${err.message}`);
    process.exitCode = 1;
  }
}

const IDS = { oak_log: 1, oak_planks: 2 };

/** A bag, and a craft that does whatever `onCraft` does to it. */
function fakeBot(bag, onCraft) {
  const items = () => Object.entries(bag)
    .filter(([, count]) => count > 0)
    .map(([name, count]) => ({ name, type: IDS[name], count }));
  return {
    registry: { itemsByName: { oak_planks: { id: IDS.oak_planks } } },
    recipesFor: () => [{ delta: [{ id: IDS.oak_log, count: -1 }, { id: IDS.oak_planks, count: 4 }] }],
    inventory: { items },
    pathfinder: { setGoal() {} },
    clearControlStates() {},
    currentWindow: null,
    craft: async () => onCraft(bag),
  };
}

(async () => {
  console.log('crafting');

  await check('a craft whose planks arrive is a success', async () => {
    const bot = fakeBot({ oak_log: 2 }, (bag) => { bag.oak_log -= 1; bag.oak_planks = 4; });
    assert.strictEqual(await craftItem(bot, 'oak_planks', 1, null), true);
  });

  await check('logs gone but planks not in the bag yet: the craft happened', async () => {
    const bot = fakeBot({ oak_log: 2 }, (bag) => { bag.oak_log -= 1; });
    assert.strictEqual(await craftItem(bot, 'oak_planks', 1, null), true);
  });

  await check('nothing used and nothing made: a real failure', async () => {
    const bot = fakeBot({ oak_log: 2 }, () => {});
    assert.strictEqual(await craftItem(bot, 'oak_planks', 1, null), false);
  });

  console.log(`\n${passed} checks passed`);
})();
