/**
 * Lava, judged by the whole body rather than one point of it.
 *
 * Every lava check in the project used to ask about the block at the bot's
 * position — the single cell its centre point sits in. The body is 0.6 wide.
 * Standing on the lip of a pool, half the hitbox is in the lava and the centre
 * cell is stone, so every one of those checks answered "not in lava" while the
 * game dealt lava damage four times a second.
 *
 * That is how the bot died at 15:36 on 09-24 with thirteen diamonds: the
 * escape stopped after one step because its centre had left the lava cell,
 * the hazard reflex never fired again, the damage ledger booked eight hits of
 * lava-rate damage as "fire", and `valuables` took the wheel back and walked
 * on. 20 health to 0 in four seconds.
 *
 * The physics engine already works this out properly — prismarine-physics
 * sets `entity.isInLava` from the player's bounding box every tick — and
 * nothing read it. The cell scan below is the same question asked of the
 * world directly, for the moments physics has not ticked yet (just spawned,
 * just teleported) and for the tests' stub bots, which have no physics.
 *
 * A leaf module on purpose: survive, damage, falls and bot.js all need it, and
 * nav already depends on falls.
 */

const { Vec3 } = require('vec3');

const LAVA_NAMES = new Set(['lava', 'flowing_lava']);

// Vanilla player hitbox: 0.6 wide, 1.8 tall.
const BODY_HALF_WIDTH = 0.3;
const BODY_HEIGHT = 1.8;
// A box edge exactly on a block boundary does not overlap the next block.
const EDGE = 1e-6;

function isLavaBlock(block) {
  return !!block && LAVA_NAMES.has(block.name);
}

/** Every block cell a player standing at `pos` overlaps, grown by `margin`. */
function bodyCells(pos, margin = 0) {
  const half = BODY_HALF_WIDTH + margin;
  const x0 = Math.floor(pos.x - half);
  const x1 = Math.floor(pos.x + half - EDGE);
  const y0 = Math.floor(pos.y - margin);
  const y1 = Math.floor(pos.y + BODY_HEIGHT + margin - EDGE);
  const z0 = Math.floor(pos.z - half);
  const z1 = Math.floor(pos.z + half - EDGE);
  const cells = [];
  for (let x = x0; x <= x1; x++) {
    for (let y = y0; y <= y1; y++) {
      for (let z = z0; z <= z1; z++) cells.push(new Vec3(x, y, z));
    }
  }
  return cells;
}

function lavaInCells(bot, cells) {
  return cells.some((cell) => {
    try {
      return isLavaBlock(bot.blockAt(cell));
    } catch {
      return false;
    }
  });
}

/** A body standing at `pos` would be in lava. */
function lavaAtBody(bot, pos) {
  return lavaInCells(bot, bodyCells(pos));
}

/** Any part of the body in lava. */
function touchingLava(bot) {
  const entity = bot.entity;
  if (!entity?.position) return false;
  if (entity.isInLava) return true;
  return lavaInCells(bot, bodyCells(entity.position));
}

/**
 * Lava within `margin` blocks of the body.
 *
 * "Out of the lava" is not "safe": a body that has only just left the edge is
 * one knockback, one drift or one lava flow from being back in it. The escape
 * keeps going until this is clear too.
 */
function lavaNearBody(bot, margin = 1) {
  const entity = bot.entity;
  if (!entity?.position) return false;
  return lavaInCells(bot, bodyCells(entity.position, margin));
}

const SIDES = [[1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1]];

/** A cell with lava directly beside it on the same level. */
function lavaBeside(bot, cell) {
  return SIDES.some(([dx, dy, dz]) => {
    try {
      return isLavaBlock(bot.blockAt(cell.offset(dx, dy, dz)));
    } catch {
      return false;
    }
  });
}

module.exports = {
  LAVA_NAMES,
  BODY_HALF_WIDTH,
  isLavaBlock,
  bodyCells,
  touchingLava,
  lavaAtBody,
  lavaNearBody,
  lavaBeside,
};
