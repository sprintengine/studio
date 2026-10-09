// Stateful fakes of the host services a module resolves, for
// `createFakeMainHost` (`@sprintengine/module-sdk/testing`).
//
// Each fake is the moduleId-first registry the app provides under the
// service's key, so the SDK's own helpers (`getModuleStorage(host)`,
// `getConversationService(host)`, …) run unchanged against it, and each
// applies the host's rules: the same key pattern, root rule and size cap for
// storage, the same `permission_missing` answers (or throws, where a call has
// no failure shape) for the permissions the host checks, the same ownership
// answers for chats. Each also returns a handle a test drives the world with
// (`conversations.emitEvent`, `github.respond`, …).
//
// SERVICE_FAKES below is keyed by service key. Adding a fake for a new host
// service is one entry there, one field on `FakeServices`, and its row in
// MODULE_SERVICE_REQUIREMENTS (services.ts).

import { isAbsolute } from 'node:path'

import type {
  CompanionAgentEvent,
  CompanionAgentHandle,
  CompanionAgentSpec,
  CompanionAgentStatus,
  ModuleStorageResult,
  ModuleWorkspaceView,
  ScheduledAgentDraft,
  ScheduledAgentLastRun,
  ScheduledAgentView,
  ScheduledAgentWriteResult,
  WorkspaceCreateInput,
  WorkspaceCreateResult,
} from './index.js'
import type {
  ModuleConversationCreateInput,
  ModuleConversationEvent,
  ModuleConversationErrorCode,
  ModuleConversationEventType,
  ModuleConversationPermissionPreset,
  ModuleConversationRef,
  ModuleConversationStatus,
  ModuleConversationStreamFrame,
  ModuleConversationSummary,
} from './conversation.js'
import type {
  ModuleGitHubRequest,
  ModuleGitHubResponse,
  ModuleSecretFetchInit,
  ModuleSecretFetchResult,
  ModuleSecretsError,
} from './brokers.js'

/** What every service fake is built with. */
export type FakeServiceContext = {
  readonly moduleId: string
  /** The module's declared permissions. Live: a test may add or remove one mid-test. */
  readonly permissions: Set<string>
  /** The fake clock (epoch ms). */
  now(): number
  /** The workspaces every fake resolves ids and roots against. */
  readonly workspaces: FakeWorkspaces
}

type Failure<C extends string> = { ok: false; code: C; message: string }
const failure = <C extends string>(code: C, message: string): Failure<C> => ({ ok: false, code, message })

// ── Workspaces ───────────────────────────────────────────────────────────────

/** The workspaces the host knows about: `WorkspaceContextToken`, `WorkspaceServiceToken`, and every id a fake checks. */
export type FakeWorkspaces = {
  /** Every workspace, hydrated or not. */
  all(): ModuleWorkspaceView[]
  add(workspace: ModuleWorkspaceView): void
  remove(id: string): void
  /**
   * While false, `get` answers null and `list` answers `[]` — the host right
   * after launch, before workspace state re-hydrates. Code that treats null as
   * "deleted" fails a test that toggles this.
   */
  setHydrated(hydrated: boolean): void
  /** The workspaces `WorkspaceServiceToken.create` made, in order. */
  readonly created: WorkspaceCreateInput[]
}

export function createFakeWorkspaces(initial: readonly ModuleWorkspaceView[]): FakeWorkspaces & {
  find(id: string): ModuleWorkspaceView | undefined
  hydrated(): boolean
} {
  const list = initial.map((workspace) => ({ ...workspace }))
  const created: WorkspaceCreateInput[] = []
  let hydrated = true
  return {
    all: () => list.map((workspace) => ({ ...workspace })),
    add(workspace) {
      const index = list.findIndex((existing) => existing.id === workspace.id)
      if (index === -1) list.push({ ...workspace })
      else list[index] = { ...workspace }
    },
    remove(id) {
      const index = list.findIndex((existing) => existing.id === id)
      if (index !== -1) list.splice(index, 1)
    },
    setHydrated(next) {
      hydrated = next
    },
    created,
    find: (id) => list.find((workspace) => workspace.id === id),
    hydrated: () => hydrated,
  }
}

type InternalWorkspaces = ReturnType<typeof createFakeWorkspaces>

function workspaceContextRegistry(workspaces: InternalWorkspaces) {
  return {
    async get(workspaceId: string): Promise<ModuleWorkspaceView | null> {
      if (!workspaces.hydrated()) return null
      const found = workspaces.find(workspaceId)
      return found ? { ...found } : null
    },
    async list(): Promise<ModuleWorkspaceView[]> {
      return workspaces.hydrated() ? workspaces.all() : []
    },
  }
}

function workspaceServiceRegistry(workspaces: InternalWorkspaces) {
  let next = 1
  return {
    async create(input: WorkspaceCreateInput): Promise<WorkspaceCreateResult> {
      if (input.folderPath !== undefined && !isAbsolute(input.folderPath)) {
        return failure('invalid_input', 'folderPath must be an absolute path.')
      }
      workspaces.created.push({ ...input })
      const workspaceId = `ws-created-${next++}`
      workspaces.add({
        id: workspaceId,
        name: input.name ?? 'Workspace',
        folderPath: input.folderPath ?? null,
        mode: input.templateId ?? 'standard',
      })
      return { ok: true, workspaceId }
    },
  }
}

// ── Storage ──────────────────────────────────────────────────────────────────

