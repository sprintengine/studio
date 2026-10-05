import {
  CONVERSATION_DEFAULT_MODEL_ID,
  type ConversationCommand,
  type ConversationThread,
  type ConversationWireErrorCode,
  type ConversationWireHost,
  type ConversationWirePullRequest,
  type ConversationWireModels,
} from '../../../../packages/conversation-protocol/src/public'
import { isPlaceholderAgentName } from '../../../shared/agent-names'
import type {
  ConversationKey,
  ConversationImageAttachment,
  ConversationPermissionPreset,
  ConversationSessionActionResult,
  ConversationSessionFrame,
  ConversationSessionSummary,
  ConversationSubscribeInput,
} from '../../../shared/conversation-runtime'
import type { ConversationBackend } from '../../../server/core/conversation-backend'
import type { ConversationModelCatalog } from '../../conversation-model-catalog'
import { ConversationSessionApi } from '../../conversation-session-api'
import { randomUUID } from 'node:crypto'
import { DEFAULT_AGENT_SPAWN_PERMISSION_PRESET } from '../../../shared/launch-settings'
import { parseCliPermissionModeId } from '../../../shared/cli-permission-mode'
import { basename, dirname, isAbsolute, resolve } from 'node:path'
import { openConfinedExistingFile } from '../../conversation-file-access'
import { conversationImagePathOf } from './tailnet-conversation-images'
import {
  ATTACHABLE_IMAGE_TYPES,
  MAX_ATTACHMENT_BYTES,
  MAX_ATTACHMENTS_PER_TURN,
} from '../../../shared/conversation-attachments'

const UPLOAD_TTL_MS = 60 * 60_000
const MAX_UPLOAD_REFS = 256
const MAX_DEVICE_UPLOAD_REFS = 32
const MAX_SPENT_UPLOAD_REFS = 256
/**
 * Where a step's picture is, once found, is kept this long and for this many
 * steps. Finding it scans the transcript back to the step, and a phone
 * scrolling a chat, or a second paired machine, asks for the same pictures
 * again. Kept for minutes, not for good: a step can be announced again with
 * a different path, and a picture's last announcement is the one that
 * stands. A step that names no picture yet is not kept at all.
 */
const IMAGE_PATH_TTL_MS = 10 * 60_000
const MAX_IMAGE_PATHS = 256
const wireCapabilities = (session: ConversationSessionSummary) =>
  session.capabilities
    ? {
        images: session.capabilities.images,
        approvals: session.capabilities.approvals,
        questions: session.capabilities.questions,
        planMode: session.capabilities.planMode,
        interrupt: session.capabilities.interrupt,
        checkpoints: session.capabilities.checkpoints === true,
        ...(session.capabilities.permissionPresets
          ? { permissionPresets: [...session.capabilities.permissionPresets] }
          : {}),
        ...(session.capabilities.permissionModes ? { permissionModes: [...session.capabilities.permissionModes] } : {}),
      }
    : undefined

export async function readBoundedConversationUpload(path: string, expectedBytes: number): Promise<Buffer> {
  if (!Number.isSafeInteger(expectedBytes) || expectedBytes < 1 || expectedBytes > MAX_ATTACHMENT_BYTES)
    throw new Error('Image upload size is invalid.')
  const file = await openConfinedExistingFile(dirname(path), basename(path))
  try {
    const before = await file.stat()
    if (!before.isFile() || before.size !== expectedBytes) throw new Error('Image upload changed after receipt.')
    const bytes = Buffer.allocUnsafe(expectedBytes + 1)
    let count = 0
    while (count < bytes.length) {
      const read = await file.read(bytes, count, bytes.length - count, count)
      if (!read.bytesRead) break
      count += read.bytesRead
    }
    const after = await file.stat()
    if (count !== expectedBytes || after.size !== before.size || after.mtimeMs !== before.mtimeMs)
      throw new Error('Image upload changed after receipt.')
    return bytes.subarray(0, count)
  } finally {
    await file.close()
  }
}

