'use strict';

// ── Constants ──────────────────────────────────────────────
const TILE = 16;
const COLS = 26;
const ROWS = 26;
const TANK_SIZE = 14;
const BULLET_SIZE = 4;
const DIR = { UP: 0, RIGHT: 1, DOWN: 2, LEFT: 3 };
const DX = [0, 1, 0, -1];
const DY = [-1, 0, 1, 0];

// ── State ──────────────────────────────────────────────────
let socket, myId, currentRoomId;
let selectedRoomId = null;
let gameState = null;
let mapData = null;
let animFrame = 0;
let lastRender = 0;
let animTick = 0;
let pingMs = 0;
let pingStart = 0;

const keys = {};
const canvas = document.getElementById('gameCanvas');
const ctx = canvas.getContext('2d');
ctx.imageSmoothingEnabled = false;

// ── Colors / Theme ────────────────────────────────────────
const TILE_COLORS = {
  1: { main: '#C84B11', dark: '#8B3009', light: '#FF6B2B' },  // brick
  2: { main: '#888', dark: '#555', light: '#AAA' },             // steel
  3: { main: '#0055AA', dark: '#003377', light: '#0077CC' },    // water
  4: { main: '#1A5C1A', dark: '#0D3D0D', light: '#2A8C2A' },    // bush
  5: { main: '#FFD700', dark: '#B8860B', light: '#FFF' },       // base/eagle
};

// ── Socket Connection ─────────────────────────────────────
socket = io();

socket.on('connect', () => {
  console.log('Connected:', socket.id);
  myId = socket.id;
  // Ping
  setInterval(() => {
    pingStart = Date.now();
    socket.emit('ping_');
  }, 2000);
});

socket.on('pong_', () => {
  pingMs = Date.now() - pingStart;
  document.getElementById('pingDisplay').textContent = `PING: ${pingMs}ms`;
});

socket.on('roomList', (rooms) => {
  renderRoomList(rooms);
});

socket.on('mapList', (maps) => {
  const sel = document.getElementById('mapSelect');
  sel.innerHTML = maps.map(m => `<option value="${m.index}">${m.name}</option>`).join('');
});

socket.on('roomCreated', ({ roomId }) => {
  selectedRoomId = roomId;
  joinSelected();
});

socket.on('joinedRoom', ({ roomId, playerId, mapData: md }) => {
  myId = playerId;
  currentRoomId = roomId;
  mapData = md;
  showScreen('gameScreen');
  requestAnimationFrame(gameLoop);
  addChatMessage('system', `Joined room! Waiting for game...`);
});

socket.on('gameState', (state) => {
  gameState = state;
  if (state.gameOver) showGameOver(state);
  updateHUD(state);
});

socket.on('gameRestarted', ({ mapData: md }) => {
  mapData = md;
  document.getElementById('gameOverlay').classList.remove('show');
  gameState = null;
});

socket.on('playerJoined', ({ name }) => {
  addChatMessage('system', `${name} joined the battle!`);
});

socket.on('playerLeft', ({ id }) => {
  addChatMessage('system', `A player left.`);
});

socket.on('chat', ({ name, msg }) => {
  addChatMessage('chat', msg, name);
});

socket.on('error', (msg) => {
  alert('Error: ' + msg);
});

// ── Lobby ─────────────────────────────────────────────────
function renderRoomList(rooms) {
  const el = document.getElementById('roomList');
  if (!rooms.length) {
    el.innerHTML = '<div style="font-size:7px;color:#444;text-align:center;padding:20px">NO ROOMS YET — CREATE ONE!</div>';
    return;
  }
  el.innerHTML = rooms.map(r => `
    <div class="room-item ${selectedRoomId === r.id ? 'selected' : ''}" onclick="selectRoom('${r.id}')">
      <span class="room-name">${escHtml(r.name)}</span>
      <span class="room-map">${escHtml(r.map)}</span>
      <span class="room-players">${r.players}/4</span>
      <span class="room-status ${r.status}">${r.status.toUpperCase()}</span>
    </div>
  `).join('');
}

function selectRoom(id) {
  selectedRoomId = id;
  document.querySelectorAll('.room-item').forEach(el => el.classList.remove('selected'));
  event.currentTarget.classList.add('selected');
}