/** The module's storage: every scope's values, as the host would have written them. */
export type FakeStorage = {
  /** The stored value (a fresh copy), or undefined. `workspaceRoot` absent reads the global store. */
  peek(key: string, workspaceRoot?: string): unknown
  /** Every key in a scope, sorted. */
  keys(workspaceRoot?: string): string[]
  /** Write a value as if an earlier run had stored it. */
  seed(key: string, value: unknown, workspaceRoot?: string): void
  /** Every call, in order: `['set', key, workspaceRoot]`. */
  readonly calls: Array<[method: 'get' | 'set' | 'delete' | 'list', key: string | null, workspaceRoot: string | null]>
}

// The host's own rules (module-storage.ts in the app): keys are file names.
const STORAGE_KEY_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/
const WINDOWS_RESERVED_KEY = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/
/** The host's cap on one stored value, in bytes of JSON. */
export const MODULE_STORAGE_VALUE_LIMIT_BYTES = 1024 * 1024

type StorageCode = 'invalid_key' | 'invalid_value' | 'value_too_large' | 'invalid_workspace_root' | 'io_error'

function storageRegistry(): { registry: object; handle: FakeStorage } {
  const scopes = new Map<string, Map<string, string>>()
  const calls: FakeStorage['calls'] = []
  const GLOBAL = '\u0000global'
  const scope = (root: string | undefined): Map<string, string> => {
    const id = root ?? GLOBAL
    let store = scopes.get(id)
    if (!store) scopes.set(id, (store = new Map()))
    return store
  }
  const keyIssue = (key: unknown): Failure<StorageCode> | null => {
    if (typeof key !== 'string' || !STORAGE_KEY_PATTERN.test(key)) {
      return failure(
        'invalid_key',
        `Key "${String(key)}" is invalid — keys match ${STORAGE_KEY_PATTERN} (lowercase alphanumerics, dot, dash, underscore; max 64 chars).`,
      )
    }
    if (WINDOWS_RESERVED_KEY.test(key)) {
      return failure('invalid_key', `Key "${key}" is a reserved device name on Windows and cannot be used.`)
    }
    return null
  }
  const rootIssue = (root: unknown): Failure<StorageCode> | null =>
    root !== undefined && (typeof root !== 'string' || !isAbsolute(root))
      ? failure(
          'invalid_workspace_root',
          'workspaceRoot must be an absolute path (resolve it via the workspace context).',
        )
      : null
  type Scoped = { key: string; workspaceRoot?: string }

  const registry = {
    async get(_moduleId: string, input: Scoped): Promise<ModuleStorageResult<{ value: unknown; found: boolean }>> {
      calls.push(['get', input?.key ?? null, input?.workspaceRoot ?? null])
      const issue = keyIssue(input?.key) ?? rootIssue(input?.workspaceRoot)
      if (issue) return issue
      const text = scope(input.workspaceRoot).get(input.key)
      return text === undefined
        ? { ok: true, value: undefined, found: false }
        : { ok: true, value: JSON.parse(text) as unknown, found: true }
    },
    async set(_moduleId: string, input: Scoped & { value: unknown }): Promise<ModuleStorageResult<object>> {
      calls.push(['set', input?.key ?? null, input?.workspaceRoot ?? null])
      const issue = keyIssue(input?.key) ?? rootIssue(input?.workspaceRoot)
      if (issue) return issue
      let text: string | undefined
      try {
        text = JSON.stringify(input.value)
      } catch (error) {
        return failure('invalid_value', error instanceof Error ? error.message : String(error))
      }
      if (text === undefined) return failure('invalid_value', 'Value must be JSON-serializable (undefined is not).')
      if (Buffer.byteLength(text, 'utf8') > MODULE_STORAGE_VALUE_LIMIT_BYTES) {
        return failure('value_too_large', `Value exceeds the ${MODULE_STORAGE_VALUE_LIMIT_BYTES / 1024 / 1024} MB cap.`)
      }
      scope(input.workspaceRoot).set(input.key, text)
      return { ok: true }
    },
    async delete(_moduleId: string, input: Scoped): Promise<ModuleStorageResult<{ deleted: boolean }>> {
      calls.push(['delete', input?.key ?? null, input?.workspaceRoot ?? null])
      const issue = keyIssue(input?.key) ?? rootIssue(input?.workspaceRoot)
      if (issue) return issue
      return { ok: true, deleted: scope(input.workspaceRoot).delete(input.key) }
    },
    async list(
      _moduleId: string,
      input?: { workspaceRoot?: string },
    ): Promise<ModuleStorageResult<{ keys: string[] }>> {
      calls.push(['list', null, input?.workspaceRoot ?? null])
      const issue = rootIssue(input?.workspaceRoot)
      if (issue) return issue
      return { ok: true, keys: [...scope(input?.workspaceRoot).keys()].sort() }
    },
  }
  const handle: FakeStorage = {
    peek(key, workspaceRoot) {
      const text = scope(workspaceRoot).get(key)
      return text === undefined ? undefined : (JSON.parse(text) as unknown)
    },
    keys: (workspaceRoot) => [...scope(workspaceRoot).keys()].sort(),
    seed(key, value, workspaceRoot) {
      scope(workspaceRoot).set(key, JSON.stringify(value))
    },
    calls,
  }
  return { registry, handle }
}

// ── Conversations ────────────────────────────────────────────────────────────

/** What a test passes to `emitEvent`: the event's own parts; identity, order and time are filled in. */
export type FakeConversationEventInput = {
  type: ModuleConversationEventType
  payload?: Record<string, unknown>
}

