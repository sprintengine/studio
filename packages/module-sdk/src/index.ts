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

import type { ModuleChatRuntimeOption, ModuleOpenChatInput, ModuleOpenChatResult } from './conversation.js'
import type { HostCapability } from './host-api.js'

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

/**
 * sha256 digests of a module's own files: POSIX path relative to the module
 * root → lowercase hex. Covers every regular file under the root except
 * `manifest.json` itself, and nothing else — a file on disk that is not listed
 * is as much a mismatch as a listed file whose bytes changed.
 */
export type ModuleFileDigests = Record<string, string>

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
  /**
   * The host API this module was built against (`HOST_API_VERSION` of the SDK
   * it compiled with). Required for third-party modules; the host refuses one
   * built for an API it does not provide.
   */
  engines?: { hostApi: number }
  entry?: ModuleEntry
  /**
   * Digests of every file the module ships. `sprintengine-module sign` writes
   * them, so the signature covers the code and not only the declaration; the
   * app trusts a module by its publisher key only when they match the files
   * on disk exactly.
   */
  files?: ModuleFileDigests
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
  // Retired but still reserved: Automations became scheduled agents 2026-09-30.
  'automations',
  'scheduled-agents',
  // Retired but still reserved (the hosted mobile relay, removed 2026-09-27).
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
  | 'ipc:settings'
  | 'ipc:invoke'
  | 'backlog.read'
  | 'backlog.write'
  | 'backlog.link.open'
  // Create and manage the module's own scheduled agents through the SDK's
  // scoped service. Disclosure-level like every other scope: the service does
  // not runtime-check it.
  | 'scheduled-agents.manage'
  // Attach workspace-bound background (companion) agents through the SDK's
  // Companion Agents service. Unlike the disclosure-only scopes above, the
  // companion service checks this one explicitly at attach time.
  | 'agents:companion'
  // Persist the module's own data through the SDK's scoped storage service
  // (host-placed: the workspace's app-owned `.sprintengine/modules/<id>/`, or
  // per-user app data).
  | 'storage'
  // Read the conversations the module started through the SDK's scoped
  // conversation service: their events, transcripts and list.
  | 'conversation:read'
  // Start, prompt, interrupt and stop the module's own conversations, and open
  // a chat in the renderer (`RendererHost.openChat`). Implies read.
  | 'conversation:operate'
  // Run those conversations on `bypass`, and let them use named tools
  // without asking (`allowedTools`). Without it a module's chats go no looser
  // than `auto`, whatever it asks for.
  | 'conversation:bypass'
  // Store secrets the host sends only to origins the module named, never
  // handing the value back (the SDK's scoped secrets service).
  | 'secrets'
  // Call the GitHub API with the user's sign-in through the SDK's GitHub
  // service; the host attaches the token and never hands it over.
  | 'github'
  // Contribute tools to the Studio MCP gateway (`MainHost.registerMcpTools`).
  | 'mcp:tools'
  | (string & {})

