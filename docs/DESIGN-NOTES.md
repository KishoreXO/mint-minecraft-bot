# Design notes

How the bot is put together, why, and the bugs that shaped it. For a plain description of what it does, see [BOT-GUIDE.txt](../BOT-GUIDE.txt).

The bug list is a development history: each entry describes the code as it was when the bug was found, so some mention names that have since changed (for example `escapeWater`, now `escapeDrowning` and `leaveWater`).

## Architecture

### Why a typed-decision model instead of an LLM

Nearly everything a Minecraft bot does is deterministic: path to a tree, craft a pickaxe, open a furnace. That's plain code — no "intelligence" required, and no reason to pay latency for it.

What *isn't* deterministic is judgement: *"a zombie is 8 blocks away, I'm on 9 HP with a wooden sword and no armour — fight, flee, or ignore?"* or *"there's iron ore here and I already have 12 ingots — worth the detour?"*

An LLM could answer those, but it's the wrong instrument: seconds of latency and free-text output to parse, for a question asked dozens of times a minute that only ever has a few valid answers. Jev takes a structured state plus typed questions (`choice` / `score` / `noul`) and returns a decision with a confidence value in milliseconds, with nothing to parse.

So: **hardcode everything deterministic; call the fast typed model only at the handful of genuine judgement points.** Jev is consulted in three places — `behaviors/threat.js` (fight/flee/ignore), `behaviors/mine.js` (mine/skip) and a strategy question (which need to focus on). Everything else is ordinary code.

### The director: one owner of the body

The single most important structural decision. An earlier design had six independent async loops (woodcutting, combat, mining, survival, death-recovery, water-escape) all calling `bot.pathfinder.goto()` whenever they liked, coordinated by a few shared booleans. Because every flag check was separated from its action by an `await`, two loops routinely both believed they held control — producing constant `goal was changed before it could be completed` errors and visibly jittery movement.

Now there is **one scheduler and one active behavior at a time**:

```
              ┌─────────────────────────────┐
              │         director.js          │
              │  picks ONE behavior by       │
              │  priority, runs it, repeats  │
              └──────────────┬──────────────┘
                             │ owns the body
   ┌─────────────────────────┼─────────────────────────┐
   ▼                         ▼                         ▼
supervisor (250ms)      behavior.run(task)        nav.js
 cheap urgent checks     one unit of work         the ONLY caller of
 → aborts current task   → returns, re-picks      pathfinder.goto()
```

- Each behavior does **one discrete unit of work** (chop one log, craft one item, resolve one fight) then returns, so priorities are re-evaluated constantly.
- A fast supervisor watches only *cheap, urgent* conditions (drowning, being attacked, starving) and preempts the running behavior via a cancellation token. Expensive checks (scanning for ore) belong to low-priority behaviors that never need to preempt anything.
- All movement goes through `nav.js`, which guarantees one active goal, cancels in-flight paths on abort, and **always clears control states afterwards** (a stuck `forward`/`sprint` key was a real cause of the bot appearing to fly around).

### Behavior priorities

The full, current list of behaviors and their priorities is in [BOT-GUIDE.txt](../BOT-GUIDE.txt), section 4.

### Borrowed, not hand-rolled

Four problems turned out to be better solved by maintained ecosystem plugins than by this repo's own code, each of which had been getting them subtly wrong:

| Plugin | Replaces | What our version got wrong |
|---|---|---|
| `@nxg-org/mineflayer-custom-pvp` | hand-written swing loop, and `mineflayer-pvp` before it | Flat swing timers, instant head-snapping, no real crits, and — crucially — all movement driven through pathfinder |
| `mineflayer-bloodhound` | guessing the attacker as "nearest player within 6 blocks" | Wrong whenever a mob was the one hitting us, or a player merely stood nearby; all retargeting was built on it |
| `mineflayer-tool` | block → tool guessing by name regex | Didn't know the real harvest tables or enchantment effects |
| `mineflayer-armor-manager` | nothing — armour was only worn when crafted | Picked-up armour was never equipped |
| `mineflayer-auto-eat` | the `eat` behavior | Competed with combat for priority, so the bot starved during long fights |

`mineflayer-pvp` was tried first and replaced. It drives **all** its movement through pathfinder, which is fatal for how the bot looks (see the `fullStop` note below). `custom-pvp` uses pathfinder only for the distant approach and switches to manual control states inside melee range — the same thing a player does — and adds real jump-criticals, w-tap knockback, intelligent strafing and smooth "legit" rotation.

What is *not* delegated is judgement: which mob to fight, when to break off, creeper spacing, strafing, and retargeting all stay in `tactics.js` / `behaviors/threat.js`, because pvp has no opinion about any of them.

Adopting plugins is not free, either — `mineflayer-pvp` quietly reintroduced the `fullStop()` position-snapping this project had spent a long time eliminating, because it calls `pathfinder.stop()` internally on every kill. Both that and its movement-profile leak are patched in `bot.js`; see the bug list below.

### Where Jev is (and isn't) used

Three kinds of call, all genuine judgement calls:

- **fight / flee / ignore** (`threat`) — given health, hunger, weapon, armour, how many hostiles are nearby, whether the threat can actually be outrun, and whether it attacks at range.
- **mine / skip** on **ores** (`mine`) — "is this detour worth it given what I already have?"
- **strategy** — which need to focus on right now; a confident answer boosts the matching behaviors for 30 seconds.

