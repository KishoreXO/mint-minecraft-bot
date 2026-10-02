/**
 * Getting more out of Jev without asking it more.
 *
 * Measured over 690 logs: of 17,185 answers warmed in the background, 317
 * were ever used. The fixes are timing and bookkeeping — answers that outlive
 * their refresh, no questions nobody reads, one request per subject, stale
 * requests dropped, slots shared out, ore verdicts riding along with strategy
 * — and each one is checked here against a stubbed network. No real calls.
 *
 * Run with: node test/jev.test.js
 */

const assert = require('assert');
const Vec3 = require('vec3');
const config = require('../src/config');

config.typesafe.apiKey = config.typesafe.apiKey || 'test-key';

const jevClient = require('../src/jevClient');
const prefetch = require('../src/prefetch');
const {
  worthAskingJev, needsFreshAnswer, THREAT_ANSWER_TTL_MS, bailHealth, LOW_HEALTH_BAIL,
} = require('../src/behaviors/threat');
const { currentRisk } = require('../src/director');

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

/** A network that answers after `delayMs`, counts calls, and honours abort. */
function stubNetwork(answer, delayMs = 20) {
  const net = { calls: [], client: null };
  net.client = {
    systemOne(body, { signal } = {}) {
      net.calls.push(body);
      return new Promise((resolve, reject) => {
        const t = setTimeout(() => resolve(answer(body)), delayMs);
        signal?.addEventListener('abort', () => {
          clearTimeout(t);
          const err = new Error('aborted');
          err.name = 'AbortError';
          reject(err);
        });
      });
    },
  };
  jevClient._setClientForTests(net.client);
  return net;
}

const threatAnswer = () => ({ answers: { action: { choice: 'fight', confidence: 0.9 } } });

