import { refuse } from './unsupported'

// The shell's half of a web tab's IPC: every `window.api` channel the server
// does not own. In a desktop window these reach Electron's main process, which
// owns the window, its menus, the local machine's terminals and the caches the
// shell keeps. A browser has none of that, so every one of them is refused
// here (`unsupported.ts`). The members a browser can answer are answered
// before they get this far, typed, in `createWebApi.ts`.

type Listener = (...args: any[]) => void

/** Shell-side pushes a web tab raises itself (none come from a main process). */
const listeners = new Map<string, Set<Listener>>()

export function emitWebShellPush(channel: string, ...args: unknown[]): void {
  for (const listener of [...(listeners.get(channel) ?? [])]) listener({ sender: null, ports: [] }, ...args)
}

/** `ipcRenderer`'s shape, for the router's channels that are not the server's. */
export const webShellIpc = {
  invoke(channel: string): Promise<any> {
    return Promise.reject(refuse(channel))
  },
  send(channel: string): void {
    // A fire-and-forget to a main process that is not there: noted, not thrown.
    refuse(channel)
  },
  on(channel: string, listener: Listener): void {
    let set = listeners.get(channel)
    if (!set) listeners.set(channel, (set = new Set()))
    set.add(listener)
  },
  removeListener(channel: string, listener: Listener): void {
    listeners.get(channel)?.delete(listener)
  },
  removeAllListeners(channel: string): void {
    listeners.delete(channel)
  },
}