Notably, plain stone is *not* routed through Jev. "I need 8 cobblestone for a furnace" is arithmetic, not judgement — sending the single most common block in the game to a model, repeatedly, would cost API calls and buy no decision value. That's `gatherStone`, and it's deterministic.

### Ask before you need the answer

This is the most important design decision in the project, and it took a long time to arrive at.

Jev is a *fast* typed model, but "fast" measured against this workload means **761ms on average, 302ms at best, 4.8s at worst** (191 calls, live). A reflex decision has to happen in tens of milliseconds. So every call site raced the model against a short deadline and fell back to a hardcoded instinct — and Jev lost that race almost every time. The model was barely deciding anything; instinct was running the bot. That is a fairly damning thing to discover about a project whose premise is "use a fast typed model for reflex decisions".

The insight is that **latency only matters if you start the call at the moment you need the answer.** A mob is visible for several seconds before it's close enough to fight. An ore vein is on screen long before the bot reaches it. So `src/prefetch.js` continuously warms the same caches the decision paths already read:

- every hostile inside detection range gets a fight/flee verdict computed while it's still walking over
- every ore *type* in scan range gets a mine/skip verdict before the bot arrives
- results are deduped, refreshed on a timer, and capped at 6 requests in flight

By the time the bot actually has to choose, the answer is usually already sitting there, and it's used with **zero delay**. Measured after this change: `jev 3/3` — every combat decision in the session made by the model, none by the fallback.

The cost is API calls for decisions that never get made. That is the right trade: the calls are cheap, and standing still is not.

The status line reports `jev <decided-by-model>/<total>` so this is a number you can watch rather than a claim.

### Nothing ever blocks on the model

This is the part that makes a fast typed model usable for reflexes at all, and it's worth being precise about because it's a real design trade-off.

Every Jev call site races the request against a deadline. If the answer arrives in time, it's used. If it doesn't, the bot acts on a **hardcoded instinct** — and the request still completes in the background and populates a short-lived cache, so the model's answer is used for the *next* decision instead of being thrown away.

| Call site | Wait | Fallback |
|---|---|---|
| Threat, target further than 5 blocks | 300ms | `instinctiveDecision()` — flee only what we can outrun, otherwise fight |
| Threat, target within 5 blocks or we just took damage | **0ms** | Same, immediately |
| Threat, target within 4.5 blocks and we're armed or cornered | **not called at all** | Straight to the swing |
| Ore mine/skip | 400ms | `instinctiveOreVerdict()` — stock targets per resource, plus a distance cap |

The zero-wait case matters most. The bot was dying mid-question: something walked into swinging range, the bot paused to consider whether to fight it, and took free hits during its own deliberation. At arm's length there is nothing to deliberate about — react now, let the model inform the next encounter. That is what "System One" should mean in practice.

The third row goes further and skips the request entirely. Even at a zero-millisecond wait, the old path still built a full threat-state object (which scans every entity in the world to count hostiles), opened a network request and wrote a decision log line — all before the first swing. When something is already swinging at us and instinct would say "fight" anyway, that work is pure latency.

Measured budgets, from the live logs: Jev's threat calls came back in 0.6–3.6s, occasionally ~310ms. The deadline sits just above the fast responses, because waiting longer almost never changes the answer — it only delays the swing. Every `Engaging` log line now carries a `reactionMs`, so this is measurable rather than a matter of opinion.

### Combat tactics

Jev decides *whether* to fight. Once it says fight, the combat plugin (`@nxg-org/mineflayer-custom-pvp`) handles the swinging (cooldown timing, crits, reach) and this repo handles the positioning and judgement:

- **Zombies/husks/drowned** — pillars two blocks up, out of melee reach, then hits down. (Deliberately *not* used against spiders, which climb, or endermen, which teleport.)
- **Creepers** — strike and immediately retreat out of blast range rather than standing adjacent. Left to itself pvp will stand and trade with a creeper, which is fatal.
- **Skeletons/strays/pillagers** — *with* a bow: real line-of-sight cover via `bot.world.raycast`, peeking out only to shoot. *Without* a bow: closes distance fast and brawls, because backing away from an archer just donates free arrows.
- **Everything else** — melee at the **outer edge of our reach**. A player's entity reach is 3.0 blocks; a zombie's is about 2.2 and a spider's about 2.0, so hovering at ~2.6–3.0 lands hits from outside what most hostiles can answer. It's a preference rather than a rule — the engine still closes and trades when the target corners it or the terrain leaves no room.
- **Retargeting mid-fight** — a creeper within 6 blocks, or anything that starts hitting us, takes over from whatever we were swinging at. Locking onto the first target is how a winning fight becomes a crater.
- **Chase leash** of 18 blocks from where the fight started, so it stops following a fleeing player across the map.
- **Unreachable targets** are remembered for 20s rather than re-engaged forever.
- **On taking a hit**, steering pauses briefly so the server's knockback actually moves the bot instead of being cancelled by its own pathing.

#### The bot is defensive, not aggressive

`threat` outranks all productive work, so every mob the bot decides to "deal with" is time not spent gathering, crafting or descending. An earlier rule reacted to anything it couldn't outrun at any distance up to 14 blocks — and skeletons, spiders, witches and withers are all un-outrunnable, so at night that meant reacting to everything on screen, forever. The bot fought constantly, progressed not at all, and died.

The bar is now: **it hurt us, or it is genuinely on top of us (≤6 blocks)**. Everything else is scenery. Walking away while doing useful work is almost always the better play, and it doubles as the escape.

