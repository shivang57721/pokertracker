'use strict';

// ── Rank constants ─────────────────────────────────────────────────────────────
const RANKS = '23456789TJQKA';
const RANK_IDX = {};
for (let i = 0; i < RANKS.length; i++) RANK_IDX[RANKS[i]] = i;

// ── Hand classification ────────────────────────────────────────────────────────
// Returns e.g. 'AKs', 'T9o', '77'
function classifyHand(holeCards) {
  if (!holeCards || holeCards.length !== 2) return null;
  const r1 = holeCards[0][0], s1 = holeCards[0][1];
  const r2 = holeCards[1][0], s2 = holeCards[1][1];
  const i1 = RANK_IDX[r1], i2 = RANK_IDX[r2];
  if (i1 == null || i2 == null) return null;
  if (i1 === i2) return r1 + r2;                                 // pocket pair
  const [hi, lo] = i1 > i2 ? [r1, r2] : [r2, r1];
  return hi + lo + (s1 === s2 ? 's' : 'o');
}

// ── Range expansion ────────────────────────────────────────────────────────────
// Expands a single token like '22+', 'A3s+', 'KJo', 'T9s' → Set of hand strings
function expandRangeToken(token) {
  const hands = new Set();
  const plus = token.endsWith('+');
  const base = plus ? token.slice(0, -1) : token;
  const r1 = base[0], r2 = base[1];
  const suffix = base.length > 2 ? base[2] : '';
  const r1i = RANK_IDX[r1], r2i = RANK_IDX[r2];
  if (r1i == null || r2i == null) return hands;

  if (r1 === r2) {
    // Pair notation e.g. '77+' → 77,88,...,AA
    if (plus) {
      for (let i = r1i; i < RANKS.length; i++) hands.add(RANKS[i] + RANKS[i]);
    } else {
      hands.add(r1 + r2);
    }
  } else {
    // Suited/offsuit e.g. 'A3s+' → A3s..AKs, 'KJo' → just KJo
    if (plus) {
      for (let i = r2i; i < r1i; i++) hands.add(r1 + RANKS[i] + suffix);
    } else {
      hands.add(r1 + r2 + suffix);
    }
  }
  return hands;
}

function parseRangeString(str) {
  const result = new Set();
  for (const token of str.split(',').map(t => t.trim()).filter(Boolean)) {
    for (const h of expandRangeToken(token)) result.add(h);
  }
  return result;
}

// ── Pre-computed RFI ranges (6-max cash, GTO-simplified) ──────────────────────
const RFI_RANGES = {
  // 66+, Ax suited, Kx suited, broadway suited, select offsuit broadways + suited connectors/gappers
  utg: parseRangeString('66+, A2s+, K5s+, Q9s+, JTs, T9s, 65s, QJo, KJo+, ATo+'),
  hj:  parseRangeString('66+, A2s+, K4s+, Q8s+, J9s+, T8s, 54s, 65s, 76s, 87s, 98s, T9s, QTo+, KTo+, A9o+'),
  co:  parseRangeString('22+, A2s+, K3s+, Q5s+, J7s+, T7s+, JTo, QTo+, KTo+, A8o+, 54s, 65s, 76s, 87s, 98s, 97s'),
  btn: parseRangeString('22+, A2s+, K2s+, Q2s+, J4s+, T6s+, 96s+, J9o+, T9o, Q9o+, K9o+, A4o+, 54s, 65s, 76s, 87s, 64s, 75s, 86s, 85s'),
  sb:  parseRangeString('22+, A2s+, K2s+, Q2s+, J4s+, T6s+, 96s+, J9o+, T9o, Q9o+, K9o+, A4o+, 54s, 65s, 76s, 87s, 53s, 64s, 75s, 86s, 85s, T8o, 98o'),
};