/** One chat the module started, as the fake holds it. */
export type FakeConversationRecord = {
  summary: ModuleConversationSummary
  /** What `create` was asked. */
  input: ModuleConversationCreateInput
  /** Every event so far: the transcript. */
  events: ModuleConversationEvent[]
  /** Messages sent with `send`, in order (the opening prompt is the first `user_message` event). */
  sent: string[]
  /** Approval and question answers, in order. */
  answers: Array<{ requestId: string; method: string; input: unknown }>
  interrupted: number
  stopped: boolean
}

/** The module's chats, and the levers that make an agent say something. */
export type FakeConversations = {
  all(): FakeConversationRecord[]
  get(ref: ModuleConversationRef): FakeConversationRecord | undefined
  /**
   * Append an event to a chat's transcript and deliver it to every
   * `subscribe` and `follow`, as the runtime would. Status follows the event:
   * `turn_started` → active, `approval_requested` → awaiting_approval,
   * `turn_completed`/`turn_failed` → ready, `session_closed` → stopped.
   */
  emitEvent(ref: ModuleConversationRef, event: FakeConversationEventInput): ModuleConversationEvent
  /** Put a chat in a status directly, notifying watchers. */
  setStatus(ref: ModuleConversationRef, status: ModuleConversationStatus | 'absent'): void
  /**
   * Add a chat the module does NOT own (the person's own, or another
   * module's), to check that the module cannot reach it.
   */
  addForeign(ref: ModuleConversationRef): void
  /** Make the next `create` fail with this code, once. */
  failNextCreate(code: ModuleConversationErrorCode, message?: string): void
}

const PRESET_ORDER: ModuleConversationPermissionPreset[] = ['manual', 'none', 'auto', 'bypass']