Measured effect, in a spot with 13–16 hostiles in range continuously: **zero combat engagements, zero damage taken, full health throughout**, while chopping wood, collecting drops and crafting. The previous build in the same spot spent 100% of its time in `threat` at low health and made no progress at all.

Two absolute rules sit on top:

- **Bosses are never targets.** Not at any range, not even when they attack us. A wither kills this bot every time, so the only correct response is to leave. It is excluded from target selection, from retargeting, from the reflex path, and from the flee-escalation that turns "can't escape" into "turn and fight" — that last hole is what had it punching a wither bare-fisted.
- **Creepers are never meleed.** Hit-and-run looked sensible and was unworkable: the engine only swings inside 3 blocks and the safe distance is 5, so the bot backed off before it could ever land a hit, then danced at arm's length until the fuse finished. Creepers are worth nothing to a speedrun and a sprinting player outruns one comfortably. So it walks away, every time.

#### Fleeing is a last resort, not a default

The bot used to flee almost everything and die doing it. Running away only works against something slower than you that can't shoot: a sprinting player does 5.6 blocks/s, a zombie ~4.6, a spider ~6.0, and a skeleton doesn't need to catch you at all. `canOutrun()` in `entities.js` encodes which mobs are genuinely escapable; against everything else the bot now turns and fights rather than being shot in the back, and the same fact is passed to Jev as `can_outrun_it` so it stops being asked to choose an impossible option.

#### Mining where the ore actually is

The 1.18 world generation replaced uniform ore spread with triangular distributions that peak at specific depths, so mining at the wrong Y is the biggest time-waster available to a bot — you can strip-mine at y=40 for an hour and see one diamond, because there essentially aren't any up there. `goDeep` digs a staircase to the right band for whatever the bot currently needs:

| Resource | Best Y | Worth being between |
|---|---|---|
| Diamond / redstone | −59 | −64 … 14 |
| Gold | −16 | −64 … 32 |
| Lapis | 0 | −32 … 32 |
| Iron | 16 | −24 … 56 |
| Copper | 48 | −16 … 112 |
| Coal | 96 | 0 … 190 |

It only ever digs *down* to a band, and it won't go looking for diamond before there's an iron pickaxe to mine it with, since diamond mined with stone drops nothing.

#### Sleeping through the night

`bed` is the real answer to the night problem and is strictly better than burrowing: sleeping doesn't survive the night, it *skips* it — eight in-game hours of spawns, fleeing and lost progress collapse into about five seconds. It also resets the spawn point, so death-loot walks get shorter rather than longer as the bot ranges further out. Wool comes from the sheep `hunt` already kills for food, so the cost is usually zero.

#### Don't take the fight you can't win

At night an unarmed bot is surrounded — observed live with fourteen hostiles inside detection range — and `threat` sits at priority 90, so it monopolises the scheduler. The bot spent entire nights doing nothing but fight and flee: it never gathered wood, so it never crafted the sword that would have let it stop running, so the next night went the same way. Adjusting priorities just changes which half of the deadlock wins.

Two things break it. First, distant slower mobs are treated as scenery (`BOTHER_RANGE`) — walking to a tree already moves away from a zombie 13 blocks off, and that *is* the escape. Second, `shelter`: when it's night, the bot is swarmed and it has nothing better than a wooden sword, it digs down two, seals the roof and waits for sunrise — the first thing any Minecraft player learns. It deliberately won't burrow with something already adjacent, because sealing a creeper in with you is worse than being outside.

#### Weapon discipline

Fists do 1 damage against a zombie's 20 HP. The bot **prefers** to wait for a weapon rather than punch things — `hunt` won't attack animals bare-fisted unless actually starving, and `gear` prioritises a sword before other tools. It is a preference, not a hard block: if something is already on top of it and it has nothing, punching beats being eaten.

## Capabilities (fullbright and x-ray)

Both are off-by-default-ish switches in `.env`, and both deserve an honest description because what they mean for a *headless bot* is not what they mean for a person at a screen.

**`ENABLE_FULLBRIGHT`** (default **on**). A bot has no screen, so there is nothing to brighten — as a rendering feature this is a no-op and pretending otherwise would be nonsense. What darkness genuinely costs the bot is **torches**, and torches cost coal, sticks and a trip back to a crafting table. With this on, the bot stops treating "a stack of torches" as a prerequisite for going underground (2 instead of 8). It still places torches when it has them, because their real job is stopping mobs spawning in the tunnel behind it, not vision.

**`ENABLE_XRAY`** (default **off** — this one is genuinely cheating). The bot **already** sees through walls and always has: `bot.findBlocks()` reads the world's block data directly with no line-of-sight check, so ore buried in solid rock is exactly as visible to it as ore on the surface. The only honest question is whether it's allowed to *act* on that:

| | Behaviour |
|---|---|
| **off** | May only mine ore it could legitimately see — exposed faces, plus whatever its own strip mining reveals. Slower, and how a player actually plays. |
| **on** | Beelines through solid stone straight to buried ore, at up to `XRAY_RADIUS` blocks. Dramatically faster, and unambiguously an x-ray cheat. |

X-ray does **not** weaken any safety check. It only widens the ore search and permits acting on buried ore; every block still passes `safeToDig` (which refuses lava on any of six faces), every step still passes `stepTo` (which refuses lava and falls), and combat still preempts mining at priority 88. It makes the bot better at finding ore, not blind to what kills it.

Both can be flipped live from Minecraft chat (`xray on`, `fullbright off`, `cheats` to see the current state), because the difference they make is only visible over minutes of mining. The current setting is printed at startup so a run's results are never ambiguous.

## Bugs found and fixed

