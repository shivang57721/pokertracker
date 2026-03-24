require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const express = require('express');
const cors = require('cors');
const { getDb, saveDb, queryAll, queryOne } = require('./db');
const { importFromDirectory, DEFAULT_HH_PATH } = require('./importer');
const { startWatcher } = require('./watcher');
const { computeStats, computeSessions, computeProfitCurve, getAvailableFilters, computePositionStats } = require('./stats');
const { reparsePositions } = require('./reparse-positions');
const { reparseUncalled }     = require('./reparse-uncalled');
const { reparseHandActions }  = require('./reparse-hand-actions');
const { analyzeAllHands } = require('./analyzer');
const Anthropic = require('@anthropic-ai/sdk');

const anthropic = new Anthropic(); // reads ANTHROPIC_API_KEY from env

const AI_SYSTEM_PROMPT =
  'I want you to act as my poker coach and analyze this hand I played. ' +
  'Here is my general strategy for context:\n\n' +
  'Preflop: Tight from early position, progressively looser toward the button. ' +
  'I 3-bet premium hands and suited hands that have playability, more often when out of position, ' +
  'and adjust to the opener (tighter against UTG).\n' +
  'Postflop: I bet when I have range advantage. I bet big with premium hands and draws. ' +
  'I check or bet small otherwise. I try to turn busted draws into bluffs. ' +
  'With marginal hands I try to get to showdown cheaply.\n\n' +
  'Analyze the hand below. For each street, evaluate my decision. ' +
  'If I made a mistake, explain specifically what I should have done instead and why, ' +
  'including pot odds or equity reasoning where relevant. ' +
  'If a street was played fine, say so and move on. ' +
  "Don't give generic poker advice — focus only on what happened in this hand.";

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors({ origin: 'http://localhost:5173' }));
app.use(express.json());

