// `@sprintengine/module-sdk/testing` — fake hosts for testing a module in Node,
// without the app.
//
// - `createFakeMainHost` is a `MainHost` with stateful fakes of every service
//   the SDK publishes (storage, chats, scheduled agents, companions, secrets,
//   GitHub, workspaces), held to the host's rules: the same storage key
//   pattern, root rule and 1 MB cap, the same `permission_missing` answers for
//   the permissions the host checks, the same refusals on the renderer bridge.
//   `ipc.invoke` calls the module's channels the way its renderer would and
//   `tools.call` calls its MCP tools the way an agent would.
// - `createFakeRendererHost` is a `RendererHost` that records every
//   registration and renders a registered door, panel, modal, settings
//   section or top-bar item to HTML; `invoke` and `subscribe` reach a fake
//   main host when given one.
// - `installTestingKit` routes `@sprintengine/module-sdk/ui`, `/surface` and
//   `@monaco-editor/react` to a pass-through kit (`./testing/kit`) whose
//   components draw their props and children, so a built renderer bundle loads
//   and renders in Node, and a door that throws on render fails its test.
//
// Node only (it uses `node:module` hooks); never import it from module code.

import { registerHooks } from 'node:module'
import { isAbsolute } from 'node:path'

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
  ModuleCommandDefinition,
  ModuleFocusTabInput,
  ModuleNotifyInput,
  ModuleSkillRegistration,
  ModuleWorkspaceView,
  NotificationActionProvider,
  RendererHost,
  ServiceToken,
  SettingsSectionDefinition,
  SidebarNavEntryDefinition,
  SidecarSpec,
  TopBarItemDefinition,
  WorkspaceFileWatchEvent,
  WorkspacePanelComponent,
  WorkspaceTypeDefinition,
} from './index.js'
import type { ModuleChatRuntimeOption, ModuleOpenChatInput, ModuleOpenChatResult } from './conversation.js'
import { moduleServiceRequirement } from './services.js'
import {
  createFakeWorkspaces,
  SERVICE_FAKES,
  type FakeServiceContext,
  type FakeServices,
  type FakeWorkspaces,
} from './testing-services.js'
import type { ComponentType, ReactNode } from 'react'

export type {
  FakeCompanions,
  FakeCompanionTurn,
  FakeConversationEventInput,
  FakeConversationRecord,
  FakeConversations,
  FakeGitHub,
  FakeGitHubAnswer,
  FakeScheduledAgents,
  FakeSecretRequest,
  FakeSecrets,
  FakeServiceContext,
  FakeServices,
  FakeStorage,
  FakeWorkspaces,
} from './testing-services.js'
export { MODULE_STORAGE_VALUE_LIMIT_BYTES } from './testing-services.js'

// ── Shared pieces ────────────────────────────────────────────────────────────

/** The workspace every fake starts with when a test names none. */
export const DEFAULT_FAKE_WORKSPACES: readonly ModuleWorkspaceView[] = [
  { id: 'ws-app', name: 'App', folderPath: '/Users/dev/projects/app', mode: 'standard' },
]

// Every capability this SDK knows. A fake answers `supports` with these unless
// told otherwise, so a module's "older host" branch is opt-in to test.
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
  'electron-main',
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

