// @sprintengine/module-sdk — the published contract surface external authors
// compile against when building SprintEngine Studio capability modules.
//
// The repository is the consumer-of-record: a drift guard inside the studio
// repo (packages/module-sdk/drift/sdk-drift-guard.ts) type-checks that these
// declarations stay equivalent to (or sound narrowings of) the in-app
// contracts, and that mirrored value exports stay identical. The SDK never
// imports application code, so the published tarball is self-contained.
//
// Some shapes are deliberately narrowed for external publication (for
// example, run-glyph providers receive a minimal input view rather than the
// shell's internal workspace shape). Every narrowing is listed in README.md.

import type { ComponentType, LazyExoticComponent } from 'react'

// ── Manifest ─────────────────────────────────────────────────────────────────

export type CapabilityCategory =
  'core' | 'dev-tools' | 'vcs' | 'orchestration' | 'insight' | 'connectivity' | (string & {})

export type ModuleSource = 'bundled' | 'third-party'

/** Detached ed25519 signature over the canonical manifest (signature field excluded). */
export type ModuleSignature = {
  algorithm: 'ed25519'
  publicKey: string
  signature: string
}

/**
 * Code entry points, relative to the module root. `entry.main` runs in the
 * main process for trusted modules; `entry.renderer` is loaded into the
 * renderer for trusted modules. `entry.preload` is reserved and NOT loaded in
 * v1 — declare it only for forward compatibility.
 */
export type ModuleEntry = {
  main?: string
  preload?: string
  renderer?: string
}

export type CapabilityManifest = {
  id: string
  displayName: string
  version: number
  publisher?: string
  category?: CapabilityCategory
  summary?: string
  /** Whether the module loads when the user has expressed no preference. */
  defaultEnabled: boolean
  /** Core modules are always enabled. Third-party modules must not set this. */
  core?: boolean
  /** Capability ids this module needs loaded (and enabled) before it can load. */
  dependsOn?: string[]
  /** Capability ids that must not be enabled at the same time as this one. */
  conflictsWith?: string[]
  /** Provenance. Absent ⇒ bundled first-party. Installed modules are 'third-party'. */
  source?: ModuleSource
  /** Permission scopes requested (install-time disclosure, not runtime enforcement). */
  permissions?: string[]
  entry?: ModuleEntry
  signature?: ModuleSignature
}

/** Trust classification: only 'trusted' modules are eligible to execute code. */
export type ModuleTrustStatus = 'trusted' | 'signed' | 'unsigned' | 'invalid'

/** Reserved bundled module ids a third-party module may not claim. */
export const BUNDLED_MODULE_IDS: readonly string[] = [
  'agent-runtime',
  'backlog',
  'canvas',
  'design',
  // Retired but still reserved (Design Wizard, deleted 2026-09-08) — like
  // 'switchboard' below, the id stays claimed so nothing can impersonate it.
  'design-wizard',
  'dev-tools',
  'git',
  'memory-graph',
  'switchboard',
  // RESERVED, never bundled: the Sprint Engine ships as an out-of-tree module
  // that installs under this id, so the name is claimed here and nothing else
  // can take it.
  'sprint-engine',
  'review',
  'automations',
  'mobile-relay',
  'voice-dictation',
]

// ── Permissions (install-time disclosure vocabulary) ─────────────────────────

export type CapabilityPermission =
  | 'filesystem:read-workspace'
  | 'filesystem:write-workspace'
  | 'filesystem:read-home'
  | 'process:spawn'
  | 'network'
  | 'ipc:workspace-read'
  | 'ipc:workspace-write'
  | 'ipc:agents'
  | 'ipc:settings'
  | 'ipc:invoke'
  | 'backlog.read'
  | 'backlog.write'
  | 'backlog.link.open'
  // Create and manage the module's own automations through the SDK's scoped
  // Automations service. Disclosure-level like every other scope: the service
  // does not runtime-check it.
  | 'automations.manage'
  // Attach workspace-bound background (companion) agents through the SDK's
  // Companion Agents service. Unlike the disclosure-only scopes above, the
  // companion service checks this one explicitly at attach time.
  | 'agents:companion'
  // Launch, prompt and stop the module's OWN agent terminals through the SDK's
  // scoped Agent Sessions service. Runtime-checked like `agents:companion`, and
  // scoped further by agent-id namespace: a module reaches the sessions it
  // started and named, never another module's and never the user's.
  | 'agents:session'
  // Persist the module's own data through the SDK's scoped storage service
  // (host-placed: the workspace's app-owned `.sprintengine/modules/<id>/`, or
  // per-user app data).
  | 'storage'
  | (string & {})

export const KNOWN_CAPABILITY_PERMISSIONS: readonly string[] = [
  'filesystem:read-workspace',
  'filesystem:write-workspace',
  'filesystem:read-home',
  'process:spawn',
  'network',
  'ipc:workspace-read',
  'ipc:workspace-write',
  'ipc:agents',
  'ipc:settings',
  'ipc:invoke',
  'backlog.read',
  'backlog.write',
  'backlog.link.open',
  'automations.manage',
  'agents:companion',
  'agents:session',
  'storage',
]

// ── Notifications ────────────────────────────────────────────────────────────

export type ModuleNotificationSeverity = 'info' | 'warning' | 'error'

/** What a module passes to `host.notify(...)`; identity and time are stamped by the host. */
export type ModuleNotifyInput = {
  severity: ModuleNotificationSeverity
  title: string
  body?: string
}

export type ModuleNotification = {
  /** Stamped by the host kernel from the emitting module's scope. */
  sourceModuleId: string
  severity: ModuleNotificationSeverity
  title: string
  body?: string
  /** Epoch ms at emission, assigned by the kernel. */
  emittedAt: number
}

// ── Module events (main → renderer) ──────────────────────────────────────────

/**
 * The wire shape of one event, as `MainHost.emit` stamps it and the host
 * delivers it. Your module never constructs or receives this directly —
 * `emit(topic, payload)` builds it and `RendererHost.subscribe(topic, cb)`
 * hands `cb` the payload alone — but it is published so the routing contract is
 * inspectable: identity and time are the host's, topic and payload are yours.
 */
export type ModuleEventEnvelope = {
  /** Stamped by the host kernel from the emitting module's scope. */
  sourceModuleId: string
  /** Module-chosen event name. Scoped to the module, so it needs no prefix. */
  topic: string
  /** Structured-cloneable payload; absent for a bare signal. */
  payload?: unknown
  /** Epoch ms at emission, assigned by the kernel. */
  emittedAt: number
}

// ── Main-process host (entry.main) ───────────────────────────────────────────

/**
 * The raw IPC event is typed `unknown` in the SDK so the package carries no
 * Electron dependency; treat it as opaque unless you depend on Electron types
 * yourself.
 */
export type IpcInvokeHandler = (event: unknown, ...args: unknown[]) => unknown | Promise<unknown>

export type StartupHook = () => void | Promise<void>
export type ShutdownBeginHook = () => void | Promise<void>
export type ShutdownHook = () => void | Promise<void>

/** Typed handle for a service one module provides and others require. */
export type ServiceToken<T> = { readonly key: string; readonly __type?: T }

export function createServiceToken<T>(key: string): ServiceToken<T> {
  return { key }
}

export type SidecarSpec = {
  id: string
  /** e.g. 'process'. Free-form; the host interprets it. */
  kind: string
  /** Entry point or executable, depending on kind. */
  module?: string
  description?: string
  /**
   * When the host spawns the sidecar: 'startup' (default) starts it during
   * app startup in registration order; 'demand' leaves spawning to the owner
   * (for lazily-started daemons). Only meaningful when the host manages the
   * sidecar's lifecycle.
   */
  startOn?: 'startup' | 'demand'
}

export type SidecarRunState = 'declared' | 'stopped' | 'starting' | 'running' | 'failed'

export type SidecarStartOptions = {
  /** Merged into the child env for this start only (e.g. a per-start token). */
  env?: Record<string, string>
}

export type SidecarRuntimeStatus = {
  id: string
  moduleId: string
  kind: string
  description?: string
  state: SidecarRunState
  error?: string
}

/**
 * Handle returned by `registerSidecar`. The host does not spawn a module's
 * sidecar: a registration is a declaration, so `start` refuses it and
 * `status()` reports `'declared'`.
 */
export type SidecarHandle = {
  start(options?: SidecarStartOptions): Promise<void>
  stop(): Promise<void>
  status(): SidecarRuntimeStatus
}

// ── MCP tools on the Studio gateway (MC-1855) ─────────────────────────────────

/** A normal MCP tool result; `isError: true` marks a tool-domain failure. */
export type McpToolResult = {
  // Text, or an image part (a browser snapshot, base64 PNG/JPEG) the client
  // renders inline — the MCP `image` content shape.
  content: Array<{ type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string }>
  structuredContent?: Record<string, unknown>
  isError?: boolean
}

/**
 * Who is calling over the gateway, as far as the connection declared.
 *
 * `studio-agent`/`external-local` arrive on the owner-only local socket and
 * their identity is advisory. `remote-tailnet` arrives on the opt-in tailnet
 * listener, where the transport proved which paired device is calling before
 * dispatch — `deviceId`, `deviceName`, and `peerNode` are set by the app, not
 * by the caller.
 */
export type McpConnectionMetadata = {
  kind: 'studio-agent' | 'external-local' | 'remote-tailnet'
  workspaceId?: string
  agentId?: string
  agentName?: string
  cliId?: string
  deviceId?: string
  deviceName?: string
  peerNode?: string
}

export type McpConnectionContext = {
  metadata: McpConnectionMetadata
}

/**
 * One MCP tool contributed to the always-on Studio gateway. `inputSchema` is a
 * JSON Schema object; array-typed fields must stay arrays end to end. Tool
 * names are a public contract for agents — pick stable, module-prefixed names.
 */
export type McpToolRegistration = {
  name: string
  description: string
  inputSchema: Record<string, unknown>
  /**
   * Declares that the tool CHANGES state. The Studio gateway reads it for two
   * decisions: a remote (tailnet) caller must hold `<family>:operate` rather
   * than the read-only `<family>:read` to invoke it, and every call — including
   * one refused for want of that scope — is written to the gateway audit with
   * the calling device. Omitted or false means a read: advertised to every
   * paired device on the read scope and not audited. Declare it on anything
   * that writes to disk, spawns a process, or reconfigures the machine.
   */
  mutates?: boolean
  handler: (args: Record<string, unknown>, context?: McpConnectionContext) => Promise<McpToolResult>
}

// ── Skills a module ships ────────────────────────────────────────────────────

/**
 * Where a skill must land in a workspace.
 *
 * - `'agents'` — the harness-neutral `.agents/skills/<id>` directory only.
 *   Enough for a skill an agent discovers by reading the directory.
 * - `'all-native'` — additionally every installed CLI plugin's own native
 *   skill directory (`.claude/skills`, `.codex/skills`, …). Required when the
 *   skill is invoked by name in a prompt, because a CLI resolves an invocation
 *   only against its own directory.
 */
export type ModuleSkillTargetPolicy = 'agents' | 'all-native'

/**
 * One skill your module ships. `sourceDir` is the directory holding the
 * skill's `SKILL.md` (plus its `agents/` sidecars, when it has them), relative
 * to your module root; the host resolves it and refuses a path that escapes
 * the root.
 *
 * `id` is the invocation name and must not collide with a built-in skill or
 * with a skill another module already registered.
 */
export type ModuleSkillRegistration = {
  id: string
  sourceDir: string
  targetPolicy: ModuleSkillTargetPolicy
  description: string
}

/**
 * The answer to "is this skill present in that workspace now?".
 *
 * `status` carries the installer's own vocabulary — `installed`, `updated`,
 * `local`, `modified`, `missing-source`, `missing-workspace`, `unknown-skill`,
 * `install-failed` — so you can tell "we wrote it" from "a hand-made copy is
 * in the way" from "nobody has ever heard of this skill".
 */
export type EnsureSkillInstalledResult = {
  ok: boolean
  status: string
  message?: string
}

// ── Launch contributions ─────────────────────────────────────────────────────

/** Path style of the launched shell, so a contribution can quote paths it can open. */
export type LaunchContributionPathStyle = 'posix' | 'windows' | 'wsl'

/**
 * What the host knows about this spawn when it asks modules to contribute.
 *
 * `knowledgeRoot` is a value the caller already resolved. Core does not
 * interpret it; the module that owns it reads it and writes env / session tags
 * itself.
 */
export type LaunchContributionRequest = {
  cli: string
  workspaceRoot: string
  sessionId: string
  agentId?: string
  agentKind?: string
  resume?: boolean
  /** Absolute Knowledge Graph root when the launch resolved one. */
  knowledgeRoot?: string
  /**
   * Path style of the launched shell. POSIX env uses `'posix'`; a native
   * Windows PTY uses `'windows'`; a WSL bootstrap uses `'wsl'` so the module
   * can quote paths the Linux shell can open.
   */
  pathStyle: LaunchContributionPathStyle
}

/** One managed-MCP server entry, in the shape `mcp-config-service` already takes. */
export type LaunchContributionMcpServer = {
  id: string
  name?: string
  command?: string
  args?: string[]
  env?: Record<string, string>
  url?: string
  transport?: string
}

