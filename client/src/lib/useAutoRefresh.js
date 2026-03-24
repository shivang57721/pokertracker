import { useEffect, useRef } from 'react'
import { fetchHandCount } from './api'

/**
 * Polls /api/health every `intervalMs` milliseconds.
 * Calls `onNewHands` whenever the server hand count increases.
 * Stops polling when the component unmounts.
 */
export default function useAutoRefresh(onNewHands, intervalMs = 10_000) {
  const lastCountRef = useRef(null)
  const cbRef        = useRef(onNewHands)
  cbRef.current = onNewHands

  useEffect(() => {
    let cancelled = false

    const check = async () => {
      try {
        const count = await fetchHandCount()
        if (cancelled) return
        if (lastCountRef.current !== null && count > lastCountRef.current) {
          cbRef.current()
        }
        lastCountRef.current = count
      } catch {
        // network hiccup — silently skip this tick
      }
    }

    // Seed the baseline count immediately (don't trigger a refresh on mount)
    check()

    const id = setInterval(check, intervalMs)
    return () => { cancelled = true; clearInterval(id) }
  }, [intervalMs])
}