function conversationsRegistry(context: FakeServiceContext): { registry: object; handle: FakeConversations } {
  const workspaces = context.workspaces as InternalWorkspaces
  const records = new Map<string, FakeConversationRecord>()
  const foreign = new Set<string>()
  const subscribers = new Map<string, Set<(event: ModuleConversationEvent) => void>>()
  const followers = new Map<string, Set<(frame: ModuleConversationStreamFrame) => void>>()
  const watchers = new Set<{ filter?: { workspaceId?: string }; cb: (list: ModuleConversationSummary[]) => void }>()
  const receipts = new Map<string, unknown>()
  let nextAgent = 1
  let nextEvent = 1
  let pendingFailure: Failure<string> | null = null

  const refKey = (ref: ModuleConversationRef): string => `${ref?.workspaceId}\u0000${ref?.agentId}`
  const canOperate = (): boolean => context.permissions.has('conversation:operate')
  const canRead = (): boolean => canOperate() || context.permissions.has('conversation:read')
  const missing = (permission: string) =>
    failure('permission_missing', `Module "${context.moduleId}" must declare the "${permission}" permission.`)
  const notOwned = (ref: ModuleConversationRef) =>
    failure(
      'not_owned',
      `No conversation "${ref?.agentId}" in workspace "${ref?.workspaceId}" was started by this module.`,
    )
  const requireRead = (): void => {
    if (!canRead()) throw new Error(missing('conversation:read').message)
  }
  const owned = (ref: ModuleConversationRef): FakeConversationRecord | undefined => records.get(refKey(ref))
  const list = (filter?: { workspaceId?: string }): ModuleConversationSummary[] =>
    [...records.values()]
      .filter((record) => !filter?.workspaceId || record.summary.workspaceId === filter.workspaceId)
      .map((record) => ({ ...record.summary }))
  const notifyWatchers = (): void => {
    for (const watcher of watchers) watcher.cb(list(watcher.filter))
  }
  // The module's ceiling: `auto`, or `bypass` with `conversation:bypass`.
  const capped = (preset: ModuleConversationPermissionPreset | undefined) => {
    if (preset === undefined) return undefined
    const ceiling: ModuleConversationPermissionPreset = context.permissions.has('conversation:bypass')
      ? 'bypass'
      : 'auto'
    return PRESET_ORDER.indexOf(preset) > PRESET_ORDER.indexOf(ceiling) ? ceiling : preset
  }
  // A retried command with the same id answers the first result.
  const once = async <T>(commandId: string | undefined, run: () => Promise<T>): Promise<T> => {
    if (commandId === undefined) return run()
    const key = `${context.moduleId}:${commandId}`
    if (receipts.has(key)) return receipts.get(key) as T
    const result = await run()
    receipts.set(key, result)
    return result
  }
  const STATUS_AFTER: Partial<Record<ModuleConversationEventType, ModuleConversationStatus>> = {
    session_ready: 'ready',
    turn_started: 'active',
    approval_requested: 'awaiting_approval',
    approval_resolved: 'active',
    turn_completed: 'ready',
    turn_failed: 'ready',
    session_closed: 'stopped',
  }

  function emit(record: FakeConversationRecord, input: FakeConversationEventInput): ModuleConversationEvent {
    const event: ModuleConversationEvent = {
      id: `event-${nextEvent++}`,
      seq: record.events.length + 1,
      sessionId: record.summary.sessionId ?? `session-${record.summary.agentId}`,
      workspaceId: record.summary.workspaceId,
      agentId: record.summary.agentId,
      providerId: record.summary.providerId,
      modelId: record.summary.modelId,
      type: input.type,
      createdAt: context.now(),
      ...(input.payload ? { payload: structuredClone(input.payload) } : {}),
    }
    record.events.push(event)
    const status = STATUS_AFTER[input.type]
    const key = refKey(record.summary)
    for (const cb of subscribers.get(key) ?? []) cb(structuredClone(event))
    for (const onFrame of followers.get(key) ?? []) onFrame({ type: 'event', event: structuredClone(event) })
    if (status && status !== record.summary.status) {
      record.summary.status = status
      notifyWatchers()
    }
    return event
  }

  // Every operating call: the permission, then ownership, then the command
  // receipt. (The registry is loosely typed; the SDK helper types the answers.)
  const operate = async (
    ref: ModuleConversationRef,
    commandId: string | undefined,
    run: (record: FakeConversationRecord) => object,
  ): Promise<object> => {
    if (!canOperate()) return missing('conversation:operate')
    const record = owned(ref)
    if (!record) return notOwned(ref)
    return once(commandId, async () => run(record))
  }

  const registry = {
    async create(_moduleId: string, input: ModuleConversationCreateInput) {
      if (!canOperate()) return missing('conversation:operate')
      if (typeof input !== 'object' || input === null) return failure('invalid_input', 'create takes an object.')
      return once(input.commandId, async () => {
        if (typeof input.workspaceId !== 'string' || !input.workspaceId.trim()) {
          return failure('invalid_input', '"workspaceId" is required.')
        }
        if (input.allowedTools?.length && !context.permissions.has('conversation:bypass')) {
          return failure(
            'permission_missing',
            `Module "${context.moduleId}" must declare "conversation:bypass" to let a chat use tools without asking.`,
          )
        }
        if (pendingFailure) {
          const planned = pendingFailure
          pendingFailure = null
          return planned
        }
        const workspace = workspaces.find(input.workspaceId)
        if (!workspace) return failure('unknown_workspace', `No workspace "${input.workspaceId}".`)
        if (!workspace.folderPath) {
          return failure('workspace_folder_missing', `Workspace "${input.workspaceId}" has no project folder.`)
        }
        const agentId = `agent-${nextAgent++}`
        const preset = capped(input.permissionPreset)
        const cli = input.cli ?? 'claude'
        const record: FakeConversationRecord = {
          summary: {
            workspaceId: workspace.id,
            agentId,
            sessionId: `session-${agentId}`,
            name: input.name ?? `Chat ${agentId}`,
            cli,
            providerId: cli,
            modelId: input.model ?? 'default',
            status: 'starting',
            ...(preset ? { permissionPreset: preset } : {}),
            ...(preset && preset === input.permissionPreset && input.permissionMode
              ? { permissionMode: input.permissionMode }
              : {}),
          },
          input: structuredClone(input),
          events: [],
          sent: [],
          answers: [],
          interrupted: 0,
          stopped: false,
        }
        records.set(refKey(record.summary), record)
        emit(record, { type: 'session_started' })
        if (input.prompt) emit(record, { type: 'user_message', payload: { text: input.prompt } })
        notifyWatchers()
        return { ok: true as const, conversation: { ...record.summary } }
      })
    },
    send: (_m: string, ref: ModuleConversationRef, input: { message: string; commandId?: string }) =>
      operate(ref, input?.commandId, (record) => {
        if (typeof input?.message !== 'string' || !input.message.trim()) {
          return failure('invalid_input', '"message" is required.')
        }
        record.sent.push(input.message)
        emit(record, { type: 'user_message', payload: { text: input.message } })
        return { ok: true }
      }),
    interrupt: (_m: string, ref: ModuleConversationRef, options?: { commandId?: string }) =>
      operate(ref, options?.commandId, (record) => {
        record.interrupted += 1
        return { ok: true }
      }),
    respondToApproval: (_m: string, ref: ModuleConversationRef, input: { requestId: string; commandId?: string }) =>
      operate(ref, input?.commandId, (record) => {
        record.answers.push({ requestId: input.requestId, method: 'respondToApproval', input: structuredClone(input) })
        return { ok: true }
      }),
    answerQuestion: (_m: string, ref: ModuleConversationRef, input: { requestId: string; commandId?: string }) =>
      operate(ref, input?.commandId, (record) => {
        record.answers.push({ requestId: input.requestId, method: 'answerQuestion', input: structuredClone(input) })
        return { ok: true }
      }),
    resolvePlan: (_m: string, ref: ModuleConversationRef, input: { requestId: string; commandId?: string }) =>
      operate(ref, input?.commandId, (record) => {
        record.answers.push({ requestId: input.requestId, method: 'resolvePlan', input: structuredClone(input) })
        return { ok: true }
      }),
    setPermissionPreset: (
      _m: string,
      ref: ModuleConversationRef,
      preset: ModuleConversationPermissionPreset,
      options?: { commandId?: string; permissionMode?: string },
    ) =>
      operate(ref, options?.commandId, (record) => {
        if (!PRESET_ORDER.includes(preset)) {
          return failure('invalid_input', '"permissionPreset" must be "none", "manual", "auto" or "bypass".')
        }
        const inForce = capped(preset) ?? preset
        record.summary.permissionPreset = inForce
        if (inForce === preset && options?.permissionMode) record.summary.permissionMode = options.permissionMode
        else delete record.summary.permissionMode
        notifyWatchers()
        return {
          ok: true,
          permissionPreset: inForce,
          ...(record.summary.permissionMode ? { permissionMode: record.summary.permissionMode } : {}),
        }
      }),
    setModel: (_m: string, ref: ModuleConversationRef, modelId: string, options?: { commandId?: string }) =>
      operate(ref, options?.commandId, (record) => {
        record.summary.modelId = modelId
        notifyWatchers()
        return { ok: true, modelId }
      }),
    stop: (_m: string, ref: ModuleConversationRef) =>
      operate(ref, undefined, (record) => {
        record.stopped = true
        emit(record, { type: 'session_closed' })
        return { ok: true }
      }),
    subscribe(_m: string, ref: ModuleConversationRef, cb: (event: ModuleConversationEvent) => void) {
      requireRead()
      if (!owned(ref)) throw new Error(notOwned(ref).message)
      const key = refKey(ref)
      let set = subscribers.get(key)
      if (!set) subscribers.set(key, (set = new Set()))
      set.add(cb)
      return () => {
        set.delete(cb)
      }
    },
    follow(
      _m: string,
      ref: ModuleConversationRef,
      options: { afterSeq?: number } | undefined,
      onFrame: (frame: ModuleConversationStreamFrame) => void,
    ) {
      requireRead()
      const record = owned(ref)
      if (!record) throw new Error(notOwned(ref).message)
      const after = options?.afterSeq
      const generation = `fake-${record.summary.agentId}`
      if (after !== undefined && after <= record.events.length) {
        for (const event of record.events.slice(after)) onFrame({ type: 'event', event: structuredClone(event) })
      } else {
        onFrame({
          type: 'snapshot',
          page: {
            events: structuredClone(record.events),
            hasMore: false,
            beforeCursor: record.events.length ? 1 : null,
          },
          reset: true,
          generation,
        })
      }
      onFrame({ type: 'synchronized', seq: record.events.length, generation })
      const key = refKey(ref)
      let set = followers.get(key)
      if (!set) followers.set(key, (set = new Set()))
      set.add(onFrame)
      return () => {
        set.delete(onFrame)
      }
    },
    async transcript(_m: string, ref: ModuleConversationRef) {
      if (!canRead()) return missing('conversation:read')
      const record = owned(ref)
      if (!record) return notOwned(ref)
      return { ok: true as const, events: structuredClone(record.events) }
    },
    list(_m: string, filter?: { workspaceId?: string }) {
      requireRead()
      return list(filter)
    },
    watch(_m: string, filter: { workspaceId?: string } | undefined, cb: (list: ModuleConversationSummary[]) => void) {
      requireRead()
      const watcher = { filter, cb }
      watchers.add(watcher)
      cb(list(filter))
      return () => {
        watchers.delete(watcher)
      }
    },
  }

  const handle: FakeConversations = {
    all: () => [...records.values()],
    get: (ref) => owned(ref),
    emitEvent(ref, event) {
      const record = owned(ref)
      if (!record) {
        throw new Error(
          foreign.has(refKey(ref))
            ? `Conversation "${ref.agentId}" is not the module's own; the module never sees its events.`
            : `No conversation "${ref.agentId}" in workspace "${ref.workspaceId}"; start one with create first.`,
        )
      }
      return emit(record, event)
    },
    setStatus(ref, status) {
      const record = owned(ref)
      if (!record) throw new Error(`No conversation "${ref.agentId}" in workspace "${ref.workspaceId}".`)
      record.summary.status = status
      notifyWatchers()
    },
    addForeign(ref) {
      foreign.add(refKey(ref))
    },
    failNextCreate(code, message) {
      pendingFailure = failure(code, message ?? `The fake host refused this create with "${code}".`)
    },
  }
  return { registry, handle }
}