export type LaunchContributionHostContextSection = {
  heading: string
  body: string
}

export type LaunchContributionSessionTag = {
  /** A module owns this session's lifetime (reaper recency-floor exclusion). */
  managed: boolean
  /** Hold this session out of the idle reaper entirely. */
  reapExempt?: boolean
}

export type LaunchContributionResult = {
  env?: Record<string, string>
  /** Directories prepended to `PATH`. The module writes its own shims here. */
  pathEntries?: string[]
  /** POSIX function definitions (and their `export -f`) appended to the shell bootstrap. */
  shellFunctions?: string[]
  mcpServers?: LaunchContributionMcpServer[]
  /** Sections appended to the host-context document after design-system and knowledge. */
  hostContext?: LaunchContributionHostContextSection[]
  session?: LaunchContributionSessionTag
  /**
   * Env keys the shell strips from inherited env before applying this
   * contribution, so a stale value from the app's own process cannot leak
   * into a spawn that did not set its own. Core always strips the
   * agent-identity keys; this list is in addition.
   */
  identityKeys?: string[]
}

export type LaunchContribution = (launch: LaunchContributionRequest) => LaunchContributionResult

export type MainHost = {
  /** The module currently registering; stamped by the host. */
  readonly moduleId: string
  /** Raw Electron ipcMain; typed `unknown` to keep the SDK Electron-free. */
  readonly ipcMain: unknown
  registerIpc(channel: string, handler: IpcInvokeHandler): void
  /**
   * Contribute MCP tools to the Studio gateway, owned by this module's id. A
   * tool name another module already registered is a registration error (the
   * whole batch is rejected). Availability follows the module's enablement
   * live: a disabled module's tools stay listed on the gateway and answer
   * calls with an actionable enable error instead of running. An MCP tool is
   * agent-reachable capability — declare the `ipc:agents` permission.
   */
  registerMcpTools(tools: McpToolRegistration[]): void
  /**
   * Contribute agent skills your module ships. Each `sourceDir` is relative to
   * your module root and must stay inside it. Registrations are owned exactly
   * as IPC channels and MCP tools are: an id a built-in skill or another
   * module already holds is a registration error, the whole batch is validated
   * before one skill of it lands, and unloading your module takes its skills
   * with it.
   *
   * A registered skill is a skill: an agent launched with `skill: { id }`
   * resolves it, and `targetPolicy: 'all-native'` fans it out into every
   * installed CLI's native skill directory the way a built-in does.
   */
  registerSkills(skills: ModuleSkillRegistration[]): void
  /**
   * Make a skill present in a workspace now, rather than at the next agent
   * launch — how you pre-install the skill an agent will be told to invoke.
   * Works for your own skills and for the app's. Never throws; an unknown id
   * answers `{ ok: false, status: 'unknown-skill' }`.
   */
  ensureSkillInstalled(workspaceRoot: string, skillId: string): Promise<EnsureSkillInstalledResult>
  provideService<T>(token: ServiceToken<T>, factory: (host: MainHost) => T): T
  getService<T>(token: ServiceToken<T>): T | undefined
  requireService<T>(token: ServiceToken<T>): T
  onStartup(hook: StartupHook): void
  /**
   * Run early, before the host tears down shared infrastructure. Use it to stop
   * self-scheduled loops and flip a shutting-down flag so no new work is
   * dispatched during teardown; defer awaiting in-flight work to `onShutdown`.
   * Begin hooks run in registration order, opposite `onShutdown`.
   */
  onShutdownBegin(hook: ShutdownBeginHook): void
  onShutdown(hook: ShutdownHook): void
  /**
   * Declare a sidecar this module owns. The registration is a declaration:
   * the host lists it but does not spawn it (only first-party modules hand the
   * host a lifecycle).
   */
  registerSidecar(spec: SidecarSpec): SidecarHandle
  /**
   * Contribute env, PATH shims, shell functions, managed-MCP server entries,
   * host-context sections and a session lifetime tag to every agent launch.
   * Called per spawn in module registration order; a throw is recorded as a
   * module diagnostic and skipped — it never fails the launch. A disabled or
   * absent module contributes nothing. Declare `ipc:agents`.
   */
  registerLaunchContribution(contribution: LaunchContribution): void
  /**
   * Surface a user-visible status notification. Identity is stamped from this
   * host's scope; emission is flood-bounded per module.
   */
  notify(input: ModuleNotifyInput): void
  /**
   * Push an event to your module's renderer half — the subscribe verb the
   * request/response bridge does not have. The receiving end is
   * `RendererHost.subscribe(topic, cb)`.
   *
   * Identity is stamped from this host's scope, so only your module's
   * subscribers receive it and you can never emit as another module. An empty
   * or over-128-character topic throws. The payload crosses IPC and must be
   * structured-cloneable.
   *
   * Delivery contract:
   * - **Fan-out** — one emit reaches every open window; the channel has no
   *   addressing, so per-window state is yours to key on.
   * - **Ordering** — FIFO per module: a `started` never lands after its `done`.
   * - **No replay** — an event emitted with no window open is dropped, and a
   *   window opened later sees nothing earlier. Events are signals, not state:
   *   keep the durable answer readable through an IPC channel and let events
   *   say "read it again". A subscriber must be correct having missed every
   *   event before it subscribed.
   * - **No flood bound** — unlike `notify`, nothing is dropped for rate;
   *   emitting sanely is your module's responsibility.
   */
  emit(topic: string, payload?: unknown): void
}

/** The export contract of `entry.main`: `export function registerMain(host) { … }`. */
export type RegisterMain = (host: MainHost) => void

// ── Workspace service (host-provided, consumed via the service bridge) ────────

export type WorkspaceCreateInput = {
  /** Workspace display name. */
  name?: string
  /** Absolute folder to open in the workspace. */
  folderPath?: string
  /** Layout template id; defaults to the standard template when omitted. */
  templateId?: string
}

export type WorkspaceCreateResult = { ok: true; workspaceId: string } | { ok: false; code: string; message: string }

/**
 * Programmatic workspace creation, provided by the app core. A creation runs
 * the same renderer flow the UI uses and is confirmed on the workspace-sync bus
 * before it resolves, so the returned id is always a real, observed workspace.
 */
export type WorkspaceService = {
  create(input: WorkspaceCreateInput): Promise<WorkspaceCreateResult>
}

/**
 * Resolve with `host.requireService(WorkspaceServiceToken)` from a module's
 * `entry.main`. Provided by the agent-runtime core — declare
 * `dependsOn: ['agent-runtime']` (or a chain reaching it) or resolve inside
 * handlers rather than at the top of `registerMain`, so registration order
 * can't race the provider.
 */
export const WorkspaceServiceToken: ServiceToken<WorkspaceService> =
  createServiceToken<WorkspaceService>('core.workspace')

/**
 * Read-only workspace snapshot: the id → root/name/mode resolution modules
 * need for per-workspace persistence keys and scoped services. A snapshot,
 * not a subscription — live session/workspace observation is a separate
 * surface.
 */
export type ModuleWorkspaceView = {
  id: string
  name: string
  /**
   * Absolute folder the workspace opened (its primary checkout); null for
   * folderless workspaces. Note for worktree-backed workspaces (an automation
   * run with `runInWorktree`, and whatever else a module opens): the agents work
   * in a git worktree under this folder — this snapshot deliberately reports the
   * durable project root (the right base for persistence and scoped services),
   * not the transient worktree.
   */
  folderPath: string | null
  /** Workspace type id ('standard' or a module-registered type). */
  mode: string
}

/**
 * Resolve a workspace id to its read-only view from `entry.main`. A null
 * resolution means "not currently resolvable" — an unknown id, or workspace
 * state that has not re-hydrated yet (e.g. right after app launch). Never a
 * throw, and never a deletion signal: retry later instead of discarding
 * per-workspace state. Declare the `ipc:workspace-read` permission
 * (install-time disclosure). The renderer twin is `RendererHost.getWorkspace`.
 */
export type WorkspaceContextService = {
  get(workspaceId: string): Promise<ModuleWorkspaceView | null>
  /**
   * Every workspace currently open, in registry order. The main-side twin of
   * `RendererHost.listWorkspaces`, and the only way `entry.main` can answer
   * "which project roots are open" — an MCP tool your module contributes runs
   * with no window and no renderer to ask.
   */
  list(): Promise<ModuleWorkspaceView[]>
}

/**
 * Resolve with `host.requireService(WorkspaceContextToken)` from a module's
 * `entry.main`. Provided by the agent-runtime core — declare
 * `dependsOn: ['agent-runtime']` (or a chain reaching it) or resolve inside
 * handlers rather than at the top of `registerMain`, so registration order
 * can't race the provider.
 */
export const WorkspaceContextToken: ServiceToken<WorkspaceContextService> =
  createServiceToken<WorkspaceContextService>('core.workspace-context')

// ── Automations providers (host-provided, consumed via the service bridge) ────

export type JsonSchema = Record<string, unknown>

export type AutomationStatus = 'enabled' | 'paused' | 'blocked'

export type AutomationRunStatus = 'queued' | 'running' | 'completed' | 'failed' | 'blocked' | 'skipped'

export type TriggerKind = 'schedule' | string

export type ScheduleTriggerConfig = {
  kind: 'schedule'
  cadence:
    | { type: 'interval'; everyMinutes: number }
    | { type: 'daily'; timeLocal: string }
    | { type: 'weekly'; timeLocal: string; daysOfWeek: number[] }
    /**
     * One-shot: run once at `datetime` — ISO-8601 local wall-clock
     * (`YYYY-MM-DDTHH:mm`, seconds optional and ignored, NO trailing `Z` or
     * offset; the config's `timezone` field is the sole timezone authority,
     * matching daily/weekly). Once the fire time passes, `computeNextRun`
     * returns null and the automation never fires again — it stays listed
     * with no upcoming run. A past datetime is valid and simply never fires.
     * A wall-clock that falls in a DST spring-forward gap resolves to the
     * first instant after the gap, the same rule daily/weekly use.
     */
    | { type: 'at'; datetime: string }
    | { type: 'cron'; expression: string }
  timezone: string
}

export type AutomationTriggerPollContext = {
  getSharedValue<T>(key: string, factory: () => Promise<T>): Promise<T>
}

export type AutomationTriggerPollEvent = {
  id: string
  occurredAt: string
  payload: Record<string, unknown>
}

export type AutomationTriggerPollResult =
  { ok: true; events: AutomationTriggerPollEvent[] } | { ok: false; blockedReason: string }

/**
 * Bundled action kinds the host ships, plus module-namespaced kinds
 * (`<module-id>.<suffix>`). The union stays open so a compiled module can
 * register its own kinds; the literals document the ones the panel already
 * knows how to author.
 */
export type ActionKind = 'spawn-agent' | 'run-command' | 'run-skill-loop' | string

/**
 * Closed vocabulary of Automations panel type-glyphs. The panel draws these
 * shapes; a module names one rather than shipping SVG. `agent` is a
 * head-and-shoulders figure, `loop` is the repeat arrows, `board` is a
 * four-pane board, `clock` is the automations clock (and the fallback for an
 * omitted glyph).
 */
export const AUTOMATION_PROVIDER_GLYPHS = ['agent', 'loop', 'board', 'clock'] as const
export type AutomationProviderGlyph = (typeof AUTOMATION_PROVIDER_GLYPHS)[number]

/**
 * When a definition pairs this trigger with `actionKind` and leaves
 * `disableAfterRun` unspecified, the write path applies `defaultDisableAfterRun`.
 * Used to bound ping-pong between a completion trigger and a start action
 * without the host naming either kind.
 */
export type AutomationTriggerPairing = {
  actionKind: ActionKind
  defaultDisableAfterRun?: boolean
}

export type AutomationTriggerProvider = {
  kind: TriggerKind
  /** Sentence-case family label the Automations panel shows. */
  label?: string
  glyph?: AutomationProviderGlyph
  /** One-line summary for the panel's supporting line. */
  summary?: string
  pairsWith?: AutomationTriggerPairing
  configSchema: JsonSchema
  requiredIntegrations?: string[]
  validateConfig?(config: unknown): { ok: true } | { ok: false; error: string }
  subscribe(input: { config: unknown; fire: (payload: Record<string, unknown>) => void; now: () => number }): () => void
  computeNextRun?(config: unknown, after: number): number | null
  poll?(input: {
    config: unknown
    workspaceRoot: string
    now: () => number
    context?: AutomationTriggerPollContext
  }): Promise<AutomationTriggerPollResult>
}

export type AutomationRunIsolation = 'worktree' | 'workspace-checkout'

