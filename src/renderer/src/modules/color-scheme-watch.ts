// Live light/dark observation for module renderers (RendererHost.watchColorScheme).
//
// A module that hosts a themed third-party widget — Monaco, a chart library —
// cannot read the app's theme from CSS: it has to hand its own runtime a
// concrete 'light' | 'dark'. The shell answers that question in exactly one
// place (useResolvedColorScheme: the persisted appearance preference, resolved
// through the OS media query while it is `system`), and this is that same
// answer published as a subscription instead of a hook, because module code is
// not always inside the app's React tree.
//
// Ports are injected so the contract is unit-testable; modules/index wires the
// real store + media query at boot.

import type { ColorScheme } from '../types/appTheme'

/** The resolved surface of the active theme. */
export type ModuleColorScheme = ColorScheme

export type ColorSchemeWatchPorts = {
  /** The scheme right now, resolved exactly as useResolvedColorScheme resolves it. */
  getScheme: () => ModuleColorScheme
  /**
   * Fires on anything that could change the answer — a theme preference write
   * or an OS light/dark switch. Over-firing is fine: the watcher dedupes.
   */
  subscribe: (cb: () => void) => () => void
}

export type ColorSchemeWatcher = (cb: (scheme: ModuleColorScheme) => void) => () => void

export function createColorSchemeWatcher(ports: ColorSchemeWatchPorts): ColorSchemeWatcher {
  return (cb) => {
    let last: ModuleColorScheme | null = null
    const emit = (): void => {
      const scheme = ports.getScheme()
      // Deduped: the OS media query fires while the preference is an explicit
      // theme, and that is not a change to the answer.
      if (scheme === last) return
      last = scheme
      try {
        cb(scheme)
      } catch (error) {
        // A throwing module callback must not break the emit loop for siblings.
        console.error('[modules] color scheme watch callback threw:', error)
      }
    }
    const unsubscribe = ports.subscribe(emit)
    // Fires once with the current value, then on change — the same contract
    // every other module watch surface keeps.
    emit()
    return unsubscribe
  }
}
