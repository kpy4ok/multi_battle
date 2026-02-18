'use strict';

// ── Constants ──────────────────────────────────────────────
const TILE = 16, COLS = 26, ROWS = 26, TANK_SIZE = 14, BULLET_SIZE = 4;
const DIR = { UP:0, RIGHT:1, DOWN:2, LEFT:3 };
const DX  = [0, 1, 0, -1];
const DY  = [-1, 0, 1, 0];

// ── State ──────────────────────────────────────────────────
let socket, myId, currentRoomId, currentMode = 'coop';
let selectedRoomId = null;
let gameState = null, mapData = null;
let lastRender = 0, animTick = 0;
let pingMs = 0, pingStart = 0;
let autoLeaveTimer = null;  // countdown interval on game-over screen

const keys = {};
const canvas = document.getElementById('gameCanvas');
const ctx    = canvas.getContext('2d');
ctx.imageSmoothingEnabled = false;

// Mobile touch
const touch = { up:false, down:false, left:false, right:false, shoot:false };
let joystickTouchId = null, joystickOrigin = {x:0,y:0}, fireTouchId = null;

const TILE_COLORS = {
  1:{main:'#C84B11',dark:'#8B3009',light:'#FF6B2B'},
  2:{main:'#888',dark:'#555',light:'#AAA'},
  3:{main:'#0055AA',dark:'#003377',light:'#0077CC'},
  4:{main:'#1A5C1A',dark:'#0D3D0D',light:'#2A8C2A'},
  5:{main:'#FFD700',dark:'#B8860B',light:'#FFF'},
};

const MODE_LABELS = {
  coop:             'CO-OP',
  deathmatch:       'DEATHMATCH',
  deathmatch_bots:  'DM + BOTS',
};

// ── Socket ────────────────────────────────────────────────
socket = io();

socket.on('connect', () => {
  myId = socket.id;
  setInterval(() => { pingStart = Date.now(); socket.emit('ping_'); }, 2000);
});
socket.on('pong_', () => {
  pingMs = Date.now() - pingStart;
  const el = document.getElementById('pingDisplay');
  if (el) el.textContent = `PING: ${pingMs}ms`;
});
socket.on('roomList',  renderRoomList);
socket.on('mapList', (maps) => {
  const sel = document.getElementById('mapSelect');
  sel.innerHTML = maps.map(m =>
    `<option value="${m.index}">[${modeBadgeText(m.mode)}] ${m.name}</option>`
  ).join('');
});
socket.on('roomCreated', ({roomId}) => { selectedRoomId = roomId; joinSelected(); });
socket.on('joinedRoom', ({roomId, playerId, mapData:md, mode, fragLimit}) => {
  myId = playerId; currentRoomId = roomId; currentMode = mode || 'coop';
  mapData = md;
  updateModeUI();
  showScreen('gameScreen');
  resizeCanvas();
  requestAnimationFrame(gameLoop);
  addChatMessage('system', `Joined! Mode: ${MODE_LABELS[currentMode]}`);
});
socket.on('gameState', (state) => {
  gameState = state;
  currentMode = state.mode || currentMode;
  if (state.mapData) mapData = state.mapData;
  if (state.gameOver) showGameOver(state);
  updateHUD(state);
});
socket.on('gameRestarted', ({mapData:md, mode}) => {
  mapData = md; currentMode = mode || currentMode;
  document.getElementById('gameOverlay').classList.remove('show');
  gameState = null;
  updateModeUI();
});
// Server force-reset (35s auto-cleanup)
socket.on('serverReset', () => {
  if (autoLeaveTimer) { clearInterval(autoLeaveTimer); autoLeaveTimer = null; }
  leaveGame();
});
socket.on('playerJoined', ({name}) => addChatMessage('system', `${name} joined!`));
socket.on('playerLeft',   ()        => addChatMessage('system', 'A player left.'));
socket.on('chat', ({name, msg})     => addChatMessage('chat', msg, name));
socket.on('error', (msg)            => alert('Error: ' + msg));

