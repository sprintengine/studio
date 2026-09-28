import { createContext, useContext } from 'react'

import type {
  ConversationInterruptInput,
  ConversationLoadEarlierInput,
  ConversationPageResult,
  ConversationRespondToRequestInput,
  ConversationSendTurnInput,
  ConversationSessionFrame,
  ConversationSessionSummary,
  ConversationSetModelInput,
  ConversationSetPermissionInput,
  ConversationSubscribeInput,
  ConversationToolDetailInput,
  ConversationToolDetailResult,
  ConversationTurnDiffInput,
  ConversationTurnDiffResult,
} from '../../../../../shared/conversation-runtime'
import type {
  MeshConversationAccess,
  MeshConversationCommandResult,
  MeshConversationKey,
  MeshConversationLink,
} from '../../../../../shared/tailnet-mesh'

// Where a chat view's conversation lives. The view — its transcript, pending
// dock, composer — is the same whether the conversation runs on this machine
// or on a paired one; only the calls behind it differ. The local transport is
// the conversation IPC; a remote one is the Mesh's, which follows the
// conversation over the tailnet from main.
//
// What a transport cannot do is said by its capabilities, not inferred from a
// provider id: a remote device may not choose a permanent approval rule or a
// bypass preset, cannot revert a checkpoint on the other machine's disk, and
// has none of this machine's skills, files or history index to offer.

export type ConversationTransportCapabilities = {
  /** Send, stop, answer approvals and questions, change the preset. */
  operate: boolean
  /** Start a provider session here before the first send. A remote send resumes one over there. */
  startSession: boolean
  /** Offer "always allow" rules, which outlive the conversation. */
  permanentApprovals: boolean
  /** Revert a turn's files from its checkpoint. */
  checkpointRevert: boolean
  /**
   * Pick another model of the chat's CLI: before the first turn, and — where
   * the provider declares `liveModelSwitch` — mid-conversation too.
   */
  modelSwitch: boolean
  /** Attach skills, mention files, and attach images from this machine. */
  composerContext: boolean
  /** The local history index: the editable title, cost, search. */
  localHistory: boolean
  /** Paths in the transcript name files on this machine's disk. */
  localFiles: boolean
  /** The runtime echoes an optimistic turn's id back on its `user_message`. */
  optimisticTurns: boolean
  /**
   * The session's permission preset is known before a session reports it. A
   * remote one is known only once the machine's list names it — a desktop
   * built before the list carried it never does — and a picker showing a guess
   * would be worse than none.
   */
  reportsPreset: boolean
}

/** What an action answers: the local session API's result, or a remote command's. */
type ConversationTransportResult =
  { ok: true; session?: ConversationSessionSummary; notice?: string } | { ok: false; message: string }

export type ConversationTransport = {
  kind: 'local' | 'remote'
  /** The paired machine the conversation runs on, for a remote transport. */
  machineName?: string
  capabilities: ConversationTransportCapabilities
  subscribe(input: ConversationSubscribeInput, cb: (frame: ConversationSessionFrame) => void): () => void
  loadEarlier(input: ConversationLoadEarlierInput): Promise<ConversationPageResult>
  toolDetail(input: ConversationToolDetailInput): Promise<ConversationToolDetailResult>
  turnDiff(input: ConversationTurnDiffInput): Promise<ConversationTurnDiffResult>
  send(input: ConversationSendTurnInput): Promise<ConversationTransportResult>
  interrupt(input: ConversationInterruptInput): Promise<ConversationTransportResult>
  respond(input: ConversationRespondToRequestInput): Promise<ConversationTransportResult>
  setPermissionPreset(input: ConversationSetPermissionInput): Promise<ConversationTransportResult>
  /** Switch a running session's model; absent where the transport cannot. */
  setModel?(input: ConversationSetModelInput): Promise<ConversationTransportResult>
}

const LOCAL_CAPABILITIES: ConversationTransportCapabilities = {
  operate: true,
  startSession: true,
  permanentApprovals: true,
  checkpointRevert: true,
  modelSwitch: true,
  composerContext: true,
  localHistory: true,
  localFiles: true,
  optimisticTurns: true,
  reportsPreset: true,
}

