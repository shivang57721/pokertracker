import { useState, useEffect, useCallback } from 'react'
import Sparkline from './Sparkline'
import { fetchSessions, fetchAvailableFilters } from '../lib/api'
import { fmtUSD, fmtInt, fmtDuration, fmtStakes } from '../lib/format'

// ── Helpers ───────────────────────────────────────────────────────────────────

function fmtSessionDate(str) {
  if (!str) return ''
  const d = new Date(str.replace(' ', 'T'))
  return d.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' })
}

function fmtTime(str) {
  if (!str) return ''
  return new Date(str.replace(' ', 'T')).toTimeString().slice(0, 5)
}

// ── Summary tile ─────────────────────────────────────────────────────────────
function Tile({ label, value, sub, valueClass = 'text-gray-100' }) {
  return (
    <div className="bg-gray-900 border border-gray-800 rounded-xl px-4 py-3 flex flex-col gap-1">
      <span className="text-xs font-medium text-gray-500 uppercase tracking-wider">{label}</span>
      <span className={`text-2xl font-bold tabular-nums leading-none ${valueClass}`}>{value}</span>
      {sub && <span className="text-xs text-gray-600">{sub}</span>}
    </div>
  )
}

// ── Net badge (inline, compact) ───────────────────────────────────────────────
function NetBadge({ net, chips, isTournament, large = false }) {
  const val     = isTournament ? chips : net
  const label   = isTournament ? `${val > 0 ? '+' : ''}${fmtInt(val)} chips` : fmtUSD(val)
  const cls     = val > 0 ? 'text-emerald-400' : val < 0 ? 'text-red-400' : 'text-gray-500'
  const sizeCls = large ? 'text-2xl font-bold' : 'text-sm font-semibold'
  return <span className={`tabular-nums ${cls} ${sizeCls}`}>{label}</span>
}

// ── Session card ─────────────────────────────────────────────────────────────
function SessionCard({ session }) {
  const isWin     = (session.is_tournament ? session.tourn_net_chips : session.cash_net_usd) > 0
  const isLoss    = (session.is_tournament ? session.tourn_net_chips : session.cash_net_usd) < 0
  const borderCls = isWin  ? 'border-emerald-800/50 hover:border-emerald-700/60'
                  : isLoss ? 'border-red-900/50 hover:border-red-800/60'
                  :          'border-gray-800 hover:border-gray-700'

  const gameShort = session.game_type
    ?.replace("Hold'em ", '')
    .replace(' Limit', '')
    ?? '—'

  return (
    <div className={`bg-gray-900 border rounded-xl p-4 flex flex-col gap-3 transition-colors ${borderCls}`}>
      {/* ── Header row ── */}
      <div className="flex items-start justify-between gap-2">
        <div>
          <p className="text-sm font-semibold text-gray-200 leading-tight">
            {fmtSessionDate(session.start)}
          </p>
          <p className="text-xs text-gray-600 mt-0.5">
            {fmtTime(session.start)} – {fmtTime(session.end)}
          </p>
        </div>

        {/* Duration + hands badges */}
        <div className="flex flex-col items-end gap-1 shrink-0">
          <span className="text-xs bg-gray-800 text-gray-400 px-2 py-0.5 rounded-full font-medium">
            {fmtDuration(session.duration_min)}
          </span>
          <span className="text-xs text-gray-600">
            {fmtInt(session.hands)} hands
          </span>
        </div>
      </div>

      {/* ── Game info ── */}
      <div className="flex flex-wrap gap-x-3 gap-y-1 text-xs">
        <span className="text-gray-400 font-medium">{gameShort}</span>
        <span className="text-gray-600">{fmtStakes(session.stakes)}</span>
        {session.is_tournament && (
          <span className="text-yellow-700 bg-yellow-900/20 px-1.5 py-0.5 rounded font-medium">
            Tournament
          </span>
        )}
      </div>

      {/* ── Tables ── */}
      {session.tables?.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {session.tables.slice(0, 4).map(t => (
            <span key={t}
              className="text-xs text-gray-600 bg-gray-800/60 px-2 py-0.5 rounded truncate max-w-40"
              title={t}>
              {t}
            </span>
          ))}
          {session.tables.length > 4 && (
            <span className="text-xs text-gray-700">+{session.tables.length - 4} more</span>
          )}
        </div>
      )}

      {/* ── Sparkline + profit ── */}
      <div className="flex items-end justify-between gap-3 mt-auto pt-1 border-t border-gray-800/60">
        {/* Sparkline */}
        <div className="flex-1 min-w-0">
          <Sparkline data={session.sparkline} width={96} height={36} />
        </div>

        {/* Profit block */}
        <div className="flex flex-col items-end gap-0.5 shrink-0">
          <NetBadge
            net={session.cash_net_usd}
            chips={session.tourn_net_chips}
            isTournament={session.is_tournament}
            large
          />
          {session.bb_100 != null && (
            <span className={`text-xs tabular-nums font-medium
              ${session.bb_100 > 0 ? 'text-emerald-600' : session.bb_100 < 0 ? 'text-red-700' : 'text-gray-600'}`}>
              {session.bb_100 > 0 ? '+' : ''}{session.bb_100} BB/100
            </span>
          )}
        </div>
      </div>
    </div>
  )
}