// ── Lobby ─────────────────────────────────────────────────
function modeBadgeText(mode) {
  return {coop:'COOP',deathmatch:'DM',deathmatch_bots:'DM+BOT'}[mode] || mode;
}

function renderRoomList(rooms) {
  const el = document.getElementById('roomList');
  if (!rooms || !rooms.length) {
    el.innerHTML = '<div style="font-size:7px;color:#444;text-align:center;padding:20px">NO ROOMS — CREATE ONE!</div>';
    return;
  }
  el.innerHTML = rooms.map(r => `
    <div class="room-item ${selectedRoomId===r.id?'selected':''}" onclick="selectRoom('${r.id}',this)">
      <span class="room-name">${escHtml(r.name)}</span>
      <span class="mode-badge ${r.mode}">${modeBadgeText(r.mode)}</span>
      <span class="room-players" style="font-size:6px">${r.players}/${r.maxPlayers}</span>
      <span class="room-status ${r.status}">${r.status.toUpperCase()}</span>
    </div>`).join('');
}

function selectRoom(id, el) {
  selectedRoomId = id;
  document.querySelectorAll('.room-item').forEach(e => e.classList.remove('selected'));
  if (el) el.classList.add('selected');
}
function joinSelected() {
  if (!selectedRoomId) { alert('Select a room first!'); return; }
  const name = document.getElementById('playerName').value.trim() || 'TANK_'+Math.floor(Math.random()*999);
  socket.emit('joinRoom', { roomId: selectedRoomId, playerName: name.toUpperCase() });
}
function createRoom() {
  const name = document.getElementById('newRoomName').value.trim() || 'BATTLE ROOM';
  socket.emit('createRoom', { name, mapIndex: parseInt(document.getElementById('mapSelect').value) });
}
function refreshRooms() { socket.emit('getRooms'); }

// ── Mode UI helpers ───────────────────────────────────────
function updateModeUI() {
  const lbl = document.getElementById('gameModeLabel');
  if (lbl) { lbl.textContent = MODE_LABELS[currentMode] || currentMode; lbl.className = currentMode; }

  const isDM = currentMode === 'deathmatch' || currentMode === 'deathmatch_bots';

  // Hide enemy section in DM
  const enemySec = document.getElementById('enemySection');
  if (enemySec) enemySec.style.display = isDM ? 'none' : '';

  // Hide mob enemy box in DM
  const mobEB = document.getElementById('mobEnemyBox');
  if (mobEB) mobEB.style.display = isDM ? 'none' : '';

  // Update titles
  const st = document.getElementById('scoreboardTitle');
  if (st) st.textContent = isDM ? '🏆 SCOREBOARD' : '▶ PLAYERS';
  const mt = document.getElementById('mobScoreTitle');
  if (mt) mt.textContent = isDM ? '🏆 SCORE' : '▶ PLAYERS';
}

// ── Screen helpers ────────────────────────────────────────
function isMobile() { return window.matchMedia('(pointer:coarse)').matches || window.innerWidth < 768; }

function showScreen(id) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  document.getElementById(id).classList.add('active');
  const mc = document.getElementById('mobileControls');
  if (mc) mc.style.display = (id==='gameScreen' && isMobile()) ? 'flex' : 'none';
}
function leaveGame() {
  if (autoLeaveTimer) { clearInterval(autoLeaveTimer); autoLeaveTimer = null; }
  document.getElementById('gameOverlay').classList.remove('show');
  socket.disconnect(); socket.connect();
  showScreen('lobbyScreen');
  gameState = null; mapData = null; currentRoomId = null; currentMode = 'coop';
  socket.emit('roomList');
}
function requestRestart() {
  if (autoLeaveTimer) { clearInterval(autoLeaveTimer); autoLeaveTimer = null; }
  socket.emit('restartGame');
}

