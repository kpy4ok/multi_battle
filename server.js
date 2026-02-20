'use strict';

const express  = require('express');
const http     = require('http');
const { Server } = require('socket.io');
const path     = require('path');
const crypto   = require('crypto');
const { GameRoom, MAPS } = require('./game-logic');
const db       = require('./db');

const app    = express();
const server = http.createServer(app);
const io     = new Server(server, { cors: { origin: '*' } });

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ── Public leaderboard API (no auth needed) ────────────────
app.get('/api/leaderboard', (req, res) => {
  try {
    res.json(db.getPublicStats());
  } catch(e) {
    res.json({ topPlayers: [], recentGames: [], totalStats: null });
  }
});

// ── UID helpers ────────────────────────────────────────────
// UID is generated server-side per new socket connection and sent to client.
// Client stores it in localStorage and sends it back on reconnect.
// This way one physical user keeps the same UID across multiple sessions.
function newUID() {
  return 'u_' + crypto.randomBytes(10).toString('hex');
}

// ── IP helper ─────────────────────────────────────────────
function getIP(socket) {
  return (
    socket.handshake.headers['x-forwarded-for']?.split(',')[0]?.trim() ||
    socket.handshake.address ||
    'unknown'
  );
}

// ── HTTP: page_open event (called by client on first load) ─
app.post('/api/pageopen', (req, res) => {
  const { uid, resolution } = req.body || {};
  const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
  const ua = req.headers['user-agent'] || '';
  db.log({ uid, event: 'page_open', ip, ua, resolution });
  res.json({ ok: true });
});

// ── HTTP: admin stats page ─────────────────────────────────
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || 'changeme';   // set via env var on server

app.get('/admin', (req, res) => {
  if (req.query.token !== ADMIN_TOKEN) return res.status(403).send('Forbidden');
  const s = db.getStats();
  const fmt = ts => new Date(ts).toISOString().replace('T',' ').slice(0,19);
  const eventColor = { page_open:'#44AAFF', room_join:'#44FF88', room_create:'#FFD700', room_exit:'#FF8C00', game_win:'#FF4444' };

  res.send(`<!DOCTYPE html>
<html><head><meta charset="UTF-8">
<title>Battle City — Admin</title>
<style>
  body{background:#0a0a0f;color:#ccc;font-family:monospace;font-size:13px;padding:20px;}
  h1{color:#FFD700;font-size:18px;margin-bottom:20px;}
  h2{color:#FFD700;font-size:13px;margin:24px 0 8px;border-bottom:1px solid #333;padding-bottom:4px;}
  .stats{display:flex;gap:20px;flex-wrap:wrap;margin-bottom:20px;}
  .stat{background:#111;border:1px solid #333;padding:12px 20px;border-radius:4px;}
  .stat .val{font-size:28px;color:#FFD700;display:block;}
  .stat .lbl{color:#666;font-size:11px;}
  table{width:100%;border-collapse:collapse;margin-bottom:20px;}
  th{background:#111;color:#FFD700;padding:6px 10px;text-align:left;font-size:11px;border-bottom:1px solid #333;}
  td{padding:5px 10px;border-bottom:1px solid #1a1a1a;font-size:11px;}
  tr:hover td{background:#111;}
  .badge{padding:2px 6px;border-radius:2px;font-size:10px;font-weight:bold;}
  .win{color:#44FF88;} .loss{color:#FF4444;}
</style></head><body>
<h1>⚔ BATTLE CITY — ADMIN STATS</h1>

<div class="stats">
  <div class="stat"><span class="val">${s.totalUsers}</span><span class="lbl">UNIQUE USERS</span></div>
  <div class="stat"><span class="val">${s.totalSessions}</span><span class="lbl">PAGE OPENS</span></div>
  <div class="stat"><span class="val">${s.totalGames}</span><span class="lbl">COMPLETED GAMES</span></div>
</div>

<h2>🏆 TOP PLAYERS</h2>
<table>
  <tr><th>USERNAME</th><th>UID</th><th>GAMES</th><th>WINS</th><th>TOTAL SCORE</th></tr>
  ${s.topPlayers.map(p=>`<tr>
    <td>${p.username||'?'}</td><td style="color:#555;font-size:10px">${p.uid}</td>
    <td>${p.games}</td><td class="win">${p.wins}</td><td style="color:#44FF88">${p.total_score}</td>
  </tr>`).join('')}
</table>

<h2>📋 RECENT RESULTS (last 50)</h2>
<table>
  <tr><th>TIME</th><th>UID</th><th>NAME</th><th>ROOM</th><th>MODE</th><th>RESULT</th><th>SCORE</th><th>DEATHS</th><th>DURATION</th></tr>
  ${s.recentResults.map(r=>`<tr>
    <td>${fmt(r.ts)}</td>
    <td style="color:#555;font-size:10px">${r.uid}</td>
    <td>${r.username||'?'}</td>
    <td>${r.room_name||r.room_id||'?'}</td>
    <td>${r.mode||'?'}</td>
    <td class="${r.result}">${r.result?.toUpperCase()}</td>
    <td style="color:#44FF88">${r.score}</td>
    <td style="color:#FF4444">${r.deaths}</td>
    <td>${r.duration_s}s</td>
  </tr>`).join('')}
</table>

<h2>📜 RECENT ACTIVITY LOG (last 100)</h2>
<table>
  <tr><th>TIME</th><th>EVENT</th><th>NAME</th><th>UID</th><th>IP</th><th>OS</th><th>BROWSER</th><th>RES</th><th>ROOM</th></tr>
  ${s.recentLog.map(l=>`<tr>
    <td>${fmt(l.ts)}</td>
    <td><span class="badge" style="color:${eventColor[l.event]||'#aaa'}">${l.event}</span></td>
    <td>${l.username||'—'}</td>
    <td style="color:#555;font-size:10px">${l.uid}</td>
    <td>${l.ip||'?'}</td>
    <td>${l.os||'?'}</td>
    <td>${l.browser||'?'}</td>
    <td>${l.resolution||'?'}</td>
    <td>${l.room_name||l.room_id||'—'}</td>
  </tr>`).join('')}
</table>
</body></html>`);
});

