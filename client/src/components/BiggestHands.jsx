import { useState } from 'react'
import HoleCards  from './HoleCards'
import HandReplay from './HandReplay'
import { fmtUSD, parseCards } from '../lib/format'

const SUIT_SYMBOL = { h: '♥', d: '♦', c: '♣', s: '♠' }
const SUIT_CLASS  = { h: 'text-red-400', d: 'text-blue-400', c: 'text-emerald-400', s: 'text-slate-300' }

const POSITION_SHORT = {
  'utg': 'UTG', 'utg+1': 'UTG+1', 'mp': 'MP', 'lj': 'LJ',
  'hj': 'HJ', 'co': 'CO', 'button': 'BTN', 'small blind': 'SB', 'big blind': 'BB',
}

function BoardCard({ card }) {
  if (!card) return null
  const rank = card.slice(0, -1)
  const suit = card.slice(-1)
  return (
    <span className={`font-mono font-bold text-xs ${SUIT_CLASS[suit] ?? 'text-gray-300'}`}>
      {rank}{SUIT_SYMBOL[suit] ?? suit}
    </span>
  )
}

function HandRow({ hand, isCash, onOpen }) {
  const net      = hand.net_profit ?? 0
  const cards    = parseCards(hand.hole_cards)
  const board    = parseCards(hand.board)
  const posLabel = POSITION_SHORT[hand.player_position] ?? hand.player_position ?? '—'
  const isWin    = net > 0

  return (
    <button
      onClick={() => onOpen(hand.hand_id)}
      className="flex items-center gap-3 w-full text-left px-3 py-2.5 rounded-lg
                 hover:bg-gray-800/70 transition-colors group"
    >
      {/* Result badge */}
      <span className={`w-16 shrink-0 text-sm font-bold tabular-nums text-right
        ${isWin ? 'text-emerald-400' : 'text-red-400'}`}>
        {isCash ? fmtUSD(net) : `${net > 0 ? '+' : ''}${Math.round(net).toLocaleString()}`}
      </span>

      {/* Hole cards */}
      <span className="shrink-0">
        {cards.length ? <HoleCards cards={cards} /> : <span className="text-gray-600 font-mono text-sm">—</span>}
      </span>

      {/* Position */}
      <span className="text-xs text-gray-500 font-medium w-10 shrink-0">{posLabel}</span>

      {/* Board */}
      <span className="flex items-center gap-0.5 flex-1 min-w-0">
        {board.length
          ? board.map((c, i) => <BoardCard key={i} card={c} />)
          : <span className="text-gray-700 text-xs">no board</span>
        }
      </span>

      {/* Arrow hint */}
      <span className="text-gray-700 group-hover:text-gray-400 transition-colors text-xs">→</span>
    </button>
  )
}

function HandList({ title, hands, isCash, onOpen, accentClass }) {
  return (
    <div className="flex-1 min-w-0">
      <p className={`text-xs font-semibold uppercase tracking-wider mb-2 ${accentClass}`}>
        {title}
      </p>
      {hands.length === 0
        ? <p className="text-gray-700 text-sm px-3 py-2">No hands</p>
        : hands.map(h => (
            <HandRow key={h.hand_id} hand={h} isCash={isCash} onOpen={onOpen} />
          ))
      }
    </div>
  )
}

export default function BiggestHands({ winners = [], losers = [], loading, mode = 'cash' }) {
  const [replayId, setReplayId] = useState(null)
  const isCash = mode === 'cash'

  if (loading) {
    return (
      <div className="bg-gray-900 border border-gray-800 rounded-xl p-5">
        <div className="h-4 w-44 rounded bg-gray-800 animate-pulse mb-4" />
        <div className="h-40 rounded bg-gray-800 animate-pulse" />
      </div>
    )
  }

  if (!winners.length && !losers.length) return null

  return (
    <>
      <div className="bg-gray-900 border border-gray-800 rounded-xl p-5">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-sm font-semibold text-gray-300">Biggest Winners &amp; Losers</h2>
          <span className="text-xs text-gray-600">Click any hand to review</span>
        </div>

        <div className="flex gap-6 flex-wrap sm:flex-nowrap">
          <HandList
            title="Top 5 Winners"
            hands={winners}
            isCash={isCash}
            onOpen={setReplayId}
            accentClass="text-emerald-500"
          />
          <div className="hidden sm:block w-px bg-gray-800 shrink-0" />
          <HandList
            title="Top 5 Losers"
            hands={losers}
            isCash={isCash}
            onOpen={setReplayId}
            accentClass="text-red-500"
          />
        </div>
      </div>

      {replayId && (
        <HandReplay
          handId={replayId}
          hero={mode === 'cash' ? 'FlaminGalah12' : 'FlaminGalah12'}
          onClose={() => setReplayId(null)}
        />
      )}
    </>
  )
}
