import { useState, useMemo, useCallback } from 'react'
import {
  ResponsiveContainer, LineChart, Line, XAxis, YAxis,
  CartesianGrid, Tooltip, ReferenceLine, Brush,
} from 'recharts'
import { fmtDateShort, fmtUSD } from '../lib/format'

const MA_WINDOW = 100

function downsample(data, maxPoints = 500) {
  if (data.length <= maxPoints) return data
  const step = Math.ceil(data.length / maxPoints)
  return data.filter((_, i) => i % step === 0 || i === data.length - 1)
}

// Trailing 100-hand moving average of per-hand deltas, re-accumulated
function computeMA(display) {
  if (display.length < 2) return display.map(d => ({ ...d, ma: d.cumulative }))
  const deltas = display.map((d, i) =>
    i === 0 ? d.cumulative : d.cumulative - display[i - 1].cumulative
  )
  let running = 0
  return display.map((d, i) => {
    const start    = Math.max(0, i - MA_WINDOW + 1)
    const window   = deltas.slice(start, i + 1)
    const avgDelta = window.reduce((s, v) => s + v, 0) / window.length
    running += avgDelta
    return { ...d, ma: Math.round(running * 100) / 100 }
  })
}

function fmtChips(n) {
  if (n == null) return '—'
  const rounded = Math.round(n)
  return (rounded > 0 ? '+' : '') + rounded.toLocaleString()
}

