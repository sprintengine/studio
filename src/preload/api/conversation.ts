import { ipcRenderer, type IpcRendererEvent } from 'electron'

import type {
  ConversationProviderListResult,
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
  ConversationProviderTestInput,
  ConversationProviderTestResult,
  ConversationRespondToRequestInput,
  ConversationSendTurnInput,
  ConversationSessionActionResult,
  ConversationStartSessionInput,
  ConversationStartSessionResult,
  ConversationStopSessionInput,
} from '../../shared/conversation-runtime'

type ConversationIpcRenderer = {
  invoke(channel: 'conversation:providers:list'): Promise<ConversationProviderListResult>
  invoke(channel: 'conversation:providers:test', input: ConversationProviderTestInput): Promise<ConversationProviderTestResult>
  invoke(channel: 'conversation:secrets:status', input: ConversationSecretStatusInput): Promise<ConversationSecretStatusResult>
  invoke(channel: 'conversation:secrets:set', input: ConversationSecretSetInput): Promise<ConversationSecretSetResult>
  invoke(channel: 'conversation:secrets:clear', input: ConversationSecretClearInput): Promise<ConversationSecretClearResult>
  invoke(channel: 'conversation:sessions:start', input: ConversationStartSessionInput): Promise<ConversationStartSessionResult>
  invoke(channel: 'conversation:sessions:send-turn', input: ConversationSendTurnInput): Promise<ConversationSessionActionResult>
  invoke(channel: 'conversation:sessions:interrupt', input: ConversationInterruptInput): Promise<ConversationSessionActionResult>
  invoke(
    channel: 'conversation:sessions:respond-to-request',
    input: ConversationRespondToRequestInput
  ): Promise<ConversationSessionActionResult>
  invoke(channel: 'conversation:sessions:stop', input: ConversationStopSessionInput): Promise<ConversationSessionActionResult>
  invoke(channel: 'conversation:sessions:list', input?: ConversationListSessionsInput): Promise<ConversationListSessionsResult>
  invoke(channel: 'conversation:events:subscribe'): Promise<{ ok: true; subscriptionId: string }>
  invoke(channel: 'conversation:events:unsubscribe', input: { subscriptionId: string }): Promise<{ ok: true } | { ok: false; message: string }>
  on(channel: 'conversation:event', listener: (event: IpcRendererEvent, payload: ConversationEvent) => void): void
  removeListener(
    channel: 'conversation:event',
    listener: (event: IpcRendererEvent, payload: ConversationEvent) => void
  ): void
}

export function createConversationApi(renderer: ConversationIpcRenderer) {
  return {
    conversationProvidersList: (): Promise<ConversationProviderListResult> =>
      renderer.invoke('conversation:providers:list'),
    conversationProviderTest: (input: ConversationProviderTestInput): Promise<ConversationProviderTestResult> =>
      renderer.invoke('conversation:providers:test', input),
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
      input: ConversationRespondToRequestInput
    ): Promise<ConversationSessionActionResult> =>
      renderer.invoke('conversation:sessions:respond-to-request', input),
    conversationSessionStop: (input: ConversationStopSessionInput): Promise<ConversationSessionActionResult> =>
      renderer.invoke('conversation:sessions:stop', input),
    conversationSessionsList: (input?: ConversationListSessionsInput): Promise<ConversationListSessionsResult> =>
      renderer.invoke('conversation:sessions:list', input),
    onConversationEvent: (cb: (event: ConversationEvent) => void): (() => void) => {
      const listener = (_event: IpcRendererEvent, payload: ConversationEvent) => cb(payload)
      renderer.on('conversation:event', listener)
      const subscription = renderer.invoke('conversation:events:subscribe')
      return () => {
        renderer.removeListener('conversation:event', listener)
        void subscription.then((result) => {
          void renderer.invoke('conversation:events:unsubscribe', { subscriptionId: result.subscriptionId })
        }).catch(() => undefined)
      }
    },
  } satisfies Pick<
    ElectronApi,
    | 'conversationProvidersList'
    | 'conversationProviderTest'
    | 'conversationSecretStatus'
    | 'conversationSecretSet'
    | 'conversationSecretClear'
    | 'conversationSessionStart'
    | 'conversationSessionSendTurn'
    | 'conversationSessionInterrupt'
    | 'conversationSessionRespondToRequest'
    | 'conversationSessionStop'
    | 'conversationSessionsList'
    | 'onConversationEvent'
  >
}

export const conversationApi = createConversationApi(ipcRenderer)