export type AutomationRun = {
  id: string
  automationId: string
  status: AutomationRunStatus
  dueAt: string
  startedAt: string | null
  completedAt: string | null
  blockedReason?: string
  workspaceId?: string
  agentId?: string
  /**
   * Terminal-session executionId of the spawned agent, resolved at launch-confirm
   * time. Correlates an agent-lifecycle exit back to this run. Optional: historical
   * runs and resolution misses degrade to the poll-scan.
   */
  executionId?: string
  promptFingerprint?: string
  touchedFiles?: string[]
  commandsRan?: string[]
  summary?: string
  /**
   * Isolation the run actually got, stamped by the built-in agent-backed actions
   * at launch. `worktree` is the contained shape: its own worktree, its own
   * branch, and a pull request on completion. `workspace-checkout` is the
   * deliberate opt-out (`runInWorktree: false`): the agent ran in the user's own
   * checkout, so the run has no branch and opens no pull request. Absent on
   * historical runs and on runs that never launched an agent — read it, not the
   * absence of {@link worktreePath}, to tell a contained run from an uncontained
   * one without re-reading the definition.
   */
  isolation?: AutomationRunIsolation
  /** Git worktree the agent-backed run executes in (per-run isolation). */
  worktreePath?: string
  /** Branch the run's worktree is checked out on. */
  branch?: string
  /** Pull request opened for the run's branch on completion, when available. */
  pullRequestUrl?: string
  /** Report files the run produced, project-relative and contained under `reports/`. */
  reportPaths?: string[]
}

export type AutomationCliPermissionPreset = 'none' | 'manual' | 'auto' | 'bypass'

export type ActionContext = {
  automationId: string
  runId: string
  workspaceRoot: string
  triggerPayload: Record<string, unknown>
  spawnAgent(input: {
    workspaceId?: string
    folderPath: string
    cli?: string
    cliModel?: string
    permissionPreset?: AutomationCliPermissionPreset
    worktreePath?: string
    name?: string
    prompt: string
  }): Promise<{ workspaceId: string; agentId: string }>
  runCommand(input: { command: string[]; cwd: string }): Promise<{ code: number; output: string }>
  reportProgress(patch: Partial<AutomationRun>): void
  requireIntegration(id: string): void
}

export type AutomationActionProvider = {
  kind: ActionKind
  /** Sentence-case label the Automations panel shows for this action. */
  label?: string
  glyph?: AutomationProviderGlyph
  /** One-line summary for the panel's supporting line. */
  summary?: string
  configSchema: JsonSchema
  requiredIntegrations?: string[]
  run(config: unknown, ctx: ActionContext): Promise<Partial<AutomationRun>>
}

type AutomationsProviderRegistry = {
  registerTriggerProvider(moduleId: string, provider: AutomationTriggerProvider): string
  registerActionProvider(moduleId: string, provider: AutomationActionProvider): string
}

const automationsProviderRegistryToken: ServiceToken<AutomationsProviderRegistry> =
  createServiceToken<AutomationsProviderRegistry>('automations.provider-registry')

export function registerAutomationTrigger(host: MainHost, provider: AutomationTriggerProvider): string {
  return host.requireService(automationsProviderRegistryToken).registerTriggerProvider(host.moduleId, provider)
}

export function registerAutomationAction(host: MainHost, provider: AutomationActionProvider): string {
  return host.requireService(automationsProviderRegistryToken).registerActionProvider(host.moduleId, provider)
}

// ── Scoped Automations service (owned CRUD + run events) ─────────────────────

export type AutomationDefinition = {
  id: string
  name: string
  status: AutomationStatus
  trigger: { kind: TriggerKind; config: unknown }
  condition?: { kind: string; config: unknown }
  action: { kind: ActionKind; config: unknown }
  /**
   * The capability module that created this automation through the SDK's
   * scoped Automations service; absent ⇒ user-owned. Stamped server-side from
   * the creating module's identity — never accepted from the renderer — and
   * immutable thereafter (patches cannot carry it). The user outranks the
   * module: panel edits to module-owned automations stay allowed; only the
   * module service enforces ownership.
   */
  ownerModuleId?: string
  /**
   * Whether an agent-backed run executes in its own per-run git worktree (branch
   * isolation from the user's checkout, and the prerequisite for opening a PR —
   * a non-worktree run has no branch to review). Absent ⇒ true, so existing
   * automations keep running in a worktree.
   */
  runInWorktree?: boolean
  /**
   * Runtime-only bridge for definitions written before `autonomyDefault` was
   * retired (2026-07-30) whose author set it to `review_only`. That intent —
   * report, do not fix — now lives in the automation's prompt, so the store read
   * translates the retired key into this marker and the launch prompt carries a
   * write-up-only instruction. Host-populated and never persisted: a module must
   * not send it, and it is stripped again on write, so it exists only between a
   * legacy file's read and the run it starts.
   */
  legacyWriteUpOnly?: true
  /**
   * Run once, then pause: after one triggered fire (schedule due-run, skipped
   * overdue run, webhook or polling trigger event) the definition transitions to
   * `status: 'paused'`; re-enabling arms it again. A manual "Run now" never
   * consumes the shot — the flag means "after one *triggered* fire". Absent ⇒
   * false. Works for every trigger kind; orthogonal to the `at` cadence's own
   * natural exhaustion.
   */
  disableAfterRun?: boolean
  /**
   * The marketplace catalogue entry this automation was added from, and that
   * entry's publisher. Provenance only: stamped once by the marketplace install
   * path and immutable thereafter (patches cannot carry either field), so the
   * shelf can answer "is this already added" for a project and open the record
   * the entry produced. Distinct from `ownerModuleId`, which is module identity
   * and governs who may write the record — a catalogue automation is the user's
   * the moment it lands, and survives uninstalling the plugin that shipped it.
   */
  sourceCatalogueId?: string
  sourcePublisher?: string
  nextRunAt: string | null
  lastRunAt: string | null
  lastRunId: string | null
  createdAt: string
  updatedAt: string
}

export type AutomationDefinitionDraft = {
  id?: string
  name: string
  status: AutomationStatus
  trigger: { kind: TriggerKind; config: unknown }
  condition?: { kind: string; config: unknown }
  action: { kind: ActionKind; config: unknown }
  runInWorktree?: boolean
  disableAfterRun?: boolean
  /**
   * Owning module for drafts created through the SDK's scoped Automations
   * service. Optional echo of the creating module's own id — a draft claiming
   * a different module is refused, and ownership is always stamped by the
   * host. The user-facing IPC create path ignores it entirely.
   */
  ownerModuleId?: string
  /**
   * Catalogue provenance for drafts created by the marketplace install path.
   * Stamped by the host from the bundle being installed — like `ownerModuleId`,
   * never read off a caller-supplied payload.
   */
  sourceCatalogueId?: string
  sourcePublisher?: string
}

export type AutomationDefinitionPatch = Partial<
  Omit<AutomationDefinitionDraft, 'id' | 'ownerModuleId' | 'sourceCatalogueId' | 'sourcePublisher'>
>

export type AutomationRunEventStatus = Extract<AutomationRunStatus, 'completed' | 'failed' | 'blocked'>
export type AutomationRunEventTrigger = 'timer' | 'manual'

export type AutomationsRunEvent = {
  automationId: string
  runId: string
  workspaceId: string
  agentId?: string
  definitionName: string
  status: AutomationRunEventStatus
  trigger: AutomationRunEventTrigger
}

export type ModuleAutomationsError =
  'invalid_draft' | 'invalid_workspace' | 'not_found' | 'not_owner' | 'store_error' | 'engine_unavailable'

export type ModuleAutomationsResult<T> =
  ({ ok: true } & T) | { ok: false; code: ModuleAutomationsError; message: string }

/**
 * Owned automation CRUD + run events for a module's `entry.main`, obtained via
 * `getAutomationsService(host)`. Every method is pre-scoped to your module:
 * `create` stamps `ownerModuleId`, mutations refuse records your module does
 * not own (`not_owner` — user-created automations included), `list` returns
 * only owned records, and `onRunEvent` fires only for owned automations.
 * Declare the `automations.manage` permission (install-time disclosure) and
 * `dependsOn: ['automations']` so the service exists before your entry runs.
 */
export type ModuleAutomationsService = {
  /** Create an automation owned by this module (`ownerModuleId` is stamped). */
  create(input: {
    workspaceRoot: string
    draft: AutomationDefinitionDraft
  }): Promise<ModuleAutomationsResult<{ automation: AutomationDefinition }>>
  update(input: {
    workspaceRoot: string
    automationId: string
    patch: AutomationDefinitionPatch
  }): Promise<ModuleAutomationsResult<{ automation: AutomationDefinition }>>
  delete(input: { workspaceRoot: string; automationId: string }): Promise<ModuleAutomationsResult<object>>
  /** Automations this module owns in the workspace (never other modules' or the user's). */
  list(input: { workspaceRoot: string }): Promise<ModuleAutomationsResult<{ automations: AutomationDefinition[] }>>
  listRuns(input: {
    workspaceRoot: string
    automationId: string
  }): Promise<ModuleAutomationsResult<{ runs: AutomationRun[] }>>
  /** Subscribe to run events for automations this module owns. Returns the unsubscriber; call it in `onShutdown`. */
  onRunEvent(listener: (event: AutomationsRunEvent) => void): () => void
}

type AutomationsModuleRegistry = {
  create(
    moduleId: string,
    input: { workspaceRoot: string; draft: unknown },
  ): Promise<ModuleAutomationsResult<{ automation: AutomationDefinition }>>
  update(
    moduleId: string,
    input: { workspaceRoot: string; automationId: string; patch: unknown },
  ): Promise<ModuleAutomationsResult<{ automation: AutomationDefinition }>>
  delete(
    moduleId: string,
    input: { workspaceRoot: string; automationId: string },
  ): Promise<ModuleAutomationsResult<object>>
  list(
    moduleId: string,
    input: { workspaceRoot: string },
  ): Promise<ModuleAutomationsResult<{ automations: AutomationDefinition[] }>>
  listRuns(
    moduleId: string,
    input: { workspaceRoot: string; automationId: string },
  ): Promise<ModuleAutomationsResult<{ runs: AutomationRun[] }>>
  onRunEvent(moduleId: string, listener: (event: AutomationsRunEvent) => void): () => void
}

const automationsModuleServiceToken: ServiceToken<AutomationsModuleRegistry> =
  createServiceToken<AutomationsModuleRegistry>('automations.module-service')

/**
 * The scoped Automations service for `host`'s module. The raw host registry
 * takes a module id on every call; this helper closes over `host.moduleId`
 * exactly like `registerAutomationTrigger`/`registerAutomationAction`.
 */
export function getAutomationsService(host: MainHost): ModuleAutomationsService {
  const registry = host.requireService(automationsModuleServiceToken)
  const moduleId = host.moduleId
  return {
    create: (input) => registry.create(moduleId, input),
    update: (input) => registry.update(moduleId, input),
    delete: (input) => registry.delete(moduleId, input),
    list: (input) => registry.list(moduleId, input),
    listRuns: (input) => registry.listRuns(moduleId, input),
    onRunEvent: (listener) => registry.onRunEvent(moduleId, listener),
  }
}

// ── Companion agents (host-provided, consumed via the service bridge) ─────────

/**
 * A companion agent's status: the conversation-session vocabulary plus
 * `absent` — never spawned, or already disposed (not present in the projection).
 */
export type CompanionAgentStatus =
  'starting' | 'ready' | 'active' | 'awaiting_approval' | 'stopped' | 'failed' | 'absent'

/**
 * A canonical conversation event as delivered to a companion's `onEvent`.
 * Secret-shaped payload keys are redacted before delivery. `type` is widened to
 * `string` so new app event kinds never break compiled modules.
 */
export type CompanionAgentEvent = {
  id: string
  sessionId: string
  workspaceId: string
  agentId: string
  providerId: string
  modelId: string
  type: string
  createdAt: number
  payload?: Record<string, unknown>
}

export type CompanionAgentSpec = {
  workspaceId: string
  /** Stable, module-chosen id (e.g. 'review-guide'); the projection key. */
  agentId: string
  /** Display name in the Sessions popover. */
  name: string
  /** Absolute workspace folder (the main process has no id → folder registry). */
  workspaceRoot: string
  /** Engine selection; defaults resolve to the workspace's harness CLI/model. */
  engine?: { cli?: string; model?: string }
  /** Advisory context roots; the provider resolves knowledge from workspaceRoot. */
  contextRoots?: { knowledge?: boolean }
  /** Standing instructions, delivered as a preamble on the first turn. */
  systemPrompt: string
}

export type CompanionValidateResult<T> = { ok: true; value: T } | { ok: false; errors: string[] }

export type CompanionRunStructuredOptions<T> = {
  prompt: string
  validate: (raw: unknown) => CompanionValidateResult<T>
  /** Validator errors are fed back to the agent and the turn retried. Default 1. */
  retries?: number
  onPhase?: (phase: string) => void
}

export type CompanionAgentHandle = {
  readonly workspaceId: string
  readonly agentId: string
  /** Folds from the same conversation-session projection the Sessions popover reads. */
  status(): CompanionAgentStatus
  onStatus(cb: (status: CompanionAgentStatus) => void): () => void
  /** Run a structured JSON task: extract final JSON, validate, retry-once, return typed. */
  runStructured<T>(opts: CompanionRunStructuredOptions<T>): Promise<T>
  /** A chat turn on the session's own transport. */
  send(message: string): Promise<void>
  onEvent(cb: (event: CompanionAgentEvent) => void): () => void
  interrupt(): void
  /** Ends the session; the handle becomes inert. Re-attach spawns a fresh one. */
  dispose(): void
}

