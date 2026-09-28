# mint-minecraft-bot

An autonomous Minecraft survival bot. It joins your world as a normal player (called **Mint** by
default) and plays survival by itself, from empty hands to a full diamond kit, while a live web
dashboard shows what it is doing and why.

- **Plays the whole early game on its own:** wood, stone tools, food, iron, then diamonds and a full
  diamond kit.
- **Survives:** fights or avoids mobs with tactics for each mob type, shelters or sleeps at night,
  eats and cooks, escapes lava, drowning and water traps, and walks back for its items after dying.
- **Thinks fast:** everything with one right answer is plain code. Judgement calls, such as "fight
  or flee?", go to a fast typed-decision model, asked ahead of time so the bot never stands still
  waiting for an answer.
- **Easy to watch:** a dashboard at <http://localhost:3000> with a 3D view of the world, health and
  hunger, the plan, the decision stream, a radar and the backpack.

Built on [Mineflayer](https://github.com/PrismarineJS/mineflayer) and the PrismarineJS ecosystem;
see [CREDITS.md](CREDITS.md).

> Not an official Minecraft product. Not approved by or associated with Mojang or Microsoft.

## Requirements

- Minecraft Java Edition **1.21.9**. The bot is tested on it; other versions are auto-detected but
  untested.
- [Node.js](https://nodejs.org) **22.19 or newer**.
- Optional: an API key for Jev ([TypeSafe](https://typesafe.ai)). Without one, the bot uses its
  built-in rules for every decision.

## Quick start

```bash
git clone <this repository>
cd mc-jev-bot
npm install
cp .env.example .env        # on Windows: copy .env.example .env
```

1. In Minecraft, open your world and choose **Esc → Open to LAN → Start LAN World**. Note the port
   it prints in chat.
2. Put that port in `.env` as `MC_PORT=` (it changes every time you reopen the world).
3. Start the bot:

   ```bash
   npm start
   ```

The bot joins as **Mint**. To rename it, set `BOT_NAME=YourName` in `.env`.

Stop it with **Ctrl+C**. It saves its memory of the world first.

[HOW-TO-RUN.txt](HOW-TO-RUN.txt) walks through all of this step by step, with troubleshooting.

## The dashboard

Open <http://localhost:3000> while the bot runs. It only listens on this computer and can only
watch; nothing on it controls the bot.

- **3D view** of the world through the bot's eyes, or orbiting it, with its route and the block it
  is digging drawn in. A frame-rate readout sits in the corner.
- **Status:** health, hunger and air; what the bot is doing, in plain words; the phases to a
  diamond kit, with a supplies checklist.
- **Brain board:** every behavior the scheduler is weighing, and which one has control.
- **Decisions:** Jev's calls, a decision stream, and a replay of the last 10 seconds after each
  death.
- **Radar and backpack.**
- **History tab:** run statistics across worlds and attempts.

Keys: `1` live, `2` history, `3` 3D on/off, `S` sound. Add `?overlay=1` to the address for a
see-through version to use in OBS.

## Talking to the bot

Type these in Minecraft chat, without a slash:

`help`, `status`, `report`, `watch 30`, `plan`, `why`, `hurt`, `diff`, `lag`, `where`, `inv`,
`base`, `come`, `stop`, `resume`, `cheats`, `xray on|off`, `fullbright on|off`

## Configuration

All settings live in `.env`; [.env.example](.env.example) lists every one with its default. The
main ones:

| Setting | Default | Meaning |
|---|---|---|
| `MC_HOST`, `MC_PORT` | `localhost`, `25565` | Where the world is |
| `BOT_NAME` | `Mint` | The bot's name in the world |
| `TYPESAFE_API_KEY` | none | Key for the decision model (optional) |
| `MC_AUTH`, `MC_EMAIL` | `offline` | Use `microsoft` and an account email for online servers |
| `MC_DASHBOARD_PORT` | `3000` | Dashboard port; `0` turns it off |
| `MC_VIEWER` | `on` | `off` drops the 3D view to save memory |
| `MC_VIEWER_PIXEL_RATIO` | `1` | 3D resolution; `1` is fastest |
| `ENABLE_FULLBRIGHT` | `true` | No torches needed before going underground |
| `ENABLE_XRAY` | `false` | Tunnel straight to hidden ore. This is a cheat. |

## How it works, briefly

- **One behavior at a time.** A priority scheduler (`src/director.js`) runs the most urgent
  behavior whose conditions are met. Examples: escaping lava (97), drowning (95), fighting back
  (94), sleeping (92), picking up drops (44), crafting (40), mining (25), exploring (5). Each one
  does a small piece of work and hands back control, so the bot reacts to change constantly.
- **Eight phases** (`src/progression.js`): Wood, Stone tools, Food, Ready to dig, Iron, Iron kit,
  Diamonds, Diamond kit. Survival always comes first; small detours worth taking are allowed.
- **A reflex layer** checks for lava, drowning, nearby mobs and big drops on every game tick.
- **Swimming** is built on the game's real physics, measured and pinned by tests (`src/water.js`).
- **Memory per world:** stations, ore it has seen, deaths, water traps and hunted-out ground.

[BOT-GUIDE.txt](BOT-GUIDE.txt) explains every behavior and feature.
[docs/DESIGN-NOTES.md](docs/DESIGN-NOTES.md) covers the design decisions and the bugs that shaped
them.

## Development

```bash
npm test          # 35 test suites; no Minecraft needed
npm run lint      # ESLint
npm run logs      # summarise the newest session log (logs/)
npm run fresh     # wipe the bot's memory of the world, then start it
```

`test/waterSim.test.js` runs the real prismarine-physics engine on a small in-memory world to test
swimming.

## Credits and license

Created by **Kishore Muniyasamy**. Released under the [MIT License](LICENSE).

Third-party projects and their licenses are listed in [CREDITS.md](CREDITS.md). One dependency,
the combat plugin, is GPL-3.0; that file explains what this means.
