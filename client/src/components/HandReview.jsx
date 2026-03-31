import { useEffect, useState, useCallback, useRef, useMemo } from 'react'
import HoleCards from './HoleCards'
import { fmtUSD, fmtBB, fmtInt, fmtStakes, fmtDateTime } from '../lib/format'
import useDisplayMode from '../lib/useDisplayMode'
import { fetchReviewSummary, fetchReviewHands, markReviewed, markUnreviewed, runAiAnalysis } from '../lib/api'
import { annotateActions, boardForStreet, buildAnalysisPrompt, FLAG_LABELS, estimateEquity, describeHand } from '../lib/handUtils'
import { PRESETS, getPresetDates } from '../lib/datePresets'

const STREET_ORDER = ['preflop', 'flop', 'turn', 'river', 'showdown']
const STREET_LABEL = { preflop: 'Preflop', flop: 'Flop', turn: 'Turn', river: 'River', showdown: 'Showdown' }

const ACTION_LABEL = {
  post_sb: 'posts SB', post_bb: 'posts BB', post_ante: 'posts ante',
  fold: 'folds', check: 'checks', call: 'calls', bet: 'bets', raise: 'raises to',
}


const ALL_FLAG_TYPES = Object.keys(FLAG_LABELS)

const POS_SHORT = {
  'button':      'BTN',
  'small blind': 'SB',
  'big blind':   'BB',
  'utg':         'UTG',
  'utg+1':       'UTG+1',
  'mp':          'MP',
  'lj':          'LJ',
  'hj':          'HJ',
  'co':          'CO',
}