/**
 * Workspace-bound background agents for a module's `entry.main`, obtained via
 * `getCompanionAgentsService(host)`. `attach` NEVER spawns — it returns a handle
 * in `absent` status; the first `runStructured`/`send` (a live user intent)
 * spawns, so reopening a workspace never auto-starts a companion. A second
 * `attach` with the same (workspaceId, agentId) returns the SAME handle.
 *
 * Declare the `agents:companion` permission (the service checks it at attach
 * time and throws if absent) and `dependsOn: ['agent-runtime']` so the service
 * exists before your entry runs.
 */
export type CompanionAgentsService = {
  attach(spec: CompanionAgentSpec): CompanionAgentHandle
}

type CompanionAgentsRegistry = {
  attach(moduleId: string, spec: CompanionAgentSpec): CompanionAgentHandle
}

const companionAgentsModuleServiceToken: ServiceToken<CompanionAgentsRegistry> =
  createServiceToken<CompanionAgentsRegistry>('companion-agents.module-service')

/**
 * The scoped Companion Agents service for `host`'s module. The raw host registry
 * takes a module id on every call; this helper closes over `host.moduleId`
 * exactly like `getAutomationsService`.
 */
export function getCompanionAgentsService(host: MainHost): CompanionAgentsService {
  const registry = host.requireService(companionAgentsModuleServiceToken)
  const moduleId = host.moduleId
  return {
    attach: (spec) => registry.attach(moduleId, spec),
  }
}

// ── Agent sessions (host-provided, consumed via the service bridge) ──────────

/**
 * A terminal agent session as a module sees it: the coordinates it needs to
 * address the session again, and the liveness facts it needs to decide whether
 * to. Deliberately narrower than the app's own session snapshot — identity and
 * liveness, never scrollback, cwd, or file-change telemetry.
 */
export type ModuleAgentSessionRecord = {
  sessionId: string
  agentId: string | null
  name: string | null
  cli: string | null
  workspaceId: string | null
  executionId: string | null
  /** The pty is running and not frozen by the idle reaper. */
  isLive: boolean
  suspended: boolean
  reapExempt: boolean
  startedAt: number
}

export type ModuleAgentSpawnRequest = {
  /**
   * The workspace the agent belongs to. Required: a module surface is always
   * opened FROM somewhere, and an agent parked in a workspace nobody named is
   * one the user cannot find again.
   */
  workspaceId: string
  /** Absolute working directory for the agent's terminal. */
  cwd: string
  /** Agent CLI plugin id. Absent takes the user's last-selected CLI. */
  cli?: string
  /** Model id for CLIs declaring modelSelection; forwarded verbatim. */
  cliModel?: string
  /** Delivered as the opening turn on a fresh spawn, or pasted into a reused one. */
  prompt: string
  /**
   * A skill the host installs into the working directory before the CLI starts.
   * An id the host cannot resolve fails the spawn with `unknown_skill` rather
   * than starting an agent without the instructions it was meant to run on.
   * The CLI-native invocation comes back as `skillInvocation` for the prompt to
   * lead with.
   */
  skill?: { id: string }
  /** Session-manager label for the terminal. Absent picks a name from the shared pool. */
  label?: string
  /**
   * The agent's identity: `${agentIdPrefix}${agentIdKey}`. The prefix must be a
   * namespace this module registered; the key is whatever the module keys its
   * agents by (a review id, a document id). Stable across spawns, which is what
   * `reuseLive` and `list()` match on. Absent mints an app-owned id.
   */
  agentIdPrefix?: string
  agentIdKey?: string
  /**
   * The launch permission preset. Absent takes the user's configured default —
   * never an escalation the module chose for them.
   */
  permissionPreset?: 'none' | 'manual' | 'auto' | 'bypass'
  /**
   * Deliver the prompt to a live session under the same agent id instead of
   * spawning a second one (`reused: true`). Default true; a dead or suspended
   * session under that id is disposed and replaced either way.
   */
  reuseLive?: boolean
  /** Free-form role ('review-guide'). Accepted; the host does not record it today. */
  role?: string
}

export type ModuleAgentSpawnResult =
  | {
      ok: true
      sessionId: string
      agentId: string
      executionId: string
      workspaceId: string
      cli: string
      reused: boolean
      /**
       * The CLI-native explicit invocation for the requested skill (`/review-guide`
       * on Claude, `Use $review-guide.` on Codex). Absent when no skill was asked
       * for, or when this CLI's plugin declares no native skill form — point the
       * agent at the installed `.agents/skills/<id>/SKILL.md` instead.
       */
      skillInvocation?: string
    }
  | {
      ok: false
      code:
        | 'unknown_workspace'
        | 'missing_cwd'
        | 'no_cli_selected'
        | 'cli_not_agent_selectable'
        | 'unknown_skill'
        | 'spawn_failed'
        | 'send_failed'
        | 'permission_missing'
      message: string
    }

/** A module agent's terminal ended. Fans out from the runtime's own exit report. */
export type ModuleAgentExitEvent = {
  agentId: string | null
  executionId: string
  workspaceId: string | null
  exitCode: number
}

/**
 * Terminal agent sessions for a module's `entry.main`, obtained via
 * `getAgentSessionService(host)`.
 *
 * Declare the `agents:session` permission — every method here checks it — and
 * `dependsOn: ['agent-runtime']` so the service exists before your entry runs.
 */
export type ModuleAgentSessionService = {
  spawn(request: ModuleAgentSpawnRequest): Promise<ModuleAgentSpawnResult>
  /** One prompt into a live session, submitted as a turn, serialized per session. */
  send(sessionId: string, text: string): Promise<{ ok: boolean; message?: string }>
  kill(sessionId: string): void
  /**
   * Hold a session out of the idle reaper's reach while it is mid-task. The
   * host clears the exemption when that session exits, so a module that never
   * balances its own call cannot leave an unsuspendable pty behind.
   */
  setReapExempt(sessionId: string, exempt: boolean): void
  onExit(listener: (event: ModuleAgentExitEvent) => void): () => void
  /** Only sessions whose agent id starts with a prefix this module owns. */
  list(): ModuleAgentSessionRecord[]
}

type AgentSessionsRegistry = {
  spawn(moduleId: string, request: ModuleAgentSpawnRequest): Promise<ModuleAgentSpawnResult>
  send(moduleId: string, sessionId: string, text: string): Promise<{ ok: boolean; message?: string }>
  kill(moduleId: string, sessionId: string): void
  setReapExempt(moduleId: string, sessionId: string, exempt: boolean): void
  onExit(moduleId: string, listener: (event: ModuleAgentExitEvent) => void): () => void
  list(moduleId: string): ModuleAgentSessionRecord[]
}

const agentSessionsModuleServiceToken: ServiceToken<AgentSessionsRegistry> = createServiceToken<AgentSessionsRegistry>(
  'agent-sessions.module-service',
)

/**
 * The scoped Agent Sessions service for `host`'s module. The raw host registry
 * takes a module id on every call; this helper closes over `host.moduleId`
 * exactly like `getCompanionAgentsService`.
 */
export function getAgentSessionService(host: MainHost): ModuleAgentSessionService {
  const registry = host.requireService(agentSessionsModuleServiceToken)
  const moduleId = host.moduleId
  return {
    spawn: (request) => registry.spawn(moduleId, request),
    send: (sessionId, text) => registry.send(moduleId, sessionId, text),
    kill: (sessionId) => registry.kill(moduleId, sessionId),
    setReapExempt: (sessionId, exempt) => registry.setReapExempt(moduleId, sessionId, exempt),
    onExit: (listener) => registry.onExit(moduleId, listener),
    list: () => registry.list(moduleId),
  }
}

// ── Module storage (host-provided, consumed via the service bridge) ──────────

export type ModuleStorageErrorCode =
  'invalid_key' | 'invalid_value' | 'value_too_large' | 'invalid_workspace_root' | 'io_error'

export type ModuleStorageResult<T> = ({ ok: true } & T) | { ok: false; code: ModuleStorageErrorCode; message: string }

/**
 * Per-module, per-workspace JSON storage, scoped to your module by
 * `getModuleStorage(host)`. The host owns file placement — workspace-scoped
 * keys live in the workspace's app-owned folder (`.sprintengine/modules/<moduleId>/`),
 * global keys under the app's per-user data — so modules stop inventing
 * locations (home-dir files, raw localStorage). Keys match
 * `^[a-z0-9][a-z0-9._-]{0,63}$`; values must be JSON-serializable and at most
 * 1 MB; writes are atomic (write-then-rename). Pass `workspaceRoot` (absolute;
 * resolve it via the workspace context) for workspace-scoped keys, omit it for
 * the module's global store. Declare the `storage` permission (install-time
 * disclosure). Renderer panels reach storage through the module's own
 * `host.invoke` channels.
 */
export type ModuleStorageService = {
  /** `found: false` (with `value: undefined`) when the key has never been set. */
  get(input: { key: string; workspaceRoot?: string }): Promise<ModuleStorageResult<{ value: unknown; found: boolean }>>
  set(input: { key: string; value: unknown; workspaceRoot?: string }): Promise<ModuleStorageResult<object>>
  delete(input: { key: string; workspaceRoot?: string }): Promise<ModuleStorageResult<{ deleted: boolean }>>
  /** Keys in the scope, sorted; an empty store lists `[]`, never an error. */
  list(input?: { workspaceRoot?: string }): Promise<ModuleStorageResult<{ keys: string[] }>>
}

// The moduleId-first registry the app provides; derived from the published
// service so the two shapes cannot drift.
type ModuleStorageRegistry = {
  [K in keyof ModuleStorageService]: (
    moduleId: string,
    ...args: Parameters<ModuleStorageService[K]>
  ) => ReturnType<ModuleStorageService[K]>
}

const moduleStorageToken: ServiceToken<ModuleStorageRegistry> =
  createServiceToken<ModuleStorageRegistry>('core.module-storage')

/**
 * The scoped storage service for `host`'s module. The raw host registry takes
 * a module id on every call; this helper closes over `host.moduleId` exactly
 * like `getAutomationsService`. Provided by the agent-runtime core — declare
 * `dependsOn: ['agent-runtime']` (a chain that reaches it, e.g.
 * `['automations']`, also works) so your `entry.main` registers after the
 * provider; without the dependency edge, load order is alphabetical and a
 * top-of-registerMain call can race the provider and fail your module's load.
 */
export function getModuleStorage(host: MainHost): ModuleStorageService {
  const registry = host.requireService(moduleStorageToken)
  const moduleId = host.moduleId
  return {
    get: (input) => registry.get(moduleId, input),
    set: (input) => registry.set(moduleId, input),
    delete: (input) => registry.delete(moduleId, input),
    list: (input) => registry.list(moduleId, input),
  }
}

// ── Renderer host (entry.renderer) ───────────────────────────────────────────

/**
 * Props passed to a contributed workspace panel. (The app may pass additional
 * shell-internal props not in the v1 SDK surface.)
 */
export type WorkspacePanelProps = {
  workspaceId: string
}

/** Eager component or React.lazy() wrapper; both render the same way. */
export type WorkspacePanelComponent =
  ComponentType<WorkspacePanelProps> | LazyExoticComponent<ComponentType<WorkspacePanelProps>>

export type WorkspaceTypeIconComponent = ComponentType<{ className?: string }>

export type WorkspaceTypeTopBarView = {
  component: string
  name: string
}

export type PreviewSlot = {
  x: number
  y: number
  w: number
  h: number
  type: 'agent' | 'editor' | 'explorer'
  label: string
}

// A conservative subset of the FlexLayout JSON model the app's workspace
// layouts use. Anything expressible here is a valid app layout; the app
// accepts more (borders, extra attributes) than the SDK exposes in v1.
export type LayoutTabJson = {
  type: 'tab'
  id?: string
  name?: string
  component?: string
  config?: unknown
}

export type LayoutTabSetJson = {
  type: 'tabset'
  id?: string
  weight?: number
  enableTabStrip?: boolean
  children: LayoutTabJson[]
}

export type LayoutRowJson = {
  type: 'row'
  id?: string
  weight?: number
  children: Array<LayoutRowJson | LayoutTabSetJson>
}

export type LayoutGlobalJson = {
  tabSetEnableDrop?: boolean
  tabEnableClose?: boolean
}

export type WorkspaceLayoutJson = {
  global?: LayoutGlobalJson
  layout: LayoutRowJson
}

export type WorkspaceLayoutTemplate = {
  id: string
  name: string
  description: string
  previewSlots: PreviewSlot[]
  layout: WorkspaceLayoutJson
}

/**
 * A supervisor is a render-nothing React component the shell mounts for your
 * workspace type — the home for background renderer logic (auto-run loops,
 * pollers, sync). Lifecycle: `'global'` mounts one instance in the primary
 * window while your module is enabled (whether or not one of your workspaces
 * is open); `'all-windows'` mounts one instance per window. Unmounted when
 * the module is disabled. The shell mounts supervisors inside a crash
 * boundary and a display:none host: a throw is contained (logged, supervisor
 * unmounted) and returned markup is never shown — return null. A
 * supervisor may only touch published SDK surfaces — its power is exactly
 * what the rest of the SDK exposes.
 */