async function main() {
  console.log('answers that outlive their refresh');

  await check('a threat answer lives past its refresh by a full round trip', () => {
    assert.ok(THREAT_ANSWER_TTL_MS >= prefetch.ENTITY_REFRESH_MS + config.typesafe.answerLatencyAllowanceMs);
  });

  await check('the prefetcher asks again just before an answer runs out, not after', () => {
    const now = Date.now();
    const ctx = { threat: { decisions: new Map([[7, { decision: 'fight', at: now }]]) } };
    assert.strictEqual(needsFreshAnswer(ctx, 7, now), false, 'fresh');
    const nearlyOut = now + THREAT_ANSWER_TTL_MS - config.typesafe.answerLatencyAllowanceMs;
    assert.strictEqual(needsFreshAnswer(ctx, 7, nearlyOut), true, 'one round trip left');
    assert.strictEqual(needsFreshAnswer(ctx, 99, now), true, 'never asked');
  });

  console.log('\nonly questions someone reads');

  const me = { position: new Vec3(0, 64, 0) };
  const bot = { entity: me, username: 'Mint', entities: {} };
  const ctx = { threat: { lastAttackerId: null, lastAttackAt: 0, lastAttackedAt: 0 } };
  const mob = (name, extra = {}) => ({
    id: 5, name, type: 'hostile', isValid: true, position: new Vec3(4, 64, 0), ...extra,
  });

  await check('creepers and endermen are not warmed — nothing reads those answers', () => {
    assert.strictEqual(worthAskingJev(bot, ctx, mob('creeper'), 4), false);
    assert.strictEqual(worthAskingJev(bot, ctx, mob('enderman', { type: 'mob' }), 4), false);
    assert.strictEqual(worthAskingJev(bot, ctx, mob('zombie'), 4), true);
  });

  await check('a player who has not hit the bot is not warmed either', () => {
    const player = mob('player', { type: 'player', username: 'Steve' });
    assert.strictEqual(worthAskingJev(bot, ctx, player, 4), false);
  });

  console.log('\none request per subject, and none for subjects that left');

  await check('asking about a mob already being asked about sends nothing new', async () => {
    const net = stubNetwork(threatAnswer);
    const [a, b] = await Promise.all([
      jevClient.assessMobThreat({ mob_type: 'zombie' }, { subject: 'mob:5' }),
      jevClient.assessMobThreat({ mob_type: 'zombie' }, { subject: 'mob:5' }),
    ]);
    assert.strictEqual(net.calls.length, 1);
    assert.strictEqual(a.decision, 'fight');
    assert.strictEqual(b.decision, 'fight');
    assert.strictEqual(jevClient.pending('mob:5'), false, 'cleared once answered');
  });

  await check('a question about a mob that has gone is abandoned, and frees its slot', async () => {
    stubNetwork(threatAnswer, 200);
    const asked = jevClient.assessMobThreat({ mob_type: 'zombie' }, { subject: 'mob:6' });
    assert.strictEqual(jevClient.pending('mob:6'), true);
    prefetch.abandonStale({ entity: { position: new Vec3(0, 64, 0) }, entities: {} });
    const result = await asked;
    assert.notStrictEqual(result.source, 'jev');
    assert.strictEqual(jevClient.pending('mob:6'), false);
    assert.strictEqual(jevClient.snapshot().threat.aborted, 1);
  });

  await check('a swarm cannot take the slots strategy and ore need', async () => {
    stubNetwork(threatAnswer, 100);
    const asks = [];
    for (let i = 0; i < prefetch.SLOTS.threat; i++) {
      asks.push(jevClient.assessMobThreat({}, { subject: `mob:${100 + i}` }));
    }
    assert.strictEqual(prefetch.canSend('threat'), false, 'threat slots full');
    assert.strictEqual(prefetch.canSend('strategy'), true);
    assert.strictEqual(prefetch.canSend('ore'), true);
    await Promise.all(asks);
  });

  console.log('\nore verdicts ride along with strategy');

  await check('one call carries the strategy and the due ore verdicts', async () => {
    const net = stubNetwork((body) => {
      const answers = {
        focus: { choice: 'ore', confidence: 0.8 },
        risk: { choice: 'safe', confidence: 0.7 },
      };
      for (const key of Object.keys(body.questions)) {
        if (key.startsWith('ore_')) answers[key] = { choice: 'mine', confidence: 0.9 };
      }
      return { answers };
    });
    const result = await jevClient.assessStrategy({ hunger: 20 }, {
      ores: [{ name: 'iron_ore', state: { already_held: 2 } }, { name: 'coal_ore', state: { already_held: 0 } }],
    });
    assert.strictEqual(net.calls.length, 1);
    assert.ok(net.calls[0].questions.ore_iron_ore && net.calls[0].questions.ore_coal_ore);
    assert.deepStrictEqual(net.calls[0].state.ores.iron_ore, { already_held: 2 });
    assert.strictEqual(result.focus, 'ore');
    assert.strictEqual(result.ores.iron_ore.decision, 'mine');
    assert.strictEqual(result.ores.coal_ore.decision, 'mine');
  });

  await check('no more ores ride along than the cap', async () => {
    const net = stubNetwork(() => ({
      answers: { focus: { choice: 'ore', confidence: 0.8 }, risk: { choice: 'safe', confidence: 0.7 } },
    }));
    const ores = ['a', 'b', 'c', 'd', 'e'].map((name) => ({ name: `${name}_ore`, state: {} }));
    await jevClient.assessStrategy({}, { ores });
    const oreQuestions = Object.keys(net.calls[0].questions).filter((k) => k.startsWith('ore_'));
    assert.strictEqual(oreQuestions.length, jevClient.MAX_ORES_PER_STRATEGY);
  });

  console.log('\nusing what comes back');

  await check('a coin-flip answer is not used — instinct decides', () => {
    assert.strictEqual(jevClient.confident({ source: 'jev', confidence: 0.2 }), false);
    assert.strictEqual(jevClient.confident({ source: 'jev', confidence: 0.6 }), true);
    assert.strictEqual(jevClient.confident({ source: 'fallback', confidence: 1 }), false);
  });

  await check('"danger" from Jev only ever makes the bot more careful', () => {
    const fresh = { strategy: { risk: 'danger', riskConfidence: 0.8, at: Date.now() } };
    const stale = { strategy: { risk: 'danger', riskConfidence: 0.8, at: Date.now() - 10 * 60 * 1000 } };
    const unsure = { strategy: { risk: 'danger', riskConfidence: 0.1, at: Date.now() } };
    assert.strictEqual(currentRisk(fresh), 'danger');
    assert.strictEqual(currentRisk(stale), null);
    assert.strictEqual(currentRisk(unsure), null);
    const alone = { entity: { position: new Vec3(0, 64, 0) }, entities: {} };
    assert.strictEqual(bailHealth(alone), LOW_HEALTH_BAIL);
    assert.ok(bailHealth(alone, fresh) > LOW_HEALTH_BAIL, 'leaves fights sooner');
    assert.strictEqual(bailHealth(alone, unsure), LOW_HEALTH_BAIL);
  });

  await check('"danger" starts the dusk dig-in earlier, never later', () => {
    const { nightComing, DUSK_PREP_SEC } = require('../src/behaviors/shelter');
    // Just outside the normal prep window: 1.2x the usual lead.
    const tick = 13000 - Math.round(DUSK_PREP_SEC * 1.2 * 20); // world.js DUSK
    const dusky = { time: { timeOfDay: tick, day: 1, isDay: true }, entity: { position: new Vec3(0, 64, 0) } };
    const fresh = { strategy: { risk: 'danger', riskConfidence: 0.8, at: Date.now() } };
    assert.strictEqual(nightComing(dusky), false);
    assert.strictEqual(nightComing(dusky, fresh), true);
  });

  jevClient._setClientForTests(null);
  console.log(`\n${passed} checks passed`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