// ── Canvas resize ─────────────────────────────────────────
function resizeCanvas() {
  const mob = isMobile();
  const ctrlH   = mob ? 190 : 0;
  const safePad = mob ? 44 : 0;
  const safeBot = mob ? 0  : 0;
  const sideW   = mob ? 0  : 220;
  const pad = 8;
  const avW = window.innerWidth  - sideW - pad*2;
  const avH = window.innerHeight - ctrlH - safePad - safeBot - pad*2;
  const size = Math.min(avW, avH, 560);
  canvas.style.width = size+'px'; canvas.style.height = size+'px';
}
window.addEventListener('resize', resizeCanvas);

// ── Keyboard ──────────────────────────────────────────────
document.addEventListener('keydown', e => {
  keys[e.code] = true;
  if (['Space','ArrowUp','ArrowDown','ArrowLeft','ArrowRight'].includes(e.code)) e.preventDefault();
  if (e.code==='Escape') leaveGame();
});
document.addEventListener('keyup', e => { keys[e.code] = false; });

// ── Virtual Joystick ─────────────────────────────────────
function setupTouchControls() {
  const zone    = document.getElementById('joystickZone');
  const fireBtn = document.getElementById('fireBtn');
  if (!zone || !fireBtn) return;

  zone.addEventListener('touchstart', e => {
    e.preventDefault();
    const t = e.changedTouches[0];
    joystickTouchId = t.identifier;
    joystickOrigin  = {x:t.clientX, y:t.clientY};
    moveKnob(0,0);
  }, {passive:false});

  zone.addEventListener('touchmove', e => {
    e.preventDefault();
    for (const t of e.changedTouches) {
      if (t.identifier !== joystickTouchId) continue;
      const dx = t.clientX - joystickOrigin.x, dy = t.clientY - joystickOrigin.y;
      const dist = Math.hypot(dx, dy), dead = 14;
      touch.up = touch.down = touch.left = touch.right = false;
      if (dist > dead) {
        const a = Math.atan2(dy, dx);
        if      (a > -Math.PI*3/4 && a < -Math.PI/4) touch.up    = true;
        else if (a >  Math.PI/4   && a <  Math.PI*3/4) touch.down  = true;
        else if (Math.abs(a) > Math.PI*3/4)             touch.left  = true;
        else                                             touch.right = true;
      }
      const cl = 38;
      moveKnob(Math.max(-cl,Math.min(cl,dx)), Math.max(-cl,Math.min(cl,dy)));
    }
  }, {passive:false});

  const endJoy = e => {
    e.preventDefault();
    for (const t of e.changedTouches)
      if (t.identifier === joystickTouchId) {
        touch.up=touch.down=touch.left=touch.right=false;
        joystickTouchId=null; moveKnob(0,0);
      }
  };
  zone.addEventListener('touchend',    endJoy, {passive:false});
  zone.addEventListener('touchcancel', endJoy, {passive:false});

  fireBtn.addEventListener('touchstart', e => {
    e.preventDefault(); touch.shoot=true;
    fireTouchId=e.changedTouches[0].identifier;
    fireBtn.classList.add('pressed');
  }, {passive:false});
  const endFire = e => {
    e.preventDefault();
    for (const t of e.changedTouches)
      if (t.identifier===fireTouchId) { touch.shoot=false; fireTouchId=null; fireBtn.classList.remove('pressed'); }
  };
  fireBtn.addEventListener('touchend',    endFire, {passive:false});
  fireBtn.addEventListener('touchcancel', endFire, {passive:false});
}

function moveKnob(dx, dy) {
  const knob = document.getElementById('joystickKnob');
  if (knob) knob.style.transform = `translate(calc(-50% + ${dx}px), calc(-50% + ${dy}px))`;
  ['up','down','left','right'].forEach(d => {
    const a = document.getElementById('dpad_'+d);
    if (a) a.classList.toggle('lit', !!touch[d]);
  });
}

// ── Input loop ────────────────────────────────────────────
function sendInput() {
  if (!currentRoomId) return;
  socket.emit('input', {
    up:    keys['ArrowUp']    || keys['KeyW'] || touch.up,
    down:  keys['ArrowDown']  || keys['KeyS'] || touch.down,
    left:  keys['ArrowLeft']  || keys['KeyA'] || touch.left,
    right: keys['ArrowRight'] || keys['KeyD'] || touch.right,
    shoot: keys['Space']      || keys['Enter']|| touch.shoot,
  });
}
setInterval(sendInput, 33);

