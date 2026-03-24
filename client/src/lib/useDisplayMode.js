import { useState } from 'react'

const KEY = 'hand_display_mode'

// Returns [isBB, setIsBB] — persisted in localStorage.
// Default is BB (true). All pages share the same key so changes persist across tabs.
export default function useDisplayMode() {
  const [isBB, setIsBBState] = useState(() => localStorage.getItem(KEY) !== 'usd')

  const setIsBB = (val) => {
    localStorage.setItem(KEY, val ? 'bb' : 'usd')
    setIsBBState(val)
  }

  return [isBB, setIsBB]
}
