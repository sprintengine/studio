// The module conversation service: the chats a module starts, drives and reads
// through the app's own conversation runtime (SDK `getConversationService`).
//
// A module reaches only the chats it created. Ownership is the chat record's
// `ownerModuleId`, stamped by the launch service when the module's `create`
// started it, and checked on every call: a ref naming the person's own chat,
// or another module's, is answered `not_owned` — the same answer as a ref
// naming nothing, so a module cannot probe for chats it may not see.
//
// Permissions are read per call from the module's declared list, never cached:
// `conversation:read` covers subscribe, transcript, list and watch;
// `conversation:operate` covers everything and implies read. The calls that
// answer a result say `permission_missing`; the ones that cannot (subscribe,
// list, watch) throw, since calling them without the permission is a mistake
// in the module and not a state of the world.
//
// A module picks any of the four presets for its chats, up to a ceiling:
// `auto`, or `bypass` for a module that declared `conversation:bypass`, so the
// consent prompt says so before the person trusts it. A preset above the
// ceiling is lowered to it rather than refused, as the tool-caller cap lowers
// one, and the answer names the preset in force. A preset left out takes the
// person's own default, which is theirs to choose and is not capped here.
//
// Events reach a module the way they reach a chat UI: redacted (secret-shaped
// payload keys) and only for its own chats.

import { randomUUID } from 'crypto'

import { conversationWorkingRoot, type AgentState } from '../../shared/agent-state'
import { cliForConversationProvider } from '../../shared/conversation-harness'
import {
  CONVERSATION_PERMISSION_PRESETS,
  type ConversationCliRuntimeOverrides,
  type ConversationEvent,
  type ConversationInterruptInput,
  type ConversationListSessionsInput,
  type ConversationListSessionsResult,
  type ConversationRespondToRequestInput,
  type ConversationSendTurnInput,
  type ConversationSessionActionResult,
  type ConversationSessionSummary,
  type ConversationSetModelInput,
  type ConversationSetPermissionInput,
  type ConversationStartSessionInput,
  type ConversationStartSessionResult,
  type ConversationStopSessionInput,
  type ConversationTranscriptInput,
  type ConversationTranscriptResult,
} from '../../shared/conversation-runtime'
import type {
  ModuleConversationApprovalDecision,
  ModuleConversationCreateInput,
  ModuleConversationErrorCode,
  ModuleConversationEvent,
  ModuleConversationImageAttachment,
  ModuleConversationPermissionPreset,
  ModuleConversationRef,
  ModuleConversationRegistry,
  ModuleConversationResult,
  ModuleConversationService,
  ModuleConversationSummary,
} from '../../shared/modules/conversation-service'
import { isLooserCliPermissionPreset, type CliPermissionPreset } from '../../shared/cli-permission-preset'
import { CONVERSATION_DEFAULT_MODEL_ID } from '../../../packages/conversation-protocol/src'
import { redactEvent } from '../companion-agent-service'
import type { ConversationLaunchRequest, ConversationLaunchResult } from '../conversation-launch-service'
import { clampToModuleToolCaller } from './module-tool-caller'

/** A workspace as the service reads it: its folder and its agent records. */
export type ModuleConversationWorkspace = {
  id: string
  folderPath?: string | null
  agents: Record<string, AgentState>
}

/** The slice of the conversation runtime the service drives. */
export type ModuleConversationRuntime = {
  startSession(input: ConversationStartSessionInput): Promise<ConversationStartSessionResult>
  sendTurn(input: ConversationSendTurnInput): Promise<ConversationSessionActionResult>
  interrupt(input: ConversationInterruptInput): Promise<ConversationSessionActionResult>
  respondToRequest(input: ConversationRespondToRequestInput): Promise<ConversationSessionActionResult>
  setPermission(input: ConversationSetPermissionInput): Promise<ConversationSessionActionResult>
  setModel(input: ConversationSetModelInput): Promise<ConversationSessionActionResult>
  stopSession(input: ConversationStopSessionInput): Promise<ConversationSessionActionResult>
  listSessions(input?: ConversationListSessionsInput): ConversationListSessionsResult
  readTranscript(input: ConversationTranscriptInput): Promise<ConversationTranscriptResult>
  onEvent(listener: (event: ConversationEvent) => void): () => void
}

