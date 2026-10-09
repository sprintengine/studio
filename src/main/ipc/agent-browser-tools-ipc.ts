import type { IpcMain } from 'electron'

import type { AgentBrowserToolsStore } from '../agent-browser-tools-store'

/**
 * Settings' read and write of "Let agents use the built-in browser". Main owns
 * the value (agent-browser-tools-store.ts), so both answer with what main now
 * holds; a write also offers or withdraws the tools (`onChange`).
 */
export function registerAgentBrowserToolsIpc(
  ipcMain: IpcMain,
  store: AgentBrowserToolsStore,
  onChange: () => void,
): void {
  ipcMain.handle('app:get-agent-browser-tools', (): boolean => store.isEnabled())
  ipcMain.handle('app:set-agent-browser-tools', (_event, enabled: unknown): boolean => {
    const before = store.isEnabled()
    store.set(enabled === true)
    if (store.isEnabled() !== before) onChange()
    return store.isEnabled()
  })
}
