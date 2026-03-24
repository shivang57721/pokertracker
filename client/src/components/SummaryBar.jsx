import { fmtUSD, fmtInt, fmtNum, fmtDuration } from '../lib/format'

function Tile({ label, value, sub, valueClass = 'text-gray-100', loading }) {
  return (
    <div className="flex flex-col gap-1 min-w-0">
      <span className="text-xs font-medium text-gray-500 uppercase tracking-wider truncate">{label}</span>
      {loading
        ? <div className="h-8 w-24 rounded bg-gray-800 animate-pulse" />
        : <span className={`text-2xl font-bold tabular-nums leading-none ${valueClass}`}>{value}</span>
      }
      {sub && !loading && (
        <span className="text-xs text-gray-600">{sub}</span>
      )}
    </div>
  )
}

function Divider() {
  return <div className="hidden sm:block w-px self-stretch bg-gray-800" />
}

function fmtChips(n) {
  if (n == null) return '—'
  const abs = Math.abs(Math.round(n)).toLocaleString()
  if (n > 0) return `+${abs}`
  if (n < 0) return `-${abs.replace('-', '')}`
  return '0'
}

export default function SummaryBar({ stats, sessions, loading, mode = 'cash', flaggedHands = null }) {
  const hands   = stats?.total_hands ?? null
  const nSess   = sessions?.length ?? null
  const avgDur  = sessions?.length
    ? Math.round(sessions.reduce((s, x) => s + x.duration_min, 0) / sessions.length)
    : null

  // ── Cash tiles ──────────────────────────────────────────────────────────────
  if (mode === 'cash') {
    const net    = stats?.profit?.cash_net_usd ?? null
    const bb100  = stats?.profit?.bb_100 ?? null
    const netClass  = net   == null ? 'text-gray-100' : net   > 0 ? 'text-emerald-400' : net   < 0 ? 'text-red-400' : 'text-gray-100'
    const bb100Class = bb100 == null ? 'text-gray-100' : bb100 > 0 ? 'text-emerald-400' : bb100 < 0 ? 'text-red-400' : 'text-gray-100'

    return (
      <div className="bg-gray-900 border border-gray-800 rounded-xl px-6 py-4">
        <div className="flex flex-wrap gap-6 sm:gap-8 items-center ">
          <Tile
            label="Hands"
            value={loading ? null : fmtInt(hands)}
            sub={stats?.cash_hands ? `${fmtInt(stats.cash_hands)} cash` : undefined}
            loading={loading}
          />
          <Divider />
          <Tile
            label="PnL"
            value={loading ? null : fmtUSD(net)}
            valueClass={netClass}
            loading={loading}
          />
          <Divider />
          <Tile
            label="BB / 100"
            value={loading ? null : bb100 != null ? (bb100 > 0 ? `+${fmtNum(bb100)}` : fmtNum(bb100)) : '—'}
            sub="big blinds per 100 hands"
            valueClass={bb100Class}
            loading={loading}
          />
          <Divider />
          <Tile
            label="Sessions"
            value={loading ? null : fmtInt(nSess)}
            sub={avgDur ? `avg ${fmtDuration(avgDur)}/session` : undefined}
            loading={loading}
          />
        </div>
      </div>
    )
  }

  // ── Tournament tiles ────────────────────────────────────────────────────────
  const chips     = stats?.profit?.tourn_net_chips ?? null
  const chipsClass = chips == null ? 'text-gray-100' : chips > 0 ? 'text-emerald-400' : chips < 0 ? 'text-red-400' : 'text-gray-100'

  return (
    <div className="bg-gray-900 border border-yellow-900/40 rounded-xl px-6 py-4">
      <div className="flex flex-wrap gap-6 sm:gap-8 items-center ">
        <Tile
          label="Hands"
          value={loading ? null : fmtInt(hands)}
          sub={stats?.tourn_hands ? `${fmtInt(stats.tourn_hands)} tournament` : undefined}
          loading={loading}
        />
        <Divider />
        <Tile
          label="Chip Delta"
          value={loading ? null : fmtChips(chips)}
          sub="net chips across all tournaments"
          valueClass={chipsClass}
          loading={loading}
        />
        <Divider />
        <Tile
          label="Sessions"
          value={loading ? null : fmtInt(nSess)}
          sub={avgDur ? `avg ${fmtDuration(avgDur)}/session` : undefined}
          loading={loading}
        />
        <Divider />
        <Tile
          label="3-Bet"
          value={loading ? null :
            stats ? `${stats.preflop.three_bet ?? '—'}%` : '—'
          }
          sub="3-bet frequency"
          loading={loading}
        />
      </div>
    </div>
  )
}
