/**
 * Pushes every module's app-level state (`appSettings.moduleSettings`, the
 * `module:<id>` namespaces a Settings section writes) to main.
 *
 * A module's `entry.main` reads its settings there (`MainHost.getModuleAppState`)
 * with no window to ask — a scheduler's run time, a poller's interval — so
 * main keeps a persisted copy. Same one-way contract as the text-generation
 * and background-mode mirrors: the renderer owns the values, main keeps the
 * copy, and there is no read path back.
 *
 * Mounted once from `WorkspaceManager`. The first push runs on mount so main
 * converges even when this window's values came from another window or an
 * import; after that only a change that moved the bag is sent.
 */
import { useWorkspaceStore } from '../store/workspaceStore'

export function initModuleAppStateSync(): () => void {
  const api = typeof window !== 'undefined' ? window.api : undefined
  if (!api?.setModuleAppState) return () => undefined

  let lastPushed: string | null = null
  let lastBag: unknown = null
  const push = (): void => {
    const bag = useWorkspaceStore.getState().appSettings.moduleSettings
    // Identity first: most store writes leave the bag untouched.
    if (bag === lastBag && lastPushed !== null) return
    lastBag = bag
    const key = JSON.stringify(bag ?? {})
    if (key === lastPushed) return
    lastPushed = key
    void api.setModuleAppState(bag ?? {}).catch(() => {
      // Retry on the next change; main keeps the last good push meanwhile.
      lastPushed = null
    })
  }

  push()
  return useWorkspaceStore.subscribe(push)
}
