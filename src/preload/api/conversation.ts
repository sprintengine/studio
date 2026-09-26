import { ipcRenderer, type IpcRendererEvent } from 'electron'

import type {
  ConversationProviderListResult,
  ConversationProviderModelsInput,
  ConversationProviderModelsResult,
  ConversationSecretClearInput,
  ConversationSecretClearResult,
  ConversationSecretSetInput,
  ConversationSecretSetResult,
  ConversationSecretStatusInput,
  ConversationSecretStatusResult,
  ElectronApi,
} from '../../shared/electron-api'
import type {
  ConversationEvent,
  ConversationInterruptInput,
  ConversationListSessionsInput,
  ConversationListSessionsResult,
  ConversationRespondToRequestInput,
  ConversationSendTurnInput,
  ConversationSessionActionResult,
  ConversationSetPermissionInput,
  ConversationStartSessionInput,
  ConversationStartSessionResult,
  ConversationStopSessionInput,
  ConversationProvidersListInput,
  ConversationTranscriptInput,
  ConversationTranscriptResult,
  ConversationToolDetailInput,
  ConversationToolDetailResult,
  ConversationSubscribeInput,
  ConversationLoadEarlierInput,
  ConversationSessionFrame,
  ConversationPageResult,
  ConversationTurnDiffInput,
  ConversationTurnDiffResult,
  ConversationRevertInput,
  ConversationRevertResult,
  ConversationApprovalRulesResult,
  ConversationApprovalRuleRevokeResult,
} from '../../shared/conversation-runtime'

type ConversationIpcRenderer = {
  invoke(channel: 'conversation:approval-rules:list'): Promise<ConversationApprovalRulesResult>
  invoke(
    channel: 'conversation:approval-rules:revoke',
    input: { ruleId: string },
  ): Promise<ConversationApprovalRuleRevokeResult>
  invoke(channel: 'conversation:turn:diff', input: ConversationTurnDiffInput): Promise<ConversationTurnDiffResult>
  invoke(channel: 'conversation:turn:revert', input: ConversationRevertInput): Promise<ConversationRevertResult>
  invoke(
    channel: 'conversation:session:subscribe',
    input: ConversationSubscribeInput & { subscriptionId: string },
  ): Promise<{ ok: boolean; subscriptionId?: string; message?: string }>
  invoke(channel: 'conversation:session:unsubscribe', input: { subscriptionId: string }): Promise<{ ok: boolean }>
  invoke(channel: 'conversation:session:earlier', input: ConversationLoadEarlierInput): Promise<ConversationPageResult>
  on(
    channel: 'conversation:session-event',
    listener: (event: IpcRendererEvent, payload: { subscriptionId: string; frame: ConversationSessionFrame }) => void,
  ): void
  removeListener(
    channel: 'conversation:session-event',
    listener: (event: IpcRendererEvent, payload: { subscriptionId: string; frame: ConversationSessionFrame }) => void,
  ): void
  invoke(
    channel: 'conversation:providers:list',
    input?: ConversationProvidersListInput,
  ): Promise<ConversationProviderListResult>
  invoke(
    channel: 'conversation:providers:models',
    input: ConversationProviderModelsInput,
  ): Promise<ConversationProviderModelsResult>
  invoke(
    channel: 'conversation:secrets:status',
    input: ConversationSecretStatusInput,
  ): Promise<ConversationSecretStatusResult>
  invoke(channel: 'conversation:secrets:set', input: ConversationSecretSetInput): Promise<ConversationSecretSetResult>
  invoke(
    channel: 'conversation:secrets:clear',
    input: ConversationSecretClearInput,
  ): Promise<ConversationSecretClearResult>
  invoke(
    channel: 'conversation:sessions:start',
    input: ConversationStartSessionInput,
  ): Promise<ConversationStartSessionResult>
  invoke(
    channel: 'conversation:sessions:send-turn',
    input: ConversationSendTurnInput,
  ): Promise<ConversationSessionActionResult>
  invoke(
    channel: 'conversation:sessions:interrupt',
    input: ConversationInterruptInput,
  ): Promise<ConversationSessionActionResult>
  invoke(
    channel: 'conversation:sessions:respond-to-request',
    input: ConversationRespondToRequestInput,
  ): Promise<ConversationSessionActionResult>
  invoke(
    channel: 'conversation:sessions:set-permission',
    input: ConversationSetPermissionInput,
  ): Promise<ConversationSessionActionResult>
  invoke(
    channel: 'conversation:sessions:stop',
    input: ConversationStopSessionInput,
  ): Promise<ConversationSessionActionResult>
  invoke(
    channel: 'conversation:sessions:list',
    input?: ConversationListSessionsInput,
  ): Promise<ConversationListSessionsResult>
  invoke(channel: 'conversation:transcript', input: ConversationTranscriptInput): Promise<ConversationTranscriptResult>
  invoke(channel: 'conversation:tool-detail', input: ConversationToolDetailInput): Promise<ConversationToolDetailResult>
  invoke(channel: 'conversation:events:subscribe'): Promise<{ ok: true; subscriptionId: string }>
  invoke(
    channel: 'conversation:events:unsubscribe',
    input: { subscriptionId: string },
  ): Promise<{ ok: true } | { ok: false; message: string }>
  on(channel: 'conversation:event', listener: (event: IpcRendererEvent, payload: ConversationEvent) => void): void
  removeListener(
    channel: 'conversation:event',
    listener: (event: IpcRendererEvent, payload: ConversationEvent) => void,
  ): void
}

