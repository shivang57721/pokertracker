import {
  ResponsiveContainer, BarChart, Bar, XAxis, YAxis,
  CartesianGrid, Tooltip, ReferenceLine, Cell,
} from 'recharts'
import { fmtInt } from '../lib/format'

const POSITION_ORDER = ['utg', 'utg+1', 'mp', 'lj', 'hj', 'co', 'button', 'small blind', 'big blind']
const POSITION_LABEL = {
  'utg':         'UTG',
  'utg+1':       'UTG+1',
  'mp':          'MP',
  'lj':          'LJ',
  'hj':          'HJ',
  'co':          'CO',
  'button':      'BTN',
  'small blind': 'SB',
  'big blind':   'BB',
}

function PosTooltip({ active, payload }) {
  if (!active || !payload?.length) return null
  const d = payload[0]?.payload
  return (
    <div className="bg-gray-900 border border-gray-700 rounded-lg px-3 py-2 shadow-xl text-sm">
      <p className="font-semibold text-gray-200 mb-1">{d.label}</p>
      <p className={`font-bold tabular-nums ${d.bb_100 >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
        {d.bb_100 >= 0 ? '+' : ''}{d.bb_100?.toFixed(1)} BB/100
      </p>
      <p className="text-xs text-gray-500 mt-0.5">{fmtInt(d.hand_count)} hands</p>
    </div>
  )
}

export default function WinRateByPosition({ data = [], loading }) {
  if (loading) {
    return (
      <div className="bg-gray-900 border border-gray-800 rounded-xl p-5">
        <div className="h-4 w-40 rounded bg-gray-800 animate-pulse mb-4" />
        <div className="h-52 rounded bg-gray-800 animate-pulse" />
      </div>
    )
  }

  if (!data.length) {
    return (
      <div className="bg-gray-900 border border-gray-800 rounded-xl p-5 flex items-center justify-center h-36">
        <p className="text-gray-600 text-sm">No position data for selected filters</p>
      </div>
    )
  }

  // Sort into canonical position order, filter out positions with no BB/100
  const sorted = POSITION_ORDER
    .map(pos => {
      const row = data.find(d => d.position === pos)
      if (!row || row.bb_100 == null) return null
      return { ...row, label: POSITION_LABEL[pos] ?? pos }
    })
    .filter(Boolean)

  // Also include any positions not in the canonical order (shouldn't happen but just in case)
  const known = new Set(POSITION_ORDER)
  for (const row of data) {
    if (!known.has(row.position) && row.bb_100 != null) {
      sorted.push({ ...row, label: POSITION_LABEL[row.position] ?? row.position })
    }
  }

  const maxAbs = Math.max(...sorted.map(d => Math.abs(d.bb_100)), 1)
  const domain = [-(maxAbs * 1.2), maxAbs * 1.2]

  return (
    <div className="bg-gray-900 border border-gray-800 rounded-xl p-5">
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-sm font-semibold text-gray-300">Win Rate by Position</h2>
        <span className="text-xs text-gray-600">BB/100 · cash hands only</span>
      </div>

      <ResponsiveContainer width="100%" height={sorted.length * 44 + 20}>
        <BarChart
          layout="vertical"
          data={sorted}
          margin={{ top: 0, right: 60, left: 0, bottom: 0 }}
          barSize={20}
        >
          <CartesianGrid strokeDasharray="3 3" stroke="#1f2937" horizontal={false} />

          <XAxis
            type="number"
            domain={domain}
            tick={{ fill: '#6b7280', fontSize: 11 }}
            axisLine={{ stroke: '#374151' }}
            tickLine={false}
            tickFormatter={v => `${v > 0 ? '+' : ''}${v.toFixed(0)}`}
          />

          <YAxis
            type="category"
            dataKey="label"
            tick={{ fill: '#9ca3af', fontSize: 12, fontWeight: 600 }}
            axisLine={false}
            tickLine={false}
            width={44}
          />

          <Tooltip content={<PosTooltip />} cursor={{ fill: 'rgba(255,255,255,0.04)' }} />

          <ReferenceLine x={0} stroke="#374151" strokeWidth={1} />

          <Bar dataKey="bb_100" radius={[0, 3, 3, 0]}
            label={{
              position: 'right',
              formatter: v => `${v >= 0 ? '+' : ''}${v.toFixed(1)}`,
              fill: '#6b7280',
              fontSize: 11,
            }}
          >
            {sorted.map((entry, i) => (
              <Cell
                key={i}
                fill={entry.bb_100 >= 0 ? '#34d399' : '#f87171'}
                fillOpacity={0.85}
              />
            ))}
          </Bar>
        </BarChart>
      </ResponsiveContainer>

      {/* Hand count summary row */}
      <div className="flex flex-wrap gap-3 mt-3 pt-3 border-t border-gray-800">
        {sorted.map(d => (
          <span key={d.label} className="text-xs text-gray-600">
            <span className="text-gray-400 font-medium">{d.label}</span>
            {' '}{fmtInt(d.hand_count)}h
          </span>
        ))}
      </div>
    </div>
  )
}
