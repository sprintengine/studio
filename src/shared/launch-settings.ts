/**
 * The agent-launch settings, which main owns.
 *
 * Every input main needs to compose an agent launch with no window open lives
 * here: the user-configured CLI runtimes, MCP settings, project knowledge
 * roots, the last-selected CLI and the agent-spawn permission presets. Main
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
import { normalizeCliPermissionPreset, type CliPermissionPreset } from './cli-permission-preset'
import {
  normalizeExecutionHostId,
  normalizeExecutionHostSettings,
  type ExecutionHostId,
  type ExecutionHostSettings,
} from './execution-host'

// 2: the per-CLI "run through WSL" switch left the CLI runtime, and each
// machine this computer offers (a WSL distribution) got settings of its own in
// `hosts`. There are no released installs, so a version-1 record is read
// through the same normalizer rather than migrated: its runtimes keep their
// commands and models, and the switch is dropped.
const AGENT_LAUNCH_SETTINGS_SCHEMA_VERSION = 2
const READABLE_SCHEMA_VERSIONS: readonly number[] = [1, AGENT_LAUNCH_SETTINGS_SCHEMA_VERSION]

/**
 * A CLI's settings that hold on every machine: its models, and its command on
 * THIS machine (the local host). A WSL distribution keeps its own commands in
 * `hosts[id].cliCommands`.
 */
export type AgentLaunchCliRuntimeSettings = {
  command: string
  models?: string[]
}

