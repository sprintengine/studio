// `@sprintengine/module-sdk/testing` — fake hosts for testing a module in Node,
// without the app.
//
// - `createFakeMainHost` is a `MainHost` with stateful fakes of every service
//   the SDK publishes (storage, chats, scheduled agents, companions, secrets,
//   GitHub, workspaces, the Backlog, usage, activity), held to the host's
//   rules: the same storage key pattern, root rule and 1 MB cap, the same
//   `permission_missing` answers for the permissions the host checks, the same
//   refusals on the renderer bridge. `ipc.invoke` calls the module's channels
//   the way its renderer would and `tools.call` calls its MCP tools the way an
//   agent would.
// - `createFakeRendererHost` is a `RendererHost` that records every
//   registration, toast and opened link, and renders a registered door, panel,
//   modal, settings section or top-bar item to HTML; `invoke`, `subscribe`, the
//   module app state, the Backlog and usage reach a fake main host when given
//   one.
// - `installTestingKit` routes `@sprintengine/module-sdk/ui`, `/surface` and
//   `@monaco-editor/react` to a pass-through kit (`./testing/kit`) whose
//   components draw their props and children, so a built renderer bundle loads
//   and renders in Node, and a door that throws on render fails its test.
//
// A host method or service added to the SDK lands here too: the method on the
// fake host (its permission in MAIN_METHOD_PERMISSIONS or
// RENDERER_METHOD_PERMISSIONS, its capability in KNOWN_CAPABILITIES), a
// service's fake in SERVICE_FAKES (testing-services.ts). The typecheck fails
// until the fake hosts implement every method, and a test fails until every
// capability is known.
//
// Node only (it uses `node:module` hooks); never import it from module code.

import { existsSync, rmSync } from 'node:fs'
import { registerHooks } from 'node:module'
import { dirname, isAbsolute, resolve as resolvePath } from 'node:path'

import { HOST_API_VERSION } from './host-api.js'
import type { HostCapability } from './host-api.js'
import type {
  BacklogItemAction,
  BacklogItemView,
  BacklogLinkProvider,
  DoorBadgeContribution,
  FileAction,
  GlobalSurfaceDefinition,
  MainHost,
  McpConnectionMetadata,
  McpToolRegistration,
  McpToolResult,
  ModalSurfaceDefinition,
  ModuleColorScheme,
  ModuleCommandContext,
  ModuleCommandDefinition,
  ModuleFocusTabInput,
  ModuleNotificationTarget,
  ModuleNotifyInput,
  ModuleOpenExternalResult,
  ModuleSkillRegistration,
  ModuleSkillStatus,
  ModuleSkillStatusResult,
  ModuleToastInput,
  ModuleToastTone,
  ModuleWorkspaceView,
  NotificationActionProvider,
  RendererHost,
  ServiceToken,
  SettingsSectionDefinition,
  SidebarNavEntryBadge,
  SidebarNavEntryDefinition,
  SidecarSpec,
  TopBarItemDefinition,
  WorkspaceFileWatchEvent,
  WorkspacePanelComponent,
  WorkspaceTypeDefinition,
} from './index.js'
import type { ModuleChatRuntimeOption, ModuleOpenChatInput, ModuleOpenChatResult } from './conversation.js'
import { moduleServiceRequirement } from './services.js'
import type { UsageQuery, UsageQueryResult } from './activity.js'
import {
  createFakeWorkspaces,
  SERVICE_FAKES,
  type FakeBacklog,
  type FakeBacklogItemInput,
  type FakeServiceContext,
  type FakeServices,
  type FakeUsage,
  type FakeWorkspaces,
} from './testing-services.js'
import type { ComponentType, ReactNode } from 'react'

export type {
  FakeActivity,
  FakeBacklog,
  FakeBacklogItemInput,
  FakeCompanions,
  FakeCompanionTurn,
  FakeConversationEventInput,
  FakeConversationRecord,
  FakeConversations,
  FakeGitHub,
  FakeGitHubAnswer,
  FakeGitHubDownloadAnswer,
  FakeGitHubDownloadReply,
  FakeGitHubGraphqlAnswer,
  FakeGitHubReply,
  FakeScheduledAgents,
  FakeSecretRequest,
  FakeSecrets,
  FakeServiceContext,
  FakeServices,
  FakeStorage,
  FakeUsage,
  FakeUsageRecord,
  FakeWorkspaceGitInfo,
  FakeWorkspaces,
} from './testing-services.js'
export { MODULE_STORAGE_VALUE_LIMIT_BYTES } from './testing-services.js'

// ── Shared pieces ────────────────────────────────────────────────────────────

/** The workspace every fake starts with when a test names none. */
export const DEFAULT_FAKE_WORKSPACES: readonly ModuleWorkspaceView[] = [
  { id: 'ws-app', name: 'App', folderPath: '/Users/dev/projects/app', mode: 'standard' },
]

// Every capability this SDK knows. A fake answers `supports` with these unless
// told otherwise, so a module's "older host" branch is opt-in to test. A test
// fails when HostCapability (host-api.ts) names one this list does not.
const KNOWN_CAPABILITIES: readonly HostCapability[] = [
  'conversations',
  'conversation-controls',
  'conversation-streams',
  'conversation-requests',
  'conversation-permissions',
  'chat.open',
  'companion-agents',
  'scheduled-agents',
  'secrets',
  'github',
  'storage',
  'mcp-tools',
  'skills',
  'module-assets',
  'notifications',
  // Backlog, usage and activity services.
  'backlog-write',
  'usage',
  'activity',
  // Shell surfaces and the renderer host.
  'sidebar-nav-entries',
  'door-badges',
  'toast',
  'module-id',
  'command-context',
  'active-workspace',
  'surface-view',
  'open-external',
  'ui-kit-extras',
  'chart-tokens',
  'electron-main',
  // Main-host plumbing: settings, workspaces, storage, GitHub, skills, MCP.
  'skill-status',
  'mcp-verified-identity',
  'github-headers',
  'github-graphql',
  'github-download',
  'storage-query',
  'storage-watch',
  'module-data-dir',
  'main-asset-path',
  'workspace-git-info',
  'workspace-history',
  'main-app-state',
]

/** What a fake host is told about the module: its id and the permissions its manifest declares. */
export type FakeModuleIdentity = {
  moduleId?: string
  permissions?: readonly string[]
  /** A module manifest (`module/manifest.json`, parsed) to read the id and permissions from instead. */
  manifest?: { id: string; permissions?: readonly string[] }
}

function identityOf(options: FakeModuleIdentity): { moduleId: string; permissions: Set<string> } {
  const moduleId = options.moduleId ?? options.manifest?.id
  if (!moduleId) throw new Error('A fake host needs a moduleId (or a manifest with an id).')
  return { moduleId, permissions: new Set(options.permissions ?? options.manifest?.permissions ?? []) }
}

/** A use of something whose permission the manifest does not declare. */
export type FakeUndeclaredUse = {
  /** The service key or host method. */
  what: string
  /** Any one of these would cover it. */
  needs: readonly string[]
  /** Whether the host itself refuses the call without it, or only discloses it. */
  checked: boolean
}

// The bridge accepts its own scope and the broad one it was split out of.
const BRIDGE_PERMISSIONS = ['module:bridge', 'ipc:invoke'] as const

function refusal(message: string, code: string): Error {
  return Object.assign(new Error(message), { code })
}

// ── Notifications and events: the host's validation ─────────────────────────

const NOTIFY_SEVERITIES = ['info', 'warning', 'error']
const MAX_TOPIC_LENGTH = 128
const MAX_NOTIFY_TITLE_LENGTH = 200
const MAX_NOTIFY_BODY_LENGTH = 2000
const MAX_NOTIFY_TARGET_ID_LENGTH = 200

function notifyTargetId(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed.length > 0 && trimmed.length <= MAX_NOTIFY_TARGET_ID_LENGTH ? trimmed : null
}