// ── Chat ──────────────────────────────────────────────────
function sendChat() {
  const inp = document.getElementById('chatInput');
  if (!inp||!inp.value.trim()) return;
  socket.emit('chat', inp.value.trim()); inp.value='';
}
function sendMobChat() {
  const inp = document.getElementById('mobChatInput');
  if (!inp||!inp.value.trim()) return;
  socket.emit('chat', inp.value.trim()); inp.value=''; inp.blur();
}
function addChatMessage(type, msg, name) {
  const append = el => {
    if (!el) return;
    const div = document.createElement('div');
    div.className = `chat-msg ${type}`;
    div.innerHTML = type==='chat'
      ? `<span class="chat-name">${escHtml(name)}:</span> ${escHtml(msg)}`
      : escHtml(msg);
    el.appendChild(div);
    while (el.children.length > 40) el.removeChild(el.firstChild);
    el.scrollTop = el.scrollHeight;
  };
  append(document.getElementById('chatMessages'));
  append(document.getElementById('mobChatMessages'));
}

// ── HUD ───────────────────────────────────────────────────
function updateHUD(state) {
  const isDM = state.mode==='deathmatch' || state.mode==='deathmatch_bots';

  if (isDM) {
    renderDMScoreboard(state);
  } else {
    renderCoopHUD(state);
    renderEnemyCounter(state);
  }
}

function renderCoopHUD(state) {
  const html = state.players.map(p => `
    <div class="player-row">
      <div class="player-color-dot" style="background:${p.color}"></div>
      <span>${escHtml(p.name.slice(0,7))}</span>
      <span class="player-lives">${'♥'.repeat(Math.max(0,p.lives))}</span>
      <span class="player-score">${p.score}</span>
    </div>`).join('');
  const sc = document.getElementById('scoreboardContent');
  if (sc) sc.innerHTML = html;

  // Mobile
  const mob = document.getElementById('mobScoreContent');
  if (mob) mob.innerHTML = state.players.map(p => `
    <div class="mob-player-row">
      <div class="mob-color-dot" style="background:${p.color}"></div>
      <span>${escHtml(p.name.slice(0,5))}</span>
      <span class="mob-lives">${'♥'.repeat(Math.max(0,p.lives))}</span>
      <span class="mob-score">${p.score}</span>
    </div>`).join('');
}

function renderEnemyCounter(state) {
  const total = (state.enemiesRemaining||0) + (state.enemiesOnField||0);
  const icons = Array(Math.max(0,Math.min(total,30))).fill('<div class="enemy-icon"></div>').join('');
  const c = document.getElementById('enemyCounter'); if (c) c.innerHTML = icons;
  const l = document.getElementById('enemiesLeft');  if (l) l.textContent=`${state.enemiesRemaining} REMAINING`;
  const mc = document.getElementById('mobEnemyRow'); if (mc) mc.innerHTML = Array(Math.max(0,Math.min(total,20))).fill('<div class="mob-enemy-icon"></div>').join('');
  const ml = document.getElementById('mobEnemiesLeft'); if (ml) ml.textContent=`${state.enemiesRemaining} LEFT`;
}

