import { join } from 'node:path'

import {
  app,
  BrowserWindow,
  MessageChannelMain,
  powerMonitor,
  safeStorage,
  utilityProcess,
  type MessagePortMain,
} from 'electron'

import type { ServerBootstrapEnvelope } from '../../server/bootstrap/envelope'
import { SERVER_EVENTS, SERVER_METHODS, SHELL_METHODS, type PowerHint } from '../../server/desktop/server-methods'
import { serveShellBridge } from '../../server/shell-bridge/serve-shell-bridge'
import type { ShellBridge } from '../../server/shell-bridge/shell-bridge'
import type { StudioConnectResult } from '../../shared/studio-connection'
import { isCanvasWorkerWindow } from '../canvas/canvas-worker-window'
import { isAppRendererUrl } from '../ipc/ipc-sender'
import { isWorkspaceWindowWebContents } from '../window-factory'
import { writeDiagnosticLog } from '../diagnostics-service'
import { createPortBroker, type PortBroker } from './port-broker'
import type { ShellServerLink } from './remote-core'
import { createServerLog, type ServerLog } from './server-log'
import { createServerStateMirror, type ServerStateMirror } from './server-mirror'
import { createServerSupervisor, type ServerSupervisor, type ShutdownProgress } from './supervisor'
import { forkUtilityServer } from './utility-launcher'

// The shell's half of the Studio server out of process, put together: the
// supervisor that forks and watches it, the log its output goes to, the port
// broker that hands every app window its port, the mirror of what the shell
// reads synchronously, the shell bridge and the two caches the server asks
// about, and the hints the shell sends (power, focus, visibility).
//
// Built at boot, before any window, when the session's mode is out of process;
// forked at `ready`, which is the earliest a utility process can start.

export type DesktopServerHost = {
  supervisor: ServerSupervisor
  link: ShellServerLink
  mirror: ServerStateMirror
  broker: PortBroker
  log: ServerLog
  /** Fork the server and start sending hints. At app ready. */
  start(): void
  /** Answer the server's requests of the shell: the bridge, and the shell's own caches. */
  serveShell(
    bridge: ShellBridge,
    caches: { marketplaceRead(input: unknown): unknown; thirdPartyModules(): unknown },
  ): void
  /** A chat view's protocol connection, its port handed to the server. */
  connectStudioPort(port: MessagePortMain): Promise<StudioConnectResult>
  shutdown(options: {
    drain: boolean
    budgetMs: number
    onProgress?: (progress: ShutdownProgress) => void
  }): Promise<'exited' | 'killed'>
}