function joinSelected() {
  if (!selectedRoomId) { alert('Select a room first!'); return; }
  const name = document.getElementById('playerName').value.trim() || 'TANK_' + Math.floor(Math.random()*999);
  socket.emit('joinRoom', { roomId: selectedRoomId, playerName: name.toUpperCase() });
}

function createRoom() {
  const name = document.getElementById('newRoomName').value.trim() || 'BATTLE ROOM';
  const mapIndex = parseInt(document.getElementById('mapSelect').value);
  socket.emit('createRoom', { name, mapIndex });
}

function refreshRooms() {
  socket.emit('getRooms');
  socket.once('roomList', renderRoomList);
}

// ── Game Screen ───────────────────────────────────────────
function showScreen(id) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  document.getElementById(id).classList.add('active');
}

function leaveGame() {
  document.getElementById('gameOverlay').classList.remove('show');
  socket.disconnect();
  socket.connect();
  showScreen('lobbyScreen');
  gameState = null;
  mapData = null;
  currentRoomId = null;
  socket.emit('roomList');
}

function requestRestart() {
  socket.emit('restartGame');
}

// ── Input ─────────────────────────────────────────────────
document.addEventListener('keydown', e => {
  keys[e.code] = true;
  if (['Space','ArrowUp','ArrowDown','ArrowLeft','ArrowRight'].includes(e.code)) {
    e.preventDefault();
  }
  if (e.code === 'Escape') leaveGame();
});
document.addEventListener('keyup', e => { keys[e.code] = false; });

// Mobile touch controls (virtual joystick stub)
let touchDir = null;

function sendInput() {
  if (!currentRoomId) return;
  socket.emit('input', {
    up:    keys['ArrowUp']    || keys['KeyW'],
    down:  keys['ArrowDown']  || keys['KeyS'],
    left:  keys['ArrowLeft']  || keys['KeyA'],
    right: keys['ArrowRight'] || keys['KeyD'],
    shoot: keys['Space']      || keys['Enter'],
  });
}

setInterval(sendInput, 33);

function sendChat() {
  const inp = document.getElementById('chatInput');
  if (!inp.value.trim()) return;
  socket.emit('chat', inp.value.trim());
  inp.value = '';
}

// ── HUD ───────────────────────────────────────────────────
function updateHUD(state) {
  // Players
  const hud = document.getElementById('playerHud');
  hud.innerHTML = state.players.map(p => `
    <div class="player-row">
      <div class="player-color-dot" style="background:${p.color}"></div>
      <span>${escHtml(p.name.slice(0,8))}</span>
      <span class="player-lives">${'♥'.repeat(Math.max(0,p.lives))}</span>
      <span class="player-score">${p.score}</span>
    </div>
  `).join('');

  // Enemies
  const total = state.enemiesRemaining + state.enemiesOnField;
  const counter = document.getElementById('enemyCounter');
  counter.innerHTML = Array(total).fill('<div class="enemy-icon"></div>').join('');
  document.getElementById('enemiesLeft').textContent =
    `${state.enemiesRemaining} REMAINING`;
}

function addChatMessage(type, msg, name) {
  const el = document.getElementById('chatMessages');
  const div = document.createElement('div');
  div.className = `chat-msg ${type}`;
  if (type === 'chat') {
    div.innerHTML = `<span class="chat-name">${escHtml(name)}:</span> ${escHtml(msg)}`;
  } else {
    div.textContent = msg;
  }
  el.appendChild(div);
  el.scrollTop = el.scrollHeight;
}

function showGameOver(state) {
  const overlay = document.getElementById('gameOverlay');
  overlay.classList.add('show');
  const title = document.getElementById('overlayTitle');
  if (state.winner === 'players') {
    title.textContent = '★ MISSION COMPLETE ★';
    title.className = 'win';
  } else {
    title.textContent = '✕ GAME OVER ✕';
    title.className = 'lose';
  }
  // Scores
  const scores = state.players.map(p => `${p.name}: ${p.score}`).join('  |  ');
  document.getElementById('overlayScore').textContent = scores;
}

// ── Renderer ──────────────────────────────────────────────
function gameLoop(ts) {
  requestAnimationFrame(gameLoop);
  const dt = ts - lastRender;
  lastRender = ts;
  animTick += dt;

  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  if (!gameState) {
    drawWaiting();
    return;
  }

  // Draw map
  drawMap();

  // Draw tanks (players)
  for (const p of gameState.players) {
    if (p.alive) drawTank(p.x, p.y, p.dir, p.color, p.shield, p.moving, false);
  }

  // Draw enemies
  for (const e of gameState.enemies) {
    if (e.alive) drawTank(e.x, e.y, e.dir, '#CC2222', false, e.moving, true);
  }

  // Draw bullets
  for (const b of gameState.bullets) {
    drawBullet(b);
  }

  // Draw bushes on top (so tanks appear under bush)
  drawBushLayer();
}

