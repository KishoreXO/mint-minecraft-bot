// quiet: dotenv 17 prints an advert on every start otherwise.
require('dotenv').config({ quiet: true });

function required(name, fallback) {
  const value = process.env[name] ?? fallback;
  if (value === undefined) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

module.exports = {
  mc: {
    host: required('MC_HOST', 'localhost'),
    port: Number(required('MC_PORT', '25565')),
    /**
     * The bot's name in the world. Change it with BOT_NAME in .env; nothing
     * else in the code names the bot. Under microsoft auth the login is
     * MC_EMAIL instead, and the name is whatever that account is called.
     */
    username: (process.env.MC_AUTH || 'offline').toLowerCase() === 'microsoft'
      ? required('MC_EMAIL')
      : required('BOT_NAME', 'Mint'),
    version: process.env.MC_VERSION || false, // false = auto-detect
    /**
     * How to authenticate.
     *
     * 'offline' is right for a LAN world or a cracked server and is what this
     * bot has always assumed — but it is refused outright by any online-mode
     * server, which is every public one. 'microsoft' opens a device-code
     * login: the console prints a short code and a URL, you approve it once
     * in a browser, and the token is cached in `authCache` so restarts never
     * ask again.
     *
     * Under microsoft auth MC_EMAIL is the account to sign in with; under
     * offline BOT_NAME is simply the name the bot joins as.
     */
    auth: (process.env.MC_AUTH || 'offline').toLowerCase(),
    /**
     * Servers are slower than a LAN world in every way that matters: chunks
     * arrive late, keep-alives round-trip over the internet, and a busy
     * server can stall for several seconds. mineflayer's 30s default drops
     * the connection over hiccups a real client rides out.
     */
    connectTimeoutMs: Number(process.env.MC_CONNECT_TIMEOUT_MS || 60000),
    // Requesting fewer chunks makes joining a populated server dramatically
    // faster and cuts the synchronous cost of every findBlocks call.
    viewDistance: process.env.MC_VIEW_DISTANCE || 'normal',
  },
  typesafe: {
    apiKey: process.env.TYPESAFE_API_KEY,
    // Generous enough that calls usually succeed — observed latencies range
    // from ~450ms to several seconds, and a 1.2s ceiling was timing out most
    // combat calls, which meant Jev was barely being consulted at all.
    timeoutMs: Number(process.env.TYPESAFE_TIMEOUT_MS || 4000),
    // But nothing in the bot ever WAITS this long. Every call site races the
    // request against a deadline and acts on a hardcoded instinct if it
    // isn't answered; the request still finishes in the background and
    // populates the cache, so the answer is used — just for the next
    // decision rather than this one.
    // Measured Jev latency in practice: mostly 0.6–3.6s, occasionally ~310ms.
    // Waiting longer than this almost never pays off — it just adds delay
    // before the swing — so the budget is set just above the fast responses.
    combatDeadlineMs: Number(process.env.TYPESAFE_COMBAT_DEADLINE_MS || 300),
    // When something is already in swinging range, deliberating at all is
    // the wrong move — react now, ask afterwards. This is the distance at
    // which combat stops waiting for Jev entirely.
    reflexRangeBlocks: Number(process.env.TYPESAFE_REFLEX_RANGE || 5),
    // Mining is not life-or-death, but "stand still staring at iron ore for
    // four seconds" is exactly what made the bot feel slow. Short deadline,
    // deterministic fallback.
    resourceDeadlineMs: Number(process.env.TYPESAFE_RESOURCE_DEADLINE_MS || 400),
    // Below this an answer is a coin flip and instinct decides instead. One
    // floor for every kind of question — strategy has always had it.
    minConfidence: 0.35,
    // How often a threat answer is refreshed in the background, and how long
    // an answer takes to come back near the top of its range (threat p90 is
    // ~0.8 s). An answer lives for the sum, so a fresh one always lands
    // before the old one expires.
    threatRefreshMs: 2000,
    answerLatencyAllowanceMs: 1000,
  },
  /**
   * Capabilities that a human player would need a modified client for.
   *
   * Both of these are honest about what they actually do for a HEADLESS bot,
   * which is not the same as what they do for a person:
   *
   *  - fullBright: the equivalent of the fullbright mod or a bright texture
   *    pack, for something with no screen.
   *
   *    What that mod actually buys a human is the ability to see blocks and
   *    mobs in unlit caves. This bot already has that unconditionally and
   *    always has: bot.blockAt reads chunk data directly, and bot.entities
   *    tracks every entity the server sends, and neither consults the light
   *    level at any point. Darkness costs it literally nothing in perception
   *    — it can "see" a zombie at light level 0 exactly as well as one at
   *    noon.
   *
   *    So this switch is not about vision, because vision was never the
   *    problem. It is about everything the bot used to do BECAUSE it assumed
   *    it needed light: demanding torches before a descent, going prospecting
   *    for coal to make them, and stopping to place them. With it on, all of
   *    that is off — torches gate nothing and are never placed — which is
   *    what "use fullbright rather than torches" means for a headless client.
   *
   *    The one real thing torches do is suppress mob spawns, and that is
   *    handled instead by not being on the surface at night and by sealing
   *    tunnels behind us.
   *
   *  - xray: the bot ALREADY sees through walls — bot.findBlocks() reads the
   *    world's block data directly, with no line-of-sight check, so ore
   *    inside solid rock is as visible to it as ore on the surface. The only
   *    honest question is whether it's allowed to ACT on that. Off (the
   *    default) it may only mine ore it could legitimately see: exposed
   *    faces, and whatever its own tunnels reveal. On, it beelines to buried
   *    ore through solid stone, which is dramatically faster and is
   *    unambiguously cheating.
   */
  cheats: {
    fullBright: process.env.ENABLE_FULLBRIGHT !== 'false', // default ON
    xray: process.env.ENABLE_XRAY === 'true', // default OFF
    xrayRadius: Number(process.env.XRAY_RADIUS || 64),
  },

  behavior: {
    // How close a hostile has to be before we ask Jev about it.
    mobDetectionRange: 14,
    // Preferred retreat distance; nav falls back to shorter hops if the
    // pathfinder can't work out a route that far.
    fleeDistance: 12,
  },
  logging: {
    // Periodic one-line snapshot of what the bot is doing, so there's
    // something readable in the console even when nothing notable happens.
    statusIntervalMs: Number(process.env.STATUS_INTERVAL_MS || 15000),
  },
  /**
   * The web dashboard — see src/dashboard.js. Always on and always bound to
   * 127.0.0.1: it is read-only and for this computer. MC_DASHBOARD_PORT=0 turns
   * it off; MC_VIEWER=off keeps the page but drops the 3D view, which is the
   * heavy part (it sends the browser every chunk the bot can see).
   *
   * Four chunks, not six: measured on this 8 GB laptop, closing a tab showing
   * six took free memory from 829 MB to 1203 MB, and with it open the bot
   * logged "freeMemMb: 62" and a 16.7 s freeze just before an enderman killed
   * it mid-pillar. Four is 81 columns instead of 169.
   */
  dashboard: {
    port: Number(process.env.MC_DASHBOARD_PORT ?? 3000),
    viewer: (process.env.MC_VIEWER || 'on').toLowerCase() !== 'off',
    viewDistance: Number(process.env.MC_VIEWER_DISTANCE || 4),
    // The pixel ratio the 3D view draws at. 1 is sharp enough for a panel this
    // size and, on a scaled laptop screen, a half to a third of the pixels the
    // browser would otherwise draw every frame. 0 means the screen's own.
    pixelRatio: Number(process.env.MC_VIEWER_PIXEL_RATIO ?? 1),
  },
};
