import { useEffect, useState, useCallback, useRef, useMemo } from 'react'
import HoleCards from './HoleCards'
import { fmtUSD, fmtBB, fmtDateTime, fmtStakes } from '../lib/format'
import { fetchAiAnalysis, runAiAnalysis } from '../lib/api'
import { annotateActions, boardForStreet, buildAnalysisPrompt } from '../lib/handUtils'
import useDisplayMode from '../lib/useDisplayMode'

const STREET_LABEL = { preflop: 'Preflop', flop: 'Flop', turn: 'Turn', river: 'River', showdown: 'Showdown' }
const STREET_ORDER = ['preflop', 'flop', 'turn', 'river', 'showdown']

const ACTION_LABEL = {
  post_sb:   'posts SB',
  post_bb:   'posts BB',
  post_ante: 'posts ante',
  fold:      'folds',
  check:     'checks',
  call:      'calls',
  bet:       'bets',
  raise:     'raises to',
}


function ActionLine({ action, hero, bigBlind, isBB }) {
  const isHero = action.player === hero
  const label  = ACTION_LABEL[action.action] ?? action.action
  const fmt    = (n) => isBB && bigBlind ? fmtBB(n, bigBlind) : fmtUSD(n).replace('+', '')

  // Amount to show alongside the label
  let amtStr = ''
  if (action.action === 'raise' && action.total_amount != null) {
    amtStr = fmt(action.total_amount)
  } else if (action.amount != null) {
    amtStr = fmt(action.amount)
  }

  // Colour by action type
  const actionColor =
    action.action === 'fold'    ? 'text-gray-500' :
    action.action === 'check'   ? 'text-gray-400' :
    action.action === 'call'    ? 'text-blue-400'  :
    action.action === 'bet'     ? 'text-emerald-400' :
    action.action === 'raise'   ? 'text-yellow-400' :
    action.action === 'post_sb' ||
    action.action === 'post_bb' ||
    action.action === 'post_ante' ? 'text-gray-500' :
    'text-gray-300'

  return (
    <div className={`flex items-baseline gap-2 py-0.5 px-2 rounded
      ${isHero ? 'bg-emerald-900/20' : ''}`}>
      {/* Player name */}
      <span className={`text-xs font-medium shrink-0 w-36 truncate
        ${isHero ? 'text-emerald-300' : 'text-gray-300'}`}>
        {action.player}{isHero ? ' ★' : ''}
      </span>

      {/* Action */}
      <span className={`text-xs font-semibold ${actionColor}`}>
        {label}
        {amtStr ? ` ${amtStr}` : ''}
        {action.is_all_in ? ' · all-in' : ''}
      </span>

      {/* Pot before this action */}
      <span className="ml-auto text-xs text-gray-700 tabular-nums shrink-0">
        pot {fmt(action.potBefore)}
      </span>
    </div>
  )
}

function StreetSection({ street, actions, board, hero, bigBlind, isBB }) {
  const newCards = boardForStreet(board, street)
  const prevCards = street === 'turn'  ? board.slice(0, 3) :
                    street === 'river' ? board.slice(0, 4) : []
  // Cards newly added this street
  const addedCards = newCards.slice(prevCards.length)

  if (actions.length === 0 && addedCards.length === 0) return null

  return (
    <div>
      {/* Street header */}
      <div className="flex items-center gap-3 py-2 mt-3">
        <span className="text-xs font-bold text-gray-500 uppercase tracking-widest w-16 shrink-0">
          {STREET_LABEL[street]}
        </span>
        {addedCards.length > 0 && (
          <div className="flex items-center gap-1">
            {prevCards.length > 0 && (
              <>
                <HoleCards cards={prevCards} size="sm" />
                <span className="text-gray-700 text-xs mx-1">+</span>
              </>
            )}
            <HoleCards cards={addedCards} size="sm" />
          </div>
        )}
        {street === 'preflop' && (
          <span className="text-xs text-gray-700">Hole cards dealt</span>
        )}
      </div>

      {/* Actions */}
      <div className="space-y-0.5">
        {actions.map((a, i) => (
          <ActionLine key={i} action={a} hero={hero} bigBlind={bigBlind} isBB={isBB} />
        ))}
      </div>
    </div>
  )
}