export type ModuleConversationDeps = {
  launch: (request: ConversationLaunchRequest) => Promise<ConversationLaunchResult>
  runtime: ModuleConversationRuntime
  /**
   * Patch a chat's agent record through the sequenced workspace bus. A preset
   * or model switch is written there as the chat view writes it, so the next
   * session the chat starts is on what the module chose.
   */
  writeAgent: (workspaceId: string, agentId: string, patch: Partial<AgentState>) => { ok: boolean; message?: string }
  /**
   * The models a chat's CLI offers, as this machine's own picker lists them
   * (conversation-model-catalog.ts). Present, `setModel` takes only those ids
   * and the CLI's default; absent, the runtime is the only check.
   */
  modelCatalog?: (providerId: string) => Promise<{ cliLabel: string; options: { id: string }[] } | null>
  /** Every workspace with its agent records, read fresh on each call. */
  getWorkspaceAgents: () => readonly ModuleConversationWorkspace[]
  /** The permissions the module declared in its manifest. */
  getModulePermissions: (moduleId: string) => readonly string[] | undefined
  /**
   * Told whenever the workspaces' agent records may have changed, so `watch`
   * re-reads its list. Absent, a watch moves only on conversation events.
   */
  onWorkspacesChanged?: (listener: () => void) => () => void
  /** The person's CLI command overrides, for a chat whose session is started again. */
  getCliRuntimes?: () => ConversationCliRuntimeOverrides | undefined
  /**
   * The loosest preset a chat started now may run on, or null when uncapped:
   * the ceiling of the agent whose MCP tool call into the module is running
   * (module-tool-caller.ts). Read at each `create`.
   */
  getCallerPermissionCeiling?: () => CliPermissionPreset | null
  newCommandId?: () => string
}

export type ModuleConversationModuleRegistry = {
  forModule(moduleId: string): ModuleConversationService
  /** The moduleId-first shape the `conversation.module-service` token carries. */
  registry: ModuleConversationRegistry
  /** Drop the runtime subscription. App teardown only. */
  dispose(): void
}

type OwnedChat = {
  workspace: ModuleConversationWorkspace
  agent: AgentState
  workingRoot: string | null
}

type Failure = { ok: false; code: ModuleConversationErrorCode; message: string }

const PERMISSION_PRESETS: ReadonlySet<string> = new Set(CONVERSATION_PERMISSION_PRESETS)
const APPROVAL_DECISIONS: ReadonlySet<string> = new Set<ModuleConversationApprovalDecision>([
  'once',
  'conversation',
  'deny',
])

/** The loosest preset a module's chats run on unless it declared `conversation:bypass`. */
export const MODULE_CONVERSATION_DEFAULT_CEILING: CliPermissionPreset = 'auto'

/** The loosest preset a module with these declared permissions may put its chats on. */
export function moduleConversationCeiling(permissions: readonly string[]): CliPermissionPreset {
  return permissions.includes('conversation:bypass') ? 'bypass' : MODULE_CONVERSATION_DEFAULT_CEILING
}

function isPermissionPreset(value: unknown): value is ModuleConversationPermissionPreset {
  return typeof value === 'string' && PERMISSION_PRESETS.has(value)
}

function failure(code: ModuleConversationErrorCode, message: string): Failure {
  return { ok: false, code, message }
}

function refKey(ref: ModuleConversationRef): string {
  return `${ref.workspaceId}\u0000${ref.agentId}`
}

function isRef(value: unknown): value is ModuleConversationRef {
  const ref = value as ModuleConversationRef | null
  return (
    typeof ref === 'object' &&
    ref !== null &&
    typeof ref.workspaceId === 'string' &&
    ref.workspaceId.trim() !== '' &&
    typeof ref.agentId === 'string' &&
    ref.agentId.trim() !== ''
  )
}

function isStringList(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string' && entry.trim() !== '')
}

function isAttachmentList(value: unknown): value is ModuleConversationImageAttachment[] {
  return (
    Array.isArray(value) &&
    value.every(
      (entry) =>
        typeof entry === 'object' &&
        entry !== null &&
        typeof entry.id === 'string' &&
        typeof entry.mediaType === 'string' &&
        typeof entry.dataBase64 === 'string' &&
        typeof entry.byteLength === 'number',
    )
  )
}

function actionResult(result: ConversationSessionActionResult): ModuleConversationResult {
  return result.ok ? { ok: true } : failure('runtime_refused', result.message)
}

function actionError(error: unknown): Failure {
  return failure('runtime_refused', error instanceof Error ? error.message : String(error))
}

