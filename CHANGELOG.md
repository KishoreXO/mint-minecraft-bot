# Changelog

## 1.0.0 (2026-09-28): first public release

### The bot
- Plays survival from empty hands toward a full diamond kit, in eight phases: Wood, Stone tools,
  Food, Ready to dig, Iron, Iron kit, Diamonds, Diamond kit.
- 28 behaviors under one priority scheduler, plus a reflex layer that runs every game tick.
- Combat with tactics for each mob type. It never melees creepers and never takes on bosses.
- Sleeps in a bed or shelters at night; eats and cooks; escapes lava; walks back for its items
  after a death.
- Swimming built on measured game physics:
  - routes to the surface, to air and to shore;
  - climbs only banks it can actually climb;
  - builds its way out of flooded ravines;
  - remembers water traps.
- Finding food:
  - keeps one heading into new ground instead of wandering in circles;
  - remembers hunted-out areas;
  - picks ripe crops, berries and melons;
  - eats rotten flesh only as a last resort instead of starving.
- The bot's name is one setting, `BOT_NAME`, default **Mint**.

### Dashboard
- Live 3D view, status, phases with a supplies checklist, the scheduler's board, Jev decisions, a
  decision stream, a death replay, a radar, the backpack and run history.
- The 3D view is faster:
  - it draws at a capped pixel ratio (`MC_VIEWER_PIXEL_RATIO`);
  - it runs in its own browser process, so the rest of the page no longer slows it down;
  - it shows its frame rate.
- Pauses itself when the tab is hidden; dims and says so when the bot stops sending data.

### Fixes in this release
- `npm test` could stop part-way: a helper crashed after the mining suite had passed. It now runs
  every suite and fails any suite that exits early.
- A craft whose ingredients were used up, but whose result reached the bag late, was counted as a
  failure and repeated.
- After a route to a valuable ore fails, the bot stops chasing new ore sightings for two minutes.
  Before, it spent 20 seconds on each of up to five unreachable veins in a row.
- The "re-entered water" log signal counted every step through shallow water. It now counts only
  real escapes.
- `npm audit` reports no vulnerabilities (`uuid` is pinned to a fixed version).

### Known issues
- Deaths still happen, mostly to skeletons' arrows and to melee at night.
- On a laptop with little free memory the bot can freeze for a moment. The logs mark these freezes
  as "not our code". Turning the 3D view off helps.
- Tested on Minecraft 1.21.9 only.
