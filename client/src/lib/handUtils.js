// Track exact pot size using per-player per-street commitment accounting
export function annotateActions(actions) {
  let pot = 0
  const streetCommit = {} // player → amount committed this street
  let currentStreet  = null
  const out = []

  for (const a of actions) {
    if (a.street !== currentStreet) {
      currentStreet = a.street
      Object.keys(streetCommit).forEach(k => delete streetCommit[k])
    }

    const potBefore = pot
    let delta = 0

    if (a.amount != null) {
      const prior = streetCommit[a.player] || 0
      if (a.action === 'raise' && a.total_amount != null) {
        delta = a.total_amount - prior
        streetCommit[a.player] = a.total_amount
      } else {
        delta = a.amount
        streetCommit[a.player] = prior + delta
      }
      pot += delta
    }

    out.push({ ...a, potBefore, potAfter: pot, delta })
  }

  return out
}

// ── AI prompt builder ─────────────────────────────────────────────────────────
export const FLAG_LABELS = {
  open_too_loose:            'Open Too Loose',
  open_too_tight:            'Open Too Tight',
  open_limp:                 'Open Limp',
  bb_defence_too_loose:      'BB Defence Too Loose',
  cold_call:                 'Cold Call',
  three_bet_too_light:       '3-Bet Too Light',
  fold_too_strong_3bet:      'Fold Too Strong to 3-Bet',
  fold_draw_good_odds:       'Folded Draw w/ Good Odds',
  call_bad_pot_odds:         'Called w/ Bad Odds',
  never_bluffed_busted_draw: 'Never Bluffed Busted Draw',
  donk_bet:                  'Donk Bet',
  bet_bet_bet_marginal:      '3-Street Barrel Marginal',
  showdown_big_pot_weak_hand:'Big Pot Showdown (Weak)',
  bet_too_small_strong_hand: 'Bet Too Small (Strong)',
  check_river_strong_hand:   'Checked River Strong Hand (IP)',
}

const STRATEGY_CONTEXT =
  'I want you to act as my poker coach and analyze this hand I played. ' +
  'Here is my general strategy for context:\n\n' +
  'Preflop: Tight from early position, progressively looser toward the button. ' +
  'I 3-bet premium hands and suited hands that have playability, more often when out of position, ' +
  'and adjust to the opener (tighter against UTG).\n' +
  'Postflop: I bet when I have range advantage. I bet big with premium hands and draws. ' +
  'I check or bet small otherwise. I try to turn busted draws into bluffs. ' +
  'With marginal hands I try to get to showdown cheaply.'

const ANALYSIS_INSTRUCTION =
  'Analyze the hand below. For each street, evaluate my decision. ' +
  'If I made a mistake, explain specifically what I should have done instead and why, ' +
  'including pot odds or equity reasoning where relevant. ' +
  'If a street was played fine, say so and move on. ' +
  "Don't give generic poker advice — focus only on what happened in this hand."

// Builds the full copy-paste prompt (and the text shown in the fallback box).
// flags: array of { flag_type, street, description } — sentinel rows auto-excluded.
export function buildAnalysisPrompt(hero, rawText, flags = []) {
  const realFlags = flags.filter(f => f.flag_type !== '_analyzed')

  let flagSection = ''
  if (realFlags.length > 0) {
    const items = realFlags.map(f => {
      const label = FLAG_LABELS[f.flag_type] ?? f.flag_type
      const parts = [label]
      if (f.street)      parts.push(`(${f.street})`)
      if (f.description) parts.push(`— ${f.description}`)
      return parts.join(' ')
    }).join('\n- ')
    flagSection = `\nThis hand was flagged by my tracker for:\n- ${items}\n`
  }

  return `${STRATEGY_CONTEXT}\n${flagSection}\n${ANALYSIS_INSTRUCTION}\n\nPlayer to analyze: ${hero}\n\n${rawText ?? ''}`
}

// ── Board cards visible at the start of each street ───────────────────────────
export function boardForStreet(board, street) {
  if (!board?.length) return []
  if (street === 'flop')  return board.slice(0, 3)
  if (street === 'turn')  return board.slice(0, 4)
  if (street === 'river') return board.slice(0, 5)
  return []
}