// The host's validation (shared/modules/notifications.ts in the app): what a
// bell row would carry, trimmed and clipped, or the throw the module would get.
function validateNotify(moduleId: string, input: unknown): ModuleNotifyInput {
  const { severity, title, body, target } = (input ?? {}) as Record<string, unknown>
  const fail = (message: string): never => {
    throw new Error(`Module "${moduleId}" notify(...) ${message}`)
  }
  if (typeof input !== 'object' || input === null) fail('requires a payload object.')
  if (typeof severity !== 'string' || !NOTIFY_SEVERITIES.includes(severity)) {
    fail('severity must be "info", "warning", or "error".')
  }
  if (typeof title !== 'string' || !title.trim()) fail('requires a non-empty title.')
  if (body !== undefined && typeof body !== 'string') fail('body must be a string when provided.')
  let validTarget: ModuleNotificationTarget | undefined
  if (target !== undefined) {
    if (!target || typeof target !== 'object') fail('target must be { surfaceId, viewId? } when provided.')
    const { surfaceId, viewId } = target as Record<string, unknown>
    const validSurfaceId = notifyTargetId(surfaceId) ?? fail('target.surfaceId must be a non-empty string.')
    const validViewId = viewId === undefined ? undefined : notifyTargetId(viewId)
    if (validViewId === null) fail('target.viewId must be a non-empty string when provided.')
    validTarget = { surfaceId: validSurfaceId, ...(validViewId ? { viewId: validViewId } : {}) }
  }
  const trimmed = (body as string | undefined)?.trim()
  return {
    severity: severity as ModuleNotifyInput['severity'],
    title: (title as string).trim().slice(0, MAX_NOTIFY_TITLE_LENGTH),
    ...(trimmed ? { body: trimmed.slice(0, MAX_NOTIFY_BODY_LENGTH) } : {}),
    ...(validTarget ? { target: validTarget } : {}),
  }
}

// ── Module app state ─────────────────────────────────────────────────────────

// The module's app-level state (its Settings values): one namespace the
// renderer reads and writes and `entry.main` reads, so a fake renderer given a
// fake main host shares it, as the windows and main do.
type AppStateStore = {
  get(key: string): unknown
  all(): Record<string, unknown>
  set(key: string, value: unknown): void
  subscribe(cb: (values: Readonly<Record<string, unknown>>) => void): () => void
}

function createAppStateStore(initial: Record<string, unknown> | undefined): AppStateStore {
  const values: Record<string, unknown> = structuredClone(initial ?? {})
  const listeners = new Set<(values: Readonly<Record<string, unknown>>) => void>()
  return {
    get: (key) => structuredClone(values[key]),
    all: () => structuredClone(values),
    set(key, value) {
      if (value === undefined) delete values[key]
      else values[key] = structuredClone(value)
      for (const listener of [...listeners]) listener(structuredClone(values))
    },
    subscribe(cb) {
      listeners.add(cb)
      return () => {
        listeners.delete(cb)
      }
    },
  }
}

function validateTopic(moduleId: string, topic: unknown): string {
  if (typeof topic !== 'string' || !topic.trim() || topic.length > MAX_TOPIC_LENGTH) {
    throw new Error(`Module "${moduleId}" emit(...) needs a topic of 1-${MAX_TOPIC_LENGTH} characters.`)
  }
  return topic
}

// ── The main host ────────────────────────────────────────────────────────────

export type FakeMainHostOptions = FakeModuleIdentity & {
  /** The workspaces the host knows. Default: one, `ws-app` at `/Users/dev/projects/app`. */
  workspaces?: readonly ModuleWorkspaceView[]
  /** Values already stored, as an earlier run would have left them: the global store, and per workspace root. */
  storage?: { global?: Record<string, unknown>; workspaces?: Record<string, Record<string, unknown>> }
  /** What `supports` answers true for. Default: every capability this SDK knows. */
  capabilities?: readonly string[]
  /**
   * Replace a service: a moduleId-first registry object to answer with in
   * place of the built-in fake, or null for a service no enabled module
   * provides (`requireService` throws, `getService` answers undefined).
   */
  services?: Record<string, object | null>
  /** Skill ids the app ships, which `ensureSkillInstalled` answers for besides the module's own. */
  builtinSkills?: readonly string[]
  /** The clock every fake stamps with. Default: `Date.now`. */
  now?: () => number
  /** Module app state (Settings values) a window already pushed, for `getModuleAppState`. */
  appState?: Record<string, unknown>
  /** What `getModuleDataDir` answers. Default: a fresh temporary folder, made on first use (`dispose` removes it). */
  dataDir?: string
  /** The module's folder, which `getAssetPath` resolves under. Default: the working directory (the project root under `npm test`). */
  moduleRoot?: string
  /**
   * The files the module was verified with (`module/manifest.json`'s `files`),
   * module-relative. Given, `getAssetPath` resolves only these, as the host
   * does; absent, any file that exists under `moduleRoot`.
   */
  verifiedFiles?: readonly string[]
}

export type FakeMainHost = {
  /** Hand this to `registerMain`. */
  host: MainHost
  /** The module's declared permissions. Live: add or remove one to test the other branch. */
  permissions: Set<string>
  /** The renderer's side of the bridge. */
  ipc: {
    /**
     * Call a channel as the module's renderer would with `host.invoke`: own
     * channels only, refused without `module:bridge` (or `ipc:invoke`), payload
     * and result structured-cloned as IPC clones them. A refusal rejects with
     * an Error carrying `code`, as `RendererHost.invoke` does.
     */
    invoke(channel: string, payload?: unknown): Promise<unknown>
    /** The channels registered so far. */
    channels(): string[]
  }
  /** The gateway's side of the module's MCP tools. */
  tools: {
    /** Call a registered tool as an agent would. `metadata` defaults to a Studio agent in the first workspace. */
    call(name: string, args?: Record<string, unknown>, metadata?: McpConnectionMetadata): Promise<McpToolResult>
    list(): McpToolRegistration[]
  }
  /** Every `emit`, in order. */
  emitted: Array<{ topic: string; payload?: unknown }>
  /** Every `notify`, validated as the host validates it. */
  notifications: ModuleNotifyInput[]
  skills: {
    registered: ModuleSkillRegistration[]
    ensured: Array<{ workspaceRoot: string; skillId: string }>
    /**
     * Put a skill in a state in a workspace, for `getSkillStatus` and
     * `ensureSkillInstalled` to find: `local` or `modified` (a copy the app
     * leaves alone), `update-available` (`ensure…` answers `updated`),
     * `install-failed`, …. Unset, a known skill is `missing` until
     * `ensureSkillInstalled` installs it.
     */
    setStatus(workspaceRoot: string, skillId: string, status: ModuleSkillStatus): void
  }
  sidecars: SidecarSpec[]
  /** The stateful service fakes, to arrange the world and read what the module did to it. */
  services: FakeServices
  /** Service keys the module resolved, in order (a key resolved twice appears once). */
  resolved: string[]
  /** Services resolved without a permission that covers them. A clean module leaves this empty. */
  undeclared: FakeUndeclaredUse[]
  /** Run every `onStartup` hook, in order. Rejects with the first hook's error after running them all. */
  startup(): Promise<void>
  /** Run `onShutdownBegin` hooks in order, then `onShutdown` hooks in reverse. */
  shutdown(): Promise<void>
  /** Hear every `emit` (a fake renderer host subscribes this way). */
  onEmit(listener: (topic: string, payload: unknown) => void): () => void
  /** The module app state now, as `getModuleAppState` reads it. */
  appState(): Record<string, unknown>
  /**
   * Change one key of the module app state, as a window's Settings section
   * would push it (`undefined` removes it); `watchModuleAppState` listeners
   * hear the whole namespace. A fake renderer given this host shares it.
   */
  setAppState(key: string, value: unknown): void
  /** Remove the temporary data directory `getModuleDataDir` made (never a `dataDir` the test passed). */
  dispose(): void
}

type MainInternals = {
  moduleId: string
  workspaces: ReturnType<typeof createFakeWorkspaces>
  appState: AppStateStore
  registry(key: string): object | undefined
}

