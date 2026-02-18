'use strict';

const express = require('express');
const http    = require('http');
const { Server } = require('socket.io');
const path    = require('path');
const { GameRoom, MAPS } = require('./game-logic');

const app    = express();
const server = http.createServer(app);
const io     = new Server(server, { cors: { origin: '*' } });

app.use(express.static(path.join(__dirname, 'public')));

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

function createRoom(name, mapIndex) {
  const idx  = mapIndex || 0;
  const map  = MAPS[idx];
  const isDM = map.mode === 'deathmatch' || map.mode === 'deathmatch_bots';
  const id   = 'room_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6);
  rooms[id]  = {
    id,
    name:       name || `Room ${Object.keys(rooms).length + 1}`,
    mapIndex:   idx,
    mapName:    map.name,
    mode:       map.mode,
    maxPlayers: isDM ? 8 : 4,
    game:       null,
    hostId:     null,
    stateInterval: null,
  };
  return rooms[id];
}

function startStateLoop(room) {
  if (room.stateInterval) clearInterval(room.stateInterval);
  room.stateInterval = setInterval(() => {
    const g = room.game;
    if (!g) return;
    io.to(room.id).emit('gameState', g.getState());
    if (g.gameOver) {
      clearInterval(room.stateInterval);
      // Auto-reset room 35s after game ends so it becomes joinable again
      room.autoResetTimer = setTimeout(() => {
        if (!room.game || !room.game.gameOver) return;
        console.log(`[auto-reset] ${room.name}`);
        room.game.stop();
        room.game = null;
        io.to(room.id).emit('serverReset');   // kick remaining clients to lobby
        io.emit('roomList', getRoomList());
      }, 35000);
    }
  }, 33);
}

// Default rooms
createRoom('Classic Battle #1', 0);
createRoom('Fortress Siege',    1);
createRoom('Deathmatch Arena',  2);
createRoom('DM with Bots',      3);

// ── Socket.IO ──────────────────────────────────────────────
io.on('connection', (socket) => {
  console.log(`[+] ${socket.id}`);

  socket.emit('roomList', getRoomList());
  socket.emit('mapList', MAPS.map((m, i) => ({ index: i, name: m.name, mode: m.mode })));

  socket.on('createRoom', ({ name, mapIndex }) => {
    const room = createRoom(name, mapIndex);
    room.hostId = socket.id;
    io.emit('roomList', getRoomList());
    socket.emit('roomCreated', { roomId: room.id });
  });

  socket.on('joinRoom', ({ roomId, playerName }) => {
    const room = rooms[roomId];
    if (!room)                                  return socket.emit('error', 'Room not found');
    if (!room.game) room.game = new GameRoom(roomId, room.mapIndex);

    const game = room.game;
    if (game.getPlayerCount() >= room.maxPlayers) return socket.emit('error', 'Room is full');
    if (game.gameOver)                             return socket.emit('error', 'Game already over — restart first');

    socket.join(roomId);
    socket.data.roomId     = roomId;
    socket.data.playerName = playerName;

    const player = game.addPlayer(socket.id, playerName);
    console.log(`[+] ${playerName} → ${room.name}`);

    socket.emit('joinedRoom', {
      roomId,
      playerId:   socket.id,
      player,
      mode:       game.mode,
      mapData:    game.mapData,
      fragLimit:  game.fragLimit,
    });

    io.to(roomId).emit('playerJoined', { id: socket.id, name: playerName });
    io.emit('roomList', getRoomList());

    if (!game.tickInterval) {
      game.start();
      startStateLoop(room);
    }
  });

  socket.on('input', (inputs) => {
    const room = rooms[socket.data.roomId];
    if (room && room.game) room.game.handleInput(socket.id, inputs);
  });

  socket.on('ping_',    ()    => socket.emit('pong_'));
  socket.on('getRooms', ()    => socket.emit('roomList', getRoomList()));

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

    // Cancel auto-reset if pending
    if (room.autoResetTimer) { clearTimeout(room.autoResetTimer); room.autoResetTimer = null; }

    room.game.stop();
    clearInterval(room.stateInterval);
    room.game = new GameRoom(room.id, room.mapIndex);

    // Re-add all connected players
    const sockets = io.sockets.adapter.rooms.get(room.id);
    if (sockets) {
      for (const sid of sockets) {
        const s = io.sockets.sockets.get(sid);
        if (s) room.game.addPlayer(sid, s.data.playerName);
      }
    }

    room.game.start();
    startStateLoop(room);
    io.to(room.id).emit('gameRestarted', { mapData: room.game.mapData, mode: room.game.mode });
  });

  socket.on('disconnect', () => {
    const roomId = socket.data.roomId;
    console.log(`[-] ${socket.id}`);
    if (!roomId || !rooms[roomId] || !rooms[roomId].game) return;
    const room = rooms[roomId];
    room.game.removePlayer(socket.id);
    io.to(roomId).emit('playerLeft', { id: socket.id });
    io.emit('roomList', getRoomList());
    if (room.game.getPlayerCount() === 0) {
      room.game.stop();
      clearInterval(room.stateInterval);
      room.game = null;
    }
  });
});

// ── Start ──────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`\n🎮  Battle City running at http://localhost:${PORT}\n`));