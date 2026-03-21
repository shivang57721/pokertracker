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
export const fetchAvailableFilters = (player)         => get(`/stats/${player}/filters`)

// Returns { hands, total } — extract .hands for simple use cases
export const fetchHands = (player, params = {}) =>
  get(`/hands${qs({ player, ...params })}`)

