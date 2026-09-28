const fs = require('fs');
const path = require('path');
const { Vec3 } = require('vec3');
const logger = require('./logger');
const memory = require('./memory');

/**
 * Where the bot has placed its crafting table / furnace.
 *
 * Kept on disk because this has to outlive both reconnects (which rebuild
 * all in-memory state) and full process restarts — otherwise the bot
 * "forgets" a table it placed a minute ago and crafts a redundant one,
 * which is how the world ended up littered with crafting tables.
 */
const FILE = path.join(__dirname, '..', 'known-base.json');
const SAVE_INTERVAL_MS = 5000;

function toVec3(raw) {
  return raw ? new Vec3(raw.x, raw.y, raw.z) : null;
}

const EMPTY = {
  tablePos: null, furnacePos: null, smokerPos: null, blastPos: null, homePos: null, world: null,
};

function load() {
  try {
    const raw = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    return {
      tablePos: toVec3(raw.tablePos),
      furnacePos: toVec3(raw.furnacePos),
      smokerPos: toVec3(raw.smokerPos),
      blastPos: toVec3(raw.blastPos),
      homePos: toVec3(raw.homePos),
      world: raw.world ?? null,
    };
  } catch {
    return { ...EMPTY };
  }
}

const knownBase = load();

/**
 * Written whole or not at all.
 *
 * This was an async fs.writeFile, and shutdown calls it on the way out: the
 * file is truncated the moment the write opens it, and the process exited
 * before the bytes followed. known-base.json was found EMPTY (0 bytes) after
 * the 09-24 15:35 run's Ctrl+C — every station the bot had placed forgotten,
 * which is exactly what this file exists to prevent (see the top of this
 * module). Synchronous, because the file is a few hundred bytes and the
 * caller may be the last thing that runs; via a temporary file and a rename,
 * because a rename cannot leave half a file behind.
 */
/**
 * Windows refuses a rename onto a file someone else has open for a moment —
 * the indexer, an antivirus scan, an editor with it open — with EPERM or
 * EBUSY. Live on 09-25: "Failed to save base positions {EPERM: operation not
 * permitted, rename known-base.json.tmp -> known-base.json}", and the
 * station positions from that save were simply lost. The lock is always
 * brief, so wait a moment and try again; if it still will not go, writing the
 * file in place beats not writing it at all.
 */
const RENAME_ATTEMPTS = 5;
const RENAME_RETRY_MS = 40;

function pause(ms) {
  // Synchronous on purpose — see save(): the caller may be the last thing
  // that runs before the process exits.
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function save() {
  const tmp = `${FILE}.tmp`;
  const text = JSON.stringify(knownBase);
  try {
    fs.writeFileSync(tmp, text);
  } catch (err) {
    logger.warn('Failed to save base positions', { error: err.message });
    return;
  }
  let lastErr = null;
  for (let attempt = 0; attempt < RENAME_ATTEMPTS; attempt++) {
    try {
      fs.renameSync(tmp, FILE);
      return;
    } catch (err) {
      lastErr = err;
      if (err.code !== 'EPERM' && err.code !== 'EBUSY' && err.code !== 'EACCES') break;
      pause(RENAME_RETRY_MS);
    }
  }
  try {
    fs.writeFileSync(FILE, text);
    try { fs.unlinkSync(tmp); } catch { /* left behind; overwritten next save */ }
  } catch (err) {
    logger.warn('Failed to save base positions', { error: err.message, renameError: lastErr?.message });
  }
}

let timer = null;
function startAutosave() {
  if (timer) return;
  timer = setInterval(save, SAVE_INTERVAL_MS);
  if (timer.unref) timer.unref();
}

/**
 * Which world these remembered positions belong to.
 *
 * known-base.json survives process restarts by design, which means it also
 * survives the player making a brand new world — and then the bot starts life
 * believing it owns a crafting table at coordinates that are now open ocean.
 * It walks there, fails, disowns it, and walks back: a fresh world was
 * measurably slower to get going than one the bot already knew, which is
 * exactly backwards.
 *
 * The signature is the host plus the world's spawn point. Port is
 * deliberately excluded: a LAN world picks a new one every time it is opened,
 * so including it would wipe the memory on every single restart — while the
 * spawn point is fixed per world and differs between worlds, which is
 * precisely the distinction we want.
 */
function worldSignature(bot, host) {
  const spawn = bot.spawnPoint;
  if (!spawn) return null;
  return `${host}|${Math.round(spawn.x)},${Math.round(spawn.y)},${Math.round(spawn.z)}`;
}

/**
 * Forget everything if we've been moved to a different world.
 *
 * SAFE UNTIL PROVEN OTHERWISE. Until the signature is known, the remembered
 * base is treated as belonging to somewhere else and is not acted on — the
 * old code returned early and left it fully live, which is the exact
 * carry-over this is meant to prevent: `bot.spawnPoint` comes from a packet
 * that usually lands before the spawn event and is not guaranteed to, so a
 * slow login would have the bot walk confidently off toward a crafting table
 * in a world it is no longer in.
 *
 * Returns true once a signature has actually been established, so the caller
 * can retry until it has.
 */
function adoptWorld(bot, host) {
  const signature = worldSignature(bot, host);
  if (!signature) return false;

  // The richer per-world notebook (depth reached, ore seen but not yet
  // minable, deaths, structures) shares this signature — see src/memory.js.
  const remembered = memory.adopt(signature);
  if (remembered && remembered.sessions > 1) {
    logger.info('I have been in this world before — picking up where I left off', remembered);
  }

  if (knownBase.world === signature) return true; // known world, nothing to clear

  const hadMemory = !!(knownBase.tablePos || knownBase.furnacePos);
  Object.assign(knownBase, EMPTY, { world: signature });
  save();

  if (hadMemory) {
    logger.info('New world — forgetting the old base', { world: signature });
  }
  return true;
}

/**
 * Wipe the remembered base outright.
 *
 * For the case where the world could not be identified at all: notes we
 * cannot attribute to a world are worse than no notes, because the bot acts
 * on them with full confidence. Starting clean costs one crafting table.
 */
function forgetEverything() {
  Object.assign(knownBase, EMPTY);
  save();
}

function remember(key, position) {
  knownBase[key] = position.clone ? position.clone() : position;
  save();
}

function forget(key) {
  knownBase[key] = null;
  save();
}

module.exports = {
  FILE, knownBase, save, startAutosave, remember, forget, adoptWorld, forgetEverything,
};
