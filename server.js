'use strict';

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const { GameRoom, MAPS } = require('./game-logic');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' }
});

app.use(express.static(path.join(__dirname, 'public')));

// ── Room registry ──────────────────────────────────────────
const rooms = {}; // roomId -> { meta, game: GameRoom | null }

function getRoomList() {
  return Object.values(rooms).map(r => ({
    id: r.id,
    name: r.name,
    map: r.mapName,
    players: r.game ? r.game.getPlayerCount() : 0,
    maxPlayers: 4,
    status: r.game ? (r.game.gameOver ? 'finished' : 'playing') : 'waiting',
  }));
}

function createRoom(name, mapIndex) {
  const id = 'room_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6);
  rooms[id] = {
    id,
    name: name || `Room ${Object.keys(rooms).length + 1}`,
    mapIndex: mapIndex || 0,
    mapName: MAPS[mapIndex || 0].name,
    game: null,
    hostId: null,
  };
  return rooms[id];
}

// Create default rooms
createRoom('Classic Battle #1', 0);
createRoom('Fortress Siege', 1);

// ── Socket.IO events ───────────────────────────────────────
io.on('connection', (socket) => {
  console.log(`[+] Connected: ${socket.id}`);

  // Send current room list
  socket.emit('roomList', getRoomList());
  socket.emit('mapList', MAPS.map((m, i) => ({ index: i, name: m.name })));

  // Create room
  socket.on('createRoom', ({ name, mapIndex }) => {
    const room = createRoom(name, mapIndex);
    room.hostId = socket.id;
    io.emit('roomList', getRoomList());
    socket.emit('roomCreated', { roomId: room.id });
  });

  // Join room
  socket.on('joinRoom', ({ roomId, playerName }) => {
    const room = rooms[roomId];
    if (!room) return socket.emit('error', 'Room not found');

    // Initialize game if first player
    if (!room.game) {
      room.game = new GameRoom(roomId, room.mapIndex);
    }

    const game = room.game;
    if (game.getPlayerCount() >= 4) return socket.emit('error', 'Room is full');
    if (game.gameOver) return socket.emit('error', 'Game already over');

    socket.join(roomId);
    socket.data.roomId = roomId;
    socket.data.playerName = playerName;

    const player = game.addPlayer(socket.id, playerName);
    console.log(`[+] ${playerName} joined room ${roomId}`);

    // Send initial map + state
    socket.emit('joinedRoom', {
      roomId,
      playerId: socket.id,
      player,
      mapData: game.mapData,
      mapCols: 26,
      mapRows: 26,
      tileSize: 16,
    });

    io.to(roomId).emit('playerJoined', { id: socket.id, name: playerName });
    io.emit('roomList', getRoomList());

    // Start game loop if not started
    if (!game.tickInterval) {
      game.start();
      // Broadcast state at ~30fps
      room.stateInterval = setInterval(() => {
        if (game.gameOver) {
          io.to(roomId).emit('gameState', game.getState());
          clearInterval(room.stateInterval);
          return;
        }
        io.to(roomId).emit('gameState', game.getState());
      }, 33);
    }
  });

  // Player input
  socket.on('input', (inputs) => {
    const roomId = socket.data.roomId;
    if (!roomId || !rooms[roomId] || !rooms[roomId].game) return;
    rooms[roomId].game.handleInput(socket.id, inputs);
  });

  // Ping
  socket.on('ping_', () => socket.emit('pong_'));

  // Get rooms (refresh)
  socket.on('getRooms', () => socket.emit('roomList', getRoomList()));

  // Chat message
  socket.on('chat', (msg) => {
    const roomId = socket.data.roomId;
    if (!roomId) return;
    const name = socket.data.playerName || 'Unknown';
    io.to(roomId).emit('chat', { name, msg: msg.slice(0, 100) });
  });

  // Restart game
  socket.on('restartGame', () => {
    const roomId = socket.data.roomId;
    const room = rooms[roomId];
    if (!room || !room.game || !room.game.gameOver) return;

    room.game.stop();
    clearInterval(room.stateInterval);
    room.game = new GameRoom(roomId, room.mapIndex);
    room.game.start();

    // Re-add all players in room
    const sockets = io.sockets.adapter.rooms.get(roomId);
    let idx = 0;
    if (sockets) {
      for (const sid of sockets) {
        const s = io.sockets.sockets.get(sid);
        if (s) {
          room.game.addPlayer(sid, s.data.playerName);
          idx++;
        }
      }
    }

    room.stateInterval = setInterval(() => {
      if (room.game.gameOver) {
        io.to(roomId).emit('gameState', room.game.getState());
        clearInterval(room.stateInterval);
        return;
      }
      io.to(roomId).emit('gameState', room.game.getState());
    }, 33);

    io.to(roomId).emit('gameRestarted', { mapData: room.game.mapData });
  });

  // Disconnect
  socket.on('disconnect', () => {
    const roomId = socket.data.roomId;
    console.log(`[-] Disconnected: ${socket.id}`);
    if (roomId && rooms[roomId] && rooms[roomId].game) {
      rooms[roomId].game.removePlayer(socket.id);
      io.to(roomId).emit('playerLeft', { id: socket.id });
      io.emit('roomList', getRoomList());

      // Clean up empty rooms (except default ones)
      if (rooms[roomId].game.getPlayerCount() === 0) {
        rooms[roomId].game.stop();
        clearInterval(rooms[roomId].stateInterval);
        rooms[roomId].game = null;
      }
    }
  });
});

// ── Start ──────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`\n🎮 Battle City Multiplayer running at http://localhost:${PORT}\n`);
});
