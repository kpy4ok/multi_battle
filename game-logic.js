'use strict';

const { MAPS, SPAWN_POINTS, DM_SPAWN_POINTS, ENEMY_SPAWNS } = require('./maps');

const TILE_SIZE     = 16;
const MAP_COLS      = 26;
const MAP_ROWS      = 26;
const TANK_SIZE     = 14;
const BULLET_SPEED  = 5;
const TANK_SPEED    = 1.5;
const BULLET_SIZE   = 4;

// Classic mode
const MAX_ENEMIES   = 4;
const TOTAL_ENEMIES = 20;

// Deathmatch
const DM_FRAG_LIMIT       = 20;   // first to 20 kills wins
const DM_RESPAWN_DELAY_MS = 2000;
const DM_MAX_BOTS         = 4;    // bots in DM+bots mode

// Enemy AI
const ENEMY_SHOOT_INTERVAL = 2000;
const ENEMY_MOVE_INTERVAL  = 800;

const DIR = { UP: 0, RIGHT: 1, DOWN: 2, LEFT: 3 };
const DX  = [0, 1, 0, -1];
const DY  = [-1, 0, 1, 0];

// 8 distinct tank colors
const PLAYER_COLORS = [
  '#FFD700', '#00BFFF', '#FF6347', '#98FB98',
  '#FF69B4', '#FFA500', '#00FFFF', '#DA70D6',
];

// ── Game modes ────────────────────────────────────────────
// 'coop'            — classic, players vs AI enemies, protect eagle
// 'deathmatch'      — players kill each other, frag limit, no AI
// 'deathmatch_bots' — players + AI bots all kill each other

class GameRoom {
  constructor(id, mapIndex = 0) {
    this.id       = id;
    this.mapIndex = mapIndex;
    const map     = MAPS[mapIndex];
    this.mapData  = [...map.tiles];
    this.mode     = map.mode || 'coop';
    this.isDM     = this.mode === 'deathmatch' || this.mode === 'deathmatch_bots';
    this.maxPlayers = this.isDM ? 8 : 4;

    this.players  = {};      // socketId -> player
    this.bots     = [];      // DM bots (treated like players but AI-driven)
    this.bullets  = [];
    this.enemies  = [];      // classic mode AI tanks

    this.nextBulletId = 0;
    this.nextEnemyId  = 0;
    this.nextBotId    = 0;

    // Classic mode state
    this.enemiesRemaining = this.mode === 'coop' ? TOTAL_ENEMIES : 0;
    this.enemiesOnField   = 0;
    this.baseDestroyed    = false;

    // DM state
    this.fragLimit = DM_FRAG_LIMIT;

    this.gameOver    = false;
    this.winner      = null;   // name string in DM, 'players'/'enemies' in coop
    this.winnerId    = null;
    this.lastUpdate  = Date.now();
    this.tickInterval  = null;
    this.enemySpawnTimer = 0;

    // Pending respawns for DM: [{entity, timer}]
    this.respawnQueue = [];
  }

  // ── Public helpers ──────────────────────────────────────
  getPlayerCount() { return Object.keys(this.players).length; }

  getSpawnPoint(idx) {
    const pts = this.isDM ? DM_SPAWN_POINTS : SPAWN_POINTS;
    return pts[idx % pts.length];
  }

  addPlayer(socketId, name) {
    const idx   = Object.keys(this.players).length;
    const spawn = this.getSpawnPoint(idx);
    this.players[socketId] = {
      id:             socketId,
      name:           name || `Player${idx + 1}`,
      x:              spawn.x * TILE_SIZE + 1,
      y:              spawn.y * TILE_SIZE + 1,
      dir:            DIR.UP,
      alive:          true,
      lives:          this.isDM ? Infinity : 3,
      score:          0,   // frags in DM, points in coop
      deaths:         0,
      speed:          TANK_SPEED,
      moving:         false,
      color:          PLAYER_COLORS[idx % PLAYER_COLORS.length],
      shield:         3000,
      bulletCooldown: 0,
      isBot:          false,
      inputs:         { up: false, down: false, left: false, right: false, shoot: false },
      respawnTimer:   0,
    };
    return this.players[socketId];
  }

  removePlayer(socketId) { delete this.players[socketId]; }

  handleInput(socketId, inputs) {
    if (this.players[socketId]) this.players[socketId].inputs = inputs;
  }

