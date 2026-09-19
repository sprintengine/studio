/**
 * Pushes `appSettings.keepRunningInBackground` to main.
 *
 * Main reads this setting inside `window-all-closed` — the one moment there is
 * no renderer left to ask — so it cannot live only in localStorage. Same
 * one-way contract as the appearance mirrors: the renderer owns the value, main
 * keeps a persisted copy, and there is no read path back.
 *
 * Mounted once from `WorkspaceManager`, next to the launch-settings sync. The
 * first push runs on mount so main converges even when this window's stored
 * value came from another window or from an import.
 */
import { useWorkspaceStore } from '../store/workspaceStore'

export function initBackgroundModeSync(): () => void {
  const api = typeof window !== 'undefined' ? window.api : undefined
  if (!api?.setBackgroundMode) return () => undefined

  // `null` rather than `false`: the mount push must reach main even when the
  // setting is off, or a profile that turned it off in another window would
  // leave main holding the stale `true`.
  let lastPushed: boolean | null = null
  const push = (): void => {
    const enabled = useWorkspaceStore.getState().appSettings.keepRunningInBackground === true
    if (enabled === lastPushed) return
    lastPushed = enabled
    void api.setBackgroundMode(enabled).catch(() => {
      // Retry on the next settings change; main also persists the last good
      // push, so a transient IPC failure only delays convergence.
      lastPushed = null
    })
  }

  push()
  return useWorkspaceStore.subscribe(push)
}
