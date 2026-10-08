import { ipc as ipcRenderer } from '../ipc-router'
import type { ElectronApi } from '../../shared/electron-api'
import type {
  ChatTitleRequest,
  PullRequestTextResult,
  TextGenerationCliRuntimeOverrides,
  TextGenerationEngine,
  TextGenerationResult,
  TextGenerationSettings,
} from '../../shared/text-generation/contract'
import type {
  CreatePullRequestOutcome,
  CreatePullRequestState,
  PullRequestCheckoutPin,
  PushForPullRequestOutcome,
} from '../../shared/git/pull-request-create'

export const textGenerationApi = {
  generateChatTitle: (request: ChatTitleRequest): Promise<TextGenerationResult> =>
    ipcRenderer.invoke('text-generation:chat-title', request),
  // The same one-way push as background mode: the window owns the setting,
  // the process that runs the chats keeps the copy it titles them by.
  setTextGenerationSettings: (settings: TextGenerationSettings): Promise<void> =>
    ipcRenderer.invoke('text-generation:set-settings', settings),
  createPullRequestState: (cwd: string): Promise<CreatePullRequestState | null> =>
    ipcRenderer.invoke('pull-request-create:state', cwd),
  draftPullRequestText: (request: {
    cwd: string
    engine: TextGenerationEngine
    cliRuntimes?: TextGenerationCliRuntimeOverrides
    draftId?: string
  }): Promise<PullRequestTextResult> => ipcRenderer.invoke('pull-request-create:draft', request),
  cancelPullRequestDraft: (draftId: string): Promise<void> =>
    ipcRenderer.invoke('pull-request-create:draft-cancel', draftId),
  pushForPullRequest: (cwd: string, pin?: PullRequestCheckoutPin): Promise<PushForPullRequestOutcome> =>
    ipcRenderer.invoke('pull-request-create:push', cwd, pin),
  createPullRequest: (input: {
    cwd: string
    title: string
    body: string
    pin?: PullRequestCheckoutPin
  }): Promise<CreatePullRequestOutcome> => ipcRenderer.invoke('pull-request-create:create', input),
} satisfies Pick<
  ElectronApi,
  | 'generateChatTitle'
  | 'setTextGenerationSettings'
  | 'createPullRequestState'
  | 'draftPullRequestText'
  | 'cancelPullRequestDraft'
  | 'pushForPullRequest'
  | 'createPullRequest'
>