export function createDesktopServerHost(options: {
  buildStamp: string | null
  diagnosticsEnabled: boolean
  version: string
  channel: 'latest' | 'nightly'
}): DesktopServerHost {
  const userData = app.getPath('userData')
  const log = createServerLog({
    logsDir: () => app.getPath('logs'),
    // A dev build says what its server says in the terminal it was started from.
    ...(app.isPackaged ? {} : { onLine: (line: string) => process.stderr.write(`[studio-server] ${line}\n`) }),
  })
  const say = (line: string) => log.note(line)
  const envelope = (): ServerBootstrapEnvelope => ({
    v: 1,
    role: 'desktop-local',
    dataDir: userData,
    logsDir: app.getPath('logs'),
    runDir: join(userData, 'run'),
    tempDir: app.getPath('temp'),
    paths: {
      resourcesDir: process.resourcesPath ?? null,
      appPath: app.getAppPath(),
      isPackaged: app.isPackaged,
      // Main's own binary: the launcher pointer and the MCP fallback entry
      // name it, never the Helper the server itself runs as.
      appExecPath: process.execPath,
    },
    app: { version: options.version, buildStamp: options.buildStamp ?? '', channel: options.channel },
    owner: {},
    listeners: { gateway: true, tailnet: 'from-settings' },
    secrets: { kind: 'shell', available: safeStorage.isEncryptionAvailable() },
    flags: { diagnostics: options.diagnosticsEnabled },
  })
  const supervisor = createServerSupervisor({
    fork: () =>
      forkUtilityServer({
        utilityProcess,
        // Beside main in the same build; inside app.asar when packaged.
        modulePath: join(app.getAppPath(), 'out', 'main', 'studio-server.js'),
        log,
      }),
    envelope,
    log: say,
  })
  const mirror = createServerStateMirror({ rpc: supervisor.rpc, log: say })
  const broker = createPortBroker({
    supervisor,
    createChannel: () => new MessageChannelMain(),
    isAppDocument: isAppRendererUrl,
    isWorkspaceWindow: (window) => isWorkspaceWindowWebContents(window.webContents as Electron.WebContents),
    log: say,
  })
  // Every ready (the first and each restart's) starts the mirror over.
  supervisor.onReady(() => {
    void mirror.load().catch((error: unknown) => say(`mirror did not load: ${String(error)}`))
    sendWindowHints()
  })
  supervisor.onState((state) => {
    say(state.kind === 'ready' ? `server ready (pid ${state.ready.pid})` : `server ${state.kind}`)
    if (state.kind === 'failed') {
      void writeDiagnosticLog({
        level: 'error',
        source: 'workspace',
        title: 'Studio server stopped',
        message: state.reason,
        details: log.tail().slice(-40).join('\n'),
      }).catch(() => undefined)
    }
  })

  function sendWindowHints(): void {
    const windows = BrowserWindow.getAllWindows().filter((win) => !win.isDestroyed() && !isCanvasWorkerWindow(win))
    supervisor.rpc.emit(SERVER_EVENTS.hintVisibility, {
      anyWindowVisible: windows.some((win) => win.isVisible() && !win.isMinimized()),
    })
    supervisor.rpc.emit(SERVER_EVENTS.hintFocus, { appFocused: windows.some((win) => win.isFocused()) })
  }

  function startHints(): void {
    const power = (event: PowerHint) => {
      if (event === 'suspend') supervisor.power('suspend')
      if (event === 'resume') supervisor.power('resume')
      supervisor.rpc.emit(SERVER_EVENTS.hintPower, { event })
    }
    powerMonitor.on('suspend', () => power('suspend'))
    powerMonitor.on('resume', () => power('resume'))
    powerMonitor.on('lock-screen', () => power('lock'))
    powerMonitor.on('unlock-screen', () => power('unlock'))
    powerMonitor.on('on-battery', () => power('battery'))
    powerMonitor.on('on-ac', () => power('ac'))
    app.on('browser-window-focus', sendWindowHints)
    app.on('browser-window-blur', sendWindowHints)
    app.on('browser-window-created', (_event, window) => {
      broker.attachWindow(window)
      for (const event of ['show', 'hide', 'minimize', 'restore', 'closed'] as const)
        window.on(event as 'show', sendWindowHints)
    })
  }

  const link: ShellServerLink = {
    rpc: supervisor.rpc,
    mirror,
    whenServing: async (budgetMs) => (await supervisor.whenReady(budgetMs)) === 'ready',
    isServing: () => supervisor.state.kind === 'ready',
  }

  return {
    supervisor,
    link,
    mirror,
    broker,
    log,
    start() {
      startHints()
      // Windows created before this (none, in the boot order) are attached too.
      for (const window of BrowserWindow.getAllWindows()) broker.attachWindow(window)
      supervisor.start()
    },
    serveShell(bridge, caches) {
      serveShellBridge(supervisor.rpc, bridge)
      supervisor.rpc.handle(SHELL_METHODS.marketplaceRead, (input) => caches.marketplaceRead(input))
      supervisor.rpc.handle(SHELL_METHODS.thirdPartyModules, () => caches.thirdPartyModules())
    },
    async connectStudioPort(port) {
      if ((await supervisor.whenReady(STUDIO_CONNECT_WAIT_MS)) !== 'ready') {
        throw new Error('Studio server is not running, so this window cannot reach its chats yet.')
      }
      const clientId = `studio-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
      if (!supervisor.post({ t: 'attach-client', clientId, windowId: null, kind: 'studio-connection' }, [port])) {
        throw new Error('Studio server is restarting; try again.')
      }
      return supervisor.call<StudioConnectResult>(SERVER_METHODS.studioConnect, { clientId })
    },
    shutdown: (shutdownOptions) => supervisor.shutdown(shutdownOptions),
  }
}

/** How long a chat view's connection waits for a server still starting. */
const STUDIO_CONNECT_WAIT_MS = 20_000
