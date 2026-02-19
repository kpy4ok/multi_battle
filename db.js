'use strict';

/**
 * db.js — SQLite logging & results
 *
 * TABLE: user_log
 *   id          INTEGER PK
 *   uid         TEXT    — unique user ID (cookie-based, persistent across sessions)
 *   event       TEXT    — 'page_open' | 'room_join' | 'room_create' | 'room_exit' | 'game_win'
 *   username    TEXT    — player name at time of event
 *   ip          TEXT
 *   os          TEXT    — parsed from User-Agent
 *   browser     TEXT    — parsed from User-Agent
 *   resolution  TEXT    — "WxH" sent from client
 *   room_id     TEXT    — null for page_open
 *   room_name   TEXT
 *   ts          INTEGER — unix ms
 *
 * TABLE: game_results
 *   id          INTEGER PK
 *   uid         TEXT    — references user_log.uid
 *   username    TEXT
 *   room_id     TEXT
 *   room_name   TEXT
 *   mode        TEXT    — 'coop' | 'deathmatch' | 'deathmatch_bots'
 *   result      TEXT    — 'win' | 'loss'
 *   score       INTEGER — frags (DM) or points (coop)
 *   deaths      INTEGER
 *   duration_s  INTEGER — seconds the game lasted
 *   ts          INTEGER
 */

const Database = require('better-sqlite3');
const path     = require('path');
const UAParser = require('ua-parser-js');

const DB_PATH = path.join(__dirname, 'data', 'battle.db');

// Ensure data/ dir exists
const fs = require('fs');
fs.mkdirSync(path.join(__dirname, 'data'), { recursive: true });

const db = new Database(DB_PATH);

// WAL mode = much faster for concurrent writes
db.pragma('journal_mode = WAL');
db.pragma('synchronous = NORMAL');