function renderDMScoreboard(state) {
  // Combine players + bots, sort by frags desc
  const all = [...(state.players||[]), ...(state.bots||[])].sort((a,b) => b.score - a.score);

  const rows = all.map(p => `
    <tr class="${p.isBot?'bot-row':''}">
      <td><span style="color:${p.color}">■</span> ${escHtml(p.name.slice(0,8))}</td>
      <td class="frag-col">${p.score}</td>
      <td class="death-col">${p.deaths}</td>
    </tr>`).join('');

  const fragLim = state.fragLimit || 20;
  const html = `
    <table class="dm-table">
      <thead><tr><th>NAME</th><th>FRAGS</th><th>DEATHS</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
    <div class="dm-frag-limit">FRAG LIMIT: ${fragLim}</div>`;

  const sc = document.getElementById('scoreboardContent');
  if (sc) sc.innerHTML = html;

  // Mobile DM table (compact)
  const mobRows = all.slice(0,6).map(p => `
    <tr class="${p.isBot?'bot-row':''}">
      <td><span style="color:${p.color}">■</span>${escHtml(p.name.slice(0,5))}</td>
      <td class="frag-col">${p.score}</td>
      <td class="death-col">${p.deaths}</td>
    </tr>`).join('');

  const mob = document.getElementById('mobScoreContent');
  if (mob) mob.innerHTML = `
    <table class="mob-dm-table">
      <thead><tr><th>NAME</th><th>K</th><th>D</th></tr></thead>
      <tbody>${mobRows}</tbody>
    </table>`;
}

function showGameOver(state) {
  // Only trigger once
  if (document.getElementById('gameOverlay').classList.contains('show')) return;
  document.getElementById('gameOverlay').classList.add('show');

  const title = document.getElementById('overlayTitle');
  const isDM  = state.mode==='deathmatch'||state.mode==='deathmatch_bots';

  if (isDM) {
    title.textContent = `🏆 ${state.winner} WINS!`;
    title.className   = 'dm';
    const all = [...(state.players||[]), ...(state.bots||[])].sort((a,b)=>b.score-a.score);
    document.getElementById('overlayScore').innerHTML =
      all.map(p=>`<span style="color:${p.color}">■ ${escHtml(p.name)}</span>  ${p.score}K / ${p.deaths}D`).join('<br>');
  } else {
    title.textContent = state.winner==='players' ? '★ MISSION COMPLETE ★' : '✕ GAME OVER ✕';
    title.className   = state.winner==='players' ? 'win' : 'lose';
    document.getElementById('overlayScore').innerHTML =
      state.players.map(p=>`${escHtml(p.name)}: ${p.score} pts`).join('<br>');
  }

  // ── 30-second auto-redirect countdown ──────────────────
  if (autoLeaveTimer) clearInterval(autoLeaveTimer);
  let remaining = 30;
  const timerEl = document.getElementById('overlayCountdown');
  if (timerEl) timerEl.textContent = `LOBBY IN ${remaining}s`;

  autoLeaveTimer = setInterval(() => {
    remaining--;
    if (timerEl) timerEl.textContent = `LOBBY IN ${remaining}s`;
    if (remaining <= 0) {
      clearInterval(autoLeaveTimer);
      autoLeaveTimer = null;
      leaveGame();
    }
  }, 1000);
}

// ── Renderer ──────────────────────────────────────────────
function gameLoop(ts) {
  requestAnimationFrame(gameLoop);
  animTick += ts - lastRender; lastRender = ts;
  ctx.fillStyle='#000'; ctx.fillRect(0,0,canvas.width,canvas.height);
  if (!gameState) { drawWaiting(); return; }

  drawMap();

  // Players
  for (const p of gameState.players) if (p.alive) drawTank(p.x,p.y,p.dir,p.color,p.shield,p.moving,false, p.id===myId);

  // DM bots (rendered like enemy tanks)
  if (gameState.bots) for (const b of gameState.bots) if (b.alive) drawTank(b.x,b.y,b.dir,b.color,b.shield,b.moving,true, false);

  // Classic enemies
  for (const e of gameState.enemies) if (e.alive) drawTank(e.x,e.y,e.dir,'#CC2222',false,e.moving,true,false);

  // Bullets
  for (const b of gameState.bullets) drawBullet(b);

  drawBushLayer();

  // DM: draw player name tags
  if (gameState.mode==='deathmatch'||gameState.mode==='deathmatch_bots') {
    const scale = parseFloat(canvas.style.width) / canvas.width || 1;
    drawNameTags(gameState.players, gameState.bots||[], scale);
  }
}

