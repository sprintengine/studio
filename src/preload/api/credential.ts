import { ipcRenderer } from 'electron'

import type {
  CredentialSecretClearInput,
  CredentialSecretClearResult,
  CredentialSecretSetInput,
  CredentialSecretSetResult,
  CredentialSecretStatusInput,
  CredentialSecretStatusResult,
  ElectronApi,
} from '../../shared/electron-api'

// Preload surface for the shared credential store. Generic (id-based), so any
// renderer surface — Agents CLI settings, the chat Providers tab, future ones —
// reads/writes credentials through one mechanism.
type CredentialIpcRenderer = {
  invoke(
    channel: 'credential:secrets:status',
    input: CredentialSecretStatusInput,
  ): Promise<CredentialSecretStatusResult>
  invoke(channel: 'credential:secrets:set', input: CredentialSecretSetInput): Promise<CredentialSecretSetResult>
  invoke(channel: 'credential:secrets:clear', input: CredentialSecretClearInput): Promise<CredentialSecretClearResult>
}

export function createCredentialApi(renderer: CredentialIpcRenderer) {
  return {
    credentialSecretStatus: (input: CredentialSecretStatusInput): Promise<CredentialSecretStatusResult> =>
      renderer.invoke('credential:secrets:status', input),
    credentialSecretSet: (input: CredentialSecretSetInput): Promise<CredentialSecretSetResult> =>
      renderer.invoke('credential:secrets:set', input),
    credentialSecretClear: (input: CredentialSecretClearInput): Promise<CredentialSecretClearResult> =>
      renderer.invoke('credential:secrets:clear', input),
  } satisfies Pick<ElectronApi, 'credentialSecretStatus' | 'credentialSecretSet' | 'credentialSecretClear'>
}

export const credentialApi = createCredentialApi(ipcRenderer)