export type ConversationGatewayHost = {
  list(): Promise<ConversationThread[]>
  /**
   * This machine's own kind and colour, for the identity endpoint's
   * `machine`: how a paired device draws the desktop it is paired with.
   */
  machine?(): { kind: string; color: string } | null
  resolveKey(workspaceId: string, agentId: string): ConversationKey | null
  subscribe(
    key: ConversationKey,
    cursor: Omit<ConversationSubscribeInput, 'key'>,
    listener: (frame: ConversationSessionFrame) => void,
  ): { dispose(): void; ready: Promise<void> }
  loadEarlier(
    key: ConversationKey,
    beforeCursor: number,
    turnLimit?: number,
  ): ReturnType<ConversationSessionApi['loadEarlier']>
  getToolDetail(key: ConversationKey, toolUseId: string): ReturnType<ConversationBackend['getToolDetail']>
  getTurnDiff(key: ConversationKey, turnSeq: number, path?: string): ReturnType<ConversationSessionApi['getTurnDiff']>
  /**
   * Where the picture one step made or looked at is on this disk, read from
   * the conversation's own record of that step. `unknown_conversation` when
   * the workspace has no such chat; `unknown_image` when the chat has no such
   * step, or the step shows no picture.
   */
  toolImagePath?(key: ConversationKey, toolUseId: string): Promise<ConversationToolImagePath>
  registerUpload?(input: {
    deviceId: string
    sessionId: string
    path: string
    name: string
    mediaType: string
    bytes: number
    dispose?: () => void
  }): string
  /**
   * The preset the conversation runs under now, or would resume under: the
   * same answer its listed thread gives as `permissionPreset`.
   */
  permissionOf?(key: Pick<ConversationKey, 'workspaceId' | 'agentId'>): ConversationPermissionPreset
  /**
   * Carry out one command under its client's id. `fingerprint`, where the
   * client's door computes one, is kept with the command's receipt: the same
   * id for a different command is then refused (`command_id_conflict`).
   */
  command(
    key: ConversationKey,
    deviceId: string,
    commandId: string,
    command: ConversationCommand,
    fingerprint?: string,
  ): Promise<ConversationGatewayCommandResult>
}

/**
 * A runtime answer as a command's result. The runtime names one refusal by a
 * code, a command id already used for a different command, and that is kept;
 * the commands built here name none, and the runtime's words stay in the message.
 */
function relay(
  result: ConversationGatewayCommandResult | ConversationSessionActionResult,
): ConversationGatewayCommandResult {
  if (result.ok || result.code === undefined || result.code === 'command_id_conflict')
    return result as ConversationGatewayCommandResult
  const { code: _unnamed, ...rest } = result
  return rest as ConversationGatewayCommandResult
}

export type ConversationToolImagePath =
  { ok: true; path: string } | { ok: false; code: 'unknown_conversation' | 'unknown_image' }

/**
 * How a command ended. `code` names a refusal the wire has a word for (a model
 * outside the chat's catalog); any other refusal is `unavailable` with its
 * message. `notice` qualifies an accepted command, as the runtime words it.
 */
export type ConversationGatewayCommandResult = {
  ok: boolean
  message?: string
  code?: ConversationWireErrorCode | 'command_id_conflict'
  notice?: string
}

/**
 * What a listed chat carries beside its conversation: the machine it runs on
 * and the pull requests it opened. Both are read from records this
 * desktop already keeps, so listing never starts a process or asks GitHub.
 */
export type ConversationListMarks = {
  /** The machine a workspace's chats run on; null when it cannot be named yet. */
  machineOf?: (workspaceId: string) => ConversationWireHost | null
  /** The pull requests the record holds for these chats, keyed `workspaceId:agentId`. */
  pullRequestsOf?: (
    keys: Array<{ workspaceId: string; agentId: string }>,
  ) => Promise<Map<string, ConversationWirePullRequest[]>>
  /** This machine's own kind and colour. */
  selfMachine?: () => { kind: string; color: string }
}

