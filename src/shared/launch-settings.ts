/**
 * The app-launch settings main owns a durable copy of (MC-2154).
 *
 * Every input main needs to compose an agent launch with no window open lives
 * here: the user-configured CLI runtimes, MCP settings, project knowledge
 * roots, the last-selected CLI and the agent-spawn permission preset. They are
 * authored in renderer `appSettings` (localStorage); the renderer pushes them
 * on change and main persists them under userData, so a boot with zero windows
 * — the headless scheduler, a mobile-originated launch — spawns with the
 * user's real settings instead of guessing.
 *
 * Persistence is a versioned record with a monotonic revision and write
 * provenance: a reader can tell a seeded record from a user-pushed one, and a
 * subscriber can order writes. Pure data logic only — all fs/clock access
 * lives in `src/main/launch-settings-mirror.ts`.
 */
import type { McpSettings } from './agent-state'
import type { CliPermissionPreset } from './cli-permission-preset'

const AGENT_LAUNCH_SETTINGS_SCHEMA_VERSION = 1

type AgentLaunchCliRuntimeSettings = {
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
 * Acknowledgement of a launch-settings push: the authoritative record main now
 * holds (the pusher reconciles its revision floor against it) and whether the
 * push actually changed anything — an unchanged blob is not a new revision.
 */
export type AgentLaunchSettingsWriteAck = {
  ok: true
  record: AgentLaunchSettingsRecord
  changed: boolean
}

/** The renderer → main channels the settings mirror is written through. */
export const LAUNCH_SETTINGS_CHANNELS = {
  sync: 'launch-settings:sync',
  hydrate: 'launch-settings:hydrate',
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

const cliPermissionPresets = new Set<CliPermissionPreset>([
  'none',
  'manual',
  'auto',
  'bypass',
])

/**
 * Fail-soft parse of a settings payload (an IPC push or a legacy on-disk
 * mirror). Unknown fields are dropped; missing fields default to empty. Never
 * throws.
 */
export function normalizeAgentLaunchSettings(raw: unknown): AgentLaunchSettings {
  const empty = emptyAgentLaunchSettings()
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return empty
  const record = raw as Record<string, unknown>
  const cliRuntimes: AgentLaunchSettings['cliRuntimes'] = {}
  if (record.cliRuntimes && typeof record.cliRuntimes === 'object' && !Array.isArray(record.cliRuntimes)) {
    for (const [cli, value] of Object.entries(record.cliRuntimes as Record<string, unknown>)) {
      if (!value || typeof value !== 'object') continue
      const entry = value as Record<string, unknown>
      if (typeof entry.command !== 'string') continue
      cliRuntimes[cli] = {
        command: entry.command,
        useWsl: entry.useWsl === true,
        ...(Array.isArray(entry.models)
          ? { models: entry.models.filter((model): model is string => typeof model === 'string') }
          : {}),
      }
    }
  }
  const mcp = record.mcp && typeof record.mcp === 'object' && !Array.isArray(record.mcp)
    ? record.mcp as McpSettings
    : empty.mcp
  const projectKnowledgeRoots: Record<string, string | null> = {}
  if (
    record.projectKnowledgeRoots
    && typeof record.projectKnowledgeRoots === 'object'
    && !Array.isArray(record.projectKnowledgeRoots)
  ) {
    for (const [key, value] of Object.entries(record.projectKnowledgeRoots as Record<string, unknown>)) {
      if (typeof value === 'string' || value === null) projectKnowledgeRoots[key] = value
    }
  }
  return {
    cliRuntimes,
    mcp,
    projectKnowledgeRoots,
    lastSelectedCli: typeof record.lastSelectedCli === 'string' && record.lastSelectedCli
      ? record.lastSelectedCli
      : null,
    lastAgentSpawnPermissionPreset:
      typeof record.lastAgentSpawnPermissionPreset === 'string'
        && cliPermissionPresets.has(record.lastAgentSpawnPermissionPreset as CliPermissionPreset)
        ? record.lastAgentSpawnPermissionPreset as CliPermissionPreset
        : null,
  }
}

/**
 * Parse a persisted store file. Returns null when the payload is not a
 * well-formed current-schema record — including the pre-MC-2154 file, which
 * held bare settings with no revision. A null result means "no authoritative
 * record yet": the caller re-seeds from the settings it holds, so a legacy or
 * corrupt file costs one hydration rather than a crash.
 */
export function parseAgentLaunchSettingsRecord(
  raw: unknown,
): AgentLaunchSettingsRecord | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const record = raw as Record<string, unknown>
  if (record.schemaVersion !== AGENT_LAUNCH_SETTINGS_SCHEMA_VERSION) return null
  const revision = record.revision
  if (typeof revision !== 'number' || !Number.isInteger(revision) || revision < 1) return null
  const rawWrite = record.lastWrite && typeof record.lastWrite === 'object' && !Array.isArray(record.lastWrite)
    ? record.lastWrite as Record<string, unknown>
    : null
  return {
    schemaVersion: AGENT_LAUNCH_SETTINGS_SCHEMA_VERSION,
    revision,
    settings: normalizeAgentLaunchSettings(record.settings),
    changedAt: typeof record.changedAt === 'number' && Number.isFinite(record.changedAt)
      ? record.changedAt
      : 0,
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
 * Content equality for the mirrored settings. Both sides are normalized, so
 * key order is stable and a serialized compare is exact — an unchanged push
 * must not bump the revision or wake subscribers.
 */
export function agentLaunchSettingsEqual(
  left: AgentLaunchSettings,
  right: AgentLaunchSettings,
): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}

export function serializeAgentLaunchSettingsRecord(
  record: AgentLaunchSettingsRecord,
): string {
  return `${JSON.stringify(record, null, 2)}\n`
}