  // ── Lifecycle ───────────────────────────────────────────
  start() {
    if (this.mode === 'coop') {
      this.spawnEnemy();
    } else if (this.mode === 'deathmatch_bots') {
      this._spawnBots();
    }
    this.tickInterval = setInterval(() => this.tick(), 33);
  }

  stop() {
    if (this.tickInterval) clearInterval(this.tickInterval);
  }

  // ── Main tick ───────────────────────────────────────────
  tick() {
    const now = Date.now();
    const dt  = now - this.lastUpdate;
    this.lastUpdate = now;
    if (this.gameOver) return;

    // Timers
    for (const p of Object.values(this.players)) {
      if (p.shield > 0)         p.shield         -= dt;
      if (p.bulletCooldown > 0) p.bulletCooldown -= dt;
    }
    for (const b of this.bots) {
      if (b.shield > 0)         b.shield         -= dt;
      if (b.bulletCooldown > 0) b.bulletCooldown -= dt;
    }

    // DM respawn queue
    if (this.isDM) this._processRespawns(dt);

    // Move human players
    this._updatePlayers(dt);

    // Move bots (DM bots) or classic enemies
    if (this.isDM) {
      this._updateBots(dt);
    } else {
      this.enemySpawnTimer += dt;
      if (this.enemySpawnTimer > 3000 && this.enemiesOnField < MAX_ENEMIES && this.enemiesRemaining > 0) {
        this.spawnEnemy();
        this.enemySpawnTimer = 0;
      }
      this._updateClassicEnemies(dt);
    }

    this._updateBullets();
    this._checkGameOver();
  }

  // ── Player movement ─────────────────────────────────────
  _updatePlayers(dt) {
    for (const p of Object.values(this.players)) {
      if (!p.alive) continue;
      const { up, down, left, right, shoot } = p.inputs;
      let moved = false;
      if      (up)    { p.dir = DIR.UP;    this._tryMove(p, 0, -p.speed); moved = true; }
      else if (down)  { p.dir = DIR.DOWN;  this._tryMove(p, 0,  p.speed); moved = true; }
      else if (left)  { p.dir = DIR.LEFT;  this._tryMove(p, -p.speed, 0); moved = true; }
      else if (right) { p.dir = DIR.RIGHT; this._tryMove(p,  p.speed, 0); moved = true; }
      p.moving = moved;
      if (shoot && p.bulletCooldown <= 0) {
        this._fireBullet(p, 'player');
        p.bulletCooldown = 380;
      }
    }
  }

  // ── Bot AI (DM bots) ────────────────────────────────────
  _spawnBots() {
    const count = DM_MAX_BOTS;
    for (let i = 0; i < count; i++) {
      const idx   = Object.keys(this.players).length + i;
      const spawn = this.getSpawnPoint(idx);
      const bot = {
        id:             'bot_' + this.nextBotId++,
        name:           ['ROBO-X', 'IRON-T', 'STEEL-K', 'MECH-Q', 'CYBER', 'METAL', 'DREAD', 'BLAZE'][i % 8],
        x:              spawn.x * TILE_SIZE + 1,
        y:              spawn.y * TILE_SIZE + 1,
        dir:            DIR.DOWN,
        alive:          true,
        lives:          Infinity,
        score:          0,
        deaths:         0,
        speed:          1.0,
        moving:         false,
        color:          '#CC2222',
        shield:         2000,
        bulletCooldown: 0,
        isBot:          true,
        moveTimer:      Math.random() * 1000,
        shootTimer:     Math.random() * 2000,
        targetId:       null,
        respawnTimer:   0,
      };
      this.bots.push(bot);
    }
  }