// ── Client-side hand analysis helpers ─────────────────────────────────────────
const RANK_VAL = {
  A: 14, K: 13, Q: 12, J: 11, T: 10,
  '9': 9, '8': 8, '7': 7, '6': 6, '5': 5, '4': 4, '3': 3, '2': 2,
}
const RANK_NAME = {
  14: 'Ace', 13: 'King', 12: 'Queen', 11: 'Jack', 10: 'Ten',
  9: 'Nine', 8: 'Eight', 7: 'Seven', 6: 'Six', 5: 'Five', 4: 'Four', 3: 'Three', 2: 'Two',
}
const RANK_PLURAL = {
  14: 'Aces', 13: 'Kings', 12: 'Queens', 11: 'Jacks', 10: 'Tens',
  9: 'Nines', 8: 'Eights', 7: 'Sevens', 6: 'Sixes', 5: 'Fives', 4: 'Fours', 3: 'Threes', 2: 'Twos',
}

function cRank(c) { return RANK_VAL[c?.slice(0, -1)] || 0 }
function cSuit(c) { return c?.slice(-1) }

function rankCounts(cards) {
  const counts = {}
  for (const c of cards) { const r = cRank(c); if (r) counts[r] = (counts[r] || 0) + 1 }
  return counts
}

// Describes the best hand made from holeCards + board (for showdown display).
export function describeHand(holeCards, board) {
  if (!holeCards?.length) return ''
  const all = [...holeCards, ...(board || [])]

  const counts  = rankCounts(all)
  const entries = Object.entries(counts).map(([r, c]) => [+r, c]).sort((a, b) => b[1] - a[1] || b[0] - a[0])
  const pairs   = entries.filter(([, c]) => c >= 2).map(([r]) => r).sort((a, b) => b - a)
  const trips   = entries.find(([, c]) => c >= 3)?.[0]
  const quads   = entries.find(([, c]) => c >= 4)?.[0]

  // Flush
  const suitCounts = {}
  for (const c of all) { const s = cSuit(c); suitCounts[s] = (suitCounts[s] || 0) + 1 }
  const flushSuit = Object.entries(suitCounts).find(([, v]) => v >= 5)?.[0]

  // Straight (including ace-low)
  const uniq = [...new Set(all.map(cRank))].sort((a, b) => a - b)
  if (uniq.includes(14)) uniq.unshift(1)
  let straightHigh = 0
  for (let i = 0; i <= uniq.length - 5; i++) {
    const sl = uniq.slice(i, i + 5)
    if (new Set(sl).size === 5 && sl[4] - sl[0] === 4) {
      straightHigh = Math.max(straightHigh, sl[4] === 1 ? 5 : sl[4])
    }
  }

  if (quads)                      return `four ${RANK_PLURAL[quads]}`
  if (flushSuit && straightHigh)  return straightHigh === 14 ? 'royal flush' : `straight flush, ${RANK_NAME[straightHigh]} high`
  if (trips && pairs.length >= 2) return `full house, ${RANK_PLURAL[trips]} full of ${RANK_PLURAL[pairs.find(p => p !== trips)]}`
  if (flushSuit) {
    const hi = all.filter(c => cSuit(c) === flushSuit).map(cRank).sort((a, b) => b - a)[0]
    return `flush, ${RANK_NAME[hi]} high`
  }
  if (straightHigh)               return `straight, ${RANK_NAME[straightHigh]} high`
  if (trips)                      return `three ${RANK_PLURAL[trips]}`
  if (pairs.length >= 2)          return `two pair, ${RANK_PLURAL[pairs[0]]} and ${RANK_PLURAL[pairs[1]]}`
  if (pairs.length === 1)         return `pair of ${RANK_PLURAL[pairs[0]]}`
  const hi = Math.max(...all.map(cRank))
  return `${RANK_NAME[hi]} high`
}