// ── Scheduled agents ─────────────────────────────────────────────────────────

/** The module's scheduled agents, and a way to make one run. */
export type FakeScheduledAgents = {
  all(): ScheduledAgentView[]
  /**
   * Run one as its schedule would: records `lastRun` (a new workspace id),
   * notifies `onChanged` listeners, and closes a one-time schedule.
   */
  fire(id: string): ScheduledAgentLastRun
  /** Make the next `create` or `update` fail with this message, as the host's validation would. */
  failNextWrite(message: string): void
}

function scheduledAgentsRegistry(context: FakeServiceContext): { registry: object; handle: FakeScheduledAgents } {
  const agents = new Map<string, ScheduledAgentView>()
  const listeners = new Set<(list: ScheduledAgentView[]) => void>()
  let nextId = 1
  let nextRun = 1
  let pendingFailure: string | null = null

  const snapshot = (): ScheduledAgentView[] => [...agents.values()].map((agent) => structuredClone(agent))
  const changed = (): void => {
    for (const listener of listeners) listener(snapshot())
  }
  const invalid = (draft: ScheduledAgentDraft): string | null => {
    if (pendingFailure) {
      const message = pendingFailure
      pendingFailure = null
      return message
    }
    if (typeof draft?.prompt !== 'string' || !draft.prompt.trim()) return 'A scheduled agent needs a prompt.'
    if (typeof draft.folderPath !== 'string' || !isAbsolute(draft.folderPath)) {
      return 'A scheduled agent needs an absolute project folder.'
    }
    if (typeof draft.schedule?.cron !== 'string' || !draft.schedule.cron.trim())
      return 'A scheduled agent needs a schedule.'
    if (typeof draft.schedule.timezone !== 'string' || !draft.schedule.timezone.trim()) {
      return 'A scheduled agent needs a time zone.'
    }
    if (draft.schedule.once !== undefined && draft.schedule.once <= context.now())
      return 'That time has already passed.'
    if (typeof draft.cli !== 'string' || !draft.cli.trim()) return 'A scheduled agent needs an agent runtime.'
    return null
  }
  const notFound = (id: string) => ({ ok: false as const, message: `No scheduled agent "${id}".` })

  function run(agent: ScheduledAgentView): ScheduledAgentLastRun {
    const lastRun: ScheduledAgentLastRun = { at: context.now(), ok: true, workspaceId: `ws-run-${nextRun++}` }
    agent.lastRun = lastRun
    if (agent.schedule.once !== undefined) agents.delete(agent.id)
    changed()
    return lastRun
  }

  const registry = {
    async create(moduleId: string, draft: ScheduledAgentDraft): Promise<ScheduledAgentWriteResult> {
      const problem = invalid(draft)
      if (problem) return { ok: false, message: problem }
      const at = context.now()
      const agent: ScheduledAgentView = {
        ...structuredClone(draft),
        id: `scheduled-${nextId++}`,
        ownerModuleId: moduleId,
        createdAt: at,
        updatedAt: at,
        lastRun: null,
        lastFailureSeenAt: null,
        // The fake does not evaluate cron; a one-time schedule knows its instant.
        nextRunAt: draft.schedule.once ?? null,
      }
      agents.set(agent.id, agent)
      changed()
      return { ok: true, agent: structuredClone(agent) }
    },
    async update(_moduleId: string, id: string, draft: ScheduledAgentDraft): Promise<ScheduledAgentWriteResult> {
      const existing = agents.get(id)
      if (!existing) return notFound(id)
      const problem = invalid(draft)
      if (problem) return { ok: false, message: problem }
      const agent: ScheduledAgentView = {
        ...existing,
        ...structuredClone(draft),
        updatedAt: context.now(),
        nextRunAt: draft.schedule.once ?? null,
      }
      agents.set(id, agent)
      changed()
      return { ok: true, agent: structuredClone(agent) }
    },
    async remove(_moduleId: string, id: string) {
      if (!agents.delete(id)) return notFound(id)
      changed()
      return { ok: true as const }
    },
    async list() {
      return snapshot()
    },
    async runNow(_moduleId: string, id: string) {
      const agent = agents.get(id)
      if (!agent) return notFound(id)
      return { ok: true as const, run: run(agent) }
    },
    onChanged(_moduleId: string, listener: (list: ScheduledAgentView[]) => void) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
  }
  const handle: FakeScheduledAgents = {
    all: snapshot,
    fire(id) {
      const agent = agents.get(id)
      if (!agent) throw new Error(`No scheduled agent "${id}".`)
      return run(agent)
    },
    failNextWrite(message) {
      pendingFailure = message
    },
  }
  return { registry, handle }
}