function validateNotify(moduleId: string, input: unknown): ModuleNotifyInput {
  const { severity, title, body } = (input ?? {}) as Record<string, unknown>
  const fail = (message: string): never => {
    throw new Error(`Module "${moduleId}" notify(...) ${message}`)
  }
  if (typeof input !== 'object' || input === null) fail('requires a payload object.')
  if (typeof severity !== 'string' || !NOTIFY_SEVERITIES.includes(severity)) {
    fail('severity must be "info", "warning", or "error".')
  }
  if (typeof title !== 'string' || !title.trim()) fail('requires a non-empty title.')
  if (body !== undefined && typeof body !== 'string') fail('body must be a string when provided.')
  const trimmed = (body as string | undefined)?.trim()
  return {
    severity: severity as ModuleNotifyInput['severity'],
    title: (title as string).trim(),
    ...(trimmed ? { body: trimmed } : {}),
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
}

type MainInternals = {
  moduleId: string
  workspaces: ReturnType<typeof createFakeWorkspaces>
  registry(key: string): object | undefined
}
const mainInternals = new WeakMap<FakeMainHost, MainInternals>()

export function createFakeMainHost(options: FakeMainHostOptions): FakeMainHost {
  const { moduleId, permissions } = identityOf(options)
  const now = options.now ?? Date.now
  const workspaces = createFakeWorkspaces(options.workspaces ?? DEFAULT_FAKE_WORKSPACES)
  const capabilities = new Set<string>(options.capabilities ?? KNOWN_CAPABILITIES)
  const context: FakeServiceContext = { moduleId, permissions, now, workspaces }

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
    skills: { registered: [], ensured: [] },
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
      if (!fake.skills.registered.some((skill) => skill.id === skillId) && !builtinSkills.has(skillId)) {
        return { ok: false, status: 'unknown-skill', message: `No skill "${skillId}" is registered.` }
      }
      return { ok: true, status: 'installed' }
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
  mainInternals.set(fake, { moduleId, workspaces, registry: (key) => registries.get(key) })
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
  return chunks.join('')
}

// A registered component is a plain component or a `lazy` one; both render.
async function renderComponent(component: unknown, props: object): Promise<string> {
  const { createElement } = await import('react')
  return renderToHtml(createElement(component as ComponentType<object>, props))
}

// ── The renderer host ────────────────────────────────────────────────────────

export type FakeRendererHostOptions = FakeModuleIdentity & {
  /** The module's main half: `invoke` reaches its channels and `subscribe` hears its `emit`. */
  main?: FakeMainHost
  /** The open workspaces. Default: the main fake's, or one `ws-app`. */
  workspaces?: readonly ModuleWorkspaceView[]
  /** Backlog items per workspace id. */
  backlogItems?: Record<string, BacklogItemView[]>
  /** Module app state already saved. */
  appState?: Record<string, unknown>
  /** Workspace module state already saved, per workspace id. */
  workspaceState?: Record<string, unknown>
  colorScheme?: ModuleColorScheme
  /** What `listChatRuntimes` answers. Default: Claude Code with no model choice. */
  chatRuntimes?: ModuleChatRuntimeOption[]
  /** What `supports` answers true for. Default: every capability this SDK knows. */
  capabilities?: readonly string[]
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
  /** Host methods used without a permission that covers them. A clean module leaves this empty. */
  undeclared: FakeUndeclaredUse[]
  /** Module app state as saved. */
  appState(): Record<string, unknown>
  /** Workspace module state as saved for a workspace. */
  workspaceState(workspaceId: string): unknown
  /** Deliver an event to `subscribe` listeners, as the module's main half would. */
  emit(topic: string, payload?: unknown): void
  /** Change the open workspaces; `watchWorkspaces` listeners hear it. */
  setWorkspaces(workspaces: readonly ModuleWorkspaceView[]): void
  /** Change the Backlog of a workspace; `watchBacklogItems` listeners hear it. */
  setBacklogItems(workspaceId: string, items: BacklogItemView[]): void
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
    navEntry(id: string, props?: { collapsed?: boolean }): Promise<string>
  }
  /** Run a registered command as the palette would. */
  runCommand(id: string): Promise<void>
}

// Disclosure permissions for renderer host methods (the ones the host checks
// itself — `openChat`, `invoke` — answer for themselves).
const RENDERER_METHOD_PERMISSIONS: Readonly<Record<string, readonly string[]>> = {
  getWorkspace: ['ipc:workspace-read'],
  listWorkspaces: ['ipc:workspace-read'],
  watchWorkspaces: ['ipc:workspace-read'],
  getWorkingRoot: ['ipc:workspace-read'],
  getWorkspaceModuleState: ['storage'],
  setWorkspaceModuleState: ['storage'],
  getModuleAppState: ['storage'],
  setModuleAppState: ['storage'],
  watchModuleAppState: ['storage'],
  listBacklogItems: ['backlog.read'],
  watchBacklogItems: ['backlog.read'],
  watchWorkspaceFile: ['filesystem:read-workspace'],
  openChat: ['conversation:operate'],
  invoke: [...BRIDGE_PERMISSIONS],
}
const CHECKED_RENDERER_METHODS = new Set(['openChat', 'invoke'])