export default function HandReplay({ handId, hero, onClose }) {
  const [hand,    setHand]    = useState(null)
  const [loading, setLoading] = useState(true)
  const [error,   setError]   = useState(null)
  const [isBB,    setIsBB]    = useDisplayMode()

  // AI analysis state
  const [aiAnalysis,  setAiAnalysis]  = useState(null)   // null = not loaded yet
  const [aiLoaded,    setAiLoaded]    = useState(false)   // true once initial fetch done
  const [aiRunning,   setAiRunning]   = useState(false)
  const [aiError,     setAiError]     = useState(null)
  const [copied,      setCopied]      = useState(false)
  const copyTimerRef = useRef(null)

  useEffect(() => {
    if (!handId) return
    setLoading(true)
    setError(null)
    fetch(`/api/hands/${handId}`)
      .then(r => { if (!r.ok) throw new Error(r.status); return r.json() })
      .then(setHand)
      .catch(e => setError(e.message))
      .finally(() => setLoading(false))
  }, [handId])

  // Load existing analysis when handId changes
  useEffect(() => {
    if (!handId) return
    setAiAnalysis(null)
    setAiLoaded(false)
    setAiError(null)
    fetchAiAnalysis(handId)
      .then(data => { setAiAnalysis(data); setAiLoaded(true) })
      .catch(() => setAiLoaded(true)) // silently ignore — button still shown
  }, [handId])

  const handleAnalyze = useCallback(async (force = false) => {
    setAiRunning(true)
    setAiError(null)
    setCopied(false)
    try {
      const result = await runAiAnalysis(handId, force)
      setAiAnalysis(result)
    } catch (e) {
      setAiError(e.message)
    } finally {
      setAiRunning(false)
    }
  }, [handId])

  const fallbackPrompt = useMemo(
    () => buildAnalysisPrompt(hero, hand?.raw_text, hand?.flags),
    [hero, hand]
  )

  const handleCopy = useCallback(() => {
    if (!hand?.raw_text) return
    navigator.clipboard.writeText(fallbackPrompt).then(() => {
      setCopied(true)
      clearTimeout(copyTimerRef.current)
      copyTimerRef.current = setTimeout(() => setCopied(false), 2000)
    })
  }, [hand, hero])

  // Clear copy timer on unmount
  useEffect(() => () => clearTimeout(copyTimerRef.current), [])

  // Close on Escape
  useEffect(() => {
    const handler = e => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [onClose])

  const bigBlind   = hand?.big_blind ?? null
  const fmt        = (n, sign = false) => isBB && bigBlind ? fmtBB(n, bigBlind, sign) : (sign ? fmtUSD(n) : fmtUSD(n).replace('+', ''))
  const heroPlayer = hand?.players?.find(p => p.player === hero)
  const annotated  = hand ? annotateActions(hand.actions) : []

  // Group annotated actions by street
  const byStreet = {}
  for (const a of annotated) {
    if (!byStreet[a.street]) byStreet[a.street] = []
    byStreet[a.street].push(a)
  }

  const finalPot = annotated.length ? annotated.at(-1).potAfter : null

  return (
    // Backdrop
    <div
      className="fixed inset-0 z-50 bg-black/70 flex items-start justify-end"
      onClick={onClose}
    >
      {/* Panel */}
      <div
        className="relative h-full w-full max-w-xl bg-gray-950 border-l border-gray-800
                   overflow-y-auto shadow-2xl flex flex-col"
        onClick={e => e.stopPropagation()}
      >
        {/* Header */}
        <div className="sticky top-0 bg-gray-950/95 backdrop-blur border-b border-gray-800 px-4 py-3 flex items-start justify-between gap-4">
          <div className="min-w-0">
            {loading ? (
              <div className="h-4 w-48 bg-gray-800 rounded animate-pulse" />
            ) : error ? (
              <span className="text-red-400 text-sm">Error: {error}</span>
            ) : (
              <>
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="text-sm font-bold text-gray-100">Hand #{hand.hand_id}</span>
                  <span className="text-xs text-gray-500">{fmtStakes(hand.stakes)}</span>
                  <span className="text-xs text-gray-600">{hand.game_type?.replace("Hold'em ", '')}</span>
                  {hand.is_tournament === 1 && (
                    <span className="text-xs text-yellow-600 bg-yellow-900/20 px-1.5 py-0.5 rounded">Tourn</span>
                  )}
                </div>
                <div className="text-xs text-gray-600 mt-0.5">
                  {hand.table_name} · {fmtDateTime(hand.date_played)}
                </div>
              </>
            )}
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <div className="flex rounded-lg border border-gray-700 overflow-hidden text-xs">
              <button onClick={() => setIsBB(true)}
                className={`px-2 py-1 font-medium transition-colors ${isBB ? 'bg-gray-700 text-gray-100' : 'bg-gray-900 text-gray-500 hover:text-gray-300'}`}>
                BB
              </button>
              <button onClick={() => setIsBB(false)}
                className={`px-2 py-1 font-medium transition-colors ${!isBB ? 'bg-gray-700 text-gray-100' : 'bg-gray-900 text-gray-500 hover:text-gray-300'}`}>
                $
              </button>
            </div>
            <button
              onClick={onClose}
              className="text-gray-500 hover:text-gray-200 text-lg leading-none transition-colors"
            >
              ✕
            </button>
          </div>
        </div>

        {loading && (
          <div className="flex-1 flex items-center justify-center">
            <div className="text-gray-600 text-sm animate-pulse">Loading hand…</div>
          </div>
        )}

        {!loading && !error && hand && (
          <div className="px-4 pb-6 flex-1">
            {/* Players & stacks */}
            <div className="mt-4 grid grid-cols-2 gap-1.5">
              {hand.players.map(p => {
                const isH = p.player === hero
                const won = p.amount_won > 0
                return (
                  <div key={p.player}
                    className={`flex items-center gap-2 px-2 py-1.5 rounded text-xs
                      ${isH ? 'bg-emerald-900/20 border border-emerald-800/30' : 'bg-gray-900 border border-gray-800'}`}>
                    <span className={`font-medium truncate max-w-24 ${isH ? 'text-emerald-300' : 'text-gray-300'}`}>
                      {p.player}{isH ? ' ★' : ''}
                    </span>
                    {p.position && (
                      <span className="text-gray-600 capitalize shrink-0">{p.position}</span>
                    )}
                    {p.hole_cards?.length > 0 && (
                      <span className="ml-auto shrink-0">
                        <HoleCards cards={p.hole_cards} size="sm" />
                      </span>
                    )}
                    {won && (
                      <span className="text-emerald-400 tabular-nums shrink-0">
                        +{fmt(p.amount_won)}
                      </span>
                    )}
                  </div>
                )
              })}
            </div>

            {/* Hero hole cards prominently */}
            {heroPlayer?.hole_cards?.length > 0 && (
              <div className="mt-4 flex items-center gap-3">
                <span className="text-xs text-gray-500">Your cards:</span>
                <HoleCards cards={heroPlayer.hole_cards} size="lg" />
              </div>
            )}

            {/* Street-by-street replay */}
            <div className="mt-4 divide-y divide-gray-800/50">
              {STREET_ORDER.map(street => (
                byStreet[street]?.length || boardForStreet(hand.board, street).length ? (
                  <StreetSection
                    key={street}
                    street={street}
                    actions={byStreet[street] || []}
                    board={hand.board}
                    hero={hero}
                    bigBlind={bigBlind}
                    isBB={isBB}
                  />
                ) : null
              ))}
            </div>

            {/* Summary */}
            <div className="mt-5 border border-gray-800 rounded-xl p-4 bg-gray-900/50 space-y-2">
              <p className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-3">Summary</p>

              {/* Winners */}
              {hand.players.filter(p => p.amount_won > 0).map(p => (
                <div key={p.player} className="flex justify-between text-sm">
                  <span className={p.player === hero ? 'text-emerald-300 font-medium' : 'text-gray-300'}>
                    {p.player}{p.player === hero ? ' ★' : ''} collected
                  </span>
                  <span className="text-emerald-400 tabular-nums font-semibold">
                    {fmt(p.amount_won)}
                  </span>
                </div>
              ))}

              <div className="border-t border-gray-800 pt-2 flex flex-wrap gap-4 text-xs text-gray-500">
                <span>Total pot: <span className="text-gray-300">{fmt(hand.total_pot)}</span></span>
                {hand.rake > 0 && (
                  <span>Rake: <span className="text-gray-400">{fmt(hand.rake)}</span></span>
                )}
                {heroPlayer && (
                  <span className="ml-auto">
                    Your result:{' '}
                    <span className={heroPlayer.net_profit >= 0 ? 'text-emerald-400' : 'text-red-400'}>
                      {fmt(heroPlayer.net_profit, true)}
                    </span>
                  </span>
                )}
              </div>
            </div>

            {/* AI coaching analysis */}
            <div className="mt-5 border border-violet-900/40 rounded-xl bg-gray-900/50">
              {/* Header row with button */}
              <div className="flex items-center justify-between px-4 py-3 border-b border-violet-900/30">
                <div className="flex items-center gap-2">
                  <span className="text-xs">✦</span>
                  <p className="text-xs font-semibold text-violet-400 uppercase tracking-wider">AI Coaching</p>
                  {aiAnalysis?.model && (
                    <span className="text-xs text-gray-600">{aiAnalysis.model}</span>
                  )}
                </div>
                {aiLoaded && (
                  <button
                    onClick={() => handleAnalyze(!!aiAnalysis)}
                    disabled={aiRunning}
                    className={`text-xs font-medium px-3 py-1 rounded-lg transition-colors
                      ${aiRunning
                        ? 'bg-gray-800 text-gray-500 cursor-not-allowed'
                        : 'bg-violet-800/60 text-violet-200 hover:bg-violet-700/60'}`}
                  >
                    {aiRunning ? 'Analyzing…' : aiAnalysis ? 'Re-analyze' : 'Analyze with AI'}
                  </button>
                )}
              </div>

              <div className="px-4 py-3">
                {/* Loading skeleton while hand or AI fetch is in progress */}
                {(!aiLoaded || aiRunning) && !aiAnalysis && (
                  <div className="space-y-2 animate-pulse">
                    <div className="h-3 bg-gray-800 rounded w-3/4" />
                    <div className="h-3 bg-gray-800 rounded w-full" />
                    <div className="h-3 bg-gray-800 rounded w-5/6" />
                  </div>
                )}

                {/* Error + fallback prompt */}
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

                {/* Analysis text */}
                {aiAnalysis && !aiRunning && (
                  <p className="text-sm text-gray-300 leading-relaxed whitespace-pre-wrap">
                    {aiAnalysis.analysis}
                  </p>
                )}

                {/* Empty state — loaded but no analysis yet */}
                {aiLoaded && !aiAnalysis && !aiRunning && !aiError && (
                  <p className="text-xs text-gray-600">
                    Click &ldquo;Analyze with AI&rdquo; to get coaching feedback on this hand.
                  </p>
                )}
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