// ── Room registry ──────────────────────────────────────────
const rooms = {};

function getRoomList() {
  return Object.values(rooms).map(r => ({
    id:         r.id,
    name:       r.name,
    map:        r.mapName,
    mode:       r.mode,
    players:    r.game ? r.game.getPlayerCount() : 0,
    maxPlayers: r.maxPlayers,
    status:     r.game ? (r.game.gameOver ? 'finished' : 'playing') : 'waiting',
  }));
}

function createRoom(name, mapIndex, isSystem = false) {
  const idx  = mapIndex || 0;
  const map  = MAPS[idx];
  const isDM = map.mode === 'deathmatch' || map.mode === 'deathmatch_bots';
  const id   = 'room_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6);
  rooms[id]  = {
    id,
    name:          name || `Room ${Object.keys(rooms).length + 1}`,
    mapIndex:      idx,
    mapName:       map.name,
    mode:          map.mode,
    maxPlayers:    isDM ? 8 : 4,
    isSystem,              // system rooms are never deleted
    game:          null,
    hostId:        null,
    stateInterval: null,
    startedAt:     null,
    autoResetTimer:   null,
    emptyDestroyTimer: null,  // 30s grace timer when room goes empty
  };
  return rooms[id];
}

// Destroy a user room cleanly — stops game, clears all timers, removes from registry
function destroyUserRoom(room) {
  if (!room || room.isSystem) return;
  if (!rooms[room.id]) return;  // already gone

  console.log(`[destroy] user room "${room.name}" (${room.id})`);

  // Clear all timers
  if (room.stateInterval)    clearInterval(room.stateInterval);
  if (room.autoResetTimer)   clearTimeout(room.autoResetTimer);
  if (room.emptyDestroyTimer) clearTimeout(room.emptyDestroyTimer);

  // Stop game loop
  if (room.game) room.game.stop();

  // Remove from registry
  delete rooms[room.id];

  // Broadcast updated room list to lobby
  io.emit('roomList', getRoomList());
}