Worth recording, since several were invisible in logs and took real digging:

- **`entity.type === 'mob'` never matches on MC 1.19+.** That value is only set by the legacy `spawn_entity_living` packet, removed in 1.19. Modern mobs report `type: 'hostile'` / `'animal'`. The old detection code therefore **never saw a single mob** — so the bot never fought, never hunted, never got food, never got armour, and consequently fled every encounter it was asked about. Entity classification now matches on an explicit name list first and falls back to type/kind, so it works on old and new servers alike. Covered by `test/entities.test.js`.
- **The bot never ate.** It cooked food and then let it rot in the inventory. Minecraft only regenerates health above 18 hunger, so it lived permanently at low HP.
- **Tools were equipped before pathing, not before digging** — and `mineflayer-pathfinder` swaps tools itself to clear obstacles en route, so the actual dig used whatever pathfinder happened to leave in hand. This is the "mining stone bare-handed, chopping dirt with a sword" behaviour.
- **Six loops racing for one pathfinder** — see the director section above.
- **Furnace `update` listeners were never removed**, leaking one per smelt and letting stale listeners resolve later operations.
- **`bot.nearestEntity()` has no distance bound**, so the bot would march across the map after the first animal it heard about.
- **Pathfinder's `fullStop()` was the cause of both "no knockback" and "moves like a hacker".** Its internals do this:
  ```js
  bot.entity.velocity.x = 0            // server knockback lives here
  bot.entity.velocity.z = 0
  if (Math.abs(bot.entity.position.x - blockX) > 0.2) bot.entity.position.x = blockX  // teleport
  ```
  Its own comment reads *"Kind of cheaty, but the server will not tell the difference."* It fires on every goal completion, obstacle dig and block placement — so with pathfinder digging enabled the bot was snapping to block centres constantly (which is exactly what a speed hack looks like) and having its knockback erased. Fixed by disabling pathfinder digging entirely and doing all digging ourselves, which also fixed tool selection since pathfinder swaps tools to clear obstacles.
- **`bot.dig()` ignores cancellation.** Without `bot.stopDigging()` the bot finished chopping a whole tree while being attacked — aborts fired every 250ms for ~3.7s and did nothing.
- **The SDK's default retry policy turned one slow Jev call into 5.26s of standing still.** Retries are now off and no call site ever blocks — see [Nothing ever blocks on the model](#nothing-ever-blocks-on-the-model).
- **`GoalNear(pos, 0)` never completes** — demanding the exact coordinate is unreachable, so pathfinder re-plans forever. Pinned the bot in place for over a minute chasing one item drop.
- **Granite, diorite, andesite and tuff don't drop cobblestone.** They were in the "stone" list, so the bot mined hundreds of blocks while its stone counter never moved.
- **Death-loot recovery gave up after a single pathfinder timeout.** `goNear` has a 20s overall limit and a 6s stall detector, so *any* death site more than ~60 blocks away always threw `navigation timed out` — and the catch block then cleared the pending position, permanently abandoning the loot on the first try. Long returns now happen in 40-block legs, and only three consecutive legs with no movement count as failure. The trip is also budgeted against the 5-minute despawn clock before it starts, so the bot no longer walks three minutes to an empty field.
- **Item pickups were confirmed with a fixed 350ms wait.** Pickup is server-authoritative, so on a laggy tick items the bot *had* just collected were marked unreachable and skipped for the next 60 seconds. It now polls for the confirmation for up to 1.5s and returns the instant the entity disappears.
- **An unhandled socket error killed the whole process** whenever the LAN world was closed (repeated `ECONNREFUSED` AggregateErrors, exit code 4). That's the "keeps leaving and never comes back" symptom. Error listeners are now attached before anything can connect, network error codes are survivable at the process level, and mineflayer's own `console.log(err)` dump — 30 lines per failed attempt — is turned off in favour of one throttled line.
- **A behavior was deleted but left in `module.exports`**, so the module threw on require and the bot wouldn't start at all. `node --check` passes that happily; `test/modules.test.js` now loads every module and validates every behavior's shape.
- **`fullStop()` is a pathfinder bug, and no plugin swap fixes it.** This took three attempts to get right. Pathfinder calls `fullStop()` — which zeroes horizontal velocity (wiping server knockback) and *teleports* the bot to the block centre — from two places. One is `bot.pathfinder.stop()`, which every combat plugin calls to disengage. The other is the movement monitor itself, whenever a path runs out of nodes:
  ```js
  if (path.length === 0) {                       // done
    if (!dynamicGoal && stateGoal && ...) { ... } // dynamic only skips the EVENT
    fullStop()                                    // ...not this
    return
  }
  ```
  So marking a goal `dynamic` does **not** protect you: every time a chase path completed the bot teleported, which in melee — against a target that keeps stopping and starting — is constant. That is the "hacker movement, especially when pvping". It is fixed in two parts: `bot.pathfinder.stop` is redirected to `setGoal(null)` (which goes through `resetPath` and never reaches `fullStop`), and the combat engine's follow goal is configured *closer* than the range at which it hands over to manual control, so the path is always abandoned before it can empty.
- **Adopting `mineflayer-pvp` silently reintroduced `fullStop()`.** Its `stop()` calls `bot.pathfinder.stop()`, which sets `stopPathing = true`, and pathfinder's internal `stop()` then calls `fullStop()`. Worse, pvp calls it *itself*:
  ```js
  this.bot.on('entityGone', e => { if (e === this.target) this.stop(); });
  ```
  So the bot position-snapped and had its knockback velocity wiped at the end of **every single kill**, plus on every break-off and every creeper reposition — the exact bug that disabling pathfinder digging was meant to eliminate. Fixed by routing `bot.pvp.stop` through pvp's own `forceStop()`, which clears the target via `setGoal(null)` and never reaches `fullStop()`.
