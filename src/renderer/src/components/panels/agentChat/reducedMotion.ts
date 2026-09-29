// Whether the person asked for less motion, read from one media query per
// window rather than a new one on every render and every scroll: the list's
// end-follow asks on each render of the chat.
const queries = new WeakMap<object, MediaQueryList | null>()

export function prefersReducedMotion(): boolean {
  if (typeof window === 'undefined') return false
  let query = queries.get(window)
  if (query === undefined) {
    query = typeof window.matchMedia === 'function' ? window.matchMedia('(prefers-reduced-motion: reduce)') : null
    queries.set(window, query)
  }
  return query?.matches ?? false
}