function drawNameTags(players, bots, scale) {
  ctx.save();
  ctx.font = '4px "Press Start 2P"';
  ctx.textAlign = 'center';
  const all = [...players, ...bots];
  for (const p of all) {
    if (!p.alive) continue;
    const tx = p.x + TANK_SIZE/2;
    const ty = p.y - 3;
    ctx.fillStyle = p.isBot ? 'rgba(200,50,50,0.9)' : (p.id===myId ? '#FFD700' : 'rgba(255,255,255,0.8)');
    ctx.fillText(p.name.slice(0,6), tx, ty);
    // frag count
    ctx.fillStyle = '#44FF88';
    ctx.fillText(p.score+'K', tx, ty - 5);
  }
  ctx.restore();
}

function drawWaiting() {
  ctx.fillStyle='#111'; ctx.fillRect(0,0,canvas.width,canvas.height);
  if (Math.floor(animTick/500)%2) {
    ctx.fillStyle='#FFD700'; ctx.font='8px "Press Start 2P"'; ctx.textAlign='center';
    ctx.fillText('WAITING FOR', canvas.width/2, canvas.height/2-10);
    ctx.fillText('PLAYERS...', canvas.width/2, canvas.height/2+10);
  }
  drawTankPixel(canvas.width/2-7, canvas.height/2+40+Math.sin(animTick/300)*4, 0,'#FFD700',false);
}

function drawMap() {
  if (!mapData) return;
  for (let r=0;r<ROWS;r++) for (let c=0;c<COLS;c++) {
    const t=mapData[r*COLS+c]; if(!t) continue;
    if(t===5){drawEagle(c*TILE,r*TILE);continue;}
    if(t===4) continue;
    drawTile(c*TILE,r*TILE,t);
  }
}
function drawBushLayer() {
  if (!mapData) return;
  for (let r=0;r<ROWS;r++) for (let c=0;c<COLS;c++)
    if(mapData[r*COLS+c]===4) drawTile(c*TILE,r*TILE,4);
}

function drawTile(px,py,type) {
  const c=TILE_COLORS[type]; if(!c) return;
  if(type===1){
    ctx.fillStyle=c.main; ctx.fillRect(px,py,TILE,TILE);
    ctx.fillStyle=c.dark;
    ctx.fillRect(px,py+7,TILE,2); ctx.fillRect(px+7,py,2,7);
    ctx.fillRect(px+3,py+9,2,7); ctx.fillRect(px+11,py+9,2,7);
  } else if(type===2){
    ctx.fillStyle=c.dark; ctx.fillRect(px,py,TILE,TILE);
    ctx.fillStyle=c.main; ctx.fillRect(px+1,py+1,TILE-2,TILE-2);
    ctx.fillStyle=c.light; ctx.fillRect(px+1,py+1,TILE-2,2); ctx.fillRect(px+1,py+1,2,TILE-2);
    ctx.fillStyle=c.dark; ctx.fillRect(px+1,py+TILE-3,TILE-2,2); ctx.fillRect(px+TILE-3,py+1,2,TILE-2);
    ctx.fillRect(px+TILE/2-1,py+2,2,TILE-4); ctx.fillRect(px+2,py+TILE/2-1,TILE-4,2);
  } else if(type===3){
    const w=Math.floor(animTick/400)%2;
    ctx.fillStyle=c.main; ctx.fillRect(px,py,TILE,TILE);
    ctx.fillStyle=c.light;
    if(w===0){ctx.fillRect(px+1,py+3,6,2);ctx.fillRect(px+9,py+11,6,2);}
    else{ctx.fillRect(px+5,py+7,6,2);ctx.fillRect(px+1,py+11,6,2);}
  } else if(type===4){
    ctx.fillStyle=c.dark; ctx.fillRect(px,py,TILE,TILE);
    ctx.fillStyle=c.main;
    ctx.fillRect(px+1,py+1,6,6); ctx.fillRect(px+9,py+1,6,6);
    ctx.fillRect(px+5,py+5,6,6); ctx.fillRect(px+1,py+9,6,6); ctx.fillRect(px+9,py+9,6,6);
    ctx.fillStyle=c.light; ctx.fillRect(px+2,py+2,2,2); ctx.fillRect(px+10,py+2,2,2);
  }
}

