// Test-only stub for `electron`, backing the cross-process seam suites in
// `src/seams/`.
//
// Those suites drive a real renderer surface through the REAL preload
// passthrough (`src/preload/api/*.ts`) into the REAL main IPC handlers
// (`src/main/ipc/*.ts`). Both halves import `electron`, and neither can load it
// in a plain node test bundle. This stub is the wire between them:
// `ipcMain.handle` records a channel's handler and `ipcRenderer.invoke` calls
// exactly that handler, so a channel name the preload spells differently from
// the one main registers fails in the suite rather than silently in production.
//
// Deliberately NOT a permissive mock. An `invoke` on a channel nothing
// registered rejects, the way the real `ipcRenderer` does, so a suite can never
// pass on a fake success. Only the surface these suites actually cross is
// implemented; anything else is absent and fails loudly.

/** channel -> the handler main registered for it. */
const invokeHandlers = new Map()
/** channel -> listeners the preload registered for main-pushed events. */
const rendererListeners = new Map()

const ipcMain = {
  // Real Electron throws on a second `handle` for the same channel. Here the
  // later registration wins, deliberately: a suite legitimately registers one
  // handler set per scenario in a single process. It is the one place this stub
  // is more permissive than Electron, and the app registers each channel once.
  handle(channel, handler) {
    invokeHandlers.set(channel, handler)
  },
  handleOnce(channel, handler) {
    invokeHandlers.set(channel, async (...args) => {
      invokeHandlers.delete(channel)
      return handler(...args)
    })
  },
  removeHandler(channel) {
    invokeHandlers.delete(channel)
  },
  // Fire-and-forget `send` traffic carries no handler contract, so listeners
  // are accepted and never invoked; no seam under test uses this direction.
  on() {
    return ipcMain
  },
  removeListener() {
    return ipcMain
  },
  removeAllListeners() {
    return ipcMain
  },
}

const ipcRenderer = {
  async invoke(channel, ...args) {
    const handler = invokeHandlers.get(channel)
    if (!handler) {
      throw new Error(`Error invoking remote method '${channel}': no handler registered`)
    }
    // The real first argument is an IpcMainInvokeEvent. Its `sender` is the ONE
    // window below — the same object `webContents.send` pushes through — so a
    // handler that subscribes on behalf of its sender (the agent-capabilities
    // watch) delivers its events back to the preload listeners registered on
    // this stub. Not a fabricated stand-in: it is the single renderer these
    // suites model, and a handler reaching past `id` / `isDestroyed` / `once` /
    // `send` still fails on the missing member rather than getting a plausible
    // answer.
    return handler({ sender: webContents }, ...args)
  },
  on(channel, listener) {
    const listeners = rendererListeners.get(channel) ?? new Set()
    listeners.add(listener)
    rendererListeners.set(channel, listeners)
    return ipcRenderer
  },
  removeListener(channel, listener) {
    rendererListeners.get(channel)?.delete(listener)
    return ipcRenderer
  },
  send() {},
}

// One window, so main-side code that pushes to every open window (the
// runs-changed broadcast, the brief-run event) reaches the renderer listeners
// registered above through its normal `webContents.send` path.
const webContents = {
  // Stable id: main-side code that keys subscriptions per sender (the
  // agent-capabilities watch) needs one, and there is exactly one renderer here.
  id: 1,
  isDestroyed: () => false,
  // `once('destroyed')` is a teardown hook; this window never closes inside a
  // suite, so the listener is accepted and never fired.
  once() {
    return webContents
  },
  send(channel, ...args) {
    for (const listener of rendererListeners.get(channel) ?? []) {
      listener({ sender: webContents }, ...args)
    }
  },
}

const theWindow = {
  isDestroyed: () => false,
  webContents,
}

const BrowserWindow = {
  getAllWindows: () => [theWindow],
  fromWebContents: () => theWindow,
}

module.exports = {
  ipcMain,
  ipcRenderer,
  BrowserWindow,
  webContents,
  contextBridge: {
    exposeInMainWorld() {},
  },
  // `isPackaged` and `getPath` are the only app fields the main modules these
  // suites import read; a suite that reaches further should fail on the missing
  // member rather than get a plausible-looking answer.
  app: {
    isPackaged: false,
    // A per-process scratch directory, so a suite that registers an IPC surface
    // keyed on `userData` (the marketplace install receipts) writes somewhere
    // disposable instead of the real profile. `SPRINTENGINE_USER_DATA_DIR` wins
    // when a suite wants to look at what was written, under either of its names
    // because this stub cannot import the TypeScript seam that reconciles them.
    getPath(name) {
      const override = process.env.SPRINTENGINE_USER_DATA_DIR ?? process.env.MULTICODE_USER_DATA_DIR
      const base = override && override.trim().length > 0
        ? override.trim()
        : require('node:path').join(require('node:os').tmpdir(), `multicode-electron-stub-${process.pid}`)
      require('node:fs').mkdirSync(base, { recursive: true })
      return name === 'userData' ? base : require('node:path').join(base, String(name))
    },
  },
}
