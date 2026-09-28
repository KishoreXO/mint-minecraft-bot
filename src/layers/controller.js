const { installReflexLayer } = require('./reflex');
const { StateMachine } = require('./stateMachine');
const { STATES, TRANSITIONS, classify } = require('./states');

const CLASSIFY_INTERVAL_MS = 100;

/**
 * Wires the reflex layer and the state machine into a live bot.
 *
 * Reflexes are genuinely active — see reflex.js. The state machine is an
 * OBSERVER of director.js by default: it classifies whatever behavior
 * director is currently running (mine -> 'mining', threat -> 'fighting', …)
 * and drives enter/update/exit off that, rather than owning bot.pathfinder
 * or bot.setControlState itself. Two schedulers fighting for the same
 * control states is exactly the bug class this project has spent the most
 * time fixing (see director.js's own history), so this layer adds
 * visibility and a real extension point — ctx.combatPolicy — without
 * competing with the tuned behavior list for the bot's body.
 *
 * ctx.state.current is the machine's own view, readable from anywhere
 * (status line, tests, a future policy) without reaching into director's
 * internals.
 */
function installLayers(bot, ctx) {
  const machine = new StateMachine(STATES, TRANSITIONS, 'idle');
  ctx.state = machine;

  const stopReflexes = installReflexLayer(bot, ctx);

  const classifyTimer = setInterval(() => {
    if (!ctx.connected) return;
    const wanted = classify(ctx.currentBehavior);
    if (wanted !== machine.current) {
      machine.transition(wanted, bot, ctx, ctx.currentBehavior);
    }
    machine.update(bot, ctx);
  }, CLASSIFY_INTERVAL_MS);
  if (classifyTimer.unref) classifyTimer.unref();

  return () => {
    stopReflexes();
    clearInterval(classifyTimer);
  };
}

module.exports = { installLayers };
