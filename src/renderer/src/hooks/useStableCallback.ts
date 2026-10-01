import { useCallback, useLayoutEffect, useRef } from 'react'

/**
 * A function whose identity never changes and which always runs the latest
 * `callback` passed in.
 *
 * For handlers handed to a memoized child: the child re-renders only when
 * what it shows changes, not every time the parent rebuilds a closure over
 * state the handler reads when it is called. Not for anything called during
 * render, which would read the previous render's closure.
 */
export function useStableCallback<Args extends unknown[], Result>(
  callback: (...args: Args) => Result,
): (...args: Args) => Result {
  const latest = useRef(callback)
  useLayoutEffect(() => {
    latest.current = callback
  })
  return useCallback((...args: Args) => latest.current(...args), [])
}
