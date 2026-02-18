# 🎮 Battle City Online — Multiplayer

A browser-based multiplayer Battle City clone with room-based matchmaking.

## Quick Start

```bash
# 1. Install dependencies
npm install

# 2. Start the server
npm start

# 3. Open in browser
# http://localhost:3000
```

## Stack

| Layer | Tech |
|---|---|
| Server | Node.js + Express |
| Realtime | Socket.io |
| Client | HTML5 Canvas + Vanilla JS |
| Styling | CSS3 (retro 8-bit CRT aesthetic) |

## Features

- 🏠 **Room Browser** — CS-style server list to create/join rooms
- 👥 **Up to 4 Players** per room
- 🤖 **Enemy AI** — 20 enemy tanks per level with basic pathfinding
- 🗺️ **2 Maps** — Classic and Fortress layouts
- 💬 **In-game Chat** per room
- 🛡️ **Spawn Protection** — brief invincibility on spawn
- 🏆 **Win/Lose conditions** — destroy all enemies or protect the Eagle base
- 📡 **Ping Display**
- 📱 **Responsive** layout

## Controls

| Key | Action |
|---|---|
| W/A/S/D or Arrow Keys | Move tank |
| Space / Enter | Fire |
| Escape | Leave room |

## Game Rules

- Defend the **Eagle** (gold base at bottom) — if it's destroyed, you lose!
- Destroy all **20 enemy tanks** to win
- Each player has **3 lives**
- **Brick walls** can be destroyed by bullets
- **Steel walls** are indestructible

## Architecture

```
server.js          — Express HTTP + Socket.io event hub
game-logic.js      — Authoritative server-side game state (tick at 30fps)
maps.js            — Tile map definitions
public/index.html  — Lobby + Game UI
public/client.js   — Socket.io client + Canvas renderer
```

The server runs a **tick-based game loop** at 30fps and broadcasts state to all clients in the room. Clients are input-only — no client-side prediction (intentionally simple).

## Deployment

Works on any Node.js host (Railway, Render, Fly.io, VPS).

```bash
PORT=80 node server.js
```

For production, add a reverse proxy (nginx) in front of it.
