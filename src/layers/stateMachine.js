const logger = require('../logger');

/**
 * A small, generic finite state machine.
 *
 * Deliberately dumb: it owns transition legality and the enter/update/exit
 * lifecycle, nothing else. What each state actually DOES to the bot lives in
 * the state module itself (see src/layers/states/*.js), not here.
 */
class StateMachine {
  /**
   * @param {Object<string, {enter?, update?, exit?}>} states name -> state
   * @param {Object<string, Set<string>>} transitions name -> allowed next
   * @param {string} initial starting state name
   */
  constructor(states, transitions, initial) {
    this.states = states;
    this.transitions = transitions;
    this.current = initial;
  }

  canTransition(to) {
    if (to === this.current) return true;
    if (!this.states[to]) return false;
    return !!this.transitions[this.current]?.has(to);
  }

  /** Move to a new state, running exit() on the old one and enter() on the new. */
  transition(to, bot, ctx, reason) {
    if (to === this.current) return false;
    if (!this.canTransition(to)) {
      logger.warn('State machine: illegal transition refused', {
        from: this.current, to, reason,
      });
      return false;
    }

    const from = this.current;
    try {
      this.states[from]?.exit?.(bot, ctx);
    } catch (err) {
      logger.warn('State exit threw', { state: from, error: err.message });
    }

    this.current = to;

    try {
      this.states[to]?.enter?.(bot, ctx, reason);
    } catch (err) {
      logger.warn('State enter threw', { state: to, error: err.message });
    }
    return true;
  }

  /** Run the active state's per-tick work, if it has any. */
  update(bot, ctx) {
    const state = this.states[this.current];
    if (!state?.update) return;
    try {
      state.update(bot, ctx);
    } catch (err) {
      logger.warn('State update threw', { state: this.current, error: err.message });
    }
  }
}

module.exports = { StateMachine };
