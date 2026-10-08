/**
 * Pushes `appSettings.textGeneration` to main.
 *
 * A chat is titled by the process that runs it, from the chat's own events,
 * so a chat a phone starts while no window is open or in front still gets a
 * model-written title (`main/text-generation/chat-titler.ts`). That process
 * cannot ask a window for the setting, so it keeps a copy. Same one-way
 * contract as the background-mode and usage-data mirrors: the renderer owns
 * the value, main keeps a persisted copy, and there is no read path back.
 *
 * Mounted once from `WorkspaceManager`, next to the background-mode sync. The
 * first push runs on mount so main converges even when this window's stored
 * value came from another window or from an import.
 */
import { useWorkspaceStore } from '../store/workspaceStore'

export function initTextGenerationSettingsSync(): () => void {
  const api = typeof window !== 'undefined' ? window.api : undefined
  if (!api?.setTextGenerationSettings) return () => undefined

  // Compared by value: the setting is an object, and the store hands out a new
  // one whenever anything in it is written. `null` so the mount push always
  // goes, even at the default, or a profile switched off in another window
  // would leave main holding the stale value.
  let lastPushed: string | null = null
  const push = (): void => {
    const settings = useWorkspaceStore.getState().appSettings.textGeneration
    const key = JSON.stringify(settings)
    if (key === lastPushed) return
    lastPushed = key
    void api.setTextGenerationSettings(settings).catch(() => {
      // Retry on the next settings change; main also persists the last good
      // push, so a transient IPC failure only delays convergence.
      lastPushed = null
    })
  }

  push()
  return useWorkspaceStore.subscribe(push)
}