export const KNOWN_CAPABILITY_PERMISSIONS: readonly string[] = [
  'filesystem:read-workspace',
  'filesystem:write-workspace',
  'filesystem:read-home',
  'process:spawn',
  'network',
  'ipc:workspace-read',
  'ipc:workspace-write',
  'ipc:settings',
  'ipc:invoke',
  'backlog.read',
  'backlog.write',
  'backlog.link.open',
  'scheduled-agents.manage',
  'agents:companion',
  'storage',
  'conversation:read',
  'conversation:operate',
  'conversation:bypass',
  'secrets',
  'github',
  'mcp:tools',
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

// ── MCP tools on the Studio gateway ─────────────────────────────────

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
   * the calling device. `false` means a read: advertised to every paired
   * device on the read scope and not audited.
   *
   * Omitted counts as a change: a tool from an installed module is treated as
   * `mutates: true` unless it says `mutates: false`. Declare `false` only on a
   * tool that genuinely reads — never on one that writes to disk, spawns a
   * process, or reconfigures the machine.
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

export type MainHost = {
  /** The module currently registering; stamped by the host. */
  readonly moduleId: string
  /** The host API this app provides (`HOST_API_VERSION` of the SDK it was built with). */
  readonly hostApiVersion: number
  /**
   * Whether the running host provides `capability` now. False for names it
   * does not know, so a module may probe for capabilities newer than its SDK.
   */
  supports(capability: HostCapability): boolean
  registerIpc(channel: string, handler: IpcInvokeHandler): void
  /**
   * Contribute MCP tools to the Studio gateway, owned by this module's id. A
   * tool name another module already registered is a registration error (the
   * whole batch is rejected). Availability follows the module's enablement
   * live: a disabled module's tools stay listed on the gateway and answer
   * calls with an actionable enable error instead of running. An MCP tool is
   * agent-reachable capability: declare the `mcp:tools` permission, without
   * which the host refuses the registration.
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

/**
 * The export contract of `entry.main`: `export function registerMain(host) { … }`.
 * It may be async: the host waits for the returned promise (bounded) before it
 * counts the module as loaded, and a rejection fails the module alone.
 */
export type RegisterMain = (host: MainHost) => void | Promise<void>

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
   * folderless workspaces. Note for worktree-backed workspaces (a scheduled
   * agent's run on a worktree, and whatever else a module opens): the agents work
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

// ── Scheduled agents (host-provided, consumed via the service bridge) ────────

/** The machine a scheduled agent runs on: this computer, or one of its WSL distributions. */
export type ScheduledAgentHostId = 'local' | `wsl:${string}`

export type ScheduledAgentSchedule = {
  /** Five-field cron; several expressions separated by `;`. */
  cron: string
  /** The IANA zone the cron's wall-clock is read in. */
  timezone: string
}

/** A skill or an installed MCP server, by id, with the name its chip shows. */
export type ScheduledAgentAttachment = { id: string; name: string }

export type ScheduledAgentLastRun =
  { at: number; ok: true; workspaceId: string } | { at: number; ok: false; message: string }

/**
 * A scheduled agent: a prompt and a schedule. Each time the schedule comes
 * round, a new chat starts in `folderPath` with `prompt` as its first message,
 * on the machine, CLI, model, permissions, skills, MCP servers and worktree
 * setting recorded here. Nothing carries from one run to the next.
 */
export type ScheduledAgent = {
  id: string
  prompt: string
  schedule: ScheduledAgentSchedule
  folderPath: string
  hostId: ScheduledAgentHostId | null
  cli: string
  cliModel: string | null
  /**
   * `bypass` skips every prompt; `auto` lets edits in the project through and
   * asks before commands and anything outside it; `manual` asks before every
   * edit, command and outside call; `none` passes no flag, so the CLI's own
   * configuration decides. Null follows the preset the person chose for that
   * CLI, read at run time.
   */
  permissionPreset: 'none' | 'manual' | 'auto' | 'bypass' | null
  skills: ScheduledAgentAttachment[]
  mcpServers: ScheduledAgentAttachment[]
  /** A fresh worktree per run, named from this; null runs in the project's checkout. */
  worktree: { name: string } | null
  /** The module that created it; the SDK service stamps it and only that module reaches it. */
  ownerModuleId: string | null
  createdAt: number
  updatedAt: number
  lastRun: ScheduledAgentLastRun | null
  lastFailureSeenAt: number | null
}

/** What a module writes: everything but the bookkeeping. */
export type ScheduledAgentDraft = Pick<
  ScheduledAgent,
  | 'prompt'
  | 'schedule'
  | 'folderPath'
  | 'hostId'
  | 'cli'
  | 'cliModel'
  | 'permissionPreset'
  | 'skills'
  | 'mcpServers'
  | 'worktree'
>

/** A scheduled agent as listed: the record plus when it runs next (epoch ms). */
export type ScheduledAgentView = ScheduledAgent & { nextRunAt: number | null }

export type ScheduledAgentWriteResult = { ok: true; agent: ScheduledAgentView } | { ok: false; message: string }

/**
 * Scheduled agents for a module's `entry.main`, obtained via
 * `getScheduledAgentsService(host)`. Every method is pre-scoped to your
 * module: `create` stamps it as the owner, `list` returns only the ones it
 * owns, and every other call refuses an id it does not own as if the id did
 * not exist. Declare the `scheduled-agents.manage` permission (install-time
 * disclosure) and `dependsOn: ['scheduled-agents']` so the service exists
 * before your entry runs.
 */
export type ModuleScheduledAgentsService = {
  create(draft: ScheduledAgentDraft): Promise<ScheduledAgentWriteResult>
  update(id: string, draft: ScheduledAgentDraft): Promise<ScheduledAgentWriteResult>
  remove(id: string): Promise<{ ok: true } | { ok: false; message: string }>
  list(): Promise<ScheduledAgentView[]>
  /** Start a run now, without waiting for the schedule. */
  runNow(id: string): Promise<{ ok: true; run: ScheduledAgentLastRun } | { ok: false; message: string }>
  /** Called with this module's scheduled agents whenever one of them changes. Returns the unsubscriber; call it in `onShutdown`. */
  onChanged(listener: (agents: ScheduledAgentView[]) => void): () => void
}

type ScheduledAgentsModuleRegistry = {
  create(moduleId: string, draft: ScheduledAgentDraft): Promise<ScheduledAgentWriteResult>
  update(moduleId: string, id: string, draft: ScheduledAgentDraft): Promise<ScheduledAgentWriteResult>
  remove(moduleId: string, id: string): Promise<{ ok: true } | { ok: false; message: string }>
  list(moduleId: string): Promise<ScheduledAgentView[]>
  runNow(
    moduleId: string,
    id: string,
  ): Promise<{ ok: true; run: ScheduledAgentLastRun } | { ok: false; message: string }>
  onChanged(moduleId: string, listener: (agents: ScheduledAgentView[]) => void): () => void
}

const scheduledAgentsModuleServiceToken: ServiceToken<ScheduledAgentsModuleRegistry> =
  createServiceToken<ScheduledAgentsModuleRegistry>('scheduled-agents.module-service')

/**
 * The scoped scheduled agents service for `host`'s module. The raw host
 * registry is moduleId-first; this binds `host.moduleId` so a module cannot
 * reach another's scheduled agents or the person's own.
 */
export function getScheduledAgentsService(host: MainHost): ModuleScheduledAgentsService {
  const registry = host.requireService(scheduledAgentsModuleServiceToken)
  const moduleId = host.moduleId
  return {
    create: (draft) => registry.create(moduleId, draft),
    update: (id, draft) => registry.update(moduleId, id, draft),
    remove: (id) => registry.remove(moduleId, id),
    list: () => registry.list(moduleId),
    runNow: (id) => registry.runNow(moduleId, id),
    onChanged: (listener) => registry.onChanged(moduleId, listener),
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
  /** Order within the session; absent only on events recorded before the host stamped one. */
  seq?: number
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
 * exactly like `getScheduledAgentsService`.
 */
export function getCompanionAgentsService(host: MainHost): CompanionAgentsService {
  const registry = host.requireService(companionAgentsModuleServiceToken)
  const moduleId = host.moduleId
  return {
    attach: (spec) => registry.attach(moduleId, spec),
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
 * like `getScheduledAgentsService`. Provided by the agent-runtime core — declare
 * `dependsOn: ['agent-runtime']` (a chain that reaches it, e.g.
 * `['scheduled-agents']`, also works) so your `entry.main` registers after the
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
 * instance-level nav cluster (the band holding New chat and
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

// ── Live runtime surfaces (renderer) ─────────────────────────────────────────

export type WorkspaceFileWatchEvent = {
  relativePath: string
  /** File content after the change; null when the file does not exist. */
  content: string | null
}

/** The resolved surface of the app's active theme (`watchColorScheme`). */
export type ModuleColorScheme = 'light' | 'dark'

export type ModuleFocusTabInput = {
  workspaceId: string
  kind: 'chat' | 'file'
  /** A chat's agent id (from `openChat` or the conversation service), or a workspace-relative file path. */
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
  /** The host API this app provides (`HOST_API_VERSION` of the SDK it was built with). */
  readonly hostApiVersion: number
  /**
   * Whether the running host provides `capability` now. False for names it
   * does not know, so a module may probe for capabilities newer than its SDK.
   */
  supports(capability: HostCapability): boolean
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
   * Open one of THIS module's global surfaces — the page a
   * `registerGlobalSurface` with the same id contributed — as if its door had
   * been picked. A module may only open surfaces it registered: false for an
   * id that is not yours, not registered, or while your module is disabled.
   */
  openGlobalSurface(id: string): boolean
  /**
   * Open one of THIS module's modal surfaces over whatever the window is
   * showing — the trigger you draw yourself from a panel, a row action or a
   * command. A module may only open surfaces it registered: false for an id
   * that is not yours, not registered, or while your module is disabled.
   */
  openModalSurface(id: string): boolean
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
   * The workspace's *effective working root*: where its live work happens.
   * `ModuleWorkspaceView.folderPath` deliberately reports the durable primary
   * checkout; a worktree-backed workspace (a scheduled agent's run on a
   * worktree, for one) does live work under a worktree, and this
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
   * Focus a workspace tab: a chat by its agent id (added if missing) or a
   * file tab by workspace-relative path. False when not focusable; throws
   * with a named cause when agent runtime is unavailable.
   */
  focusTab(input: ModuleFocusTabInput): boolean
  /**
   * Open a chat in a workspace and focus it. By default the prompt lands in the
   * composer as a draft the user sends themselves; `send: true` sends it as the
   * first turn. Expected failures come back as a result, never a throw
   * (`unavailable` when this window cannot open chats). Declare
   * `conversation:operate`.
   */
  openChat(input: ModuleOpenChatInput): Promise<ModuleOpenChatResult>
  /**
   * The agent runtimes a chat can run on, from the same catalog the shell's
   * own chat picker reads, with the one the user last chose marked.
   */
  listChatRuntimes(): ModuleChatRuntimeOption[]
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

export const SPRINTENGINE_FILE_DROP_MIME = 'application/x-sprintengine-file-drop'

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
  dataTransfer.setData(SPRINTENGINE_FILE_DROP_MIME, JSON.stringify(payload))
  dataTransfer.setData('text/plain', fileText)
}

/**
 * Whether a drag carries the studio's file-drop payload (or native OS files).
 * Use this during `dragover` — the HTML DnD protected mode blanks `getData`
 * there, so `readFileDropPayload` only works inside the `drop` handler.
 */
export function hasFileDropData(dataTransfer: DataTransfer): boolean {
  const types = Array.from(dataTransfer.types)
  return types.includes(SPRINTENGINE_FILE_DROP_MIME) || types.includes('Files')
}

/**
 * Read the studio's file-drop payload off a drop event's dataTransfer. Returns
 * null — never throws — when the MIME entry is absent, the JSON is
 * unparseable, the version is unknown (future versions ⇒ null; handle it), or
 * the shape is invalid. A Backlog-item drag carries the item's markdown file
 * path in `files[0].path`, resolvable back to the item.
 */
export function readFileDropPayload(dataTransfer: DataTransfer): FileDropPayload | null {
  const raw = dataTransfer.getData(SPRINTENGINE_FILE_DROP_MIME)
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

/**
 * The export contract of `entry.renderer`: `export function registerRenderer(host) { … }`.
 * It may be async: the host waits for the returned promise (bounded) before it
 * counts the module as loaded, and a rejection fails the module alone.
 */
export type RegisterRenderer = (host: RendererHost) => void | Promise<void>

// ── Host API version, conversations, brokered credentials ────────────────────

export {
  HOST_API_MIN_SUPPORTED,
  HOST_API_VERSION,
  checkHostApiCompatibility,
  type HostApiCompatibility,
  type HostCapability,
} from './host-api.js'

export {
  getConversationService,
  type ModuleChatRuntimeOption,
  type ModuleConversationApprovalDecision,
  type ModuleConversationCommandOptions,
  type ModuleConversationCreateInput,
  type ModuleConversationErrorCode,
  type ModuleConversationEvent,
  type ModuleConversationEventType,
  type ModuleConversationFollowOptions,
  type ModuleConversationImageAttachment,
  type ModuleConversationPage,
  type ModuleConversationPermissionPreset,
  type ModuleConversationPlanDecision,
  type ModuleConversationRef,
  type ModuleConversationResult,
  type ModuleConversationService,
  type ModuleConversationStatus,
  type ModuleConversationStreamFrame,
  type ModuleConversationSummary,
  type ModuleOpenChatInput,
  type ModuleOpenChatResult,
} from './conversation.js'

export {
  getGitHubService,
  getSecretsService,
  type ModuleGitHubRequest,
  type ModuleGitHubResponse,
  type ModuleGitHubService,
  type ModuleSecretFetchInit,
  type ModuleSecretFetchResult,
  type ModuleSecretsError,
  type ModuleSecretsService,
} from './brokers.js'

// ── Manifest validation + canonical signing payload ──────────────────────────
// Pure (no Node APIs) and safe in any runtime. The ed25519 sign/verify
// functions, and the walk that digests a module folder, need node:crypto and
// node:fs and live behind the `./signing` subpath export.

export {
  canonicalManifestPayload,
  compareModuleFileDigests,
  isPackExcludedPath,
  parseThirdPartyModuleManifest,
  validateCapabilityPermissions,
  validateModuleFileDigests,
  validateThirdPartyModuleManifest,
  type ModuleFileDigestsValidation,
  type PermissionValidationIssue,
  type PermissionValidationResult,
  type ThirdPartyManifestIssue,
  type ThirdPartyManifestResult,
} from './manifest-validate.js'

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