export type WorkspaceTypeSupervisorScope = 'global' | 'all-windows'

export type WorkspaceTypeSupervisorComponent = ComponentType | LazyExoticComponent<ComponentType>

export type WorkspaceTypeSupervisor = {
  Component: WorkspaceTypeSupervisorComponent
  scope: WorkspaceTypeSupervisorScope
}

/**
 * The published, stable subset of the shell's sidebar-status vocabulary. The
 * app's own vocabulary is wider and grows; module glyphs stick to this core
 * so a compiled module never emits a state the running shell can't draw.
 */
export type WorkspaceRunGlyphState =
  'todo' | 'ready' | 'in_progress' | 'paused' | 'needs_input' | 'done' | 'failed' | 'archived'

/** The sidebar row's one status slot: lifecycle state, liveness, plain label. */
export type WorkspaceRunGlyph = {
  state: WorkspaceRunGlyphState
  /** Adds the live pulse — only while something is actually running. */
  live: boolean
  /** Plain-language status, e.g. "2 scheduled today" or "Waiting on a reply". */
  label: string
}

/**
 * The read view a run-glyph provider derives from. Deliberately minimal: the
 * provider owns its module's state and consults it synchronously (e.g. a
 * cache its supervisor maintains); the shell supplies only the identity.
 */
export type WorkspaceRunGlyphInput = {
  mode: string
}

/** Confirm copy for a type-contributed sidebar row action. */
export type WorkspaceTypeRowActionConfirm = {
  title: string
  body: string
  confirmLabel: string
  cancelLabel?: string
}

/**
 * The workspace fields a type's sidebar status hooks may read. The shell
 * passes a richer row; this is identity plus the module bag.
 */
export type WorkspaceTypeSidebarWorkspace = {
  id: string
  name: string
  mode: string
  moduleState?: Record<string, unknown>
}

/**
 * Extra context-menu item on a sidebar row of this type. Gone with the
 * module; never a disabled core row. `confirm` opens the shell's confirm
 * modal before `run`.
 */
export type WorkspaceTypeRowAction = {
  id: string
  label: string
  variant?: 'danger'
  isVisible?: (workspace: WorkspaceTypeSidebarWorkspace) => boolean
  confirm?: (workspace: { name: string }) => WorkspaceTypeRowActionConfirm
  run: (workspaceId: string) => void | Promise<void>
}

/**
 * A module-owned config step in the workspace-creation hub. One step per type
 * (v1): the hub renders it as the flow's one config page after the shared
 * name/folder fields, holds the value for the pane's lifetime only (nothing
 * persists shell-side), and hands it to `createTemplate(context)` on create.
 * A throwing Component degrades to the type's zero-config flow with an inline
 * notice — it never blocks the hub.
 */
export type WorkspaceCreationStepProps = {
  value: unknown
  setValue: (value: unknown) => void
}

export type WorkspaceCreationStepComponent =
  ComponentType<WorkspaceCreationStepProps> | LazyExoticComponent<ComponentType<WorkspaceCreationStepProps>>

export type WorkspaceTypeCreationStep = {
  id: string
  /** Page title in the hub pane. */
  heading: string
  /** One-line page subtitle. */
  description?: string
  Component: WorkspaceCreationStepComponent
  /** Gates the Create button; absent means the step never blocks creation. */
  isReady?: (value: unknown) => boolean
  /** Footer hint while isReady is false, e.g. "Name a city to forecast." */
  blockedHint?: string
}

/** Context handed to `createTemplate` on create. */
export type WorkspaceTypeCreateContext = {
  /** The module creation step's collected value; undefined without a step. */
  stepValue?: unknown
}

/**
 * What the creation hub hands your type's async create hook.
 * `createTemplate` is synchronous by design — it answers "what layout?" — so a
 * type whose creation is real orchestration (probe a source, materialize it on
 * disk, roll back on failure) puts that work in `createWorkspace` instead.
 */
export type WorkspaceTypeCreateRequest = {
  /** The name field's value, untrimmed. Empty means the user named nothing. */
  name: string
  /** The materialized folder. The hub creates/opens it before calling. */
  folderPath: string
  /** The creation step's collected value; undefined without a step. */
  stepValue?: unknown
  /**
   * Write back into your creation step's value. Your step owns that page's
   * body, and the step value is the state both halves share — so a hook that
   * fails puts the reason here and the step renders it, rather than throwing
   * prose at a generic error surface.
   */
  setStepValue: (value: unknown) => void
}

/**
 * The shell capabilities an async create hook may use. Deliberately two: mint
 * this type's workspace, and take it back.
 */
export type WorkspaceTypeCreateHost = {
  /**
   * Create the workspace from your `createTemplate` and return its id — the
   * same row the zero-config path would have made. `name` overrides the
   * request's (use it for your own fallback); the step value reaches
   * `createTemplate` either way.
   */
  createWorkspace(input?: { name?: string }): string
  /** Remove a workspace this hook created. The rollback half of the pair. */
  removeWorkspace(workspaceId: string): void
}

/**
 * A contributed workspace type.
 */
export type WorkspaceTypeDefinition = {
  id: string
  label: string
  description: string
  icon: WorkspaceTypeIconComponent
  accentToken?: string
  searchTerms?: string[]
  createTemplate(context?: WorkspaceTypeCreateContext): WorkspaceLayoutTemplate
  /**
   * Open once after this type's first enabled, trusted renderer load. Creates
   * a folderless workspace from createTemplate, or focuses an existing one.
   * Only zero-config types (no creationStep/createWorkspace hook) support this.
   * Closing it does not reopen it on the next launch; use host.openWorkspace
   * in an explicit command to let users reopen it. Newly installed/trusted
   * renderer-only modules load immediately; main/preload modules and updates
   * to already evaluated code require a restart.
   */
  openOnFirstLoad?: boolean
  /**
   * Own this type's create action. When present the hub calls this instead of
   * creating the workspace itself: resolve to mean "created, close the hub";
   * reject to leave the hub open with the create still available. Call
   * `host.createWorkspace()` to mint the row (that is what runs
   * `createTemplate`) and `host.removeWorkspace(id)` to roll it back — a
   * create that fails after minting must not leave an empty workspace behind.
   * Absent ⇒ the hub creates from `createTemplate` directly.
   */
  createWorkspace?(request: WorkspaceTypeCreateRequest, host: WorkspaceTypeCreateHost): Promise<void>
  topBarViews?: {
    label: string
    views: WorkspaceTypeTopBarView[]
  }
  /**
   * Background renderer components the shell mounts for this type (see
   * WorkspaceTypeSupervisor). Useful together with the live-runtime surfaces —
   * a supervisor with nothing observable is a no-op.
   */
  supervisors?: WorkspaceTypeSupervisor[]
  /**
   * Sidebar status for workspaces of this type. Called for workspaces whose
   * mode equals this type's id (the mode's own provider always wins the
   * dispatch); return null for "no run signal" — the shell falls back to its
   * recency text. Note: while your type ships this hook, collapsed sidebar
   * rows defer their terminal-derived attention dot to your provider — a
   * null return reads as "genuinely resting", so return a `needs_input`
   * glyph when your module wants the user's attention. Synchronous — derive
   * from module state you already hold, not from IPC.
   */
  deriveRunGlyph?(workspace: WorkspaceRunGlyphInput): WorkspaceRunGlyph | null
  /**
   * Label for this type's create control (picker, hub). Absent ⇒ `label`.
   * When `createWorkspace` is present, that control runs the hook instead of
   * minting from `createTemplate`.
   */
  createLabel?: string
  /** Glyph beside the sidebar row title for workspaces of this type. */
  RowMark?: WorkspaceTypeIconComponent
  /** Extra context-menu items on this type's sidebar rows. */
  rowActions?: WorkspaceTypeRowAction[]
  /** The type's config step in the creation hub (one per type in v1). */
  creationStep?: WorkspaceTypeCreationStep
  creationStepsId?: string
  pickerOrder?: number
  /**
   * Keep the type registered (so its runtime workspaces still resolve, render,
   * and get created programmatically) but withhold those workspaces from the
   * normal workspace rail — Projects list, keyboard switch targets, and
   * command-palette results. For a type whose own door surface took over
   * finding and steering the workspaces, so listing them again under one
   * project would claim they belong there. Hidden means hidden from
   * DISCOVERY: the workspace stays in the store, in window assignments, and
   * explicitly activatable. The rail analog of `hiddenFromPicker`.
   */
  hiddenFromRail?: boolean
}

// ── Backlog contributions ────────────────────────────────────────────────────

export type BacklogItemStatus = 'idea' | 'ready' | 'in_progress' | 'needs_input' | 'completed' | 'archived'
// `pending` is lifecycle-neutral: the work is recorded but has not started.
export type BacklogItemLinkStatus = 'pending' | 'active' | 'completed' | 'canceled' | 'failed' | 'unknown'

export type BacklogItemLink = {
  id: string
  moduleId: string
  type: 'execution' | 'issue' | 'review' | 'artifact' | 'external' | 'agent'
  label: string
  target: {
    kind: string
    id: string
    path?: string
    url?: string
  }
  status?: BacklogItemLinkStatus
  updatedAt?: string
}

export type BacklogResolvedLink = BacklogItemLink & {
  status: BacklogItemLinkStatus
  unavailableReason?: string
  canOpen?: boolean
}

/**
 * Read view of a Backlog item as handed to module callbacks. Enumerated app
 * internals (triage axes) are widened to `string` so new app values
 * never break compiled modules.
 */
export type BacklogItemView = {
  id: string
  path: string
  relativePath: string
  title: string
  status: BacklogItemStatus
  type?: string
  difficulty?: string
  criticality?: string
  metadata: Record<string, unknown>
  links: BacklogItemLink[]
  excerpt: string
  sourceContent: string
}

export type BacklogItemActionCategory = 'execute' | 'analyze' | 'transform' | 'publish' | 'review' | 'organize'

export type BacklogItemActionContext = {
  workspaceId: string
  workspaceRoot: string
  item: BacklogItemView
  readSource(): Promise<string>
  updateStatus(status: BacklogItemStatus): Promise<void>
  addLink(link: BacklogItemLink): Promise<void>
  updateModuleMetadata(moduleId: string, value: unknown): Promise<void>
}

export type BacklogItemActionState = 'enabled' | 'disabled'

export type BacklogItemAction = {
  id: string
  label: string
  category: BacklogItemActionCategory
  /**
   * Position within the Backlog menus — the row's right-click menu and the
   * detail header's More-actions menu — sorted by `order` then label. It does
   * not earn a header button; those belong to the shell.
   */
  order?: number
  isVisible?: (context: BacklogItemActionContext) => boolean
  getState?: (context: BacklogItemActionContext) => BacklogItemActionState
  run: (context: BacklogItemActionContext) => void | Promise<void>
}

export type BacklogLinkProviderInput = {
  workspaceId: string
  workspaceRoot: string
  item: BacklogItemView
  link: BacklogItemLink
}

export type BacklogLinkProvider = {
  /** Must equal the registering module's id. */
  moduleId: string
  /** Link target kinds this provider owns; a kind has exactly one owner. */
  targetKinds: string[]
  resolveLinkStatus(input: BacklogLinkProviderInput): Promise<BacklogResolvedLink>
  openLink?(input: BacklogLinkProviderInput): Promise<void | boolean>
}

// ── File Explorer actions ────────────────────────────────────────────────────

/**
 * One selected Files-tree row as handed to `registerFileAction` callbacks.
 * Directories, git-deleted rows and ordinary files all appear; visibility is
 * the action's to decide.
 */
export type FileActionEntry = {
  name: string
  path: string
  isDir: boolean
  gitDeleted?: boolean
}

export type FileActionContext = {
  workspaceId: string
  workspaceRoot: string
  entries: readonly FileActionEntry[]
}

export type FileActionState = 'enabled' | 'disabled'

/**
 * A Files-tree context-menu action. Sibling of `BacklogItemAction`: the
 * explorer renders enabled-module contributions under a heading named for
 * the module, gone entirely when the module is absent — never a disabled
 * core row. Sorted by `order` then label within the group.
 */
export type FileAction = {
  id: string
  label: string
  order?: number
  /** Selection-aware display label; falls back to `label` when absent. */
  getLabel?: (context: FileActionContext) => string
  isVisible?: (context: FileActionContext) => boolean
  getState?: (context: FileActionContext) => FileActionState
  run: (context: FileActionContext) => void | Promise<void>
}

// ── Commands ─────────────────────────────────────────────────────────────────

export type CommandScope =
  | 'global'
  | 'workspace'
  | 'workspace-navigation'
  | 'editor'
  | 'terminal'
  | 'panel'
  // Open scope family: `panel:<moduleId>` is active while a workspace whose
  // mode belongs to that module is active — the shell derives it from the
  // workspace-type registry, so your module's commands can gate on "my
  // workspace is active" without a shell enum change. A module that registers
  // the workspace type `weather-deck` gates its commands on
  // `panel:weather-deck`.
  | (string & {})