// ── BB defence call ranges vs a single open (keyed by opener position) ────────
const BB_DEFENCE_RANGES = {
  utg: parseRangeString('22+, A2s+, K3s+, Q8s+, J8s+, ATo+, KJo+, QJo, 52s+, 42s+'),
  hj:  parseRangeString('22+, A2s+, K2s+, Q5s+, J7s+, T7s+, ATo+, KJo+, QJo, 52s+, 42s+'),
  co:  parseRangeString('22+, A2s+, K2s+, Q3s+, J6s+, T7s+, A9o+, KTo+, QTo+, JTo, 52s+, 42s+'),
  btn: parseRangeString('22+, A2s+, K2s+, Q2s+, J2s+, T5s+, 95s+, A4o+, K9o+, Q9o+, J9o+, 52s+, 42s+'),
  sb:  parseRangeString('22+, A2s+, K2s+, Q2s+, J2s+, T2s+, 95s+, A2o+, K7o+, Q8o+, J8o+, 52s+, 42s+, 32s, 73s, 84s, 54o, 65o, 76o, 87o, 98o, T9o'),
};

// ── 3-bet ranges ───────────────────────────────────────────────────────────────
const THREE_BET_VALUE = new Set(['TT', 'JJ', 'QQ', 'KK', 'AA', 'AQs', 'AKs', 'AKo']);
const THREE_BET_BLUFF = new Set(['A2s', 'A3s', 'A4s', 'A5s', '76s', '87s', '98s', 'T9s', '86s', '97s', 'T8s']);
const REASONABLE_THREE_BET = new Set([...THREE_BET_VALUE, ...THREE_BET_BLUFF]);

// ── Draw detection ─────────────────────────────────────────────────────────────
function hasMadeFlush(holeCards, board) {
  const all = [...holeCards, ...board];
  const sc = {};
  for (const c of all) sc[c[1]] = (sc[c[1]] || 0) + 1;
  return Object.entries(sc).some(([s, n]) => n >= 5 && holeCards.some(c => c[1] === s));
}

function hasFlushDraw(holeCards, board) {
  if (hasMadeFlush(holeCards, board)) return false;
  const all = [...holeCards, ...board];
  const sc = {};
  for (const c of all) sc[c[1]] = (sc[c[1]] || 0) + 1;
  return Object.entries(sc).some(([s, n]) => n >= 4 && holeCards.some(c => c[1] === s));
}

// Returns 'oesd', 'gutshot', or null
function getStraightDrawType(holeCards, board) {
  const all = [...holeCards, ...board];
  const heroNums = new Set(holeCards.map(c => RANK_IDX[c[0]]));
  const allNums  = new Set(all.map(c => RANK_IDX[c[0]]));
  if (allNums.has(12))  allNums.add(-1);   // ace-low
  if (heroNums.has(12)) heroNums.add(-1);

  // Skip if already a straight
  for (let lo = -1; lo <= 9; lo++) {
    const w = [lo, lo + 1, lo + 2, lo + 3, lo + 4];
    if (w.every(r => allNums.has(r)) && w.some(r => heroNums.has(r))) return null;
  }

  let best = null;
  for (let lo = -1; lo <= 9; lo++) {
    const w = [lo, lo + 1, lo + 2, lo + 3, lo + 4];
    const present = w.filter(r => allNums.has(r));
    if (present.length !== 4) continue;
    if (!present.some(r => heroNums.has(r))) continue;
    const span = present[present.length - 1] - present[0];
    if (span === 3) return 'oesd'; // 4 consecutive → open-ended (best possible)
    if (!best) best = 'gutshot';
  }
  return best;
}

function hasMadeStraight(holeCards, board) {
  const all = [...holeCards, ...board];
  const heroNums = new Set(holeCards.map(c => RANK_IDX[c[0]]));
  const allNums  = new Set(all.map(c => RANK_IDX[c[0]]));
  if (allNums.has(12))  allNums.add(-1);
  if (heroNums.has(12)) heroNums.add(-1);
  for (let lo = -1; lo <= 9; lo++) {
    const w = [lo, lo + 1, lo + 2, lo + 3, lo + 4];
    if (w.every(r => allNums.has(r)) && w.some(r => heroNums.has(r))) return true;
  }
  return false;
}

