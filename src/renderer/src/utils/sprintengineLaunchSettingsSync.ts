/**
 * Mirrors the renderer's agent-launch settings to the main process
 * (sprint-runtime-ownership Phase 2): the main sprint scheduler spawns agents
 * with the same cliRuntimes / MCP / knowledge-root inputs the renderer
 * supervisor used, but those live in renderer `appSettings`. Mounted
 * once from `WorkspaceManager`; pushes on mount and whenever the relevant
 * settings actually change (signature-compared, debounced a tick by the
 * store's own batching).
 */
import type { SprintEngineLaunchSettings } from '../../../shared/sprintengine/launch-settings'
import { useWorkspaceStore } from '../store/workspaceStore'

function currentLaunchSettings(): SprintEngineLaunchSettings {
  const { appSettings } = useWorkspaceStore.getState()
  return {
    cliRuntimes: appSettings.cliRuntimes ?? {},
    mcp: appSettings.mcp ?? { syncEnabled: false, servers: {} },
    projectKnowledgeRoots: appSettings.projectKnowledgeRoots ?? {},
  }
}

export function initSprintEngineLaunchSettingsSync(): () => void {
  const api = typeof window !== 'undefined' ? window.api : undefined
  if (!api?.syncSprintEngineLaunchSettings) return () => undefined

  let lastSignature = ''
  const push = (): void => {
    const settings = currentLaunchSettings()
    const signature = JSON.stringify(settings)
    if (signature === lastSignature) return
    lastSignature = signature
    void api.syncSprintEngineLaunchSettings(settings).catch(() => {
      // Retry on the next settings change; main also persists the last good
      // push, so a transient IPC failure only delays convergence.
      lastSignature = ''
    })
  }

  push()
  const unsubscribe = useWorkspaceStore.subscribe(push)
  return unsubscribe
}