// ── Companion agents ─────────────────────────────────────────────────────────

/** What a companion's scripted reply is computed from. */
export type FakeCompanionTurn = { spec: CompanionAgentSpec; prompt: string; attempt: number }

/** The module's companion agents, and the replies they give. */
export type FakeCompanions = {
  /** Every handle `attach` returned, by `workspaceId/agentId`. */
  handles(): CompanionAgentHandle[]
  /** What `runStructured` gets back from the agent (before validation). Default: `{}`. */
  respond(reply: (turn: FakeCompanionTurn) => unknown): void
  /** Every prompt sent through `runStructured` and `send`, in order. */
  readonly prompts: Array<{ agentId: string; prompt: string; via: 'runStructured' | 'send' }>
  /** Deliver an event to a companion's `onEvent` listeners. */
  emitEvent(workspaceId: string, agentId: string, event: Omit<CompanionAgentEvent, 'workspaceId' | 'agentId'>): void
}

function companionsRegistry(context: FakeServiceContext): { registry: object; handle: FakeCompanions } {
  const handles = new Map<string, CompanionAgentHandle>()
  const eventListeners = new Map<string, Set<(event: CompanionAgentEvent) => void>>()
  const prompts: FakeCompanions['prompts'] = []
  let reply: (turn: FakeCompanionTurn) => unknown = () => ({})

  function create(spec: CompanionAgentSpec): CompanionAgentHandle {
    const key = `${spec.workspaceId}/${spec.agentId}`
    let status: CompanionAgentStatus = 'absent'
    const statusListeners = new Set<(status: CompanionAgentStatus) => void>()
    const listeners = new Set<(event: CompanionAgentEvent) => void>()
    eventListeners.set(key, listeners)
    const setStatus = (next: CompanionAgentStatus): void => {
      if (next === status) return
      status = next
      for (const listener of statusListeners) listener(next)
    }
    let disposed = false
    const live = (): void => {
      if (disposed) throw new Error(`Companion "${spec.agentId}" was disposed; attach it again.`)
    }
    const handle: CompanionAgentHandle = {
      workspaceId: spec.workspaceId,
      agentId: spec.agentId,
      status: () => status,
      onStatus(cb) {
        statusListeners.add(cb)
        return () => {
          statusListeners.delete(cb)
        }
      },
      async runStructured(options) {
        live()
        // A live intent spawns the session, as the host's first runStructured does.
        setStatus('active')
        const retries = options.retries ?? 1
        let errors: string[] = []
        try {
          for (let attempt = 0; attempt <= retries; attempt += 1) {
            const prompt =
              attempt === 0 ? options.prompt : `${options.prompt}\n\nThe last answer was invalid: ${errors.join('; ')}`
            prompts.push({ agentId: spec.agentId, prompt, via: 'runStructured' })
            options.onPhase?.(attempt === 0 ? 'running' : 'retrying')
            const validated = options.validate(structuredClone(reply({ spec, prompt, attempt })))
            if (validated.ok) return validated.value
            errors = validated.errors
          }
        } finally {
          setStatus('ready')
        }
        throw new Error(`Companion "${spec.agentId}" gave no valid answer: ${errors.join('; ')}`)
      },
      async send(message) {
        live()
        setStatus('ready')
        prompts.push({ agentId: spec.agentId, prompt: message, via: 'send' })
      },
      onEvent(cb) {
        listeners.add(cb)
        return () => {
          listeners.delete(cb)
        }
      },
      interrupt() {},
      dispose() {
        disposed = true
        setStatus('absent')
        handles.delete(key)
      },
    }
    return handle
  }

  const registry = {
    attach(_moduleId: string, spec: CompanionAgentSpec): CompanionAgentHandle {
      if (!context.permissions.has('agents:companion')) {
        throw new Error(
          `Module "${context.moduleId}" must declare the "agents:companion" permission to attach a companion agent.`,
        )
      }
      if (!spec?.workspaceRoot || !isAbsolute(spec.workspaceRoot)) {
        throw new Error('A companion agent needs an absolute workspaceRoot.')
      }
      const key = `${spec.workspaceId}/${spec.agentId}`
      let handle = handles.get(key)
      if (!handle) handles.set(key, (handle = create(spec)))
      return handle
    },
  }
  const handle: FakeCompanions = {
    handles: () => [...handles.values()],
    respond(next) {
      reply = next
    },
    prompts,
    emitEvent(workspaceId, agentId, event) {
      for (const cb of eventListeners.get(`${workspaceId}/${agentId}`) ?? []) {
        cb({ ...structuredClone(event), workspaceId, agentId } as CompanionAgentEvent)
      }
    },
  }
  return { registry, handle }
}