// Disclosure permissions for main host methods; the host checks
// `getWorkspaceGitInfo` itself (`permission_missing`).
const MAIN_METHOD_PERMISSIONS: Readonly<Record<string, readonly string[]>> = {
  getModuleAppState: ['storage'],
  watchModuleAppState: ['storage'],
  getModuleDataDir: ['storage'],
  getWorkspaceGitInfo: ['ipc:workspace-read'],
}
const CHECKED_MAIN_METHODS = new Set(['getWorkspaceGitInfo'])

// The skill states an agent launched in the workspace would find the skill in.
const SKILL_PRESENT: ReadonlySet<ModuleSkillStatus> = new Set<ModuleSkillStatus>([
  'installed',
  'updated',
  'update-available',
  'local',
  'modified',
  'delivered-at-launch',
])

// The host's rule for a module-relative file path (an asset).
function validateAssetPath(relativePath: string, moduleId: string): string[] {
  if (
    typeof relativePath !== 'string' ||
    !relativePath ||
    relativePath.startsWith('/') ||
    /[\\\0?#]/.test(relativePath)
  ) {
    throw new Error(`Module "${moduleId}" asset path must be a module-relative file path, got "${relativePath}".`)
  }
  const parts = relativePath.split('/')
  if (parts.some((part) => !part || part === '.' || part === '..')) {
    throw new Error(`Module "${moduleId}" asset path must be a module-relative file path, got "${relativePath}".`)
  }
  return parts
}
const mainInternals = new WeakMap<FakeMainHost, MainInternals>()

export function createFakeMainHost(options: FakeMainHostOptions): FakeMainHost {
  const { moduleId, permissions } = identityOf(options)
  const now = options.now ?? Date.now
  const workspaces = createFakeWorkspaces(options.workspaces ?? DEFAULT_FAKE_WORKSPACES, now)
  const capabilities = new Set<string>(options.capabilities ?? KNOWN_CAPABILITIES)
  const context: FakeServiceContext = {
    moduleId,
    permissions,
    now,
    workspaces,
    ...(options.dataDir ? { dataDir: options.dataDir } : {}),
  }
  const appState = createAppStateStore(options.appState)
  const skillStatuses = new Map<string, ModuleSkillStatus>()
  const skillKey = (workspaceRoot: string, skillId: string): string => `${workspaceRoot}\u0000${skillId}`

  // Every built-in fake is made up front, so a test can arrange its state
  // before the module resolves it.
  const registries = new Map<string, object>()
  const services = { workspaces } as Partial<FakeServices> & { workspaces: FakeWorkspaces }
  for (const [key, definition] of Object.entries(SERVICE_FAKES)) {
    const made = definition.create(context)
    registries.set(key, made.registry)
    if (definition.name && definition.name !== 'workspaces') {
      ;(services as Record<string, unknown>)[definition.name] = made.handle
    }
  }
  const fakes = services as FakeServices
  for (const [key, value] of Object.entries(options.storage?.global ?? {})) fakes.storage.seed(key, value)
  for (const [root, values] of Object.entries(options.storage?.workspaces ?? {})) {
    for (const [key, value] of Object.entries(values)) fakes.storage.seed(key, value, root)
  }

  const channels = new Map<string, (event: unknown, ...args: unknown[]) => unknown>()
  const tools = new Map<string, McpToolRegistration>()
  const provided = new Map<string, unknown>()
  const startupHooks: Array<() => unknown> = []
  const shutdownBeginHooks: Array<() => unknown> = []
  const shutdownHooks: Array<() => unknown> = []
  const emitListeners = new Set<(topic: string, payload: unknown) => void>()
  const builtinSkills = new Set(options.builtinSkills ?? [])

  const fake: FakeMainHost = {
    host: undefined as unknown as MainHost,
    permissions,
    ipc: {
      async invoke(channel, payload) {
        if (typeof channel !== 'string' || !channel.startsWith(`${moduleId}:`)) {
          throw new Error(`Module "${moduleId}" may only invoke its own channels ("${moduleId}:*"); got "${channel}".`)
        }
        const handler = channels.get(channel)
        if (!handler) throw refusal(`No module has registered the IPC channel "${channel}".`, 'unknown_channel')
        if (!BRIDGE_PERMISSIONS.some((permission) => permissions.has(permission))) {
          throw refusal(
            `Module "${moduleId}" does not declare the "module:bridge" permission, so its channels cannot be bridged.`,
            'permission_missing',
          )
        }
        const result = await handler({ sender: { fake: true } }, structuredClone(payload))
        return structuredClone(result)
      },
      channels: () => [...channels.keys()],
    },
    tools: {
      async call(name, args = {}, metadata) {
        const tool = tools.get(name)
        if (!tool)
          throw new Error(
            `No MCP tool "${name}" is registered; the module registered ${[...tools.keys()].join(', ') || 'none'}.`,
          )
        const first = workspaces.all()[0]
        const connection: McpConnectionMetadata = metadata ?? {
          kind: 'studio-agent',
          ...(first ? { workspaceId: first.id } : {}),
          agentId: 'agent-1',
          agentName: 'Test agent',
          cliId: 'claude',
        }
        const result = await tool.handler(structuredClone(args), { metadata: connection })
        if (!result || !Array.isArray(result.content)) {
          throw new Error(`MCP tool "${name}" answered without a content array; the gateway would refuse the result.`)
        }
        return structuredClone(result)
      },
      list: () => [...tools.values()],
    },
    emitted: [],
    notifications: [],
    skills: {
      registered: [],
      ensured: [],
      setStatus(workspaceRoot, skillId, status) {
        skillStatuses.set(skillKey(workspaceRoot, skillId), status)
      },
    },
    sidecars: [],
    services: fakes,
    resolved: [],
    undeclared: [],
    async startup() {
      await runAll(startupHooks)
    },
    async shutdown() {
      await runAll(shutdownBeginHooks)
      await runAll([...shutdownHooks].reverse())
    },
    onEmit(listener) {
      emitListeners.add(listener)
      return () => {
        emitListeners.delete(listener)
      }
    },
    appState: () => appState.all(),
    setAppState(key, value) {
      appState.set(key, value)
    },
    dispose() {
      const made = fakes.storage.dataDir()
      if (made && !options.dataDir) rmSync(dirname(made), { recursive: true, force: true })
    },
  }

  function use(method: string): void {
    const needs = MAIN_METHOD_PERMISSIONS[method]
    if (!needs || needs.some((permission) => permissions.has(permission))) return
    if (!fake.undeclared.some((entry) => entry.what === method)) {
      fake.undeclared.push({ what: method, needs, checked: CHECKED_MAIN_METHODS.has(method) })
    }
  }
  const knownSkill = (skillId: string): boolean =>
    fake.skills.registered.some((skill) => skill.id === skillId) || builtinSkills.has(skillId)
  // What the installer would find, without writing anything.
  function skillStatus(workspaceRoot: string, skillId: string): ModuleSkillStatusResult {
    if (typeof workspaceRoot !== 'string' || !workspaceRoot.trim()) {
      return { ok: false, status: 'missing-workspace', message: 'No workspace root was given.' }
    }
    if (!knownSkill(skillId)) {
      return { ok: false, status: 'unknown-skill', message: `No skill "${skillId}" is registered.` }
    }
    const status = skillStatuses.get(skillKey(workspaceRoot, skillId)) ?? 'missing'
    return { ok: SKILL_PRESENT.has(status), status }
  }

  function resolve<T>(token: ServiceToken<T>, required: boolean): T | undefined {
    const key = token?.key
    if (provided.has(key)) return provided.get(key) as T
    const override = options.services && Object.hasOwn(options.services, key) ? options.services[key] : undefined
    const requirement = moduleServiceRequirement(key)
    if (override === undefined && !registries.has(key)) {
      throw new Error(`Service "${key}" is not available to third-party modules.`)
    }
    if (override === null) {
      if (required) throw new Error(`Module "${moduleId}" requires service "${key}", which no enabled module provides.`)
      return undefined
    }
    if (!fake.resolved.includes(key)) fake.resolved.push(key)
    if (requirement && !requirement.permissions.some((permission) => permissions.has(permission))) {
      if (!fake.undeclared.some((use) => use.what === key)) {
        fake.undeclared.push({ what: key, needs: requirement.permissions, checked: requirement.checked })
      }
    }
    return (override ?? registries.get(key)) as T
  }

  const host: MainHost = {
    moduleId,
    hostApiVersion: HOST_API_VERSION,
    supports: (capability) => capabilities.has(capability),
    registerIpc(channel, handler) {
      if (channels.has(channel))
        throw new Error(`IPC channel "${channel}" is already registered by module "${moduleId}".`)
      channels.set(channel, handler)
    },
    registerMcpTools(batch) {
      if (!permissions.has('mcp:tools')) {
        throw new Error(`Module "${moduleId}" must declare the "mcp:tools" permission to register MCP tools.`)
      }
      const names = new Set<string>()
      for (const tool of batch) {
        if (tools.has(tool.name))
          throw new Error(`MCP tool "${tool.name}" is already registered by module "${moduleId}".`)
        if (names.has(tool.name))
          throw new Error(`MCP tool "${tool.name}" is registered twice by module "${moduleId}".`)
        names.add(tool.name)
      }
      // A third-party tool that does not say `mutates: false` counts as a change.
      for (const tool of batch) tools.set(tool.name, { ...tool, mutates: tool.mutates !== false })
    },
    registerSkills(batch) {
      const ids = new Set(fake.skills.registered.map((skill) => skill.id))
      for (const skill of batch) {
        const parts = typeof skill.sourceDir === 'string' ? skill.sourceDir.split(/[\\/]/) : ['..']
        if (!skill.sourceDir || isAbsolute(skill.sourceDir) || parts.includes('..')) {
          throw new Error(`Module "${moduleId}" skill "${skill.id}" sourceDir must stay inside the module root.`)
        }
        if (ids.has(skill.id) || builtinSkills.has(skill.id)) {
          throw new Error(`Skill "${skill.id}" is already registered.`)
        }
        ids.add(skill.id)
      }
      fake.skills.registered.push(...batch.map((skill) => ({ ...skill })))
    },
    async ensureSkillInstalled(workspaceRoot, skillId) {
      fake.skills.ensured.push({ workspaceRoot, skillId })
      const found = skillStatus(workspaceRoot, skillId)
      if (found.status === 'missing') {
        skillStatuses.set(skillKey(workspaceRoot, skillId), 'installed')
        return { ok: true, status: 'installed' }
      }
      if (found.status === 'update-available') {
        skillStatuses.set(skillKey(workspaceRoot, skillId), 'installed')
        return { ok: true, status: 'updated' }
      }
      return found
    },
    async getSkillStatus(workspaceRoot, skillId) {
      return skillStatus(workspaceRoot, skillId)
    },
    getModuleDataDir() {
      use('getModuleDataDir')
      const key = 'core.module-storage'
      const storage = (
        options.services && Object.hasOwn(options.services, key) ? options.services[key] : registries.get(key)
      ) as { dataDir?: (moduleId: string) => string } | null | undefined
      if (typeof storage?.dataDir !== 'function') {
        throw new Error(`Module "${moduleId}" asked for its data directory, and no storage service is provided.`)
      }
      return storage.dataDir(moduleId)
    },
    getAssetPath(relativePath) {
      validateAssetPath(relativePath, moduleId)
      const root = options.moduleRoot ?? process.cwd()
      const listed = options.verifiedFiles ? options.verifiedFiles.includes(relativePath) : true
      const path = resolvePath(root, relativePath)
      if (!listed || !existsSync(path)) {
        throw new Error(`"${relativePath}" is not among module "${moduleId}"'s verified files.`)
      }
      return path
    },
    async getWorkspaceGitInfo(workspaceId) {
      use('getWorkspaceGitInfo')
      if (!permissions.has('ipc:workspace-read')) {
        return {
          ok: false,
          code: 'permission_missing',
          message: `Module "${moduleId}" must declare the "ipc:workspace-read" permission to read a workspace's git information.`,
        }
      }
      return workspaces.gitInfo(workspaceId)
    },
    getModuleAppState<T = unknown>(key: string): T | undefined {
      use('getModuleAppState')
      if (typeof key !== 'string' || key.trim().length === 0) return undefined
      return appState.get(key) as T | undefined
    },
    watchModuleAppState(cb) {
      use('watchModuleAppState')
      // Heard on change only, not on subscribe, as the host's main half is.
      return appState.subscribe(cb)
    },
    provideService(token, factory) {
      if (provided.has(token.key) || registries.has(token.key)) {
        throw new Error(`Service "${token.key}" is already provided; module "${moduleId}" tried to provide it again.`)
      }
      const instance = factory(host)
      provided.set(token.key, instance)
      return instance
    },
    getService: (token) => resolve(token, false),
    requireService: (token) => resolve(token, true) as never,
    onStartup(hook) {
      startupHooks.push(hook)
    },
    onShutdownBegin(hook) {
      shutdownBeginHooks.push(hook)
    },
    onShutdown(hook) {
      shutdownHooks.push(hook)
    },
    registerSidecar(spec) {
      fake.sidecars.push({ ...spec })
      return {
        start: async () => {
          throw new Error(`Sidecar "${spec.id}" was registered without a lifecycle and cannot be started.`)
        },
        stop: async () => {},
        status: () => ({ id: spec.id, moduleId, kind: spec.kind, description: spec.description, state: 'declared' }),
      }
    },
    notify(input) {
      fake.notifications.push(validateNotify(moduleId, input))
    },
    emit(topic, payload) {
      const valid = validateTopic(moduleId, topic)
      // The payload crosses IPC: one that cannot be cloned throws here as it would there.
      const cloned = payload === undefined ? undefined : structuredClone(payload)
      fake.emitted.push(cloned === undefined ? { topic: valid } : { topic: valid, payload: cloned })
      for (const listener of emitListeners) listener(valid, structuredClone(cloned))
    },
  }
  fake.host = host
  mainInternals.set(fake, { moduleId, workspaces, appState, registry: (key) => registries.get(key) })
  return fake
}

async function runAll(hooks: ReadonlyArray<() => unknown>): Promise<void> {
  const errors: unknown[] = []
  for (const hook of hooks) {
    try {
      await hook()
    } catch (error) {
      errors.push(error)
    }
  }
  // The host logs a failing hook and carries on; a test should hear about it.
  if (errors.length > 0) throw errors[0]
}

// ── Rendering ────────────────────────────────────────────────────────────────

/** The specifiers the host answers at runtime, which `installTestingKit` routes to the pass-through kit. */
export const HOST_PROVIDED_SPECIFIERS: readonly string[] = [
  '@sprintengine/module-sdk/ui',
  '@sprintengine/module-sdk/surface',
  '@monaco-editor/react',
]

let kitInstalled = false

/**
 * Route the host-provided specifiers to `@sprintengine/module-sdk/testing/kit`
 * for every later `import` and `require` in this process, so a built renderer
 * bundle loads in Node and its components render with a kit that draws. Call
 * it before importing the bundle. Idempotent.
 */
export function installTestingKit(): void {
  if (kitInstalled) return
  kitInstalled = true
  const kit = new URL('./testing-kit.js', import.meta.url).href
  const routed = new Set(HOST_PROVIDED_SPECIFIERS)
  registerHooks({
    resolve(specifier, context, nextResolve) {
      if (routed.has(specifier)) return { url: kit, format: 'module', shortCircuit: true }
      return nextResolve(specifier, context)
    },
  })
}

/**
 * Render a React tree to HTML in Node, waiting for `lazy` components and
 * Suspense to settle. Rejects with the error when a component throws, so a
 * door that cannot render fails its test. Needs `react` and `react-dom`
 * installed beside the test.
 *
 * The comments a server render puts between adjacent text nodes (`<!-- -->`)
 * are dropped, so `Preview: {greeting}` reads as `Preview: Hello` to a
 * text assertion, as it does on screen.
 */
export async function renderToHtml(node: ReactNode): Promise<string> {
  const { prerender } = await import('react-dom/static')
  const errors: unknown[] = []
  const { prelude } = await prerender(node, {
    onError(error: unknown) {
      errors.push(error)
    },
  })
  const chunks: string[] = []
  const decoder = new TextDecoder()
  const reader = prelude.getReader()
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    chunks.push(decoder.decode(value, { stream: true }))
  }
  chunks.push(decoder.decode())
  if (errors.length > 0) throw errors[0]
  return chunks.join('').replaceAll('<!-- -->', '')
}

