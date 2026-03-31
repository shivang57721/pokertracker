import { useEffect, useState, useCallback } from 'react'
import './index.css'

import FilterBar         from './components/FilterBar'
import SummaryBar        from './components/SummaryBar'
import ProfitChart       from './components/ProfitChart'
import StatsGrid         from './components/StatsGrid'
import HandBrowser       from './components/HandBrowser'
import SessionHistory    from './components/SessionHistory'
import HandReview        from './components/HandReview'
import WinRateByPosition from './components/WinRateByPosition'
import BiggestHands      from './components/BiggestHands'

import {
  fetchStats,
  fetchSessions,
  fetchProfitCurve,
  fetchAvailableFilters,
  fetchFlags,
  fetchPositionStats,
  fetchHands,
} from './lib/api'
import useAutoRefresh from './lib/useAutoRefresh'

const HERO = 'FlaminGalah12'

const EMPTY_FILTERS = { from: '', to: '', game_type: '', stakes: '', position: '' }

const NAV_TABS = [
  { id: 'dashboard', label: 'Dashboard'    },
  { id: 'sessions',  label: 'Sessions'     },
  { id: 'browser',   label: 'Hand Browser' },
  { id: 'review',    label: 'Hand Review'  },
]

// ── Date preset helpers ────────────────────────────────────────────────────
const fmtLocal = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`

function getPresetDates(preset) {
  const fmt   = fmtLocal
  const fmtTo = d => fmt(d) + ' 23:59:59'
  const today = new Date()
  switch (preset) {
    case 'today': {
      const d = new Date(); d.setHours(0, 0, 0, 0)
      return { from: fmt(d), to: fmtTo(today) }
    }
    case 'yesterday': {
      const d = new Date(); d.setDate(d.getDate() - 1)
      return { from: fmt(d), to: fmtTo(d) }
    }
    case 'last_7': {
      const d = new Date(); d.setDate(d.getDate() - 6)
      return { from: fmt(d), to: fmtTo(today) }
    }
    case 'last_30': {
      const d = new Date(); d.setDate(d.getDate() - 29)
      return { from: fmt(d), to: fmtTo(today) }
    }
    case 'this_month': {
      const d = new Date(); d.setDate(1)
      return { from: fmt(d), to: fmtTo(today) }
    }
    default:
      return { from: '', to: '' }
  }
}

function getPrevPeriodDates(preset) {
  const fmt   = fmtLocal
  const fmtTo = d => fmt(d) + ' 23:59:59'
  switch (preset) {
    case 'today': {
      const d = new Date(); d.setDate(d.getDate() - 1)
      return { from: fmt(d), to: fmtTo(d) }
    }
    case 'yesterday': {
      const d = new Date(); d.setDate(d.getDate() - 2)
      return { from: fmt(d), to: fmtTo(d) }
    }
    case 'last_7': {
      const from = new Date(); from.setDate(from.getDate() - 13)
      const to   = new Date(); to.setDate(to.getDate() - 7)
      return { from: fmt(from), to: fmtTo(to) }
    }
    case 'last_30': {
      const from = new Date(); from.setDate(from.getDate() - 59)
      const to   = new Date(); to.setDate(to.getDate() - 30)
      return { from: fmt(from), to: fmtTo(to) }
    }
    case 'this_month': {
      const now            = new Date()
      const firstThisMonth = new Date(now.getFullYear(), now.getMonth(), 1)
      const lastPrevMonth  = new Date(firstThisMonth - 1)
      const firstPrevMonth = new Date(lastPrevMonth.getFullYear(), lastPrevMonth.getMonth(), 1)
      return { from: fmt(firstPrevMonth), to: fmtTo(lastPrevMonth) }
    }
    default:
      return null
  }
}

export default function App() {
  const [tab,  setTab]  = useState('dashboard')
  const [mode, setMode] = useState('cash')

  const [filters,          setFilters]        = useState(EMPTY_FILTERS)
  const [datePreset,       setDatePreset]     = useState('all_time')
  const [stats,            setStats]          = useState(null)
  const [prevStats,        setPrevStats]      = useState(null)
  const [sessions,         setSessions]       = useState(null)
  const [curve,            setCurve]          = useState([])
  const [positionStats,    setPositionStats]  = useState([])
  const [biggestWinners,   setBiggestWinners] = useState([])
  const [biggestLosers,    setBiggestLosers]  = useState([])
  const [availableFilters, setAvailableFilters] = useState(null)
  const [loading,          setLoading]        = useState(true)
  const [error,            setError]          = useState(null)
  const [flaggedHands,     setFlaggedHands]   = useState(null)

  const apiFilters = { ...filters, is_tournament: mode === 'cash' ? '0' : '1' }

  const CASH_ONLY_POSITIONS = new Set(['lj', 'mp', 'utg+1'])
  const handleModeChange = newMode => {
    setMode(newMode)
    setFilters(prev => ({
      ...prev,
      stakes: '',
      position: newMode === 'cash' && CASH_ONLY_POSITIONS.has(prev.position) ? '' : prev.position,
    }))
  }

  const handlePresetChange = useCallback(preset => {
    setDatePreset(preset)
    if (preset !== 'custom') {
      const { from, to } = getPresetDates(preset)
      setFilters(prev => ({ ...prev, from, to }))
    }
  }, [])

  useEffect(() => {
    fetchAvailableFilters(HERO)
      .then(setAvailableFilters)
      .catch(err => console.warn('filters:', err.message))
    fetchFlags({ limit: 0 })
      .then(d => setFlaggedHands(d.flagged_hands ?? 0))
      .catch(err => console.warn('flags:', err.message))
  }, [])

  const loadStats = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const cashFilters = { ...filters, is_tournament: '0' }
      const prevDates   = getPrevPeriodDates(datePreset)

      const [s, sess, pc, pos, winners, losers] = await Promise.all([
        fetchStats(HERO, apiFilters),
        fetchSessions(HERO, apiFilters),
        fetchProfitCurve(HERO, apiFilters),
        mode === 'cash' ? fetchPositionStats(HERO, cashFilters) : Promise.resolve([]),
        fetchHands(HERO, { ...cashFilters, sort_by: 'net_profit', sort_dir: 'desc', limit: 5 }),
        fetchHands(HERO, { ...cashFilters, sort_by: 'net_profit', sort_dir: 'asc',  limit: 5 }),
      ])

      setStats(s)
      setSessions(sess)
      setCurve(mode === 'tournament' ? (pc.tournament ?? []) : (pc.cash ?? []))
      setPositionStats(pos)
      setBiggestWinners(winners.hands ?? [])
      setBiggestLosers(losers.hands ?? [])

      if (prevDates) {
        const prevFilters = { ...apiFilters, from: prevDates.from, to: prevDates.to }
        fetchStats(HERO, prevFilters)
          .then(setPrevStats)
          .catch(() => setPrevStats(null))
      } else {
        setPrevStats(null)
      }
    } catch (err) {
      setError(err.message)
    } finally {
      setLoading(false)
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filters, mode])

  useEffect(() => { loadStats() }, [loadStats])

  // Auto-refresh dashboard + sessions when new hands are imported
  useAutoRefresh(loadStats)

  return (
    <div className="min-h-screen bg-gray-950 text-gray-100">
      <header className="sticky top-0 z-10 bg-gray-950/90 backdrop-blur border-b border-gray-800">
        <div className="max-w-screen-xl mx-auto px-4">

          <div className="flex items-center gap-6 pt-3 pb-0">
            <div className="flex items-center gap-2 shrink-0">
              <span className="text-lg">♠</span>
              <span className="font-bold text-gray-100 text-sm tracking-tight">PokerTracker</span>
              <span className="text-xs text-gray-600 font-mono">{HERO}</span>
            </div>

            <nav className="flex gap-0">
              {NAV_TABS.map(t => (
                <button
                  key={t.id}
                  onClick={() => setTab(t.id)}
                  className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors
                    ${tab === t.id
                      ? 'border-emerald-500 text-emerald-300'
                      : 'border-transparent text-gray-500 hover:text-gray-300'}`}
                >
                  {t.label}
                </button>
              ))}
            </nav>
          </div>

          {tab === 'dashboard' && (
            <div className="py-3 flex flex-wrap items-center gap-4">
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

              <div className="w-px h-6 bg-gray-700 shrink-0" />

              <FilterBar
                filters={filters}
                onChange={setFilters}
                availableFilters={availableFilters}
                mode={mode}
                datePreset={datePreset}
                onPresetChange={handlePresetChange}
              />
            </div>
          )}
        </div>
      </header>

      <main className="max-w-screen-xl mx-auto px-4 py-6">
        {tab === 'dashboard' && (
          <div className="space-y-6">
            {error && (
              <div className="bg-red-900/30 border border-red-700 rounded-xl px-4 py-3 text-sm text-red-300">
                Failed to load stats: {error}
              </div>
            )}
            <SummaryBar stats={stats} sessions={sessions} loading={loading} mode={mode} flaggedHands={flaggedHands} />
            <StatsGrid   stats={stats} prevStats={prevStats} loading={loading} />
            <ProfitChart data={curve} loading={loading} mode={mode} />
            {mode === 'cash' && (
              <WinRateByPosition data={positionStats} loading={loading} />
            )}
            <BiggestHands winners={biggestWinners} losers={biggestLosers} loading={loading} mode={mode} />
          </div>
        )}

        {tab === 'sessions' && <SessionHistory hero={HERO} />}
        {tab === 'browser'  && <HandBrowser hero={HERO} />}
        {tab === 'review'   && <HandReview hero={HERO} />}
      </main>
    </div>
  )
}
