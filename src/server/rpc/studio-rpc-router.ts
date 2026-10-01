import {
  STUDIO_METHODS,
  parseStudioMethodParams,
  studioScopesGrant,
  type ConversationCommand,
  type StudioCreatedConversation,
  type StudioErrorBody,
  type StudioGrant,
  type StudioMethod,
  type StudioMethodParams,
  type StudioMethodResult,
  type StudioServerInfo,
} from '../../../packages/studio-protocol/src/public'
import { isLooserCliPermissionPreset } from '../../shared/cli-permission-preset'
import { ceilingAllowsUnaskedTools, clampPresetToCeiling } from '../../shared/permission-ceiling'
import type { ConversationKey } from '../../shared/conversation-runtime'
import type { StudioAuditEntry, StudioConversationBackend } from './studio-rpc-types'

// The Studio RPC's methods, transport-free: given the grant a client holds at
// this moment, a method and its params, an answer. The connection reads the
// grant live and hands it here on every request, so a narrowed grant or a
// revoked client is refused at the next request, not the next connection.
//
// Three rules sit here rather than in the conversation host, because they are
// about who is asking:
//
// - Scope. Every method's scope comes from STUDIO_METHODS, checked first.
// - Ceiling. A paired app's chats run no looser than its ceiling, exactly as a
//   module's do (permission-ceiling.ts): a preset it asks for is lowered to the
//   ceiling, none asked for is pinned to it, and naming tools a chat may use
//   unasked needs the loosest ceiling. An app does not drive a chat that
//   already runs looser than its ceiling — it may read it, interrupt or stop
//   it, deny its requests and lower its preset, but not send to it or approve
//   for it — or the ceiling would hold only for chats the app started. A chat
//   running with tools it may use unasked counts as `bypass` for that check,
//   and answering a request for the rest of the conversation (an allow rule
//   for its kind) needs a ceiling of at least `auto`.
// - Command ids. A client's ids are namespaced by the client before they reach
//   the runtime's receipts (`client:<id>:<commandId>`, `owner:<commandId>`), as
//   a module's are (`module:<id>:<commandId>`), so one client can neither
//   collide with nor be answered from another's receipts.

export type StudioRpcAnswer<M extends StudioMethod = StudioMethod> =
  { ok: true; result: StudioMethodResult<M> } | { ok: false; error: StudioErrorBody }

export type StudioRpcRouter = {
  handle(grant: StudioGrant, method: StudioMethod, params: unknown): Promise<StudioRpcAnswer>
}

export type StudioRpcRouterOptions = {
  backend: StudioConversationBackend
  /** What `server.info` answers, without the grant. */
  info: () => Omit<StudioServerInfo, 'grant'>
  audit?: (entry: StudioAuditEntry) => void
  now?: () => number
}

/** The receipt key a client's command id is held under. */
export function studioRuntimeCommandId(grant: StudioGrant, commandId: string): string {
  return grant.owner ? `owner:${commandId}` : `client:${grant.clientId}:${commandId}`
}

/** The strictest ceiling under which an app may answer a request for the rest of a conversation. */
const CONVERSATION_RULE_FLOOR = 'auto' as const

const refuse = (code: string, message: string): { ok: false; error: StudioErrorBody } => ({
  ok: false,
  error: { code, message },
})

// Commands that move a chat's work forward. The rest — interrupt, a denial, a
// rejected plan, a stricter preset, stop — only ever hold it back, so they are
// never refused for the chat's own preset.
function drivesChat(command: ConversationCommand): boolean {
  switch (command.kind) {
    case 'send':
    case 'answerQuestion':
    case 'setModel':
      return true
    case 'resolveApproval':
      return command.decision !== 'deny'
    case 'resolvePlan':
      return command.decision === 'approve'
    default:
      return false
  }
}

