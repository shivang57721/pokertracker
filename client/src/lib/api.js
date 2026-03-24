const BASE = '/api'

async function get(path) {
  const res = await fetch(BASE + path)
  if (!res.ok) throw new Error(`${path} → ${res.status}`)
  return res.json()
}

function qs(params) {
  const p = new URLSearchParams()
  for (const [k, v] of Object.entries(params))
    if (v !== '' && v != null) p.set(k, v)
  const s = p.toString()
  return s ? '?' + s : ''
}

export const fetchStats            = (player, f = {}) => get(`/stats/${player}${qs(f)}`)
export const fetchSessions         = (player, f = {}) => get(`/stats/${player}/sessions${qs(f)}`)
export const fetchProfitCurve      = (player, f = {}) => get(`/stats/${player}/profit-curve${qs(f)}`)
export const fetchPositionStats    = (player, f = {}) => get(`/stats/${player}/positions${qs(f)}`)
export const fetchAvailableFilters = (player)         => get(`/stats/${player}/filters`)

// Returns { hands, total } — extract .hands for simple use cases
export const fetchHands = (player, params = {}) =>
  get(`/hands${qs({ player, ...params })}`)

// Returns { flags, total_flags, flagged_hands }
export const fetchFlags = (params = {}) => get(`/flags${qs(params)}`)

// Trigger analysis of all unprocessed cash hands
export const triggerAnalyze = () =>
  fetch('/api/analyze', { method: 'POST' }).then(r => r.json())

// Returns existing AI analysis row or null
export const fetchAiAnalysis = (handId) => get(`/ai-analysis/${handId}`)

// Run AI analysis (force=true to re-analyze)
export const runAiAnalysis = (handId, force = false) =>
  fetch(`/api/ai-analysis/${handId}`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ force }),
  }).then(async r => {
    const data = await r.json()
    if (!r.ok) throw new Error(data.error || `${r.status}`)
    return data
  })

// Hand Review
export const fetchHandCount = () =>
  get('/health').then(d => d.hand_count ?? 0)

export const fetchReviewSummary = ()           => get('/review/summary')
export const fetchReviewHands   = (params = {}) => get(`/review${qs(params)}`)
export const markReviewed   = (handId) =>
  fetch(`/api/review/${handId}/reviewed`, { method: 'POST'   }).then(r => r.json())
export const markUnreviewed = (handId) =>
  fetch(`/api/review/${handId}/reviewed`, { method: 'DELETE' }).then(r => r.json())

