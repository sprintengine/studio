import { ipc as ipcRenderer } from '../ipc-router'

import type { ElectronApi } from '../../shared/electron-api'

/**
 * Compact a terminal agent's conversation (`/compact` at its prompt). It takes
 * a session id and nothing else: the text sent is main's, never the renderer's.
 */
type AgentCompactIpcRenderer = {
  invoke(channel: 'agent:compact', sessionId: string): Promise<{ ok: true } | { ok: false; message: string }>
}

export function createAgentCompactApi(renderer: AgentCompactIpcRenderer) {
  return {
    compactAgentSession: (sessionId: string) => renderer.invoke('agent:compact', sessionId),
  } satisfies Pick<ElectronApi, 'compactAgentSession'>
}

export const agentCompactApi = createAgentCompactApi(ipcRenderer)