// A registered component is a plain component or a `lazy` one; both render.
async function renderComponent(component: unknown, props: object): Promise<string> {
  const { createElement } = await import('react')
  return renderToHtml(createElement(component as ComponentType<object>, props))
}

// ── The renderer host ────────────────────────────────────────────────────────

export type FakeRendererHostOptions = FakeModuleIdentity & {
  /**
   * The module's main half: `invoke` reaches its channels, `subscribe` hears
   * its `emit`, and the module app state, the Backlog, usage and workspace
   * git info are its.
   */
  main?: FakeMainHost
  /** The open workspaces. Default: the main fake's, or one `ws-app`. */
  workspaces?: readonly ModuleWorkspaceView[]
  /** The workspace this window shows (`getActiveWorkspaceId`). Default: the first workspace, or null. */
  activeWorkspaceId?: string | null
  /** Backlog items per workspace id, seeded into the Backlog (`services.backlog`). */
  backlogItems?: Record<string, readonly FakeBacklogItemInput[]>
  /** Module app state already saved (added to the main fake's, given one). */
  appState?: Record<string, unknown>
  /** Workspace module state already saved, per workspace id. */
  workspaceState?: Record<string, unknown>
  colorScheme?: ModuleColorScheme
  /** What `listChatRuntimes` answers. Default: Claude Code with no model choice. */
  chatRuntimes?: ModuleChatRuntimeOption[]
  /** What `supports` answers true for. Default: every capability this SDK knows. */
  capabilities?: readonly string[]
  /** The clock the renderer's own Backlog and usage fakes stamp with. Default: `Date.now`. */
  now?: () => number
}

