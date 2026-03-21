import { useEffect, useState, useCallback } from 'react'
import './index.css'

import FilterBar      from './components/FilterBar'
import SummaryBar     from './components/SummaryBar'
import ProfitChart    from './components/ProfitChart'
import StatsGrid      from './components/StatsGrid'
import HandBrowser    from './components/HandBrowser'
import SessionHistory from './components/SessionHistory'

import {
  fetchStats,
  fetchSessions,
  fetchProfitCurve,
  fetchAvailableFilters,
} from './lib/api'

const HERO = 'FlaminGalah12'

// is_tournament is NOT stored here — it's always derived from `mode`
const EMPTY_FILTERS = { from: '', to: '', game_type: '', stakes: '' }

const NAV_TABS = [
  { id: 'dashboard', label: 'Dashboard'    },
  { id: 'sessions',  label: 'Sessions'     },
  { id: 'browser',   label: 'Hand Browser' },
]

export default function App() {
  const [tab,  setTab]  = useState('dashboard')
  // 'cash' | 'tournament' — default cash since that's the primary game type
  const [mode, setMode] = useState('cash')

  // ── Dashboard filter state (no is_tournament — that comes from mode) ────────
  const [filters,          setFilters]          = useState(EMPTY_FILTERS)
  const [stats,            setStats]            = useState(null)
  const [sessions,         setSessions]         = useState(null)
  const [curve,            setCurve]            = useState([])
  const [availableFilters, setAvailableFilters] = useState(null)
  const [loading,          setLoading]          = useState(true)
  const [error,            setError]            = useState(null)

  // The full filter object injected into every API call
  const apiFilters = { ...filters, is_tournament: mode === 'cash' ? '0' : '1' }

  // ── When mode changes, clear the stakes filter (incompatible across modes) ──
  const handleModeChange = newMode => {
    setMode(newMode)
    setFilters(prev => ({ ...prev, stakes: '' }))
  }

  // ── Fetch available filter metadata once ───────────────────────────────────
  useEffect(() => {
    fetchAvailableFilters(HERO)
      .then(setAvailableFilters)
      .catch(err => console.warn('filters:', err.message))
  }, [])

  // ── Fetch stats + sessions + curve whenever mode or filters change ─────────
  const loadStats = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const [s, sess, pc] = await Promise.all([
        fetchStats(HERO, apiFilters),
        fetchSessions(HERO, apiFilters),
        fetchProfitCurve(HERO, apiFilters),
      ])
      setStats(s)
      setSessions(sess)
      setCurve(mode === 'tournament' ? (pc.tournament ?? []) : (pc.cash ?? []))
    } catch (err) {
      setError(err.message)
    } finally {
      setLoading(false)
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filters, mode])

  useEffect(() => { loadStats() }, [loadStats])

  return (
    <div className="min-h-screen bg-gray-950 text-gray-100">
      {/* ── Sticky header ──────────────────────────────────────────────────── */}
      <header className="sticky top-0 z-10 bg-gray-950/90 backdrop-blur border-b border-gray-800">
        <div className="max-w-screen-xl mx-auto px-4">

          {/* Row 1: logo + page nav */}
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

          {/* Row 2: mode toggle + filter bar — dashboard only */}
          {tab === 'dashboard' && (
            <div className="py-3 flex flex-wrap items-center gap-4">
              {/* ── Mode toggle ── */}
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

              {/* Vertical rule */}
              <div className="w-px h-6 bg-gray-700 shrink-0" />

              {/* ── Filter bar (mode-aware) ── */}
              <FilterBar
                filters={filters}
                onChange={setFilters}
                availableFilters={availableFilters}
                mode={mode}
              />
            </div>
          )}
        </div>
      </header>

      {/* ── Main content ───────────────────────────────────────────────────── */}
      <main className="max-w-screen-xl mx-auto px-4 py-6">
        {tab === 'dashboard' && (
          <div className="space-y-6">
            {error && (
              <div className="bg-red-900/30 border border-red-700 rounded-xl px-4 py-3 text-sm text-red-300">
                Failed to load stats: {error}
              </div>
            )}
            <SummaryBar stats={stats} sessions={sessions} loading={loading} mode={mode} />
            <StatsGrid   stats={stats} loading={loading} />
            <ProfitChart data={curve} loading={loading} mode={mode} />
          </div>
        )}

        {tab === 'sessions' && (
          <SessionHistory hero={HERO} />
        )}

        {tab === 'browser' && (
          <HandBrowser hero={HERO} />
        )}
      </main>
    </div>
  )
}