function drawEagle(px,py) {
  const px2=['  XXXXX  ',' XXXXXXX ','XXXXXXXXX','X XXXXX X','XX     XX','XXXXXXXXX',' XXXXXXX ','  XXXXX  '];
  for(let r=0;r<px2.length;r++) for(let c=0;c<px2[r].length;c++)
    if(px2[r][c]==='X'){ctx.fillStyle=(r+c)%2===0?'#FFD700':'#FF8C00';ctx.fillRect(px+c*2-2,py+r*2,2,2);}
}

function drawTank(x,y,dir,color,shielded,moving,isEnemy,isMe) {
  ctx.save();
  ctx.translate(x+TANK_SIZE/2, y+TANK_SIZE/2);
  ctx.rotate(dir*Math.PI/2);
  const s=TANK_SIZE, hs=s/2;
  ctx.fillStyle=isEnemy?'#8B1A1A':darken(color,0.3); ctx.fillRect(-hs,-hs,s,s);
  ctx.fillStyle=color; ctx.fillRect(-hs+1,-hs+1,s-2,s-4);
  ctx.fillStyle='#333'; ctx.fillRect(-hs,-hs,3,s); ctx.fillRect(hs-3,-hs,3,s);
  ctx.fillStyle='#555';
  const off=moving?Math.floor(animTick/80)%3:0;
  for(let i=0;i<4;i++){ctx.fillRect(-hs+1,-hs+((i*4+off)%s),1,2);ctx.fillRect(hs-2,-hs+((i*4+off)%s),1,2);}
  ctx.fillStyle=darken(color,0.2); ctx.fillRect(-3,-3,6,6);
  ctx.fillStyle=darken(color,0.4); ctx.fillRect(-1.5,-hs-2,3,hs);
  ctx.restore();
  // Shield
  if(shielded&&Math.floor(animTick/100)%2){
    ctx.save(); ctx.strokeStyle='rgba(255,255,200,0.8)'; ctx.lineWidth=1;
    ctx.beginPath(); ctx.arc(x+TANK_SIZE/2,y+TANK_SIZE/2,TANK_SIZE/2+3,0,Math.PI*2); ctx.stroke(); ctx.restore();
  }
  // My tank outline
  if(isMe){
    ctx.save(); ctx.strokeStyle='rgba(255,255,0,0.5)'; ctx.lineWidth=1;
    ctx.strokeRect(x-1,y-1,TANK_SIZE+2,TANK_SIZE+2); ctx.restore();
  }
}

function drawTankPixel(x,y,dir,color,isEnemy){drawTank(x,y,dir,color,false,true,isEnemy,false);}

function drawBullet(b) {
  const isH=b.dir===DIR.LEFT||b.dir===DIR.RIGHT, w=isH?6:3, h=isH?3:6;
  // Color by team
  let col = '#FFFF00';
  if (b.team==='enemy') col='#FF4444';
  else if (b.team==='bot') col='#FF8C00';
  ctx.fillStyle=col==='#FFFF00'?'rgba(255,255,0,0.3)':col==='#FF4444'?'rgba(255,0,0,0.3)':'rgba(255,140,0,0.3)';
  ctx.fillRect(b.x-1,b.y-1,w+2,h+2);
  ctx.fillStyle=col; ctx.fillRect(b.x,b.y,w,h);
}

function darken(hex,a){
  let r=parseInt(hex.slice(1,3),16),g=parseInt(hex.slice(3,5),16),b=parseInt(hex.slice(5,7),16);
  return `rgb(${Math.floor(r*(1-a))},${Math.floor(g*(1-a))},${Math.floor(b*(1-a))})`;
}
function escHtml(s){return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');}

// ── Boot ──────────────────────────────────────────────────
setupTouchControls();
resizeCanvas();