'use strict';

const { MAPS, SPAWN_POINTS, ENEMY_SPAWNS } = require('./maps');

const TILE_SIZE = 16;
const MAP_COLS = 26;
const MAP_ROWS = 26;
const TANK_SIZE = 14;
const BULLET_SPEED = 5;
const TANK_SPEED = 1.5;
const BULLET_SIZE = 4;
const ENEMY_SHOOT_INTERVAL = 2000; // ms
const ENEMY_MOVE_INTERVAL = 800;
const MAX_ENEMIES = 4;
const TOTAL_ENEMIES = 20;

// Directions
const DIR = { UP: 0, RIGHT: 1, DOWN: 2, LEFT: 3 };
const DX = [0, 1, 0, -1];
const DY = [-1, 0, 1, 0];

class GameRoom {
  constructor(id, mapIndex = 0) {
    this.id = id;
    this.mapIndex = mapIndex;
    this.mapData = [...MAPS[mapIndex].tiles];
    this.players = {}; // socketId -> player state
    this.bullets = [];
    this.enemies = [];
    this.nextBulletId = 0;
    this.nextEnemyId = 0;
    this.enemiesRemaining = TOTAL_ENEMIES;
    this.enemiesOnField = 0;
    this.gameOver = false;
    this.winner = null;
    this.lastUpdate = Date.now();
    this.tickInterval = null;
    this.enemyShootTimer = 0;
    this.enemySpawnTimer = 0;
    this.baseDestroyed = false;
  }

  getPlayerCount() {
    return Object.keys(this.players).length;
  }

  addPlayer(socketId, name) {
    const idx = Object.keys(this.players).length;
    const spawn = SPAWN_POINTS[idx % SPAWN_POINTS.length];
    this.players[socketId] = {
      id: socketId,
      name: name || `Player${idx + 1}`,
      x: spawn.x * TILE_SIZE + 1,
      y: spawn.y * TILE_SIZE + 1,
      dir: DIR.UP,
      alive: true,
      lives: 3,
      score: 0,
      speed: TANK_SPEED,
      moving: false,
      color: ['#FFD700', '#00BFFF', '#FF6347', '#98FB98'][idx % 4],
      shield: 3000, // spawn protection ms
      bulletCooldown: 0,
      inputs: { up: false, down: false, left: false, right: false, shoot: false }
    };
    return this.players[socketId];
  }

  removePlayer(socketId) {
    delete this.players[socketId];
  }

  handleInput(socketId, inputs) {
    if (this.players[socketId]) {
      this.players[socketId].inputs = inputs;
    }
  }

  start() {
    this.spawnEnemy();
    this.tickInterval = setInterval(() => this.tick(), 33); // ~30fps
  }

  stop() {
    if (this.tickInterval) clearInterval(this.tickInterval);
  }

  tick() {
    const now = Date.now();
    const dt = now - this.lastUpdate;
    this.lastUpdate = now;

    if (this.gameOver) return;

    // Update shield timers
    for (const p of Object.values(this.players)) {
      if (p.shield > 0) p.shield -= dt;
      if (p.bulletCooldown > 0) p.bulletCooldown -= dt;
    }

    // Move players
    this.updatePlayers(dt);

    // Spawn enemies
    this.enemySpawnTimer += dt;
    if (this.enemySpawnTimer > 3000 && this.enemiesOnField < MAX_ENEMIES && this.enemiesRemaining > 0) {
      this.spawnEnemy();
      this.enemySpawnTimer = 0;
    }

    // Update enemies
    this.enemyShootTimer += dt;
    this.updateEnemies(dt);

    // Update bullets
    this.updateBullets(dt);

    // Check game over
    this.checkGameOver();
  }

  updatePlayers(dt) {
    for (const p of Object.values(this.players)) {
      if (!p.alive) continue;
      const { up, down, left, right, shoot } = p.inputs;

      let moved = false;
      if (up) { p.dir = DIR.UP; this.tryMove(p, 0, -p.speed); moved = true; }
      else if (down) { p.dir = DIR.DOWN; this.tryMove(p, 0, p.speed); moved = true; }
      else if (left) { p.dir = DIR.LEFT; this.tryMove(p, -p.speed, 0); moved = true; }
      else if (right) { p.dir = DIR.RIGHT; this.tryMove(p, p.speed, 0); moved = true; }
      p.moving = moved;

      if (shoot && p.bulletCooldown <= 0) {
        this.fireBullet(p, false);
        p.bulletCooldown = 400;
      }
    }
  }