function startStateLoop(room) {
  if (room.stateInterval) clearInterval(room.stateInterval);
  room.startedAt = Date.now();

  room.stateInterval = setInterval(() => {
    const g = room.game;
    if (!g) return;
    io.to(room.id).emit('gameState', g.getState());

    if (g.gameOver) {
      clearInterval(room.stateInterval);
      room.stateInterval = null;
      saveRoomResults(room, g);

      // After 35s: reset system rooms, destroy user rooms
      room.autoResetTimer = setTimeout(() => {
        if (!rooms[room.id]) return; // already destroyed

        if (room.isSystem) {
          // System room: just wipe the game so it's joinable again
          if (room.game) { room.game.stop(); room.game = null; }
          console.log(`[auto-reset] system room "${room.name}"`);
          io.to(room.id).emit('serverReset');
          io.emit('roomList', getRoomList());
        } else {
          // User room: kick any remaining clients then delete
          io.to(room.id).emit('serverReset');
          destroyUserRoom(room);
        }
        room.autoResetTimer = null;
      }, 35000);
    }
  }, 33);
}

// ── Save results for all players when game finishes ────────
function saveRoomResults(room, game) {
  try {
    const duration_s = room.startedAt ? Math.round((Date.now() - room.startedAt) / 1000) : 0;
    const state      = game.getState();
    const isDM       = state.mode === 'deathmatch' || state.mode === 'deathmatch_bots';
    const allEntities = [...(state.players || []), ...(state.bots || [])];

    for (const p of allEntities) {
      if (p.isBot) continue;  // don't save bot results
      // Look up UID stored on socket data
      const sockData = socketMeta[p.id];
      if (!sockData) continue;

      let result;
      if (isDM) {
        result = (state.winnerId === p.id) ? 'win' : 'loss';
      } else {
        result = state.winner === 'players' ? 'win' : 'loss';
      }

      db.saveResult({
        uid:        sockData.uid,
        username:   p.name,
        roomId:     room.id,
        roomName:   room.name,
        mode:       state.mode,
        result,
        score:      p.score  || 0,
        deaths:     p.deaths || 0,
        duration_s,
      });

      // Also log game_win event for winners
      if (result === 'win') {
        db.log({
          uid:      sockData.uid,
          event:    'game_win',
          username: p.name,
          ip:       sockData.ip,
          ua:       sockData.ua,
          roomId:   room.id,
          roomName: room.name,
        });
      }
    }
  } catch(e) {
    console.error('[saveRoomResults]', e.message);
  }
}

// ── Per-socket metadata store ──────────────────────────────
// socketMeta[socketId] = { uid, ip, ua, resolution }
const socketMeta = {};

// Default rooms (system — never auto-deleted)
createRoom('Classic Battle #1', 0, true);
createRoom('Fortress Siege',    1, true);
createRoom('Deathmatch Arena',  2, true);
createRoom('DM with Bots',      3, true);
createRoom('Mini DM with Bots', 4, true);

