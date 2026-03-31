import { useState, useEffect, useCallback } from 'react'
import HoleCards   from './HoleCards'
import HandReplay  from './HandReplay'
import { fetchHands, fetchAvailableFilters } from '../lib/api'
import useAutoRefresh from '../lib/useAutoRefresh'
import { fmtUSD, fmtBB, fmtDateTime, fmtStakes } from '../lib/format'
import useDisplayMode from '../lib/useDisplayMode'
import { PRESETS, getPresetDates } from '../lib/datePresets'

const PAGE_SIZE = 50

// ── Sort header ───────────────────────────────────────────────────────────────
function SortTh({ label, col, sortBy, sortDir, onSort, className = '' }) {
  const active = sortBy === col
  return (
    <th
      className={`py-2 px-3 font-medium cursor-pointer select-none whitespace-nowrap
        hover:text-gray-300 transition-colors ${active ? 'text-gray-200' : 'text-gray-600'} ${className}`}
      onClick={() => onSort(col)}
    >
      {label}
      <span className="ml-1 text-gray-600">
        {active ? (sortDir === 'asc' ? '↑' : '↓') : '↕'}
      </span>
    </th>
  )
}

// ── Net result badge ──────────────────────────────────────────────────────────
function fmtChips(n) {
  if (n == null) return '—'
  const rounded = Math.round(n)
  return (rounded > 0 ? '+' : '') + rounded.toLocaleString() + ' chips'
}

function NetBadge({ net, isTournament, bigBlind, isBB }) {
  if (net == null) return <span className="text-gray-600">—</span>
  const cls = net > 0 ? 'text-emerald-400' : net < 0 ? 'text-red-400' : 'text-gray-500'
  const label = isTournament ? fmtChips(net)
    : (isBB && bigBlind) ? fmtBB(net, bigBlind, true)
    : fmtUSD(net)
  return <span className={`tabular-nums font-semibold text-xs ${cls}`}>{label}</span>
}

// ── Position badge ────────────────────────────────────────────────────────────
function PosBadge({ pos }) {
  if (!pos) return <span className="text-gray-700">—</span>
  const abbr = pos === 'small blind' ? 'SB' : pos === 'big blind' ? 'BB' : pos === 'button' ? 'BTN' : pos.toUpperCase()
  const cls  = pos === 'button'      ? 'text-yellow-400' :
               pos === 'small blind' ? 'text-blue-400' :
               pos === 'big blind'   ? 'text-purple-400' : 'text-gray-400'
  return <span className={`text-xs font-mono font-semibold ${cls}`}>{abbr}</span>
}