// Estimates hero's equity given hole cards + visible board.
// Returns { equity: 0–1, label: string } or null if insufficient info.
export function estimateEquity(holeCards, board) {
  if (!holeCards?.length || !board?.length || board.length < 3) return null

  const all       = [...holeCards, ...board]
  const cardsToGo = board.length === 3 ? 2 : board.length === 4 ? 1 : 0
  const counts    = rankCounts(all)
  const entries   = Object.entries(counts).map(([r, c]) => [+r, c])
  const pairs     = entries.filter(([, c]) => c >= 2).map(([r]) => r).sort((a, b) => b - a)
  const trips     = entries.find(([, c]) => c >= 3)?.[0]
  const quads     = entries.find(([, c]) => c >= 4)?.[0]

  // Flush
  const suitCounts = {}
  for (const c of all) { const s = cSuit(c); suitCounts[s] = (suitCounts[s] || 0) + 1 }
  const madeFlush = Object.entries(suitCounts).some(([s, cnt]) => cnt >= 5 && holeCards.some(c => cSuit(c) === s))
  const flushDraw = !madeFlush && Object.entries(suitCounts).some(([s, cnt]) => cnt === 4 && holeCards.some(c => cSuit(c) === s))

  // Straight (including ace-low)
  const allRanks = [...new Set(all.map(cRank))].sort((a, b) => a - b)
  if (allRanks.includes(14)) allRanks.unshift(1)
  let madeStraight = false, oesd = false, gutshot = false
  for (let i = 0; i <= allRanks.length - 4; i++) {
    const w4 = allRanks.slice(i, i + 4)
    const usesHero = holeCards.some(c => { const r = cRank(c); return w4.includes(r) || (r === 14 && w4.includes(1)) })
    if (i + 4 < allRanks.length) {
      const w5 = allRanks.slice(i, i + 5)
      if (new Set(w5).size === 5 && w5[4] - w5[0] === 4) madeStraight = true
    }
    if (!madeStraight && usesHero) {
      if (w4[3] - w4[0] === 3) oesd = true
      if (w4[3] - w4[0] === 4) gutshot = true
    }
  }

  // Made hand priority
  if (quads)                    return { equity: 0.97, label: 'Quads' }
  if (trips && pairs.length>=2) return { equity: 0.90, label: 'Full house' }
  if (madeFlush)                return { equity: 0.82, label: 'Flush' }
  if (madeStraight)             return { equity: 0.78, label: 'Straight' }
  if (trips)                    return { equity: 0.72, label: 'Three of a kind' }
  if (pairs.length >= 2)        return { equity: 0.60, label: 'Two pair' }

  // Draws
  if (flushDraw && oesd) {
    const eq = cardsToGo === 2 ? 0.54 : 0.27
    return { equity: eq, label: `Flush draw + open-ended draw (~${Math.round(eq * 100)}%)` }
  }
  if (flushDraw) {
    const eq = cardsToGo === 2 ? 0.35 : 0.19
    return { equity: eq, label: `Flush draw (~${Math.round(eq * 100)}%)` }
  }
  if (oesd) {
    const eq = cardsToGo === 2 ? 0.31 : 0.17
    return { equity: eq, label: `Open-ended straight draw (~${Math.round(eq * 100)}%)` }
  }
  if (gutshot) {
    const eq = cardsToGo === 2 ? 0.17 : 0.09
    return { equity: eq, label: `Gutshot (~${Math.round(eq * 100)}%)` }
  }

  // One pair
  if (pairs.length === 1) {
    const pairRank = pairs[0]
    const boardSorted = board.map(cRank).sort((a, b) => b - a)
    if (holeCards.length === 2 && cRank(holeCards[0]) === cRank(holeCards[1])) {
      // Pocket pair
      return cRank(holeCards[0]) > Math.max(...board.map(cRank))
        ? { equity: 0.60, label: 'Overpair' }
        : { equity: 0.32, label: 'Underpair' }
    }
    if (pairRank === boardSorted[0]) return { equity: 0.52, label: 'Top pair' }
    if (pairRank === boardSorted[1]) return { equity: 0.40, label: 'Middle pair' }
    return { equity: 0.28, label: 'Bottom pair' }
  }

  // Overcards
  const boardMax  = Math.max(...board.map(cRank))
  const overcards = holeCards.filter(c => cRank(c) > boardMax).length
  if (overcards >= 2) {
    const eq = cardsToGo === 2 ? 0.24 : 0.13
    return { equity: eq, label: `Two overcards (~${Math.round(eq * 100)}%)` }
  }
  if (overcards === 1) {
    const eq = cardsToGo === 2 ? 0.12 : 0.06
    return { equity: eq, label: `One overcard (~${Math.round(eq * 100)}%)` }
  }

  return { equity: 0.15, label: 'No pair / weak hand (~15%)' }
}