export type CommandAvailability =
  | 'always'
  | 'activeWorkspace'
  | 'activeFile'
  | 'memoryGraphEnabled'
  | 'canvasEnabled'
  | 'gitPanelActive'
  | 'terminalActive'
  | 'diagnosticsEnabled'
  | 'automationsEnabled'
  // Open at the type level so new shell conditions never break a compiled
  // module; an unknown condition reads as unsatisfied (fail closed). Prefer
  // an availability predicate for module-specific gating.
  | (string & {})

/**
 * The published context view a module availability predicate is evaluated
 * against. Deliberately tiny — extended only by demonstrated need; anything a
 * module knows about its own state it checks inside the predicate itself.
 */
export type ModuleCommandContext = {
  activeWorkspaceId: string | null
  activeWorkspaceMode: string | null
}

/**
 * A command contributed by a module. The registered id is namespaced
 * `<moduleId>.<id>`; the handler callback travels with the definition.
 */
export type ModuleCommandDefinition = {
  /** Bare command id; the registered id becomes `<moduleId>.<id>`. */
  id: string
  title: string
  /** Grouping label in the palette and Shortcuts settings. */
  category: string
  /**
   * `panel:<moduleId>` gates on "a workspace whose mode belongs to my module
   * is active" — derived by the shell from the workspace-type registry.
   */
  scopes: readonly CommandScope[]
  defaultKeybindings?: readonly string[]
  /**
   * Either shell availability preconditions, or a predicate over the
   * published `ModuleCommandContext` view — "offer this only when…" without
   * a shell enum change. With no context wired (early boot) a
   * predicate-gated command is unavailable, never a silent no-op.
   */
  availability?: readonly CommandAvailability[] | ((context: ModuleCommandContext) => boolean)
  allowInEditableTarget?: boolean
  run: () => void | Promise<void>
}

// ── Settings sections ────────────────────────────────────────────────────────

export type SettingsSectionProps = {
  values: Readonly<Record<string, unknown>>
  /** Persist one value in the module's namespace; `undefined` deletes the key. */
  setValue: (key: string, value: unknown) => void
}

export type SettingsSectionComponent =
  ComponentType<SettingsSectionProps> | LazyExoticComponent<ComponentType<SettingsSectionProps>>

/** Icons follow the house glyph pattern: 24×24 viewBox, currentColor strokes. */
export type SettingsSectionIconComponent = ComponentType<{ className?: string }>

export type SettingsSectionDefinition = {
  id: string
  label: string
  description?: string
  icon: SettingsSectionIconComponent
  Component: SettingsSectionComponent
  order?: number
}

// ── Sidebar nav entries ──────────────────────────────────────────────────────

export type SidebarNavEntryRenderProps = {
  /** The sidebar is collapsed to the icon rail; render icon-only with a tooltip. */
  collapsed: boolean
}

export type SidebarNavEntryComponent =
  ComponentType<SidebarNavEntryRenderProps> | LazyExoticComponent<ComponentType<SidebarNavEntryRenderProps>>

/**
 * A top-nav door your module contributes to the workspace sidebar's
 * instance-level nav cluster (the band holding New chat, Automations,
 * Connectors). The entry is a self-contained row component that owns its full
 * behavior — a status dot, an open action against the local window's store,
 * active state. The sidebar shows it only while your module is enabled and
 * places it by `order`, so the toggle adds/removes the door without a reload.
 */
export type SidebarNavEntryDefinition = {
  id: string
  /** Sort key in the top-nav cluster; lower renders first. Built-in doors reserve 0–30. */
  order: number
  Component: SidebarNavEntryComponent
}

/**
 * A waiting-count your module contributes for a drawer / nav-entry row. The
 * shell merges this with that row's unread bell news; the contribution is
 * gone with the module, so a count with no row never appears.
 */
export type DoorBadgeContribution = {
  /** Matches your sidebar nav entry id / the shell's drawer row id. */
  rowId: string
  /** Live items on this door waiting on the operator. Not a React hook. */
  getWaitingCount(): number
  subscribe(onChange: () => void): () => void
  /**
   * Notification source whose unnamed rows fall to this door. An emitter that
   * knows the row still sets `extensionsRow` on the notification itself.
   */
  notificationSource?: string
}

// ── Top bar items ────────────────────────────────────────────────────────────

export type TopBarItemComponent = ComponentType | LazyExoticComponent<ComponentType>

/**
 * A control your module contributes to the app's top bar (the title-strip
 * control cluster). The item is a self-contained zero-prop component that owns
 * its full behavior — state, tooltip, action — exactly like the shell's own
 * controls; the host only owns placement and gating. The bar shows it only
 * while your module is enabled and orders contributed items by `order`, so the
 * toggle adds/removes the control without a reload. The top bar is dense:
 * contribute a single compact control (an icon button), not a cluster.
 */
export type TopBarItemDefinition = {
  id: string
  /** Sort key among contributed top-bar items; lower renders first, ties break on id. */
  order: number
  Component: TopBarItemComponent
}

// ── Global door surfaces ─────────────────────────────────────────────────────

export type GlobalSurfaceComponent = ComponentType | LazyExoticComponent<ComponentType>

/** The glyph the shell's chrome draws when it names your surface. */
export type SurfaceIconComponent = ComponentType<{ className?: string }>

/**
 * Where your door's own rail goes while the door is open.
 *
 *   `sidebar` (the default) — your rail REPLACES the app sidebar's column for
 *   the length of the visit. Right when the rail is a list the person walks
 *   and is the navigation while your surface is open.
 *
 *   `inline` — your rail renders inside the card region beside your canvas and
 *   the sidebar column keeps whatever it was showing. Right when the column
 *   ALREADY holds the navigation that reached you: taking it would delete the
 *   very list the person is navigating with.
 */
export type SurfaceRailPlacement = 'sidebar' | 'inline'

/**
 * One row of the shell's Extensions drawer, for a surface that is several
 * destinations to the person rather than one. A surface with no `views` (the
 * common case) contributes a single row named by its own `label` and `Icon`.
 * You own each row's name, glyph and how the surface lands on it; the shell
 * owns only where the rows sit.
 */
export type SurfaceViewDefinition = {
  /**
   * Unique within your surface. Publish this id while the surface is showing
   * this view, so exactly one of your rows reads selected.
   */
  id: string
  /** The row's label and accessible name. Non-empty; sentence case. */
  label: string
  /** The row's glyph; the shell sizes it via className. */
  Icon: SurfaceIconComponent
  /**
   * Land the surface on this view. Runs BEFORE the shell opens the surface, so
   * a deep-link latch set here is drained by your surface as it mounts. This
   * replaces `onOpen` for a view row: a view IS a target, so there is no stale
   * latch to discard.
   */
  open: () => void
}

/**
 * The full-page surface behind a top-level door. A global surface is a
 * first-class extension point: it is instance-global, needs no workspace
 * type, panel, or project scope, and owns its own data and layout. Pair it
 * with a sidebar nav entry whose open action routes to the same `id` — the
 * shell mounts the surface over the workspace card region when that door
 * opens, gated on your module's live enablement. The component is zero-prop,
 * eager or `React.lazy()`. While your module is uninstalled or disabled, the
 * shell renders an explicit "not installed" door in its place and keeps the
 * user's spot; re-enabling restores the surface without a reload.
 *
 * Everything but `id` and `Component` is optional, and every optional field is
 * about PRESENTATION — how the shell's own chrome names and places your
 * surface (Extensions drawer ruling, 2026-09-05). A door that draws its own
 * row through `registerSidebarNavEntry` can omit them all, as it always could.
 */
export type GlobalSurfaceDefinition = {
  /** Matches the id the door opens. Non-empty; unique across all modules. */
  id: string
  /**
   * Your surface's user-facing name — the drawer row's label, the door bar's
   * fallback title, and the "not installed" explainer's heading. Decoupled
   * from the id. Non-empty when given; omit it if your own nav-entry component
   * names the surface instead.
   */
  label?: string
  /** The glyph for chrome that names your surface. Optional for the same reason `label` is. */
  Icon?: SurfaceIconComponent
  /**
   * Called just before the shell opens your surface from a PLAIN opener — a
   * rail glyph, a drawer row, a history step — one landing on your default
   * view. Discard stale deep-link latches here. Deep-link openers dispatch
   * their own state and bypass this.
   */
  onOpen?: () => void
  /** The drawer rows your one surface offers, when it is more than one destination. */
  views?: readonly SurfaceViewDefinition[]
  /** Where your door's rail goes. Defaults to `sidebar`. */
  railPlacement?: SurfaceRailPlacement
  Component: GlobalSurfaceComponent
}

// ── Modal surfaces ───────────────────────────────────────────────────────────

export type ModalSurfaceIconComponent = ComponentType<{ className?: string }>

/**
 * A modal surface your module contributes — a pick-and-close task floated over
 * work that stays put. The shell mounts your body inside its own modal shell
 * over whatever the window is showing: it owns the modal chrome (width step,
 * flat scrim — never a backdrop blur — focus trap, Escape/scrim close, and a
 * title bar carrying `label` and the one close), and your component owns only
 * the body, zero-prop, eager or `React.lazy()`. While your module is disabled
 * an open modal closes; re-enabling restores it without a reload.
 *
 * **You open it.** The shell renders no trigger for a modal surface. It used to
 * put a glyph button for each one in the sidebar footer's settings cluster
 * (doors→modals, 2026-09-01); the Extensions-drawer ruling of 2026-09-05 sent
 * every destination the shell's own chrome offers back to being a DOOR, and
 * took the cluster with it — a modal is now reached from inside the content it
 * floats over (a pane launcher, a row action, a notification's Open), which is
 * the shape a modal is for. Contribute the trigger yourself from wherever that
 * is, and call `openModalSurface(id)`.
 *
 * **Except one trigger the shell does draw for you.** `launcher` puts your
 * surface's row in the workspace pane's kind list — the strip's "+" menu and
 * the pane's empty-state launcher, beside Browser, Terminal and Diff — which
 * is where a workspace-scoped modal is reached for. Picking it opens your
 * modal and hands your body the workspace it was picked in.
 *
 * `order` and `Icon` are what the retired cluster read, and they are optional
 * for that reason: nothing renders them today. They are kept rather than
 * deleted so a module that already declares them still compiles, and so a
 * future trigger surface has the fields it would need.
 */
export type ModalSurfaceDefinition = {
  /** Non-empty; unique across all modules. */
  id: string
  /** Sort key among registered modal surfaces; lower first, ties break on id. Nothing renders this today. */
  order?: number
  /** The dialog's accessible name and its bar title. Non-empty; sentence case. */
  label: string
  /** A glyph for chrome that names this surface. Nothing renders this today. */
  Icon?: ModalSurfaceIconComponent
  /**
   * Called just before the shell opens this modal from a plain opener — one
   * landing on the surface's default view. Discard stale deep-link latches
   * here. Deep-link openers dispatch their own state and bypass this.
   */
  onOpen?: () => void
  /**
   * Contribute your surface's row to the workspace pane's kind list. Omit it
   * and the shell draws no trigger at all — you open the modal yourself from
   * wherever makes sense.
   */
  launcher?: ModalSurfaceLauncher
  /** The modal body. */
  Component: ModalSurfaceComponent
}

/**
 * What the shell hands a modal body: the workspace its opener acted from, when
 * the opener had one (the pane row passes the workspace it was picked in; a
 * command or a notification passes none). A modal floats over the window
 * rather than mounting inside a workspace card, so this is what tells your
 * surface which workspace it is acting on — do not fall back to "the active
 * one", which can change under an open modal.
 *
 * A zero-prop component still satisfies `ModalSurfaceComponent`, so ignore the
 * prop if your surface is app-level.
 */
export type ModalSurfaceComponentProps = {
  workspaceId?: string
}

export type ModalSurfaceComponent =
  ComponentType<ModalSurfaceComponentProps> | LazyExoticComponent<ComponentType<ModalSurfaceComponentProps>>

/**
 * The pane row your modal surface contributes. The workspace pane lists the
 * kinds a workspace can open — Browser, Terminal, Files, Diff, Git, Backlog —
 * and this appends yours, in the "+" menu and in the pane's empty-state
 * launcher, drawn exactly like the shell's own.
 */
export type ModalSurfaceLauncher = {
  /** The row's name, e.g. "Reviews". Non-empty; sentence case. */
  label: string
  /**
   * The key that opens your row while the menu or the launcher has focus.
   * EXACTLY one character (uppercased by the host); anything else is a
   * registration error. The shell's own kinds win a collision: a letter
   * already taken by a built-in row (B, T, F, D, G, L) — or by a module row
   * registered before yours — leaves your row with its label and glyph and no
   * shortcut at all, rather than stealing a key the person already knows.
   */
  letter: string
  /** The row's mark, in both the menu and the launcher card. */
  Glyph: ModalSurfaceIconComponent
}

// ── Agent id namespaces ──────────────────────────────────────────────────────

/**
 * An agent-id namespace your module claims. A module that spawns agents outside
 * a window's knowledge — a background guide, a companion — owns ids the shell
 * then has to reason about without knowing whose they are: what to call the
 * session when no workspace claims it, and whether the id is one it may adopt
 * onto a workspace. This is how it asks you instead of guessing.
 */
