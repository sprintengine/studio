import { ipcRenderer, type IpcRendererEvent } from 'electron'

import {
  fleetTerminalEventChannel,
  FLEET_ATTACH_TERMINAL_CHANNEL,
  FLEET_BROWSE_CHANNEL,
  FLEET_CREATE_TERMINAL_CHANNEL,
  FLEET_WORKSPACE_CHECKOUT_CHANNEL,
  FLEET_DETACH_TERMINAL_CHANNEL,
  FLEET_FORGET_CHANNEL,
  FLEET_GET_LIVE_STATE_CHANNEL,
  FLEET_LIST_CONNECTIONS_CHANNEL,
  FLEET_CANCEL_PAIRING_CHANNEL,
  FLEET_CHECK_REACHABILITY_CHANNEL,
  FLEET_PAIR_CHANNEL,
  FLEET_REQUEST_PAIRING_CHANNEL,
  FLEET_EVENT_CHANNEL,
  FLEET_TERMINAL_INPUT_CHANNEL,
  FLEET_TERMINAL_RESIZE_CHANNEL,
  type FleetAttachResult,
  type FleetBrowse,
  type FleetConnection,
  type FleetCreateTerminalResult,
  type FleetCheckoutRequest,
  type FleetWorkspaceCheckoutResult,
  type FleetEvent,
  type FleetLiveState,
  type FleetPairResult,
  type FleetRequestPairingResult,
  type FleetTerminalEvent,
  fleetConversationFrameChannel,
  FLEET_CONVERSATION_COMMAND_CHANNEL,
  FLEET_CONVERSATION_EARLIER_CHANNEL,
  FLEET_CONVERSATION_FOLLOW_CHANNEL,
  FLEET_CONVERSATION_LIST_CHANNEL,
  FLEET_CONVERSATION_TOOL_DETAIL_CHANNEL,
  FLEET_CONVERSATION_TURN_DIFF_CHANNEL,
  FLEET_CONVERSATION_UNFOLLOW_CHANNEL,
  type FleetConversationCommand,
  type FleetConversationCommandResult,
  type FleetConversationFrame,
  type FleetConversationKey,
  type FleetConversationListResult,
} from '../../shared/tailnet-fleet'
import type {
  ConversationPageResult,
  ConversationToolDetailResult,
  ConversationTurnDiffResult,
} from '../../shared/conversation-runtime'
import type { TailnetScope } from '../../shared/tailnet'
import type { ElectronApi } from '../../shared/electron-api'

