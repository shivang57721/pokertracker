const express = require('express');
const cors = require('cors');
const { getDb, saveDb, queryAll, queryOne } = require('./db');
const { importFromDirectory, DEFAULT_HH_PATH } = require('./importer');
const { startWatcher } = require('./watcher');
const { computeStats, computeSessions, computeProfitCurve, getAvailableFilters } = require('./stats');
const { reparsePositions } = require('./reparse-positions');

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors({ origin: 'http://localhost:5173' }));
app.use(express.json());

// ── Health ────────────────────────────────────────────────────────────────────
app.get('/api/health', async (req, res) => {
  await getDb();
  res.json({ status: 'ok', message: 'PokerTracker API is running' });
});

// ── Hands list ────────────────────────────────────────────────────────────────
// GET /api/hands?player=&limit=50&offset=0&from=&to=&stakes=&game_type=
//               &is_tournament=0|1&search=&sort_by=&sort_dir=asc|desc
//               &min_net=&max_net=   (min_net/max_net only when player given)
// Always returns { hands: [...], total: N }
app.get('/api/hands', async (req, res) => {
  try {
    const db     = await getDb();
    const limit  = Math.min(parseInt(req.query.limit)  || 50, 500);
    const offset = parseInt(req.query.offset) || 0;
    const player = req.query.player || null;

    // Whitelist sort columns to prevent injection
    const SORT_COLS = new Set(['date_played','hand_id','stakes','total_pot','net_profit','player_position']);
    const rawSort   = req.query.sort_by;
    const sortBy    = (rawSort && SORT_COLS.has(rawSort) &&
                       !(rawSort === 'net_profit'      && !player) &&
                       !(rawSort === 'player_position' && !player))
                      ? rawSort : 'date_played';
    const sortDir   = req.query.sort_dir === 'asc' ? 'ASC' : 'DESC';

    // WHERE conditions on h.* columns
    const conditions = [];
    const baseParams = [];

    if (req.query.is_tournament != null && req.query.is_tournament !== '') {
      conditions.push('h.is_tournament = ?');
      baseParams.push(req.query.is_tournament === '1' ? 1 : 0);
    }
    if (req.query.from) {
      conditions.push('h.date_played >= ?');
      baseParams.push(req.query.from);
    }
    if (req.query.to) {
      conditions.push('h.date_played <= ?');
      baseParams.push(req.query.to + ' 23:59:59');
    }
    if (req.query.stakes) {
      conditions.push('h.stakes = ?');
      baseParams.push(req.query.stakes);
    }
    if (req.query.game_type) {
      conditions.push('h.game_type = ?');
      baseParams.push(req.query.game_type);
    }
    if (req.query.search) {
      conditions.push('(h.hand_id LIKE ? OR h.table_name LIKE ?)');
      const like = `%${req.query.search}%`;
      baseParams.push(like, like);
    }

    const whereClause = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

    if (player) {
      // Inner query computes net_profit so we can sort/filter on it in the outer query
      const netSub = `(
        SELECT SUM(COALESCE(a.amount, 0))
        FROM hand_actions a
        WHERE a.hand_id = h.hand_id AND a.player = ?
          AND a.action IN ('post_sb','post_bb','post_ante','call','bet','raise')
      )`;
      const innerSql = `
        SELECT h.*,
               hp.hole_cards   AS hole_cards,
               hp.amount_won   AS player_won,
               hp.position     AS player_position,
               hp.amount_won - COALESCE(${netSub}, 0) AS net_profit
        FROM hands h
        JOIN hand_players hp ON h.hand_id = hp.hand_id AND hp.player = ?
        ${whereClause}
      `;
      // Order: subquery player, JOIN player, then base filter params
      const innerParams = [player, player, ...baseParams];

      // Optional outer filter on the computed net_profit alias
      const outerCond   = [];
      const outerParams = [];
      if (req.query.min_net != null && req.query.min_net !== '') {
        outerCond.push('net_profit >= ?');
        outerParams.push(parseFloat(req.query.min_net));
      }
      if (req.query.max_net != null && req.query.max_net !== '') {
        outerCond.push('net_profit <= ?');
        outerParams.push(parseFloat(req.query.max_net));
      }
      const outerWhere = outerCond.length ? `WHERE ${outerCond.join(' AND ')}` : '';
      const allParams  = [...innerParams, ...outerParams];

      const finalSql = `SELECT * FROM (${innerSql}) ${outerWhere} ORDER BY ${sortBy} ${sortDir} LIMIT ? OFFSET ?`;
      const countSql = `SELECT COUNT(*) AS total FROM (${innerSql}) ${outerWhere}`;

      const rows     = queryAll(db, finalSql, [...allParams, limit, offset]);
      const countRow = queryOne(db, countSql, allParams);

      return res.json({
        hands: rows.map(r => ({
          ...r,
          board:      JSON.parse(r.board      || '[]'),
          hole_cards: JSON.parse(r.hole_cards || '[]'),
        })),
        total: countRow?.total ?? 0,
      });
    }

    // No player — simpler query
    const sql      = `SELECT h.* FROM hands h ${whereClause} ORDER BY ${sortBy} ${sortDir} LIMIT ? OFFSET ?`;
    const countSql = `SELECT COUNT(*) AS total FROM hands h ${whereClause}`;

    const rows     = queryAll(db, sql, [...baseParams, limit, offset]);
    const countRow = queryOne(db, countSql, baseParams);

    return res.json({
      hands: rows.map(r => ({ ...r, board: JSON.parse(r.board || '[]') })),
      total: countRow?.total ?? 0,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Single hand (with players + actions) ─────────────────────────────────────
app.get('/api/hands/:handId', async (req, res) => {
  try {
    const db = await getDb();
    const { handId } = req.params;

    const hand = queryOne(db, 'SELECT * FROM hands WHERE hand_id = ?', [handId]);
    if (!hand) return res.status(404).json({ error: 'Hand not found' });

    const players = queryAll(
      db,
      'SELECT * FROM hand_players WHERE hand_id = ? ORDER BY seat',
      [handId]
    );
    const actions = queryAll(
      db,
      'SELECT * FROM hand_actions WHERE hand_id = ? ORDER BY action_order',
      [handId]
    );

    res.json({
      ...hand,
      board: JSON.parse(hand.board || '[]'),
      players: players.map(p => ({ ...p, hole_cards: JSON.parse(p.hole_cards || '[]') })),
      actions,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Player stats ──────────────────────────────────────────────────────────────
// GET /api/players/:player/stats
app.get('/api/players/:player/stats', async (req, res) => {
  try {
    const db = await getDb();
    const { player } = req.params;

    const stats = queryOne(db, `
      SELECT
        COUNT(*)                                          AS hands_played,
        SUM(hp.amount_won)                                AS total_won,
        SUM(CASE WHEN hp.amount_won > 0 THEN 1 ELSE 0 END) AS hands_won,
        SUM(CASE WHEN hp.hole_cards != '[]' THEN 1 ELSE 0 END) AS showdowns,
        SUM(hp.starting_chips)                            AS total_chips_at_table
      FROM hand_players hp
      WHERE hp.player = ?
    `, [player]);

    // Breakdown by game type
    const byGameType = queryAll(db, `
      SELECT h.game_type, h.is_tournament,
             COUNT(*) AS hands,
             SUM(hp.amount_won) AS net
      FROM hand_players hp
      JOIN hands h ON h.hand_id = hp.hand_id
      WHERE hp.player = ?
      GROUP BY h.game_type, h.is_tournament
      ORDER BY hands DESC
    `, [player]);

    // Recent results (last 20 hands)
    const recent = queryAll(db, `
      SELECT h.hand_id, h.date_played, h.game_type, h.stakes,
             hp.position, hp.hole_cards, hp.amount_won, h.board
      FROM hand_players hp
      JOIN hands h ON h.hand_id = hp.hand_id
      WHERE hp.player = ?
      ORDER BY h.date_played DESC
      LIMIT 20
    `, [player]);

    res.json({
      player,
      ...stats,
      by_game_type: byGameType,
      recent: recent.map(r => ({
        ...r,
        hole_cards: JSON.parse(r.hole_cards || '[]'),
        board: JSON.parse(r.board || '[]'),
      })),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Global stats ──────────────────────────────────────────────────────────────
app.get('/api/stats', async (req, res) => {
  try {
    const db = await getDb();

    const totals = queryOne(db, `
      SELECT
        COUNT(*)                                       AS total_hands,
        SUM(CASE WHEN is_tournament = 0 THEN 1 ELSE 0 END) AS cash_hands,
        SUM(CASE WHEN is_tournament = 1 THEN 1 ELSE 0 END) AS tournament_hands,
        COUNT(DISTINCT table_name)                     AS tables,
        MIN(date_played)                               AS first_hand,
        MAX(date_played)                               AS last_hand
      FROM hands
    `);

    res.json(totals);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Statistics ────────────────────────────────────────────────────────────────
// Shared query-string parser for stat filters
// Supported params: from, to, game_type, stakes, is_tournament (0|1)
function parseStatFilters(query) {
  const opts = {};
  if (query.from)           opts.from           = query.from;
  if (query.to)             opts.to             = query.to;
  if (query.game_type)      opts.game_type      = query.game_type;
  if (query.stakes)         opts.stakes         = query.stakes;
  if (query.is_tournament != null && query.is_tournament !== '')
    opts.is_tournament = query.is_tournament === '1' || query.is_tournament === 'true';
  return opts;
}

// GET /api/stats/:player
// All metrics: VPIP, PFR, 3-bet, AF, WTSD, W$SD, CBet, Fold-to-CBet, BB/100, profit
app.get('/api/stats/:player', async (req, res) => {
  try {
    const result = await computeStats(req.params.player, parseStatFilters(req.query));
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/stats/:player/sessions
// Session breakdown: profit/loss per session with start, end, duration, hand count
app.get('/api/stats/:player/sessions', async (req, res) => {
  try {
    const result = await computeSessions(req.params.player, parseStatFilters(req.query));
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/stats/:player/profit-curve
// Time-series of cumulative net profit, split into cash and tournament series
app.get('/api/stats/:player/profit-curve', async (req, res) => {
  try {
    const result = await computeProfitCurve(req.params.player, parseStatFilters(req.query));
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/stats/:player/filters
// Distinct game_types, stakes, and date range available for this player
app.get('/api/stats/:player/filters', async (req, res) => {
  try {
    res.json(await getAvailableFilters(req.params.player));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Import ────────────────────────────────────────────────────────────────────
// POST /api/import  { "path": "/optional/override/path" }
app.post('/api/import', async (req, res) => {
  try {
    const dirPath = req.body?.path || DEFAULT_HH_PATH;
    const result = await importFromDirectory(dirPath);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Reparse positions ─────────────────────────────────────────────────────────
// POST /api/reparse-positions
// Re-reads every hand's raw_text, recalculates positions with the updated
// seat-based algorithm, and writes them back into hand_players.position.
app.post('/api/reparse-positions', async (req, res) => {
  try {
    const result = await reparsePositions();
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`PokerTracker server running on http://localhost:${PORT}`);

  // On startup: catch up on any hands written while the server was offline,
  // then hand off to the file watcher for live updates.
  importFromDirectory(DEFAULT_HH_PATH)
    .then(r => {
      if (r.imported > 0) {
        console.log(`[startup] Caught up: ${r.imported} new hand(s) imported`);
      } else {
        console.log(`[startup] DB is up to date (${r.skipped} hand(s) already present)`);
      }
      startWatcher(DEFAULT_HH_PATH);
    })
    .catch(err => {
      console.warn(`[startup] Initial import warning: ${err.message}`);
      // Still start the watcher even if the initial import fails
      startWatcher(DEFAULT_HH_PATH);
    });
});