export type AgentIdNamespaceDefinition = {
  /**
   * Every agent id starting with this belongs to your module. Keep it
   * distinctive and terminated (`'review-guide-'`, not `'review'`) so it cannot
   * swallow another module's ids. A prefix overlapping one already claimed is a
   * registration error.
   */
  prefix: string
  /**
   * What the shell calls sessions in this namespace that no workspace claims,
   * e.g. "Reviews". Sentence case; it is a group name in a session list.
   */
  label: string
}

// ── Live runtime surfaces (renderer) ─────────────────────────────────────────

export type WorkspaceFileWatchEvent = {
  relativePath: string
  /** File content after the change; null when the file does not exist. */
  content: string | null
}

/** The resolved surface of the app's active theme (`watchColorScheme`). */
export type ModuleColorScheme = 'light' | 'dark'

/** Read-only view of one live agent session (enum-ish fields widened to string). */
export type ModuleAgentSessionView = {
  /** The studio's terminal-tracking id (stable per session). */
  sessionId: string
  agentId: string | null
  /** Display name from spawn metadata, when known. */
  name: string | null
  /** Session kind ('terminal', 'agent', …). */
  kind: string
  /** Owning orchestration system tag, when the session belongs to one. */
  system: string | null
  /** The owning execution's id within its system, when the session belongs to one. */
  executionId: string | null
  /** True while the underlying process is alive (false when suspended/exited). */
  isLive: boolean
}

/** One model a runtime offers, as a picker row. */
export type ModuleAgentRuntimeModelOption = {
  /** Model id to pass as `spawnAgent`'s `cliModel`. */
  id: string
  /** Display label; falls back to the id when the catalog names none. */
  label: string
}

export type ModuleAgentRuntimeOption = {
  /** Runtime id to pass as `spawnAgent`'s `cli` (e.g. 'claude', 'codex'). */
  id: string
  /** Display label for pickers. */
  label: string
  /**
   * Whether this machine has the runtime's binary. Rows detected as missing
   * are still listed so your picker can show them disabled rather than
   * pretending the CLI does not exist; spawning one fails.
   */
  available: boolean
  /**
   * The model ids this runtime offers — the plugin manifest's list merged with
   * what the CLI reported about itself and the ids the user added, the same
   * rows the shell's own model picker shows. Empty means the runtime exposes
   * no model choice: omit `cliModel` and it launches with its own default.
   */
  models: ModuleAgentRuntimeModelOption[]
  /** True for the runtime the user last chose — what a picker should preselect. */
  isDefault: boolean
}

export type ModuleSpawnAgentInput = {
  workspaceId: string
  /** Display name for the agent tab; defaults to a shell-picked agent name. */
  name?: string
  /** Runtime id from `listAgentRuntimes()`; defaults to the user's last-used CLI. */
  cli?: string
  /** Model id for the runtime; omitted = the CLI's default model. */
  cliModel?: string
  /** Launch prompt handed to the agent once the session starts. */
  prompt?: string
  /** Focus the new agent's tab (default true). */
  focus?: boolean
}

export type ModuleSpawnAgentResult =
  | { ok: true; agentId: string }
  | { ok: false; code: 'unknown_workspace' | 'missing_folder' | 'unknown_runtime' | 'spawn_failed'; message: string }

export type ModuleFocusTabInput = {
  workspaceId: string
  kind: 'agent' | 'file'
  /** Agent id, or a workspace-relative file path. */
  id: string
}

// ── Notification Open actions (renderer) ─────────────────────────────────────

/**
 * The subset of a bell row a notification-action provider may read. The shell
 * passes a richer in-app notification; extra fields stay unpublished.
 */
export type NotificationActionView = {
  workspaceId?: string
  navigationTarget?: { kind: string; ref: string }
}

export type NotificationActionContext = {
  notification: NotificationActionView
  /** Shell capability: switch the active workspace in the current window. */
  revealWorkspace(workspaceId: string): void
}

export type NotificationAction = {
  id: string
  label: string
  isVisible?(context: NotificationActionContext): boolean
  run(context: NotificationActionContext): void | Promise<void>
}

export type NotificationActionProvider = {
  /** The notification source this provider owns — the emitter tag its module writes. */
  source: string
  resolveActions(context: NotificationActionContext): NotificationAction[]
}

// ── Renderer host registration contract ──────────────────────────────────────

export type RendererHost = {
  /**
   * Stable URL for a file packaged inside this trusted module (e.g. runtime/index.html).
   * Inside packaged HTML, relative resources, WebAssembly, workers and IndexedDB share a stable,
   * separate module origin. No leading slash, traversal, query or fragment in the path.
   * Available in Studio builds supporting module assets; trust/enablement is checked
   * on every request. Assets must be files under the installed module root (128 MiB max).
   */
  getAssetUrl(relativePath: string): string
  registerPanel(componentId: string, component: WorkspacePanelComponent): void
  registerWorkspaceType(definition: WorkspaceTypeDefinition): void
  /**
   * Create or focus a workspace of a type registered by this module. The type
   * must be enabled and zero-config (no creationStep/createWorkspace hook).
   * Creates from createTemplate with no folder and the type's label as name;
   * reuses an existing workspace of this type. Returns its id after opening.
   */
  openWorkspace(typeId: string): Promise<string>
  registerBacklogItemAction(action: BacklogItemAction): void
  registerBacklogLinkProvider(provider: BacklogLinkProvider): void
  /**
   * Contribute a Files-tree context-menu action. The explorer renders
   * enabled-module contributions under a heading named for this module, sorted
   * by `order` then label. Duplicate ids are a registration error. The row is
   * absent — not disabled — when this module is off.
   */
  registerFileAction(action: FileAction): void
  /**
   * Contribute Open actions for bell rows of `provider.source`. One provider
   * per source; a duplicate is a registration error. A provider that returns
   * no actions leaves the shell's generic workspace-reveal fallback in place.
   */
  registerNotificationActionProvider(provider: NotificationActionProvider): void
  registerCommand(definition: ModuleCommandDefinition): void
  registerSettingsSection(definition: SettingsSectionDefinition): void
  /**
   * Contribute a top-nav door to the workspace sidebar. Registered once at
   * boot; the sidebar filters by your module's enablement and orders by
   * `order`, so toggling your module shows/hides the door without a reload.
   */
  registerSidebarNavEntry(definition: SidebarNavEntryDefinition): void
  /**
   * Contribute the waiting-count a drawer / nav-entry row wears. The shell
   * merges this with that row's unread bell news; the contribution is gone
   * with the module. Duplicate `rowId` is a registration error.
   */
  registerDoorBadge(contribution: DoorBadgeContribution): void
  /**
   * Contribute a control to the app's top bar. Registered once at boot; the
   * bar filters by your module's enablement and orders by `order`, so
   * toggling your module shows/hides the control without a reload. An id
   * already claimed by another module is a registration error, reported as a
   * module load error that gates off your module's other contributions.
   */
  registerTopBarItem(definition: TopBarItemDefinition): void
  /**
   * Contribute the door-routed full-page surface behind a sidebar nav entry
   * with the same id. Registered once at boot; the shell gates the mount on
   * your module's enablement, so the toggle swaps the page for the explicit
   * "not installed" door (and back) without a reload. An id already claimed
   * by another module is a registration error, reported as a module load
   * error that gates off your module's other contributions.
   */
  registerGlobalSurface(definition: GlobalSurfaceDefinition): void
  /**
   * Contribute a modal surface: a body the shell mounts in its modal shell,
   * floated over whatever the window is showing. Registered once at boot; the
   * mount gates on your module's enablement, so the toggle closes an open
   * modal and restores it on re-enable without a reload. An id already
   * claimed by another module is a registration error, reported as a module
   * load error that gates off your module's other contributions.
   *
   * Declare `launcher` to put your surface's row in the workspace pane's kind
   * list; a malformed one (empty label, a `letter` that is not exactly one
   * character, a missing Glyph) is a registration error too.
   */
  registerModalSurface(definition: ModalSurfaceDefinition): void
  /**
   * The workspace's Backlog items as read-only views. Declare the
   * `backlog.read` permission (install-time disclosure). Mutations go through
   * `BacklogItemActionContext` (Backlog actions) or the item's file — never
   * through this read surface. Rejects when the backlog module is disabled.
   */
  listBacklogItems(workspaceId: string): Promise<BacklogItemView[]>
  /**
   * Observe the workspace's Backlog: `cb` fires once with the current
   * snapshot, then on every change (scans are debounced ~300ms behind file
   * edits). Returns the unsubscriber — call it when your panel unmounts.
   * Throws when the backlog module is disabled. Declare `backlog.read`.
   */
  watchBacklogItems(workspaceId: string, cb: (items: BacklogItemView[]) => void): () => void
  /**
   * Resolve a workspace id (e.g. from `WorkspacePanelProps.workspaceId`) to
   * its read-only view — the supported way to get a workspace's folder root,
   * name, and mode. A null resolution means "not currently resolvable" (an
   * unknown id, or the shell hasn't wired workspace state yet at early
   * boot) — never a throw, and never a deletion signal: retry later instead
   * of discarding per-workspace state. Declare the `ipc:workspace-read`
   * permission (install-time disclosure). The `entry.main` twin is
   * `WorkspaceContextToken`.
   */
  getWorkspace(workspaceId: string): Promise<ModuleWorkspaceView | null>
  /**
   * Every open workspace as a read-only view, in the order the shell lists
   * them — for a surface that is not mounted inside one workspace (a modal
   * floating over the window, a settings section) and so has no id to
   * resolve. Empty before the shell wires workspace state (early boot);
   * never a throw. Declare the `ipc:workspace-read` permission (install-time
   * disclosure).
   */
  listWorkspaces(): Promise<ModuleWorkspaceView[]>
  /**
   * Observe the open workspaces: `cb` fires once with the current list, then
   * on every change (deduped by value, so an unrelated store write does not
   * wake it). Returns the unsubscriber — call it on unmount. Before the shell
   * wires workspace state the first call reports an empty list. Declare
   * `ipc:workspace-read`.
   */
  watchWorkspaces(cb: (workspaces: ModuleWorkspaceView[]) => void): () => void
  /**
   * Observe the app's resolved light/dark surface: `cb` fires immediately
   * with the current scheme, then whenever it changes — an explicit theme
   * switch, or an OS switch while the preference follows the system. Returns
   * the unsubscriber; call it on unmount.
   *
   * This is for a themed runtime you HOST (Monaco's base theme, a chart
   * library's palette) — something that needs a concrete 'light' | 'dark'
   * rather than a CSS variable. Ordinary module UI should read THEME_TOKENS
   * instead and re-skin without JavaScript.
   */
  watchColorScheme(cb: (scheme: ModuleColorScheme) => void): () => void
  /**
   * Your module's entry in the workspace's per-module state bag — durable
   * state your module keeps on a workspace (view choices, selection, panel
   * config), persisted with the workspace and synced across windows. Scoped
   * to your module: one module can never read another's entry. `undefined`
   * means no state is recorded, the workspace id is unknown, or the shell
   * hasn't wired workspace state yet (early boot) — never a throw and never
   * a deletion signal; retry later instead of discarding state. Declare the
   * `storage` permission (install-time disclosure).
   */
  getWorkspaceModuleState<T = unknown>(workspaceId: string): T | undefined
  /**
   * Replace your module's entry in the workspace's per-module state bag;
   * null/undefined removes it. Keep entries JSON-serializable — they persist
   * into the workspace registry verbatim. False means the write was NOT
   * stored (unknown workspace id, or the shell hasn't wired workspace state
   * yet) — surface it or retry; never assume success. Declare the `storage`
   * permission (install-time disclosure).
   */
  setWorkspaceModuleState(workspaceId: string, state: unknown): boolean
  /**
   * Read one key from your module's APP-level state — the scope above
   * `getWorkspaceModuleState`, for state that belongs to your module rather
   * than to a single workspace: remembered defaults, the last thing the user
   * opened. Synchronous and store-backed, so a renderer selector can derive
   * from it without an IPC round trip changing render timing (which is why
   * this exists alongside the `entry.main` `ModuleStorageService`).
   * `undefined` means the key has never been set, or the shell has not wired
   * the store yet (early boot) — never a throw and never a deletion signal.
   * Scoped to your module: one module can never read another's. Persists with
   * app settings and survives a disable/enable cycle. It shares a keyspace with
   * your contributed Settings section's values, which are app-level module
   * state by another name. Declare the `storage` permission.
   */
  getModuleAppState<T = unknown>(key: string): T | undefined
  /**
   * Write one key in your module's app-level state; `undefined` deletes it.
   * Keep values JSON-serializable — they persist into app settings verbatim.
   * False means the write was NOT stored (empty key, or the shell has not
   * wired the store yet) — surface it or retry; never assume success. Declare
   * the `storage` permission.
   */
  setModuleAppState(key: string, value: unknown): boolean
  /**
   * Observe your module's app-level state: `cb` fires with the whole namespace
   * on every change (not on subscribe — read the current value with
   * `getModuleAppState`). Returns the unsubscriber; call it on unmount. Pair
   * the two with `useSyncExternalStore` for a reactive read.
   */
  watchModuleAppState(cb: (values: Readonly<Record<string, unknown>>) => void): () => void
  /**
   * Subscribe to events your `entry.main` pushed with `MainHost.emit` — the
   * subscribe verb `invoke` does not have. Scoped to your module: another
   * module's events never reach you, and yours never reach it. `cb` receives
   * the emitted payload. Returns the unsubscriber; call it on unmount.
   *
   * Nothing is replayed, so a subscriber must be correct having missed every
   * event emitted before it subscribed — read current state through
   * `invoke` and let events tell you when to read it again. Delivery stops
   * while your module is disabled and resumes when it is re-enabled.
   */
  subscribe(topic: string, cb: (payload: unknown) => void): () => void
  /**
   * Claim an agent-id namespace for your module: every agent id starting with
   * `prefix` is yours, and `label` is what the shell calls those sessions where
   * no workspace claims them. Without it, an agent your module spawned outside
   * a window's knowledge is an unlabelled, unadoptable session. Registered once
   * at boot; the shell gates on your module's live enablement. A prefix
   * overlapping one another module already claimed is a registration error,
   * reported as a module load error that gates off your other contributions.
   * Declare the `ipc:agents` permission.
   */
  registerAgentIdNamespace(definition: AgentIdNamespaceDefinition): void
  /**
   * The workspace's *effective working root*: where its live work happens.
   * `ModuleWorkspaceView.folderPath` deliberately reports the durable primary
   * checkout; a worktree-backed workspace (an automation run with
   * `runInWorktree`, for one) does live work under a worktree, and this
   * resolves that root. The live-runtime methods below
   * resolve workspace-relative paths against it. Null means "not currently
   * resolvable" — never a throw. Declare `ipc:workspace-read`.
   */
  getWorkingRoot(workspaceId: string): Promise<string | null>
  /**
   * Watch one workspace-relative file (resolved against the effective working
   * root): `cb` fires once with the current content (null when the file
   * doesn't exist), then debounced (~300ms) on every change. Rejects with a
   * named cause for absolute/escaping paths, unknown/folderless workspaces,
   * or a disabled Agent Runtime module. Keep the resolved closure and call it
   * on unmount. Declare `filesystem:read-workspace`.
   */
  watchWorkspaceFile(
    workspaceId: string,
    relativePath: string,
    cb: (event: WorkspaceFileWatchEvent) => void,
  ): Promise<() => void>
  /**
   * Observe live agent sessions: `cb` fires once with the current read-only
   * views, then on every change (deduped). Returns the unsubscriber — call it
   * on unmount. Throws with a named cause when agent runtime is unavailable.
   *
   * A workspace id watches that workspace's sessions, whoever spawned them.
   * `undefined` watches every workspace, narrowed to sessions whose agent id
   * falls in a namespace you claimed with `registerAgentIdNamespace` — which
   * is how you follow agents your own `entry.main` spawned without a
   * window's knowledge. Claim no namespace and the unscoped watch reports an
   * empty list; it is never a window onto other modules' sessions.
   * Declare `ipc:agents`.
   */
  watchAgentSessions(workspaceId: string | undefined, cb: (sessions: ModuleAgentSessionView[]) => void): () => void
  /**
   * Spawn an agent session through the app's SHARED session runtime (the
   * same path every shell surface uses) and add its tab to the workspace
   * layout. Structured result — expected failures (unknown workspace,
   * folderless workspace, unavailable runtime, spawn failure) never throw;
   * rejects only when agent runtime is unavailable. Declare `ipc:agents`.
   */
  spawnAgent(input: ModuleSpawnAgentInput): Promise<ModuleSpawnAgentResult>
  /**
   * Focus a workspace tab: an agent's terminal tab (added if missing) or a
   * file tab by workspace-relative path. False when not focusable; throws
   * with a named cause when agent runtime is unavailable.
   */
  focusTab(input: ModuleFocusTabInput): boolean
  /**
   * The agent runtimes available to spawn, from the same
   * availability-filtered catalog the shell's own pickers read: id, display
   * label, whether the binary is on this machine, the runtime's model rows,
   * and which one the user last chose. Plugin internals stay unexposed.
   * Throws with a named cause when agent runtime is unavailable.
   */
  listAgentRuntimes(): ModuleAgentRuntimeOption[]
  /**
   * Invoke an IPC channel this module's own `entry.main` registered via
   * `MainHost.registerIpc`, e.g. `host.invoke('my-module:save', data)`.
   *
   * The channel MUST start with `<moduleId>:` (your own module id); other
   * channel names throw before IPC happens. The host additionally routes only
   * to channels owned by a module whose manifest declares the `ipc:invoke`
   * permission. A refused invoke rejects with an Error whose
   * `code` property carries the `ModuleBridgeRefusalCode`, so callers can
   * branch on the refusal kind without parsing the message.
   *
   * This bridge is a contract, not a security boundary: all renderer code
   * shares one world. Trust gating (only `trusted` modules execute) remains
   * the actual boundary.
   */
  invoke(channel: string, payload?: unknown): Promise<unknown>
}

