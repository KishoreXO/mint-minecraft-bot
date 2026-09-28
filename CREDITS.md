# Credits

## Author

**Kishore Muniyasamy** created this bot: its design, behaviors, dashboard and tests.

## Built on

This bot stands on the work of these open-source projects and their contributors.
None of their code is copied into this repository; `npm install` downloads each one
under its own license.

### PrismarineJS

The Minecraft client this bot is built on, and most of what it knows about the game.
<https://github.com/PrismarineJS>

| Package | What it does here | License |
|---|---|---|
| [mineflayer](https://github.com/PrismarineJS/mineflayer) | Joins the world and plays as a player | MIT |
| [mineflayer-pathfinder](https://github.com/PrismarineJS/mineflayer-pathfinder) (by Karang) | Walking routes | MIT |
| [prismarine-viewer](https://github.com/PrismarineJS/prismarine-viewer) | The 3D view on the dashboard | MIT |
| [prismarine-physics](https://github.com/PrismarineJS/prismarine-physics) | Movement physics, also used by the swimming tests | MIT |
| [prismarine-block](https://github.com/PrismarineJS/prismarine-block), [prismarine-chunk](https://github.com/PrismarineJS/prismarine-chunk), [prismarine-world](https://github.com/PrismarineJS/prismarine-world), [prismarine-item](https://github.com/PrismarineJS/prismarine-item), [prismarine-registry](https://github.com/PrismarineJS/prismarine-registry) | Blocks, chunks, the world, items and game data | MIT |
| [minecraft-data](https://github.com/PrismarineJS/minecraft-data) | Recipes, blocks, items and mobs for every version | MIT |
| [minecraft-protocol](https://github.com/PrismarineJS/node-minecraft-protocol) (by Andrew Kelley) | The network protocol, used by mineflayer | BSD-3-Clause |
| [vec3](https://github.com/PrismarineJS/node-vec3) (by Andrew Kelley) | 3D vector maths | BSD |

Romain Beaumont maintains much of PrismarineJS; Will Franzen wrote prismarine-world.

### Mineflayer plugins

| Package | Author | What it does here | License |
|---|---|---|---|
| [@nxg-org/mineflayer-custom-pvp](https://github.com/nxg-org/mineflayer-custom-pvp) | generel_schwerz (nxg-org) | Sword combat, critical hits, strafing | **GPL-3.0** |
| [mineflayer-bloodhound](https://github.com/Nixes/mineflayer-bloodhound) | Nixes | Works out who hit the bot | none declared |
| [mineflayer-tool](https://github.com/TheDudeFromCI/mineflayer-tool) | TheDudeFromCI | Picks the right tool for a block | MIT |
| [mineflayer-armor-manager](https://github.com/G07cha/MineflayerArmorManager) | G07cha | Wears the best armour | MIT |
| [mineflayer-auto-eat](https://github.com/linkle69/mineflayer-auto-eat) | Linkle | Eats automatically | MIT |

### Web and runtime

| Package | What it does here | License |
|---|---|---|
| [Express](https://github.com/expressjs/express) (TJ Holowaychuk and contributors) | The dashboard's web server | MIT |
| [Socket.IO](https://github.com/socketio/socket.io) | Streams the 3D view to the browser | MIT |
| [three.js](https://github.com/mrdoob/three.js) (mrdoob and contributors) | 3D rendering, bundled inside prismarine-viewer | MIT |
| [undici](https://github.com/nodejs/undici) (Node.js) | HTTP connections | MIT |
| [dotenv](https://github.com/motdotla/dotenv) | Reads the `.env` settings file | BSD-2-Clause |
| [ESLint](https://github.com/eslint/eslint) | Checks the code (development only) | MIT |

### Fonts

The dashboard loads these from Google Fonts:

- [VT323](https://fonts.google.com/specimen/VT323) by Peter Hull, SIL Open Font License 1.1
- [JetBrains Mono](https://github.com/JetBrains/JetBrainsMono) by JetBrains, SIL Open Font License 1.1

## A note on licenses

This repository's own code is MIT (see [LICENSE](LICENSE)). Two dependencies are different:

- **@nxg-org/mineflayer-custom-pvp is GPL-3.0.** The bot loads it for combat. If you distribute a
  copy of the bot together with its dependencies (for example a bundle that includes
  `node_modules`), the GPL-3.0 applies to that combined program. Sharing this repository's source,
  which does not include the plugin, is not affected.
- **mineflayer-bloodhound declares no license.** It is installed from npm like any other package and
  is not redistributed here.

This is a summary, not legal advice.

## Minecraft

Not an official Minecraft product. Not approved by or associated with Mojang or Microsoft.
Minecraft is a trademark of Mojang AB. Game textures shown on the dashboard come from the
prismarine-viewer package installed on your machine; none are included in this repository.
