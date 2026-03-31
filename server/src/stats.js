'use strict';

const { getDb, queryAll, queryOne } = require('./db');

// ── Filter helper ─────────────────────────────────────────────────────────────
// Returns { extra: " AND ...", params: [...] } for appending to WHERE clauses.
// All stat queries alias the hands table as `h`.
// Position filter uses h.hand_id subquery so it's compatible with both
// hand_players (hp) and hand_actions (ha) based queries.
function buildFilter(opts, player) {
  const conds = [];
  const params = [];
  if (opts.from)              { conds.push('h.date_played >= ?'); params.push(opts.from); }
  if (opts.to)                { conds.push('h.date_played <= ?');  params.push(opts.to); }
  if (opts.game_type)         { conds.push('h.game_type = ?');     params.push(opts.game_type); }
  if (opts.stakes)            { conds.push('h.stakes = ?');        params.push(opts.stakes); }
  if (opts.is_tournament != null) {
    conds.push('h.is_tournament = ?');
    params.push(opts.is_tournament ? 1 : 0);
  }
  if (opts.position && player) {
    conds.push('h.hand_id IN (SELECT hand_id FROM hand_players WHERE player = ? AND position = ?)');
    params.push(player, opts.position);
  }
  return {
    extra:  conds.length ? ' AND ' + conds.join(' AND ') : '',
    params,
  };
}

const pct = (num, den) =>
  den > 0 ? Math.round((num / den) * 1000) / 10 : null;

const round2 = n => Math.round(n * 100) / 100;

