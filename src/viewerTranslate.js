const BitArray = require('prismarine-chunk/src/pc/common/BitArrayNoSpan');

/**
 * Chunks from a 1.21.9 world, re-labelled so a 1.21.4 renderer can draw them.
 *
 * prismarine-viewer's browser bundle ships minecraft-data up to 1.21.4 and no
 * further. Told "1.21.9" it has no block table at all; told "1.21.4" while
 * being handed 1.21.9 chunks it draws the wrong block wherever the two
 * versions' state numbering differs — and 1.21.5–1.21.9 inserted ~70 blocks
 * (shelves, copper bars, leaf litter...), shifting nearly every state id after
 * them. So every chunk and block update is translated on the way out, by
 * name, through a table built once from both registries.
 *
 * Only palettes are rewritten, never the 4096 cells of a section: a section's
 * data indexes its palette, so relabelling the palette relabels every block.
 * The one exception is a "direct" section (too many kinds of block for a
 * palette), which has to be walked cell by cell — rare, and still only 4096
 * reads.
 */

// Blocks the older renderer has never heard of, drawn as the nearest thing it
// does know. Anything not listed falls back to stone if solid, air if not.
const STAND_INS = {
  iron_chain: 'chain',
  bush: 'short_grass',
  firefly_bush: 'short_grass',
  short_dry_grass: 'short_grass',
  tall_dry_grass: 'tall_grass',
  wildflowers: 'pink_petals',
  leaf_litter: 'air',
  cactus_flower: 'air',
  dried_ghast: 'air',
  copper_torch: 'torch',
  copper_wall_torch: 'wall_torch',
};

function sameProperties(a, b) {
  const sa = a.states ?? [];
  const sb = b.states ?? [];
  if (sa.length !== sb.length) return false;
  return sa.every((s, i) => s.name === sb[i].name
    && s.num_values === sb[i].num_values
    && JSON.stringify(s.values ?? null) === JSON.stringify(sb[i].values ?? null));
}

/** Int32Array indexed by source state id, holding the target state id. */
function buildStateMap(from, to) {
  const maxState = Math.max(...from.blocksArray.map((b) => b.maxStateId));
  const map = new Int32Array(maxState + 1);
  const air = to.blocksByName.air.defaultState;
  const stone = to.blocksByName.stone.defaultState;

  for (const block of from.blocksArray) {
    let target = to.blocksByName[block.name];
    if (!target && STAND_INS[block.name]) target = to.blocksByName[STAND_INS[block.name]];
    for (let s = block.minStateId; s <= block.maxStateId; s++) {
      if (!target) {
        map[s] = block.boundingBox === 'block' ? stone : air;
      } else if (target.name === block.name && sameProperties(block, target)) {
        map[s] = target.minStateId + (s - block.minStateId);
      } else {
        map[s] = target.defaultState;
      }
    }
  }
  return map;
}

function translateContainer(json, map) {
  const c = JSON.parse(json);
  const m = (id) => (id >= 0 && id < map.length ? map[id] : id);
  if (c.type === 'single') {
    c.value = m(c.value);
  } else if (c.type === 'indirect') {
    c.palette = c.palette.map(m);
  } else if (c.type === 'direct') {
    // Re-encoded as a palette, not relabelled in place: prismarine-chunk's
    // DirectPaletteContainer.fromJson discards `data` and starts from an
    // empty array, so a direct section arrived in the browser as solid air.
    // A palette container of any width round-trips intact.
    const source = BitArray.fromJson(c.data);
    const palette = [];
    const slot = new Map();
    const cells = new Array(source.capacity);
    for (let i = 0; i < source.capacity; i++) {
      const id = m(source.get(i));
      if (!slot.has(id)) { slot.set(id, palette.length); palette.push(id); }
      cells[i] = slot.get(id);
    }
    const bitsPerValue = Math.max(4, Math.ceil(Math.log2(palette.length)));
    const data = new BitArray({ bitsPerValue, capacity: source.capacity });
    cells.forEach((v, i) => data.set(i, v));
    return JSON.stringify({
      type: 'indirect', palette, maxBits: 8, maxBitsPerBlock: source.bitsPerValue, data: data.toJson(),
    });
  }
  return JSON.stringify(c);
}

/** A ChunkColumn.toJson() string, with every block state relabelled. */
function translateChunkJson(json, map) {
  const column = JSON.parse(json);
  column.sections = column.sections.map((sectionJson) => {
    const section = JSON.parse(sectionJson);
    section.data = translateContainer(section.data, map);
    return JSON.stringify(section);
  });
  return JSON.stringify(column);
}

/**
 * The newest version the renderer supports that is not newer than the world.
 * Versions are compared numerically, so "1.21.10" sorts after "1.21.9".
 */
function rendererVersion(worldVersion, supported) {
  const parts = (v) => String(v).split('.').map(Number);
  const cmp = (a, b) => {
    const pa = parts(a);
    const pb = parts(b);
    for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
      const d = (pa[i] ?? 0) - (pb[i] ?? 0);
      if (d) return d;
    }
    return 0;
  };
  const usable = supported.filter((v) => cmp(v, worldVersion) <= 0).sort(cmp);
  return usable[usable.length - 1] ?? null;
}

module.exports = {
  buildStateMap, translateChunkJson, translateContainer, rendererVersion, STAND_INS,
};
