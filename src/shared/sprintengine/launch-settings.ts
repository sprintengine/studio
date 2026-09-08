/**
 * The app-launch settings main owns a durable copy of (MC-2154; started as the
 * Phase 2 launch mirror of the sprint-runtime-ownership epic).
 *
 * Every input main needs to compose an agent launch with no window open lives
 * here: the user-configured CLI runtimes, MCP settings, project knowledge
 * roots, the last-selected CLI, the agent-spawn permission preset, and the
 * Sprint Engine role settings (saved rosters + the last-selected roster, which
 * roster resolution reads together). They are authored in renderer
 * `appSettings` (localStorage); the renderer pushes them on change and main
 * persists them under userData, so a boot with zero windows — the headless
 * scheduler, boot-time run discovery, a mobile-originated launch — spawns with
 * the user's real settings instead of guessing.
 *
 * Persistence is a versioned record with a monotonic revision and write
 * provenance (same shape rule as `automation-intent.ts`): a reader can tell a
 * seeded record from a user-pushed one, and a subscriber can order writes.
 * Pure data logic only — all fs/clock access lives in
 * `src/main/sprintengine-launch-settings-mirror.ts`.
 */
import type { McpSettings } from './agent-state'
import type { SprintEngineCliPermissionPreset } from './automation-types'
import type { SprintEngineRoleSettings, SprintEngineRoster } from './run-types'

const SPRINT_ENGINE_LAUNCH_SETTINGS_SCHEMA_VERSION = 1

type SprintEngineLaunchCliRuntimeSettings = {
  command: string
  useWsl: boolean
  models?: string[]
}

export type SprintEngineLaunchSettings = {
  cliRuntimes: Record<string, SprintEngineLaunchCliRuntimeSettings>
  mcp: McpSettings
  projectKnowledgeRoots: Record<string, string | null>
  /**
   * The CLI a spawn defaults to when the caller names none. `null` = never
   * chosen; the reader applies its own default rather than inventing one.
   */
  lastSelectedCli: string | null
  /** The permission preset an agent spawn defaults to. `null` = never chosen. */
  lastAgentSpawnPermissionPreset: SprintEngineCliPermissionPreset | null
  /**
   * Saved rosters travel with `lastSelectedRosterId` and the legacy
   * `savedRoster` because roster resolution reads all three together — a
   * headless launch that only knew the roster list would still have to guess
   * which one the user means.
   */
  sprintEngineRoleSettings: SprintEngineRoleSettings
}

/** Names the process boundary a write came through, never the human. */
export type SprintEngineLaunchSettingsActor = 'ui' | 'system'

export type SprintEngineLaunchSettingsRecord = {
  schemaVersion: typeof SPRINT_ENGINE_LAUNCH_SETTINGS_SCHEMA_VERSION
  /**
   * Monotonic write counter. Broadcasts carry it; a subscriber ignores
   * anything at or below the revision it already applied, so a slow echo can
   * never re-assert a stale value over a newer one.
   */
  revision: number
  settings: SprintEngineLaunchSettings
  changedAt: number
  lastWrite: { actor: SprintEngineLaunchSettingsActor; at: string }
}

export function emptySprintEngineLaunchSettings(): SprintEngineLaunchSettings {
  return {
    cliRuntimes: {},
    mcp: { syncEnabled: false, servers: {} },
    projectKnowledgeRoots: {},
    lastSelectedCli: null,
    lastAgentSpawnPermissionPreset: null,
    sprintEngineRoleSettings: { enabled: {} },
  }
}

const cliPermissionPresets = new Set<SprintEngineCliPermissionPreset>([
  'none',
  'manual',
  'auto',
  'bypass',
])

function isPlainObject(raw: unknown): raw is Record<string, unknown> {
  return Boolean(raw) && typeof raw === 'object' && !Array.isArray(raw)
}

/**
 * A roster is kept only when it carries what resolution actually reads: an id,
 * a name, and the two staffing maps. A half-formed roster is dropped rather
 * than passed through — a headless launch that resolved one would staff a
 * phantom team, which is worse than falling back to the default.
 */
function normalizeRoster(raw: unknown): SprintEngineRoster | null {
  if (!isPlainObject(raw)) return null
  if (typeof raw.id !== 'string' || !raw.id) return null
  if (typeof raw.name !== 'string') return null
  if (!isPlainObject(raw.roleCounts) || !isPlainObject(raw.roleCliDefaults)) return null
  return raw as unknown as SprintEngineRoster
}

