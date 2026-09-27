import type { ConversationClientFrame, ConversationWireThread } from '../../../../packages/conversation-protocol/src'
import type {
  ConversationKey,
  ConversationImageAttachment,
  ConversationSessionFrame,
  ConversationSessionSummary,
  ConversationSubscribeInput,
} from '../../../shared/conversation-runtime'
import type { ConversationRuntime } from '../../conversation-runtime'
import { ConversationSessionApi } from '../../conversation-session-api'
import { randomUUID } from 'node:crypto'
import { basename, dirname } from 'node:path'
import { openConfinedExistingFile } from '../../conversation-file-access'
import {
  ATTACHABLE_IMAGE_TYPES,
  MAX_ATTACHMENT_BYTES,
  MAX_ATTACHMENTS_PER_TURN,
} from '../../../shared/conversation-attachments'

const UPLOAD_TTL_MS = 60 * 60_000
const MAX_UPLOAD_REFS = 256
const MAX_DEVICE_UPLOAD_REFS = 32
const MAX_SPENT_UPLOAD_REFS = 256
const wireCapabilities = (session: ConversationSessionSummary) =>
  session.capabilities
    ? {
        images: session.capabilities.images,
        approvals: session.capabilities.approvals,
        questions: session.capabilities.questions,
        planMode: session.capabilities.planMode,
        interrupt: session.capabilities.interrupt,
        checkpoints: session.capabilities.checkpoints === true,
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
  list(): Promise<ConversationWireThread[]>
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
  getToolDetail(key: ConversationKey, toolUseId: string): ReturnType<ConversationRuntime['getToolDetail']>
  getTurnDiff(key: ConversationKey, turnSeq: number, path?: string): ReturnType<ConversationSessionApi['getTurnDiff']>
  registerUpload?(input: {
    deviceId: string
    sessionId: string
    path: string
    name: string
    mediaType: string
    bytes: number
    dispose?: () => void
  }): string
  command(
    key: ConversationKey,
    deviceId: string,
    commandId: string,
    command: Extract<ConversationClientFrame, { type: 'command' }>['command'],
  ): Promise<{ ok: boolean; message?: string }>
}

/** Both IPC and the network wrap this one session API; only root resolution differs. */
export function createConversationGatewayHost(
  runtime: ConversationRuntime,
  resolveWorkspaceRoot: (workspaceId: string) => string | null,
  listWorkspaces: () => Array<{ workspaceId: string; workspaceRoot: string }>,
): ConversationGatewayHost {
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
  const starting = new Map<string, ReturnType<ConversationRuntime['startSession']>>()
  const sending = new Map<
    string,
    { commandId: string; deviceId: string; promise: Promise<{ ok: boolean; message?: string }> }
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
  const ensureSession = async (key: ConversationKey) => {
    const active = sessionFor(key)
    if (active) return { ok: true as const, session: active }
    const id = JSON.stringify([key.workspaceId, key.agentId])
    let request = starting.get(id)
    if (!request) {
      request = (async () => {
        const indexed = await runtime.listThreads(key)
        const thread = indexed.ok ? indexed.threads.find((entry) => entry.agentId === key.agentId) : undefined
        if (!thread) return { ok: false as const, message: 'Conversation is unavailable.' }
        // A remote resume never inherits an unattended or bypass preset. If
        // the provider cannot honor manual approval, resume it on the desktop.
        return runtime.startSession({
          ...key,
          providerId: thread.providerId,
          modelId: thread.model,
          permissionPreset: 'manual',
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
  return {
    async list() {
      const result = api.listSessions()
      const live = result.ok
        ? result.sessions.filter((session) => session.status !== 'stopped').sort((a, b) => b.updatedAt - a.updatedAt)
        : []
      const byId = new Map<string, ConversationWireThread>()
      for (const workspace of listWorkspaces()) {
        const indexed = await runtime.listThreads(workspace)
        if (!indexed.ok) continue
        for (const thread of indexed.threads) {
          const summary = live.find(
            (session) => session.workspaceId === workspace.workspaceId && session.agentId === thread.agentId,
          )
          byId.set(`${workspace.workspaceId}:${thread.agentId}`, {
            workspaceId: workspace.workspaceId,
            agentId: thread.agentId,
            title: thread.title,
            phase: summary?.phase ?? 'completed',
            updatedAt: thread.updatedAt,
            createdAt: thread.createdAt,
            providerId: thread.providerId,
            modelId: thread.model,
            turnCount: thread.turnCount,
            lastSeq: thread.lastSeq,
            ...(summary ? { sessionId: summary.sessionId, capabilities: wireCapabilities(summary) } : {}),
          })
        }
      }
      for (const summary of live) {
        const id = `${summary.workspaceId}:${summary.agentId}`
        if (byId.has(id)) continue
        byId.set(id, {
          workspaceId: summary.workspaceId,
          agentId: summary.agentId,
          title: summary.displayName ?? summary.firstUserText ?? 'New conversation',
          phase: summary.phase ?? 'idle',
          updatedAt: summary.updatedAt,
          createdAt: summary.createdAt,
          providerId: summary.providerId,
          modelId: summary.modelId,
          turnCount: 0,
          lastSeq: 0,
          sessionId: summary.sessionId,
          capabilities: wireCapabilities(summary),
        })
      }
      return [...byId.values()].sort((a, b) => b.updatedAt - a.updatedAt)
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
    registerUpload(input) {
      for (const [id, entry] of uploads) if (Date.now() - entry.at > UPLOAD_TTL_MS) discardUpload(id)
      const ownIds = [...uploads].filter(([, entry]) => entry.deviceId === input.deviceId).map(([id]) => id)
      while (ownIds.length >= MAX_DEVICE_UPLOAD_REFS) discardUpload(ownIds.shift()!)
      while (uploads.size >= MAX_UPLOAD_REFS) discardUpload(uploads.keys().next().value!)
      const id = randomUUID()
      uploads.set(id, { ...input, at: Date.now() })
      return id
    },
    command(key, deviceId, commandId, command) {
      const execute = async (): Promise<{ ok: boolean; message?: string }> => {
        let session = sessionFor(key)
        if (!session && command.kind === 'send') {
          const resumed = await ensureSession(key)
          if (!resumed.ok) return resumed
          session = resumed.session
        }
        if (!session) return { ok: false, message: 'Conversation is unavailable.' }
        switch (command.kind) {
          case 'send': {
            if (session.permissionPreset !== 'manual' && session.permissionPreset !== 'auto')
              return {
                ok: false,
                message: 'Choose an explicit Manual or Auto permission preset before sending from a remote device.',
              }
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
                requireSafePermissions: true,
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
              requireSafePermissions: true,
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
            return api.interrupt({ sessionId: session.sessionId, commandId })
          case 'resolveApproval':
            return api.resolveApproval({
              sessionId: session.sessionId,
              commandId,
              requestId: command.requestId,
              approved: command.decision !== 'deny',
              decision: command.decision,
            })
          case 'answerQuestion':
            return api.answerQuestion({
              sessionId: session.sessionId,
              commandId,
              requestId: command.requestId,
              approved: true,
              answers: command.answers,
            })
          case 'setPermissionPreset':
            return api.setPermissionPreset({
              sessionId: session.sessionId,
              commandId,
              permissionPreset: command.preset,
            })
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
