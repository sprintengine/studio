/**
 * The agent-launch settings, which main owns.
 *
 * Every input main needs to compose an agent launch with no window open lives
 * here: the user-configured CLI runtimes, MCP settings, project knowledge
 * roots, the last-selected CLI and the agent-spawn permission preset. Main
 * holds the one authoritative record under userData; a window reads it at
 * boot, writes to it only through partial `update` patches, and follows every
 * change through the `changed` broadcast. A boot with zero windows (the
 * headless scheduler, a mobile-originated launch) spawns with the same record
 * a window shows. docs/launch-settings-ownership.md has the whole picture.
 *
 * Persistence is a versioned record with a monotonic revision and write
 * provenance: a reader can tell a migrated record from a user write, and a
 * subscriber can order writes. Pure data logic only — all fs/clock access
 * lives in `src/main/launch-settings-store.ts`.
 */
import type { McpServerConfig, McpSettings } from './agent-state'
import type { CliPermissionPreset } from './cli-permission-preset'

const AGENT_LAUNCH_SETTINGS_SCHEMA_VERSION = 1

export type AgentLaunchCliRuntimeSettings = {
  command: string
  useWsl: boolean
  models?: string[]
}

export type AgentLaunchSettings = {
  cliRuntimes: Record<string, AgentLaunchCliRuntimeSettings>
  mcp: McpSettings
  projectKnowledgeRoots: Record<string, string | null>
  /**
   * The CLI a spawn defaults to when the caller names none. `null` = never
   * chosen; the reader applies its own default rather than inventing one.
   */
  lastSelectedCli: string | null
  /** The permission preset an agent spawn defaults to. `null` = never chosen. */
  lastAgentSpawnPermissionPreset: CliPermissionPreset | null
}

/** Names the process boundary a write came through, never the human. */
export type AgentLaunchSettingsActor = 'ui' | 'system'

export type AgentLaunchSettingsRecord = {
  schemaVersion: typeof AGENT_LAUNCH_SETTINGS_SCHEMA_VERSION
  /**
   * Monotonic write counter. Broadcasts carry it; a subscriber ignores
   * anything at or below the revision it already applied, so a slow echo can
   * never re-assert a stale value over a newer one.
   */
  revision: number
  settings: AgentLaunchSettings
  changedAt: number
  lastWrite: { actor: AgentLaunchSettingsActor; at: string }
}

/**
 * A partial write to main's record. Each field is independent, so two windows
 * editing different CLIs, different MCP servers or different knowledge roots
 * never overwrite each other with a stale copy of the rest.
 *
 * - `cliRuntimes`: per CLI, an entry replaces that CLI's runtime whole and
 *   `null` removes it. CLIs the patch does not name are untouched.
 * - `mcp.syncEnabled` sets the switch; `mcp.servers` upserts per server id,
 *   `null` removing that server.
 * - `projectKnowledgeRoots`: per project root, a string sets it and `null`
 *   removes the entry.
 * - `lastSelectedCli` and `lastAgentSpawnPermissionPreset` replace the value;
 *   `null` returns it to "never chosen".
 */
export type AgentLaunchSettingsPatch = {
  cliRuntimes?: Record<string, AgentLaunchCliRuntimeSettings | null>
  mcp?: {
    syncEnabled?: boolean
    servers?: Record<string, McpServerConfig | null>
  }
  projectKnowledgeRoots?: Record<string, string | null>
  lastSelectedCli?: string | null
  lastAgentSpawnPermissionPreset?: CliPermissionPreset | null
}

/**
 * What a window reads at boot. `record` is null until anything has been
 * written; `settings` is what main spawns with either way (an unrevisioned
 * legacy file, or the empty defaults), so a window can render it at once.
 */
export type AgentLaunchSettingsSnapshot = {
  record: AgentLaunchSettingsRecord | null
  settings: AgentLaunchSettings
}

/**
 * Main's answer to an `update` or a `migrate`: the authoritative record it now
 * holds, which the caller adopts over anything it applied optimistically, and
 * whether the call changed it. An update whose content matches the record is
 * not a new revision; a migration offered onto an existing record is refused
 * and reports `changed: false`.
 */
export type AgentLaunchSettingsWriteAck = {
  ok: true
  record: AgentLaunchSettingsRecord
  changed: boolean
}

/**
 * The launch-settings channels. `get`, `update` and `migrate` are renderer →
 * main invokes; `changed` is main's broadcast to every window, carrying the
 * new record after each write that changed it.
 */
export const LAUNCH_SETTINGS_CHANNELS = {
  get: 'launch-settings:get',
  update: 'launch-settings:update',
  migrate: 'launch-settings:migrate',
  changed: 'launch-settings:changed',
} as const