// ─────────────────────────────────────────────────────────────────────────────
// computeStats — all metrics for one player with optional filters
// ─────────────────────────────────────────────────────────────────────────────
async function computeStats(player, opts = {}) {
  const db = await getDb();
  const f  = buildFilter(opts, player);

  // ── Total hands & basic player data ───────────────────────────────────────
  const handRows = queryAll(db,
    `SELECT hp.hand_id, hp.amount_won, hp.did_muck,
            h.big_blind, h.is_tournament, h.date_played
     FROM hand_players hp
     JOIN hands h ON h.hand_id = hp.hand_id
     WHERE hp.player = ?${f.extra}
     ORDER BY h.date_played`,
    [player, ...f.params]
  );

  const totalHands = handRows.length;
  if (!totalHands) return emptyStats(player, opts);

  // ── Amount invested per hand (player's total $ put into pot) ──────────────
  // Using JOIN instead of IN to stay within SQLite variable limits.
  const investedRows = queryAll(db,
    `SELECT ha.hand_id,
            SUM(CASE WHEN ha.action = 'uncalled_return'
                     THEN -COALESCE(ha.amount, 0)
                     ELSE  COALESCE(ha.amount, 0) END) AS invested
     FROM hand_actions ha
     JOIN hands h ON h.hand_id = ha.hand_id
     WHERE ha.player = ?${f.extra}
       AND ha.action IN ('post_sb','post_bb','post_ante','call','bet','raise','uncalled_return')
     GROUP BY ha.hand_id`,
    [player, ...f.params]
  );
  const investedByHand = Object.fromEntries(
    investedRows.map(r => [r.hand_id, r.invested || 0])
  );

  // ── Net profit: split cash (USD) vs tournament (chips) ────────────────────
  let cashNet = 0, cashBBsum = 0, cashCount = 0;
  let tournChips = 0, tournCount = 0;

  for (const r of handRows) {
    const net = r.amount_won - (investedByHand[r.hand_id] || 0);
    if (r.is_tournament) {
      tournChips += net;
      tournCount++;
    } else {
      cashNet    += net;
      cashCount++;
      if (r.big_blind > 0) cashBBsum += net / r.big_blind;
    }
  }

  const bb100 = cashCount > 0 ? round2((cashBBsum / cashCount) * 100) : null;

  // ── VPIP: voluntarily put $ in preflop (call/raise/bet, not blind posts) ──
  const vpipHands = queryOne(db,
    `SELECT COUNT(DISTINCT ha.hand_id) AS n
     FROM hand_actions ha
     JOIN hands h ON h.hand_id = ha.hand_id
     WHERE ha.player = ?${f.extra}
       AND ha.street = 'preflop'
       AND ha.action IN ('call','raise','bet')`,
    [player, ...f.params]
  ).n;

  // ── PFR: raised preflop ────────────────────────────────────────────────────
  const pfrHands = queryOne(db,
    `SELECT COUNT(DISTINCT ha.hand_id) AS n
     FROM hand_actions ha
     JOIN hands h ON h.hand_id = ha.hand_id
     WHERE ha.player = ?${f.extra}
       AND ha.street = 'preflop' AND ha.action = 'raise'`,
    [player, ...f.params]
  ).n;

  // ── 3-bet: hero raised preflop after someone else had already raised ───────
  const threeBetHands = queryOne(db,
    `SELECT COUNT(DISTINCT ha.hand_id) AS n
     FROM hand_actions ha
     JOIN hands h ON h.hand_id = ha.hand_id
     WHERE ha.player = ?${f.extra}
       AND ha.street = 'preflop' AND ha.action = 'raise'
       AND EXISTS (
         SELECT 1 FROM hand_actions prev
         WHERE prev.hand_id = ha.hand_id
           AND prev.street = 'preflop' AND prev.action = 'raise'
           AND prev.player != ha.player
           AND prev.action_order < ha.action_order
       )`,
    [player, ...f.params]
  ).n;

  // 3-bet opportunity: hero still had a preflop decision after someone raised
  const threeBetOpps = queryOne(db,
    `SELECT COUNT(DISTINCT ha.hand_id) AS n
     FROM hand_actions ha
     JOIN hands h ON h.hand_id = ha.hand_id
     WHERE ha.player = ?${f.extra}
       AND ha.street = 'preflop'
       AND EXISTS (
         SELECT 1 FROM hand_actions rz
         WHERE rz.hand_id  = ha.hand_id
           AND rz.street   = 'preflop' AND rz.action = 'raise'
           AND rz.player  != ha.player
           AND rz.action_order < ha.action_order
       )`,
    [player, ...f.params]
  ).n;

  // ── Aggression Factor per street: (bets+raises) / calls ───────────────────
  const aggrRows = queryAll(db,
    `SELECT ha.street,
            SUM(CASE WHEN ha.action IN ('bet','raise') THEN 1 ELSE 0 END) AS aggressive,
            SUM(CASE WHEN ha.action = 'call'           THEN 1 ELSE 0 END) AS passive
     FROM hand_actions ha
     JOIN hands h ON h.hand_id = ha.hand_id
     WHERE ha.player = ?${f.extra}
       AND ha.street IN ('flop','turn','river')
     GROUP BY ha.street`,
    [player, ...f.params]
  );
  const afByStreet = {};
  let totalAggr = 0, totalPass = 0;
  for (const row of aggrRows) {
    afByStreet[row.street] = row.passive > 0
      ? round2(row.aggressive / row.passive)
      : row.aggressive;
    totalAggr += row.aggressive;
    totalPass += row.passive;
  }
  const afOverall = totalPass > 0 ? round2(totalAggr / totalPass) : totalAggr;

  // ── Saw flop ───────────────────────────────────────────────────────────────
  const sawFlop = queryOne(db,
    `SELECT COUNT(DISTINCT ha.hand_id) AS n
     FROM hand_actions ha
     JOIN hands h ON h.hand_id = ha.hand_id
     WHERE ha.player = ?${f.extra}
       AND ha.street = 'flop'`,
    [player, ...f.params]
  ).n;

  // ── WTSD: didn't fold AND the hand went to showdown ───────────────────────
  // "Went to showdown" = another player showed or mucked (hole_cards != '[]' for
  //  non-hero players means cards were revealed at showdown; did_muck = 1 likewise).
  const wtsdHands = queryOne(db,
    `SELECT COUNT(DISTINCT hp.hand_id) AS n
     FROM hand_players hp
     JOIN hands h ON h.hand_id = hp.hand_id
     WHERE hp.player = ?${f.extra}
       AND NOT EXISTS (
         SELECT 1 FROM hand_actions fa
         WHERE fa.hand_id = hp.hand_id
           AND fa.player  = hp.player
           AND fa.action  = 'fold'
       )
       AND EXISTS (
         SELECT 1 FROM hand_players other
         WHERE other.hand_id = hp.hand_id
           AND other.player != hp.player
           AND (other.did_muck = 1 OR other.hole_cards != '[]')
       )`,
    [player, ...f.params]
  ).n;

  // ── W$SD: went to showdown AND won money ──────────────────────────────────
  const wsdWon = queryOne(db,
    `SELECT COUNT(DISTINCT hp.hand_id) AS n
     FROM hand_players hp
     JOIN hands h ON h.hand_id = hp.hand_id
     WHERE hp.player = ?${f.extra}
       AND hp.amount_won > 0
       AND NOT EXISTS (
         SELECT 1 FROM hand_actions fa
         WHERE fa.hand_id = hp.hand_id
           AND fa.player  = hp.player
           AND fa.action  = 'fold'
       )
       AND EXISTS (
         SELECT 1 FROM hand_players other
         WHERE other.hand_id = hp.hand_id
           AND other.player != hp.player
           AND (other.did_muck = 1 OR other.hole_cards != '[]')
       )`,
    [player, ...f.params]
  ).n;

  // ── C-Bet: bet the flop after raising preflop ─────────────────────────────
  const cbetDone = queryOne(db,
    `SELECT COUNT(DISTINCT ha.hand_id) AS n
     FROM hand_actions ha
     JOIN hands h ON h.hand_id = ha.hand_id
     WHERE ha.player = ?${f.extra}
       AND ha.street = 'flop' AND ha.action = 'bet'
       AND EXISTS (
         SELECT 1 FROM hand_actions pre
         WHERE pre.hand_id = ha.hand_id
           AND pre.player  = ha.player
           AND pre.street  = 'preflop' AND pre.action = 'raise'
       )`,
    [player, ...f.params]
  ).n;

  // C-bet opportunity: raised preflop and had a flop action
  const cbetOpps = queryOne(db,
    `SELECT COUNT(DISTINCT ha.hand_id) AS n
     FROM hand_actions ha
     JOIN hands h ON h.hand_id = ha.hand_id
     WHERE ha.player = ?${f.extra}
       AND ha.street = 'flop'
       AND EXISTS (
         SELECT 1 FROM hand_actions pre
         WHERE pre.hand_id = ha.hand_id
           AND pre.player  = ha.player
           AND pre.street  = 'preflop' AND pre.action = 'raise'
       )`,
    [player, ...f.params]
  ).n;

  // ── Fold to C-Bet ─────────────────────────────────────────────────────────
  // Numerator: hero folded on flop when a c-bet (bet from PF raiser) preceded it
  const foldToCbet = queryOne(db,
    `SELECT COUNT(DISTINCT ha.hand_id) AS n
     FROM hand_actions ha
     JOIN hands h ON h.hand_id = ha.hand_id
     WHERE ha.player = ?${f.extra}
       AND ha.street = 'flop' AND ha.action = 'fold'
       AND EXISTS (
         SELECT 1 FROM hand_actions cbet
         WHERE cbet.hand_id     = ha.hand_id
           AND cbet.player     != ha.player
           AND cbet.street      = 'flop' AND cbet.action = 'bet'
           AND cbet.action_order < ha.action_order
           AND EXISTS (
             SELECT 1 FROM hand_actions pre
             WHERE pre.hand_id = cbet.hand_id
               AND pre.player  = cbet.player
               AND pre.street  = 'preflop' AND pre.action = 'raise'
           )
       )`,
    [player, ...f.params]
  ).n;

  // Denominator: hero had a flop action and a c-bet came before it
  const facedCbet = queryOne(db,
    `SELECT COUNT(DISTINCT ha.hand_id) AS n
     FROM hand_actions ha
     JOIN hands h ON h.hand_id = ha.hand_id
     WHERE ha.player = ?${f.extra}
       AND ha.street = 'flop'
       AND EXISTS (
         SELECT 1 FROM hand_actions cbet
         WHERE cbet.hand_id     = ha.hand_id
           AND cbet.player     != ha.player
           AND cbet.street      = 'flop' AND cbet.action = 'bet'
           AND cbet.action_order < ha.action_order
           AND EXISTS (
             SELECT 1 FROM hand_actions pre
             WHERE pre.hand_id = cbet.hand_id
               AND pre.player  = cbet.player
               AND pre.street  = 'preflop' AND pre.action = 'raise'
           )
       )`,
    [player, ...f.params]
  ).n;

  // ── Assemble result ────────────────────────────────────────────────────────
  return {
    player,
    filters: opts,
    total_hands:  totalHands,
    cash_hands:   cashCount,
    tourn_hands:  tournCount,

    profit: {
      cash_net_usd:    round2(cashNet),
      tourn_net_chips: round2(tournChips),
      bb_100: bb100,   // cash only — null when no cash hands
    },

    preflop: {
      vpip:      pct(vpipHands,      totalHands),
      pfr:       pct(pfrHands,       totalHands),
      three_bet: pct(threeBetHands,  threeBetOpps),
    },

    aggression: {
      overall: afOverall,
      flop:    afByStreet.flop  ?? null,
      turn:    afByStreet.turn  ?? null,
      river:   afByStreet.river ?? null,
    },

    postflop: {
      saw_flop:     pct(sawFlop,  totalHands),
      wtsd:         pct(wtsdHands, sawFlop),
      w_sd:         pct(wsdWon,   wtsdHands),
      cbet:         pct(cbetDone, cbetOpps),
      fold_to_cbet: pct(foldToCbet, facedCbet),
    },

    // Raw counts — useful for the frontend to show sample sizes
    counts: {
      vpip: vpipHands, pfr: pfrHands,
      three_bet: threeBetHands, three_bet_opps: threeBetOpps,
      saw_flop: sawFlop,
      wtsd: wtsdHands, wsd_won: wsdWon,
      cbet_done: cbetDone, cbet_opps: cbetOpps,
      fold_to_cbet: foldToCbet, faced_cbet: facedCbet,
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// computeSessions — hands grouped into sessions (30-min idle = new session)
// ─────────────────────────────────────────────────────────────────────────────
const SESSION_GAP_MS = 30 * 60 * 1000;

async function computeSessions(player, opts = {}) {
  const db = await getDb();
  const f  = buildFilter(opts, player);

  const hands = queryAll(db,
    `SELECT hp.hand_id, hp.amount_won,
            h.date_played, h.big_blind, h.stakes, h.game_type,
            h.is_tournament, h.table_name
     FROM hand_players hp
     JOIN hands h ON h.hand_id = hp.hand_id
     WHERE hp.player = ?${f.extra}
       AND h.date_played IS NOT NULL
     ORDER BY h.date_played ASC`,
    [player, ...f.params]
  );
  if (!hands.length) return [];

  // Amount invested per hand
  const investedRows = queryAll(db,
    `SELECT ha.hand_id,
            SUM(CASE WHEN ha.action = 'uncalled_return'
                     THEN -COALESCE(ha.amount, 0)
                     ELSE  COALESCE(ha.amount, 0) END) AS invested
     FROM hand_actions ha
     JOIN hands h ON h.hand_id = ha.hand_id
     WHERE ha.player = ?${f.extra}
       AND ha.action IN ('post_sb','post_bb','post_ante','call','bet','raise','uncalled_return')
     GROUP BY ha.hand_id`,
    [player, ...f.params]
  );
  const investedByHand = Object.fromEntries(
    investedRows.map(r => [r.hand_id, r.invested || 0])
  );

  const sessions = [];
  let cur = null;

  for (const hand of hands) {
    const net  = hand.amount_won - (investedByHand[hand.hand_id] || 0);
    const tsMs = new Date(hand.date_played.replace(' ', 'T')).getTime();

    if (!cur || tsMs - cur.lastMs > SESSION_GAP_MS) {
      if (cur) sessions.push(closeSession(cur));
      cur = {
        start:         hand.date_played,
        end:           hand.date_played,
        lastMs:        tsMs,
        hands:         0,
        cashNet:       0,
        tournChips:    0,
        stakes:        hand.stakes,
        game_type:     hand.game_type,
        is_tournament: !!hand.is_tournament,
        tablesSet:     new Set(),
        sparkline:     [0],   // running cumulative net, starts at breakeven
        runningNet:    0,
        cashBBSum:     0,
        cashCount:     0,
      };
    }

    cur.end    = hand.date_played;
    cur.lastMs = tsMs;
    cur.hands++;
    if (hand.table_name) cur.tablesSet.add(hand.table_name);

    cur.runningNet += net;
    cur.sparkline.push(round2(cur.runningNet));

    if (hand.is_tournament) {
      cur.tournChips += net;
    } else {
      cur.cashNet += net;
      if (hand.big_blind > 0) {
        cur.cashBBSum += net / hand.big_blind;
        cur.cashCount++;
      }
    }
  }
  if (cur) sessions.push(closeSession(cur));

  return sessions.reverse(); // most recent first
}

function closeSession(s) {
  const startMs = new Date(s.start.replace(' ', 'T')).getTime();
  const endMs   = new Date(s.end.replace(' ', 'T')).getTime();
  const bb100   = s.cashCount > 0 ? round2((s.cashBBSum / s.cashCount) * 100) : null;
  return {
    start:           s.start,
    end:             s.end,
    duration_min:    Math.max(1, Math.round((endMs - startMs) / 60_000)),
    hands:           s.hands,
    stakes:          s.stakes,
    game_type:       s.game_type,
    is_tournament:   s.is_tournament,
    tables:          [...s.tablesSet],
    sparkline:       s.sparkline,
    bb_100:          bb100,
    // Only one will be non-zero per session (sessions rarely mix formats)
    cash_net_usd:    round2(s.cashNet),
    tourn_net_chips: round2(s.tournChips),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// computeProfitCurve — running cumulative net by hand for chart rendering
// Returns cash and tournament series separately.
// ─────────────────────────────────────────────────────────────────────────────
async function computeProfitCurve(player, opts = {}) {
  const db = await getDb();
  const f  = buildFilter(opts, player);

  const hands = queryAll(db,
    `SELECT hp.hand_id, hp.amount_won,
            h.date_played, h.big_blind, h.is_tournament
     FROM hand_players hp
     JOIN hands h ON h.hand_id = hp.hand_id
     WHERE hp.player = ?${f.extra}
       AND h.date_played IS NOT NULL
     ORDER BY h.date_played ASC`,
    [player, ...f.params]
  );
  if (!hands.length) return { cash: [], tournament: [] };

  const investedRows = queryAll(db,
    `SELECT ha.hand_id,
            SUM(CASE WHEN ha.action = 'uncalled_return'
                     THEN -COALESCE(ha.amount, 0)
                     ELSE  COALESCE(ha.amount, 0) END) AS invested
     FROM hand_actions ha
     JOIN hands h ON h.hand_id = ha.hand_id
     WHERE ha.player = ?${f.extra}
       AND ha.action IN ('post_sb','post_bb','post_ante','call','bet','raise','uncalled_return')
     GROUP BY ha.hand_id`,
    [player, ...f.params]
  );
  const investedByHand = Object.fromEntries(
    investedRows.map(r => [r.hand_id, r.invested || 0])
  );

  const cashSeries = [], tournSeries = [];
  let cashRunning = 0, cashRunningBB = 0, tournRunning = 0;

  for (const hand of hands) {
    const net = hand.amount_won - (investedByHand[hand.hand_id] || 0);
    if (hand.is_tournament) {
      tournRunning += net;
      tournSeries.push({ date: hand.date_played, cumulative: round2(tournRunning) });
    } else {
      cashRunning += net;
      if (hand.big_blind > 0) cashRunningBB += net / hand.big_blind;
      cashSeries.push({
        date: hand.date_played,
        cumulative:    round2(cashRunning),
        cumulative_bb: round2(cashRunningBB),
      });
    }
  }

  return { cash: cashSeries, tournament: tournSeries };
}

// ─────────────────────────────────────────────────────────────────────────────
// getAvailableFilters — distinct values in the DB for filter dropdowns
// ─────────────────────────────────────────────────────────────────────────────
async function getAvailableFilters(player) {
  const db = await getDb();
  const f  = buildFilter({});  // no extra filter

  const gameTypes = queryAll(db,
    `SELECT DISTINCT h.game_type
     FROM hand_players hp JOIN hands h ON h.hand_id = hp.hand_id
     WHERE hp.player = ? AND h.game_type IS NOT NULL
     ORDER BY h.game_type`,
    [player]
  ).map(r => r.game_type);

  const stakes = queryAll(db,
    `SELECT DISTINCT h.stakes, h.is_tournament
     FROM hand_players hp JOIN hands h ON h.hand_id = hp.hand_id
     WHERE hp.player = ? AND h.stakes IS NOT NULL
     ORDER BY h.is_tournament, h.stakes`,
    [player]
  );

  const dateRange = queryOne(db,
    `SELECT MIN(h.date_played) AS first, MAX(h.date_played) AS last
     FROM hand_players hp JOIN hands h ON h.hand_id = hp.hand_id
     WHERE hp.player = ?`,
    [player]
  );

  return { game_types: gameTypes, stakes, date_range: dateRange };
}

// ─────────────────────────────────────────────────────────────────────────────
// computePositionStats — BB/100 per position for cash hands
// ─────────────────────────────────────────────────────────────────────────────
async function computePositionStats(player, opts = {}) {
  const db = await getDb();
  const f  = buildFilter(opts, player);

  const handRows = queryAll(db,
    `SELECT hp.hand_id, hp.position, hp.amount_won, h.big_blind
     FROM hand_players hp
     JOIN hands h ON h.hand_id = hp.hand_id
     WHERE hp.player = ?${f.extra}
       AND h.is_tournament = 0
       AND hp.position IS NOT NULL`,
    [player, ...f.params]
  );
  if (!handRows.length) return [];

  const investedRows = queryAll(db,
    `SELECT ha.hand_id,
            SUM(CASE WHEN ha.action = 'uncalled_return'
                     THEN -COALESCE(ha.amount, 0)
                     ELSE  COALESCE(ha.amount, 0) END) AS invested
     FROM hand_actions ha
     JOIN hands h ON h.hand_id = ha.hand_id
     WHERE ha.player = ?${f.extra}
       AND h.is_tournament = 0
       AND ha.action IN ('post_sb','post_bb','post_ante','call','bet','raise','uncalled_return')
     GROUP BY ha.hand_id`,
    [player, ...f.params]
  );
  const investedByHand = Object.fromEntries(
    investedRows.map(r => [r.hand_id, r.invested || 0])
  );

  const byPos = {};
  for (const r of handRows) {
    const pos = r.position;
    if (!byPos[pos]) byPos[pos] = { net: 0, bbSum: 0, count: 0 };
    const net = r.amount_won - (investedByHand[r.hand_id] || 0);
    byPos[pos].net   += net;
    byPos[pos].count++;
    if (r.big_blind > 0) byPos[pos].bbSum += net / r.big_blind;
  }

  return Object.entries(byPos).map(([position, d]) => ({
    position,
    hand_count: d.count,
    net_usd:    round2(d.net),
    bb_100:     d.count > 0 ? round2((d.bbSum / d.count) * 100) : null,
  }));
}

function emptyStats(player, opts) {
  return {
    player, filters: opts,
    total_hands: 0, cash_hands: 0, tourn_hands: 0,
    profit: { cash_net_usd: 0, tourn_net_chips: 0, bb_100: null },
    preflop: { vpip: null, pfr: null, three_bet: null },
    aggression: { overall: null, flop: null, turn: null, river: null },
    postflop: { saw_flop: null, wtsd: null, w_sd: null, cbet: null, fold_to_cbet: null },
    counts: {},
  };
}

module.exports = { computeStats, computeSessions, computeProfitCurve, getAvailableFilters, computePositionStats };