// ── Review summary bar ────────────────────────────────────────────────────────
function ReviewSummary({ summary, loading }) {
  if (loading) {
    return (
      <div className="bg-gray-900 border border-gray-800 rounded-xl px-6 py-4 animate-pulse">
        <div className="flex gap-8">
          {[1, 2, 3].map(i => <div key={i} className="h-12 w-32 bg-gray-800 rounded" />)}
        </div>
      </div>
    )
  }
  if (!summary) return null

  const lossAbs = Math.abs(summary.estimated_loss ?? 0)

  return (
    <div className="bg-gray-900 border border-amber-900/40 rounded-xl px-6 py-4">
      <div className="flex flex-wrap gap-6 sm:gap-10 items-start">
        <div className="flex flex-col gap-1 min-w-0">
          <span className="text-xs font-medium text-gray-500 uppercase tracking-wider">Unreviewed</span>
          <span className="text-2xl font-bold tabular-nums text-amber-400">{fmtInt(summary.total_unreviewed)}</span>
          <span className="text-xs text-gray-600">{fmtInt(summary.total_reviewed)} reviewed</span>
        </div>
        <div className="w-px self-stretch bg-gray-800 hidden sm:block" />
        <div className="flex flex-col gap-1 min-w-0">
          <span className="text-xs font-medium text-gray-500 uppercase tracking-wider">Est. Money Lost</span>
          <span className="text-2xl font-bold tabular-nums text-red-400">{fmtUSD(-lossAbs)}</span>
          <span className="text-xs text-gray-600">on unreviewed hands</span>
        </div>
        {summary.by_flag_type?.length > 0 && (
          <>
            <div className="w-px self-stretch bg-gray-800 hidden sm:block" />
            <div className="flex flex-col gap-1 min-w-0">
              <span className="text-xs font-medium text-gray-500 uppercase tracking-wider mb-1">By Mistake Type</span>
              <div className="flex flex-wrap gap-2">
                {summary.by_flag_type.slice(0, 6).map(ft => (
                  <span key={ft.flag_type} className="text-xs bg-gray-800 border border-gray-700 rounded-full px-2 py-0.5 text-gray-300">
                    {FLAG_LABELS[ft.flag_type] ?? ft.flag_type}
                    <span className="ml-1 text-gray-500">{ft.hand_count}</span>
                  </span>
                ))}
                {summary.by_flag_type.length > 6 && (
                  <span className="text-xs text-gray-600">+{summary.by_flag_type.length - 6} more</span>
                )}
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  )
}

// ── Street-by-street action replay ────────────────────────────────────────────
function StreetReplay({ hand, hero, flags, isBB, bigBlind }) {
  const fmt    = (n, sign = false) => isBB && bigBlind ? fmtBB(n, bigBlind, sign) : (sign ? fmtUSD(n) : fmtUSD(n).replace('+', ''))
  const annotated = annotateActions(hand.actions)

  // Position map: player → position string
  const posMap = {}
  for (const p of (hand.players || [])) {
    if (p.position) posMap[p.player] = p.position.toLowerCase()
  }

  // Hero starting chips for SPR calculation
  const heroStart = hand.players?.find(p => p.player === hero)?.starting_chips ?? 0

  // Streets with a flag attached (for decision annotation)
  const flaggedStreets = new Set((flags || []).map(f => f.street).filter(Boolean))

  const byStreet = {}
  for (const a of annotated) {
    if (!byStreet[a.street]) byStreet[a.street] = []
    byStreet[a.street].push(a)
  }

  // Track hero's cumulative investment before each street (for remaining stack)
  let cumInvested = 0
  const heroStackAt = {}
  for (const street of STREET_ORDER) {
    heroStackAt[street] = heroStart - cumInvested
    for (const a of (byStreet[street] || [])) {
      if (a.player === hero && a.delta > 0) cumInvested += a.delta
    }
  }

  return (
    <div className="space-y-0">
      {STREET_ORDER.map(street => {
        const acts       = byStreet[street] || []
        const newCards   = boardForStreet(hand.board, street)
        const prevCards  = street === 'turn'  ? hand.board.slice(0, 3) :
                           street === 'river' ? hand.board.slice(0, 4) : []
        const addedCards = newCards.slice(prevCards.length)

        if (acts.length === 0 && addedCards.length === 0) return null

        // Pot entering this street = potBefore of first action
        const streetPot      = acts.length > 0 ? acts[0].potBefore : null
        const heroStack      = heroStackAt[street]
        const spr            = streetPot > 0 ? heroStack / streetPot : null
        const showStreetInfo = ['flop', 'turn', 'river'].includes(street) && streetPot != null
        const boardAtStreet  = boardForStreet(hand.board, street)
        const isFlaggedStreet = flaggedStreets.has(street)

        // Track the last bet/raise and hero's accumulated commitment per street
        let lastAggressor    = null
        let heroStreetCommit = 0

        return (
          <div key={street}>
            {/* Street header */}
            <div className="flex items-start gap-3 py-1.5 mt-4">
              <span className="text-xs font-bold text-gray-500 uppercase tracking-widest w-14 shrink-0 pt-0.5">
                {STREET_LABEL[street]}
              </span>
              <div className="flex flex-col gap-1.5 flex-1">
                {addedCards.length > 0 && (
                  <div className="flex items-center gap-1">
                    {prevCards.length > 0 && (
                      <>
                        <HoleCards cards={prevCards} size="sm" />
                        <span className="text-gray-700 text-xs mx-0.5">+</span>
                      </>
                    )}
                    <HoleCards cards={addedCards} size="sm" />
                  </div>
                )}
                {showStreetInfo && (
                  <div className="flex items-center gap-2 text-xs flex-wrap">
                    <span className="text-gray-500">Pot
                      <span className="text-gray-200 font-semibold ml-1">{fmt(streetPot)}</span>
                    </span>
                    <span className="text-gray-700">·</span>
                    <span className="text-gray-500">Hero stack
                      <span className="text-gray-200 font-semibold ml-1">{fmt(heroStack)}</span>
                    </span>
                    <span className="text-gray-700">·</span>
                    <span className="text-gray-500">SPR
                      <span className={`font-bold ml-1 ${
                        spr < 2 ? 'text-red-400' : spr < 5 ? 'text-yellow-400' : 'text-emerald-400'
                      }`}>{spr?.toFixed(1)}</span>
                    </span>
                  </div>
                )}
              </div>
            </div>

            {/* No-action placeholder (board ran out on previous all-in) */}
            {acts.length === 0 && (
              <div className="ml-16 mt-1 mb-2 text-xs text-gray-600 italic">
                No action — all-in on previous street
              </div>
            )}

            {/* Action rows */}
            <div className="space-y-0.5 ml-1">
              {acts.map((a, i) => {
                const isHero   = a.player === hero
                const pos      = posMap[a.player]
                const posShort = pos ? (POS_SHORT[pos] || pos.toUpperCase()) : null
                const label    = ACTION_LABEL[a.action] ?? a.action
                let amtStr = ''
                if (a.action === 'raise' && a.total_amount != null) {
                  amtStr = fmt(a.total_amount)
                } else if (a.amount != null && a.amount > 0) {
                  amtStr = fmt(a.amount)
                }
                const actionColor =
                  a.action === 'fold'    ? 'text-gray-500' :
                  a.action === 'check'   ? 'text-gray-400' :
                  a.action === 'call'    ? 'text-blue-400'  :
                  a.action === 'bet'     ? 'text-emerald-400' :
                  a.action === 'raise'   ? 'text-yellow-400' :
                  (a.action === 'post_sb' || a.action === 'post_bb' || a.action === 'post_ante')
                    ? 'text-gray-500' : 'text-gray-300'

                // Snapshot state before updating it for the next iteration
                const capturedAggressor  = lastAggressor
                const capturedHeroCommit = heroStreetCommit

                // Update trackers for subsequent actions
                if (a.action === 'bet' || a.action === 'raise') lastAggressor = a
                if (isHero && a.delta > 0) heroStreetCommit += a.delta

                // How much hero would need to call (or did call)
                // For folds: reconstruct from the last aggressor's total/delta minus hero's prior commit
                let callAmount = null
                if (a.action === 'call') {
                  callAmount = a.delta
                } else if (a.action === 'fold' && capturedAggressor) {
                  const raiseTo = capturedAggressor.action === 'raise' && capturedAggressor.total_amount != null
                    ? capturedAggressor.total_amount
                    : null
                  callAmount = raiseTo != null
                    ? raiseTo - capturedHeroCommit
                    : capturedAggressor.delta
                }

                // Only annotate when hero is facing a bet/raise (has a non-zero call amount)
                // a.potBefore already includes the villain bet, so formula is:
                // pot_odds = callAmount / (a.potBefore + callAmount)
                const showAnnotation =
                  isHero &&
                  hand.hole_cards?.length > 0 &&
                  (a.action === 'call' || a.action === 'fold') &&
                  ['flop', 'turn', 'river'].includes(street) &&
                  capturedAggressor != null &&
                  callAmount != null && callAmount > 0

                const potOdds = showAnnotation && a.potBefore > 0
                  ? callAmount / (a.potBefore + callAmount)
                  : null

                // Bet size as % of pot before villain's bet
                const betPct = capturedAggressor && capturedAggressor.potBefore > 0
                  ? (capturedAggressor.delta / capturedAggressor.potBefore) * 100
                  : null

                // Equity estimate and verdict
                const eqResult = showAnnotation ? estimateEquity(hand.hole_cards, boardAtStreet) : null
                const hasNumbers = eqResult != null && potOdds != null

                const calledGood  = a.action === 'call' && hasNumbers && eqResult.equity >  potOdds
                const calledBad   = a.action === 'call' && hasNumbers && eqResult.equity <= potOdds
                const foldedGood  = a.action === 'fold' && hasNumbers && eqResult.equity <= potOdds
                const foldedBad   = a.action === 'fold' && hasNumbers && eqResult.equity >  potOdds

                const isGoodDecision = calledGood || foldedGood
                const verdictLabel   = calledGood ? '→ +EV call'
                  : calledBad  ? '→ -EV call'
                  : foldedBad  ? '→ should have called'
                  : foldedGood ? '→ correct fold'
                  : null

                return (
                  <div key={i}>
                    {/* Action row */}
                    <div className={`flex items-baseline gap-1.5 py-0.5 px-2 rounded
                      ${isHero ? 'bg-emerald-900/20' : ''}`}>
                      {/* Position tag — always reserve space for alignment */}
                      <span className={`text-xs font-mono shrink-0 w-14 text-right
                        ${isHero ? 'text-emerald-700' : 'text-gray-600'}`}>
                        {posShort ? `[${posShort}]` : ''}
                      </span>
                      {/* Player name */}
                      <span className={`text-xs font-medium shrink-0 w-32 truncate
                        ${isHero ? 'text-emerald-300' : 'text-gray-300'}`}>
                        {a.player}{isHero ? ' ★' : ''}
                      </span>
                      {/* Action + amount */}
                      <span className={`text-xs font-semibold ${actionColor}`}>
                        {label}{amtStr ? ` ${amtStr}` : ''}{a.is_all_in ? ' · all-in' : ''}
                      </span>
                      {/* Inline pot after action */}
                      <span className="text-xs text-gray-600 tabular-nums">
                        · pot {fmt(a.potAfter)}
                      </span>
                    </div>

                    {/* Decision annotation */}
                    {showAnnotation && potOdds != null && (
                      <div className={`mx-2 mt-0.5 mb-1.5 px-3 py-2 rounded-lg text-xs border
                        ${isGoodDecision
                          ? 'bg-emerald-950/50 border-emerald-800/50'
                          : 'bg-red-950/50 border-red-800/50'}`}>
                        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                          {/* Pot odds */}
                          <span className={isGoodDecision ? 'text-emerald-400' : 'text-red-400'}>
                            Pot odds: {Math.round(potOdds * 100)}%
                            <span className="text-gray-500 font-normal ml-1">
                              (need {Math.round(potOdds * 100)}% equity to break even)
                            </span>
                          </span>
                          {/* Bet size */}
                          {betPct != null && (
                            <span className="text-gray-500">
                              Bet: {Math.round(betPct)}% pot
                            </span>
                          )}
                        </div>
                        {/* Equity + verdict */}
                        {eqResult && (
                          <div className={`mt-1 ${isGoodDecision ? 'text-emerald-300' : 'text-red-300'}`}>
                            Est. equity: {Math.round(eqResult.equity * 100)}% — {eqResult.label}
                            {verdictLabel && (
                              <span className={`ml-1.5 font-semibold ${isGoodDecision ? 'text-emerald-400' : 'text-red-400'}`}>
                                {verdictLabel}
                              </span>
                            )}
                          </div>
                        )}
                      </div>
                    )}

                  </div>
                )
              })}
            </div>
          </div>
        )
      })}
    </div>
  )
}

// ── Hand detail modal (right-side panel) ──────────────────────────────────────
function HandDetailModal({ hand, selectedIndex, totalHands, onClose, onNext, onPrev, onToggleReviewed, hero, isBB, setIsBB }) {
  const [isReviewed, setIsReviewed] = useState(!!hand.is_reviewed)
  const [marking,    setMarking]    = useState(false)
  const [aiAnalysis, setAiAnalysis] = useState(
    hand.ai_analysis ? { analysis: hand.ai_analysis, model: hand.ai_model } : null
  )
  const [aiRunning, setAiRunning] = useState(false)
  const [aiError,   setAiError]   = useState(null)
  const [copied,      setCopied]      = useState(false)
  const [copyToast,   setCopyToast]   = useState(false)
  const [reviewToast, setReviewToast] = useState(false)
  const copyTimerRef   = useRef(null)
  const toastTimerRef  = useRef(null)
  const rToastTimerRef = useRef(null)

  const fallbackPrompt = useMemo(
    () => buildAnalysisPrompt(hero, hand?.raw_text, hand?.flags),
    [hero, hand]
  )

  // Reset local state whenever the displayed hand changes
  useEffect(() => {
    setIsReviewed(!!hand.is_reviewed)
    setAiAnalysis(hand.ai_analysis ? { analysis: hand.ai_analysis, model: hand.ai_model } : null)
    setAiRunning(false)
    setAiError(null)
    setCopied(false)
  }, [hand.hand_id]) // eslint-disable-line react-hooks/exhaustive-deps

  const handleMark = useCallback(async () => {
    setMarking(true)
    try {
      if (isReviewed) {
        await markUnreviewed(hand.hand_id)
        setIsReviewed(false)
        onToggleReviewed(hand.hand_id, false, hand.net_profit ?? 0)
      } else {
        await markReviewed(hand.hand_id)
        setIsReviewed(true)
        onToggleReviewed(hand.hand_id, true, hand.net_profit ?? 0)
        setReviewToast(true)
        clearTimeout(rToastTimerRef.current)
        rToastTimerRef.current = setTimeout(() => setReviewToast(false), 1500)
      }
    } finally {
      setMarking(false)
    }
  }, [isReviewed, hand.hand_id, onToggleReviewed])

  useEffect(() => () => { clearTimeout(copyTimerRef.current); clearTimeout(toastTimerRef.current); clearTimeout(rToastTimerRef.current) }, [])

  // Keyboard navigation + shortcuts
  useEffect(() => {
    const handler = e => {
      if (e.key === 'Escape')     { onClose(); return }
      if (e.key === 'ArrowRight') { onNext();  return }
      if (e.key === 'ArrowLeft')  { onPrev();  return }
      // Enter → mark reviewed / unreviewed
      if (e.key === 'Enter' && !marking) { handleMark(); return }
      // Ctrl/Cmd+C → copy AI prompt (only when no text is selected)
      if ((e.ctrlKey || e.metaKey) && e.key === 'c' && !window.getSelection()?.toString()) {
        e.preventDefault()
        navigator.clipboard.writeText(fallbackPrompt).then(() => {
          setCopied(true)
          clearTimeout(copyTimerRef.current)
          copyTimerRef.current = setTimeout(() => setCopied(false), 2000)
          // Toast: fade in immediately, fade out after 1.5 s
          setCopyToast(true)
          clearTimeout(toastTimerRef.current)
          toastTimerRef.current = setTimeout(() => setCopyToast(false), 1500)
        })
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [onClose, onNext, onPrev, handleMark, marking, fallbackPrompt])

  const handleAnalyze = async () => {
    setAiRunning(true)
    setAiError(null)
    setCopied(false)
    try {
      const result = await runAiAnalysis(hand.hand_id, !!aiAnalysis)
      setAiAnalysis(result)
    } catch (e) {
      setAiError(e.message)
    } finally {
      setAiRunning(false)
    }
  }

  const handleCopy = () => {
    navigator.clipboard.writeText(fallbackPrompt).then(() => {
      setCopied(true)
      clearTimeout(copyTimerRef.current)
      copyTimerRef.current = setTimeout(() => setCopied(false), 2000)
    })
  }

  const hasPrev  = selectedIndex > 0
  const hasNext  = selectedIndex < totalHands - 1

  const annotated = annotateActions(hand.actions)
  const netProfit = hand.net_profit ?? 0
  const bigBlind  = hand.big_blind
  const fmt = (n, sign = false) => isBB && bigBlind ? fmtBB(n, bigBlind, sign) : (sign ? fmtUSD(n) : fmtUSD(n).replace('+', ''))

  return (
    // Backdrop
    <div
      className="fixed inset-0 z-50 bg-black/70 flex items-start justify-end"
      onClick={onClose}
    >
      {/* Panel */}
      <div
        className="relative h-full w-full max-w-3xl bg-gray-950 border-l border-gray-800
                   overflow-y-auto shadow-2xl flex flex-col"
        onClick={e => e.stopPropagation()}
      >
        {/* Toast notifications (top-centre) */}
        <div className="fixed top-5 left-1/2 -translate-x-1/2 z-50 pointer-events-none flex flex-col items-center gap-2">
          <div className={`px-4 py-2 rounded-lg bg-gray-800 border border-gray-700 text-xs text-gray-200 shadow-lg
            transition-opacity duration-300 ${copyToast ? 'opacity-100' : 'opacity-0'}`}>
            AI prompt copied
          </div>
          <div className={`px-4 py-2 rounded-lg bg-emerald-900 border border-emerald-700 text-xs text-emerald-200 shadow-lg
            transition-opacity duration-300 ${reviewToast ? 'opacity-100' : 'opacity-0'}`}>
            Hand reviewed
          </div>
        </div>

        {/* ── Sticky header ── */}
        <div className="sticky top-0 z-10 bg-gray-950/95 backdrop-blur border-b border-gray-800 px-4 py-3 shrink-0">
          <div className="flex items-center gap-2">
            {/* Prev / counter / Next */}
            <button
              onClick={onPrev}
              disabled={!hasPrev}
              title="Previous hand (←)"
              className="text-gray-400 hover:text-gray-100 disabled:opacity-25 disabled:cursor-not-allowed
                         text-base w-7 text-center transition-colors"
            >
              ←
            </button>
            <span className="text-xs text-gray-600 tabular-nums w-14 text-center shrink-0">
              {selectedIndex + 1} / {totalHands}
            </span>
            <button
              onClick={onNext}
              disabled={!hasNext}
              title="Next hand (→)"
              className="text-gray-400 hover:text-gray-100 disabled:opacity-25 disabled:cursor-not-allowed
                         text-base w-7 text-center transition-colors"
            >
              →
            </button>

            <div className="w-px h-4 bg-gray-700 mx-1 shrink-0" />

            {/* Hand meta */}
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 flex-wrap">
                <span className="text-sm font-bold text-gray-100">Hand #{hand.hand_id}</span>
                <span className="text-xs text-gray-500">{fmtStakes(hand.stakes)}</span>
                <span className="text-xs text-gray-600">{hand.game_type?.replace("Hold'em ", '')}</span>
                {isReviewed && (
                  <span className="text-xs text-emerald-700 bg-emerald-900/20 border border-emerald-900/40 px-1.5 py-0.5 rounded">
                    ✓ Reviewed
                  </span>
                )}
              </div>
              <div className="text-xs text-gray-600 mt-0.5 truncate">
                {hand.table_name} · {fmtDateTime(hand.date_played)}
              </div>
            </div>

            {/* BB / $ toggle */}
            <div className="flex rounded-lg border border-gray-700 overflow-hidden shrink-0">
              <button
                onClick={() => setIsBB(true)}
                className={`px-2 py-1 text-xs font-semibold transition-colors
                  ${isBB ? 'bg-gray-600 text-white' : 'bg-gray-800 text-gray-500 hover:text-gray-300'}`}
              >BB</button>
              <button
                onClick={() => setIsBB(false)}
                className={`px-2 py-1 text-xs font-semibold transition-colors
                  ${!isBB ? 'bg-gray-600 text-white' : 'bg-gray-800 text-gray-500 hover:text-gray-300'}`}
              >$</button>
            </div>


            {/* Close */}
            <button
              onClick={onClose}
              className="text-gray-500 hover:text-gray-200 text-lg leading-none shrink-0 ml-1 transition-colors"
            >
              ✕
            </button>
          </div>
          <div className="mt-1.5 flex gap-3 text-xs text-gray-700">
            <span>← → navigate</span>
            <span>Enter to review</span>
            <span>⌘C copy prompt</span>
            <span>Esc close</span>
          </div>
        </div>

        {/* ── Flag banner ── */}
        {hand.flags?.length > 0 && (
          <div className="bg-amber-950/50 border-b border-amber-800/40 px-5 py-4 shrink-0">
            <div className="space-y-2.5">
              {hand.flags.map((f, i) => (
                  <div key={i} className="flex items-start gap-3">
                    <div>
                      <span className="text-sm font-semibold text-amber-300">
                        {FLAG_LABELS[f.flag_type] ?? f.flag_type}
                      </span>
                      {f.street && (
                        <span className="ml-1.5 text-xs text-gray-400 capitalize">{f.street}</span>
                      )}
                      {f.description && (
                        <p className="text-xs text-gray-300 mt-0.5 leading-relaxed">{f.description}</p>
                      )}
                    </div>
                  </div>
              ))}
            </div>
          </div>
        )}

        {/* ── Main content ── */}
        <div className="px-5 pb-8 flex-1 space-y-5 mt-4">

          {/* Hero cards + position + net result */}
          <div className="flex items-center gap-3 flex-wrap">
            {hand.hole_cards?.length > 0 && (
              <div className="flex items-center gap-2">
                <span className="text-xs text-gray-500">Your cards:</span>
                <HoleCards cards={hand.hole_cards} size="lg" />
              </div>
            )}
            {hand.hero_position && (
              <span className="text-xs text-gray-500 capitalize bg-gray-900 px-2 py-1 rounded border border-gray-800">
                {hand.hero_position}
              </span>
            )}
            <span className={`ml-auto text-lg font-bold tabular-nums
              ${netProfit > 0 ? 'text-emerald-400' : netProfit < 0 ? 'text-red-400' : 'text-gray-400'}`}>
              {fmt(netProfit, true)}
            </span>
          </div>

          {/* Street-by-street replay */}
          <StreetReplay hand={hand} hero={hero} flags={hand.flags} isBB={isBB} bigBlind={bigBlind} />

          {/* Summary + showdown */}
          {(() => {
            // Players who showed cards at showdown (hole cards visible, not mucked)
            const showdownPlayers = (hand.players || []).filter(
              p => p.hole_cards?.length > 0 && !p.did_muck
            )
            const hasShowdown = showdownPlayers.length > 0

            return (
              <div className="border border-gray-800 rounded-xl p-4 bg-gray-900/50 space-y-3">
                <p className="text-xs font-semibold text-gray-500 uppercase tracking-wider">Summary</p>

                {/* Showdown results */}
                {hasShowdown && (
                  <div className="space-y-2">
                    {showdownPlayers.map(p => {
                      const isH       = p.player === hero
                      const net       = p.net_profit ?? 0
                      const handDesc  = describeHand(p.hole_cards, hand.board)
                      const pos       = p.position ? (POS_SHORT[p.position.toLowerCase()] || p.position.toUpperCase()) : null
                      return (
                        <div key={p.player}
                          className={`flex items-center gap-3 px-3 py-2 rounded-lg border
                            ${isH
                              ? 'bg-emerald-950/30 border-emerald-800/40'
                              : 'bg-gray-900 border-gray-800'}`}>
                          {/* Position + name */}
                          <div className="flex items-center gap-1.5 min-w-0 flex-1">
                            {pos && (
                              <span className={`text-xs font-mono shrink-0 ${isH ? 'text-emerald-700' : 'text-gray-600'}`}>
                                [{pos}]
                              </span>
                            )}
                            <span className={`text-xs font-medium truncate ${isH ? 'text-emerald-300' : 'text-gray-300'}`}>
                              {p.player}{isH ? ' ★' : ''}
                            </span>
                          </div>
                          {/* Hole cards */}
                          <span className="shrink-0">
                            <HoleCards cards={p.hole_cards} size="sm" />
                          </span>
                          {/* Hand description */}
                          <span className={`text-xs shrink-0 ${isH ? 'text-emerald-200/70' : 'text-gray-500'}`}>
                            {handDesc}
                          </span>
                          {/* Net result */}
                          <span className={`text-sm font-bold tabular-nums shrink-0 ml-auto
                            ${net > 0 ? 'text-emerald-400' : net < 0 ? 'text-red-400' : 'text-gray-400'}`}>
                            {fmt(net, true)}
                          </span>
                        </div>
                      )
                    })}
                  </div>
                )}

                {/* Pot footer */}
                <div className={`flex gap-4 text-xs text-gray-500 ${hasShowdown ? 'border-t border-gray-800 pt-3' : ''}`}>
                  <span>Total pot: <span className="text-gray-300">{fmt(hand.total_pot)}</span></span>
                  {hand.rake > 0 && (
                    <span>Rake: <span className="text-gray-400">{fmt(hand.rake)}</span></span>
                  )}
                </div>
              </div>
            )
          })()}

          {/* AI Coaching */}
          <div className="border border-violet-900/40 rounded-xl bg-gray-900/50">
            <div className="flex items-center justify-between px-4 py-3 border-b border-violet-900/30">
              <div className="flex items-center gap-2">
                <span className="text-xs">✦</span>
                <p className="text-xs font-semibold text-violet-400 uppercase tracking-wider">AI Coaching</p>
                {aiAnalysis?.model && (
                  <span className="text-xs text-gray-600">{aiAnalysis.model}</span>
                )}
              </div>
              <button
                onClick={handleAnalyze}
                disabled={aiRunning}
                className={`text-xs font-medium px-3 py-1 rounded-lg transition-colors
                  ${aiRunning
                    ? 'bg-gray-800 text-gray-500 cursor-not-allowed'
                    : 'bg-violet-800/60 text-violet-200 hover:bg-violet-700/60'}`}
              >
                {aiRunning ? 'Analyzing…' : aiAnalysis ? 'Re-analyze' : 'Analyze with AI'}
              </button>
            </div>
            <div className="px-4 py-3">
              {aiRunning && !aiAnalysis && (
                <div className="space-y-2 animate-pulse">
                  <div className="h-3 bg-gray-800 rounded w-3/4" />
                  <div className="h-3 bg-gray-800 rounded w-full" />
                  <div className="h-3 bg-gray-800 rounded w-5/6" />
                </div>
              )}
              {aiError && (
                <div className="space-y-3">
                  <p className="text-xs text-red-400">{aiError}</p>
                  <div className="border border-amber-800/50 rounded-lg bg-amber-950/20 p-3 space-y-2">
                    <div className="flex items-center justify-between gap-2">
                      <p className="text-xs font-semibold text-amber-400">Manual prompt — paste into claude.ai</p>
                      <button
                        onClick={handleCopy}
                        className={`text-xs font-medium px-3 py-1 rounded-lg shrink-0 transition-colors
                          ${copied
                            ? 'bg-emerald-800/60 text-emerald-300'
                            : 'bg-amber-800/60 text-amber-200 hover:bg-amber-700/60'}`}
                      >
                        {copied ? 'Copied!' : 'Copy to Clipboard'}
                      </button>
                    </div>
                    <pre className="text-xs text-gray-400 whitespace-pre-wrap break-words font-mono leading-relaxed
                                    max-h-48 overflow-y-auto bg-gray-950/60 rounded p-2">
                      {fallbackPrompt}
                    </pre>
                    <p className="text-xs text-gray-600">Paste this into claude.ai for free analysis.</p>
                  </div>
                </div>
              )}
              {aiAnalysis && !aiRunning && (
                <p className="text-sm text-gray-300 leading-relaxed whitespace-pre-wrap">
                  {aiAnalysis.analysis}
                </p>
              )}
              {!aiAnalysis && !aiRunning && !aiError && (
                <p className="text-xs text-gray-600">
                  Click &ldquo;Analyze with AI&rdquo; to get coaching feedback on this hand.
                </p>
              )}
            </div>
          </div>

          {/* Mark reviewed / unreviewed */}
          <div className="flex justify-end">
            <button
              onClick={handleMark}
              disabled={marking}
              className={`text-xs font-medium px-4 py-1.5 rounded-lg border transition-colors
                ${marking
                  ? 'border-gray-700 text-gray-600 cursor-not-allowed'
                  : isReviewed
                    ? 'border-gray-700 text-gray-400 hover:border-amber-800/60 hover:text-amber-400'
                    : 'border-emerald-800/60 text-emerald-400 hover:bg-emerald-900/30'}`}
            >
              {marking ? 'Saving…' : isReviewed ? '↩ Mark as Unreviewed' : '✓ Mark as Reviewed'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

// ── Compact review card (click to open modal) ─────────────────────────────────
function ReviewCard({ hand, hero, index, onSelect, isBB }) {
  const isReviewed = !!hand.is_reviewed

  const netProfit = hand.net_profit ?? 0
  const fmt = (n, sign = false) => isBB && hand.big_blind ? fmtBB(n, hand.big_blind, sign) : (sign ? fmtUSD(n) : fmtUSD(n).replace('+', ''))

  return (
    <div
      onClick={() => onSelect(index)}
      className={`border rounded-xl cursor-pointer transition-all hover:brightness-110
        ${isReviewed
          ? 'border-gray-800 bg-gray-900/20 opacity-50 hover:opacity-80'
          : 'border-amber-800/40 bg-gray-900/50 hover:bg-gray-900/80'}`}
    >
      <div className="flex items-center gap-3 px-4 py-3">
        {isReviewed && (
          <span className="text-xs font-bold px-2 py-0.5 rounded border bg-gray-800 text-gray-500 border-gray-700 shrink-0">
            ✓
          </span>
        )}

        {hand.hole_cards?.length > 0 && (
          <span className="shrink-0"><HoleCards cards={hand.hole_cards} size="sm" /></span>
        )}
        {hand.board?.length > 0 && (
          <span className="shrink-0"><HoleCards cards={hand.board} size="sm" /></span>
        )}
        {hand.hero_position && (
          <span className="text-xs text-gray-500 capitalize shrink-0">{hand.hero_position}</span>
        )}
        <span className={`text-xs font-medium truncate
          ${isReviewed ? 'text-gray-600' : 'text-amber-400'}`}>
          {FLAG_LABELS[hand.flags?.[0]?.flag_type] ?? hand.flags?.[0]?.flag_type ?? ''}
          {hand.flags?.length > 1 && (
            <span className="ml-1 text-gray-600">+{hand.flags.length - 1}</span>
          )}
        </span>

        <span className="ml-auto text-xs text-gray-500 tabular-nums shrink-0">
          pot {fmt(hand.total_pot)}
        </span>
        <span className={`text-xs font-semibold tabular-nums shrink-0
          ${netProfit > 0 ? 'text-emerald-400' : netProfit < 0 ? 'text-red-400' : 'text-gray-400'}`}>
          {fmt(netProfit, true)}
        </span>
      </div>
    </div>
  )
}

// ── Main Hand Review page ─────────────────────────────────────────────────────
export default function HandReview({ hero }) {
  const [isBB, setIsBB] = useDisplayMode()

  const [summary,      setSummary]      = useState(null)
  const [summLoading,  setSummLoading]  = useState(true)
  const [hands,        setHands]        = useState([])
  const [total,        setTotal]        = useState(0)
  const [handsLoading, setHandsLoading] = useState(true)
  const [error,        setError]        = useState(null)

  const [reviewedFilter, setReviewedFilter] = useState('unreviewed')
  const [flagFilter,     setFlagFilter]     = useState('')
  const [datePreset,     setDatePreset]     = useState('all_time')
  const [from,           setFrom]           = useState('')
  const [to,             setTo]             = useState('')
  const [page,           setPage]           = useState(0)
  const [selectedIndex,  setSelectedIndex]  = useState(null) // null = modal closed
  const PAGE_SIZE = 20

  // Load summary
  const loadSummary = useCallback(() => {
    setSummLoading(true)
    fetchReviewSummary()
      .then(d => { setSummary(d); setSummLoading(false) })
      .catch(e => { console.warn('review summary:', e.message); setSummLoading(false) })
  }, [])

  useEffect(() => { loadSummary() }, [loadSummary])

  // Load hands
  const loadHands = useCallback(() => {
    setHandsLoading(true)
    setError(null)
    const params = { limit: PAGE_SIZE, offset: page * PAGE_SIZE, reviewed: reviewedFilter }
    if (flagFilter) params.flag_type = flagFilter
    if (from) params.from = from
    if (to)   params.to   = to
    fetchReviewHands(params)
      .then(d => { setHands(d.hands); setTotal(d.total); setHandsLoading(false) })
      .catch(e => { setError(e.message); setHandsLoading(false) })
  }, [reviewedFilter, flagFilter, page, from, to])

  useEffect(() => { loadHands() }, [loadHands])

  const handleReviewedFilter = val => { setReviewedFilter(val); setPage(0); setSelectedIndex(null) }
  const handleFlagFilter     = val => { setFlagFilter(val);     setPage(0); setSelectedIndex(null) }
  const handlePresetChange   = id  => {
    setDatePreset(id)
    if (id !== 'custom') { const { from: f, to: t } = getPresetDates(id); setFrom(f); setTo(t) }
    setPage(0); setSelectedIndex(null)
  }

  // Navigation
  const handleSelect  = useCallback(idx => setSelectedIndex(idx), [])
  const handleClose   = useCallback(() => setSelectedIndex(null), [])
  const handleNext    = useCallback(() => setSelectedIndex(i => (i < hands.length - 1 ? i + 1 : i)), [hands.length])
  const handlePrev    = useCallback(() => setSelectedIndex(i => (i > 0 ? i - 1 : i)), [])

  // Toggle reviewed — updates list and summary counts
  const handleToggleReviewed = useCallback((handId, nowReviewed, netProfit = 0) => {
    setSummary(prev => {
      if (!prev) return prev
      const delta = nowReviewed ? 1 : -1
      // Only losing hands contribute to estimated_loss
      const lossContribution = Math.min(netProfit, 0)
      const lossDelta = nowReviewed ? -lossContribution : lossContribution
      return {
        ...prev,
        total_reviewed:   prev.total_reviewed   + delta,
        total_unreviewed: prev.total_unreviewed  - delta,
        estimated_loss:   (prev.estimated_loss ?? 0) + lossDelta,
      }
    })

    if (reviewedFilter === 'all') {
      // Update in place — card appearance changes, stays in list
      setHands(prev => prev.map(h => h.hand_id === handId ? { ...h, is_reviewed: nowReviewed ? 1 : 0 } : h))
    } else {
      // Hand no longer matches filter — remove and adjust selected index
      setHands(prev => {
        const removedIdx = prev.findIndex(h => h.hand_id === handId)
        const newHands   = prev.filter(h => h.hand_id !== handId)
        setSelectedIndex(sel => {
          if (sel === null || removedIdx === -1) return sel
          if (removedIdx === sel) return newHands.length === 0 ? null : Math.min(sel, newHands.length - 1)
          return removedIdx < sel ? sel - 1 : sel
        })
        return newHands
      })
      setTotal(prev => prev - 1)
    }
  }, [reviewedFilter])

  const unreviewedCount = summary?.total_unreviewed ?? null
  const reviewedCount   = summary?.total_reviewed   ?? null
  const allCount        = summary?.total_all        ?? null
  const totalPages      = Math.ceil(total / PAGE_SIZE)

  const emptyMsg = reviewedFilter === 'reviewed'
    ? 'No reviewed hands yet.'
    : reviewedFilter === 'unreviewed'
      ? flagFilter
        ? `No unreviewed hands flagged for "${FLAG_LABELS[flagFilter] ?? flagFilter}"`
        : 'No unreviewed hands — run analysis first or all hands are reviewed.'
      : 'No flagged hands found.'

  return (
    <div className="space-y-5">
      <ReviewSummary summary={summary} loading={summLoading} />

      {/* Reviewed-status toggle */}
      <div className="flex items-center gap-2 flex-wrap">
        {[
          { val: 'unreviewed', label: 'Unreviewed', count: unreviewedCount },
          { val: 'reviewed',   label: 'Reviewed',   count: reviewedCount   },
          { val: 'all',        label: 'All',         count: allCount        },
        ].map(({ val, label, count }) => (
          <button
            key={val}
            onClick={() => handleReviewedFilter(val)}
            className={`text-sm font-medium px-4 py-1.5 rounded-lg border transition-colors
              ${reviewedFilter === val
                ? 'bg-gray-700 border-gray-500 text-gray-100'
                : 'bg-gray-900 border-gray-700 text-gray-400 hover:text-gray-200'}`}
          >
            {label}
            {count != null && (
              <span className={`ml-1.5 text-xs ${reviewedFilter === val ? 'text-gray-300' : 'text-gray-600'}`}>
                ({count})
              </span>
            )}
          </button>
        ))}
      </div>

      {/* Date filter */}
      <div className="flex items-center gap-2 flex-wrap">
        {PRESETS.map(p => (
          <button
            key={p.id}
            onClick={() => handlePresetChange(p.id)}
            className={`px-3 py-1 rounded-full text-xs font-medium transition-colors border
              ${datePreset === p.id
                ? 'bg-emerald-600 border-emerald-500 text-white'
                : 'bg-gray-800 border-gray-700 text-gray-400 hover:text-gray-200 hover:border-gray-600'}`}
          >
            {p.label}
          </button>
        ))}
        {datePreset === 'custom' && (
          <div className="flex items-center gap-1">
            <input type="date" value={from}
              onChange={e => { setFrom(e.target.value); setDatePreset('custom'); setPage(0) }}
              className="[color-scheme:dark] bg-gray-800 border border-gray-700 rounded-lg px-2 py-1
                         text-gray-200 focus:outline-none focus:border-gray-500 text-xs"
              style={{ width: '8.5rem' }} />
            <span className="text-gray-500 text-xs">–</span>
            <input type="date" value={to}
              onChange={e => { setTo(e.target.value); setDatePreset('custom'); setPage(0) }}
              className="[color-scheme:dark] bg-gray-800 border border-gray-700 rounded-lg px-2 py-1
                         text-gray-200 focus:outline-none focus:border-gray-500 text-xs"
              style={{ width: '8.5rem' }} />
          </div>
        )}
      </div>

      {/* Flag-type filter */}
      <div className="flex items-center gap-3 flex-wrap">
        <span className="text-xs text-gray-500 font-medium uppercase tracking-wider shrink-0">Mistake:</span>
        <button
          onClick={() => handleFlagFilter('')}
          className={`text-xs px-3 py-1.5 rounded-lg border transition-colors
            ${flagFilter === ''
              ? 'bg-amber-900/40 border-amber-800/60 text-amber-300'
              : 'bg-gray-900 border-gray-700 text-gray-400 hover:text-gray-200'}`}
        >
          All
        </button>
        {ALL_FLAG_TYPES.map(ft => {
          const count = summary?.by_flag_type?.find(x => x.flag_type === ft)?.hand_count
          if (!count) return null
          return (
            <button
              key={ft}
              onClick={() => handleFlagFilter(ft)}
              className={`text-xs px-3 py-1.5 rounded-lg border transition-colors
                ${flagFilter === ft
                  ? 'bg-amber-900/40 border-amber-800/60 text-amber-300'
                  : 'bg-gray-900 border-gray-700 text-gray-400 hover:text-gray-200'}`}
            >
              {FLAG_LABELS[ft]}
              <span className="ml-1.5 text-gray-600">{count}</span>
            </button>
          )
        })}
      </div>

      {/* Error */}
      {error && (
        <div className="bg-red-900/30 border border-red-700 rounded-xl px-4 py-3 text-sm text-red-300">
          {error}
        </div>
      )}

      {/* Hand list */}
      {handsLoading ? (
        <div className="space-y-3">
          {[1, 2, 3].map(i => (
            <div key={i} className="h-14 bg-gray-900 border border-gray-800 rounded-xl animate-pulse" />
          ))}
        </div>
      ) : hands.length === 0 ? (
        <div className="text-center py-16 text-gray-600">{emptyMsg}</div>
      ) : (
        <div className="space-y-2">
          {hands.map((hand, idx) => (
            <ReviewCard
              key={hand.hand_id}
              hand={hand}
              hero={hero}
              index={idx}
              onSelect={handleSelect}
              isBB={isBB}
            />
          ))}
        </div>
      )}

      {/* Pagination */}
      {totalPages > 1 && (
        <div className="flex items-center justify-between pt-2">
          <span className="text-xs text-gray-600">
            {page * PAGE_SIZE + 1}–{Math.min((page + 1) * PAGE_SIZE, total)} of {fmtInt(total)}
          </span>
          <div className="flex gap-2">
            <button
              onClick={() => setPage(p => p - 1)}
              disabled={page === 0}
              className="text-xs px-3 py-1.5 rounded-lg border border-gray-700 text-gray-400
                hover:text-gray-200 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
            >
              ← Prev
            </button>
            <button
              onClick={() => setPage(p => p + 1)}
              disabled={page >= totalPages - 1}
              className="text-xs px-3 py-1.5 rounded-lg border border-gray-700 text-gray-400
                hover:text-gray-200 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
            >
              Next →
            </button>
          </div>
        </div>
      )}

      {/* Modal */}
      {selectedIndex !== null && hands[selectedIndex] && (
        <HandDetailModal
          hand={hands[selectedIndex]}
          selectedIndex={selectedIndex}
          totalHands={hands.length}
          onClose={handleClose}
          onNext={handleNext}
          onPrev={handlePrev}
          onToggleReviewed={handleToggleReviewed}
          hero={hero}
          isBB={isBB}
          setIsBB={setIsBB}
        />
      )}
    </div>
  )
}
