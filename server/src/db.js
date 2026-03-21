const initSqlJs = require('sql.js');
const fs = require('fs');
const path = require('path');

const DB_PATH = path.join(__dirname, '..', 'poker.db');

let db = null;

async function getDb() {
  if (db) return db;

  const SQL = await initSqlJs();

  if (fs.existsSync(DB_PATH)) {
    db = new SQL.Database(fs.readFileSync(DB_PATH));
  } else {
    db = new SQL.Database();
  }

  // One-time migration: v1 schema didn't have hand_players.
  // Drop old tables so we recreate with the correct schema.
  const tablesResult = db.exec("SELECT name FROM sqlite_master WHERE type='table'");
  const tables = tablesResult.length > 0
    ? tablesResult[0].values.map(r => r[0])
    : [];
  if (tables.includes('hands') && !tables.includes('hand_players')) {
    db.run('DROP TABLE IF EXISTS hand_results');
    db.run('DROP TABLE IF EXISTS hands');
  }

  db.run(`
    CREATE TABLE IF NOT EXISTS hands (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      hand_id       TEXT UNIQUE NOT NULL,
      tournament_id TEXT,
      is_tournament INTEGER NOT NULL DEFAULT 0,
      game_type     TEXT,
      stakes        TEXT,
      small_blind   REAL,
      big_blind     REAL,
      date_played   TEXT,
      table_name    TEXT,
      max_seats     INTEGER,
      button_seat   INTEGER,
      total_pot     REAL,
      rake          REAL,
      board         TEXT,   -- JSON array e.g. ["2c","4s","3c","6s","5d"]
      raw_text      TEXT NOT NULL,
      created_at    DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    -- One row per player per hand
    CREATE TABLE IF NOT EXISTS hand_players (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      hand_id        TEXT NOT NULL,
      seat           INTEGER,
      player         TEXT NOT NULL,
      starting_chips REAL,
      position       TEXT,   -- 'button' | 'small blind' | 'big blind' | null
      hole_cards     TEXT,   -- JSON array e.g. ["6d","Qd"]
      amount_won     REAL NOT NULL DEFAULT 0,
      did_muck       INTEGER NOT NULL DEFAULT 0,
      FOREIGN KEY (hand_id) REFERENCES hands(hand_id)
    );

    -- Every betting action in order
    CREATE TABLE IF NOT EXISTS hand_actions (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      hand_id      TEXT NOT NULL,
      street       TEXT NOT NULL,   -- preflop | flop | turn | river | showdown
      action_order INTEGER NOT NULL,
      player       TEXT NOT NULL,
      action       TEXT NOT NULL,   -- fold | check | call | bet | raise | post_sb | post_bb | post_ante
      amount       REAL,            -- chips added to pot by this action (raise: the raise amount)
      total_amount REAL,            -- total bet size after action (for raises)
      is_all_in    INTEGER NOT NULL DEFAULT 0,
      FOREIGN KEY (hand_id) REFERENCES hands(hand_id)
    );

    CREATE INDEX IF NOT EXISTS idx_hands_date       ON hands(date_played);
    CREATE INDEX IF NOT EXISTS idx_hands_tournament ON hands(tournament_id);
    CREATE INDEX IF NOT EXISTS idx_players_player   ON hand_players(player);
    CREATE INDEX IF NOT EXISTS idx_players_hand     ON hand_players(hand_id);
    CREATE INDEX IF NOT EXISTS idx_actions_hand     ON hand_actions(hand_id);
  `);

  saveDb();
  return db;
}

function saveDb() {
  if (!db) return;
  fs.writeFileSync(DB_PATH, Buffer.from(db.export()));
}

/**
 * Run a SELECT with positional params and return all rows as plain objects.
 * @param {object} db
 * @param {string} sql
 * @param {any[]} params
 * @returns {object[]}
 */
function queryAll(db, sql, params = []) {
  const stmt = db.prepare(sql);
  if (params.length) stmt.bind(params);
  const rows = [];
  while (stmt.step()) rows.push(stmt.getAsObject());
  stmt.free();
  return rows;
}

/**
 * Run a SELECT and return the first row, or null.
 */
function queryOne(db, sql, params = []) {
  const stmt = db.prepare(sql);
  if (params.length) stmt.bind(params);
  const row = stmt.step() ? stmt.getAsObject() : null;
  stmt.free();
  return row;
}

module.exports = { getDb, saveDb, queryAll, queryOne };
