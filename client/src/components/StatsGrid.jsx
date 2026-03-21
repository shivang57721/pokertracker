import { STATS_META, QUALITY_STYLE } from '../lib/benchmarks'
import { fmtPct, fmtNum, fmtInt } from '../lib/format'

const STAT_KEYS = [
  { key: 'vpip',      path: s => s.preflop.vpip,            countKey: 'vpip',       fmt: fmtPct },
  { key: 'pfr',       path: s => s.preflop.pfr,             countKey: 'pfr',        fmt: fmtPct },
  { key: 'three_bet', path: s => s.preflop.three_bet,       countKey: 'three_bet',  fmt: fmtPct },
  { key: 'af',        path: s => s.aggression.overall,      countKey: null,         fmt: v => fmtNum(v, 2) },
  { key: 'wtsd',      path: s => s.postflop.wtsd,           countKey: 'wtsd',       fmt: fmtPct },
  { key: 'w_sd',      path: s => s.postflop.w_sd,           countKey: 'wsd_won',    fmt: fmtPct },
  { key: 'cbet',      path: s => s.postflop.cbet,           countKey: 'cbet_done',  fmt: fmtPct },
]

function StatCard({ meta, value, count, totalHands, loading }) {
  const q      = meta.quality(value)
  const style  = QUALITY_STYLE[q]
  const sample = count != null && totalHands ? `${fmtInt(count)} / ${fmtInt(totalHands)}` : null

  if (loading) {
    return (
      <div className="bg-gray-900 border border-gray-800 rounded-xl p-4 flex flex-col gap-3">
        <div className="h-3 w-16 rounded bg-gray-800 animate-pulse" />
        <div className="h-8 w-20 rounded bg-gray-800 animate-pulse" />
        <div className="h-2 w-24 rounded bg-gray-800 animate-pulse" />
      </div>
    )
  }

  return (
    <div className={`bg-gray-900 border rounded-xl p-4 flex flex-col gap-2 transition-colors hover:bg-gray-800/50 ${style.border}`}>
      {/* Header row */}
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs font-semibold text-gray-500 uppercase tracking-wider truncate">
          {meta.label}
        </span>
        {/* Quality indicator dot */}
        <span className={`w-2 h-2 rounded-full flex-shrink-0 ${style.dot}`} title={`${q} range`} />
      </div>

      {/* Big value */}
      <span className={`text-3xl font-bold tabular-nums leading-none ${style.value}`}>
        {value != null ? `${meta.fmt(value)}${meta.unit}` : '—'}
      </span>

      {/* Description + sample size */}
      <div className="flex flex-col gap-1 mt-auto">
        <span className="text-xs text-gray-600 leading-tight">{meta.description}</span>
        {sample && (
          <span className="text-xs text-gray-700 tabular-nums">{sample} hands</span>
        )}
      </div>

      {/* Benchmark badge */}
      <span className={`self-start text-xs px-2 py-0.5 rounded-full font-medium ${style.badge}`}>
        {meta.goodRange}
      </span>
    </div>
  )
}

// Per-street aggression mini-cards
function AfStreetBreakdown({ aggression, loading }) {
  const streets = [
    { label: 'Flop', value: aggression?.flop },
    { label: 'Turn', value: aggression?.turn },
    { label: 'River', value: aggression?.river },
  ]
  return (
    <div className="bg-gray-900 border border-gray-800 rounded-xl p-4 col-span-full">
      <p className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-3">
        Aggression Factor by Street
      </p>
      <div className="flex gap-6">
        {streets.map(s => (
          <div key={s.label} className="flex flex-col gap-1">
            <span className="text-xs text-gray-600">{s.label}</span>
            {loading
              ? <div className="h-6 w-10 rounded bg-gray-800 animate-pulse" />
              : <span className="text-lg font-bold text-gray-200 tabular-nums">
                  {s.value != null ? fmtNum(s.value, 2) : '—'}
                </span>
            }
          </div>
        ))}
        <div className="ml-auto text-xs text-gray-700 self-end leading-relaxed text-right">
          AF = (bets + raises) / calls<br/>
          &gt;2 aggressive · &lt;1 passive
        </div>
      </div>
    </div>
  )
}

export default function StatsGrid({ stats, loading }) {
  const totalHands = stats?.total_hands ?? null

  return (
    <div className="space-y-3">
      <h2 className="text-xs font-semibold text-gray-500 uppercase tracking-wider">Key Stats</h2>
      <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-7 gap-3">
        {STAT_KEYS.map(({ key, path, countKey, fmt }) => {
          const meta  = STATS_META[key]
          const value = stats ? path(stats) : null
          const count = countKey && stats?.counts ? stats.counts[countKey] : null
          return (
            <StatCard
              key={key}
              meta={{ ...meta, fmt }}
              value={value}
              count={count}
              totalHands={totalHands}
              loading={loading}
            />
          )
        })}
      </div>

      {/* Street-by-street AF breakdown */}
      <div className="grid grid-cols-1">
        <AfStreetBreakdown aggression={stats?.aggression} loading={loading} />
      </div>
    </div>
  )
}
