/**
 * Background mode (MC-2156): what happens when the last window closes, and the
 * tray presence that stands in for it.
 *
 * Closing a window becomes a pure presentation event — main services (Studio
 * gateway, `SprintRuntime`, the automations engine, the mobile bridge) are
 * never consulted here and never touched, which is what makes "close the
 * window at night, sprints keep running" true. The power-save blocker is
 * likewise untouched: it is refcounted off active runs in
 * `sprint-power-manager.ts`, and a window closing is not a run going idle.
 *
 * Electron is injected rather than imported so the last-window-close decision —
 * the one behavior an unattended machine depends on — is testable with no
 * window and no display. The real Tray/Menu wiring lives in
 * `background-tray-electron.ts`.
 */
import {
  buildBackgroundTrayItems,
  describeBackgroundTooltip,
  type BackgroundStatus,
  type BackgroundTrayItem,
} from '../shared/background-mode'

/** The slice of Electron's `Tray` this presence uses. */
export type BackgroundTrayHandle = {
  setToolTip(text: string): void
  setContextMenu(menu: unknown): void
  on(event: 'click' | 'right-click', listener: () => void): void
  destroy(): void
}

export type BackgroundTrayActions = {
  open(): void
  quit(): void
}

export type BackgroundPresenceDeps = {
  platform: string
  /** Read at close time, not captured: the user can flip the setting mid-session. */
  isBackgroundModeEnabled: () => boolean
  readStatus: () => BackgroundStatus
  /** Null when no tray could be created (no display, unsupported desktop). */
  createTray: () => BackgroundTrayHandle | null
  buildMenu: (items: readonly BackgroundTrayItem[], actions: BackgroundTrayActions) => unknown
  actions: BackgroundTrayActions
  logDiagnostic?: (input: {
    level: 'info' | 'warning'
    title: string
    message: string
  }) => void
  timers?: {
    setInterval(handler: () => void, ms: number): unknown
    clearInterval(handle: unknown): void
  }
}

/**
 * Menu-rebuild cadence while the tray is up. Tray click events refresh it on
 * macOS/Windows, but a Linux AppIndicator opens the menu without telling us, so
 * a slow tick is the only thing that keeps those counters from going stale. The
 * app is windowless when this runs, so the cost is a menu rebuild every ten
 * seconds against in-memory state.
 */
const TRAY_REFRESH_MS = 10_000

export function createBackgroundPresence(deps: BackgroundPresenceDeps) {
  const timers = deps.timers ?? {
    setInterval: (handler: () => void, ms: number) => setInterval(handler, ms),
    clearInterval: (handle: unknown) => clearInterval(handle as ReturnType<typeof setInterval>),
  }
  let tray: BackgroundTrayHandle | null = null
  let refreshHandle: unknown = null
  let quitting = false
  // One warning per failure run, not one every ten seconds.
  let renderFailureReported = false

  function render(): void {
    if (!tray) return
    // This runs on a timer in a windowless process: an exception escaping here
    // would be an unhandled throw in main, killing the very sprint runs the
    // background mode exists to keep alive. The menu is left at its last good
    // content and the failure is reported — never papered over with invented
    // counters.
    try {
      const status = deps.readStatus()
      tray.setToolTip(describeBackgroundTooltip(status))
      tray.setContextMenu(deps.buildMenu(buildBackgroundTrayItems(status), deps.actions))
      renderFailureReported = false
    } catch (error) {
      if (renderFailureReported) return
      renderFailureReported = true
      deps.logDiagnostic?.({
        level: 'warning',
        title: 'Background tray status unavailable',
        message: `The tray could not read what is running: ${error instanceof Error ? error.message : String(error)}`,
      })
    }
  }

  function showTray(): void {
    if (tray) {
      render()
      return
    }
    const created = deps.createTray()
    if (!created) {
      // Staying alive without the affordance is still the lesser evil: the user
      // asked for background mode, and quitting would kill live sprint runs.
      // The diagnostic is the only honest record that the presence is missing.
      deps.logDiagnostic?.({
        level: 'warning',
        title: 'Background tray unavailable',
        message:
          'Multicode is running in the background but could not create a tray icon; reopen it from the app or the dock.',
      })
      return
    }
    tray = created
    // macOS/Windows deliver these before the menu opens, so the counters a user
    // is about to read are rebuilt from live state rather than from the tick.
    created.on('click', render)
    created.on('right-click', render)
    render()
    refreshHandle = timers.setInterval(render, TRAY_REFRESH_MS)
  }

  function hideTray(): void {
    if (refreshHandle !== null) {
      timers.clearInterval(refreshHandle)
      refreshHandle = null
    }
    if (!tray) return
    tray.destroy()
    tray = null
  }

  return {
    /**
     * The last-window-close decision. `'stay'` leaves the process (and every
     * main service with it) running; `'quit'` is today's behavior.
     */
    onWindowAllClosed(): 'quit' | 'stay' {
      if (quitting) return 'stay'
      if (!deps.isBackgroundModeEnabled()) {
        // Byte-for-byte the pre-MC-2156 rule: quit everywhere but macOS, where
        // the process has always outlived its windows.
        return deps.platform === 'darwin' ? 'stay' : 'quit'
      }
      showTray()
      deps.logDiagnostic?.({
        level: 'info',
        title: 'Running in the background',
        message: 'The last window closed; sprint runs, the scheduler and the Studio gateway keep running.',
      })
      return 'stay'
    },

    /** A window is on screen again: the tray is a stand-in for one, so it goes. */
    onWindowOpened(): void {
      hideTray()
    },

    /** Quit disposes the tray before the graceful shutdown path runs. */
    onBeforeQuit(): void {
      quitting = true
      hideTray()
    },

    isTrayVisible(): boolean {
      return tray !== null
    },
  }
}