export function createStudioRpcRouter(options: StudioRpcRouterOptions): StudioRpcRouter {
  const { backend } = options
  const now = options.now ?? Date.now
  // Creates still starting, by namespaced id: a retry that arrives while the
  // first attempt is launching shares it, so one id makes one chat.
  const creating = new Map<
    string,
    Promise<{ ok: true; conversation: StudioCreatedConversation } | { ok: false; code: string; message: string }>
  >()

  function resolve(key: { workspaceId: string; agentId: string }): ConversationKey | null {
    return backend.resolveKey(key.workspaceId, key.agentId)
  }
  const notFound = (key: { workspaceId: string; agentId: string }) =>
    refuse('not_found', `No conversation "${key.agentId}" in workspace "${key.workspaceId}" here.`)

  function audit(
    grant: StudioGrant,
    method: StudioMethod,
    started: number,
    params: { key?: { workspaceId: string; agentId: string }; commandId?: string; workspaceId?: string },
    answer: StudioRpcAnswer,
    created?: { workspaceId: string; agentId: string },
  ): void {
    const target = created ?? params.key
    options.audit?.({
      clientId: grant.clientId,
      clientName: grant.name,
      tool: method,
      ...(target ? { workspaceId: target.workspaceId, agentId: target.agentId } : {}),
      ...(!target && params.workspaceId ? { workspaceId: params.workspaceId } : {}),
      ...(params.commandId ? { commandId: params.commandId } : {}),
      ok: answer.ok,
      ...(answer.ok ? {} : { code: answer.error.code }),
      durationMs: now() - started,
    })
  }

  async function command(
    grant: StudioGrant,
    params: { key: { workspaceId: string; agentId: string }; commandId: string },
    command: ConversationCommand,
  ): Promise<StudioRpcAnswer> {
    const key = resolve(params.key)
    if (!key) return notFound(params.key)
    let carried = command
    if (command.kind === 'setPermissionPreset') {
      // Lowered, never refused: the answer names the preset in force. A mode
      // belongs to the preset it was asked with, so one lowered runs its own.
      const preset = clampPresetToCeiling(command.preset, grant.ceiling) ?? command.preset
      carried = {
        kind: 'setPermissionPreset',
        preset,
        ...(preset === command.preset && command.permissionMode ? { permissionMode: command.permissionMode } : {}),
      }
    } else if (
      command.kind === 'resolveApproval' &&
      command.decision === 'conversation' &&
      isLooserCliPermissionPreset(CONVERSATION_RULE_FLOOR, grant.ceiling)
    ) {
      // Allowing a kind of request for the rest of the chat is an allow rule,
      // as loose for that kind as `auto` lets edits be: an app held below
      // `auto` answers one request at a time.
      return refuse(
        'ceiling_exceeded',
        `Allowing a request for the rest of the conversation needs a ceiling of "${CONVERSATION_RULE_FLOOR}" or looser; this app's is "${grant.ceiling}". Answer it "once" instead.`,
      )
    } else if (drivesChat(command)) {
      const running = backend.permissionOf(key)
      if (isLooserCliPermissionPreset(running, grant.ceiling))
        return refuse(
          'ceiling_exceeded',
          `This conversation runs on "${running}", looser than the "${grant.ceiling}" this app is allowed. Lower its preset first, or pair the app again with a looser ceiling.`,
        )
    }
    const outcome = await backend.command(key, grant.clientId, studioRuntimeCommandId(grant, params.commandId), carried)
    if (!outcome.ok) return refuse(outcome.code ?? 'unavailable', outcome.message ?? 'The command was not carried out.')
    const notice = outcome.notice ? { notice: outcome.notice } : {}
    if (carried.kind === 'setPermissionPreset')
      return {
        ok: true,
        result: {
          permissionPreset: carried.preset,
          ...(carried.permissionMode ? { permissionMode: carried.permissionMode } : {}),
          ...notice,
        },
      }
    if (carried.kind === 'setModel') return { ok: true, result: { modelId: carried.modelId, ...notice } }
    return { ok: true, result: notice }
  }

  async function create(
    grant: StudioGrant,
    params: StudioMethodParams<'conversation.create'>,
  ): Promise<StudioRpcAnswer<'conversation.create'>> {
    const { commandId, ...request } = params
    if (request.allowedTools?.length && !ceilingAllowsUnaskedTools(grant.ceiling))
      return refuse(
        'ceiling_exceeded',
        'Letting a chat use tools without asking needs a "bypass" ceiling, which this app was not given.',
      )
    const permissionPreset = clampPresetToCeiling(request.permissionPreset, grant.ceiling)
    const capped = {
      ...request,
      permissionPreset,
      // A mode rides only beside the preset it was asked with.
      permissionMode:
        permissionPreset && permissionPreset === request.permissionPreset ? request.permissionMode : undefined,
    }
    if (!capped.permissionPreset) delete capped.permissionPreset
    if (!capped.permissionMode) delete capped.permissionMode
    const launchCommandId = studioRuntimeCommandId(grant, commandId)
    const found = backend.findCreated(launchCommandId)
    if (found) return { ok: true, result: { conversation: found } }
    let pending = creating.get(launchCommandId)
    if (!pending) {
      pending = backend.create(capped, launchCommandId).catch((error: unknown) => ({
        ok: false as const,
        code: 'conversation_start_failed',
        message: error instanceof Error ? error.message : String(error),
      }))
      creating.set(launchCommandId, pending)
      const settled = pending
      void settled.then(() => {
        if (creating.get(launchCommandId) === settled) creating.delete(launchCommandId)
      })
    }
    const created = await pending
    return created.ok
      ? { ok: true, result: { conversation: created.conversation } }
      : refuse(created.code, created.message)
  }

  async function dispatch(grant: StudioGrant, method: StudioMethod, params: never): Promise<StudioRpcAnswer> {
    switch (method) {
      case 'server.info':
        return { ok: true, result: { ...options.info(), grant } }
      case 'conversation.list':
        return { ok: true, result: { conversations: await backend.list() } }
      case 'conversation.create':
        return create(grant, params)
      case 'conversation.stop': {
        const { key: wire } = params as StudioMethodParams<'conversation.stop'>
        const key = resolve(wire)
        if (!key) return notFound(wire)
        const stopped = await backend.stop(key)
        return stopped.ok ? { ok: true, result: {} } : refuse('unavailable', stopped.message)
      }
      case 'conversation.loadEarlier': {
        const { key: wire, beforeCursor, turnLimit } = params as StudioMethodParams<'conversation.loadEarlier'>
        const key = resolve(wire)
        if (!key) return notFound(wire)
        const read = await backend.loadEarlier(key, beforeCursor, turnLimit)
        return read.ok
          ? {
              ok: true,
              result: { page: { ...read.page, events: read.page.events.map((event) => backend.redact(event)) } },
            }
          : refuse('unavailable', read.message)
      }
      case 'conversation.toolDetail': {
        const { key: wire, toolUseId } = params as StudioMethodParams<'conversation.toolDetail'>
        const key = resolve(wire)
        if (!key) return notFound(wire)
        const read = await backend.toolDetail(key, toolUseId)
        if (read.ok)
          return { ok: true, result: { detail: backend.redact(read.detail) as unknown as Record<string, unknown> } }
        return refuse(
          read.code === 'not_found' ? 'not_found' : read.code === 'invalid_input' ? 'invalid_params' : 'unavailable',
          read.message,
        )
      }
      case 'conversation.turnDiff': {
        const { key: wire, turnSeq, path } = params as StudioMethodParams<'conversation.turnDiff'>
        const key = resolve(wire)
        if (!key) return notFound(wire)
        const read = await backend.turnDiff(key, turnSeq, path)
        if (!read.ok) return refuse('unavailable', read.message)
        const { ok: _ok, ...diff } = read
        return { ok: true, result: backend.redact(diff) }
      }
      default: {
        const { key, commandId, ...members } = params as {
          key: { workspaceId: string; agentId: string }
          commandId: string
        } & Record<string, unknown>
        const kind = method.slice('conversation.'.length) as ConversationCommand['kind']
        return command(grant, { key, commandId }, { kind, ...members } as ConversationCommand)
      }
    }
  }

  return {
    async handle(grant, method, params) {
      const spec = STUDIO_METHODS[method]
      const started = now()
      let answer: StudioRpcAnswer
      let read: unknown = params
      if (spec.scope && !studioScopesGrant(grant.scopes, spec.scope)) {
        answer = refuse('scope_required', `This app's grant does not include "${spec.scope}".`)
      } else {
        const parsed = parseStudioMethodParams(method, params)
        if (!parsed.ok) answer = refuse(parsed.code, parsed.message)
        else {
          read = parsed.params
          answer = await dispatch(grant, method, parsed.params as never).catch((error: unknown): StudioRpcAnswer =>
            refuse('unavailable', error instanceof Error ? error.message : 'Studio could not carry that out.'),
          )
        }
      }
      // Every mutation is audited, a refused one included: a refusal at the
      // scope or the ceiling is what this log exists to show.
      if (spec.mutation) {
        const created =
          answer.ok && method === 'conversation.create'
            ? (answer.result as StudioMethodResult<'conversation.create'>).conversation
            : undefined
        audit(grant, method, started, auditTargets(read), answer, created)
      }
      return answer
    },
  }
}

// What a request names, for the audit: its conversation and command id when
// they are where the protocol puts them. Never anything else it carries.
function auditTargets(value: unknown): {
  key?: { workspaceId: string; agentId: string }
  commandId?: string
  workspaceId?: string
} {
  if (value === null || typeof value !== 'object') return {}
  const params = value as Record<string, unknown>
  const text = (field: unknown) => (typeof field === 'string' && field ? field.slice(0, 200) : undefined)
  const key = params.key as Record<string, unknown> | undefined
  const workspaceId = text(key?.workspaceId)
  const agentId = text(key?.agentId)
  const commandId = text(params.commandId)
  const created = text(params.workspaceId)
  return {
    ...(workspaceId && agentId ? { key: { workspaceId, agentId } } : {}),
    ...(commandId ? { commandId } : {}),
    ...(created ? { workspaceId: created } : {}),
  }
}