// ── Main component ────────────────────────────────────────────────────────────
export default function HandBrowser({ hero }) {
  const [isBB, setIsBB] = useDisplayMode()

  // Top-level mode — mirrors dashboard toggle
  const [mode, setMode] = useState('cash')

  // Server-side filter/sort/page state
  const [datePreset, setDatePreset] = useState('all_time')
  const [from,     setFrom]     = useState('')
  const [to,       setTo]       = useState('')
  const [stakes,   setStakes]   = useState('')
  const [gameType, setGameType] = useState('')
  const [minNet,   setMinNet]   = useState('')
  const [maxNet,   setMaxNet]   = useState('')
  const [sortBy,   setSortBy]   = useState('date_played')
  const [sortDir,  setSortDir]  = useState('desc')
  const [page,     setPage]     = useState(1)

  // Data
  const [hands,            setHands]            = useState([])
  const [total,            setTotal]            = useState(0)
  const [loading,          setLoading]          = useState(true)
  const [availableFilters, setAvailableFilters] = useState(null)

  // Selected hand for replay
  const [replayId, setReplayId] = useState(null)

  // Fetch available filter options once
  useEffect(() => {
    fetchAvailableFilters(hero).then(setAvailableFilters).catch(() => {})
  }, [hero])

  // Fetch hands whenever server-side params change
  const load = useCallback(async () => {
    setLoading(true)
    try {
      const data = await fetchHands(hero, {
        limit:         PAGE_SIZE,
        offset:        (page - 1) * PAGE_SIZE,
        from:          from      || undefined,
        to:            to        || undefined,
        stakes:        stakes    || undefined,
        game_type:     gameType  || undefined,
        is_tournament: mode === 'cash' ? '0' : '1',
        sort_by:       sortBy,
        sort_dir:      sortDir,
        min_net:       minNet !== '' ? minNet : undefined,
        max_net:       maxNet !== '' ? maxNet : undefined,
      })
      setHands(data.hands)
      setTotal(data.total)
    } catch (e) {
      console.error('HandBrowser load error:', e)
    } finally {
      setLoading(false)
    }
  }, [hero, page, from, to, stakes, gameType, mode, sortBy, sortDir, minNet, maxNet])

  useEffect(() => { load() }, [load])
  useAutoRefresh(load)

  const resetPage = () => setPage(1)

  const handleSort = col => {
    if (col === 'net_profit') {
      // Cycle: net_profit desc → net_profit asc → abs_net_profit desc → abs_net_profit asc → repeat
      if (sortBy === 'net_profit' && sortDir === 'desc') { setSortDir('asc') }
      else if (sortBy === 'net_profit' && sortDir === 'asc') { setSortBy('abs_net_profit'); setSortDir('desc') }
      else if (sortBy === 'abs_net_profit' && sortDir === 'desc') { setSortDir('asc') }
      else if (sortBy === 'abs_net_profit' && sortDir === 'asc') { setSortBy('net_profit'); setSortDir('desc') }
      else { setSortBy('net_profit'); setSortDir('desc') }
    } else {
      if (col === sortBy) setSortDir(d => d === 'asc' ? 'desc' : 'asc')
      else { setSortBy(col); setSortDir('desc') }
    }
    resetPage()
  }

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE))
  const allStakes  = availableFilters?.stakes ?? []
  const stakesList = allStakes.filter(s => mode === 'cash' ? !s.is_tournament : s.is_tournament)
  const gameTypes  = availableFilters?.game_types ?? []

  const hasFilter = from || to || stakes || gameType || minNet !== '' || maxNet !== ''

  const handleModeChange = newMode => {
    setMode(newMode)
    setStakes('')
    setPage(1)
  }

  const handlePresetChange = id => {
    setDatePreset(id)
    if (id !== 'custom') {
      const { from: f, to: t } = getPresetDates(id)
      setFrom(f); setTo(t)
    }
    resetPage()
  }

  const resetAll = () => {
    setFrom(''); setTo(''); setStakes(''); setGameType('')
    setMinNet(''); setMaxNet(''); setPage(1); setDatePreset('all_time')
  }

  return (
    <div className="flex flex-col gap-4">
      {/* ── Mode toggle + filter bar ────────────────────────────────────────── */}
      <div className="bg-gray-900 border border-gray-800 rounded-xl p-4">
        <div className="flex flex-wrap items-center gap-2 text-sm">
          {/* Cash / Tournament toggle — matches dashboard style */}
          <div className="flex rounded-xl border border-gray-700 overflow-hidden shrink-0 shadow-md">
            <button
              onClick={() => handleModeChange('cash')}
              className={`flex items-center gap-2 px-5 py-2 text-sm font-semibold transition-colors
                ${mode === 'cash'
                  ? 'bg-emerald-600 text-white'
                  : 'bg-gray-800 text-gray-400 hover:text-gray-200'}`}
            >
              <span>💵</span> Cash
            </button>
            <button
              onClick={() => handleModeChange('tournament')}
              className={`flex items-center gap-2 px-5 py-2 text-sm font-semibold transition-colors
                ${mode === 'tournament'
                  ? 'bg-yellow-600 text-white'
                  : 'bg-gray-800 text-gray-400 hover:text-gray-200'}`}
            >
              <span>🏆</span> Tournament
            </button>
          </div>

          <div className="w-px h-6 bg-gray-700" />

          {/* BB / $ toggle — cash mode only */}
          {mode === 'cash' && (
            <div className="flex rounded-lg border border-gray-700 overflow-hidden text-xs shrink-0">
              <button onClick={() => setIsBB(true)}
                className={`px-2 py-1 font-medium transition-colors ${isBB ? 'bg-gray-700 text-gray-100' : 'bg-gray-900 text-gray-500 hover:text-gray-300'}`}>
                BB
              </button>
              <button onClick={() => setIsBB(false)}
                className={`px-2 py-1 font-medium transition-colors ${!isBB ? 'bg-gray-700 text-gray-100' : 'bg-gray-900 text-gray-500 hover:text-gray-300'}`}>
                $
              </button>
            </div>
          )}

          <div className="w-px h-6 bg-gray-700" />


          {/* Date preset chips */}
          <div className="flex items-center gap-1 flex-wrap">
            {PRESETS.map(p => (
              <button
                key={p.id}
                onClick={() => handlePresetChange(p.id)}
                className={`px-3 py-1 rounded-full text-xs font-medium transition-colors border
                  ${datePreset === p.id
                    ? 'bg-emerald-600 border-emerald-500 text-white'
                    : 'bg-gray-800 border-gray-700 text-gray-400 hover:text-gray-200 hover:border-gray-600'}`}
              >
                {p.label}
              </button>
            ))}
          </div>

          {/* Custom date pickers */}
          {datePreset === 'custom' && (
            <div className="flex items-center gap-1">
              <input type="date" value={from}
                onChange={e => { setFrom(e.target.value); setDatePreset('custom'); resetPage() }}
                className="[color-scheme:dark] bg-gray-800 border border-gray-700 rounded-lg px-2 py-1
                           text-gray-200 focus:outline-none focus:border-gray-500 focus:ring-1 focus:ring-gray-500 text-xs"
                style={{ width: '8.5rem' }} />
              <span className="text-gray-500 text-xs">–</span>
              <input type="date" value={to}
                onChange={e => { setTo(e.target.value); setDatePreset('custom'); resetPage() }}
                className="[color-scheme:dark] bg-gray-800 border border-gray-700 rounded-lg px-2 py-1
                           text-gray-200 focus:outline-none focus:border-gray-500 focus:ring-1 focus:ring-gray-500 text-xs"
                style={{ width: '8.5rem' }} />
            </div>
          )}

          <div className="w-px h-5 bg-gray-700" />

          {/* Stakes — cash only */}
          {mode === 'cash' && (
            <select value={stakes} onChange={e => { setStakes(e.target.value); resetPage() }}
              className="bg-gray-800 border border-gray-700 rounded-lg px-2 py-1.5 text-gray-200
                         focus:outline-none focus:border-gray-500 focus:ring-1 focus:ring-gray-500">
              <option value="">Stakes: All</option>
              {stakesList.map(s => <option key={s.stakes} value={s.stakes}>{fmtStakes(s.stakes)}</option>)}
            </select>
          )}

          {/* Game type */}
          <select value={gameType} onChange={e => { setGameType(e.target.value); resetPage() }}
            className="bg-gray-800 border border-gray-700 rounded-lg px-2 py-1.5 text-gray-200
                       focus:outline-none focus:border-gray-500 focus:ring-1 focus:ring-gray-500">
            <option value="">Game: All</option>
            {gameTypes.map(g => <option key={g} value={g}>{g}</option>)}
          </select>

          {/* Result range */}
          <div className="w-px h-5 bg-gray-700" />
          <div className="flex items-center gap-1.5 text-xs text-gray-500">
            <span>Result:</span>
            <input type="number" step={mode === 'tournament' ? '1' : '0.01'} value={minNet}
              placeholder={mode === 'tournament' ? 'min chips' : 'min $'}
              onChange={e => { setMinNet(e.target.value); resetPage() }}
              className="bg-gray-800 border border-gray-700 rounded px-2 py-1.5 text-gray-200 w-24
                         focus:outline-none focus:border-gray-500" />
            <span>to</span>
            <input type="number" step={mode === 'tournament' ? '1' : '0.01'} value={maxNet}
              placeholder={mode === 'tournament' ? 'max chips' : 'max $'}
              onChange={e => { setMaxNet(e.target.value); resetPage() }}
              className="bg-gray-800 border border-gray-700 rounded px-2 py-1.5 text-gray-200 w-24
                         focus:outline-none focus:border-gray-500" />
          </div>

          {hasFilter && (
            <button onClick={resetAll}
              className="text-gray-500 hover:text-gray-300 text-xs underline underline-offset-2 transition-colors ml-1">
              Reset filters
            </button>
          )}
        </div>
      </div>

      {/* ── Table ──────────────────────────────────────────────────────────── */}
      <div className="bg-gray-900 border border-gray-800 rounded-xl overflow-hidden">
        {/* Table header */}
        <div className="flex items-center justify-between px-4 py-2.5 border-b border-gray-800">
          <span className="text-xs text-gray-500">
            {loading ? 'Loading…' : `${total.toLocaleString()} hands`}
          </span>
          <span className="text-xs text-gray-700">Click a row to replay</span>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-sm min-w-[600px]">
            <thead>
              <tr className="text-left text-xs uppercase tracking-wider border-b border-gray-800">
                <SortTh label="Date"   col="date_played"     sortBy={sortBy} sortDir={sortDir} onSort={handleSort} className="pl-4" />
                <SortTh label="Stakes" col="stakes"          sortBy={sortBy} sortDir={sortDir} onSort={handleSort} />
                <SortTh label="Pos"    col="player_position" sortBy={sortBy} sortDir={sortDir} onSort={handleSort} />
                <th className="py-2 px-3 font-medium text-gray-600">Cards</th>
                <th className="py-2 px-3 font-medium text-gray-600">Board</th>
                <th
                  className={`py-2 px-3 pr-4 font-medium cursor-pointer select-none whitespace-nowrap
                    hover:text-gray-300 transition-colors
                    ${sortBy === 'net_profit' || sortBy === 'abs_net_profit' ? 'text-gray-200' : 'text-gray-600'}`}
                  onClick={() => handleSort('net_profit')}
                >
                  {sortBy === 'abs_net_profit' ? '|Result|' : 'Result'}
                  <span className="ml-1 text-gray-600">
                    {sortBy === 'net_profit' || sortBy === 'abs_net_profit'
                      ? (sortDir === 'asc' ? '↑' : '↓')
                      : '↕'}
                  </span>
                </th>
              </tr>
            </thead>
            <tbody>
              {loading && (
                Array.from({ length: 8 }).map((_, i) => (
                  <tr key={i} className="border-b border-gray-800/60">
                    {Array.from({ length: 6 }).map((_, j) => (
                      <td key={j} className="py-3 px-3">
                        <div className="h-3 rounded bg-gray-800 animate-pulse" style={{ width: `${50 + (i * j * 17) % 40}%` }} />
                      </td>
                    ))}
                  </tr>
                ))
              )}
              {!loading && hands.length === 0 && (
                <tr>
                  <td colSpan={6} className="py-12 text-center text-sm text-gray-600">
                    No hands match your filters
                  </td>
                </tr>
              )}
              {!loading && hands.map(hand => (
                <tr
                  key={hand.hand_id}
                  className="border-b border-gray-800/60 hover:bg-gray-800/40 transition-colors cursor-pointer"
                  onClick={() => setReplayId(hand.hand_id)}
                >
                  {/* Date */}
                  <td className="py-2.5 pl-4 pr-3 text-xs text-gray-500 whitespace-nowrap">
                    {fmtDateTime(hand.date_played)}
                  </td>

                  {/* Stakes */}
                  <td className="py-2.5 px-3 text-xs text-gray-300">
                    {fmtStakes(hand.stakes)}
                  </td>

                  {/* Position */}
                  <td className="py-2.5 px-3">
                    <PosBadge pos={hand.player_position} />
                  </td>

                  {/* Hole cards */}
                  <td className="py-2.5 px-3">
                    {hand.hole_cards?.length
                      ? <HoleCards cards={hand.hole_cards} />
                      : <span className="text-gray-700 text-xs font-mono">—</span>}
                  </td>

                  {/* Board */}
                  <td className="py-2.5 px-3">
                    {hand.board?.length
                      ? <HoleCards cards={hand.board} />
                      : <span className="text-gray-700 text-xs">—</span>}
                  </td>

                  {/* Result */}
                  <td className="py-2.5 px-3 pr-4">
                    <NetBadge net={hand.net_profit} isTournament={mode === 'tournament'} bigBlind={hand.big_blind} isBB={isBB} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {/* ── Pagination ───────────────────────────────────────────────────── */}
        {!loading && totalPages > 1 && (
          <div className="flex items-center justify-between px-4 py-3 border-t border-gray-800">
            <span className="text-xs text-gray-600">
              Page {page} of {totalPages} · {total.toLocaleString()} total
            </span>
            <div className="flex items-center gap-1">
              <button
                onClick={() => setPage(p => Math.max(1, p - 1))}
                disabled={page === 1}
                className="px-3 py-1.5 text-xs rounded bg-gray-800 text-gray-400
                           hover:bg-gray-700 hover:text-gray-200 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
              >
                ← Prev
              </button>

              {(() => {
                const pages = []
                const delta = 2
                const left  = Math.max(2, page - delta)
                const right = Math.min(totalPages - 1, page + delta)

                pages.push(1)
                if (left > 2) pages.push('…')
                for (let i = left; i <= right; i++) pages.push(i)
                if (right < totalPages - 1) pages.push('…')
                if (totalPages > 1) pages.push(totalPages)

                return pages.map((p, i) =>
                  p === '…' ? (
                    <span key={`e${i}`} className="px-1 text-gray-700 text-xs">…</span>
                  ) : (
                    <button
                      key={p}
                      onClick={() => setPage(p)}
                      className={`w-8 h-7 text-xs rounded transition-colors
                        ${p === page ? 'bg-emerald-600 text-white' : 'bg-gray-800 text-gray-400 hover:bg-gray-700 hover:text-gray-200'}`}
                    >
                      {p}
                    </button>
                  )
                )
              })()}

              <button
                onClick={() => setPage(p => Math.min(totalPages, p + 1))}
                disabled={page === totalPages}
                className="px-3 py-1.5 text-xs rounded bg-gray-800 text-gray-400
                           hover:bg-gray-700 hover:text-gray-200 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
              >
                Next →
              </button>
            </div>
          </div>
        )}
      </div>

      {/* ── Hand Replay Modal ───────────────────────────────────────────────── */}
      {replayId && (
        <HandReplay
          handId={replayId}
          hero={hero}
          onClose={() => setReplayId(null)}
        />
      )}
    </div>
  )
}