/**
 * Both IPC and the network wrap this one session API; only root resolution
 * differs. `defaultPermissionPreset` answers for a conversation this app has
 * not run since it started: the preset its agent record holds, else the app's
 * spawn default. `agentName` is the name the conversation's agent record holds
 * — the one this desktop's tab and sidebar show — and is what a phone or a
 * second desktop lists the conversation as; the thread's own title (its first
 * message, or a rename) answers only for a conversation with no named agent.
 */
export function createConversationGatewayHost(
  runtime: ConversationBackend,
  resolveWorkspaceRoot: (workspaceId: string) => string | null,
  listWorkspaces: () => Array<{ workspaceId: string; workspaceRoot: string }>,
  defaultPermissionPreset: (key: { workspaceId: string; agentId: string }) => ConversationPermissionPreset = () =>
    DEFAULT_AGENT_SPAWN_PERMISSION_PRESET,
  agentName: (key: { workspaceId: string; agentId: string }) => string | null | undefined = () => null,
  modelCatalog: (providerId: string) => Promise<ConversationModelCatalog | null> = async () => null,
  marks: ConversationListMarks = {},
  // The effort the chat's agent record keeps (a New chat's pick, or one
  // changed in the chat since), which a window's chat view sends every turn
  // with. A turn sent from here runs at it too, or a chat would switch effort
  // each time the person moved between the phone and the desk.
  reasoningEffortOf: (key: { workspaceId: string; agentId: string }) => string | null | undefined = () => null,
): ConversationGatewayHost {
  // A slot placeholder ("Agent 2", the record id) is not a name; the thread's
  // title says more than it does.
  const nameFor = (key: { workspaceId: string; agentId: string }): string | null => {
    const name = agentName(key)?.trim()
    return name && !isPlaceholderAgentName(name, key.agentId) ? name : null
  }
  const api = new ConversationSessionApi(runtime)
  const uploads = new Map<
    string,
    {
      deviceId: string
      sessionId: string
      path: string
      name: string
      mediaType: string
      bytes: number
      at: number
      dispose?: () => void
    }
  >()
  const discardUpload = (id: string) => {
    uploads.get(id)?.dispose?.()
    uploads.delete(id)
  }
  // Images an accepted send already carried, by upload id. Their files are
  // gone; a retry of that same command is answered from the runtime's receipt
  // and does not need them again.
  const spent = new Map<string, { deviceId: string; commandId: string }>()
  const starting = new Map<string, ReturnType<ConversationBackend['startSession']>>()
  const sending = new Map<
    string,
    { commandId: string; deviceId: string; promise: Promise<ConversationGatewayCommandResult> }
  >()
  let imageSends = 0
  const sessionFor = (key: ConversationKey) => {
    const listed = api.listSessions({ workspaceId: key.workspaceId, agentId: key.agentId })
    return listed.ok
      ? listed.sessions.find(
          (session) =>
            session.workspaceId === key.workspaceId &&
            session.agentId === key.agentId &&
            session.status !== 'stopped' &&
            session.status !== 'failed',
        )
      : undefined
  }
  // The preset a conversation runs under, or would resume under: the last
  // session this app ran for it (a stopped one still holds the preset it had),
  // else the default above. A remote resume keeps the conversation on the
  // preset it was left on rather than choosing one of its own, and on the
  // CLI's own mode at that preset when the session ran one.
  const permissionFor = (
    key: { workspaceId: string; agentId: string },
    sessions: ConversationSessionSummary[],
  ): { permissionPreset: ConversationPermissionPreset; permissionMode?: string } => {
    const latest = sessions
      .filter((session) => session.workspaceId === key.workspaceId && session.agentId === key.agentId)
      .sort((a, b) => b.updatedAt - a.updatedAt)[0]
    if (!latest?.permissionPreset) return { permissionPreset: defaultPermissionPreset(key) }
    return {
      permissionPreset: latest.permissionPreset,
      ...(latest.permissionMode ? { permissionMode: latest.permissionMode } : {}),
    }
  }
  const imagePaths = new Map<string, { at: number; found: Promise<ConversationToolImagePath> }>()
  const threadFor = async (key: ConversationKey) => {
    const indexed = await runtime.listThreads(key)
    return indexed.ok ? indexed.threads.find((entry) => entry.agentId === key.agentId) : undefined
  }
  // The models a chat can switch between: its CLI's catalog, and whether its
  // provider takes a new model mid-conversation — as the live session
  // declared, else as the provider declares for a session it would resume.
  const modelsFor = async (
    providerId: string,
    summary: ConversationSessionSummary | undefined,
    catalogs: Map<string, Promise<ConversationModelCatalog | null>> = new Map(),
  ): Promise<ConversationWireModels | null> => {
    let catalog = catalogs.get(providerId)
    if (!catalog) {
      catalog = modelCatalog(providerId).catch(() => null)
      catalogs.set(providerId, catalog)
    }
    const listed = await catalog
    if (!listed) return null
    const capabilities = summary?.capabilities ?? runtime.getProviderCapabilities(providerId)
    return { ...listed, liveModelSwitch: capabilities?.liveModelSwitch === true }
  }
  const ensureSession = async (key: ConversationKey) => {
    const active = sessionFor(key)
    if (active) return { ok: true as const, session: active }
    const id = JSON.stringify([key.workspaceId, key.agentId])
    let request = starting.get(id)
    if (!request) {
      request = (async () => {
        const thread = await threadFor(key)
        if (!thread) return { ok: false as const, message: 'Conversation is unavailable.' }
        const listed = api.listSessions({ workspaceId: key.workspaceId, agentId: key.agentId })
        return runtime.startSession({
          ...key,
          providerId: thread.providerId,
          modelId: thread.model,
          ...permissionFor(key, listed.ok ? listed.sessions : []),
        })
      })()
      starting.set(id, request)
    }
    try {
      return await request
    } finally {
      if (starting.get(id) === request) starting.delete(id)
    }
  }
  // A switch within the chat's own CLI, to a model this machine's picker
  // offers for it. Checked here, before the runtime sees it: the id must be in
  // the catalog (or be the CLI's own default), and the provider must take a
  // new model mid-conversation. A chat with no live session is resumed, as a
  // send or a preset switch resumes it, and the switch applies to that session.
  const setModel = async (
    key: ConversationKey,
    commandId: string,
    modelId: string,
    fingerprint?: string,
  ): Promise<ConversationGatewayCommandResult> => {
    let session = sessionFor(key)
    const providerId = session?.providerId ?? (await threadFor(key))?.providerId
    if (!providerId) return { ok: false, message: 'Conversation is unavailable.' }
    const models = await modelsFor(providerId, session)
    if (!models)
      return { ok: false, code: 'unsupported_model', message: "This chat's model cannot be changed from here." }
    if (modelId !== CONVERSATION_DEFAULT_MODEL_ID && !models.options.some((option) => option.id === modelId))
      return { ok: false, code: 'unsupported_model', message: `${models.cliLabel} does not offer that model.` }
    if (!models.liveModelSwitch)
      return { ok: false, message: 'This conversation provider cannot change models mid-conversation.' }
    if (!session) {
      const resumed = await ensureSession(key)
      if (!resumed.ok) return resumed
      session = resumed.session
    }
    const switched = await api.setModel({
      sessionId: session.sessionId,
      commandId,
      modelId,
      ...(fingerprint ? { commandFingerprint: fingerprint } : {}),
    })
    if (!switched.ok) return { ok: false, message: switched.message }
    return { ok: true, ...(switched.notice ? { notice: switched.notice } : {}) }
  }
  // The machine once per workspace, and the pull requests in one read of the
  // record for the whole list. A failed read leaves the rows without them, as
  // from a desktop that never listed them: the list itself still answers.
  const withMarks = async (listed: ConversationThread[]): Promise<ConversationThread[]> => {
    if (!marks.machineOf && !marks.pullRequestsOf) return listed
    const machines = new Map<string, ConversationWireHost | null>()
    const machineOf = (workspaceId: string): ConversationWireHost | null => {
      if (!marks.machineOf) return null
      if (!machines.has(workspaceId)) {
        let found: ConversationWireHost | null = null
        try {
          found = marks.machineOf(workspaceId)
        } catch {
          found = null
        }
        machines.set(workspaceId, found)
      }
      return machines.get(workspaceId) ?? null
    }
    let pullRequests: Map<string, ConversationWirePullRequest[]> | null = null
    if (marks.pullRequestsOf && listed.length > 0) {
      pullRequests = await marks
        .pullRequestsOf(listed.map((thread) => ({ workspaceId: thread.workspaceId, agentId: thread.agentId })))
        .catch(() => null)
    }
    return listed.map((thread) => {
      const host = machineOf(thread.workspaceId)
      return {
        ...thread,
        ...(host ? { host } : {}),
        ...(pullRequests ? { pullRequests: pullRequests.get(`${thread.workspaceId}:${thread.agentId}`) ?? [] } : {}),
      }
    })
  }
  return {
    async list() {
      const result = api.listSessions()
      const all = result.ok ? result.sessions : []
      const live = all.filter((session) => session.status !== 'stopped').sort((a, b) => b.updatedAt - a.updatedAt)
      // One catalog read per provider for the whole list.
      const catalogs = new Map<string, Promise<ConversationModelCatalog | null>>()
      const byId = new Map<string, ConversationThread>()
      for (const workspace of listWorkspaces()) {
        const indexed = await runtime.listThreads(workspace)
        if (!indexed.ok) continue
        for (const thread of indexed.threads) {
          const summary = live.find(
            (session) => session.workspaceId === workspace.workspaceId && session.agentId === thread.agentId,
          )
          const models = await modelsFor(thread.providerId, summary, catalogs)
          byId.set(`${workspace.workspaceId}:${thread.agentId}`, {
            workspaceId: workspace.workspaceId,
            agentId: thread.agentId,
            title: nameFor({ workspaceId: workspace.workspaceId, agentId: thread.agentId }) ?? thread.title,
            phase: summary?.phase ?? 'completed',
            updatedAt: thread.updatedAt,
            createdAt: thread.createdAt,
            providerId: thread.providerId,
            modelId: thread.model,
            turnCount: thread.turnCount,
            lastSeq: thread.lastSeq,
            ...permissionFor({ workspaceId: workspace.workspaceId, agentId: thread.agentId }, all),
            ...(models ? { models } : {}),
            ...(summary ? { sessionId: summary.sessionId, capabilities: wireCapabilities(summary) } : {}),
          })
        }
      }
      for (const summary of live) {
        const id = `${summary.workspaceId}:${summary.agentId}`
        if (byId.has(id)) continue
        const models = await modelsFor(summary.providerId, summary, catalogs)
        byId.set(id, {
          workspaceId: summary.workspaceId,
          agentId: summary.agentId,
          title: nameFor(summary) ?? summary.displayName ?? summary.firstUserText ?? 'New conversation',
          phase: summary.phase ?? 'idle',
          updatedAt: summary.updatedAt,
          createdAt: summary.createdAt,
          providerId: summary.providerId,
          modelId: summary.modelId,
          turnCount: 0,
          lastSeq: 0,
          ...permissionFor(summary, all),
          ...(models ? { models } : {}),
          sessionId: summary.sessionId,
          capabilities: wireCapabilities(summary),
        })
      }
      const listed = [...byId.values()].sort((a, b) => b.updatedAt - a.updatedAt)
      return withMarks(listed)
    },
    ...(marks.selfMachine ? { machine: () => marks.selfMachine?.() ?? null } : {}),
    permissionOf(key) {
      const listed = api.listSessions({ workspaceId: key.workspaceId, agentId: key.agentId })
      return permissionFor(key, listed.ok ? listed.sessions : []).permissionPreset
    },
    resolveKey: (workspaceId, agentId) => {
      const workspaceRoot = resolveWorkspaceRoot(workspaceId)
      return workspaceRoot ? { workspaceRoot, workspaceId, agentId } : null
    },
    subscribe: (key, cursor, listener) =>
      api.subscribe(
        { key, afterSeq: cursor.afterSeq, generation: cursor.generation, turnLimit: cursor.turnLimit },
        listener,
      ),
    loadEarlier: (key, beforeCursor, turnLimit) => api.loadEarlier({ key, beforeCursor, turnLimit }),
    getToolDetail: (key, toolUseId) => api.getToolDetail({ ...key, toolUseId }),
    getTurnDiff: (key, turnSeq, path) => api.getTurnDiff({ key, turnSeq, path }),
    toolImagePath(key, toolUseId) {
      const id = JSON.stringify([key.workspaceRoot, key.workspaceId, key.agentId, toolUseId])
      const now = Date.now()
      const kept = imagePaths.get(id)
      if (kept && now - kept.at < IMAGE_PATH_TTL_MS) return kept.found
      const found = (async (): Promise<ConversationToolImagePath> => {
        // A chat is one the list would name: a live session, or a thread the
        // workspace's history holds.
        if (!sessionFor(key) && !(await threadFor(key))) return { ok: false, code: 'unknown_conversation' }
        const tool = await runtime.findToolCall({ ...key, toolUseId })
        const path = tool ? conversationImagePathOf(tool) : null
        if (!path) return { ok: false, code: 'unknown_image' }
        // A relative path names a file in the chat's folder, as a link to it in
        // the same transcript does.
        return { ok: true, path: isAbsolute(path) ? path : resolve(key.workspaceRoot, path) }
      })()
      // Shared while it is being found, so a burst of asks is one scan; kept
      // afterwards only when it named a picture.
      imagePaths.delete(id)
      imagePaths.set(id, { at: now, found })
      while (imagePaths.size > MAX_IMAGE_PATHS) imagePaths.delete(imagePaths.keys().next().value!)
      void found.then(
        (answer) => {
          if (!answer.ok && imagePaths.get(id)?.found === found) imagePaths.delete(id)
        },
        () => {
          if (imagePaths.get(id)?.found === found) imagePaths.delete(id)
        },
      )
      return found
    },
    registerUpload(input) {
      for (const [id, entry] of uploads) if (Date.now() - entry.at > UPLOAD_TTL_MS) discardUpload(id)
      const ownIds = [...uploads].filter(([, entry]) => entry.deviceId === input.deviceId).map(([id]) => id)
      while (ownIds.length >= MAX_DEVICE_UPLOAD_REFS) discardUpload(ownIds.shift()!)
      while (uploads.size >= MAX_UPLOAD_REFS) discardUpload(uploads.keys().next().value!)
      const id = randomUUID()
      uploads.set(id, { ...input, at: Date.now() })
      return id
    },
    command(key, deviceId, commandId, command, fingerprint) {
      if (command.kind === 'setModel') return setModel(key, commandId, command.modelId, fingerprint)
      const stamp = fingerprint ? { commandFingerprint: fingerprint } : {}
      const execute = async (): Promise<ConversationGatewayCommandResult> => relay(await run())
      const run = async (): Promise<ConversationGatewayCommandResult | ConversationSessionActionResult> => {
        let session = sessionFor(key)
        // A send, or a preset switch, reaches a conversation with no live
        // session by resuming it; the switch then applies to that session.
        if (!session && (command.kind === 'send' || command.kind === 'setPermissionPreset')) {
          const resumed = await ensureSession(key)
          if (!resumed.ok) return resumed
          session = resumed.session
        }
        if (!session) return { ok: false, message: 'Conversation is unavailable.' }
        switch (command.kind) {
          case 'send': {
            // Only a level the chat's provider runs, as the chat view checks it.
            const effort = reasoningEffortOf(key) ?? undefined
            const turnEffort =
              effort && session.capabilities?.reasoningEfforts?.includes(effort) ? { reasoningEffort: effort } : {}
            const ids = command.uploadIds ?? []
            if (ids.length > MAX_ATTACHMENTS_PER_TURN) return { ok: false, message: 'Too many image attachments.' }
            const retry =
              ids.length > 0 &&
              ids.every((id) => spent.get(id)?.deviceId === deviceId && spent.get(id)?.commandId === commandId)
            if (retry)
              return api.send({
                sessionId: session.sessionId,
                commandId,
                message: command.message,
                attachments: [],
                ...turnEffort,
                ...stamp,
              })
            const attachments: ConversationImageAttachment[] = []
            for (const id of ids) {
              const upload = uploads.get(id)
              if (
                !upload ||
                upload.deviceId !== deviceId ||
                upload.sessionId !== session.sessionId ||
                !ATTACHABLE_IMAGE_TYPES.includes(upload.mediaType as (typeof ATTACHABLE_IMAGE_TYPES)[number]) ||
                upload.bytes > MAX_ATTACHMENT_BYTES ||
                Date.now() - upload.at > UPLOAD_TTL_MS
              ) {
                return { ok: false, message: 'Image upload reference is unavailable.' }
              }
              let bytes: Buffer
              try {
                bytes = await readBoundedConversationUpload(upload.path, upload.bytes)
              } catch {
                return { ok: false, message: 'Image upload changed after receipt.' }
              }
              attachments.push({
                id,
                mediaType: upload.mediaType,
                dataBase64: bytes.toString('base64'),
                name: upload.name,
                byteLength: bytes.length,
              })
            }
            const sent = await api.send({
              sessionId: session.sessionId,
              commandId,
              message: command.message,
              attachments,
              ...turnEffort,
              ...stamp,
            })
            // Accepted: the images are in the turn now, so their staged files
            // are removed rather than left for the hour-long expiry. A refused
            // send keeps them for a retry.
            if (sent.ok) {
              for (const id of ids) {
                discardUpload(id)
                spent.set(id, { deviceId, commandId })
              }
              while (spent.size > MAX_SPENT_UPLOAD_REFS) spent.delete(spent.keys().next().value!)
            }
            return sent
          }
          case 'interrupt':
            return api.interrupt({ sessionId: session.sessionId, commandId, ...stamp })
          case 'resolveApproval':
            return api.resolveApproval({
              sessionId: session.sessionId,
              commandId,
              requestId: command.requestId,
              approved: command.decision !== 'deny',
              decision: command.decision,
              ...stamp,
            })
          case 'answerQuestion':
            return api.answerQuestion({
              sessionId: session.sessionId,
              commandId,
              requestId: command.requestId,
              approved: true,
              answers: command.answers,
              ...stamp,
            })
          // A plan's own answer, refused for a request that is not a plan.
          // A plan answered as a `resolveApproval`, as before this command
          // existed, is still taken.
          case 'resolvePlan':
            return api.resolveApproval({
              sessionId: session.sessionId,
              commandId,
              requestId: command.requestId,
              approved: command.decision === 'approve',
              requestKind: 'plan',
              ...stamp,
            })
          case 'setPermissionPreset': {
            // A mode that is no mode id of a CLI's own is dropped, and the
            // preset's own mode runs, as a client from before modes gets.
            const permissionMode = parseCliPermissionModeId(command.permissionMode)
            return api.setPermissionPreset({
              sessionId: session.sessionId,
              commandId,
              permissionPreset: command.preset,
              ...(permissionMode ? { permissionMode } : {}),
              ...stamp,
            })
          }
        }
      }
      // Approval responses and interrupts must stay available while a send is
      // waiting on them. Only turn preparation is serialized and deduplicated.
      if (command.kind !== 'send') return execute()
      const id = JSON.stringify([key.workspaceId, key.agentId])
      const pending = sending.get(id)
      if (pending)
        return pending.commandId === commandId && pending.deviceId === deviceId
          ? pending.promise
          : Promise.resolve({ ok: false, message: 'A conversation send is already in progress.' })
      const hasImages = Boolean(command.uploadIds?.length)
      if (hasImages && imageSends >= 2)
        return Promise.resolve({ ok: false, message: 'Image sends are busy. Please retry shortly.' })
      if (hasImages) imageSends++
      const promise = execute().finally(() => {
        if (sending.get(id)?.promise === promise) sending.delete(id)
        if (hasImages) imageSends--
      })
      sending.set(id, { commandId, deviceId, promise })
      return promise
    },
  }
}