export type AgentLaunchSettings = {
  cliRuntimes: Record<string, AgentLaunchCliRuntimeSettings>
  /**
   * Per-machine settings, keyed by host id (`wsl:<distro>`). The local machine
   * has no entry in normal use: its commands live on `cliRuntimes`.
   */
  hosts: Partial<Record<ExecutionHostId, ExecutionHostSettings>>
  mcp: McpSettings
  projectKnowledgeRoots: Record<string, string | null>
  /**
   * The CLI a spawn defaults to when the caller names none. `null` = never
   * chosen; the reader applies its own default rather than inventing one.
   */
  lastSelectedCli: string | null
  /** The permission preset an agent spawn defaults to. `null` = never chosen. */
  lastAgentSpawnPermissionPreset: CliPermissionPreset | null
  /**
   * The permission preset a spawn on each CLI launches with, keyed by CLI id:
   * what the spawn footer's picker last chose for that runtime. A CLI with no
   * entry falls back to `lastAgentSpawnPermissionPreset`. Per CLI and not per
   * model, because a person trusts a runtime in a repository, and Claude Code's
   * auto mode is not Codex's sandbox (owner ruling 2026-09-24). Main owns it so
   * a launch with no window open, and every window, read the same choice.
   */
  cliPermissionPresets: Record<string, CliPermissionPreset>
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
 * - `hosts`: the same, per machine.
 * - `mcp.syncEnabled` sets the switch; `mcp.servers` upserts per server id,
 *   `null` removing that server.
 * - `projectKnowledgeRoots`: per project root, a string sets it and `null`
 *   removes the entry.
 * - `lastSelectedCli` and `lastAgentSpawnPermissionPreset` replace the value;
 *   `null` returns it to "never chosen".
 * - `cliPermissionPresets`: per CLI, a preset sets it and `null` removes the
 *   entry, so that CLI reads the app-wide default again.
 */
export type AgentLaunchSettingsPatch = {
  cliRuntimes?: Record<string, AgentLaunchCliRuntimeSettings | null>
  /** Per host id, an entry replaces that host's settings whole and `null` removes them. */
  hosts?: Partial<Record<ExecutionHostId, ExecutionHostSettings | null>>
  mcp?: {
    syncEnabled?: boolean
    servers?: Record<string, McpServerConfig | null>
  }
  projectKnowledgeRoots?: Record<string, string | null>
  lastSelectedCli?: string | null
  lastAgentSpawnPermissionPreset?: CliPermissionPreset | null
  cliPermissionPresets?: Record<string, CliPermissionPreset | null>
}

/**
 * What a window reads at boot. `record` is null until anything has been
 * written; `settings` is what main spawns with either way (an unrevisioned
 * legacy file, or the empty defaults), so a window can render it at once.
 */
export type AgentLaunchSettingsSnapshot = {
  record: AgentLaunchSettingsRecord | null
  settings: AgentLaunchSettings
  /** Whether `record` is on disk. False for no record, or one a failed write left only in memory. */
  persisted: boolean
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
  /**
   * Whether `record` is on disk. False when the write failed and main holds it
   * only in memory until it restarts; a window then keeps its own localStorage
   * copy of these settings, so the next boot can offer them again.
   */
  persisted: boolean
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

/**
 * The CLI a launch runs on when the person never picked one. The window's
 * pickers show it and main launches on it, both through
 * `effectiveAgentLaunchSettings`, so the two cannot disagree.
 */
export const DEFAULT_AGENT_LAUNCH_CLI = 'claude-code'

/**
 * The permission preset an agent spawn defaults to when the person never chose
 * one: bypass (owner decision, 2026-07-26 — "we should be setting bypass
 * permission mode as the default generally everywhere"). A user who wants gated
 * permissions picks one deliberately in Settings ▸ Agents.
 *
 * Only an ABSENT value adopts it. A present value that is not a current preset
 * goes through `normalizeCliPermissionPreset`, which maps the legacy spellings
 * and floors anything unrecognised to `manual`, so corruption never escalates
 * permissions and flipping this default never rewrites a deliberate choice.
 */
export const DEFAULT_AGENT_SPAWN_PERMISSION_PRESET: CliPermissionPreset = 'bypass'

/** The launch settings with every never-chosen value read as the app default. */
export type EffectiveAgentLaunchSettings = Omit<
  AgentLaunchSettings,
  'lastSelectedCli' | 'lastAgentSpawnPermissionPreset'
> & {
  lastSelectedCli: string
  lastAgentSpawnPermissionPreset: CliPermissionPreset
}

/**
 * What a launch actually uses. The stored record keeps `null` for a value the
 * person never chose — that is honest data, and it lets a later change of the
 * app default reach them — and every reader, main and window alike, reads it
 * through here, so main never launches on anything but what the window shows.
 */
export function effectiveAgentLaunchSettings(settings: AgentLaunchSettings): EffectiveAgentLaunchSettings {
  return {
    ...settings,
    lastSelectedCli: settings.lastSelectedCli || DEFAULT_AGENT_LAUNCH_CLI,
    lastAgentSpawnPermissionPreset: settings.lastAgentSpawnPermissionPreset ?? DEFAULT_AGENT_SPAWN_PERMISSION_PRESET,
  }
}

/**
 * The preset a spawn on `cli` launches with: the caller's own, else the one
 * the person chose for that CLI, else the app-wide spawn default (itself the
 * app default when never chosen). Main's launch service and the window's
 * spawn paths both resolve through here, so a launch with no window open runs
 * on the preset the picker shows for that CLI.
 */
export function resolveAgentSpawnPermissionPreset(
  settings: Pick<AgentLaunchSettings, 'cliPermissionPresets' | 'lastAgentSpawnPermissionPreset'>,
  cli: string | null | undefined,
  requested?: CliPermissionPreset | null,
): CliPermissionPreset {
  const presets = settings.cliPermissionPresets
  // Own keys only: a free-form CLI name such as `constructor` must not read
  // something off Object.prototype as its preset.
  const own = cli && presets && Object.hasOwn(presets, cli) ? presets[cli] : undefined
  return requested ?? own ?? settings.lastAgentSpawnPermissionPreset ?? DEFAULT_AGENT_SPAWN_PERMISSION_PRESET
}

export function emptyAgentLaunchSettings(): AgentLaunchSettings {
  return {
    cliRuntimes: {},
    hosts: {},
    mcp: { syncEnabled: false, servers: {} },
    projectKnowledgeRoots: {},
    lastSelectedCli: null,
    lastAgentSpawnPermissionPreset: null,
    cliPermissionPresets: {},
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
    ...(Array.isArray(value.models)
      ? { models: value.models.filter((model): model is string => typeof model === 'string') }
      : {}),
  }
}

export function normalizeAgentLaunchHosts(value: unknown): AgentLaunchSettings['hosts'] {
  const hosts: AgentLaunchSettings['hosts'] = {}
  if (!isPlainObject(value)) return hosts
  for (const [rawId, entry] of Object.entries(value)) {
    const id = normalizeExecutionHostId(rawId)
    if (id && isPlainObject(entry)) hosts[id] = normalizeExecutionHostSettings(entry)
  }
  return hosts
}

function normalizeLastSelectedCli(value: unknown): string | null {
  return typeof value === 'string' && value ? value : null
}

function normalizePreset(value: unknown): CliPermissionPreset | null {
  return typeof value === 'string' && cliPermissionPresets.has(value as CliPermissionPreset)
    ? (value as CliPermissionPreset)
    : null
}

// A stored preset. Absent stays null ("never chosen", which reads as the app
// default); anything present is a choice somebody made, so a legacy spelling
// keeps its meaning and an unrecognised value floors to `manual` rather than
// becoming null and escalating to the bypass default.
function normalizeStoredPreset(value: unknown): CliPermissionPreset | null {
  if (value === null || value === undefined) return null
  return normalizeCliPermissionPreset(typeof value === 'string' ? (value as CliPermissionPreset) : undefined)
}

/**
 * The per-CLI presets from a stored record or a migration offer. An entry is a
 * choice somebody made, so it reads like the app-wide one: a legacy spelling
 * keeps its meaning and anything unrecognised floors to `manual` rather than
 * disappearing into the (bypass) default.
 */
export function normalizeCliPermissionPresets(value: unknown): Record<string, CliPermissionPreset> {
  const presets: Record<string, CliPermissionPreset> = {}
  if (!isPlainObject(value)) return presets
  for (const [cli, entry] of Object.entries(value)) {
    const preset = cli ? normalizeStoredPreset(entry) : null
    if (preset) presets[cli] = preset
  }
  return presets
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
    hosts: normalizeAgentLaunchHosts(raw.hosts),
    mcp,
    projectKnowledgeRoots,
    lastSelectedCli: normalizeLastSelectedCli(raw.lastSelectedCli),
    lastAgentSpawnPermissionPreset: normalizeStoredPreset(raw.lastAgentSpawnPermissionPreset),
    cliPermissionPresets: normalizeCliPermissionPresets(raw.cliPermissionPresets),
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
  if (isPlainObject(raw.hosts)) {
    const hosts: NonNullable<AgentLaunchSettingsPatch['hosts']> = {}
    for (const [rawId, value] of Object.entries(raw.hosts)) {
      const id = normalizeExecutionHostId(rawId)
      if (!id) continue
      if (value === null) hosts[id] = null
      else if (isPlainObject(value)) hosts[id] = normalizeExecutionHostSettings(value)
    }
    patch.hosts = hosts
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
  if (isPlainObject(raw.cliPermissionPresets)) {
    const presets: Record<string, CliPermissionPreset | null> = {}
    for (const [cli, value] of Object.entries(raw.cliPermissionPresets)) {
      if (!cli) continue
      if (value === null) {
        presets[cli] = null
        continue
      }
      const preset = normalizePreset(value)
      if (preset) presets[cli] = preset
    }
    patch.cliPermissionPresets = presets
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
    hosts: { ...settings.hosts },
    mcp: { ...settings.mcp, servers: { ...settings.mcp.servers } },
    projectKnowledgeRoots: { ...settings.projectKnowledgeRoots },
    cliPermissionPresets: { ...settings.cliPermissionPresets },
  }
  for (const [cli, runtime] of Object.entries(patch.cliRuntimes ?? {})) {
    if (runtime === null) delete next.cliRuntimes[cli]
    else next.cliRuntimes[cli] = runtime
  }
  for (const [id, host] of Object.entries(patch.hosts ?? {}) as Array<
    [ExecutionHostId, ExecutionHostSettings | null]
  >) {
    if (host === null) delete next.hosts[id]
    else next.hosts[id] = host
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
  for (const [cli, preset] of Object.entries(patch.cliPermissionPresets ?? {})) {
    if (preset === null) delete next.cliPermissionPresets[cli]
    else next.cliPermissionPresets[cli] = preset
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
  if (typeof raw.schemaVersion !== 'number' || !READABLE_SCHEMA_VERSIONS.includes(raw.schemaVersion)) return null
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
