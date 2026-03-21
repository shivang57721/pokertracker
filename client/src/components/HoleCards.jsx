import { parseCards } from '../lib/format'

const SUIT_SYMBOL = { h: '♥', d: '♦', c: '♣', s: '♠' }
// 4-colour deck — full Tailwind class strings
const SUIT_CLASS  = { h: 'text-red-400', d: 'text-blue-400', c: 'text-emerald-400', s: 'text-slate-300' }

export default function HoleCards({ cards, size = 'sm' }) {
  const parsed = parseCards(cards)
  if (!parsed.length) return <span className="text-gray-600 font-mono">—</span>

  const textSize = size === 'lg' ? 'text-base' : 'text-sm'

  return (
    <span className="inline-flex items-center gap-0.5">
      {parsed.map((card, i) => {
        const rank = card.slice(0, -1)
        const suit = card.slice(-1)
        return (
          <span key={i} className={`font-bold font-mono tracking-tight ${textSize} ${SUIT_CLASS[suit] ?? 'text-gray-300'}`}>
            {rank}{SUIT_SYMBOL[suit] ?? suit}
          </span>
        )
      })}
    </span>
  )
}