/** Everything the module registered, by kind. */
export type FakeRendererRegistrations = {
  panels: Map<string, WorkspacePanelComponent>
  workspaceTypes: WorkspaceTypeDefinition[]
  backlogItemActions: BacklogItemAction[]
  backlogLinkProviders: BacklogLinkProvider[]
  fileActions: FileAction[]
  notificationActionProviders: NotificationActionProvider[]
  commands: ModuleCommandDefinition[]
  settingsSections: SettingsSectionDefinition[]
  sidebarNavEntries: SidebarNavEntryDefinition[]
  doorBadges: DoorBadgeContribution[]
  topBarItems: TopBarItemDefinition[]
  globalSurfaces: GlobalSurfaceDefinition[]
  modalSurfaces: ModalSurfaceDefinition[]
}

/** A toast the module showed, as the toast region got it (trimmed and clipped). */
export type FakeToast = {
  tone: ModuleToastTone
  message: string
  detail?: string
  /** Its button: call `run()` to press it, as the person would. */
  action?: ModuleToastInput['action']
  /** Whether the module called the dismisser `toast` returned. */
  dismissed: boolean
}

export type FakeRendererHost = {
  /** Hand this to `registerRenderer`. */
  host: RendererHost
  permissions: Set<string>
  registrations: FakeRendererRegistrations
  /** Every host method called, with its arguments, in order. */
  calls: Array<{ method: string; args: unknown[] }>
  openedChats: ModuleOpenChatInput[]
  focusedTabs: ModuleFocusTabInput[]
  openedSurfaces: Array<{ kind: 'global' | 'modal' | 'workspace'; id: string }>
  /** Every toast shown, in order (none while `supports('toast')` is false). */
  toasts: FakeToast[]
  /** Every URL `openExternal` handed to the system browser, normalised. */
  openedUrls: string[]
  /** The view each of the module's surfaces last said it shows (`setSurfaceView`), by surface id. */
  surfaceViews: Record<string, string | null>
  /** Host methods used without a permission that covers them. A clean module leaves this empty. */
  undeclared: FakeUndeclaredUse[]
  /**
   * The world the renderer reads and writes: the main fake's when given one.
   * `workspaces.setGitInfo` scripts `getWorkspaceGitInfo`, `backlog` holds the
   * Backlog, `usage` the token usage `queryUsage` sums.
   */
  services: Pick<FakeServices, 'workspaces' | 'backlog' | 'usage'>
  /** Module app state as saved. */
  appState(): Record<string, unknown>
  /** Workspace module state as saved for a workspace. */
  workspaceState(workspaceId: string): unknown
  /** Deliver an event to `subscribe` listeners, as the module's main half would. */
  emit(topic: string, payload?: unknown): void
  /** Change the open workspaces; `watchWorkspaces` listeners hear it. */
  setWorkspaces(workspaces: readonly ModuleWorkspaceView[]): void
  /** Show another workspace in this window (null for none); `watchActiveWorkspace` listeners hear it. */
  setActiveWorkspace(workspaceId: string | null): void
  /** Replace the Backlog of a workspace (`services.backlog.seed`); `watchBacklogItems` listeners hear it. */
  setBacklogItems(workspaceId: string, items: readonly FakeBacklogItemInput[]): void
  setColorScheme(scheme: ModuleColorScheme): void
  /** Deliver a change to a `watchWorkspaceFile` watch. */
  changeWorkspaceFile(workspaceId: string, relativePath: string, event: WorkspaceFileWatchEvent): void
  /** Render what the module registered, to HTML. Rejects when a component throws. */
  render: {
    surface(id: string): Promise<string>
    modal(id: string, props?: { workspaceId?: string }): Promise<string>
    panel(componentId: string, props?: { workspaceId?: string }): Promise<string>
    settings(id: string): Promise<string>
    topBar(id: string): Promise<string>
    navEntry(id: string, props?: { collapsed?: boolean; badge?: SidebarNavEntryBadge | null }): Promise<string>
  }
  /**
   * Run a registered command as the palette would: refused when its
   * `availability` says no, and handed the `ModuleCommandContext` (this
   * window's active workspace and its mode, overridable with `context`).
   */
  runCommand(id: string, context?: Partial<ModuleCommandContext>): Promise<void>
}

// Permissions for renderer host methods: disclosure for most, and checked by
// the host for the ones in CHECKED_RENDERER_METHODS (which answer
// `permission_missing` or throw, as the host does).
const RENDERER_METHOD_PERMISSIONS: Readonly<Record<string, readonly string[]>> = {
  getWorkspace: ['ipc:workspace-read'],
  listWorkspaces: ['ipc:workspace-read'],
  watchWorkspaces: ['ipc:workspace-read'],
  getWorkingRoot: ['ipc:workspace-read'],
  getWorkspaceGitInfo: ['ipc:workspace-read'],
  getWorkspaceModuleState: ['storage'],
  setWorkspaceModuleState: ['storage'],
  getModuleAppState: ['storage'],
  setModuleAppState: ['storage'],
  watchModuleAppState: ['storage'],
  listBacklogItems: ['backlog.read'],
  watchBacklogItems: ['backlog.read'],
  getBacklogLocation: ['backlog.read'],
  createBacklogItem: ['backlog.write'],
  updateBacklogStatus: ['backlog.write'],
  updateBacklogTriage: ['backlog.write'],
  addBacklogLink: ['backlog.write'],
  updateBacklogModuleMetadata: ['backlog.write'],
  queryUsage: ['usage:read'],
  watchWorkspaceFile: ['filesystem:read-workspace'],
  openChat: ['conversation:operate'],
  invoke: [...BRIDGE_PERMISSIONS],
}
const CHECKED_RENDERER_METHODS = new Set([
  'openChat',
  'invoke',
  'getWorkspaceGitInfo',
  'listBacklogItems',
  'watchBacklogItems',
  'getBacklogLocation',
  'createBacklogItem',
  'updateBacklogStatus',
  'updateBacklogTriage',
  'addBacklogLink',
  'updateBacklogModuleMetadata',
  'queryUsage',
])

