import { ipcRenderer } from 'electron'

import { SERVER_PORT_CHANNEL } from '../shared/server-port'
import { serverModeFromArgv } from '../shared/server-mode'
import { createIpcRouter, type RendererIpc, type RouterPort } from './ipc-router-core'

// This window's IPC: the router in `ipc-router-core.ts` over Electron's
// `ipcRenderer`, in the mode main started the window in. The web client's
// build swaps this module for one over the browser's socket.

export * from './ipc-router-core'

/** This window's router, over Electron's `ipcRenderer`, in the mode main started the window in. */
function createWindowRouter() {
  const mode = serverModeFromArgv(process.argv)
  const router = createIpcRouter({ ipcRenderer, mode })
  if (mode === 'out-of-process') {
    ipcRenderer.on(SERVER_PORT_CHANNEL, (event) => {
      const [port] = event.ports
      if (port) router.attachPort(port as unknown as RouterPort)
    })
  }
  return router
}

export const ipc: RendererIpc = createWindowRouter()