// ── Socket.IO ──────────────────────────────────────────────
io.on('connection', (socket) => {
  const ip = getIP(socket);
  const ua = socket.handshake.headers['user-agent'] || '';
  console.log(`[+] ${socket.id} ${ip}`);

  socket.emit('roomList', getRoomList());
  socket.emit('mapList', MAPS.map((m, i) => ({ index: i, name: m.name, mode: m.mode })));

  // Client sends its stored UID (or empty if first visit)
  socket.on('register', ({ uid, resolution } = {}) => {
    const resolvedUID = (uid && uid.startsWith('u_')) ? uid : newUID();
    socketMeta[socket.id] = { uid: resolvedUID, ip, ua, resolution };
    // Send UID back so client can persist it
    socket.emit('registered', { uid: resolvedUID });
  });

  socket.on('createRoom', ({ name, mapIndex }) => {
    const room = createRoom(name, mapIndex);
    room.hostId = socket.id;
    io.emit('roomList', getRoomList());
    socket.emit('roomCreated', { roomId: room.id });

    const meta = socketMeta[socket.id] || {};
    db.log({
      uid:      meta.uid,
      event:    'room_create',
      username: socket.data.playerName,
      ip,  ua,
      resolution: meta.resolution,
      roomId:   room.id,
      roomName: room.name,
    });
  });

  socket.on('joinRoom', ({ roomId, playerName }) => {
    const room = rooms[roomId];
    if (!room)                                    return socket.emit('error', 'Room not found');
    if (!room.game) room.game = new GameRoom(roomId, room.mapIndex);

    const game = room.game;
    if (game.getPlayerCount() >= room.maxPlayers) return socket.emit('error', 'Room is full');
    if (game.gameOver)                            return socket.emit('error', 'Game already over — restart first');

    socket.join(roomId);
    socket.data.roomId     = roomId;
    socket.data.playerName = playerName;

    // Cancel pending empty-room destroy timer if someone joins in time
    if (room.emptyDestroyTimer) {
      clearTimeout(room.emptyDestroyTimer);
      room.emptyDestroyTimer = null;
      console.log(`[empty-cancel] "${room.name}" — player joined before timeout`);
    }

    const player = game.addPlayer(socket.id, playerName);
    console.log(`[+] ${playerName} → ${room.name}`);

    socket.emit('joinedRoom', {
      roomId,
      playerId:  socket.id,
      player,
      mode:      game.mode,
      cols:      game.cols,
      rows:      game.rows,
      mapData:   game.mapData,
      fragLimit: game.fragLimit,
    });

    io.to(roomId).emit('playerJoined', { id: socket.id, name: playerName });
    io.emit('roomList', getRoomList());

    const meta = socketMeta[socket.id] || {};
    db.log({
      uid:        meta.uid,
      event:      'room_join',
      username:   playerName,
      ip, ua,
      resolution: meta.resolution,
      roomId:     room.id,
      roomName:   room.name,
    });

    if (!game.tickInterval) {
      game.start();
      startStateLoop(room);
    }
  });

  socket.on('input', (inputs) => {
    const room = rooms[socket.data.roomId];
    if (room && room.game) room.game.handleInput(socket.id, inputs);
  });

  socket.on('ping_',    () => socket.emit('pong_'));
  socket.on('getRooms', () => socket.emit('roomList', getRoomList()));

  socket.on('chat', (msg) => {
    const roomId = socket.data.roomId;
    if (!roomId) return;
    io.to(roomId).emit('chat', {
      name: socket.data.playerName || 'Unknown',
      msg:  String(msg).slice(0, 100),
    });
  });

  socket.on('restartGame', () => {
    const room = rooms[socket.data.roomId];
    if (!room || !room.game || !room.game.gameOver) return;
    if (room.autoResetTimer) { clearTimeout(room.autoResetTimer); room.autoResetTimer = null; }

    room.game.stop();
    clearInterval(room.stateInterval);
    room.game = new GameRoom(room.id, room.mapIndex);

    const sockets = io.sockets.adapter.rooms.get(room.id);
    if (sockets) {
      for (const sid of sockets) {
        const s = io.sockets.sockets.get(sid);
        if (s) room.game.addPlayer(sid, s.data.playerName);
      }
    }

    room.game.start();
    startStateLoop(room);
    io.to(room.id).emit('gameRestarted', { mapData: room.game.mapData, mode: room.game.mode, cols: room.game.cols, rows: room.game.rows });
  });

  socket.on('disconnect', () => {
    const roomId = socket.data.roomId;
    console.log(`[-] ${socket.id}`);

    const meta = socketMeta[socket.id] || {};
    if (roomId && rooms[roomId]) {
      db.log({
        uid:        meta.uid,
        event:      'room_exit',
        username:   socket.data.playerName,
        ip, ua,
        resolution: meta.resolution,
        roomId,
        roomName:   rooms[roomId]?.name,
      });
    }

    delete socketMeta[socket.id];

    if (!roomId || !rooms[roomId] || !rooms[roomId].game) return;
    const room = rooms[roomId];
    room.game.removePlayer(socket.id);
    io.to(roomId).emit('playerLeft', { id: socket.id });
    io.emit('roomList', getRoomList());

    if (room.game.getPlayerCount() === 0) {
      room.game.stop();
      clearInterval(room.stateInterval);
      room.stateInterval = null;
      room.game = null;

      // User rooms: destroy after 30s if still empty
      if (!room.isSystem) {
        // Cancel any existing empty timer (e.g. from a previous empty spell)
        if (room.emptyDestroyTimer) clearTimeout(room.emptyDestroyTimer);

        room.emptyDestroyTimer = setTimeout(() => {
          // Only destroy if still empty (no new players joined during the 30s)
          if (rooms[room.id] && (!room.game || room.game.getPlayerCount() === 0)) {
            destroyUserRoom(room);
          }
          room.emptyDestroyTimer = null;
        }, 30000);

        console.log(`[empty] user room "${room.name}" — destroying in 30s if no one joins`);
      }
    }
  });
});

// ── Start ──────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`\n🎮  Battle City running at http://localhost:${PORT}\n`));