/**
 * Why the host refused a `RendererHost.invoke`, attached as `code` on the
 * rejection Error: the channel was never registered (`unknown_channel`), it is
 * not `<ownerModuleId>:`-prefixed (`not_bridgeable`), the owner manifest
 * could not be resolved (`not_bridgeable`), or the owner does not declare
 * `ipc:invoke` (`permission_missing`).
 */
export type ModuleBridgeRefusalCode = 'unknown_channel' | 'not_bridgeable' | 'permission_missing'

// ── File-drop drag-and-drop contract ─────────────────────────────────────────
// The payload the Backlog panel and Files tree put on a drag (and the terminal
// accepts). Published so a module can accept those drags — or originate
// compatible ones — against a drift-guarded contract instead of an internal
// MIME string. Self-contained mirror of the app's terminalDrop contract.

export const MULTICODE_FILE_DROP_MIME = 'application/x-multicode-file-drop'

export type FileDropPayload = {
  version: 1
  workspaceId: string | null
  rootPath: string
  files: Array<{
    path: string
    name: string
    isDir?: boolean
  }>
}

/** Put a file-drop payload on a drag the app's drop targets (terminals) accept. */
export function setFileDropData(dataTransfer: DataTransfer, payload: FileDropPayload): void {
  const fileText = payload.files.map((file) => file.path).join('\n')
  dataTransfer.effectAllowed = 'copy'
  dataTransfer.setData(MULTICODE_FILE_DROP_MIME, JSON.stringify(payload))
  dataTransfer.setData('text/plain', fileText)
}

/**
 * Whether a drag carries the studio's file-drop payload (or native OS files).
 * Use this during `dragover` — the HTML DnD protected mode blanks `getData`
 * there, so `readFileDropPayload` only works inside the `drop` handler.
 */
export function hasFileDropData(dataTransfer: DataTransfer): boolean {
  const types = Array.from(dataTransfer.types)
  return types.includes(MULTICODE_FILE_DROP_MIME) || types.includes('Files')
}

/**
 * Read the studio's file-drop payload off a drop event's dataTransfer. Returns
 * null — never throws — when the MIME entry is absent, the JSON is
 * unparseable, the version is unknown (future versions ⇒ null; handle it), or
 * the shape is invalid. A Backlog-item drag carries the item's markdown file
 * path in `files[0].path`, resolvable back to the item.
 */
export function readFileDropPayload(dataTransfer: DataTransfer): FileDropPayload | null {
  const raw = dataTransfer.getData(MULTICODE_FILE_DROP_MIME)
  if (!raw) return null

  try {
    const value = JSON.parse(raw) as Partial<FileDropPayload>
    if (
      value.version !== 1 ||
      (value.workspaceId !== null && typeof value.workspaceId !== 'string') ||
      typeof value.rootPath !== 'string'
    ) {
      return null
    }
    if (!Array.isArray(value.files)) return null

    // Entries are rebuilt, never passed through: an invalid or non-boolean
    // isDir is skipped, and unknown extra properties are dropped.
    const files: FileDropPayload['files'] = []
    for (const file of value.files) {
      if (
        !file ||
        typeof file.path !== 'string' ||
        file.path.trim().length === 0 ||
        typeof file.name !== 'string' ||
        (file.isDir !== undefined && typeof file.isDir !== 'boolean')
      ) {
        continue
      }
      files.push({
        path: file.path,
        name: file.name,
        ...(file.isDir === undefined ? {} : { isDir: file.isDir }),
      })
    }

    if (!files.length) return null
    return {
      version: 1,
      workspaceId: value.workspaceId,
      rootPath: value.rootPath,
      files,
    }
  } catch {
    return null
  }
}

// ── Theme tokens ─────────────────────────────────────────────────────────────

/**
 * The theme CSS custom properties guaranteed present in every app theme.
 * Consume them as CSS variables — Tailwind arbitrary values
 * (`bg-[var(--bg-surface)]`) or plain `var()` — so module UI re-skins with the
 * active theme automatically. Only the NAMES are contract: values differ per
 * theme and may be retuned in each release; never read or cache resolved values
 * in JS, and never hard-code a hex. `--focus-ring` is a full box-shadow value,
 * not a color. Presence is enforced per theme by a repo gate
 * (test:sdk:theme-tokens).
 */
export const THEME_TOKENS = [
  // Chrome (backgrounds)
  '--bg-app',
  '--bg-surface',
  '--bg-surface-raised',
  '--bg-hover',
  '--bg-selected',
  // Borders
  '--border-subtle',
  '--border-default',
  '--border-strong',
  // Text
  '--text-strong',
  '--text-default',
  '--text-muted',
  '--text-subtle',
  '--text-disabled',
  '--text-on-accent',
  // Accent + focus
  '--accent-primary',
  '--accent-primary-soft',
  '--focus-ring',
  // Semantic tones
  '--tone-neutral',
  '--tone-accent',
  '--tone-warn',
  '--tone-good',
  '--tone-error',
  '--tone-merged',
  // Motion. `--motion-normal` is a duration, `--motion-ease` a timing
  // function: use them together on a transition or animation so module UI
  // moves at the app's pace instead of inventing its own.
  '--motion-normal',
  '--motion-ease',
] as const

export type ThemeToken = (typeof THEME_TOKENS)[number]

/** The export contract of `entry.renderer`: `export function registerRenderer(host) { … }`. */
export type RegisterRenderer = (host: RendererHost) => void

// ── Manifest validation + canonical signing payload ──────────────────────────
// Pure (no Node APIs) and safe in any runtime. The ed25519 sign/verify
// functions need node:crypto and live behind the `./signing` subpath export.

export {
  canonicalManifestPayload,
  parseThirdPartyModuleManifest,
  validateCapabilityPermissions,
  validateThirdPartyModuleManifest,
  type PermissionValidationIssue,
  type PermissionValidationResult,
  type ThirdPartyManifestIssue,
  type ThirdPartyManifestResult,
} from './manifest-validate.js'

// ── BYO-CLI plugin authoring (kind: 'cli') ───────────────────────────────────
// A CLI plugin is a separate artifact from a capability module: a `plugin.json`
// dropped into ~/.multicode/plugins/<id>/ that teaches the studio a new agent
// CLI. Pure validator + types, safe in any runtime.

export {
  parseCliPluginManifest,
  validateCliPluginManifest,
  type CliArgvToken,
  type CliAuthSpec,
  type CliCapabilities,
  type CliCompletionMode,
  type CliCompletionSpec,
  type CliContextInjection,
  type CliContextInjectionMode,
  type CliLaunchSpec,
  type CliManifestIssue,
  type CliManifestResult,
  type CliMcpConfigFormat,
  type CliMcpConfigSpec,
  type CliModelOption,
  type CliModelSelectionSpec,
  type CliPermissionPreset,
  type CliPluginManifest,
  type CliPromptInjection,
  type CliPromptInjectionMode,
  type CliReadinessSignal,
  type CliResumeSpec,
  type CliSkillFormat,
  type CliSkillInstallScope,
  type CliSkillInstallTarget,
  type CliSkillIntegration,
  type CliSkillInvocation,
  type CliSkillSupport,
  type CliVariableDecl,
  type CliVariableType,
} from './cli-manifest.js'

// ── Marketplace plugin bundle authoring ─────────────────────────────────────
// A marketplace plugin is a signed bundle manifest (`plugin.json`) that points
// at existing primitives: MCP configs, skill directories, capability modules,
// and BYO-CLI plugin folders. The app re-exports these helpers from its shared
// marketplace module, so SDK authors and the studio verify the same shape.

export {
  MARKETPLACE_COMPONENT_KINDS,
  parseMarketplacePluginAuthoringManifest,
  parseMarketplacePluginManifest,
  validateMarketplacePluginAuthoringManifest,
  validateMarketplacePluginManifest,
  type MarketplaceComponent,
  type MarketplaceComponentFileDigest,
  type MarketplaceComponentKind,
  type MarketplaceManifestIssue,
  type MarketplacePluginAuthoringManifest,
  type MarketplacePluginAuthoringManifestResult,
  type MarketplacePluginComponents,
  type MarketplacePluginManifest,
  type MarketplacePluginManifestResult,
} from './plugin-manifest.js'