- **`pvp.attack()` swaps the movement profile and never swaps it back.** After the first fight of a session the bot was permanently stuck on the combat profile for everything else it did. The standard profile is now restored on disengage.
- **`gear` reported success after a failed craft.** `run()` returned `undefined`, and the director treats anything other than an explicit `false` as real work — so an unsatisfiable goal meant `gear` was picked, failed silently, reported success, and got picked again forever, starving every lower-priority behavior. Every branch now returns the craft result.
- **Hunting walked to the wrong place for the drops.** It recorded the animal's position *before* the chase, and a panicking cow covers a lot of ground — so the bot jogged back to an empty patch of grass and left the meat behind, every hunt. It now tracks the animal's last known position.
- **Hunting swung on a flat per-weapon timer** while combat used pvp's cooldown-aware solver, so the bot attacked a cow differently from a zombie. Both go through pvp now.
- **Loot recovery ran before the respawn.** Between the fatal hit and the respawn packet the bot still has a position — its own corpse's. So it looked at the death site, saw it was standing on it, declared the trip complete and cleared the pending position **one second after dying**, then came back to life elsewhere with the loot abandoned. Nothing is scheduled for a corpse now (`bot.health > 0`), and recovery waits for the respawn event.
- **`retreatFrom` normalised a 3D vector, so fleeing something above or below went nowhere.** With a mob in a cave underneath, the horizontal component of "away" is ~0, so the retreat target landed at the bot's own feet: `goNear` reported arrival instantly, `flee` reported success, and the director immediately re-ran `threat`. Observed live as four `Fleeing` lines inside one second with the position frozen to the decimal while a creeper closed in. The direction is flattened to horizontal first, and a retreat that doesn't actually move counts as failed.
- **Unreachable crafting tables deadlocked the whole tool progression.** `gear` asked for the table, got the remembered one, failed to path to it, and was handed the identical table next tick — 45 unbroken seconds of failure while the bot stood still and never crafted the sword it needed. Reachability is now the station module's job: `ensureTable`/`ensureFurnace` walk there themselves and disown a station they can't reach, so the bot just builds a new one (four planks). Fixing this was the difference between a bot that never armed itself and one that crafted a sword and pickaxe within two seconds of the table going down.
- **Trees had no failure blacklist**, so an unreachable one was re-selected forever — a steady stream of `navigation stalled` with no wood ever gathered, which starved the entire tool progression. Also, `findBlocks` returns the nearest log *block*, often mid-canopy where a non-digging pathfinder can't reach; the bot now aims at the trunk base.
- **The stuck-detector is position-based, which mis-fires on productive work** — mining a vein is nine ores from one spot, and it read as "hasn't moved in 25 seconds" and pillared the bot ten blocks out of its own mineshaft mid-dig. Fixed by crediting progress to a specific list of behaviors that legitimately work while stationary. Crediting *every* successful behavior (the first attempt) was worse: a walled-in bot with `explore` cheerfully reporting success reset the watch on every pass, so `unstick` could never fire at all.
- **`threat` counted as a stationary behavior**, which meant a bot sealed in a pocket — swinging at mobs it couldn't reach while they couldn't reach it — kept resetting the stuck-watch forever. Observed live: 90 unbroken seconds at one coordinate, health frozen, seven hostiles listed. Combat moves; a fight that hasn't moved in 25 seconds isn't one.
- **A failed Jev call cached its fallback as a real verdict.** One API timeout wrote `skip` into the ore cache and poisoned `coal_ore` for 25 seconds, so the bot walked away from a vein it was halfway through. Fallbacks are now treated as "no answer" so the hardcoded instinct decides instead — instinct knows what the bot is carrying, a blanket `skip` knows nothing.
- **The bot mined constantly and collected nothing, for an entire session.** This one resisted four wrong diagnoses, and the sequence is worth recording because each theory looked right until it was measured:
  1. *Wrong tool?* No — logged `held: wooden_pickaxe`.
  2. *Inventory full?* No — 28 free slots.
  3. *Creative mode?* No — logged `gameMode: survival`. (Blocks dropping nothing in creative would have produced identical symptoms, so this is now checked and warned about at spawn.)
  4. *Server rejecting the digs?* No — `digBlock` now re-reads the block after `bot.dig()` resolves and confirms it actually disappeared. Zero rejections. (Worth keeping regardless: `dig()` resolves on the *client's* break animation, not the server's agreement, so a rejected break was previously counted as work done.)

  The answer came from listening to `entitySpawn` and `playerCollect` directly: **8 drops spawned at 2.8–4.0 blocks, 0 collected, 0 taken by anyone else.** Digging reach is 4.5 blocks, and `goToBlock` treated "within 4.2" as arrived — so the bot mined at the very edge of its reach and the item landed several blocks away, routinely across terrain it could not then walk through, where it despawned. Gathering behaviors now pass a tighter `within` (~2.4) so the drop lands at the bot's feet. Pickups went from 0 to 18 in the first minute.

  Two related traps found on the way: `gatherStone` targeted the *nearest* stone, which on the surface is buried inside solid rock — mined through a wall, the cobblestone drops into a sealed pocket and is gone (`mine` had required ore to be `isExposed` for exactly this reason; `gatherStone` never did). And "exposed" alone isn't enough either, because the exposed face is often a **cave ceiling**: mine that and the drop falls into the cavern. Stone now also needs a solid block beneath it and to be within 3 blocks of the bot's own height.