// ── Secrets ──────────────────────────────────────────────────────────────────

/** A request `fetchWithSecret` would send, with the secret where the host puts it. */
export type FakeSecretRequest = {
  name: string
  url: string
  method: string
  headers: Record<string, string>
  body?: string
}

/** The module's stored secrets, and the answers its brokered requests get. */
export type FakeSecrets = {
  /** Names stored, and the origins each may go to (the value stays the host's). */
  stored(): Record<string, string[]>
  /** What a brokered request answers. Default: 200 with an empty body. */
  respond(
    answer: (request: FakeSecretRequest) => { status: number; body?: string; headers?: Record<string, string> },
  ): void
  /** Every request sent, with the secret in place. */
  readonly requests: FakeSecretRequest[]
}

const SECRET_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/

function secretsRegistry(context: FakeServiceContext): { registry: object; handle: FakeSecrets } {
  const secrets = new Map<string, { value: string; allowedOrigins: string[] }>()
  const requests: FakeSecretRequest[] = []
  let answer: Parameters<FakeSecrets['respond']>[0] = () => ({ status: 200, body: '' })
  const allowed = (): boolean => context.permissions.has('secrets')
  const missing = () =>
    failure<ModuleSecretsError>(
      'permission_missing',
      `Module "${context.moduleId}" must declare the "secrets" permission.`,
    )
  const badName = (name: unknown) =>
    typeof name === 'string' && SECRET_NAME_PATTERN.test(name)
      ? null
      : failure<ModuleSecretsError>('invalid_name', `"${String(name)}" is not a secret name.`)
  const origin = (candidate: unknown): string | null => {
    if (typeof candidate !== 'string') return null
    try {
      const url = new URL(candidate)
      return url.protocol === 'https:' && (url.pathname === '/' || url.pathname === '') && !url.search
        ? url.origin
        : null
    } catch {
      return null
    }
  }

  const registry = {
    async set(_m: string, name: string, value: string, options: { allowedOrigins: string[] }) {
      if (!allowed()) return missing()
      const nameIssue = badName(name)
      if (nameIssue) return nameIssue
      if (typeof value !== 'string' || !value.trim()) throw new TypeError(`Secret "${name}" needs a string value.`)
      const origins = (options?.allowedOrigins ?? []).map(origin)
      if (origins.length === 0 || origins.some((entry) => entry === null)) {
        return failure<ModuleSecretsError>(
          'origin_not_allowed',
          `Secret "${name}" needs allowed origins, each an https origin such as "https://api.example.com".`,
        )
      }
      secrets.set(name, { value: value.trim(), allowedOrigins: [...new Set(origins as string[])] })
      return { ok: true as const }
    },
    async has(_m: string, name: string) {
      if (!allowed()) throw new Error(missing().message)
      return !badName(name) && secrets.has(name)
    },
    async delete(_m: string, name: string) {
      if (!allowed()) return missing()
      const nameIssue = badName(name)
      if (nameIssue) return nameIssue
      secrets.delete(name)
      return { ok: true as const }
    },
    async fetchWithSecret(
      _m: string,
      name: string,
      url: string,
      init: ModuleSecretFetchInit,
    ): Promise<ModuleSecretFetchResult> {
      if (!allowed()) return missing()
      const nameIssue = badName(name)
      if (nameIssue) return nameIssue
      let target: URL
      try {
        target = new URL(url)
      } catch {
        return failure('origin_not_allowed', 'The request URL is not an absolute URL.')
      }
      if (target.protocol !== 'https:') return failure('origin_not_allowed', 'A secret is only ever sent over https.')
      if (target.username || target.password) {
        return failure('origin_not_allowed', 'The request URL may not carry credentials of its own.')
      }
      const stored = secrets.get(name)
      if (!stored) return failure('not_set', `Secret "${name}" is not set.`)
      if (!stored.allowedOrigins.includes(target.origin)) {
        return failure(
          'origin_not_allowed',
          `Secret "${name}" may not be sent to ${target.origin}; it was stored for ${stored.allowedOrigins.join(', ')}.`,
        )
      }
      const headers: Record<string, string> = { ...init?.headers }
      if (init?.placement && 'header' in init.placement) {
        const scheme = init.placement.scheme ?? ''
        headers[init.placement.header] = scheme ? `${scheme} ${stored.value}` : stored.value
      } else if (init?.placement && 'query' in init.placement) {
        target.searchParams.set(init.placement.query, stored.value)
      }
      const request: FakeSecretRequest = {
        name,
        url: target.toString(),
        method: init?.method ?? 'GET',
        headers,
        ...(init?.body !== undefined ? { body: init.body } : {}),
      }
      requests.push(request)
      const answered = answer(structuredClone(request))
      // The host never hands a secret back: an echoed value is redacted.
      const body = (answered.body ?? '').split(stored.value).join('[redacted]')
      return { ok: true, status: answered.status, headers: answered.headers ?? {}, body }
    },
  }
  const handle: FakeSecrets = {
    stored: () => Object.fromEntries([...secrets].map(([name, entry]) => [name, [...entry.allowedOrigins]])),
    respond(next) {
      answer = next
    },
    requests,
  }
  return { registry, handle }
}