const TOAST_TONES: ReadonlySet<string> = new Set<ModuleToastTone>(['neutral', 'accent', 'good', 'warn', 'error'])
const MAX_TOAST_MESSAGE_LENGTH = 200
const MAX_TOAST_DETAIL_LENGTH = 500

// What `openExternal` takes: an absolute http(s) URL with no credentials.
function externalHttpUrl(url: unknown): string | null {
  if (typeof url !== 'string' || url.trim().length === 0) return null
  try {
    const parsed = new URL(url.trim())
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null
    if (parsed.username || parsed.password) return null
    return parsed.toString()
  } catch {
    return null
  }
}

type BacklogRegistry = {
  list(moduleId: string, workspaceId: string): Promise<{ ok: boolean; items?: BacklogItemView[]; message?: string }>
} & Record<string, (moduleId: string, ...args: never[]) => Promise<unknown>>
type UsageRegistry = { query(moduleId: string, query: UsageQuery): Promise<UsageQueryResult> }

export function createFakeRendererHost(options: FakeRendererHostOptions): FakeRendererHost {
  const main = options.main
  // Given only the main half, the renderer is the same module with the same
  // (live) permissions.
  const { moduleId, permissions } =
    !options.moduleId && !options.manifest && main
      ? { moduleId: main.host.moduleId, permissions: main.permissions }
      : identityOf(options)
  const internals = main ? mainInternals.get(main) : undefined
  const capabilities = new Set<string>(options.capabilities ?? KNOWN_CAPABILITIES)
  let workspaces: ModuleWorkspaceView[] = (
    options.workspaces ??
    internals?.workspaces.all() ??
    DEFAULT_FAKE_WORKSPACES
  ).map((workspace) => ({ ...workspace }))

  // The services behind the renderer's Backlog, usage and git-info methods:
  // the main fake's (the host bridges to main's registries), or the
  // renderer's own when it is tested alone.
  const world = ((): {
    workspaces: ReturnType<typeof createFakeWorkspaces>
    backlog: { registry: BacklogRegistry; handle: FakeBacklog }
    usage: { registry: UsageRegistry; handle: FakeUsage }
    appState: AppStateStore
  } => {
    if (main && internals) {
      return {
        workspaces: internals.workspaces,
        backlog: {
          registry: internals.registry('backlog.module-service') as BacklogRegistry,
          handle: main.services.backlog,
        },
        usage: { registry: internals.registry('usage.module-service') as UsageRegistry, handle: main.services.usage },
        appState: internals.appState,
      }
    }
    const own = createFakeWorkspaces(workspaces, options.now)
    const context: FakeServiceContext = { moduleId, permissions, now: options.now ?? Date.now, workspaces: own }
    const backlog = SERVICE_FAKES['backlog.module-service']!.create(context)
    const usage = SERVICE_FAKES['usage.module-service']!.create(context)
    return {
      workspaces: own,
      backlog: { registry: backlog.registry as BacklogRegistry, handle: backlog.handle as FakeBacklog },
      usage: { registry: usage.registry as UsageRegistry, handle: usage.handle as FakeUsage },
      appState: createAppStateStore(undefined),
    }
  })()
  for (const [key, value] of Object.entries(options.appState ?? {})) world.appState.set(key, value)
  for (const [workspaceId, items] of Object.entries(options.backlogItems ?? {})) {
    world.backlog.handle.seed(workspaceId, items)
  }

  const workspaceState = new Map(Object.entries(structuredClone(options.workspaceState ?? {})))
  let colorScheme: ModuleColorScheme = options.colorScheme ?? 'light'
  let activeWorkspaceId: string | null =
    options.activeWorkspaceId !== undefined ? options.activeWorkspaceId : (workspaces[0]?.id ?? null)
  const chatRuntimes = options.chatRuntimes ?? [
    { id: 'claude', label: 'Claude Code', available: true, models: [], lastSelected: true },
  ]

  const subscribers = new Set<{ topic: string; cb: (payload: unknown) => void }>()
  const workspaceWatchers = new Set<(list: ModuleWorkspaceView[]) => void>()
  const activeWorkspaceWatchers = new Set<(workspaceId: string | null) => void>()
  const schemeWatchers = new Set<(scheme: ModuleColorScheme) => void>()
  const fileWatchers = new Set<{ key: string; cb: (event: WorkspaceFileWatchEvent) => void }>()
  let nextChat = 1

  const registrations: FakeRendererRegistrations = {
    panels: new Map(),
    workspaceTypes: [],
    backlogItemActions: [],
    backlogLinkProviders: [],
    fileActions: [],
    notificationActionProviders: [],
    commands: [],
    settingsSections: [],
    sidebarNavEntries: [],
    doorBadges: [],
    topBarItems: [],
    globalSurfaces: [],
    modalSurfaces: [],
  }

  const fake: FakeRendererHost = {
    host: undefined as unknown as RendererHost,
    permissions,
    registrations,
    calls: [],
    openedChats: [],
    focusedTabs: [],
    openedSurfaces: [],
    toasts: [],
    openedUrls: [],
    surfaceViews: {},
    undeclared: [],
    services: { workspaces: world.workspaces, backlog: world.backlog.handle, usage: world.usage.handle },
    appState: () => world.appState.all(),
    workspaceState: (workspaceId) => structuredClone(workspaceState.get(workspaceId)),
    emit(topic, payload) {
      for (const subscriber of subscribers) {
        if (subscriber.topic === topic) subscriber.cb(structuredClone(payload))
      }
    },
    setWorkspaces(next) {
      workspaces = next.map((workspace) => ({ ...workspace }))
      if (!main) {
        for (const workspace of world.workspaces.all()) world.workspaces.remove(workspace.id)
        for (const workspace of workspaces) world.workspaces.add(workspace)
      }
      for (const cb of workspaceWatchers) cb(workspaces.map((workspace) => ({ ...workspace })))
    },
    setActiveWorkspace(workspaceId) {
      if (workspaceId === activeWorkspaceId) return
      activeWorkspaceId = workspaceId
      for (const cb of [...activeWorkspaceWatchers]) cb(workspaceId)
    },
    setBacklogItems(workspaceId, items) {
      world.backlog.handle.seed(workspaceId, items)
    },
    setColorScheme(scheme) {
      colorScheme = scheme
      for (const cb of schemeWatchers) cb(scheme)
    },
    changeWorkspaceFile(workspaceId, relativePath, event) {
      for (const watcher of fileWatchers) {
        if (watcher.key === `${workspaceId}\u0000${relativePath}`) watcher.cb(event)
      }
    },
    render: {
      surface: (id) => renderComponent(find(registrations.globalSurfaces, id, 'global surface').Component, {}),
      modal: (id, props = {}) =>
        renderComponent(find(registrations.modalSurfaces, id, 'modal surface').Component, props),
      panel(componentId, props = {}) {
        const component = registrations.panels.get(componentId)
        if (!component) throw new Error(`No panel "${componentId}" is registered.`)
        return renderComponent(component, { workspaceId: props.workspaceId ?? workspaces[0]?.id ?? 'ws-app' })
      },
      settings: (id) =>
        renderComponent(find(registrations.settingsSections, id, 'settings section').Component, {
          values: world.appState.all(),
          setValue(key: string, value: unknown) {
            world.appState.set(key, value)
          },
        }),
      topBar: (id) => renderComponent(find(registrations.topBarItems, id, 'top-bar item').Component, {}),
      navEntry: (id, props = {}) =>
        renderComponent(find(registrations.sidebarNavEntries, id, 'sidebar nav entry').Component, {
          collapsed: props.collapsed ?? false,
          badge: props.badge ?? null,
        }),
    },
    async runCommand(id, overrides) {
      const command = find(registrations.commands, id, 'command')
      const context: ModuleCommandContext = {
        activeWorkspaceId,
        activeWorkspaceMode: workspaces.find((workspace) => workspace.id === activeWorkspaceId)?.mode ?? null,
        ...overrides,
      }
      const { availability } = command
      const available =
        typeof availability === 'function'
          ? availability(context)
          : !availability?.includes('activeWorkspace') || context.activeWorkspaceId !== null
      if (!available) throw new Error(`Command "${id}" is not available here, so the palette would not offer it.`)
      // An older host calls the handler with nothing.
      if (capabilities.has('command-context')) await command.run(context)
      else await (command.run as () => void | Promise<void>)()
    },
  }

  function find<T extends { id: string }>(list: readonly T[], id: string, kind: string): T {
    const found = list.find((entry) => entry.id === id)
    if (!found) {
      throw new Error(
        `No ${kind} "${id}" is registered; the module registered ${list.map((entry) => entry.id).join(', ') || 'none'}.`,
      )
    }
    return found
  }
  function record(method: string, args: unknown[]): void {
    fake.calls.push({ method, args })
    const needs = RENDERER_METHOD_PERMISSIONS[method]
    if (needs && !needs.some((permission) => permissions.has(permission))) {
      if (!fake.undeclared.some((use) => use.what === method)) {
        fake.undeclared.push({ what: method, needs, checked: CHECKED_RENDERER_METHODS.has(method) })
      }
    }
  }
  function registerUnique<T extends { id: string }>(list: T[], definition: T, kind: string): void {
    if (list.some((entry) => entry.id === definition.id))
      throw new Error(`${kind} "${definition.id}" is already registered.`)
    list.push(definition)
  }
  const resolveWorkspace = (id: string): ModuleWorkspaceView | null => {
    const found = workspaces.find((workspace) => workspace.id === id)
    return found ? { ...found } : null
  }
  // The renderer's Backlog reads throw without `backlog.read`, as the host's do.
  const requireBacklogRead = (): void => {
    if (permissions.has('backlog.read')) return
    throw new Error(
      `Module "${moduleId}" does not declare the "backlog.read" permission, so it cannot read the Backlog.`,
    )
  }
  const backlogCall = <T>(method: string, args: unknown[]): Promise<T> =>
    (world.backlog.registry[method] as (moduleId: string, ...rest: unknown[]) => Promise<T>)(moduleId, ...args)

  const host: RendererHost = {
    hostApiVersion: HOST_API_VERSION,
    moduleId,
    supports: (capability) => capabilities.has(capability),
    getAssetUrl(relativePath) {
      record('getAssetUrl', [relativePath])
      return `module-asset://${moduleId}/${validateAssetPath(relativePath, moduleId).map(encodeURIComponent).join('/')}`
    },
    registerPanel(componentId, component) {
      record('registerPanel', [componentId, component])
      if (registrations.panels.has(componentId)) throw new Error(`Panel "${componentId}" is already registered.`)
      registrations.panels.set(componentId, component)
    },
    registerWorkspaceType(definition) {
      record('registerWorkspaceType', [definition])
      registerUnique(registrations.workspaceTypes, definition, 'Workspace type')
    },
    async openWorkspace(typeId) {
      record('openWorkspace', [typeId])
      if (!registrations.workspaceTypes.some((type) => type.id === typeId)) {
        throw new Error(`Workspace type "${typeId}" is not registered by module "${moduleId}".`)
      }
      fake.openedSurfaces.push({ kind: 'workspace', id: typeId })
      return `ws-${typeId}`
    },
    registerBacklogItemAction(action) {
      record('registerBacklogItemAction', [action])
      registerUnique(registrations.backlogItemActions, action, 'Backlog action')
    },
    registerBacklogLinkProvider(provider) {
      record('registerBacklogLinkProvider', [provider])
      registrations.backlogLinkProviders.push(provider)
    },
    registerFileAction(action) {
      record('registerFileAction', [action])
      registerUnique(registrations.fileActions, action, 'File action')
    },
    registerNotificationActionProvider(provider) {
      record('registerNotificationActionProvider', [provider])
      // An installed module's bell rows are filed under its own id, the only source it may claim.
      if (provider.source !== moduleId) {
        throw new Error(
          `Module "${moduleId}" may only register a notification action provider for its own rows (source "${moduleId}"); got "${provider.source}".`,
        )
      }
      if (registrations.notificationActionProviders.some((existing) => existing.source === provider.source)) {
        throw new Error(
          `Notification action provider for source "${provider.source}" is already registered by module "${moduleId}".`,
        )
      }
      registrations.notificationActionProviders.push(provider)
    },
    registerCommand(definition) {
      record('registerCommand', [definition])
      registerUnique(registrations.commands, definition, 'Command')
    },
    registerSettingsSection(definition) {
      record('registerSettingsSection', [definition])
      registerUnique(registrations.settingsSections, definition, 'Settings section')
    },
    registerSidebarNavEntry(definition) {
      record('registerSidebarNavEntry', [definition])
      registerUnique(registrations.sidebarNavEntries, definition, 'Sidebar nav entry')
    },
    registerDoorBadge(contribution) {
      record('registerDoorBadge', [contribution])
      const rowId = typeof contribution.rowId === 'string' ? contribution.rowId.trim() : ''
      if (!rowId) throw new Error('Door badge row id must be a non-empty string.')
      if (registrations.doorBadges.some((existing) => existing.rowId === rowId)) {
        throw new Error(`Door badge for row "${rowId}" is already registered by module "${moduleId}".`)
      }
      registrations.doorBadges.push({ ...contribution, rowId })
    },
    registerTopBarItem(definition) {
      record('registerTopBarItem', [definition])
      registerUnique(registrations.topBarItems, definition, 'Top-bar item')
    },
    registerGlobalSurface(definition) {
      record('registerGlobalSurface', [definition])
      registerUnique(registrations.globalSurfaces, definition, 'Global surface')
    },
    registerModalSurface(definition) {
      record('registerModalSurface', [definition])
      registerUnique(registrations.modalSurfaces, definition, 'Modal surface')
    },
    openGlobalSurface(id) {
      record('openGlobalSurface', [id])
      if (!registrations.globalSurfaces.some((surface) => surface.id === id)) return false
      fake.openedSurfaces.push({ kind: 'global', id })
      return true
    },
    openModalSurface(id) {
      record('openModalSurface', [id])
      if (!registrations.modalSurfaces.some((surface) => surface.id === id)) return false
      fake.openedSurfaces.push({ kind: 'modal', id })
      return true
    },
    async listBacklogItems(workspaceId) {
      record('listBacklogItems', [workspaceId])
      requireBacklogRead()
      const listed = await world.backlog.registry.list(moduleId, workspaceId)
      if (!listed.ok) throw new Error(listed.message)
      return listed.items ?? []
    },
    watchBacklogItems(workspaceId, cb, watchOptions) {
      record('watchBacklogItems', [workspaceId, cb, watchOptions])
      requireBacklogRead()
      return world.backlog.handle.watch(workspaceId, cb, watchOptions?.onError)
    },
    getBacklogLocation(workspaceId) {
      record('getBacklogLocation', [workspaceId])
      return backlogCall('getLocation', [workspaceId])
    },
    createBacklogItem(workspaceId, input) {
      record('createBacklogItem', [workspaceId, input])
      return backlogCall('create', [workspaceId, input])
    },
    updateBacklogStatus(workspaceId, itemId, status) {
      record('updateBacklogStatus', [workspaceId, itemId, status])
      return backlogCall('updateStatus', [workspaceId, itemId, status])
    },
    updateBacklogTriage(workspaceId, itemId, triage) {
      record('updateBacklogTriage', [workspaceId, itemId, triage])
      return backlogCall('updateTriage', [workspaceId, itemId, triage])
    },
    addBacklogLink(workspaceId, itemId, link) {
      record('addBacklogLink', [workspaceId, itemId, link])
      return backlogCall('addLink', [workspaceId, itemId, link])
    },
    updateBacklogModuleMetadata(workspaceId, itemId, value) {
      record('updateBacklogModuleMetadata', [workspaceId, itemId, value])
      return backlogCall('updateModuleMetadata', [workspaceId, itemId, value])
    },
    queryUsage(query) {
      record('queryUsage', [query])
      return world.usage.registry.query(moduleId, query)
    },
    async getWorkspace(workspaceId) {
      record('getWorkspace', [workspaceId])
      return resolveWorkspace(workspaceId)
    },
    async listWorkspaces() {
      record('listWorkspaces', [])
      return workspaces.map((workspace) => ({ ...workspace }))
    },
    async getWorkspaceGitInfo(workspaceId) {
      record('getWorkspaceGitInfo', [workspaceId])
      if (!permissions.has('ipc:workspace-read')) {
        return {
          ok: false,
          code: 'permission_missing',
          message: `Module "${moduleId}" must declare the "ipc:workspace-read" permission to read a workspace's git information.`,
        }
      }
      return world.workspaces.gitInfo(workspaceId)
    },
    watchWorkspaces(cb) {
      record('watchWorkspaces', [cb])
      workspaceWatchers.add(cb)
      cb(workspaces.map((workspace) => ({ ...workspace })))
      return () => {
        workspaceWatchers.delete(cb)
      }
    },
    watchColorScheme(cb) {
      record('watchColorScheme', [cb])
      schemeWatchers.add(cb)
      cb(colorScheme)
      return () => {
        schemeWatchers.delete(cb)
      }
    },
    getWorkspaceModuleState<T = unknown>(workspaceId: string): T | undefined {
      record('getWorkspaceModuleState', [workspaceId])
      return resolveWorkspace(workspaceId)
        ? (structuredClone(workspaceState.get(workspaceId)) as T | undefined)
        : undefined
    },
    setWorkspaceModuleState(workspaceId, state) {
      record('setWorkspaceModuleState', [workspaceId, state])
      if (!resolveWorkspace(workspaceId)) return false
      workspaceState.set(workspaceId, structuredClone(state))
      return true
    },
    getModuleAppState<T = unknown>(key: string): T | undefined {
      record('getModuleAppState', [key])
      return world.appState.get(key) as T | undefined
    },
    setModuleAppState(key, value) {
      record('setModuleAppState', [key, value])
      world.appState.set(key, value)
      return true
    },
    watchModuleAppState(cb) {
      record('watchModuleAppState', [cb])
      const stop = world.appState.subscribe(cb)
      cb(world.appState.all())
      return stop
    },
    subscribe(topic, cb) {
      record('subscribe', [topic, cb])
      const subscriber = { topic, cb }
      subscribers.add(subscriber)
      return () => {
        subscribers.delete(subscriber)
      }
    },
    async getWorkingRoot(workspaceId) {
      record('getWorkingRoot', [workspaceId])
      return resolveWorkspace(workspaceId)?.folderPath ?? null
    },
    async watchWorkspaceFile(workspaceId, relativePath, cb) {
      record('watchWorkspaceFile', [workspaceId, relativePath, cb])
      const watcher = { key: `${workspaceId}\u0000${relativePath}`, cb }
      fileWatchers.add(watcher)
      return () => {
        fileWatchers.delete(watcher)
      }
    },
    focusTab(input) {
      record('focusTab', [input])
      fake.focusedTabs.push({ ...input })
      return true
    },
    async openChat(input): Promise<ModuleOpenChatResult> {
      record('openChat', [input])
      if (!permissions.has('conversation:operate')) {
        return {
          ok: false,
          code: 'permission_missing',
          message: `Module "${moduleId}" does not declare the "conversation:operate" permission, so it cannot open a chat.`,
        }
      }
      const workspace = resolveWorkspace(input.workspaceId)
      if (!workspace) return { ok: false, code: 'unknown_workspace', message: `No workspace "${input.workspaceId}".` }
      if (!workspace.folderPath) {
        return {
          ok: false,
          code: 'workspace_folder_missing',
          message: `Workspace "${input.workspaceId}" has no project folder.`,
        }
      }
      fake.openedChats.push(structuredClone(input))
      // The chat belongs to the module, as one `openChat` opens does: the main
      // half's conversation service sees it.
      const conversations = internals?.registry('conversation.module-service') as
        | { create(moduleId: string, input: object): Promise<{ ok: boolean; conversation?: { agentId: string } }> }
        | undefined
      if (conversations) {
        const created = await conversations.create(moduleId, {
          workspaceId: input.workspaceId,
          ...(input.cli ? { cli: input.cli } : {}),
          ...(input.model ? { model: input.model } : {}),
          ...(input.send && input.prompt ? { prompt: input.prompt } : {}),
          ...(input.skills ? { skills: input.skills } : {}),
        })
        if (created.ok && created.conversation) return { ok: true, agentId: created.conversation.agentId }
      }
      return { ok: true, agentId: `chat-${nextChat++}` }
    },
    listChatRuntimes() {
      record('listChatRuntimes', [])
      return structuredClone(chatRuntimes)
    },
    toast(input) {
      record('toast', [input])
      if (!input || typeof input !== 'object') throw new Error('toast(...) requires a payload object.')
      if (typeof input.tone !== 'string' || !TOAST_TONES.has(input.tone)) {
        throw new Error('toast(...) tone must be "neutral", "accent", "good", "warn" or "error".')
      }
      const message = typeof input.message === 'string' ? input.message.trim() : ''
      if (message.length === 0) throw new Error('toast(...) requires a non-empty message.')
      if (input.detail !== undefined && typeof input.detail !== 'string') {
        throw new Error('toast(...) detail must be a string when provided.')
      }
      const action = input.action
      if (
        action !== undefined &&
        (!action || typeof action.label !== 'string' || !action.label.trim() || typeof action.run !== 'function')
      ) {
        throw new Error('toast(...) action must be { label, run } with a non-empty label.')
      }
      // A window with no toast region shows nothing; the dismisser does nothing.
      if (!capabilities.has('toast')) return () => {}
      const detail = input.detail?.trim()
      const shown: FakeToast = {
        tone: input.tone,
        message: message.slice(0, MAX_TOAST_MESSAGE_LENGTH),
        ...(detail ? { detail: detail.slice(0, MAX_TOAST_DETAIL_LENGTH) } : {}),
        ...(action ? { action: { label: action.label.trim(), run: action.run } } : {}),
        dismissed: false,
      }
      fake.toasts.push(shown)
      return () => {
        shown.dismissed = true
      }
    },
    getActiveWorkspaceId() {
      record('getActiveWorkspaceId', [])
      return activeWorkspaceId
    },
    watchActiveWorkspace(cb) {
      record('watchActiveWorkspace', [cb])
      activeWorkspaceWatchers.add(cb)
      cb(activeWorkspaceId)
      return () => {
        activeWorkspaceWatchers.delete(cb)
      }
    },
    setSurfaceView(surfaceId, viewId) {
      record('setSurfaceView', [surfaceId, viewId])
      const id = typeof surfaceId === 'string' ? surfaceId.trim() : ''
      const surface = registrations.globalSurfaces.find((entry) => entry.id === id)
      if (!surface) return false
      if (viewId === null) {
        fake.surfaceViews[surface.id] = null
        return true
      }
      const wanted = typeof viewId === 'string' ? viewId.trim() : ''
      const view = surface.views?.find((candidate) => candidate.id === wanted)
      if (!view) return false
      fake.surfaceViews[surface.id] = view.id
      return true
    },
    async openExternal(url): Promise<ModuleOpenExternalResult> {
      record('openExternal', [url])
      const safe = externalHttpUrl(url)
      if (!safe) return { ok: false, code: 'invalid_url', message: 'Only an absolute http(s) URL can be opened.' }
      if (!capabilities.has('open-external')) {
        return { ok: false, code: 'unavailable', message: 'This window cannot open links yet.' }
      }
      fake.openedUrls.push(safe)
      return { ok: true }
    },
    async invoke(channel, payload) {
      record('invoke', [channel, payload])
      if (typeof channel !== 'string' || !channel.startsWith(`${moduleId}:`)) {
        throw new Error(`Module "${moduleId}" may only invoke its own channels ("${moduleId}:*"); got "${channel}".`)
      }
      if (!main) throw refusal(`No module has registered the IPC channel "${channel}".`, 'unknown_channel')
      return main.ipc.invoke(channel, payload)
    },
  }
  fake.host = host
  main?.onEmit((topic, payload) => fake.emit(topic, payload))
  return fake
}
