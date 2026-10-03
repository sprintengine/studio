import { onWindowVisibilityChange } from '../utils/windowActivity'

// When a web tab tries its sockets again at once rather than waiting out a
// backoff (phase 9 spec, 3.5): the browser is back online, the tab is visible
// again, or it was restored from the back/forward cache (whose sockets were
// closed while it sat there). Mobile browsers suspend background tabs'
// sockets, so these are how a phone's tab comes back.

/** The private close code the server ends a removed browser's sockets with. */
export const WEB_CLOSE_REVOKED = 4401

export function watchWebReconnectTriggers(wake: () => void): () => void {
  const stopVisibility = onWindowVisibilityChange((visible) => {
    if (visible) wake()
  })
  const onPageShow = (event: PageTransitionEvent) => {
    if (event.persisted) wake()
  }
  window.addEventListener('online', wake)
  window.addEventListener('pageshow', onPageShow)
  return () => {
    stopVisibility()
    window.removeEventListener('online', wake)
    window.removeEventListener('pageshow', onPageShow)
  }
}