export function emptyAgentLaunchSettings(): AgentLaunchSettings {
  return {
    cliRuntimes: {},
    mcp: { syncEnabled: false, servers: {} },
    projectKnowledgeRoots: {},
    lastSelectedCli: null,
    lastAgentSpawnPermissionPreset: null,
  }
}

const cliPermissionPresets = new Set<CliPermissionPreset>(['none', 'manual', 'auto', 'bypass'])

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function normalizeCliRuntime(value: unknown): AgentLaunchCliRuntimeSettings | null {
  if (!isPlainObject(value) || typeof value.command !== 'string') return null
  return {
    command: value.command,
    useWsl: value.useWsl === true,
    ...(Array.isArray(value.models)
      ? { models: value.models.filter((model): model is string => typeof model === 'string') }
      : {}),
  }
}

function normalizeLastSelectedCli(value: unknown): string | null {
  return typeof value === 'string' && value ? value : null
}

function normalizePreset(value: unknown): CliPermissionPreset | null {
  return typeof value === 'string' && cliPermissionPresets.has(value as CliPermissionPreset)
    ? (value as CliPermissionPreset)
    : null
}

/**
 * Fail-soft parse of a settings payload (a migration offer or a legacy on-disk
 * file). Unknown fields are dropped; missing fields default to empty. Never
 * throws.
 */
export function normalizeAgentLaunchSettings(raw: unknown): AgentLaunchSettings {
  const empty = emptyAgentLaunchSettings()
  if (!isPlainObject(raw)) return empty
  const cliRuntimes: AgentLaunchSettings['cliRuntimes'] = {}
  if (isPlainObject(raw.cliRuntimes)) {
    for (const [cli, value] of Object.entries(raw.cliRuntimes)) {
      const runtime = normalizeCliRuntime(value)
      if (runtime) cliRuntimes[cli] = runtime
    }
  }
  const mcp = isPlainObject(raw.mcp) ? (raw.mcp as McpSettings) : empty.mcp
  const projectKnowledgeRoots: Record<string, string | null> = {}
  if (isPlainObject(raw.projectKnowledgeRoots)) {
    for (const [key, value] of Object.entries(raw.projectKnowledgeRoots)) {
      if (typeof value === 'string' || value === null) projectKnowledgeRoots[key] = value
    }
  }
  return {
    cliRuntimes,
    mcp,
    projectKnowledgeRoots,
    lastSelectedCli: normalizeLastSelectedCli(raw.lastSelectedCli),
    lastAgentSpawnPermissionPreset: normalizePreset(raw.lastAgentSpawnPermissionPreset),
  }
}

/**
 * Fail-soft parse of an `update` payload. A field of the wrong shape is
 * dropped rather than failing the whole patch, and an entry that is neither a
 * value nor `null` is dropped from its map. Never throws.
 */
export function normalizeAgentLaunchSettingsPatch(raw: unknown): AgentLaunchSettingsPatch {
  if (!isPlainObject(raw)) return {}
  const patch: AgentLaunchSettingsPatch = {}
  if (isPlainObject(raw.cliRuntimes)) {
    const cliRuntimes: Record<string, AgentLaunchCliRuntimeSettings | null> = {}
    for (const [cli, value] of Object.entries(raw.cliRuntimes)) {
      if (!cli) continue
      if (value === null) {
        cliRuntimes[cli] = null
        continue
      }
      const runtime = normalizeCliRuntime(value)
      if (runtime) cliRuntimes[cli] = runtime
    }
    patch.cliRuntimes = cliRuntimes
  }
  if (isPlainObject(raw.mcp)) {
    const mcp: NonNullable<AgentLaunchSettingsPatch['mcp']> = {}
    if (typeof raw.mcp.syncEnabled === 'boolean') mcp.syncEnabled = raw.mcp.syncEnabled
    if (isPlainObject(raw.mcp.servers)) {
      const servers: Record<string, McpServerConfig | null> = {}
      for (const [id, value] of Object.entries(raw.mcp.servers)) {
        if (!id) continue
        if (value === null) servers[id] = null
        else if (isPlainObject(value)) servers[id] = value as McpServerConfig
      }
      mcp.servers = servers
    }
    patch.mcp = mcp
  }
  if (isPlainObject(raw.projectKnowledgeRoots)) {
    const roots: Record<string, string | null> = {}
    for (const [key, value] of Object.entries(raw.projectKnowledgeRoots)) {
      if (key && (typeof value === 'string' || value === null)) roots[key] = value
    }
    patch.projectKnowledgeRoots = roots
  }
  if (raw.lastSelectedCli === null || typeof raw.lastSelectedCli === 'string') {
    patch.lastSelectedCli = normalizeLastSelectedCli(raw.lastSelectedCli)
  }
  if (raw.lastAgentSpawnPermissionPreset === null) {
    patch.lastAgentSpawnPermissionPreset = null
  } else {
    const preset = normalizePreset(raw.lastAgentSpawnPermissionPreset)
    if (preset) patch.lastAgentSpawnPermissionPreset = preset
  }
  return patch
}