  tryMove(entity, dx, dy) {
    const nx = entity.x + dx;
    const ny = entity.y + dy;
    const size = entity.isEnemy ? TANK_SIZE : TANK_SIZE;

    if (nx < 0 || ny < 0 || nx + size > MAP_COLS * TILE_SIZE || ny + size > MAP_ROWS * TILE_SIZE) return;
    if (!this.collidesWithTiles(nx, ny, size)) {
      // Check collision with other tanks
      if (!this.collidesWithTanks(entity, nx, ny, size)) {
        entity.x = nx;
        entity.y = ny;
      }
    }
  }

  collidesWithTiles(x, y, size) {
    const passable = new Set([0, 4]); // empty and bush are passable
    const x1 = Math.floor(x / TILE_SIZE);
    const y1 = Math.floor(y / TILE_SIZE);
    const x2 = Math.floor((x + size - 1) / TILE_SIZE);
    const y2 = Math.floor((y + size - 1) / TILE_SIZE);

    for (let ty = y1; ty <= y2; ty++) {
      for (let tx = x1; tx <= x2; tx++) {
        if (tx < 0 || ty < 0 || tx >= MAP_COLS || ty >= MAP_ROWS) return true;
        const tile = this.mapData[ty * MAP_COLS + tx];
        if (!passable.has(tile)) return true;
      }
    }
    return false;
  }

  collidesWithTanks(entity, nx, ny, size) {
    const checkCollision = (other) => {
      if (other === entity || !other.alive) return false;
      return nx < other.x + size && nx + size > other.x &&
             ny < other.y + size && ny + size > other.y;
    };

    for (const p of Object.values(this.players)) {
      if (checkCollision(p)) return true;
    }
    for (const e of this.enemies) {
      if (checkCollision(e)) return true;
    }
    return false;
  }

  fireBullet(source, isEnemy) {
    const cx = source.x + TANK_SIZE / 2;
    const cy = source.y + TANK_SIZE / 2;
    const dir = source.dir;
    const bullet = {
      id: this.nextBulletId++,
      x: cx - BULLET_SIZE / 2 + DX[dir] * (TANK_SIZE / 2),
      y: cy - BULLET_SIZE / 2 + DY[dir] * (TANK_SIZE / 2),
      dir,
      speed: BULLET_SPEED,
      isEnemy,
      ownerId: source.id,
    };
    this.bullets.push(bullet);
  }

  updateBullets(dt) {
    for (let i = this.bullets.length - 1; i >= 0; i--) {
      const b = this.bullets[i];
      b.x += DX[b.dir] * b.speed;
      b.y += DY[b.dir] * b.speed;

      let destroyed = false;

      // Out of bounds
      if (b.x < 0 || b.y < 0 || b.x >= MAP_COLS * TILE_SIZE || b.y >= MAP_ROWS * TILE_SIZE) {
        destroyed = true;
      }

      // Hit tiles
      if (!destroyed) {
        const tx = Math.floor((b.x + BULLET_SIZE / 2) / TILE_SIZE);
        const ty = Math.floor((b.y + BULLET_SIZE / 2) / TILE_SIZE);
        if (tx >= 0 && ty >= 0 && tx < MAP_COLS && ty < MAP_ROWS) {
          const tileIdx = ty * MAP_COLS + tx;
          const tile = this.mapData[tileIdx];
          if (tile === 1) { // brick
            this.mapData[tileIdx] = 0;
            destroyed = true;
          } else if (tile === 2) { // steel
            destroyed = true;
          } else if (tile === 5) { // base/eagle
            this.mapData[tileIdx] = 0;
            this.baseDestroyed = true;
            this.gameOver = true;
            this.winner = 'enemies';
            destroyed = true;
          }
        }
      }

      // Hit players (enemy bullets)
      if (!destroyed && b.isEnemy) {
        for (const p of Object.values(this.players)) {
          if (!p.alive || p.shield > 0) continue;
          if (this.bulletHitsTank(b, p)) {
            p.lives--;
            if (p.lives <= 0) {
              p.alive = false;
            } else {
              this.respawnPlayer(p);
            }
            destroyed = true;
            break;
          }
        }
      }

      // Hit enemies (player bullets)
      if (!destroyed && !b.isEnemy) {
        for (let j = this.enemies.length - 1; j >= 0; j--) {
          const e = this.enemies[j];
          if (!e.alive) continue;
          if (this.bulletHitsTank(b, e)) {
            e.alive = false;
            this.enemies.splice(j, 1);
            this.enemiesOnField--;
            // Give score to player
            if (this.players[b.ownerId]) {
              this.players[b.ownerId].score += 100;
            }
            destroyed = true;
            break;
          }
        }
      }

      if (destroyed) {
        this.bullets.splice(i, 1);
      }
    }
  }