export function createConversationApi(renderer: ConversationIpcRenderer) {
  const callbacks = new Set<(event: ConversationEvent) => void>()
  let subscription: Promise<{ ok: true; subscriptionId: string }> | undefined
  const listener = (_event: IpcRendererEvent, payload: ConversationEvent) => {
    for (const callback of callbacks) {
      try {
        callback(payload)
      } catch {
        callbacks.delete(callback)
      }
    }
  }
  let nextScopedId = 0
  return {
    conversationApprovalRules: (): Promise<ConversationApprovalRulesResult> =>
      renderer.invoke('conversation:approval-rules:list'),
    conversationRevokeApprovalRule: (input: { ruleId: string }): Promise<ConversationApprovalRuleRevokeResult> =>
      renderer.invoke('conversation:approval-rules:revoke', input),
    conversationTurnDiff: (input: ConversationTurnDiffInput): Promise<ConversationTurnDiffResult> =>
      renderer.invoke('conversation:turn:diff', input),
    conversationRevertToTurn: (input: ConversationRevertInput): Promise<ConversationRevertResult> =>
      renderer.invoke('conversation:turn:revert', input),
    conversationProvidersList: (input?: ConversationProvidersListInput): Promise<ConversationProviderListResult> =>
      renderer.invoke('conversation:providers:list', input),
    conversationProviderModels: (input: ConversationProviderModelsInput): Promise<ConversationProviderModelsResult> =>
      renderer.invoke('conversation:providers:models', input),
    conversationSecretStatus: (input: ConversationSecretStatusInput): Promise<ConversationSecretStatusResult> =>
      renderer.invoke('conversation:secrets:status', input),
    conversationSecretSet: (input: ConversationSecretSetInput): Promise<ConversationSecretSetResult> =>
      renderer.invoke('conversation:secrets:set', input),
    conversationSecretClear: (input: ConversationSecretClearInput): Promise<ConversationSecretClearResult> =>
      renderer.invoke('conversation:secrets:clear', input),
    conversationSessionStart: (input: ConversationStartSessionInput): Promise<ConversationStartSessionResult> =>
      renderer.invoke('conversation:sessions:start', input),
    conversationSessionSendTurn: (input: ConversationSendTurnInput): Promise<ConversationSessionActionResult> =>
      renderer.invoke('conversation:sessions:send-turn', input),
    conversationSessionInterrupt: (input: ConversationInterruptInput): Promise<ConversationSessionActionResult> =>
      renderer.invoke('conversation:sessions:interrupt', input),
    conversationSessionRespondToRequest: (
      input: ConversationRespondToRequestInput,
    ): Promise<ConversationSessionActionResult> => renderer.invoke('conversation:sessions:respond-to-request', input),
    conversationSessionSetPermission: (
      input: ConversationSetPermissionInput,
    ): Promise<ConversationSessionActionResult> => renderer.invoke('conversation:sessions:set-permission', input),
    conversationSessionStop: (input: ConversationStopSessionInput): Promise<ConversationSessionActionResult> =>
      renderer.invoke('conversation:sessions:stop', input),
    conversationSessionsList: (input?: ConversationListSessionsInput): Promise<ConversationListSessionsResult> =>
      renderer.invoke('conversation:sessions:list', input),
    conversationTranscript: (input: ConversationTranscriptInput): Promise<ConversationTranscriptResult> =>
      renderer.invoke('conversation:transcript', input),
    conversationToolDetail: (input: ConversationToolDetailInput): Promise<ConversationToolDetailResult> =>
      renderer.invoke('conversation:tool-detail', input),
    conversationLoadEarlier: (input: ConversationLoadEarlierInput): Promise<ConversationPageResult> =>
      renderer.invoke('conversation:session:earlier', input),
    onConversationSession: (
      input: ConversationSubscribeInput,
      cb: (frame: ConversationSessionFrame) => void,
    ): (() => void) => {
      const subscriptionId = `panel-${Date.now()}-${++nextScopedId}`
      let disposed = false
      const receive = (
        _event: IpcRendererEvent,
        payload: { subscriptionId: string; frame: ConversationSessionFrame },
      ) => {
        if (!disposed && payload.subscriptionId === subscriptionId) cb(payload.frame)
      }
      renderer.on('conversation:session-event', receive)
      const subscribed = renderer.invoke('conversation:session:subscribe', { ...input, subscriptionId })
      void subscribed
        .then((result) => {
          if (!disposed && !result.ok)
            cb({ type: 'error', message: result.message ?? 'Conversation subscription failed.' })
        })
        .catch((error) => {
          if (!disposed) cb({ type: 'error', message: String(error) })
        })
      return () => {
        if (disposed) return
        disposed = true
        renderer.removeListener('conversation:session-event', receive)
        void subscribed
          .then(() => renderer.invoke('conversation:session:unsubscribe', { subscriptionId }))
          .catch(() => undefined)
      }
    },
    onConversationEvent: (cb: (event: ConversationEvent) => void): (() => void) => {
      callbacks.add(cb)
      if (!subscription) {
        renderer.on('conversation:event', listener)
        subscription = renderer.invoke('conversation:events:subscribe')
        void subscription.catch(() => undefined)
      }
      let disposed = false
      return () => {
        if (disposed) return
        disposed = true
        callbacks.delete(cb)
        if (callbacks.size > 0) return
        renderer.removeListener('conversation:event', listener)
        const pending = subscription
        subscription = undefined
        void pending
          ?.then((result) => {
            void renderer.invoke('conversation:events:unsubscribe', { subscriptionId: result.subscriptionId })
          })
          .catch(() => undefined)
      }
    },
  } satisfies Pick<
    ElectronApi,
    | 'conversationProvidersList'
    | 'conversationProviderModels'
    | 'conversationSecretStatus'
    | 'conversationSecretSet'
    | 'conversationSecretClear'
    | 'conversationSessionStart'
    | 'conversationSessionSendTurn'
    | 'conversationSessionInterrupt'
    | 'conversationSessionRespondToRequest'
    | 'conversationSessionSetPermission'
    | 'conversationSessionStop'
    | 'conversationSessionsList'
    | 'conversationTranscript'
    | 'conversationToolDetail'
    | 'conversationLoadEarlier'
    | 'conversationTurnDiff'
    | 'conversationRevertToTurn'
    | 'conversationApprovalRules'
    | 'conversationRevokeApprovalRule'
    | 'onConversationSession'
    | 'onConversationEvent'
  >
}

export const conversationApi = createConversationApi(ipcRenderer)