// The Fleet's data path: the machines this Studio drives, what they
// hold, and the terminals it has open on them.
//
// Nothing here carries a credential. The device tokens stay in main, which is
// also the only place that can dial the listener at all — it refuses any
// request with an `Origin` header, and a renderer always sends one.
export const fleetApi = {
  fleetListConnections: (): Promise<FleetConnection[]> =>
    ipcRenderer.invoke(FLEET_LIST_CONNECTIONS_CHANNEL) as Promise<FleetConnection[]>,
  fleetPair: (pairingUrl: string): Promise<FleetPairResult> =>
    ipcRenderer.invoke(FLEET_PAIR_CHANNEL, { pairingUrl }) as Promise<FleetPairResult>,
  fleetRequestPairing: (
    endpoint: string,
    options?: { scopes?: TailnetScope[]; reverseScopes?: TailnetScope[] },
  ): Promise<FleetRequestPairingResult> =>
    ipcRenderer.invoke(FLEET_REQUEST_PAIRING_CHANNEL, {
      endpoint,
      // Omitted rather than sent empty when the caller names nothing, so each
      // end's own default stays in force.
      ...(options?.scopes ? { scopes: options.scopes } : {}),
      ...(options?.reverseScopes ? { reverseScopes: options.reverseScopes } : {}),
    }) as Promise<FleetRequestPairingResult>,
  fleetCheckReachability: (connectionId?: string): Promise<FleetLiveState> =>
    ipcRenderer.invoke(FLEET_CHECK_REACHABILITY_CHANNEL, connectionId ?? null) as Promise<FleetLiveState>,
  fleetCancelPairing: (requestId: string): Promise<void> =>
    ipcRenderer.invoke(FLEET_CANCEL_PAIRING_CHANNEL, requestId) as Promise<void>,
  fleetForget: (connectionId: string): Promise<FleetConnection[]> =>
    ipcRenderer.invoke(FLEET_FORGET_CHANNEL, connectionId) as Promise<FleetConnection[]>,
  fleetBrowse: (connectionId: string): Promise<FleetBrowse> =>
    ipcRenderer.invoke(FLEET_BROWSE_CHANNEL, connectionId) as Promise<FleetBrowse>,
  fleetCreateTerminal: (input: {
    connectionId: string
    workspaceId?: string
    name?: string
    cli?: string
    prompt?: string
    cliModel?: string
    permissionPreset?: string
    checkout?: FleetCheckoutRequest
  }): Promise<FleetCreateTerminalResult> =>
    ipcRenderer.invoke(FLEET_CREATE_TERMINAL_CHANNEL, input) as Promise<FleetCreateTerminalResult>,
  fleetWorkspaceCheckout: (connectionId: string, workspaceId: string): Promise<FleetWorkspaceCheckoutResult> =>
    ipcRenderer.invoke(FLEET_WORKSPACE_CHECKOUT_CHANNEL, {
      connectionId,
      workspaceId,
    }) as Promise<FleetWorkspaceCheckoutResult>,
  fleetAttachTerminal: (input: {
    attachId: string
    connectionId: string
    sessionId: string
  }): Promise<FleetAttachResult> =>
    ipcRenderer.invoke(FLEET_ATTACH_TERMINAL_CHANNEL, input) as Promise<FleetAttachResult>,
  fleetDetachTerminal: (attachId: string): Promise<void> =>
    ipcRenderer.invoke(FLEET_DETACH_TERMINAL_CHANNEL, attachId) as Promise<void>,
  fleetTerminalInput: (attachId: string, data: string): void => {
    // Fire-and-forget, like the local terminal's fast write: a keystroke that
    // waits for a round trip before the next one is read feels laggy.
    ipcRenderer.send(FLEET_TERMINAL_INPUT_CHANNEL, { attachId, data })
  },
  fleetTerminalResize: (attachId: string, cols: number, rows: number): void => {
    ipcRenderer.send(FLEET_TERMINAL_RESIZE_CHANNEL, { attachId, cols, rows })
  },
  onFleetTerminalEvent: (attachId: string, cb: (event: FleetTerminalEvent) => void): (() => void) => {
    const channel = fleetTerminalEventChannel(attachId)
    const handler = (_: IpcRendererEvent, event: FleetTerminalEvent) => cb(event)
    ipcRenderer.on(channel, handler)
    return () => ipcRenderer.removeListener(channel, handler)
  },
  // Whole-app fleet lifecycle (remote-sessions-ux): machine paired/forgotten
  // and attachment link-state changes, broadcast to every window.
  fleetGetLiveState: (): Promise<FleetLiveState> =>
    ipcRenderer.invoke(FLEET_GET_LIVE_STATE_CHANNEL) as Promise<FleetLiveState>,
  onFleetEvent: (cb: (event: FleetEvent) => void): (() => void) => {
    const handler = (_: IpcRendererEvent, event: FleetEvent) => cb(event)
    ipcRenderer.on(FLEET_EVENT_CHANNEL, handler)
    return () => ipcRenderer.removeListener(FLEET_EVENT_CHANNEL, handler)
  },
  fleetConversationList: (connectionId: string): Promise<FleetConversationListResult> =>
    ipcRenderer.invoke(FLEET_CONVERSATION_LIST_CHANNEL, connectionId) as Promise<FleetConversationListResult>,
  // The same shape as `onConversationSession`: listen first, then ask main
  // to follow, and hand back the unsubscribe. A follow that could not start
  // reaches the callback as an `error` frame, never as a throw.
  onFleetConversationSession: (
    input: { key: FleetConversationKey; turnLimit?: number },
    cb: (frame: FleetConversationFrame) => void,
  ): (() => void) => {
    const followId = `follow-${Date.now()}-${++nextFollowId}`
    const channel = fleetConversationFrameChannel(followId)
    let disposed = false
    const handler = (_: IpcRendererEvent, frame: FleetConversationFrame) => {
      if (!disposed) cb(frame)
    }
    ipcRenderer.on(channel, handler)
    const followed = ipcRenderer.invoke(FLEET_CONVERSATION_FOLLOW_CHANNEL, { followId, ...input }) as Promise<
      { ok: true } | { ok: false; code: string; message: string }
    >
    void followed
      .then((result) => {
        if (!disposed && !result.ok) cb({ type: 'error', message: result.message })
      })
      .catch((error: unknown) => {
        if (!disposed) cb({ type: 'error', message: String(error) })
      })
    return () => {
      if (disposed) return
      disposed = true
      ipcRenderer.removeListener(channel, handler)
      void followed.then(() => ipcRenderer.invoke(FLEET_CONVERSATION_UNFOLLOW_CHANNEL, followId)).catch(() => undefined)
    }
  },
  fleetConversationLoadEarlier: (input: {
    key: FleetConversationKey
    beforeCursor: number
    turnLimit?: number
  }): Promise<ConversationPageResult> =>
    ipcRenderer.invoke(FLEET_CONVERSATION_EARLIER_CHANNEL, input) as Promise<ConversationPageResult>,
  fleetConversationSend: (input: { key: FleetConversationKey; message: string }) =>
    command(input.key, { kind: 'send', message: input.message }),
  fleetConversationInterrupt: (input: { key: FleetConversationKey }) => command(input.key, { kind: 'interrupt' }),
  fleetConversationResolveApproval: (input: {
    key: FleetConversationKey
    requestId: string
    decision: 'once' | 'conversation' | 'deny'
  }) => command(input.key, { kind: 'resolveApproval', requestId: input.requestId, decision: input.decision }),
  fleetConversationAnswerQuestion: (input: {
    key: FleetConversationKey
    requestId: string
    answers: Record<string, string>
  }) => command(input.key, { kind: 'answerQuestion', requestId: input.requestId, answers: input.answers }),
  fleetConversationSetPermissionPreset: (input: { key: FleetConversationKey; preset: 'none' | 'bypass' }) =>
    command(input.key, { kind: 'setPermissionPreset', preset: input.preset }),
  fleetConversationToolDetail: (input: {
    key: FleetConversationKey
    toolUseId: string
  }): Promise<ConversationToolDetailResult> =>
    ipcRenderer.invoke(FLEET_CONVERSATION_TOOL_DETAIL_CHANNEL, input) as Promise<ConversationToolDetailResult>,
  fleetConversationTurnDiff: (input: {
    key: FleetConversationKey
    turnSeq: number
    path?: string
  }): Promise<ConversationTurnDiffResult> =>
    ipcRenderer.invoke(FLEET_CONVERSATION_TURN_DIFF_CHANNEL, input) as Promise<ConversationTurnDiffResult>,
} satisfies Pick<
  ElectronApi,
  | 'fleetListConnections'
  | 'fleetPair'
  | 'fleetRequestPairing'
  | 'fleetCancelPairing'
  | 'fleetCheckReachability'
  | 'fleetForget'
  | 'fleetBrowse'
  | 'fleetCreateTerminal'
  | 'fleetWorkspaceCheckout'
  | 'fleetAttachTerminal'
  | 'fleetDetachTerminal'
  | 'fleetTerminalInput'
  | 'fleetTerminalResize'
  | 'onFleetTerminalEvent'
  | 'fleetGetLiveState'
  | 'onFleetEvent'
  | 'fleetConversationList'
  | 'onFleetConversationSession'
  | 'fleetConversationLoadEarlier'
  | 'fleetConversationSend'
  | 'fleetConversationInterrupt'
  | 'fleetConversationResolveApproval'
  | 'fleetConversationAnswerQuestion'
  | 'fleetConversationSetPermissionPreset'
  | 'fleetConversationToolDetail'
  | 'fleetConversationTurnDiff'
>

let nextFollowId = 0

function command(key: FleetConversationKey, input: FleetConversationCommand): Promise<FleetConversationCommandResult> {
  return ipcRenderer.invoke(FLEET_CONVERSATION_COMMAND_CHANNEL, {
    key,
    command: input,
  }) as Promise<FleetConversationCommandResult>
}