/** The settings with `patch` applied. Pure: neither input is mutated. */
export function applyAgentLaunchSettingsPatch(
  settings: AgentLaunchSettings,
  patch: AgentLaunchSettingsPatch,
): AgentLaunchSettings {
  const next: AgentLaunchSettings = {
    ...settings,
    cliRuntimes: { ...settings.cliRuntimes },
    mcp: { ...settings.mcp, servers: { ...settings.mcp.servers } },
    projectKnowledgeRoots: { ...settings.projectKnowledgeRoots },
  }
  for (const [cli, runtime] of Object.entries(patch.cliRuntimes ?? {})) {
    if (runtime === null) delete next.cliRuntimes[cli]
    else next.cliRuntimes[cli] = runtime
  }
  if (patch.mcp?.syncEnabled !== undefined) next.mcp.syncEnabled = patch.mcp.syncEnabled
  for (const [id, server] of Object.entries(patch.mcp?.servers ?? {})) {
    if (server === null) delete next.mcp.servers[id]
    else next.mcp.servers[id] = server
  }
  for (const [key, root] of Object.entries(patch.projectKnowledgeRoots ?? {})) {
    if (root === null) delete next.projectKnowledgeRoots[key]
    else next.projectKnowledgeRoots[key] = root
  }
  if (patch.lastSelectedCli !== undefined) next.lastSelectedCli = patch.lastSelectedCli
  if (patch.lastAgentSpawnPermissionPreset !== undefined) {
    next.lastAgentSpawnPermissionPreset = patch.lastAgentSpawnPermissionPreset
  }
  return next
}

/**
 * Parse a persisted store file. Returns null when the payload is not a
 * well-formed current-schema record — including the original, unrevisioned
 * file, which held bare settings with no revision. A null result means "no
 * authoritative record yet": a window's one-time migration offer is accepted,
 * so a legacy or corrupt file costs one migration rather than a crash.
 */
export function parseAgentLaunchSettingsRecord(raw: unknown): AgentLaunchSettingsRecord | null {
  if (!isPlainObject(raw)) return null
  if (raw.schemaVersion !== AGENT_LAUNCH_SETTINGS_SCHEMA_VERSION) return null
  const revision = raw.revision
  if (typeof revision !== 'number' || !Number.isInteger(revision) || revision < 1) return null
  const rawWrite = isPlainObject(raw.lastWrite) ? raw.lastWrite : null
  return {
    schemaVersion: AGENT_LAUNCH_SETTINGS_SCHEMA_VERSION,
    revision,
    settings: normalizeAgentLaunchSettings(raw.settings),
    changedAt: typeof raw.changedAt === 'number' && Number.isFinite(raw.changedAt) ? raw.changedAt : 0,
    lastWrite: {
      actor: rawWrite?.actor === 'ui' ? 'ui' : 'system',
      at: typeof rawWrite?.at === 'string' ? rawWrite.at : '',
    },
  }
}

export function nextAgentLaunchSettingsRecord(input: {
  current: AgentLaunchSettingsRecord | null
  settings: AgentLaunchSettings
  actor: AgentLaunchSettingsActor
  now: number
}): AgentLaunchSettingsRecord {
  return {
    schemaVersion: AGENT_LAUNCH_SETTINGS_SCHEMA_VERSION,
    revision: (input.current?.revision ?? 0) + 1,
    settings: input.settings,
    changedAt: input.now,
    lastWrite: { actor: input.actor, at: new Date(input.now).toISOString() },
  }
}

/**
 * Content equality for two settings values, independent of key order: an
 * update that changes nothing must not bump the revision or wake subscribers,
 * and a patch applied to a record can re-insert a key in a different position
 * than the one it already held.
 */
export function agentLaunchSettingsEqual(left: AgentLaunchSettings, right: AgentLaunchSettings): boolean {
  return stableStringify(left) === stableStringify(right)
}

function stableStringify(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) =>
    isPlainObject(item)
      ? Object.fromEntries(
          Object.keys(item)
            .sort()
            .map((key) => [key, item[key]]),
        )
      : item,
  )
}

export function serializeAgentLaunchSettingsRecord(record: AgentLaunchSettingsRecord): string {
  return `${JSON.stringify(record, null, 2)}\n`
}