function CashTooltip({ active, payload }) {
  if (!active || !payload?.length) return null
  const d   = payload[0]?.payload
  const val = d?.cumulative
  const ma  = d?.ma
  return (
    <div className="bg-gray-900 border border-gray-700 rounded-lg px-3 py-2 shadow-xl text-sm">
      <p className="text-gray-400 text-xs mb-1">{d?.label}</p>
      <p className={`font-bold tabular-nums ${val >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
        {fmtUSD(val)}
      </p>
      {ma != null && (
        <p className="text-orange-400 text-xs tabular-nums mt-0.5">
          100h avg: {fmtUSD(ma)}
        </p>
      )}
    </div>
  )
}

function TournTooltip({ active, payload }) {
  if (!active || !payload?.length) return null
  const d   = payload[0]?.payload
  const val = d?.cumulative
  return (
    <div className="bg-gray-900 border border-gray-700 rounded-lg px-3 py-2 shadow-xl text-sm">
      <p className="text-gray-400 text-xs mb-1">{d?.label}</p>
      <p className={`font-bold tabular-nums ${val >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
        {fmtChips(val)} chips
      </p>
    </div>
  )
}

export default function ProfitChart({ data = [], loading, mode = 'cash' }) {
  const [brushRange, setBrushRange] = useState(null)
  const isTournament = mode === 'tournament'

  const display = useMemo(() => {
    setBrushRange(null)
    const sampled = downsample(data).map((d, i) => ({
      ...d,
      idx:   i,
      label: fmtDateShort(d.date),
    }))
    return isTournament ? sampled : computeMA(sampled)
  }, [data, isTournament])

  // Pick up to 8 evenly-spaced tick indices, no duplicates
  const xTicks = useMemo(() => {
    const n = display.length
    if (n <= 1) return display.map(d => d.idx)
    const count  = Math.min(8, n)
    const result = []
    for (let i = 0; i < count; i++) {
      result.push(Math.round(i * (n - 1) / (count - 1)))
    }
    return [...new Set(result)]
  }, [display])

  const tickFormatter = useCallback(idx => display[idx]?.label ?? '', [display])

  const isZoomed  = brushRange !== null
  const values    = display.map(d => d.cumulative)
  const minVal    = values.length ? Math.min(...values) : -1
  const maxVal    = values.length ? Math.max(...values) :  1
  const pad       = Math.max(Math.abs(maxVal - minVal) * 0.1, isTournament ? 1 : 0.05)
  const yDomain   = [minVal - pad, maxVal + pad]

  const finalVal   = display.at(-1)?.cumulative
  const isProfit   = finalVal >= 0
  const lineColor  = isProfit ? '#34d399' : '#f87171'

  const borderCls  = isTournament ? 'border-yellow-900/40' : 'border-gray-800'
  const title      = isTournament ? 'Tournament Chip Delta' : 'Cash Profit'
  const finalLabel = isTournament ? `${fmtChips(finalVal)} chips` : fmtUSD(finalVal)

  if (loading) {
    return (
      <div className={`bg-gray-900 border ${borderCls} rounded-xl p-5`}>
        <div className="h-5 w-48 rounded bg-gray-800 animate-pulse mb-4" />
        <div className="h-64 rounded bg-gray-800 animate-pulse" />
      </div>
    )
  }

  if (!display.length) {
    return (
      <div className={`bg-gray-900 border ${borderCls} rounded-xl p-5 flex items-center justify-center h-72`}>
        <p className="text-gray-600">No data for selected filters</p>
      </div>
    )
  }

  return (
    <div className={`bg-gray-900 border ${borderCls} rounded-xl p-5`}>
      <div className="flex items-center justify-between mb-4 flex-wrap gap-2">
        <div className="flex items-center gap-3 flex-wrap">
          <h2 className="text-sm font-semibold text-gray-300">{title}</h2>
          <span className={`text-xs px-2 py-0.5 rounded-full font-medium
            ${isProfit ? 'bg-emerald-400/10 text-emerald-400' : 'bg-red-400/10 text-red-400'}`}>
            {finalLabel}
          </span>
          <span className="text-xs text-gray-600">{display.length} hands</span>
          {!isTournament && (
            <span className="flex items-center gap-1.5 text-xs text-gray-600">
              <span className="inline-block w-6 border-t-2 border-orange-400 opacity-70 rounded" />
              100-hand avg
            </span>
          )}
        </div>
        <div className="flex items-center gap-3 text-xs">
          {isZoomed && (
            <button
              onClick={() => setBrushRange(null)}
              className="text-gray-400 hover:text-gray-200 underline underline-offset-2 transition-colors"
            >
              Reset zoom
            </button>
          )}
          <span className="text-gray-600">Drag bottom to zoom</span>
        </div>
      </div>

      <ResponsiveContainer width="100%" height={280}>
        <LineChart data={display} margin={{ top: 4, right: 4, left: 0, bottom: 0 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="#1f2937" vertical={false} />

          <XAxis
            dataKey="idx"
            type="number"
            domain={[0, display.length - 1]}
            ticks={xTicks}
            tickFormatter={tickFormatter}
            tick={{ fill: '#6b7280', fontSize: 11 }}
            axisLine={{ stroke: '#1f2937' }}
            tickLine={false}
          />

          <YAxis
            domain={yDomain}
            tick={{ fill: '#6b7280', fontSize: 11 }}
            axisLine={false}
            tickLine={false}
            tickFormatter={isTournament
              ? v => v >= 1000 ? `${(v / 1000).toFixed(1)}k` : String(Math.round(v))
              : v => `$${v.toFixed(2)}`
            }
            width={isTournament ? 44 : 56}
          />

          <Tooltip content={isTournament ? <TournTooltip /> : <CashTooltip />} />

          <ReferenceLine y={0} stroke="#374151" strokeDasharray="4 4" strokeWidth={1} />

          {/* 100-hand moving average — drawn first so profit line renders on top */}
          {!isTournament && (
            <Line
              type="monotone"
              dataKey="ma"
              stroke="#fb923c"
              strokeWidth={2}
              strokeOpacity={0.65}
              dot={false}
              activeDot={false}
              isAnimationActive={false}
            />
          )}

          {/* Main cumulative profit line */}
          <Line
            type="monotone"
            dataKey="cumulative"
            stroke={lineColor}
            strokeWidth={2}
            dot={false}
            activeDot={{ r: 4, strokeWidth: 0, fill: lineColor }}
          />

          <Brush
            dataKey="idx"
            height={32}
            stroke="#374151"
            fill="#0f172a"
            travellerWidth={6}
            startIndex={brushRange?.start ?? 0}
            endIndex={brushRange?.end ?? display.length - 1}
            onChange={({ startIndex, endIndex }) => {
              if (startIndex === 0 && endIndex === display.length - 1) setBrushRange(null)
              else setBrushRange({ start: startIndex, end: endIndex })
            }}
          >
            <LineChart>
              <Line type="monotone" dataKey="cumulative" stroke="#374151" dot={false} strokeWidth={1} />
            </LineChart>
          </Brush>
        </LineChart>
      </ResponsiveContainer>
    </div>
  )
}