/**
 * Fail-soft shape check for the mirrored role settings. Rosters that are not
 * identifiable objects are dropped (an unusable roster is worse than a missing
 * one — a headless launch must never resolve to a phantom); everything else
 * passes through, matching how `mcp` is mirrored.
 */
function normalizeRoleSettings(raw: unknown): SprintEngineRoleSettings {
  if (!isPlainObject(raw)) return { enabled: {} }
  const record = raw
  const enabled = isPlainObject(record.enabled)
    ? record.enabled as SprintEngineRoleSettings['enabled']
    : {}
  const savedRosters = Array.isArray(record.savedRosters)
    ? record.savedRosters
      .map(normalizeRoster)
      .filter((roster): roster is SprintEngineRoster => roster !== null)
    : undefined
  return {
    enabled,
    ...(savedRosters ? { savedRosters } : {}),
    ...(record.savedRoster !== undefined
      ? { savedRoster: record.savedRoster as SprintEngineRoleSettings['savedRoster'] }
      : {}),
    ...(typeof record.lastSelectedRosterId === 'string' || record.lastSelectedRosterId === null
      ? { lastSelectedRosterId: record.lastSelectedRosterId as string | null }
      : {}),
  }
}

/**
 * Fail-soft parse of a settings payload (an IPC push or a legacy on-disk
 * mirror). Unknown fields are dropped; missing fields default to empty. Never
 * throws.
 */
export function normalizeSprintEngineLaunchSettings(raw: unknown): SprintEngineLaunchSettings {
  const empty = emptySprintEngineLaunchSettings()
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return empty
  const record = raw as Record<string, unknown>
  const cliRuntimes: SprintEngineLaunchSettings['cliRuntimes'] = {}
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
        && cliPermissionPresets.has(record.lastAgentSpawnPermissionPreset as SprintEngineCliPermissionPreset)
        ? record.lastAgentSpawnPermissionPreset as SprintEngineCliPermissionPreset
        : null,
    sprintEngineRoleSettings: normalizeRoleSettings(record.sprintEngineRoleSettings),
  }
}

/**
 * Parse a persisted store file. Returns null when the payload is not a
 * well-formed current-schema record — including the pre-MC-2154 file, which
 * held bare settings with no revision. A null result means "no authoritative
 * record yet": the caller re-seeds from the settings it holds, so a legacy or
 * corrupt file costs one hydration rather than a crash.
 */
export function parseSprintEngineLaunchSettingsRecord(
  raw: unknown,
): SprintEngineLaunchSettingsRecord | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const record = raw as Record<string, unknown>
  if (record.schemaVersion !== SPRINT_ENGINE_LAUNCH_SETTINGS_SCHEMA_VERSION) return null
  const revision = record.revision
  if (typeof revision !== 'number' || !Number.isInteger(revision) || revision < 1) return null
  const rawWrite = record.lastWrite && typeof record.lastWrite === 'object' && !Array.isArray(record.lastWrite)
    ? record.lastWrite as Record<string, unknown>
    : null
  return {
    schemaVersion: SPRINT_ENGINE_LAUNCH_SETTINGS_SCHEMA_VERSION,
    revision,
    settings: normalizeSprintEngineLaunchSettings(record.settings),
    changedAt: typeof record.changedAt === 'number' && Number.isFinite(record.changedAt)
      ? record.changedAt
      : 0,
    lastWrite: {
      actor: rawWrite?.actor === 'ui' ? 'ui' : 'system',
      at: typeof rawWrite?.at === 'string' ? rawWrite.at : '',
    },
  }
}

export function nextSprintEngineLaunchSettingsRecord(input: {
  current: SprintEngineLaunchSettingsRecord | null
  settings: SprintEngineLaunchSettings
  actor: SprintEngineLaunchSettingsActor
  now: number
}): SprintEngineLaunchSettingsRecord {
  return {
    schemaVersion: SPRINT_ENGINE_LAUNCH_SETTINGS_SCHEMA_VERSION,
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
export function sprintEngineLaunchSettingsEqual(
  left: SprintEngineLaunchSettings,
  right: SprintEngineLaunchSettings,
): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}

export function serializeSprintEngineLaunchSettingsRecord(
  record: SprintEngineLaunchSettingsRecord,
): string {
  return `${JSON.stringify(record, null, 2)}\n`
}
