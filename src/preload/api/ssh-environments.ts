import { ipc as ipcRenderer } from '../ipc-router'
import type { ElectronApi } from '../../shared/electron-api'
import {
  SSH_ENV_CHANNELS,
  type SshEnvironmentResult,
  type SshEnvironmentSettings,
  type SshEnvironmentSummary,
  type SshPromptRequest,
  type SshResolveResult,
} from '../../shared/ssh-environments'
import { SSH_PREVIEW_CHANNELS, type SshPreviewStatus } from '../../shared/ssh-preview'

// SSH machines (phase 8): main holds their sessions and asks their questions.
export const sshEnvironmentsApi = {
  sshEnvironmentsList: (): Promise<SshEnvironmentSummary[]> => ipcRenderer.invoke(SSH_ENV_CHANNELS.list),
  sshEnvironmentResolve: (destination: string): Promise<SshResolveResult> =>
    ipcRenderer.invoke(SSH_ENV_CHANNELS.resolve, { destination }),
  sshEnvironmentSuggestions: (): Promise<string[]> => ipcRenderer.invoke(SSH_ENV_CHANNELS.suggestions),
  sshEnvironmentAdd: (input: {
    destination: string
    label?: string
  }): Promise<SshEnvironmentResult & { id?: string }> => ipcRenderer.invoke(SSH_ENV_CHANNELS.add, input),
  sshEnvironmentUpdate: (
    id: string,
    patch: Partial<SshEnvironmentSettings> & { label?: string },
  ): Promise<SshEnvironmentResult> => ipcRenderer.invoke(SSH_ENV_CHANNELS.update, { id, patch }),
  sshEnvironmentConnect: (id: string): Promise<SshEnvironmentResult> =>
    ipcRenderer.invoke(SSH_ENV_CHANNELS.connect, { id }),
  sshEnvironmentDisconnect: (id: string): Promise<SshEnvironmentResult> =>
    ipcRenderer.invoke(SSH_ENV_CHANNELS.disconnect, { id }),
  sshEnvironmentStopServer: (id: string): Promise<SshEnvironmentResult> =>
    ipcRenderer.invoke(SSH_ENV_CHANNELS.stopServer, { id }),
  sshEnvironmentUpgradeServer: (id: string): Promise<SshEnvironmentResult> =>
    ipcRenderer.invoke(SSH_ENV_CHANNELS.upgradeServer, { id }),
  sshEnvironmentForget: (
    id: string,
    options: { stopServer?: boolean; clearBrowsingData?: boolean } = {},
  ): Promise<SshEnvironmentResult> => ipcRenderer.invoke(SSH_ENV_CHANNELS.forget, { id, ...options }),
  sshEnvironmentDiagnostics: (id: string): Promise<{ ok: true; text: string } | { ok: false; message: string }> =>
    ipcRenderer.invoke(SSH_ENV_CHANNELS.diagnostics, { id }),
  sshSignIn: (id: string, providerId: string): Promise<SshEnvironmentResult> =>
    ipcRenderer.invoke(SSH_ENV_CHANNELS.signIn, { id, providerId }),
  onSshEnvironmentsChanged: (cb: () => void): (() => void) => {
    const handler = () => cb()
    ipcRenderer.on(SSH_ENV_CHANNELS.changed, handler)
    return () => ipcRenderer.removeListener(SSH_ENV_CHANNELS.changed, handler)
  },
  onSshPrompt: (cb: (request: SshPromptRequest) => void): (() => void) => {
    const handler = (_event: unknown, request: SshPromptRequest) => cb(request)
    ipcRenderer.on(SSH_ENV_CHANNELS.prompt, handler)
    return () => ipcRenderer.removeListener(SSH_ENV_CHANNELS.prompt, handler)
  },
  onSshPromptClosed: (cb: (id: string) => void): (() => void) => {
    const handler = (_event: unknown, payload: { id: string }) => cb(payload.id)
    ipcRenderer.on(SSH_ENV_CHANNELS.promptClosed, handler)
    return () => ipcRenderer.removeListener(SSH_ENV_CHANNELS.promptClosed, handler)
  },
  sshPromptAnswer: (id: string, answer: string | null): void =>
    ipcRenderer.send(SSH_ENV_CHANNELS.answer, { id, answer }),
  // The preview switch, answered whether or not this session has SSH machines.
  sshPreviewStatus: (): Promise<SshPreviewStatus> => ipcRenderer.invoke(SSH_PREVIEW_CHANNELS.get),
  sshPreviewSet: (enabled: boolean): Promise<SshPreviewStatus> =>
    ipcRenderer.invoke(SSH_PREVIEW_CHANNELS.set, { enabled }),
} satisfies Partial<ElectronApi>