export function createConversationModuleRegistry(deps: ModuleConversationDeps): ModuleConversationModuleRegistry {
  const newCommandId = deps.newCommandId ?? (() => randomUUID())

  // ── Permissions and ownership ───────────────────────────────────────────

  function declared(moduleId: string): readonly string[] {
    return deps.getModulePermissions(moduleId) ?? []
  }
  function canOperate(moduleId: string): boolean {
    return declared(moduleId).includes('conversation:operate')
  }
  function canRead(moduleId: string): boolean {
    return canOperate(moduleId) || declared(moduleId).includes('conversation:read')
  }
  function missing(moduleId: string, permission: 'conversation:read' | 'conversation:operate'): Failure {
    return failure('permission_missing', `Module "${moduleId}" must declare the "${permission}" permission.`)
  }
  function requireRead(moduleId: string): void {
    if (!canRead(moduleId)) throw new Error(missing(moduleId, 'conversation:read').message)
  }
  // A preset the module asked for, lowered to its own ceiling and then to the
  // ceiling of the agent whose tool call into the module is running, if any:
  // otherwise the module would be a capped agent's way to a chat that asks less.
  function capped(
    moduleId: string,
    requested: ModuleConversationPermissionPreset | undefined,
  ): ModuleConversationPermissionPreset | undefined {
    const ceiling = moduleConversationCeiling(declared(moduleId))
    const own = requested && isLooserCliPermissionPreset(requested, ceiling) ? ceiling : requested
    return clampToModuleToolCaller(own, deps.getCallerPermissionCeiling?.() ?? null)
  }

  function findOwned(moduleId: string, ref: ModuleConversationRef): OwnedChat | null {
    const workspace = deps.getWorkspaceAgents().find((candidate) => candidate.id === ref.workspaceId)
    const agent = workspace?.agents[ref.agentId]
    if (!workspace || !agent || agent.runtimeKind !== 'conversation' || agent.ownerModuleId !== moduleId) return null
    return { workspace, agent, workingRoot: conversationWorkingRoot(agent, workspace.folderPath) }
  }
  function notOwned(ref: ModuleConversationRef): Failure {
    return failure(
      'not_owned',
      `No conversation "${ref.agentId}" in workspace "${ref.workspaceId}" was started by this module.`,
    )
  }

  // The chat's live session: the newest one that is not stopped.
  function liveSession(ref: ModuleConversationRef): ConversationSessionSummary | null {
    const listed = deps.runtime.listSessions({ workspaceId: ref.workspaceId, agentId: ref.agentId })
    if (!listed.ok) return null
    const live = listed.sessions.filter((session) => session.status !== 'stopped')
    return live.sort((a, b) => b.createdAt - a.createdAt)[0] ?? null
  }

  // A chat whose session ended (a restart, a stop) takes a turn by starting
  // its session again, on the engine and preset its record carries — the same
  // thing a window's chat view does when the person types into it.
  async function sessionFor(ref: ModuleConversationRef, owned: OwnedChat): Promise<string | Failure> {
    const live = liveSession(ref)
    if (live) return live.sessionId
    const conversation = owned.agent.conversation
    if (!owned.workingRoot || !conversation) {
      return failure('workspace_folder_missing', `Workspace "${ref.workspaceId}" has no project folder.`)
    }
    const cliRuntimes = deps.getCliRuntimes?.()
    const started = await deps.runtime
      .startSession({
        workspaceRoot: owned.workingRoot,
        workspaceId: ref.workspaceId,
        agentId: ref.agentId,
        providerId: conversation.providerId,
        modelId: conversation.modelId,
        ...(cliRuntimes && Object.keys(cliRuntimes).length > 0 ? { cliRuntimes } : {}),
        ...(owned.agent.cliPermissionPreset ? { permissionPreset: owned.agent.cliPermissionPreset } : {}),
        ...(owned.agent.cliPermissionPreset && owned.agent.cliPermissionMode
          ? { permissionMode: owned.agent.cliPermissionMode }
          : {}),
      })
      .catch((error: unknown): ConversationStartSessionResult => ({
        ok: false,
        message: error instanceof Error ? error.message : String(error),
      }))
    return started.ok ? started.session.sessionId : failure('conversation_start_failed', started.message)
  }

  // The live session's preset, else the one the chat's record starts it on.
  function presetOf(
    live: ConversationSessionSummary | null | undefined,
    agent: AgentState | undefined,
  ): { permissionPreset?: ModuleConversationPermissionPreset } {
    const permissionPreset = live?.permissionPreset ?? agent?.cliPermissionPreset
    return permissionPreset ? { permissionPreset } : {}
  }

  function summarize(workspaceId: string, agent: AgentState): ModuleConversationSummary {
    const providerId = agent.conversation?.providerId ?? ''
    const live = liveSession({ workspaceId, agentId: agent.id })
    return {
      workspaceId,
      agentId: agent.id,
      sessionId: live?.sessionId ?? null,
      name: agent.name,
      cli: cliForConversationProvider(providerId) ?? providerId,
      providerId,
      modelId: live?.modelId ?? agent.conversation?.modelId ?? '',
      status: live?.status ?? 'absent',
      ...presetOf(live, agent),
    }
  }

  function listOwned(moduleId: string, filter?: { workspaceId?: string }): ModuleConversationSummary[] {
    const summaries: ModuleConversationSummary[] = []
    for (const workspace of deps.getWorkspaceAgents()) {
      if (filter?.workspaceId && workspace.id !== filter.workspaceId) continue
      for (const agent of Object.values(workspace.agents)) {
        if (!agent || agent.runtimeKind !== 'conversation' || agent.ownerModuleId !== moduleId) continue
        summaries.push(summarize(workspace.id, agent))
      }
    }
    return summaries
  }

  // ── Event fan-out ───────────────────────────────────────────────────────

  type Subscriber = { moduleId: string; ref: ModuleConversationRef; cb: (event: ModuleConversationEvent) => void }
  type Watcher = {
    moduleId: string
    filter?: { workspaceId?: string }
    cb: (list: ModuleConversationSummary[]) => void
    last: string
  }
  const subscribers = new Map<string, Set<Subscriber>>()
  const watchers = new Set<Watcher>()
  let unsubscribeRuntime: (() => void) | null = null
  let unsubscribeWorkspaces: (() => void) | null = null

  function refreshWatchers(onlyModule?: string): void {
    for (const watcher of watchers) {
      if (onlyModule && watcher.moduleId !== onlyModule) continue
      if (!canRead(watcher.moduleId)) continue
      const list = listOwned(watcher.moduleId, watcher.filter)
      const serialized = JSON.stringify(list)
      if (serialized === watcher.last) continue
      watcher.last = serialized
      try {
        watcher.cb(list)
      } catch {
        // A module's callback throwing is its own problem, never the runtime's.
      }
    }
  }

  function onRuntimeEvent(event: ConversationEvent): void {
    const listeners = subscribers.get(refKey(event))
    if (listeners && listeners.size > 0) {
      const redacted = redactEvent(event)
      for (const subscriber of [...listeners]) {
        // Read live: a permission narrowed, or a chat's record gone, stops the
        // stream at the next event.
        if (!canRead(subscriber.moduleId) || !findOwned(subscriber.moduleId, subscriber.ref)) continue
        try {
          subscriber.cb(redacted)
        } catch {
          // As above: a throwing callback does not stop the others.
        }
      }
    }
    if (watchers.size === 0) return
    const owner = deps.getWorkspaceAgents().find((workspace) => workspace.id === event.workspaceId)?.agents[
      event.agentId
    ]?.ownerModuleId
    if (owner) refreshWatchers(owner)
  }

  function ensureListening(): void {
    unsubscribeRuntime ??= deps.runtime.onEvent(onRuntimeEvent)
    if (watchers.size > 0 && deps.onWorkspacesChanged)
      unsubscribeWorkspaces ??= deps.onWorkspacesChanged(() => refreshWatchers())
  }

  function releaseIfIdle(): void {
    if (watchers.size === 0) {
      unsubscribeWorkspaces?.()
      unsubscribeWorkspaces = null
    }
    if (subscribers.size === 0 && watchers.size === 0) {
      unsubscribeRuntime?.()
      unsubscribeRuntime = null
    }
  }

  // ── The service a module sees ───────────────────────────────────────────

  function forModule(moduleId: string): ModuleConversationService {
    return {
      async create(input: ModuleConversationCreateInput) {
        if (!canOperate(moduleId)) return missing(moduleId, 'conversation:operate')
        if (typeof input !== 'object' || input === null) return failure('invalid_input', 'create takes an object.')
        if (typeof input.workspaceId !== 'string' || !input.workspaceId.trim()) {
          return failure('invalid_input', '"workspaceId" is required.')
        }
        for (const key of ['cli', 'model', 'prompt', 'name'] as const) {
          if (input[key] !== undefined && typeof input[key] !== 'string') {
            return failure('invalid_input', `"${key}" must be a string when provided.`)
          }
        }
        if (input.skills !== undefined && !isStringList(input.skills)) {
          return failure('invalid_input', '"skills" must be a list of skill ids.')
        }
        if (input.attachments !== undefined && !isAttachmentList(input.attachments)) {
          return failure('invalid_input', '"attachments" must be a list of images.')
        }
        if (input.permissionPreset !== undefined && !isPermissionPreset(input.permissionPreset)) {
          return failure('invalid_input', '"permissionPreset" must be "none", "manual", "auto" or "bypass".')
        }
        const permissionPreset = capped(moduleId, input.permissionPreset)
        const launched = await deps.launch({
          workspaceId: input.workspaceId.trim(),
          ...(input.cli ? { cli: input.cli } : {}),
          ...(input.model ? { cliModel: input.model } : {}),
          ...(input.prompt ? { prompt: input.prompt } : {}),
          ...(input.name ? { name: input.name } : {}),
          ...(input.skills?.length ? { skills: input.skills } : {}),
          ...(input.attachments?.length ? { attachments: input.attachments } : {}),
          ...(permissionPreset ? { permissionPreset } : {}),
          ownerModuleId: moduleId,
        })
        if (!launched.ok) return failure(launched.code as ModuleConversationErrorCode, launched.message)
        const live = liveSession(launched)
        const record = deps.getWorkspaceAgents().find((workspace) => workspace.id === launched.workspaceId)?.agents[
          launched.agentId
        ]
        return {
          ok: true,
          conversation: {
            workspaceId: launched.workspaceId,
            agentId: launched.agentId,
            sessionId: launched.sessionId,
            name: launched.name,
            cli: launched.cli,
            providerId: launched.providerId,
            modelId: launched.modelId,
            status: live?.status ?? 'starting',
            ...presetOf(live, record),
          },
        }
      },

      async send(ref, input) {
        if (!canOperate(moduleId)) return missing(moduleId, 'conversation:operate')
        if (!isRef(ref)) return failure('invalid_input', 'A conversation ref names its workspaceId and agentId.')
        if (typeof input?.message !== 'string' || (!input.message.trim() && !input.attachments?.length)) {
          return failure('invalid_input', '"message" is required.')
        }
        if (input.skills !== undefined && !isStringList(input.skills)) {
          return failure('invalid_input', '"skills" must be a list of skill ids.')
        }
        if (input.attachments !== undefined && !isAttachmentList(input.attachments)) {
          return failure('invalid_input', '"attachments" must be a list of images.')
        }
        const owned = findOwned(moduleId, ref)
        if (!owned) return notOwned(ref)
        const sessionId = await sessionFor(ref, owned)
        if (typeof sessionId !== 'string') return sessionId
        // Answered when the turn ends, as a send is everywhere else.
        return deps.runtime
          .sendTurn({
            sessionId,
            commandId: newCommandId(),
            message: input.message,
            ...(input.skills?.length ? { skills: input.skills.map((id) => ({ id })) } : {}),
            ...(input.attachments?.length ? { attachments: input.attachments } : {}),
            ...(input.steer === true ? { steer: true } : {}),
          })
          .then(actionResult, actionError)
      },

      async interrupt(ref) {
        if (!canOperate(moduleId)) return missing(moduleId, 'conversation:operate')
        if (!isRef(ref) || !findOwned(moduleId, ref)) return notOwned(ref)
        const live = liveSession(ref)
        if (!live) return { ok: true }
        return deps.runtime.interrupt({ sessionId: live.sessionId }).then(actionResult, actionError)
      },

      async respondToApproval(ref, input) {
        if (!canOperate(moduleId)) return missing(moduleId, 'conversation:operate')
        if (!isRef(ref) || !findOwned(moduleId, ref)) return notOwned(ref)
        if (typeof input?.requestId !== 'string') return failure('invalid_input', '"requestId" is required.')
        if (input.decision !== undefined && !APPROVAL_DECISIONS.has(input.decision)) {
          return failure('invalid_input', '"decision" must be "once", "conversation" or "deny".')
        }
        if (input.approved !== undefined && typeof input.approved !== 'boolean') {
          return failure('invalid_input', '"approved" must be true or false when provided.')
        }
        if (input.decision === undefined && input.approved === undefined) {
          return failure('invalid_input', 'An answer needs "decision" (or the older "approved").')
        }
        // The older boolean reads as the narrowest answer it can mean.
        const decision: ModuleConversationApprovalDecision = input.decision ?? (input.approved ? 'once' : 'deny')
        if (input.approved !== undefined && input.approved !== (decision !== 'deny')) {
          return failure('invalid_input', '"approved" and "decision" disagree.')
        }
        if (
          input.answers !== undefined &&
          (typeof input.answers !== 'object' ||
            input.answers === null ||
            !Object.values(input.answers).every((answer) => typeof answer === 'string'))
        ) {
          return failure('invalid_input', '"answers" maps each question to a string.')
        }
        const live = liveSession(ref)
        if (!live) return failure('runtime_refused', 'The conversation has no live session to answer.')
        // Never a permanent rule: a module answers this request, or allows
        // its kind for the rest of this conversation. A rule that outlives the
        // conversation is the person's to make.
        return deps.runtime
          .respondToRequest({
            sessionId: live.sessionId,
            requestId: input.requestId,
            approved: decision !== 'deny',
            ...(decision === 'conversation' ? { decision } : {}),
            ...(input.answers ? { answers: input.answers } : {}),
          })
          .then(actionResult, actionError)
      },

      async setPermissionPreset(ref, preset) {
        if (!canOperate(moduleId)) return missing(moduleId, 'conversation:operate')
        if (!isRef(ref)) return notOwned(ref)
        if (!isPermissionPreset(preset)) {
          return failure('invalid_input', 'The preset must be "none", "manual", "auto" or "bypass".')
        }
        const owned = findOwned(moduleId, ref)
        if (!owned) return notOwned(ref)
        const permissionPreset = capped(moduleId, preset) ?? preset
        // A live session takes the switch first, and the record moves only once
        // the provider accepted it. With none, the record is what the next
        // session starts on, as in the chat view.
        const live = liveSession(ref)
        let notice: string | undefined
        if (live) {
          const applied = await deps.runtime
            .setPermission({ sessionId: live.sessionId, commandId: newCommandId(), permissionPreset })
            .catch((error: unknown): ConversationSessionActionResult => actionError(error))
          if (!applied.ok) return failure('runtime_refused', applied.message)
          notice = applied.notice
        }
        const written = deps.writeAgent(ref.workspaceId, ref.agentId, { cliPermissionPreset: permissionPreset })
        if (!written.ok) {
          return failure('agent_write_failed', written.message ?? 'The conversation could not be saved.')
        }
        return { ok: true, permissionPreset, ...(notice ? { notice } : {}) }
      },

      async setModel(ref, modelId) {
        if (!canOperate(moduleId)) return missing(moduleId, 'conversation:operate')
        if (!isRef(ref)) return notOwned(ref)
        if (typeof modelId !== 'string' || !modelId.trim()) return failure('invalid_input', 'A model id is required.')
        const owned = findOwned(moduleId, ref)
        if (!owned) return notOwned(ref)
        const id = modelId.trim()
        const providerId = liveSession(ref)?.providerId ?? owned.agent.conversation?.providerId
        if (!providerId) return failure('runtime_refused', 'The conversation has no engine to switch.')
        // The rows the person's own picker offers for the chat's CLI, and the
        // CLI's default: a switch never leaves the CLI.
        if (deps.modelCatalog) {
          const catalog = await deps.modelCatalog(providerId).catch(() => null)
          if (!catalog) return failure('runtime_refused', "This conversation's model cannot be changed.")
          if (id !== CONVERSATION_DEFAULT_MODEL_ID && !catalog.options.some((option) => option.id === id)) {
            return failure('invalid_input', `${catalog.cliLabel} does not offer the model "${id}".`)
          }
        }
        // A chat with no live session is started again, as a send starts it:
        // only a running provider says whether it takes a new model
        // mid-conversation, and the runtime refuses one that does not.
        const sessionId = await sessionFor(ref, owned)
        if (typeof sessionId !== 'string') return sessionId
        const switched = await deps.runtime
          .setModel({ sessionId, commandId: newCommandId(), modelId: id })
          .catch((error: unknown): ConversationSessionActionResult => actionError(error))
        if (!switched.ok) return failure('runtime_refused', switched.message)
        const conversation = owned.agent.conversation
        if (conversation && conversation.modelId !== id) {
          // The session is on the new model already, so a record write that
          // did not land is no reason to answer that the switch failed.
          deps.writeAgent(ref.workspaceId, ref.agentId, { conversation: { ...conversation, modelId: id } })
        }
        return { ok: true, modelId: id, ...(switched.notice ? { notice: switched.notice } : {}) }
      },

      async stop(ref) {
        if (!canOperate(moduleId)) return missing(moduleId, 'conversation:operate')
        if (!isRef(ref) || !findOwned(moduleId, ref)) return notOwned(ref)
        const live = liveSession(ref)
        if (!live) return { ok: true }
        return deps.runtime.stopSession({ sessionId: live.sessionId }).then(actionResult, actionError)
      },

      subscribe(ref, cb) {
        requireRead(moduleId)
        if (!isRef(ref) || !findOwned(moduleId, ref)) throw new Error(notOwned(ref).message)
        const key = refKey(ref)
        const subscriber: Subscriber = { moduleId, ref: { workspaceId: ref.workspaceId, agentId: ref.agentId }, cb }
        const set = subscribers.get(key) ?? new Set()
        set.add(subscriber)
        subscribers.set(key, set)
        ensureListening()
        return () => {
          set.delete(subscriber)
          if (set.size === 0) subscribers.delete(key)
          releaseIfIdle()
        }
      },

      async transcript(ref) {
        if (!canRead(moduleId)) return missing(moduleId, 'conversation:read')
        if (!isRef(ref)) return notOwned(ref)
        const owned = findOwned(moduleId, ref)
        if (!owned) return notOwned(ref)
        if (!owned.workingRoot) {
          return failure('workspace_folder_missing', `Workspace "${ref.workspaceId}" has no project folder.`)
        }
        const read = await deps.runtime
          .readTranscript({ workspaceRoot: owned.workingRoot, workspaceId: ref.workspaceId, agentId: ref.agentId })
          .catch((error: unknown): ConversationTranscriptResult => ({
            ok: false,
            message: error instanceof Error ? error.message : String(error),
          }))
        if (!read.ok) return failure('runtime_refused', read.message)
        return { ok: true, events: read.events.map(redactEvent) }
      },

      list(filter) {
        requireRead(moduleId)
        return listOwned(moduleId, filter)
      },

      watch(filter, cb) {
        requireRead(moduleId)
        const list = listOwned(moduleId, filter)
        const watcher: Watcher = { moduleId, filter, cb, last: JSON.stringify(list) }
        watchers.add(watcher)
        ensureListening()
        cb(list)
        return () => {
          watchers.delete(watcher)
          releaseIfIdle()
        }
      },
    }
  }

  const services = new Map<string, ModuleConversationService>()
  const serviceFor = (moduleId: string): ModuleConversationService => {
    let service = services.get(moduleId)
    if (!service) {
      service = forModule(moduleId)
      services.set(moduleId, service)
    }
    return service
  }

  const registry: ModuleConversationRegistry = {
    create: (moduleId, input) => serviceFor(moduleId).create(input),
    send: (moduleId, ref, input) => serviceFor(moduleId).send(ref, input),
    interrupt: (moduleId, ref) => serviceFor(moduleId).interrupt(ref),
    respondToApproval: (moduleId, ref, input) => serviceFor(moduleId).respondToApproval(ref, input),
    setPermissionPreset: (moduleId, ref, preset) => serviceFor(moduleId).setPermissionPreset(ref, preset),
    setModel: (moduleId, ref, modelId) => serviceFor(moduleId).setModel(ref, modelId),
    stop: (moduleId, ref) => serviceFor(moduleId).stop(ref),
    subscribe: (moduleId, ref, cb) => serviceFor(moduleId).subscribe(ref, cb),
    transcript: (moduleId, ref) => serviceFor(moduleId).transcript(ref),
    list: (moduleId, filter) => serviceFor(moduleId).list(filter),
    watch: (moduleId, filter, cb) => serviceFor(moduleId).watch(filter, cb),
  }

  return {
    forModule: serviceFor,
    registry,
    dispose() {
      subscribers.clear()
      watchers.clear()
      unsubscribeWorkspaces?.()
      unsubscribeWorkspaces = null
      unsubscribeRuntime?.()
      unsubscribeRuntime = null
    },
  }
}