  bulletHitsTank(b, tank) {
    return b.x < tank.x + TANK_SIZE && b.x + BULLET_SIZE > tank.x &&
           b.y < tank.y + TANK_SIZE && b.y + BULLET_SIZE > tank.y;
  }

  respawnPlayer(p) {
    const idx = Object.keys(this.players).indexOf(p.id);
    const spawn = SPAWN_POINTS[idx % SPAWN_POINTS.length];
    p.x = spawn.x * TILE_SIZE + 1;
    p.y = spawn.y * TILE_SIZE + 1;
    p.shield = 2000;
    p.alive = true;
  }

  spawnEnemy() {
    if (this.enemiesRemaining <= 0) return;
    const spawnPt = ENEMY_SPAWNS[this.nextEnemyId % ENEMY_SPAWNS.length];
    const enemy = {
      id: 'e' + this.nextEnemyId++,
      x: spawnPt.x * TILE_SIZE + 1,
      y: spawnPt.y * TILE_SIZE + 1,
      dir: DIR.DOWN,
      alive: true,
      isEnemy: true,
      speed: 0.8,
      moveTimer: 0,
      shootTimer: Math.random() * 2000,
      moving: false,
    };
    this.enemies.push(enemy);
    this.enemiesOnField++;
    this.enemiesRemaining--;
  }

  updateEnemies(dt) {
    for (const e of this.enemies) {
      if (!e.alive) continue;

      // Simple AI: move toward base, occasionally change direction
      e.moveTimer += dt;
      if (e.moveTimer > ENEMY_MOVE_INTERVAL) {
        e.moveTimer = 0;
        // Randomly pick a direction, biased toward down/center
        const r = Math.random();
        if (r < 0.4) e.dir = DIR.DOWN;
        else if (r < 0.6) e.dir = DIR.LEFT;
        else if (r < 0.8) e.dir = DIR.RIGHT;
        else e.dir = DIR.UP;
      }

      // Try to move
      const prevX = e.x, prevY = e.y;
      this.tryMove(e, DX[e.dir] * e.speed, DY[e.dir] * e.speed);
      if (e.x === prevX && e.y === prevY) {
        // Stuck, change direction
        e.dir = (e.dir + 1) % 4;
      }

      // Shoot
      e.shootTimer += dt;
      if (e.shootTimer > ENEMY_SHOOT_INTERVAL) {
        e.shootTimer = 0;
        this.fireBullet(e, true);
      }
    }
  }

  checkGameOver() {
    if (this.gameOver) return;

    // All players dead
    const alivePlayers = Object.values(this.players).filter(p => p.lives > 0);
    if (alivePlayers.length === 0 && Object.keys(this.players).length > 0) {
      this.gameOver = true;
      this.winner = 'enemies';
      return;
    }

    // All enemies defeated
    if (this.enemiesRemaining <= 0 && this.enemies.length === 0) {
      this.gameOver = true;
      this.winner = 'players';
    }
  }

  getState() {
    return {
      mapData: this.mapData,
      players: Object.values(this.players).map(p => ({
        id: p.id,
        name: p.name,
        x: p.x,
        y: p.y,
        dir: p.dir,
        alive: p.alive,
        lives: p.lives,
        score: p.score,
        color: p.color,
        shield: p.shield > 0,
        moving: p.moving,
      })),
      enemies: this.enemies.map(e => ({
        id: e.id,
        x: e.x,
        y: e.y,
        dir: e.dir,
        alive: e.alive,
        moving: e.moving,
      })),
      bullets: this.bullets.map(b => ({
        id: b.id,
        x: b.x,
        y: b.y,
        dir: b.dir,
        isEnemy: b.isEnemy,
      })),
      gameOver: this.gameOver,
      winner: this.winner,
      enemiesRemaining: this.enemiesRemaining,
      enemiesOnField: this.enemiesOnField,
    };
  }
}

module.exports = { GameRoom, MAPS };