  _updateBots(dt) {
    const allTargets = [...Object.values(this.players), ...this.bots];

    for (const bot of this.bots) {
      if (!bot.alive) continue;
      if (bot.bulletCooldown > 0) bot.bulletCooldown -= dt;
      if (bot.shield > 0)         bot.shield         -= dt;

      // Find nearest living enemy (any player or other bot)
      let nearest = null, nearestDist = Infinity;
      for (const t of allTargets) {
        if (t === bot || !t.alive) continue;
        const dx = t.x - bot.x, dy = t.y - bot.y;
        const d  = Math.hypot(dx, dy);
        if (d < nearestDist) { nearestDist = d; nearest = t; }
      }

      // Movement: steer toward nearest target, jitter to avoid getting stuck
      bot.moveTimer += dt;
      if (bot.moveTimer > ENEMY_MOVE_INTERVAL) {
        bot.moveTimer = 0;
        if (nearest) {
          const dx = nearest.x - bot.x, dy = nearest.y - bot.y;
          const r  = Math.random();
          if (r < 0.6) {
            // Chase
            if (Math.abs(dx) > Math.abs(dy)) bot.dir = dx > 0 ? DIR.RIGHT : DIR.LEFT;
            else                              bot.dir = dy > 0 ? DIR.DOWN  : DIR.UP;
          } else {
            bot.dir = Math.floor(Math.random() * 4);
          }
        } else {
          bot.dir = Math.floor(Math.random() * 4);
        }
      }

      const prevX = bot.x, prevY = bot.y;
      this._tryMove(bot, DX[bot.dir] * bot.speed, DY[bot.dir] * bot.speed);
      if (bot.x === prevX && bot.y === prevY) bot.dir = (bot.dir + 1) % 4;
      bot.moving = true;

      // Shoot toward nearest or in movement direction
      bot.shootTimer = (bot.shootTimer || 0) + dt;
      if (bot.shootTimer > 1500 + Math.random() * 1000 && bot.bulletCooldown <= 0) {
        bot.shootTimer = 0;
        // Aim at nearest target
        if (nearest) {
          const dx = nearest.x - bot.x, dy = nearest.y - bot.y;
          if (Math.abs(dx) > Math.abs(dy)) bot.dir = dx > 0 ? DIR.RIGHT : DIR.LEFT;
          else                             bot.dir = dy > 0 ? DIR.DOWN  : DIR.UP;
        }
        this._fireBullet(bot, 'bot');
        bot.bulletCooldown = 500;
      }
    }
  }

  // ── Classic enemy AI ────────────────────────────────────
  _updateClassicEnemies(dt) {
    for (const e of this.enemies) {
      if (!e.alive) continue;
      e.moveTimer = (e.moveTimer || 0) + dt;
      if (e.moveTimer > ENEMY_MOVE_INTERVAL) {
        e.moveTimer = 0;
        const r = Math.random();
        if      (r < 0.4) e.dir = DIR.DOWN;
        else if (r < 0.6) e.dir = DIR.LEFT;
        else if (r < 0.8) e.dir = DIR.RIGHT;
        else               e.dir = DIR.UP;
      }
      const prevX = e.x, prevY = e.y;
      this._tryMove(e, DX[e.dir] * e.speed, DY[e.dir] * e.speed);
      if (e.x === prevX && e.y === prevY) e.dir = (e.dir + 1) % 4;
      e.moving = true;
      e.shootTimer = (e.shootTimer || 0) + dt;
      if (e.shootTimer > ENEMY_SHOOT_INTERVAL) {
        e.shootTimer = 0;
        this._fireBullet(e, 'enemy');
      }
    }
  }

  // ── Movement / collision ────────────────────────────────
  _tryMove(entity, dx, dy) {
    const nx = entity.x + dx, ny = entity.y + dy;
    if (nx < 0 || ny < 0 || nx + TANK_SIZE > MAP_COLS * TILE_SIZE || ny + TANK_SIZE > MAP_ROWS * TILE_SIZE) return;
    if (!this._collidesWithTiles(nx, ny)) {
      if (!this._collidesWithTanks(entity, nx, ny)) {
        entity.x = nx; entity.y = ny;
      }
    }
  }

  _collidesWithTiles(x, y) {
    const passable = new Set([0, 4]);
    const x1 = Math.floor(x / TILE_SIZE),             y1 = Math.floor(y / TILE_SIZE);
    const x2 = Math.floor((x + TANK_SIZE - 1) / TILE_SIZE), y2 = Math.floor((y + TANK_SIZE - 1) / TILE_SIZE);
    for (let ty = y1; ty <= y2; ty++) for (let tx = x1; tx <= x2; tx++) {
      if (tx < 0 || ty < 0 || tx >= MAP_COLS || ty >= MAP_ROWS) return true;
      if (!passable.has(this.mapData[ty * MAP_COLS + tx])) return true;
    }
    return false;
  }

  _collidesWithTanks(entity, nx, ny) {
    const check = (other) => {
      if (other === entity || !other.alive) return false;
      return nx < other.x + TANK_SIZE && nx + TANK_SIZE > other.x &&
             ny < other.y + TANK_SIZE && ny + TANK_SIZE > other.y;
    };
    for (const p of Object.values(this.players)) if (check(p)) return true;
    for (const b of this.bots)    if (check(b)) return true;
    for (const e of this.enemies) if (check(e)) return true;
    return false;
  }