// ── Board texture ──────────────────────────────────────────────────────────────
// Dry = rainbow AND no 3 cards within a 5-rank window (accounts for ace-low)
function isDryBoard(board) {
  if (!board || board.length < 3) return false;
  const flop  = board.slice(0, 3);
  const suits = flop.map(c => c[1]);
  if (new Set(suits).size < 3) return false; // two-tone or monotone

  const ranks = flop.map(c => RANK_IDX[c[0]]).sort((a, b) => a - b);
  const span  = ranks[2] - ranks[0];
  if (span <= 4) return false; // connected

  // Also check ace-low connectivity (A-2-3 etc.)
  if (ranks[2] === 12) { // ace on board
    const aceLow = [ranks[0], ranks[1], -1].sort((a, b) => a - b);
    if (aceLow[2] - aceLow[0] <= 4) return false;
  }
  return true;
}

// ── Hand strength evaluation ───────────────────────────────────────────────────
// Returns: 'two_pair_plus' | 'overpair' | 'top_pair' | 'pair_below_top' | 'no_pair'
function evaluateHandStrength(holeCards, board) {
  if (!board || board.length === 0) return 'no_pair';
  const all        = [...holeCards, ...board];
  const heroRanks  = holeCards.map(c => RANK_IDX[c[0]]);
  const boardNums  = board.map(c => RANK_IDX[c[0]]);
  const maxBoard   = Math.max(...boardNums);

  // Rank-count map across all 7 cards
  const rc = {};
  for (const c of all) { const r = RANK_IDX[c[0]]; rc[r] = (rc[r] || 0) + 1; }
  const vals       = Object.values(rc);
  const hasQuads   = vals.includes(4);
  const tripsCount = vals.filter(v => v === 3).length;
  const pairCount  = vals.filter(v => v === 2).length;

  // Flush
  const sc = {};
  for (const c of all) sc[c[1]] = (sc[c[1]] || 0) + 1;
  const madeFlush = Object.entries(sc).some(([s, n]) => n >= 5 && holeCards.some(c => c[1] === s));

  // Straight
  const allNums   = new Set(all.map(c => RANK_IDX[c[0]]));
  const heroSet   = new Set(heroRanks);
  if (allNums.has(12)) allNums.add(-1);
  if (heroSet.has(12))  heroSet.add(-1);
  let madeStraight = false;
  for (let lo = -1; lo <= 9; lo++) {
    const w = [lo, lo + 1, lo + 2, lo + 3, lo + 4];
    if (w.every(r => allNums.has(r)) && w.some(r => heroSet.has(r))) { madeStraight = true; break; }
  }

  if (hasQuads || (tripsCount >= 1 && pairCount >= 1) || madeFlush || madeStraight || tripsCount >= 1 || pairCount >= 2) {
    return 'two_pair_plus';
  }

  if (pairCount === 1) {
    const [pairedRankStr] = Object.entries(rc).find(([, c]) => c === 2);
    const pairedRank = parseInt(pairedRankStr, 10);
    if (!heroRanks.includes(pairedRank)) return 'no_pair';        // board pair only
    if (!boardNums.includes(pairedRank)) {
      return pairedRank > maxBoard ? 'overpair' : 'pair_below_top'; // pocket pair
    }
    return pairedRank === maxBoard ? 'top_pair' : 'pair_below_top';
  }

  return 'no_pair';
}

// ── Draw equity estimates ──────────────────────────────────────────────────────
// Returns hero's estimated equity given their draw type and street, or null if no draw
function getDrawEquity(holeCards, board, street) {
  const flush    = hasFlushDraw(holeCards, board);
  const straight = getStraightDrawType(holeCards, board);
  const isFlop   = street === 'flop';

  if (flush && straight === 'oesd')    return isFlop ? 0.54 : 0.33;
  if (flush && straight === 'gutshot') return isFlop ? 0.45 : 0.26;
  if (flush)                           return isFlop ? 0.35 : 0.20;
  if (straight === 'oesd')             return isFlop ? 0.32 : 0.17;
  if (straight === 'gutshot')          return isFlop ? 0.17 : 0.09;
  return null;
}

module.exports = {
  RANK_IDX,
  classifyHand,
  parseRangeString,
  expandRangeToken,
  RFI_RANGES,
  BB_DEFENCE_RANGES,
  REASONABLE_THREE_BET,
  hasFlushDraw,
  hasMadeFlush,
  getStraightDrawType,
  hasMadeStraight,
  isDryBoard,
  evaluateHandStrength,
  getDrawEquity,
};