function drawWaiting() {
  ctx.fillStyle = '#111';
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  const blink = Math.floor(animTick / 500) % 2;
  if (blink) {
    ctx.fillStyle = '#FFD700';
    ctx.font = '8px "Press Start 2P"';
    ctx.textAlign = 'center';
    ctx.fillText('WAITING FOR', canvas.width/2, canvas.height/2 - 10);
    ctx.fillText('PLAYERS...', canvas.width/2, canvas.height/2 + 10);
  }

  // Animated tank icon
  const tx = canvas.width/2 - 7;
  const ty = canvas.height/2 + 40 + Math.sin(animTick/300) * 4;
  drawTankPixel(tx, ty, DIR.UP, '#FFD700', false);
}

function drawMap() {
  if (!mapData) return;
  for (let r = 0; r < ROWS; r++) {
    for (let c = 0; c < COLS; c++) {
      const tile = mapData[r * COLS + c];
      const px = c * TILE;
      const py = r * TILE;
      if (tile === 0) continue;
      if (tile === 5) { drawEagle(px, py); continue; }
      if (tile === 4) continue; // Draw bushes after tanks
      drawTile(px, py, tile);
    }
  }
}

function drawBushLayer() {
  if (!mapData) return;
  for (let r = 0; r < ROWS; r++) {
    for (let c = 0; c < COLS; c++) {
      if (mapData[r * COLS + c] === 4) {
        drawTile(c * TILE, r * TILE, 4);
      }
    }
  }
}

function drawTile(px, py, type) {
  const c = TILE_COLORS[type];
  if (!c) return;

  if (type === 1) {
    // Brick pattern
    ctx.fillStyle = c.main;
    ctx.fillRect(px, py, TILE, TILE);
    ctx.fillStyle = c.dark;
    // mortar lines
    ctx.fillRect(px, py + 7, TILE, 2);
    ctx.fillRect(px + 7, py, 2, 7);
    ctx.fillRect(px + 3, py + 9, 2, 7);
    ctx.fillRect(px + 11, py + 9, 2, 7);
  } else if (type === 2) {
    // Steel
    ctx.fillStyle = c.dark;
    ctx.fillRect(px, py, TILE, TILE);
    ctx.fillStyle = c.main;
    ctx.fillRect(px+1, py+1, TILE-2, TILE-2);
    ctx.fillStyle = c.light;
    ctx.fillRect(px+1, py+1, TILE-2, 2);
    ctx.fillRect(px+1, py+1, 2, TILE-2);
    ctx.fillStyle = c.dark;
    ctx.fillRect(px+1, py+TILE-3, TILE-2, 2);
    ctx.fillRect(px+TILE-3, py+1, 2, TILE-2);
    // cross
    ctx.fillStyle = c.dark;
    ctx.fillRect(px + TILE/2 - 1, py+2, 2, TILE-4);
    ctx.fillRect(px+2, py + TILE/2 - 1, TILE-4, 2);
  } else if (type === 3) {
    // Water (animated)
    const wave = Math.floor(animTick / 400) % 2;
    ctx.fillStyle = c.main;
    ctx.fillRect(px, py, TILE, TILE);
    ctx.fillStyle = c.light;
    if (wave === 0) {
      ctx.fillRect(px+1, py+3, 6, 2);
      ctx.fillRect(px+9, py+11, 6, 2);
    } else {
      ctx.fillRect(px+5, py+7, 6, 2);
      ctx.fillRect(px+1, py+11, 6, 2);
    }
  } else if (type === 4) {
    // Bush
    ctx.fillStyle = c.dark;
    ctx.fillRect(px, py, TILE, TILE);
    ctx.fillStyle = c.main;
    ctx.fillRect(px+1, py+1, 6, 6);
    ctx.fillRect(px+9, py+1, 6, 6);
    ctx.fillRect(px+5, py+5, 6, 6);
    ctx.fillRect(px+1, py+9, 6, 6);
    ctx.fillRect(px+9, py+9, 6, 6);
    ctx.fillStyle = c.light;
    ctx.fillRect(px+2, py+2, 2, 2);
    ctx.fillRect(px+10, py+2, 2, 2);
  }
}