  // ── Bullets ─────────────────────────────────────────────
  _fireBullet(source, team) {
    // team: 'player' | 'bot' | 'enemy'
    const cx  = source.x + TANK_SIZE / 2;
    const cy  = source.y + TANK_SIZE / 2;
    const dir = source.dir;
    this.bullets.push({
      id:      this.nextBulletId++,
      x:       cx - BULLET_SIZE / 2 + DX[dir] * (TANK_SIZE / 2),
      y:       cy - BULLET_SIZE / 2 + DY[dir] * (TANK_SIZE / 2),
      dir,
      speed:   BULLET_SPEED,
      team,
      ownerId: source.id,
    });
  }

  _bulletHits(b, tank) {
    return b.x < tank.x + TANK_SIZE && b.x + BULLET_SIZE > tank.x &&
           b.y < tank.y + TANK_SIZE && b.y + BULLET_SIZE > tank.y;
  }

  _updateBullets() {
    for (let i = this.bullets.length - 1; i >= 0; i--) {
      const b = this.bullets[i];
      b.x += DX[b.dir] * b.speed;
      b.y += DY[b.dir] * b.speed;
      let dead = false;

      // Bounds
      if (b.x < 0 || b.y < 0 || b.x >= MAP_COLS * TILE_SIZE || b.y >= MAP_ROWS * TILE_SIZE) {
        dead = true;
      }

      // Tiles
      if (!dead) {
        const tx = Math.floor((b.x + BULLET_SIZE / 2) / TILE_SIZE);
        const ty = Math.floor((b.y + BULLET_SIZE / 2) / TILE_SIZE);
        if (tx >= 0 && ty >= 0 && tx < MAP_COLS && ty < MAP_ROWS) {
          const idx  = ty * MAP_COLS + tx;
          const tile = this.mapData[idx];
          if (tile === 1) { this.mapData[idx] = 0; dead = true; }
          else if (tile === 2) { dead = true; }
          else if (tile === 5 && this.mode === 'coop') {
            this.mapData[idx] = 0;
            this.baseDestroyed = true;
            this.gameOver = true;
            this.winner   = 'enemies';
            dead = true;
          }
        }
      }

      // ── Hit resolution per mode ───────────────────────
      if (!dead) {
        if (this.isDM) {
          dead = this._resolveDMHit(b);
        } else {
          dead = this._resolveCoopHit(b);
        }
      }

      if (dead) this.bullets.splice(i, 1);
    }
  }

  // Coop: enemy bullets hurt players; player bullets hurt enemies
  _resolveCoopHit(b) {
    if (b.team === 'enemy') {
      for (const p of Object.values(this.players)) {
        if (!p.alive || p.shield > 0) continue;
        if (this._bulletHits(b, p)) {
          this._hitPlayer(p, null);
          return true;
        }
      }
    } else {
      // player bullet hits classic enemy
      for (let j = this.enemies.length - 1; j >= 0; j--) {
        const e = this.enemies[j];
        if (!e.alive) continue;
        if (this._bulletHits(b, e)) {
          e.alive = false;
          this.enemies.splice(j, 1);
          this.enemiesOnField--;
          if (this.players[b.ownerId]) this.players[b.ownerId].score += 100;
          return true;
        }
      }
    }
    return false;
  }

  // Deathmatch: any bullet can hit any living tank except same owner
  _resolveDMHit(b) {
    const allTargets = [...Object.values(this.players), ...this.bots];
    for (const t of allTargets) {
      if (!t.alive || t.id === b.ownerId || t.shield > 0) continue;
      if (this._bulletHits(b, t)) {
        // Find killer
        const killer = this.players[b.ownerId] || this.bots.find(bt => bt.id === b.ownerId);
        this._dmKill(t, killer);
        return true;
      }
    }
    return false;
  }

  _dmKill(victim, killer) {
    victim.alive  = false;
    victim.deaths = (victim.deaths || 0) + 1;
    if (killer) killer.score++;  // frag
    // Queue respawn
    this.respawnQueue.push({ entity: victim, timer: DM_RESPAWN_DELAY_MS });
  }

  _processRespawns(dt) {
    for (let i = this.respawnQueue.length - 1; i >= 0; i--) {
      this.respawnQueue[i].timer -= dt;
      if (this.respawnQueue[i].timer <= 0) {
        this._dmRespawn(this.respawnQueue[i].entity);
        this.respawnQueue.splice(i, 1);
      }
    }
  }