// ── Sort options ──────────────────────────────────────────────────────────────
const SORT_OPTIONS = [
  { value: 'date_desc',   label: 'Newest first'    },
  { value: 'date_asc',    label: 'Oldest first'    },
  { value: 'profit_desc', label: 'Most profitable' },
  { value: 'profit_asc',  label: 'Biggest loss'    },
  { value: 'hands_desc',  label: 'Most hands'      },
  { value: 'dur_desc',    label: 'Longest'         },
]

function sortSessions(sessions, sortKey) {
  const arr = [...sessions]
  const net = s => s.is_tournament ? s.tourn_net_chips : s.cash_net_usd
  switch (sortKey) {
    case 'date_asc':    return arr.reverse()        // already newest-first from server
    case 'profit_desc': return arr.sort((a, b) => net(b) - net(a))
    case 'profit_asc':  return arr.sort((a, b) => net(a) - net(b))
    case 'hands_desc':  return arr.sort((a, b) => b.hands - a.hands)
    case 'dur_desc':    return arr.sort((a, b) => b.duration_min - a.duration_min)
    default:            return arr  // date_desc — server already returns newest first
  }
}

// ── Main component ───────────────────────────────────────────────────────────
const PAGE_SIZE = 18  // 3-col × 6 rows

export default function SessionHistory({ hero }) {
  const [sessions,         setSessions]         = useState([])
  const [availableFilters, setAvailableFilters] = useState(null)
  const [loading,          setLoading]          = useState(true)
  const [error,            setError]            = useState(null)

  // Filters
  const [from,         setFrom]         = useState('')
  const [to,           setTo]           = useState('')
  const [stakes,       setStakes]       = useState('')
  const [isTournament, setIsTournament] = useState('')
  const [sort,         setSort]         = useState('date_desc')
  const [page,         setPage]         = useState(1)

  useEffect(() => {
    fetchAvailableFilters(hero).then(setAvailableFilters).catch(() => {})
  }, [hero])

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const opts = {}
      if (from)               opts.from           = from
      if (to)                 opts.to             = to
      if (stakes)             opts.stakes         = stakes
      if (isTournament !== '') opts.is_tournament = isTournament
      const data = await fetchSessions(hero, opts)
      setSessions(data)
    } catch (e) {
      setError(e.message)
    } finally {
      setLoading(false)
    }
  }, [hero, from, to, stakes, isTournament])

  useEffect(() => { load() }, [load])

  // Reset page when sort or filters change
  useEffect(() => { setPage(1) }, [sort, from, to, stakes, isTournament])

  const sorted     = sortSessions(sessions, sort)
  const totalPages = Math.max(1, Math.ceil(sorted.length / PAGE_SIZE))
  const visible    = sorted.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE)

  // ── Summary stats ──────────────────────────────────────────────────────────
  const cashSessions = sessions.filter(s => !s.is_tournament)
  const totalNet     = cashSessions.reduce((s, x) => s + x.cash_net_usd, 0)
  const totalMins    = sessions.reduce((s, x) => s + x.duration_min, 0)
  const wins         = cashSessions.filter(s => s.cash_net_usd > 0).length
  const losses       = cashSessions.filter(s => s.cash_net_usd < 0).length
  const best         = cashSessions.length
    ? Math.max(...cashSessions.map(s => s.cash_net_usd)) : null
  const worst        = cashSessions.length
    ? Math.min(...cashSessions.map(s => s.cash_net_usd)) : null

  const stakesList = availableFilters?.stakes ?? []
  const hasFilter  = from || to || stakes || isTournament !== ''

  return (
    <div className="flex flex-col gap-6">
      {/* ── Summary tiles ────────────────────────────────────────────────── */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
        <Tile
          label="Sessions"
          value={loading ? '—' : fmtInt(sessions.length)}
          sub={`${wins}W / ${losses}L`}
        />
        <Tile
          label="Time played"
          value={loading ? '—' : fmtDuration(totalMins)}
          sub={sessions.length ? `${fmtDuration(Math.round(totalMins / sessions.length))} avg` : undefined}
        />
        <Tile
          label="Cash net"
          value={loading ? '—' : fmtUSD(totalNet)}
          valueClass={totalNet > 0 ? 'text-emerald-400' : totalNet < 0 ? 'text-red-400' : 'text-gray-100'}
        />
        <Tile
          label="Best session"
          value={loading || best == null ? '—' : fmtUSD(best)}
          valueClass="text-emerald-400"
        />
        <Tile
          label="Worst session"
          value={loading || worst == null ? '—' : fmtUSD(worst)}
          valueClass="text-red-400"
        />
        <Tile
          label="Avg hands"
          value={loading || !sessions.length ? '—' : fmtInt(Math.round(sessions.reduce((s, x) => s + x.hands, 0) / sessions.length))}
          sub="per session"
        />
      </div>

      {/* ── Filter bar ───────────────────────────────────────────────────── */}
      <div className="flex flex-wrap items-center gap-2 text-sm">
        {/* Date range */}
        <input type="date" value={from} onChange={e => setFrom(e.target.value)}
          className="[color-scheme:dark] bg-gray-800 border border-gray-700 rounded-lg px-2 py-1.5
                     text-gray-200 focus:outline-none focus:border-gray-500 focus:ring-1 focus:ring-gray-500 w-36" />
        <span className="text-gray-600 text-xs">to</span>
        <input type="date" value={to} onChange={e => setTo(e.target.value)}
          className="[color-scheme:dark] bg-gray-800 border border-gray-700 rounded-lg px-2 py-1.5
                     text-gray-200 focus:outline-none focus:border-gray-500 focus:ring-1 focus:ring-gray-500 w-36" />

        <div className="w-px h-5 bg-gray-700" />

        {/* Stakes */}
        <select value={stakes} onChange={e => setStakes(e.target.value)}
          className="bg-gray-800 border border-gray-700 rounded-lg px-2 py-1.5 text-gray-200
                     focus:outline-none focus:border-gray-500 focus:ring-1 focus:ring-gray-500">
          <option value="">Stakes: All</option>
          {stakesList.map(s => (
            <option key={s.stakes} value={s.stakes}>{fmtStakes(s.stakes)}</option>
          ))}
        </select>

        {/* Cash / Tourn toggle */}
        <div className="flex rounded-lg border border-gray-700 overflow-hidden">
          {[['', 'All'], ['0', 'Cash'], ['1', 'Tourn']].map(([val, lbl]) => (
            <button key={val} onClick={() => setIsTournament(val)}
              className={`px-3 py-1.5 text-xs font-medium transition-colors
                ${isTournament === val ? 'bg-emerald-600 text-white' : 'bg-gray-800 text-gray-400 hover:text-gray-200'}`}>
              {lbl}
            </button>
          ))}
        </div>

        <div className="w-px h-5 bg-gray-700" />

        {/* Sort */}
        <select value={sort} onChange={e => setSort(e.target.value)}
          className="bg-gray-800 border border-gray-700 rounded-lg px-2 py-1.5 text-gray-200
                     focus:outline-none focus:border-gray-500 focus:ring-1 focus:ring-gray-500">
          {SORT_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>

        {hasFilter && (
          <button
            onClick={() => { setFrom(''); setTo(''); setStakes(''); setIsTournament('') }}
            className="text-gray-500 hover:text-gray-300 text-xs underline underline-offset-2 transition-colors ml-1">
            Reset
          </button>
        )}

        <span className="ml-auto text-xs text-gray-600">
          {loading ? 'Loading…' : `${sessions.length} session${sessions.length !== 1 ? 's' : ''}`}
        </span>
      </div>

      {error && (
        <div className="bg-red-900/30 border border-red-700 rounded-xl px-4 py-3 text-sm text-red-300">
          Failed to load sessions: {error}
        </div>
      )}

      {/* ── Session cards ─────────────────────────────────────────────────── */}
      {loading ? (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {Array.from({ length: 6 }).map((_, i) => (
            <div key={i} className="bg-gray-900 border border-gray-800 rounded-xl p-4 space-y-3">
              <div className="flex justify-between">
                <div className="space-y-1.5">
                  <div className="h-4 w-36 rounded bg-gray-800 animate-pulse" />
                  <div className="h-3 w-24 rounded bg-gray-800 animate-pulse" />
                </div>
                <div className="h-5 w-14 rounded-full bg-gray-800 animate-pulse" />
              </div>
              <div className="h-3 w-28 rounded bg-gray-800 animate-pulse" />
              <div className="flex gap-1.5">
                <div className="h-4 w-20 rounded bg-gray-800 animate-pulse" />
                <div className="h-4 w-20 rounded bg-gray-800 animate-pulse" />
              </div>
              <div className="flex justify-between items-end pt-1 border-t border-gray-800/60">
                <div className="h-9 w-24 rounded bg-gray-800 animate-pulse" />
                <div className="h-6 w-16 rounded bg-gray-800 animate-pulse" />
              </div>
            </div>
          ))}
        </div>
      ) : visible.length === 0 ? (
        <div className="flex items-center justify-center h-40 text-gray-600 text-sm">
          No sessions match your filters
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {visible.map((s, i) => (
            <SessionCard key={`${s.start}-${i}`} session={s} />
          ))}
        </div>
      )}

      {/* ── Pagination ───────────────────────────────────────────────────── */}
      {!loading && totalPages > 1 && (
        <div className="flex items-center justify-center gap-1 pt-2">
          <button
            onClick={() => setPage(p => Math.max(1, p - 1))}
            disabled={page === 1}
            className="px-3 py-1.5 text-xs rounded bg-gray-800 text-gray-400
                       hover:bg-gray-700 hover:text-gray-200 disabled:opacity-30 disabled:cursor-not-allowed transition-colors">
            ← Prev
          </button>

          {Array.from({ length: totalPages }, (_, i) => i + 1)
            .filter(p => p === 1 || p === totalPages || Math.abs(p - page) <= 2)
            .reduce((acc, p, idx, arr) => {
              if (idx > 0 && p - arr[idx - 1] > 1) acc.push('…')
              acc.push(p)
              return acc
            }, [])
            .map((p, i) =>
              p === '…' ? (
                <span key={`e${i}`} className="px-1 text-gray-700 text-xs">…</span>
              ) : (
                <button key={p} onClick={() => setPage(p)}
                  className={`w-8 h-7 text-xs rounded transition-colors
                    ${p === page ? 'bg-emerald-600 text-white' : 'bg-gray-800 text-gray-400 hover:bg-gray-700 hover:text-gray-200'}`}>
                  {p}
                </button>
              )
            )}

          <button
            onClick={() => setPage(p => Math.min(totalPages, p + 1))}
            disabled={page === totalPages}
            className="px-3 py-1.5 text-xs rounded bg-gray-800 text-gray-400
                       hover:bg-gray-700 hover:text-gray-200 disabled:opacity-30 disabled:cursor-not-allowed transition-colors">
            Next →
          </button>
        </div>
      )}
    </div>
  )
}