/** The conversation IPC, read off `window.api` at call time so a test's stub is the one used. */
const localConversationTransport: ConversationTransport = {
  kind: 'local',
  capabilities: LOCAL_CAPABILITIES,
  subscribe: (input, cb) => window.api.onConversationSession(input, cb),
  loadEarlier: (input) => window.api.conversationLoadEarlier(input),
  toolDetail: (input) => window.api.conversationToolDetail(input),
  turnDiff: (input) => window.api.conversationTurnDiff(input),
  send: (input) => window.api.conversationSessionSendTurn(input),
  interrupt: (input) => window.api.conversationSessionInterrupt(input),
  respond: (input) => window.api.conversationSessionRespondToRequest(input),
  setPermissionPreset: (input) => window.api.conversationSessionSetPermission(input),
  setModel: (input) => window.api.conversationSessionSetModel(input),
}

const ConversationTransportContext = createContext<ConversationTransport>(localConversationTransport)

export const ConversationTransportProvider = ConversationTransportContext.Provider

export function useConversationTransport(): ConversationTransport {
  return useContext(ConversationTransportContext)
}

const commandResult = (result: MeshConversationCommandResult): ConversationTransportResult =>
  result.ok ? { ok: true, ...(result.notice ? { notice: result.notice } : {}) } : { ok: false, message: result.message }

/**
 * A conversation on a paired machine, over the Mesh. The key it was made for
 * is the one every call names: the local key a view passes carries this
 * machine's idea of a workspace root, which means nothing over there.
 * `onLink` receives the connection state main narrates beside the frames.
 */
export function createRemoteConversationTransport(input: {
  key: MeshConversationKey
  machineName: string
  access: MeshConversationAccess | null
  onLink?: (link: MeshConversationLink) => void
}): ConversationTransport {
  const { key } = input
  return {
    kind: 'remote',
    machineName: input.machineName,
    capabilities: {
      operate: input.access === 'operate',
      startSession: false,
      permanentApprovals: false,
      checkpointRevert: false,
      modelSwitch: false,
      composerContext: false,
      localHistory: false,
      localFiles: false,
      optimisticTurns: false,
      reportsPreset: false,
    },
    subscribe: (subscription, cb) =>
      window.api.onMeshConversationSession({ key, turnLimit: subscription.turnLimit }, (frame) => {
        if (frame.type === 'link') input.onLink?.(frame)
        else cb(frame)
      }),
    loadEarlier: (page) =>
      window.api.meshConversationLoadEarlier({ key, beforeCursor: page.beforeCursor, turnLimit: page.turnLimit }),
    toolDetail: (detail) => window.api.meshConversationToolDetail({ key, toolUseId: detail.toolUseId }),
    turnDiff: (diff) => window.api.meshConversationTurnDiff({ key, turnSeq: diff.turnSeq, path: diff.path }),
    send: async (turn) => commandResult(await window.api.meshConversationSend({ key, message: turn.message })),
    interrupt: async () => commandResult(await window.api.meshConversationInterrupt({ key })),
    respond: async (response) => {
      if (response.answers && response.approved)
        return commandResult(
          await window.api.meshConversationAnswerQuestion({
            key,
            requestId: response.requestId,
            answers: response.answers,
          }),
        )
      if (response.decision === 'always')
        return { ok: false, message: 'A remote device cannot choose a permanent rule.' }
      const decision = !response.approved ? 'deny' : response.decision === 'conversation' ? 'conversation' : 'once'
      return commandResult(
        await window.api.meshConversationResolveApproval({ key, requestId: response.requestId, decision }),
      )
    },
    setPermissionPreset: async (change) =>
      commandResult(await window.api.meshConversationSetPermissionPreset({ key, preset: change.permissionPreset })),
    // Offered only while the machine advertises model switching; the pane turns
    // `modelSwitch` on from its list, and the chip stays locked without it.
    setModel: async (change) =>
      commandResult(await window.api.meshConversationSetModel({ key, modelId: change.modelId })),
  }
}
