// 6-max NL Hold'em benchmark ranges.
// quality: 'good' | 'ok' | 'bad' | 'neutral'

export const STATS_META = {
  vpip: {
    label: 'VPIP',
    description: 'Voluntarily Put $ In Pot',
    unit: '',
    goodRange: '22–30%',
    quality(v) {
      if (v == null) return 'neutral'
      if (v >= 22 && v <= 30) return 'good'
      if (v >= 15 && v <= 38) return 'ok'
      return 'bad'
    },
  },
  pfr: {
    label: 'PFR',
    description: 'Pre-Flop Raise',
    unit: '',
    goodRange: '16–24%',
    quality(v) {
      if (v == null) return 'neutral'
      if (v >= 16 && v <= 24) return 'good'
      if (v >= 10 && v <= 30) return 'ok'
      return 'bad'
    },
  },
  three_bet: {
    label: '3-Bet',
    description: '3-Bet %',
    unit: '',
    goodRange: '5–10%',
    quality(v) {
      if (v == null) return 'neutral'
      if (v >= 5 && v <= 10) return 'good'
      if (v >= 3 && v <= 14) return 'ok'
      return 'bad'
    },
  },
  af: {
    label: 'Agg. Factor',
    description: '(Bets + Raises) / Calls',
    unit: '',
    goodRange: '1.5–3.5',
    quality(v) {
      if (v == null) return 'neutral'
      if (v >= 1.5 && v <= 3.5) return 'good'
      if (v >= 1.0 && v <= 5.0) return 'ok'
      return 'bad'
    },
  },
  wtsd: {
    label: 'WTSD',
    description: 'Went to Showdown',
    unit: '',
    goodRange: '24–32%',
    quality(v) {
      if (v == null) return 'neutral'
      if (v >= 24 && v <= 32) return 'good'
      if (v >= 18 && v <= 38) return 'ok'
      return 'bad'
    },
  },
  w_sd: {
    label: 'W$SD',
    description: 'Won $ at Showdown',
    unit: '',
    goodRange: '>52%',
    quality(v) {
      if (v == null) return 'neutral'
      if (v >= 52) return 'good'
      if (v >= 45) return 'ok'
      return 'bad'
    },
  },
  cbet: {
    label: 'C-Bet',
    description: 'Continuation Bet %',
    unit: '',
    goodRange: '45–70%',
    quality(v) {
      if (v == null) return 'neutral'
      if (v >= 45 && v <= 70) return 'good'
      if (v >= 30 && v <= 80) return 'ok'
      return 'bad'
    },
  },
}

// Full class-name strings (no partial construction — Tailwind needs complete names)
export const QUALITY_STYLE = {
  good:    { border: 'border-emerald-500/40', dot: 'bg-emerald-400', value: 'text-emerald-400', badge: 'bg-emerald-400/10 text-emerald-400 border border-emerald-400/30' },
  ok:      { border: 'border-yellow-500/40',  dot: 'bg-yellow-400',  value: 'text-yellow-400',  badge: 'bg-yellow-400/10 text-yellow-400 border border-yellow-400/30'   },
  bad:     { border: 'border-red-500/40',     dot: 'bg-red-400',     value: 'text-red-400',     badge: 'bg-red-400/10 text-red-400 border border-red-400/30'           },
  neutral: { border: 'border-gray-700',       dot: 'bg-gray-600',    value: 'text-gray-300',    badge: 'bg-gray-800 text-gray-400 border border-gray-700'              },
}
