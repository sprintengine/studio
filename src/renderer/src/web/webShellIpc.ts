import { refuse } from './unsupported'

// The shell's half of a web tab's IPC: every `window.api` channel the server
// does not own. In a desktop window these reach Electron's main process, which
// owns the window, its menus, the local machine's terminals and the caches the
// shell keeps. A browser has none of that, so every one of them is refused
// here (`unsupported.ts`). The members a browser can answer are answered
// before they get this far, typed, in `createWebApi.ts`.

type Listener = (...args: any[]) => void

/** `ipcRenderer`'s shape, for the router's channels that are not the server's. */
export const webShellIpc = {
  invoke(channel: string): Promise<any> {
    return Promise.reject(refuse(channel))
  },
  send(channel: string): void {
    // A fire-and-forget to a main process that is not there: noted, not thrown.
    refuse(channel)
  },
  // No main process pushes to a web tab, and the tab raises no shell push of
  // its own, so a subscription here has nothing to hear and nothing to keep.
  on(_channel: string, _listener: Listener): void {},
  removeListener(_channel: string, _listener: Listener): void {},
  removeAllListeners(_channel: string): void {},
}
