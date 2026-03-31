export const PRESETS = [
  { id: 'all_time', label: 'All Time'     },
  { id: 'today',    label: 'Today'        },
  { id: 'last_7',   label: 'Last 7 Days'  },
  { id: 'last_30',  label: 'Last 30 Days' },
  { id: 'custom',   label: 'Custom'       },
]

export function getPresetDates(preset) {
  const fmt   = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  const fmtTo = d => fmt(d) + ' 23:59:59'
  const today = new Date()
  switch (preset) {
    case 'today': {
      const d = new Date(); d.setHours(0, 0, 0, 0)
      return { from: fmt(d), to: fmtTo(today) }
    }
    case 'last_7': {
      const d = new Date(); d.setDate(d.getDate() - 6)
      return { from: fmt(d), to: fmtTo(today) }
    }
    case 'last_30': {
      const d = new Date(); d.setDate(d.getDate() - 29)
      return { from: fmt(d), to: fmtTo(today) }
    }
    default:
      return { from: '', to: '' }
  }
}
