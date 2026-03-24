export function fmtUSD(n, forceSign = false) {
  if (n == null) return '—'
  const abs = Math.abs(n).toFixed(2)
  if (n > 0)  return `+$${abs}`
  if (n < 0)  return `-$${abs}`
  return forceSign ? '±$0.00' : '$0.00'
}

// Convert dollar amount to BB display. showSign=true for results, false for sizes.
export function fmtBB(dollars, bigBlind, showSign = false) {
  if (dollars == null || !bigBlind) return '—'
  const bb      = dollars / bigBlind
  const rounded = Math.round(bb * 10) / 10
  const str     = Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1)
  const sign    = showSign && rounded > 0 ? '+' : ''
  return `${sign}${str}BB`
}

export function fmtPct(n) {
  return n == null ? '—' : `${n.toFixed(1)}%`
}

export function fmtNum(n, decimals = 2) {
  return n == null ? '—' : n.toFixed(decimals)
}

export function fmtInt(n) {
  return n == null ? '—' : n.toLocaleString()
}

// "2026-03-20 15:00:00" → "Mar 20"
export function fmtDateShort(str) {
  if (!str) return ''
  return new Date(str.replace(' ', 'T')).toLocaleDateString('en-GB', {
    day: 'numeric', month: 'short',
  })
}

// "2026-03-20 15:00:00" → "Mar 20, 15:00"
export function fmtDateTime(str) {
  if (!str) return ''
  const d = new Date(str.replace(' ', 'T'))
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }) +
    ' ' + d.toTimeString().slice(0, 5)
}

// Relative: "2h ago", "3d ago"
export function fmtRelative(str) {
  if (!str) return ''
  const diff = Date.now() - new Date(str.replace(' ', 'T')).getTime()
  const min = Math.floor(diff / 60_000)
  if (min < 1)   return 'just now'
  if (min < 60)  return `${min}m ago`
  const hr = Math.floor(min / 60)
  if (hr < 24)   return `${hr}h ago`
  const day = Math.floor(hr / 24)
  if (day < 7)   return `${day}d ago`
  return fmtDateShort(str)
}

// Duration: 90 → "1h 30m" | 25 → "25m"
export function fmtDuration(minutes) {
  if (!minutes) return '<1m'
  const h = Math.floor(minutes / 60)
  const m = minutes % 60
  return h > 0 ? `${h}h ${m}m` : `${m}m`
}

// Parse JSON array or return existing array
export function parseCards(value) {
  if (Array.isArray(value)) return value
  try { return JSON.parse(value || '[]') } catch { return [] }
}

// "0.01/0.02" → "$0.01/$0.02"
export function fmtStakes(stakes) {
  if (!stakes) return ''
  // Tournament level stakes don't need $
  if (stakes.startsWith('Level')) return stakes
  const parts = stakes.split('/')
  if (parts.length === 2) return `$${parts[0]}/$${parts[1]}`
  return stakes
}