function drawEagle(px, py) {
  // Eagle/base pixel art
  const pixels = [
    '  XXXXX  ',
    ' XXXXXXX ',
    'XXXXXXXXX',
    'X XXXXX X',
    'XX     XX',
    'XXXXXXXXX',
    ' XXXXXXX ',
    '  XXXXX  ',
  ];
  // Scale to 16x16
  const scale = 2;
  for (let r = 0; r < pixels.length; r++) {
    for (let c = 0; c < pixels[r].length; c++) {
      if (pixels[r][c] === 'X') {
        ctx.fillStyle = (r + c) % 2 === 0 ? '#FFD700' : '#FF8C00';
        ctx.fillRect(px + c * scale - scale, py + r * scale, scale, scale);
      }
    }
  }
}

function drawTank(x, y, dir, color, shielded, moving, isEnemy) {
  ctx.save();
  ctx.translate(x + TANK_SIZE/2, y + TANK_SIZE/2);

  const angle = dir * Math.PI / 2;
  ctx.rotate(angle);

  const s = TANK_SIZE;
  const hs = s / 2;

  // Body
  ctx.fillStyle = isEnemy ? '#8B1A1A' : darken(color, 0.3);
  ctx.fillRect(-hs, -hs, s, s);

  // Main body highlight
  ctx.fillStyle = color;
  ctx.fillRect(-hs+1, -hs+1, s-2, s-4);

  // Tracks left
  ctx.fillStyle = '#333';
  ctx.fillRect(-hs, -hs, 3, s);
  // Track tread marks
  ctx.fillStyle = '#555';
  const trackOff = moving ? Math.floor(animTick / 80) % 3 : 0;
  for (let i = 0; i < 4; i++) {
    ctx.fillRect(-hs+1, -hs + ((i * 4 + trackOff) % s), 1, 2);
  }

  // Tracks right
  ctx.fillStyle = '#333';
  ctx.fillRect(hs-3, -hs, 3, s);
  ctx.fillStyle = '#555';
  for (let i = 0; i < 4; i++) {
    ctx.fillRect(hs-2, -hs + ((i * 4 + trackOff) % s), 1, 2);
  }

  // Turret
  ctx.fillStyle = darken(color, 0.2);
  ctx.fillRect(-3, -3, 6, 6);

  // Barrel (pointing up in local coords = dir)
  ctx.fillStyle = darken(color, 0.4);
  ctx.fillRect(-1.5, -hs-2, 3, hs);

  ctx.restore();

  // Shield effect
  if (shielded) {
    const blink = Math.floor(animTick / 100) % 2;
    if (blink) {
      ctx.save();
      ctx.strokeStyle = 'rgba(255,255,200,0.8)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.arc(x + TANK_SIZE/2, y + TANK_SIZE/2, TANK_SIZE/2 + 3, 0, Math.PI*2);
      ctx.stroke();
      ctx.restore();
    }
  }
}

function drawTankPixel(x, y, dir, color, isEnemy) {
  drawTank(x, y, dir, color, false, true, isEnemy);
}

function drawBullet(b) {
  const isHoriz = b.dir === DIR.LEFT || b.dir === DIR.RIGHT;
  ctx.fillStyle = b.isEnemy ? '#FF4444' : '#FFFF00';
  const w = isHoriz ? 6 : 3;
  const h = isHoriz ? 3 : 6;
  ctx.fillRect(b.x, b.y, w, h);

  // Glow
  ctx.fillStyle = b.isEnemy ? 'rgba(255,0,0,0.3)' : 'rgba(255,255,0,0.3)';
  ctx.fillRect(b.x - 1, b.y - 1, w + 2, h + 2);
}

function darken(hex, amount) {
  // Simple darken for hex color
  let r = parseInt(hex.slice(1,3), 16);
  let g = parseInt(hex.slice(3,5), 16);
  let b = parseInt(hex.slice(5,7), 16);
  r = Math.floor(r * (1 - amount));
  g = Math.floor(g * (1 - amount));
  b = Math.floor(b * (1 - amount));
  return `rgb(${r},${g},${b})`;
}

function escHtml(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

// Add ping support to server
socket.on('connect', () => {
  socket.on('pong_', () => {});
});
