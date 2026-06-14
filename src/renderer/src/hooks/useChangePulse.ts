import { useEffect, useRef, useState } from 'react'

export type ChangePulseOptions = {
  /**
   * `change` pulses on any movement of the value; `increase` pulses only when
   * the value grows (e.g. a notification arriving, a session spawning) and stays
   * quiet when it shrinks. Defaults to `change`.
   */
  mode?: 'increase' | 'change'
  /**
   * When this key changes the baseline resets silently — the next render adopts
   * the new value without emitting a pulse. Use it to suppress the pulse when the
   * underlying subject swaps rather than updates (e.g. switching the active git
   * repo should not flash the change-count badge).
   */
  resetKey?: string | number | null
}

/**
 * Returns a token that increments each time `value` changes in the watched
 * direction. The first render never pulses (the baseline is seeded from the
 * initial value), so this fires only on genuine subsequent updates. Render the
 * token as a React `key` on the element you want to re-animate; the key change
 * remounts that element and restarts its one-shot CSS animation.
 */
export function useChangePulse(value: number, options: ChangePulseOptions = {}): number {
  const { mode = 'change', resetKey = null } = options
  const prevValue = useRef(value)
  const prevResetKey = useRef(resetKey)
  const [token, setToken] = useState(0)

  useEffect(() => {
    if (prevResetKey.current !== resetKey) {
      // Subject swapped: adopt the new value as the baseline without pulsing.
      prevResetKey.current = resetKey
      prevValue.current = value
      return
    }
    const previous = prevValue.current
    if (value === previous) return
    prevValue.current = value
    if (mode === 'increase' && value <= previous) return
    setToken((current) => current + 1)
  }, [value, mode, resetKey])

  return token
}
