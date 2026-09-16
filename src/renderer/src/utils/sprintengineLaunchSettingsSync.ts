/**
 * Pushes the renderer-authored agent-launch settings to main's store
 * (MC-2154). Main needs every input a launch is composed from — CLI runtimes,
 * MCP settings, knowledge roots, the last-selected CLI, the spawn permission
 * preset, and the saved rosters — but they are authored in `appSettings`
 * (localStorage), so with no window open main would otherwise have to guess.
 *
 * Mounted once from `WorkspaceManager`. The first mount hydrates main's store
 * (a no-op once main holds a record, so a window can never re-assert over
 * main's own value); after that it pushes whenever the relevant settings
 * actually change, signature-compared so the store's per-change subscription
 * does not churn the file.
 */
import type { SprintEngineLaunchSettings } from '../../../shared/sprintengine/launch-settings'
import { useWorkspaceStore } from '../store/workspaceStore'
import { isSprintEngineIpcBound, sprintEngineIpc } from '../modules/sprint-engine-ipc'

/** The `appSettings` slices a launch reads, for the reference short-circuit below. */
function launchSettingSources(): unknown[] {
  const { appSettings } = useWorkspaceStore.getState()
  return [
    appSettings.cliRuntimes,
    appSettings.mcp,
    appSettings.projectKnowledgeRoots,
    appSettings.lastSelectedCli,
    appSettings.lastAgentSpawnPermissionPreset,
    appSettings.sprintEngineRoleSettings,
  ]
}

function currentLaunchSettings(): SprintEngineLaunchSettings {
  const { appSettings } = useWorkspaceStore.getState()
  return {
    cliRuntimes: appSettings.cliRuntimes ?? {},
    mcp: appSettings.mcp ?? { syncEnabled: false, servers: {} },
    projectKnowledgeRoots: appSettings.projectKnowledgeRoots ?? {},
    lastSelectedCli: appSettings.lastSelectedCli ?? null,
    lastAgentSpawnPermissionPreset: appSettings.lastAgentSpawnPermissionPreset ?? null,
    sprintEngineRoleSettings: appSettings.sprintEngineRoleSettings ?? { enabled: {} },
  }
}

export function initSprintEngineLaunchSettingsSync(): () => void {
  if (!isSprintEngineIpcBound()) return () => undefined

  let lastSignature = ''
  let lastSources: unknown[] | null = null
  const push = (): void => {
    // The store notifies on every change (agent state, layout, terminals), so
    // the common case must not serialize the whole settings blob. The six
    // sources are immer-managed: reference-identical means nothing a launch
    // reads has changed.
    const sources = launchSettingSources()
    const previous = lastSources
    if (previous && sources.every((source, index) => source === previous[index])) return
    lastSources = sources
    const settings = currentLaunchSettings()
    const signature = JSON.stringify(settings)
    if (signature === lastSignature) return
    lastSignature = signature
    void sprintEngineIpc.syncSprintEngineLaunchSettings(settings).catch(() => {
      // Retry on the next settings change; main also persists the last good
      // push, so a transient IPC failure only delays convergence.
      lastSignature = ''
    })
  }

  // Seed main's store from this window's persisted settings, so the first boot
  // after this landed (and a fresh install) reads real values rather than
  // defaults. It is deliberately NOT awaited before subscribing: whichever of
  // the seed and the first push reaches main first wins, and the loser is an
  // idempotent no-op — main drops a hydrate onto an existing record and drops a
  // push whose content already matches. Awaiting it instead would let one stuck
  // call cost this window every later settings change.
  void sprintEngineIpc.hydrateSprintEngineLaunchSettings(currentLaunchSettings()).catch(() => undefined)

  push()
  return useWorkspaceStore.subscribe(push)
}