- **`digStaircaseDown` counted attempts, not descent.** `depth` was the loop counter, so a run that turned twelve times without going down a single block returned `{ok: true, depth: 12}` and the caller believed it had worked. That pinned the bot at y=70 logging *"no exposed stone nearby, digging down"* every five seconds for minutes with its Y never changing. It now measures the actual height difference, and `gatherStone` treats a zero-descent result as the no-op it is.
- **A perfect waste loop between `threat` and `unstick`.** The bot engaged a skeleton it could not reach, stood there 25 seconds, `unstick` decided it was trapped and pillared it three blocks up, `gatherStone` immediately dug it back down, the 20-second unreachable hold expired, and it engaged the same skeleton again. Up, down, up, down, for minutes. Two fixes: the unreachable hold now **doubles** each time a target proves unreachable (30s → 5min cap), and `unstick` checks whether the bot is genuinely **confined** — if any of the eight surrounding positions is walkable, standing still is not the same as being trapped and climbing out is not the answer.
- **`shelter` was locked out of the situation it exists for.** It required a placeable block *before* digging — but digging two blocks down yields two blocks of dirt, which is exactly what sealing the roof needs. So a bot with nothing, at night, being killed repeatedly, could never use it. Removing that precondition made it fire immediately; sealing also now tries the ceiling's underside, because side-wall placements in a one-wide shaft were being refused.
- **The prefetcher asked the same question four times over.** Jev takes ~800ms and the warm tick is 500ms, and nothing suppressed a subject with a request already outstanding — the cache is only written when a response returns. Visible in the logs as the same `coal_ore` verdict arriving four times in one second. Now deduped by subject while in flight.
- **The bot stood there being shot by pillagers and never reacted.** Damage attribution only correlates *melee* swings — bloodhound caps at 6 blocks — so arrows and crossbow bolts are never traced back to their owner. A pillager at 12 blocks therefore failed every test in `worthReactingTo`: not identified as the attacker, too far for the proximity fallback, too far to be "on top of us". Anything that shoots, with a clear line to us, is now reacted to at any range it can hit from; line of sight keeps it honest, so one behind a wall stays scenery. Auditing the ranged list against minecraft-data then found **ghast, blaze, illusioner, breeze and shulker** missing too — every one an invisible "stands there and takes it" bug. A test now asserts the whole set.
- **Chasing max reach made it stop hitting things.** Raising `tooCloseRange` to 2.6 against an `attackRange` of 3 left a band 0.4 blocks wide, and the engine spent its time stepping in and out of that sliver instead of swinging. Reach abuse has to stay subtle: the band is wide again, and `onHitConfig`'s backoff still drifts the bot to the outer edge naturally.
- **Mined blocks whose drop was almost directly below were never collected.** Logging the before/after distances settled what four rounds of guessing had not: `{"sawItemEntity":true,"startedAt":2.0,"endedAt":2.0}` — the item was found, two blocks away, and the bot did not move at all. When a drop is nearly underfoot the horizontal direction to it is essentially undefined, so "hold forward" picks an arbitrary yaw and the distance never changes. Manual walking now falls back to pathfinder for the last couple of blocks, which can drop down a ledge or step around a lip. Also: Minecraft has no item attraction — the hitbox has to actually touch the item — so the "close enough, don't bother walking" threshold of 1.5 blocks was itself too far to collect from.
- **It chopped a log and walked off without it.** `stepOntoDrop` went to the *block's* position, but items fall — break a log six blocks up a tree and the drop lands on the ground below, not floating where the block was. It now goes to the actual item entity when one is nearby. The same mistake was in `collect`, whose vertical limit was symmetric: walking down to a drop is easy and extremely common, climbing up to one is not, so those limits are now asymmetric (8 down, 3 up).
- **Cooking at half speed is why raw meat kept getting eaten.** The bot's most constant shortage is food, and a plain furnace could not keep up with what hunting brought in — so it was permanently in the "nothing cooked left" state that permits raw meat. It now builds a **smoker** (a furnace plus 4 logs) which cooks food twice as fast, and a **blast furnace** for ore when the materials happen to be there. `ensureSmelter` picks the right one for the job and falls back to a plain furnace, so a missing smoker never blocks progress.
- **`startAt` is not an option, so the eating threshold was silently ignored.** mineflayer-auto-eat's setting is `minHunger`; its `setOpts` is a plain `Object.assign`, so an unknown key is accepted and quietly dropped. The plugin therefore ran on its default `minHunger: 15` throughout — below the 18 needed for regeneration — which is the *real* reason the bot could never heal. A wrong option name produces no error, no warning and no behaviour, so `test/eating.test.js` now asserts the key the plugin actually reads and that `startAt` is absent.
- **The bot stopped fighting back once it lost its sword.** Two separate causes. First, a player only counted as a target if `mineflayer-bloodhound` had positively identified them as the attacker — and bloodhound is explicitly best-effort ("at the mercy of latency"), so whenever correlation failed the bot ignored the person hitting it. Being damaged with a player within 5 blocks is now enough. Second, the "can't escape, so turn and fight" rule required a weapon — but being unarmed is a reason to *prefer* not to fight, not a reason to run from something faster than you. A pursuing player catches the bot either way; running just means taking the same hits while dealing none back.
- **The combat engine kept steering after the fight ended.** `swordpvp.update()` runs on every physics tick for as long as it holds a target, and in melee it drives the control states directly. `attack()` is async, so aborting a fight in the window between calling it and it resolving leaves `stop()` running first and the target set afterwards — with no behavior left to clear it. The engine then fights whatever behavior owns the bot for control: **sprint particles while standing still, knockback that never registers because movement is re-asserted every tick, and "high ping player" motion**. A 250ms watchdog now asserts the invariant that only a combat behavior may hold a pvp target.
- **The field of crafting tables.** `approachOrDisown` blacklisted a station after a *single* navigation failure — and `goToBlock` gives up after 20s, or 6s without progress, which happens routinely for a table 40 blocks away. Once blacklisted, the nearby-search skipped the perfectly good table standing right there, so the bot placed a new one beside it. Three strikes are now required, and a station within 8 blocks is always reused regardless of the blacklist, because a block you can see from where you stand is reachable by definition.
- **Behaviors stole the wheel from each other constantly.** Each does one small unit of work and returns, at which point the whole list is re-evaluated — so neighbours at adjacent priorities (gatherStone 28, light 29, tidy 30) flip-flopped, and from outside the bot looked like it was doing random things and abandoning them. The behavior that just did real work now gets a small priority bonus for 10 seconds. Preemption still compares *raw* priorities, so nothing urgent can be held off by a routine task.
- **The bot could not heal, and the cause was one constant.** Health only regenerates at food ≥ 18, but auto-eat was configured `startAt: 16` — "eat when food drops to 16 or below". At 17 food it therefore refused to eat, could never reach 18, and never regenerated. Observed live sitting at **6/20 health with 17/20 food** and cooked meat in the bag, with no way out of it. The threshold is now dynamic: eat above the regen line whenever there's damage to heal, conserve food when already at full health.
- **Tools broke mid-run and silently downgraded the bot.** A stone pickaxe lasts 131 blocks and this bot mines constantly; watched live, its pickaxe broke and it fell back to a **wooden** one, which cannot mine iron at all — quietly undoing the whole progression with no error anywhere. `gear` now treats a tool below 15% durability as if it weren't there, builds a backup pickaxe once the current one passes halfway (deliberately *not* "always carry two" — a spare diamond pickaxe costs three diamonds that belong in a chestplate), and `deepTripShortfall` refuses to start the descent on a nearly-dead pickaxe.
- **Nothing watched the air supply.** `escapeWater` only triggered after six motionless seconds, which is the right test for bobbing on a surface and far too slow for being *underwater* — oxygen runs 20→0 and then damages immediately. Low air now triggers instantly and surfaces first, worrying about the shore afterwards.
- **`come` un-paused a bot you had explicitly stopped.** It forced `paused = false` in its `finally` rather than restoring the previous state.
- **The bot ate its kills raw.** Cooking doubles a piece of meat — raw beef gives 3 hunger and 1.8 saturation, steak gives 8 and 12.8 — so eating it raw means hunting more than twice as often, and hunting is the most interruptible thing the bot does. `mineflayer-auto-eat` takes a *static* banned list, which can't express "not unless you're desperate", so `eating.js` swaps the list at runtime: raw meat is banned while anything cooked or vegetable remains, and unbanned only below 10 hunger with nothing better. Poison and golden apples stay banned at any hunger. `hunt` also stops killing animals once 3 raw pieces are waiting for the furnace.
- **`smelt` cooked whatever was in the lowest inventory slot.** `findItem` returns the first match, so the bot would smelt iron while carrying raw meat and no cooked food, then go hungry. Food now takes priority whenever there's nothing cooked to eat. Fuel is also chosen cheapest-first with coal LAST — coal is the only torch material, and burning it to cook three steaks while a stack of logs sits in the bag is a bad trade — and sized by `itemsPerFuel` rather than the old `ceil(batch / 2)`, which burned four coal on a job one coal covers.
- **A coal/torch deadlock that made diamond unreachable.** The deep trip requires 8 torches, but `neededResource` only went looking for coal at *zero* torches. With one torch in the bag, nothing ever sought coal, so it could never reach 8 and never descended again. `gear` also only recognised coal for torches, never charcoal — which the bot can smelt itself from logs. Both fixed, and `test/progression.test.js` now walks the whole empty-handed → full-diamond chain offline so this class of stall is caught without watching a bot for an hour.
- **`idle` was listed as a "stationary" behavior.** That was true when it turned on the spot; it now walks. Listing it meant a bot that fell back to `idle` and *failed* to move reset the stuck-watch on every attempt, so `unstick` could never fire — the exact trap the bot starved to death in.
- **`bot.equip`, `bot.placeBlock` and `bot.openFurnace` can all hang** the same way `bot.craft` does, waiting on a window packet that may never arrive. Equipping runs before every dig and every swing; placing is how the bot escapes a pit. All three now have deadlines, because a hang in a recovery path freezes the bot in exactly the situation it was trying to escape.
- **Pathfinder was routing the bot off four-block ledges.** Fall damage starts above three, so `maxDropDown: 4` meant taking a heart and a half repeatedly for no reason — a slow bleed that read as "why is it never at full health". Now 3. Cactus and sweet berry bushes are added to `blocksToAvoid` for the same reason.
- **`known-base.json` outlives the world it describes.** It's deliberately on disk so the bot doesn't forget a crafting table across reconnects — but it also survives the player creating a *new world*, after which the bot treks to phantom coordinates every time it wants to craft. `locate` now forgets a remembered station the moment its chunk is loaded and the block isn't there.
- **Targets were filtered in the wrong order.** `selectTarget` picked the highest-*scoring* candidate and only then asked whether it was worth reacting to — so a creeper 12 blocks away (high score, out of range) was selected, judged not worth reacting to, and the bot ignored the zombie hitting it at 3 blocks. Actionability is now checked before ranking.
- **`bot.craft()` hangs for twenty seconds.** Observed live: `Event updateSlot:0 did not fire within timeout of 20000ms`. Its internal wait for an inventory-update packet is 20s, and when the window desyncs the bot simply stands there for all of it — the single largest source of visible AFK. Crafting is now cut off after 4s and retried.
- **Smelting was a 90-second vigil.** The furnace burns whether the bot watches it or not, so standing there was pure dead time. It now loads the furnace, waits 5s, and leaves; a later run collects (the resume path already handled a part-loaded furnace).
- **The `idle` fallback could be backed off.** The no-op backoff disables a behavior that keeps achieving nothing — which is right for real work and catastrophic for the guaranteed fallback: with `idle` penalised alongside everything else, `pickBehavior` returns null and the bot genuinely stands still. The fallback is now exempt, always reports success, and a watchdog warns if nothing wants to run for 5 seconds.
- **Ore above the bot caused a visible up-down loop.** `mine` would spot iron a few blocks up, climb to tunnel at it, which put it above the target so it dug down again — repeatedly, before finally mining anything. Ore more than 2 blocks above is now skipped: tunnelling upward is the slowest way to reach a block and the drop falls back down the shaft behind you.
- **Every manual step moved blind.** Staircases, tunnels, strip mining and pit escapes all drive the controls directly, so pathfinder's drop limits don't apply — nothing was stopping the bot walking into lava or off a ledge. All of them now go through `stepTo`, which refuses lava at foot, head or floor level and anything that isn't solid ground within a survivable drop. Seven tests cover it.
- **Preemption counted as progress, which deadlocked the stuck-detector.** After 25 motionless seconds the supervisor aborts the running behavior in favour of `unstick`. That abort is (correctly) not treated as the behavior's failure — but crediting it as *work* reset the stuck-watch, so `unstick.shouldRun` immediately went false again and the very same behavior was re-picked. Live, the bot spent minutes at one coordinate restarting the same tunnel while `unstick` preempted it over and over and never once got to run. Interruptions no longer reset the watch.
- **`tunnelToward` asked pathfinder to take a single step.** Same failure as the staircase: `goNear()` routinely refuses a one-block move into a freshly dug tunnel, so the bot dug, didn't move, found those blocks already air next time, dug nothing, and repeated. It now steps in manually and gives up on a route that produces neither a dig nor any movement.
- **The `idle` fallback genuinely idled.** It turned on the spot and slept for a second or two — and on one occasion the bot starved to death doing exactly that. The fallback now walks somewhere new, which is also the only thing that fixes an empty schedule: every gathering behavior depends on a 32–48 block scan window, so moving is what puts work back into range.
- **Nothing was responsible for being hungry with no food.** `huntUrgent` can only act on an animal already within 24 blocks; with an empty larder and nothing in sight, no behavior owned the problem and hunger simply ticked down to zero. The new `forage` behavior outranks tools and crafting — a pickaxe is no use to a corpse — and travels to find animals, searching new ground when none are visible.
- **`unstick` had a dead end: "out of blocks to pillar with".** The bot's own mining leaves it in pits, and pillaring needs blocks it doesn't always have. It now cuts a staircase upward instead, which can't run out of materials because a pickaxe is the one thing it always carries.
- **`mineflayer-tool` will happily equip nothing at all.** It adds `undefined` to its candidate list whenever the bot has a free inventory slot and can then `unequip('hand')` — i.e. choose fists — and its `isBetterMiningTool` check skips equipping entirely whenever the held item ties on dig time. Result: the bot punched stone while carrying a pickaxe, and stone mined by hand **drops nothing**, so those swings were pure waste. Rather than fight the plugin, `equipForBlock` now verifies the postcondition — if the block wants a pickaxe and we aren't holding one, equip ours.
- **Charging a wither bare-fisted.** "Can't outrun it, so fight it" is right for a spider and suicide against a boss. The bot died twice in under two seconds doing exactly this. `isBoss()` now forces flee for wither/warden/ender_dragon/elder_guardian/ravager/evoker unless we're in full armour, and it's excluded from the reflex-attack path.
- **`mineflayer-bloodhound` is an old-style factory plugin** — `require(...)` returns a function that takes `mineflayer` and *returns* the injector. Passing the module straight to `loadPlugin` silently does nothing, and `bot.bloodhound` is simply never defined. Caught only because the startup check lists missing plugins by name.
- **`tidy` threw away the escape kit.** It drops all dirt as junk, but `unstick` pillars out of holes with it and `shelter` seals a roof with it — so tidying left the bot with no way out of the next hole it dug. It now keeps a working stack of anything placeable.
- **Referencing an unimported identifier passes both `node --check` and module loading.** `mine.js` called `hasItem()` without importing it, on a path hit every scheduler tick. `test/modules.test.js` now calls every behavior's `shouldRun`/`canInterrupt` against a mock bot, which catches this class immediately.
- **The dead-export checker was silently skipping most of the codebase.** Its regex required a newline before `};`, so single-line `module.exports = { a, b };` never matched and those files were counted as clean without being read. Fixing it immediately surfaced nine dead exports and two entirely unused functions. It now reports `parsed N/M files` so a silent skip is visible.
