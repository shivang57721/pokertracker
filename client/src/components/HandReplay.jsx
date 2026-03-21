import { useEffect, useState } from 'react'
import HoleCards from './HoleCards'
import { fmtUSD, fmtDateTime, fmtStakes } from '../lib/format'

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

// Track exact pot size using per-player per-street commitment accounting
function annotateActions(actions) {
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
        // total_amount = player's total commitment this street after raising
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

// Board cards at the start of each street
function boardForStreet(board, street) {
  if (!board?.length) return []
  if (street === 'flop')  return board.slice(0, 3)
  if (street === 'turn')  return board.slice(0, 4)
  if (street === 'river') return board.slice(0, 5)
  return []
}

function ActionLine({ action, hero }) {
  const isHero = action.player === hero
  const label  = ACTION_LABEL[action.action] ?? action.action

  // Amount to show alongside the label
  let amtStr = ''
  if (action.action === 'raise' && action.total_amount != null) {
    amtStr = fmtUSD(action.total_amount).replace('+', '')
  } else if (action.amount != null) {
    amtStr = fmtUSD(action.amount).replace('+', '')
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
        pot {fmtUSD(action.potBefore).replace('+', '')}
      </span>
    </div>
  )
}

function StreetSection({ street, actions, board, hero }) {
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
          <ActionLine key={i} action={a} hero={hero} />
        ))}
      </div>
    </div>
  )
}

export default function HandReplay({ handId, hero, onClose }) {
  const [hand,    setHand]    = useState(null)
  const [loading, setLoading] = useState(true)
  const [error,   setError]   = useState(null)

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

  // Close on Escape
  useEffect(() => {
    const handler = e => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [onClose])

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
          <button
            onClick={onClose}
            className="text-gray-500 hover:text-gray-200 text-lg leading-none shrink-0 transition-colors"
          >
            ✕
          </button>
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
                        +{fmtUSD(p.amount_won).replace('+', '')}
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
                    {fmtUSD(p.amount_won).replace('+', '')}
                  </span>
                </div>
              ))}

              <div className="border-t border-gray-800 pt-2 flex flex-wrap gap-4 text-xs text-gray-500">
                <span>Total pot: <span className="text-gray-300">{fmtUSD(hand.total_pot).replace('+', '')}</span></span>
                {hand.rake > 0 && (
                  <span>Rake: <span className="text-gray-400">{fmtUSD(hand.rake).replace('+', '')}</span></span>
                )}
                {heroPlayer && (
                  <span className="ml-auto">
                    Your result:{' '}
                    <span className={heroPlayer.amount_won - (annotated.filter(a => a.player === hero && a.delta > 0).reduce((s, a) => s + a.delta, 0)) >= 0 ? 'text-emerald-400' : 'text-red-400'}>
                      {fmtUSD(heroPlayer.amount_won - annotated.filter(a => a.player === hero && a.delta > 0).reduce((s, a) => s + a.delta, 0))}
                    </span>
                  </span>
                )}
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