// ── GitHub ───────────────────────────────────────────────────────────────────

/** A scripted GitHub answer: what `request` resolves to, or the data of a 200. */
export type FakeGitHubAnswer = ModuleGitHubResponse | ((request: ModuleGitHubRequest) => ModuleGitHubResponse)

/** The signed-in user's GitHub, as scripted answers keyed by `METHOD /route`. */
export type FakeGitHub = {
  /**
   * Answer `method route` (the route as the module writes it, placeholders
   * and all: `GET /repos/{owner}/{repo}/pulls`). Unscripted requests answer
   * 404 `http_error`.
   */
  respond(method: NonNullable<ModuleGitHubRequest['method']>, route: string, answer: FakeGitHubAnswer): void
  /** Signed in (as `login`) or not; signed out answers `not_signed_in`. Default: signed in as `dev`. */
  setSignedIn(signedIn: boolean, login?: string): void
  /** Every request, in order. */
  readonly requests: ModuleGitHubRequest[]
}

const GITHUB_METHODS = ['GET', 'POST', 'PATCH', 'PUT', 'DELETE']

function githubRegistry(context: FakeServiceContext): { registry: object; handle: FakeGitHub } {
  const answers = new Map<string, FakeGitHubAnswer>()
  const requests: ModuleGitHubRequest[] = []
  let signedIn = true
  let login = 'dev'
  const allowed = (): boolean => context.permissions.has('github')
  const missingMessage = `Module "${context.moduleId}" must declare the "github" permission.`

  const registry = {
    async request(_m: string, request: ModuleGitHubRequest): Promise<ModuleGitHubResponse> {
      if (!allowed()) return failure('permission_missing', missingMessage)
      if (typeof request?.route !== 'string' || !request.route.startsWith('/')) {
        return failure('invalid_route', 'request needs a route.')
      }
      const method = request.method ?? 'GET'
      if (!GITHUB_METHODS.includes(method)) {
        return failure('invalid_route', `Method "${method}" is not one GitHub's REST API takes.`)
      }
      if (method === 'GET' && request.body !== undefined) {
        return failure('invalid_route', 'A GET request carries no body; use params.')
      }
      requests.push(structuredClone(request))
      if (!signedIn) return failure('not_signed_in', 'Sign in to GitHub in Settings to let extensions use it.')
      const scripted = answers.get(`${method} ${request.route}`)
      if (scripted === undefined) {
        return {
          ok: false,
          code: 'http_error',
          status: 404,
          message: `No scripted answer for ${method} ${request.route}.`,
        }
      }
      return structuredClone(typeof scripted === 'function' ? scripted(structuredClone(request)) : scripted)
    },
    async status() {
      if (!allowed()) throw new Error(missingMessage)
      return signedIn ? { signedIn: true, login } : { signedIn: false }
    },
  }
  const handle: FakeGitHub = {
    respond(method, route, answer) {
      answers.set(`${method} ${route}`, answer)
    },
    setSignedIn(next, nextLogin) {
      signedIn = next
      if (nextLogin) login = nextLogin
    },
    requests,
  }
  return { registry, handle }
}

// ── The registry of fakes ────────────────────────────────────────────────────

/** The handle of every built-in service fake, by name. */
export type FakeServices = {
  workspaces: FakeWorkspaces
  storage: FakeStorage
  conversations: FakeConversations
  scheduledAgents: FakeScheduledAgents
  companions: FakeCompanions
  secrets: FakeSecrets
  github: FakeGitHub
}

/** How a service's fake is made. */
export type FakeServiceDefinition = {
  /** Where its handle lands on `FakeServices`; null for a service whose state another fake owns. */
  name: keyof FakeServices | null
  create(context: FakeServiceContext): { registry: object; handle?: unknown }
}

/**
 * One fake per service key the SDK publishes (MODULE_SERVICE_REQUIREMENTS).
 * A service added to the host gets its fake here, keyed the same way.
 */
export const SERVICE_FAKES: Readonly<Record<string, FakeServiceDefinition>> = {
  'core.workspace': {
    name: null,
    create: (context) => ({ registry: workspaceServiceRegistry(context.workspaces as InternalWorkspaces) }),
  },
  'core.workspace-context': {
    name: null,
    create: (context) => ({ registry: workspaceContextRegistry(context.workspaces as InternalWorkspaces) }),
  },
  'core.module-storage': { name: 'storage', create: () => storageRegistry() },
  'conversation.module-service': { name: 'conversations', create: conversationsRegistry },
  'scheduled-agents.module-service': { name: 'scheduledAgents', create: scheduledAgentsRegistry },
  'companion-agents.module-service': { name: 'companions', create: companionsRegistry },
  'module-secrets.module-service': { name: 'secrets', create: secretsRegistry },
  'github.module-service': { name: 'github', create: githubRegistry },
}