// ── Health ────────────────────────────────────────────────────────────────────
app.get('/api/health', async (req, res) => {
  const db = await getDb();
  const row = queryOne(db, 'SELECT COUNT(*) AS count FROM hands');
  res.json({ status: 'ok', hand_count: row?.count ?? 0 });
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
        SELECT SUM(CASE WHEN a.action = 'uncalled_return'
                        THEN -COALESCE(a.amount, 0)
                        ELSE  COALESCE(a.amount, 0) END)
        FROM hand_actions a
        WHERE a.hand_id = h.hand_id AND a.player = ?
          AND a.action IN ('post_sb','post_bb','post_ante','call','bet','raise','uncalled_return')
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

    // Net profit per player: amount_won minus true invested (uncalled_return subtracts)
    const investedRows = queryAll(db,
      `SELECT player,
              SUM(CASE WHEN action = 'uncalled_return'
                       THEN -COALESCE(amount, 0)
                       ELSE  COALESCE(amount, 0) END) AS invested
       FROM hand_actions
       WHERE hand_id = ?
         AND action IN ('post_sb','post_bb','post_ante','call','bet','raise','uncalled_return')
       GROUP BY player`,
      [handId]
    );
    const investedByPlayer = Object.fromEntries(
      investedRows.map(r => [r.player, r.invested || 0])
    );

    const flags = queryAll(
      db,
      "SELECT flag_type, street, severity, description FROM hand_flags WHERE hand_id = ? AND flag_type != '_analyzed' ORDER BY severity DESC",
      [handId]
    );

    res.json({
      ...hand,
      board: JSON.parse(hand.board || '[]'),
      players: players.map(p => ({
        ...p,
        hole_cards:  JSON.parse(p.hole_cards || '[]'),
        net_profit:  Math.round((p.amount_won - (investedByPlayer[p.player] || 0)) * 100) / 100,
      })),
      actions,
      flags,
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
// Supported params: from, to, game_type, stakes, is_tournament (0|1), position
function parseStatFilters(query) {
  const opts = {};
  if (query.from)           opts.from           = query.from;
  if (query.to)             opts.to             = query.to;
  if (query.game_type)      opts.game_type      = query.game_type;
  if (query.stakes)         opts.stakes         = query.stakes;
  if (query.position)       opts.position       = query.position;
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

// GET /api/stats/:player/positions
// BB/100 per position for cash hands; supports same filters as /stats/:player
app.get('/api/stats/:player/positions', async (req, res) => {
  try {
    const result = await computePositionStats(req.params.player, parseStatFilters(req.query));
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

// ── Analysis flags ────────────────────────────────────────────────────────────
// POST /api/analyze — run mistake analysis on all unprocessed cash hands
app.post('/api/analyze', async (req, res) => {
  try {
    const result = await analyzeAllHands();
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/flags?flag_type=&min_severity=&limit=&offset=
// Returns { flags: [...], total_flags: N, flagged_hands: M }
// Excludes sentinel _analyzed records; flag_type/min_severity are optional filters.
app.get('/api/flags', async (req, res) => {
  try {
    const db          = await getDb();
    const limit       = Math.min(parseInt(req.query.limit)  || 100, 1000);
    const offset      = parseInt(req.query.offset) || 0;
    const flagType    = req.query.flag_type    || null;
    const minSeverity = parseInt(req.query.min_severity) || 1;

    const conditions = ["flag_type != '_analyzed'", 'severity >= ?'];
    const params     = [minSeverity];
    if (flagType) { conditions.push('flag_type = ?'); params.push(flagType); }

    const where = `WHERE ${conditions.join(' AND ')}`;

    const flags = queryAll(
      db,
      `SELECT hf.*, h.date_played, h.stakes FROM hand_flags hf
       JOIN hands h ON h.hand_id = hf.hand_id
       ${where} ORDER BY h.date_played DESC, hf.id DESC LIMIT ? OFFSET ?`,
      [...params, limit, offset]
    );

    const totals = queryOne(
      db,
      `SELECT COUNT(*) AS total_flags,
              COUNT(DISTINCT hand_id) AS flagged_hands
       FROM hand_flags ${where}`,
      params
    );

    res.json({
      flags,
      total_flags:   totals?.total_flags   ?? 0,
      flagged_hands: totals?.flagged_hands ?? 0,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── AI coaching analysis ──────────────────────────────────────────────────────
// GET /api/ai-analysis/:handId — return existing analysis or null
app.get('/api/ai-analysis/:handId', async (req, res) => {
  try {
    const db  = await getDb();
    const row = queryOne(db, 'SELECT * FROM ai_analysis WHERE hand_id = ?', [req.params.handId]);
    res.json(row || null);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/ai-analysis/:handId  { force?: true }
// Calls Claude, stores result; skips if analysis already exists unless force=true.
app.post('/api/ai-analysis/:handId', async (req, res) => {
  try {
    const db     = await getDb();
    const { handId } = req.params;
    const force  = req.body?.force === true;

    // Return cached unless forced
    if (!force) {
      const existing = queryOne(db, 'SELECT * FROM ai_analysis WHERE hand_id = ?', [handId]);
      if (existing) return res.json(existing);
    }

    const hand = queryOne(db, 'SELECT * FROM hands WHERE hand_id = ?', [handId]);
    if (!hand) return res.status(404).json({ error: 'Hand not found' });
    if (!hand.raw_text) return res.status(400).json({ error: 'No raw hand history text available' });

    // Fetch real flags for this hand (exclude sentinel)
    const handFlags = queryAll(
      db,
      "SELECT flag_type, street, description FROM hand_flags WHERE hand_id = ? AND flag_type != '_analyzed' ORDER BY severity DESC",
      [handId]
    );

    let flagSection = '';
    if (handFlags.length > 0) {
      const items = handFlags.map(f => {
        const parts = [f.flag_type.replace(/_/g, ' ')];
        if (f.street)      parts.push(`(${f.street})`);
        if (f.description) parts.push(`— ${f.description}`);
        return parts.join(' ');
      }).join('\n- ');
      flagSection = `This hand was flagged by my tracker for:\n- ${items}\n\n`;
    }

    const message = await anthropic.messages.create({
      model:      'claude-sonnet-4-6',
      max_tokens: 1000,
      system:     AI_SYSTEM_PROMPT,
      messages: [{
        role:    'user',
        content: `${flagSection}Player to analyze: ${HERO}\n\n${hand.raw_text}`,
      }],
    });

    const analysisText = message.content
      .filter(b => b.type === 'text')
      .map(b => b.text)
      .join('');

    const model = message.model;

    if (force) {
      db.run(
        'DELETE FROM ai_analysis WHERE hand_id = ?',
        [handId]
      );
    }
    db.run(
      'INSERT OR REPLACE INTO ai_analysis (hand_id, analysis, model) VALUES (?, ?, ?)',
      [handId, analysisText, model]
    );
    saveDb();

    res.json({ hand_id: handId, analysis: analysisText, model, created_at: new Date().toISOString() });
  } catch (err) {
    if (err instanceof Anthropic.AuthenticationError) {
      return res.status(401).json({ error: 'Invalid or missing ANTHROPIC_API_KEY' });
    }
    if (err instanceof Anthropic.RateLimitError) {
      return res.status(429).json({ error: 'Claude API rate limit reached — try again shortly' });
    }
    res.status(500).json({ error: err.message });
  }
});

// ── Hand Review ───────────────────────────────────────────────────────────────
const HERO = 'FlaminGalah12';

// GET /api/review/summary
// Returns totals, breakdown by flag type, and estimated money lost
app.get('/api/review/summary', async (req, res) => {
  try {
    const db = await getDb();

    // Total flagged hands split into reviewed / unreviewed / all
    const counts = queryOne(db, `
      SELECT
        COUNT(DISTINCT hf.hand_id) AS total_all,
        COUNT(DISTINCT CASE WHEN rh.hand_id IS NOT NULL THEN hf.hand_id END) AS total_reviewed,
        COUNT(DISTINCT CASE WHEN rh.hand_id IS NULL     THEN hf.hand_id END) AS total_unreviewed
      FROM hand_flags hf
      LEFT JOIN reviewed_hands rh ON rh.hand_id = hf.hand_id
      WHERE hf.flag_type != '_analyzed'
    `);

    // Breakdown by flag type — unreviewed only (the actionable view)
    const byType = queryAll(db, `
      SELECT hf.flag_type, COUNT(DISTINCT hf.hand_id) AS hand_count
      FROM hand_flags hf
      LEFT JOIN reviewed_hands rh ON rh.hand_id = hf.hand_id
      WHERE hf.flag_type != '_analyzed'
        AND rh.hand_id IS NULL
      GROUP BY hf.flag_type
      ORDER BY hand_count DESC
    `);

    // Estimated money lost — unreviewed flagged cash hands only
    const netSub = `(
      SELECT SUM(CASE WHEN a.action = 'uncalled_return'
                      THEN -COALESCE(a.amount, 0)
                      ELSE  COALESCE(a.amount, 0) END)
      FROM hand_actions a
      WHERE a.hand_id = h.hand_id AND a.player = ?
        AND a.action IN ('post_sb','post_bb','post_ante','call','bet','raise','uncalled_return')
    )`;
    const lossRow = queryOne(db, `
      SELECT SUM(CASE WHEN net < 0 THEN net ELSE 0 END) AS estimated_loss
      FROM (
        SELECT h.hand_id,
               hp.amount_won - COALESCE(${netSub}, 0) AS net
        FROM hand_flags hf
        JOIN hands h ON h.hand_id = hf.hand_id AND h.is_tournament = 0
        JOIN hand_players hp ON hp.hand_id = h.hand_id AND hp.player = ?
        LEFT JOIN reviewed_hands rh ON rh.hand_id = hf.hand_id
        WHERE hf.flag_type != '_analyzed'
          AND rh.hand_id IS NULL
        GROUP BY h.hand_id
      )
    `, [HERO, HERO]);

    res.json({
      total_all:        counts?.total_all        ?? 0,
      total_reviewed:   counts?.total_reviewed   ?? 0,
      total_unreviewed: counts?.total_unreviewed ?? 0,
      estimated_loss:   lossRow?.estimated_loss  ?? 0,
      by_flag_type:     byType,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/review?flag_type=&min_severity=1&limit=20&offset=0
// Returns unreviewed flagged hands sorted by max_severity DESC, total_pot DESC
// Each hand includes its flags array and ai_analysis text if present
app.get('/api/review', async (req, res) => {
  try {
    const db          = await getDb();
    const limit         = Math.min(parseInt(req.query.limit)  || 20, 200);
    const offset        = parseInt(req.query.offset) || 0;
    const flagType      = req.query.flag_type    || null;
    const minSeverity   = parseInt(req.query.min_severity) || 1;
    const reviewedParam = req.query.reviewed ?? 'unreviewed'; // 'unreviewed' | 'reviewed' | 'all'

    const conditions = [
      "h.is_tournament = 0",
      "hf.flag_type != '_analyzed'",
      "hf.severity >= ?",
    ];
    if (reviewedParam === 'unreviewed') conditions.push("rh.hand_id IS NULL");
    else if (reviewedParam === 'reviewed') conditions.push("rh.hand_id IS NOT NULL");
    const params = [minSeverity, minSeverity]; // used twice (outer + count)

    if (flagType) {
      conditions.push("h.hand_id IN (SELECT hand_id FROM hand_flags WHERE flag_type = ?)");
      params.push(flagType, flagType);
    }

    const where = `WHERE ${conditions.join(' AND ')}`;

    const netSub = `(
      SELECT SUM(CASE WHEN a.action = 'uncalled_return'
                      THEN -COALESCE(a.amount, 0)
                      ELSE  COALESCE(a.amount, 0) END)
      FROM hand_actions a
      WHERE a.hand_id = h.hand_id AND a.player = '${HERO}'
        AND a.action IN ('post_sb','post_bb','post_ante','call','bet','raise','uncalled_return')
    )`;

    const sql = `
      SELECT
        h.hand_id, h.date_played, h.stakes, h.game_type, h.table_name,
        h.total_pot, h.big_blind, h.board, h.raw_text,
        hp.position AS hero_position, hp.hole_cards, hp.amount_won,
        hp.amount_won - COALESCE(${netSub}, 0) AS net_profit,
        MAX(hf.severity) AS max_severity,
        CASE WHEN rh.hand_id IS NOT NULL THEN 1 ELSE 0 END AS is_reviewed,
        ai.analysis AS ai_analysis, ai.model AS ai_model
      FROM hand_flags hf
      JOIN hands h ON h.hand_id = hf.hand_id
      JOIN hand_players hp ON hp.hand_id = h.hand_id AND hp.player = '${HERO}'
      LEFT JOIN reviewed_hands rh ON rh.hand_id = h.hand_id
      LEFT JOIN ai_analysis ai ON ai.hand_id = h.hand_id
      ${where}
      GROUP BY h.hand_id
      ORDER BY max_severity DESC, h.total_pot DESC
      LIMIT ? OFFSET ?
    `;

    const countSql = `
      SELECT COUNT(DISTINCT h.hand_id) AS total
      FROM hand_flags hf
      JOIN hands h ON h.hand_id = hf.hand_id
      JOIN hand_players hp ON hp.hand_id = h.hand_id AND hp.player = '${HERO}'
      LEFT JOIN reviewed_hands rh ON rh.hand_id = h.hand_id
      ${where}
    `;

    const paramsSql  = flagType ? [minSeverity, flagType, limit, offset] : [minSeverity, limit, offset];
    const paramsCount = flagType ? [minSeverity, flagType] : [minSeverity];

    const rows     = queryAll(db, sql, paramsSql);
    const countRow = queryOne(db, countSql, paramsCount);

    // Fetch flags for each hand in one query
    if (rows.length === 0) {
      return res.json({ hands: [], total: 0 });
    }
    const handIds = rows.map(r => r.hand_id);
    const placeholders = handIds.map(() => '?').join(',');
    const allFlags = queryAll(db,
      `SELECT * FROM hand_flags WHERE hand_id IN (${placeholders}) AND flag_type != '_analyzed' ORDER BY severity DESC`,
      handIds
    );
    const flagsByHand = {};
    for (const f of allFlags) {
      if (!flagsByHand[f.hand_id]) flagsByHand[f.hand_id] = [];
      flagsByHand[f.hand_id].push(f);
    }

    // Fetch actions for each hand in one query
    const allActions = queryAll(db,
      `SELECT * FROM hand_actions WHERE hand_id IN (${placeholders}) ORDER BY action_order`,
      handIds
    );
    const actionsByHand = {};
    for (const a of allActions) {
      if (!actionsByHand[a.hand_id]) actionsByHand[a.hand_id] = [];
      actionsByHand[a.hand_id].push(a);
    }

    // Fetch players for each hand
    const allPlayers = queryAll(db,
      `SELECT * FROM hand_players WHERE hand_id IN (${placeholders}) ORDER BY seat`,
      handIds
    );
    const playersByHand = {};
    for (const p of allPlayers) {
      if (!playersByHand[p.hand_id]) playersByHand[p.hand_id] = [];
      playersByHand[p.hand_id].push(p);
    }

    // Compute net_profit per player per hand
    const allInvested = queryAll(db,
      `SELECT hand_id, player,
              SUM(CASE WHEN action = 'uncalled_return'
                       THEN -COALESCE(amount, 0)
                       ELSE  COALESCE(amount, 0) END) AS invested
       FROM hand_actions
       WHERE hand_id IN (${placeholders})
         AND action IN ('post_sb','post_bb','post_ante','call','bet','raise','uncalled_return')
       GROUP BY hand_id, player`,
      handIds
    );
    const investedByHandPlayer = {};
    for (const row of allInvested) {
      if (!investedByHandPlayer[row.hand_id]) investedByHandPlayer[row.hand_id] = {};
      investedByHandPlayer[row.hand_id][row.player] = row.invested || 0;
    }

    const hands = rows.map(r => ({
      ...r,
      board:      JSON.parse(r.board      || '[]'),
      hole_cards: JSON.parse(r.hole_cards || '[]'),
      flags:      flagsByHand[r.hand_id]  || [],
      actions:    actionsByHand[r.hand_id] || [],
      players:    (playersByHand[r.hand_id] || []).map(p => {
        const invested = (investedByHandPlayer[r.hand_id] || {})[p.player] || 0;
        return {
          ...p,
          hole_cards: JSON.parse(p.hole_cards || '[]'),
          net_profit: Math.round(((p.amount_won || 0) - invested) * 100) / 100,
        };
      }),
    }));

    res.json({ hands, total: countRow?.total ?? 0 });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/review/:handId/reviewed — mark a hand as reviewed
app.post('/api/review/:handId/reviewed', async (req, res) => {
  try {
    const db = await getDb();
    db.run(
      'INSERT OR REPLACE INTO reviewed_hands (hand_id) VALUES (?)',
      [req.params.handId]
    );
    saveDb();
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/review/:handId/reviewed — unmark a hand as reviewed
app.delete('/api/review/:handId/reviewed', async (req, res) => {
  try {
    const db = await getDb();
    db.run('DELETE FROM reviewed_hands WHERE hand_id = ?', [req.params.handId]);
    saveDb();
    res.json({ ok: true });
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

// ── Reparse all hand actions ───────────────────────────────────────────────────
// POST /api/reparse-hand-actions
// Deletes and re-inserts hand_actions for every hand using the current parser.
// Fixes raise 'amount' values (now stores actual chips in, not PokerStars increment)
// and adds uncalled_return records for bets that were returned uncontested.
app.post('/api/reparse-hand-actions', async (req, res) => {
  try {
    const result = await reparseHandActions();
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Reparse uncalled bets ──────────────────────────────────────────────────────
// POST /api/reparse-uncalled
// Scans raw_text of every hand and inserts missing uncalled_return actions so
// that net profit is calculated correctly for hands won without showdown.
app.post('/api/reparse-uncalled', async (req, res) => {
  try {
    const result = await reparseUncalled();
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
        analyzeAllHands()
          .then(a => console.log(`[startup] Analysis complete: ${a.analyzed} hand(s) analyzed, ${a.flagged} flag(s) added`))
          .catch(err => console.warn(`[startup] Analysis error: ${err.message}`));
      } else {
        console.log(`[startup] DB is up to date (${r.skipped} hand(s) already present)`);
      }
      startWatcher(DEFAULT_HH_PATH, ({ file, imported }) => {
        console.log(`[watcher] Triggering analysis after ${imported} new hand(s) from ${file}`);
        analyzeAllHands()
          .then(a => console.log(`[watcher] Analysis complete: ${a.analyzed} hand(s) analyzed, ${a.flagged} flag(s) added`))
          .catch(err => console.warn(`[watcher] Analysis error: ${err.message}`));
      });
    })
    .catch(err => {
      console.warn(`[startup] Initial import warning: ${err.message}`);
      // Still start the watcher even if the initial import fails
      startWatcher(DEFAULT_HH_PATH, ({ file, imported }) => {
        console.log(`[watcher] Triggering analysis after ${imported} new hand(s) from ${file}`);
        analyzeAllHands()
          .then(a => console.log(`[watcher] Analysis complete: ${a.analyzed} hand(s) analyzed, ${a.flagged} flag(s) added`))
          .catch(err => console.warn(`[watcher] Analysis error: ${err.message}`));
      });
    });
});
