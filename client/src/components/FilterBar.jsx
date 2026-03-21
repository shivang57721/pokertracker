import { fmtStakes } from '../lib/format'

export default function FilterBar({ filters, onChange, availableFilters, mode = 'cash' }) {
  const set = (key, value) => onChange(prev => ({ ...prev, [key]: value }))

  // Reset only the fields FilterBar owns; is_tournament lives in App.jsx (mode)
  const reset = () => onChange({ from: '', to: '', game_type: '', stakes: '' })

  const hasFilter = filters.from || filters.to || filters.game_type || filters.stakes

  const gameTypes  = availableFilters?.game_types ?? []
  const allStakes  = availableFilters?.stakes ?? []
  const cashStakes = allStakes.filter(s => !s.is_tournament)

  return (
    <div className="flex flex-wrap items-center gap-2 text-sm">
      {/* Date range */}
      <div className="flex items-center gap-1">
        <input
          type="date"
          value={filters.from}
          onChange={e => set('from', e.target.value)}
          className="[color-scheme:dark] bg-gray-800 border border-gray-700 rounded-lg px-2 py-1.5
                     text-gray-200 focus:outline-none focus:border-gray-500 focus:ring-1
                     focus:ring-gray-500 w-36"
        />
        <span className="text-gray-500 text-xs">to</span>
        <input
          type="date"
          value={filters.to}
          onChange={e => set('to', e.target.value)}
          className="[color-scheme:dark] bg-gray-800 border border-gray-700 rounded-lg px-2 py-1.5
                     text-gray-200 focus:outline-none focus:border-gray-500 focus:ring-1
                     focus:ring-gray-500 w-36"
        />
      </div>

      <div className="w-px h-5 bg-gray-700" />

      {/* Game type */}
      <select
        value={filters.game_type}
        onChange={e => set('game_type', e.target.value)}
        className="bg-gray-800 border border-gray-700 rounded-lg px-2 py-1.5 text-gray-200
                   focus:outline-none focus:border-gray-500 focus:ring-1 focus:ring-gray-500"
      >
        <option value="">Game: All</option>
        {gameTypes.map(gt => <option key={gt} value={gt}>{gt}</option>)}
      </select>

      {/* Stakes — cash mode only, showing cash stakes only */}
      {mode === 'cash' && (
        <select
          value={filters.stakes}
          onChange={e => set('stakes', e.target.value)}
          className="bg-gray-800 border border-gray-700 rounded-lg px-2 py-1.5 text-gray-200
                     focus:outline-none focus:border-gray-500 focus:ring-1 focus:ring-gray-500"
        >
          <option value="">Stakes: All</option>
          {cashStakes.map(s => (
            <option key={s.stakes} value={s.stakes}>{fmtStakes(s.stakes)}</option>
          ))}
        </select>
      )}

      {/* Reset */}
      {hasFilter && (
        <button
          onClick={reset}
          className="text-gray-500 hover:text-gray-300 text-xs underline underline-offset-2 transition-colors"
        >
          Reset
        </button>
      )}
    </div>
  )
}
