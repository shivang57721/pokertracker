import { fmtStakes } from '../lib/format'

const PRESETS = [
  { id: 'all_time', label: 'All Time'     },
  { id: 'today',    label: 'Today'        },
  { id: 'last_7',   label: 'Last 7 Days'  },
  { id: 'last_30',  label: 'Last 30 Days' },
  { id: 'custom',   label: 'Custom'       },
]

const POSITIONS_CASH = [
  { value: '',             label: 'Position: All' },
  { value: 'button',       label: 'BTN'           },
  { value: 'co',           label: 'CO'            },
  { value: 'hj',           label: 'HJ'            },
  { value: 'utg',          label: 'UTG'           },
  { value: 'big blind',    label: 'BB'            },
  { value: 'small blind',  label: 'SB'            },
]

const POSITIONS_TOURNAMENT = [
  { value: '',             label: 'Position: All' },
  { value: 'button',       label: 'BTN'           },
  { value: 'co',           label: 'CO'            },
  { value: 'hj',           label: 'HJ'            },
  { value: 'lj',           label: 'LJ'            },
  { value: 'mp',           label: 'MP'            },
  { value: 'utg+1',        label: 'UTG+1'         },
  { value: 'utg',          label: 'UTG'           },
  { value: 'big blind',    label: 'BB'            },
  { value: 'small blind',  label: 'SB'            },
]

export default function FilterBar({
  filters, onChange, availableFilters, mode = 'cash',
  datePreset = 'all_time', onPresetChange,
}) {
  const set = (key, value) => onChange(prev => ({ ...prev, [key]: value }))

  const handleDateChange = (key, value) => {
    onChange(prev => ({ ...prev, [key]: value }))
    onPresetChange?.('custom')
  }

  const reset = () => {
    onChange({ from: '', to: '', game_type: '', stakes: '', position: '' })
    onPresetChange?.('all_time')
  }

  const hasFilter = filters.from || filters.to || filters.game_type || filters.stakes || filters.position

  const gameTypes  = availableFilters?.game_types ?? []
  const allStakes  = availableFilters?.stakes ?? []
  const cashStakes = allStakes.filter(s => !s.is_tournament)
  const positions  = mode === 'cash' ? POSITIONS_CASH : POSITIONS_TOURNAMENT

  return (
    <div className="flex flex-wrap items-center gap-2 text-sm">
      {/* Date preset chips */}
      <div className="flex items-center gap-1 flex-wrap">
        {PRESETS.map(p => (
          <button
            key={p.id}
            onClick={() => onPresetChange?.(p.id)}
            className={`px-3 py-1 rounded-full text-xs font-medium transition-colors border
              ${datePreset === p.id
                ? 'bg-emerald-600 border-emerald-500 text-white'
                : 'bg-gray-800 border-gray-700 text-gray-400 hover:text-gray-200 hover:border-gray-600'}`}
          >
            {p.label}
          </button>
        ))}
      </div>

      {/* Custom date pickers — only visible when Custom is active */}
      {datePreset === 'custom' && (
        <div className="flex items-center gap-1">
          <input
            type="date"
            value={filters.from}
            onChange={e => handleDateChange('from', e.target.value)}
            className="[color-scheme:dark] bg-gray-800 border border-gray-700 rounded-lg px-2 py-1
                       text-gray-200 focus:outline-none focus:border-gray-500 focus:ring-1
                       focus:ring-gray-500 text-xs"
            style={{ width: '8.5rem' }}
          />
          <span className="text-gray-500 text-xs">–</span>
          <input
            type="date"
            value={filters.to}
            onChange={e => handleDateChange('to', e.target.value)}
            className="[color-scheme:dark] bg-gray-800 border border-gray-700 rounded-lg px-2 py-1
                       text-gray-200 focus:outline-none focus:border-gray-500 focus:ring-1
                       focus:ring-gray-500 text-xs"
            style={{ width: '8.5rem' }}
          />
        </div>
      )}

      <div className="w-px h-5 bg-gray-700 shrink-0" />

      {/* Game type */}
      <select
        value={filters.game_type}
        onChange={e => set('game_type', e.target.value)}
        className="bg-gray-800 border border-gray-700 rounded-lg px-2 py-1.5 text-gray-200 text-xs
                   focus:outline-none focus:border-gray-500 focus:ring-1 focus:ring-gray-500"
      >
        <option value="">Game: All</option>
        {gameTypes.map(gt => <option key={gt} value={gt}>{gt}</option>)}
      </select>

      {/* Stakes — cash mode only */}
      {mode === 'cash' && (
        <select
          value={filters.stakes}
          onChange={e => set('stakes', e.target.value)}
          className="bg-gray-800 border border-gray-700 rounded-lg px-2 py-1.5 text-gray-200 text-xs
                     focus:outline-none focus:border-gray-500 focus:ring-1 focus:ring-gray-500"
        >
          <option value="">Stakes: All</option>
          {cashStakes.map(s => (
            <option key={s.stakes} value={s.stakes}>{fmtStakes(s.stakes)}</option>
          ))}
        </select>
      )}

      {/* Position */}
      <select
        value={filters.position ?? ''}
        onChange={e => set('position', e.target.value)}
        className="bg-gray-800 border border-gray-700 rounded-lg px-2 py-1.5 text-gray-200 text-xs
                   focus:outline-none focus:border-gray-500 focus:ring-1 focus:ring-gray-500"
      >
        {positions.map(p => (
          <option key={p.value} value={p.value}>{p.label}</option>
        ))}
      </select>

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