  _dmRespawn(entity) {
    // Pick a spawn point not occupied by anyone
    const pts = DM_SPAWN_POINTS;
    let best  = pts[Math.floor(Math.random() * pts.length)];
    // Try to pick the farthest from any living entity
    let maxMinDist = -1;
    const living = [...Object.values(this.players), ...this.bots].filter(e => e.alive && e !== entity);
    for (const pt of pts) {
      const px = pt.x * TILE_SIZE, py = pt.y * TILE_SIZE;
      const minDist = living.reduce((m, e) => Math.min(m, Math.hypot(e.x - px, e.y - py)), Infinity);
      if (minDist > maxMinDist) { maxMinDist = minDist; best = pt; }
    }
    entity.x      = best.x * TILE_SIZE + 1;
    entity.y      = best.y * TILE_SIZE + 1;
    entity.alive  = true;
    entity.shield = 2000;
  }

  // Coop: player hit
  _hitPlayer(p, killer) {
    p.lives--;
    if (p.lives <= 0) {
      p.alive = false;
    } else {
      const idx   = Object.keys(this.players).indexOf(p.id);
      const spawn = SPAWN_POINTS[idx % SPAWN_POINTS.length];
      p.x = spawn.x * TILE_SIZE + 1;
      p.y = spawn.y * TILE_SIZE + 1;
      p.shield = 2000;
    }
  }

  // ── Classic enemy spawning ──────────────────────────────
  spawnEnemy() {
    if (this.enemiesRemaining <= 0) return;
    const spawnPt = ENEMY_SPAWNS[this.nextEnemyId % ENEMY_SPAWNS.length];
    this.enemies.push({
      id:          'e' + this.nextEnemyId++,
      x:           spawnPt.x * TILE_SIZE + 1,
      y:           spawnPt.y * TILE_SIZE + 1,
      dir:         DIR.DOWN,
      alive:       true,
      isEnemy:     true,
      speed:       0.8,
      moveTimer:   0,
      shootTimer:  Math.random() * 2000,
      moving:      false,
    });
    this.enemiesOnField++;
    this.enemiesRemaining--;
  }

  // ── Game over checks ────────────────────────────────────
  _checkGameOver() {
    if (this.gameOver) return;

    if (this.isDM) {
      // First player or bot to reach frag limit
      const allCombatants = [...Object.values(this.players), ...this.bots];
      for (const c of allCombatants) {
        if (c.score >= this.fragLimit) {
          this.gameOver = true;
          this.winner   = c.name;
          this.winnerId = c.id;
          return;
        }
      }
    } else {
      // Coop: all players dead
      const alive = Object.values(this.players).filter(p => p.lives > 0);
      if (alive.length === 0 && Object.keys(this.players).length > 0) {
        this.gameOver = true; this.winner = 'enemies'; return;
      }
      // All enemies defeated
      if (this.enemiesRemaining <= 0 && this.enemies.length === 0) {
        this.gameOver = true; this.winner = 'players';
      }
    }
  }

  // ── State snapshot ──────────────────────────────────────
  getState() {
    return {
      mode:     this.mode,
      mapData:  this.mapData,
      players:  Object.values(this.players).map(p => ({
        id:     p.id,
        name:   p.name,
        x:      p.x,
        y:      p.y,
        dir:    p.dir,
        alive:  p.alive,
        lives:  isFinite(p.lives) ? p.lives : -1,
        score:  p.score,
        deaths: p.deaths || 0,
        color:  p.color,
        shield: p.shield > 0,
        moving: p.moving,
        isBot:  false,
      })),
      bots: this.bots.map(b => ({
        id:     b.id,
        name:   b.name,
        x:      b.x,
        y:      b.y,
        dir:    b.dir,
        alive:  b.alive,
        lives:  -1,
        score:  b.score,
        deaths: b.deaths || 0,
        color:  b.color,
        shield: b.shield > 0,
        moving: b.moving,
        isBot:  true,
      })),
      enemies: this.enemies.map(e => ({
        id: e.id, x: e.x, y: e.y, dir: e.dir, alive: e.alive, moving: e.moving,
      })),
      bullets: this.bullets.map(b => ({
        id: b.id, x: b.x, y: b.y, dir: b.dir,
        isEnemy: b.team === 'enemy' || b.team === 'bot',
        team: b.team,
      })),
      gameOver:         this.gameOver,
      winner:           this.winner,
      winnerId:         this.winnerId,
      enemiesRemaining: this.enemiesRemaining,
      enemiesOnField:   this.enemiesOnField,
      fragLimit:        this.fragLimit,
    };
  }
}

module.exports = { GameRoom, MAPS };