// ── Schema ────────────────────────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS user_log (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    uid        TEXT    NOT NULL,
    event      TEXT    NOT NULL,
    username   TEXT,
    ip         TEXT,
    os         TEXT,
    browser    TEXT,
    resolution TEXT,
    room_id    TEXT,
    room_name  TEXT,
    ts         INTEGER NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_log_uid   ON user_log(uid);
  CREATE INDEX IF NOT EXISTS idx_log_event ON user_log(event);
  CREATE INDEX IF NOT EXISTS idx_log_ts    ON user_log(ts);

  CREATE TABLE IF NOT EXISTS game_results (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    uid        TEXT    NOT NULL,
    username   TEXT,
    room_id    TEXT,
    room_name  TEXT,
    mode       TEXT,
    result     TEXT,
    score      INTEGER DEFAULT 0,
    deaths     INTEGER DEFAULT 0,
    duration_s INTEGER DEFAULT 0,
    ts         INTEGER NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_res_uid  ON game_results(uid);
  CREATE INDEX IF NOT EXISTS idx_res_room ON game_results(room_id);
  CREATE INDEX IF NOT EXISTS idx_res_ts   ON game_results(ts);
`);

// ── Prepared statements ───────────────────────────────────
const stmtLog = db.prepare(`
  INSERT INTO user_log (uid, event, username, ip, os, browser, resolution, room_id, room_name, ts)
  VALUES (@uid, @event, @username, @ip, @os, @browser, @resolution, @room_id, @room_name, @ts)
`);

const stmtResult = db.prepare(`
  INSERT INTO game_results (uid, username, room_id, room_name, mode, result, score, deaths, duration_s, ts)
  VALUES (@uid, @username, @room_id, @room_name, @mode, @result, @score, @deaths, @duration_s, @ts)
`);

// ── UA parser helper ──────────────────────────────────────
function parseUA(uaString) {
  const p = new UAParser(uaString || '');
  const os = p.getOS();
  const br = p.getBrowser();
  return {
    os:      [os.name, os.version].filter(Boolean).join(' ') || 'Unknown',
    browser: [br.name, br.major].filter(Boolean).join(' ')   || 'Unknown',
  };
}

// ── Public API ────────────────────────────────────────────

/**
 * Log a user action.
 * @param {object} opts
 * @param {string} opts.uid
 * @param {string} opts.event       — 'page_open'|'room_join'|'room_create'|'room_exit'|'game_win'
 * @param {string} [opts.username]
 * @param {string} [opts.ip]
 * @param {string} [opts.ua]        — raw User-Agent string
 * @param {string} [opts.resolution]
 * @param {string} [opts.roomId]
 * @param {string} [opts.roomName]
 */
function log(opts) {
  try {
    const { os, browser } = parseUA(opts.ua);
    stmtLog.run({
      uid:        opts.uid        || 'unknown',
      event:      opts.event,
      username:   opts.username   || null,
      ip:         opts.ip         || null,
      os,
      browser,
      resolution: opts.resolution || null,
      room_id:    opts.roomId     || null,
      room_name:  opts.roomName   || null,
      ts:         Date.now(),
    });
  } catch (e) {
    console.error('[db.log]', e.message);
  }
}

/**
 * Save a game result for one player when the room finishes.
 */
function saveResult(opts) {
  try {
    stmtResult.run({
      uid:        opts.uid,
      username:   opts.username   || null,
      room_id:    opts.roomId,
      room_name:  opts.roomName   || null,
      mode:       opts.mode       || null,
      result:     opts.result,    // 'win' | 'loss'
      score:      opts.score      || 0,
      deaths:     opts.deaths     || 0,
      duration_s: opts.duration_s || 0,
      ts:         Date.now(),
    });
  } catch (e) {
    console.error('[db.saveResult]', e.message);
  }
}

// ── Stats queries (for admin page) ────────────────────────
function getStats() {
  return {
    totalUsers:    db.prepare(`SELECT COUNT(DISTINCT uid) as c FROM user_log`).get().c,
    totalSessions: db.prepare(`SELECT COUNT(*) as c FROM user_log WHERE event='page_open'`).get().c,
    totalGames:    db.prepare(`SELECT COUNT(DISTINCT room_id||ts) as c FROM game_results`).get().c,
    recentLog:     db.prepare(`SELECT * FROM user_log ORDER BY ts DESC LIMIT 100`).all(),
    topPlayers:    db.prepare(`
      SELECT username, uid, COUNT(*) as games,
             SUM(CASE WHEN result='win' THEN 1 ELSE 0 END) as wins,
             SUM(score) as total_score
      FROM game_results
      GROUP BY uid
      ORDER BY wins DESC, total_score DESC
      LIMIT 20`).all(),
    recentResults: db.prepare(`SELECT * FROM game_results ORDER BY ts DESC LIMIT 50`).all(),
  };
}

// ── Public leaderboard (no sensitive data) ───────────────
function getPublicStats() {
  return {
    topPlayers: db.prepare(`
      SELECT username,
             COUNT(*)                                         AS games,
             SUM(CASE WHEN result='win' THEN 1 ELSE 0 END)   AS wins,
             SUM(score)                                       AS total_score,
             SUM(deaths)                                      AS total_deaths,
             MAX(score)                                       AS best_score
      FROM game_results
      GROUP BY uid
      ORDER BY wins DESC, total_score DESC
      LIMIT 15`).all(),

    recentGames: db.prepare(`
      SELECT room_name, mode, ts,
             GROUP_CONCAT(username || ':' || result || ':' || score, '|') AS players_raw
      FROM game_results
      GROUP BY room_id, ts / 10000   -- group same game (within 10s window)
      ORDER BY ts DESC
      LIMIT 10`).all(),

    totalStats: db.prepare(`
      SELECT COUNT(DISTINCT uid)   AS unique_players,
             COUNT(*)              AS total_games,
             SUM(score)            AS total_frags,
             MAX(score)            AS record_score,
             (SELECT username FROM game_results ORDER BY score DESC LIMIT 1) AS record_holder
      FROM game_results`).get(),
  };
}

module.exports = { log, saveResult, getStats, getPublicStats };