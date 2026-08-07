// The Connectors row's model (MC-2124): which MCP servers this sprint's agents
// launch with, and the fail-closed write that puts them in the project.
//
// Two rulings shape this file, both taken 2026-08-06 against the item's open
// questions:
//
// 1. **A sprint reflects the app-level selection; it does not carry its own.**
//    `appSettings.mcp` is app-level, and the agent-launch path reads exactly
//    that (`sprintengineLaunchSettingsSync.ts` → `sprint-runtime.ts` →
//    `mcpSettingsForManagedSprintEngineLaunch`). A run-scoped subset would need
//    a second source of truth threaded through main's launch-settings mirror,
//    so the dialog edits the ONE selection and says so on the row — the same
//    honesty the shared-rosters wording gives screen 2. The deleted
//    `SprintEngineToolsPanel` also edited the global, but silently.
//
// 2. **Install stays in the Connectors surface.** This row toggles servers that
//    are already installed; it is not a second catalog browse. Toggling off
//    writes `enabled: false` rather than deleting the server (what the wizard's
//    toggle and `toggleCatalogServer` do), so a server with hand-entered env or
//    headers survives being switched off for one sprint.
//
// The sync itself mirrors `persistAdvancedSetup` (`NewWorkspacePanel.tsx:526`)
// exactly: it RETURNS the failure message instead of throwing, and it treats an
// `ok: false` result, an `error`-level issue, and a thrown error alike.

import type {
  McpServerConfig,
  McpSettings,
  McpSyncInput,
  McpSyncResult,
} from '../../../../../shared/electron-api'

export const SPRINT_CONNECTORS_ROW_LABEL = 'Connectors'

// Named for the surfaces a user can actually reach: the door is "Extensions"
// and its section is "MCP servers" (`ExtensionsGlobalSurface.tsx`). "Connectors"
// is the app's noun for the family — the composer's "+ Connector" picker uses
// it — but there is no surface by that name to send anyone to.
export const SPRINT_CONNECTORS_TOOLTIP =
  'The MCP servers this sprint launches its agents with. The selection is shared with the whole app — '
  + 'switching one on or off here switches it everywhere, exactly like a roster. Add and remove them '
  + 'under MCP servers in Extensions.'

/** Empty state inside the picker, not copy on the row. */
export const SPRINT_CONNECTORS_EMPTY = 'No connectors installed yet'

/**
 * Shown when app settings have connectors but MCP sync is switched off. It
 * deliberately names no control: nothing in the app writes `syncEnabled: false`
 * today (`setMcpSyncEnabled` has no caller, and every upsert sets it true), so
 * this state only arrives from persisted settings — pointing at a toggle that
 * does not exist would be worse than stating the consequence.
 */
export const SPRINT_CONNECTORS_SYNC_OFF = 'Connector sync is off — no connector reaches an agent'

// The prefix `persistAdvancedSetup` already uses, kept identical so the same
// failure reads the same way whichever surface created the workspace.
export const SPRINT_CONNECTOR_FAILURE_PREFIX = 'Tool integration setup failed: '

export type SprintConnector = {
  id: string
  name: string
  description?: string
  enabled: boolean
}

/**
 * Every installed connector, active first then alphabetical — the order the
 * picker renders, so the ones riding the sprint are never below the fold.
 */
export function listSprintConnectors(settings: McpSettings | null | undefined): SprintConnector[] {
  return Object.values(settings?.servers ?? {})
    .filter((server): server is McpServerConfig => Boolean(server?.id))
    .map((server) => ({
      id: server.id,
      name: server.name || server.id,
      ...(server.description ? { description: server.description } : {}),
      enabled: server.enabled === true,
    }))
    .sort((a, b) => {
      if (a.enabled !== b.enabled) return a.enabled ? -1 : 1
      return a.name.localeCompare(b.name)
    })
}

/**
 * The row's value. It states what the sprint gets, never how many exist: "3
 * active" is the answer to "which tools will these agents have".
 */
export function sprintConnectorsSummary(
  connectors: readonly SprintConnector[],
  syncEnabled: boolean,
): string {
  if (connectors.length === 0) return 'None installed'
  if (!syncEnabled) return 'Sync off'
  const active = connectors.filter((connector) => connector.enabled).length
  if (active === 0) return 'None active'
  return `${active} active`
}

/**
 * The server to write back for a toggle, or null when the id is not installed.
 * Never deletes: a disabled server stays in the map, which is also what keeps a
 * stale entry prunable from an already-synced worktree config.
 */
export function toggledSprintConnector(
  settings: McpSettings | null | undefined,
  serverId: string,
): McpServerConfig | null {
  const server = settings?.servers?.[serverId]
  if (!server) return null
  return { ...server, enabled: !(server.enabled === true) }
}

export type SprintConnectorSyncInput = {
  workspaceRoot: string | null
  settings: McpSettings | null | undefined
  /** `window.api.mcpSync`; absent on a preload that predates it. */
  mcpSync: ((input: McpSyncInput) => Promise<McpSyncResult>) | undefined
}

/**
 * Write the enabled connectors into the project through the same `mcp:sync`
 * path Settings and the new-workspace wizard use. Returns the actionable
 * failure message, or null when there was nothing to do or the write succeeded.
 *
 * Fails closed by contract: the caller aborts creation on a message rather than
 * producing a run whose agents silently lack the tools app settings declare.
 * Nothing to do is NOT a failure — with sync off, or with no server enabled,
 * there is no configuration to write and the run is correct without it.
 */
export async function syncSprintConnectors(input: SprintConnectorSyncInput): Promise<string | null> {
  const { workspaceRoot, settings } = input
  if (!workspaceRoot) return null
  if (!settings || settings.syncEnabled !== true) return null
  const hasEnabled = Object.values(settings.servers ?? {}).some((server) => server?.enabled === true)
  if (!hasEnabled) return null

  // Enabled servers with no writer to reach is exactly the toolless run this
  // seam exists to prevent, so it reports rather than skipping quietly.
  if (typeof input.mcpSync !== 'function') {
    return `${SPRINT_CONNECTOR_FAILURE_PREFIX}this build cannot write MCP configuration.`
  }

  try {
    const result = await input.mcpSync({ workspaceRoot, settings })
    if (!result.ok) return `${SPRINT_CONNECTOR_FAILURE_PREFIX}${result.message}`
    const blocking = result.issues.find((issue) => issue.level === 'error')
    if (blocking) return `${SPRINT_CONNECTOR_FAILURE_PREFIX}${blocking.message}`
  } catch (error) {
    return `${SPRINT_CONNECTOR_FAILURE_PREFIX}${error instanceof Error ? error.message : 'sync error'}`
  }
  return null
}
