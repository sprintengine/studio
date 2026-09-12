/**
 * Pushes `appSettings.telemetryEnabled` to main.
 *
 * Main is the only process that sends product telemetry, and it records events
 * that happen with no window open — a scheduled sprint finishing, the boot
 * event itself — so the user's choice cannot live only in this window's
 * localStorage. Same one-way contract as the background-mode and appearance
 * mirrors: the renderer owns the value, main keeps a persisted copy, and there
 * is no read path back.
 *
 * Mounted once from `WorkspaceManager`, next to the background-mode sync. The
 * first push runs on mount so main converges even when this window's stored
 * value came from another window or from an import.
 */
import { useWorkspaceStore } from '../store/workspaceStore'

export function initTelemetryConsentSync(): () => void {
  const api = typeof window !== 'undefined' ? window.api : undefined
  if (!api?.setTelemetryEnabled) return () => undefined

  // `null` rather than `true`: the mount push must reach main even when the
  // setting is at its default, or a profile that opted out in another window
  // would leave main holding the stale `true` and sending on its behalf.
  let lastPushed: boolean | null = null
  const push = (): void => {
    const enabled = useWorkspaceStore.getState().appSettings.telemetryEnabled !== false
    if (enabled === lastPushed) return
    lastPushed = enabled
    void api.setTelemetryEnabled(enabled).catch(() => {
      // Retry on the next settings change; main also persists the last good
      // push, so a transient IPC failure only delays convergence.
      lastPushed = null
    })
  }

  push()
  return useWorkspaceStore.subscribe(push)
}