function validateAssetPath(relativePath: string): string[] {
  if (
    typeof relativePath !== 'string' ||
    !relativePath ||
    relativePath.startsWith('/') ||
    /[\\\0?#]/.test(relativePath)
  ) {
    throw new Error('Asset path must be a module-relative file path.')
  }
  const parts = relativePath.split('/')
  if (parts.some((part) => !part || part === '.' || part === '..')) {
    throw new Error('Asset path must stay inside the module directory.')
  }
  return parts
}

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
  const backlog = new Map(Object.entries(options.backlogItems ?? {}))
  const appState: Record<string, unknown> = structuredClone(options.appState ?? {})
  const workspaceState = new Map(Object.entries(structuredClone(options.workspaceState ?? {})))
  let colorScheme: ModuleColorScheme = options.colorScheme ?? 'light'
  const chatRuntimes = options.chatRuntimes ?? [
    { id: 'claude', label: 'Claude Code', available: true, models: [], lastSelected: true },
  ]

  const subscribers = new Set<{ topic: string; cb: (payload: unknown) => void }>()
  const workspaceWatchers = new Set<(list: ModuleWorkspaceView[]) => void>()
  const backlogWatchers = new Set<{ workspaceId: string; cb: (items: BacklogItemView[]) => void }>()
  const schemeWatchers = new Set<(scheme: ModuleColorScheme) => void>()
  const appStateWatchers = new Set<(values: Readonly<Record<string, unknown>>) => void>()
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
    undeclared: [],
    appState: () => structuredClone(appState),
    workspaceState: (workspaceId) => structuredClone(workspaceState.get(workspaceId)),
    emit(topic, payload) {
      for (const subscriber of subscribers) {
        if (subscriber.topic === topic) subscriber.cb(structuredClone(payload))
      }
    },
    setWorkspaces(next) {
      workspaces = next.map((workspace) => ({ ...workspace }))
      for (const cb of workspaceWatchers) cb(workspaces.map((workspace) => ({ ...workspace })))
    },
    setBacklogItems(workspaceId, items) {
      backlog.set(workspaceId, items)
      for (const watcher of backlogWatchers) {
        if (watcher.workspaceId === workspaceId) watcher.cb(structuredClone(items))
      }
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
          values: structuredClone(appState),
          setValue(key: string, value: unknown) {
            appState[key] = structuredClone(value)
          },
        }),
      topBar: (id) => renderComponent(find(registrations.topBarItems, id, 'top-bar item').Component, {}),
      navEntry: (id, props = {}) =>
        renderComponent(find(registrations.sidebarNavEntries, id, 'sidebar nav entry').Component, {
          collapsed: props.collapsed ?? false,
        }),
    },
    async runCommand(id) {
      await find(registrations.commands, id, 'command').run()
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

  const host: RendererHost = {
    hostApiVersion: HOST_API_VERSION,
    supports: (capability) => capabilities.has(capability),
    getAssetUrl(relativePath) {
      record('getAssetUrl', [relativePath])
      return `module-asset://${moduleId}/${validateAssetPath(relativePath).map(encodeURIComponent).join('/')}`
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
      registrations.doorBadges.push(contribution)
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
      return structuredClone(backlog.get(workspaceId) ?? [])
    },
    watchBacklogItems(workspaceId, cb) {
      record('watchBacklogItems', [workspaceId, cb])
      const watcher = { workspaceId, cb }
      backlogWatchers.add(watcher)
      cb(structuredClone(backlog.get(workspaceId) ?? []))
      return () => {
        backlogWatchers.delete(watcher)
      }
    },
    async getWorkspace(workspaceId) {
      record('getWorkspace', [workspaceId])
      return resolveWorkspace(workspaceId)
    },
    async listWorkspaces() {
      record('listWorkspaces', [])
      return workspaces.map((workspace) => ({ ...workspace }))
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
      return structuredClone(appState[key]) as T | undefined
    },
    setModuleAppState(key, value) {
      record('setModuleAppState', [key, value])
      appState[key] = structuredClone(value)
      for (const cb of appStateWatchers) cb(structuredClone(appState))
      return true
    },
    watchModuleAppState(cb) {
      record('watchModuleAppState', [cb])
      appStateWatchers.add(cb)
      cb(structuredClone(appState))
      return () => {
        appStateWatchers.delete(cb)
      }
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
