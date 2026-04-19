import { app, shell, BrowserWindow, ipcMain, dialog, Menu } from 'electron'
import { basename, dirname, join, parse } from 'path'
import { watch, type FSWatcher } from 'fs'
import { access, cp, mkdir, readdir, readFile, rename, stat, writeFile } from 'fs/promises'
import { autoUpdater } from 'electron-updater'
import * as pty from 'node-pty'

function createWindow(): void {
  const win = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 800,
    minHeight: 600,
    show: false,
    ...(process.platform !== 'darwin'
      ? {
          titleBarStyle: 'hidden',
          titleBarOverlay: {
            color: '#101114',
            symbolColor: '#a1a1aa',
            height: 38,
          },
        }
      : {}),
    autoHideMenuBar: process.platform !== 'darwin',
    backgroundColor: '#09090b',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
    },
  })

  win.on('ready-to-show', () => win.show())

  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url)
    return { action: 'deny' }
  })

  if (process.env['ELECTRON_RENDERER_URL']) {
    win.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    win.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

function sendMenuCommand(win: Electron.BaseWindow | null, command: string): void {
  if (!win || win.isDestroyed()) return
  const browserWindow = BrowserWindow.fromId(win.id)
  if (!browserWindow || browserWindow.isDestroyed()) return
  browserWindow.webContents.send('app-menu:command', command)
}

function createAppMenu(): Menu {
  return Menu.buildFromTemplate([
    {
      label: 'File',
      submenu: [
        {
          label: 'Settings',
          accelerator: 'CmdOrCtrl+,',
          click: (_, win) => sendMenuCommand(win ?? BrowserWindow.getFocusedWindow(), 'show-settings'),
        },
        { type: 'separator' },
        { role: 'close' },
      ],
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' },
      ],
    },
    {
      label: 'View',
      submenu: [
        {
          label: 'Toggle File Explorer',
          accelerator: 'CmdOrCtrl+Shift+E',
          click: (_, win) => sendMenuCommand(win ?? BrowserWindow.getFocusedWindow(), 'toggle-explorer'),
        },
        {
          label: 'Toggle Code Editor',
          accelerator: 'CmdOrCtrl+Shift+O',
          click: (_, win) => sendMenuCommand(win ?? BrowserWindow.getFocusedWindow(), 'toggle-editor'),
        },
        { type: 'separator' },
        { role: 'reload' },
        { role: 'forceReload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    {
      label: 'Window',
      submenu: [
        { role: 'minimize' },
        { role: 'zoom' },
      ],
    },
    {
      label: 'Help',
      submenu: [
        {
          label: 'About Multicode',
          click: (_, win) => sendMenuCommand(win ?? BrowserWindow.getFocusedWindow(), 'show-about'),
        },
      ],
    },
  ])
}

type ContextMenuItem = {
  id?: string
  label?: string
  enabled?: boolean
  type?: 'normal' | 'separator'
}

// ── Claude Code CLI Terminal IPC ──────────────────────────────────────────────

const terminals = new Map<string, pty.IPty>()
const fileWatchers = new Map<string, { watcher: FSWatcher; senderId: number }>()
const trackedWatcherSenders = new Set<number>()
let nextFileWatcherId = 0

type TerminalSpawnPayload = {
  sessionId: string
  cols: number
  rows: number
  cwd?: string
  resume?: boolean
  swarmStatePath?: string
}

type ShellLaunchConfig = {
  command: string
  args: string[]
  initialInput?: string
}

function getTerminalEnv(): Record<string, string> {
  const env = Object.fromEntries(
    Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === 'string')
  )

  delete env.ELECTRON_RUN_AS_NODE
  env.TERM = env.TERM || 'xterm-256color'

  return env
}

function toWslPath(dirPath: string): string {
  const normalized = dirPath.replace(/\\/g, '/')
  const driveMatch = normalized.match(/^([A-Za-z]):\/(.*)$/)

  if (!driveMatch) {
    return normalized
  }

  const [, drive, rest] = driveMatch
  return `/mnt/${drive.toLowerCase()}/${rest}`
}

function quotePosix(value: string): string {
  return `'${value.replace(/'/g, `'\"'\"'`)}'`
}

function quotePowerShell(value: string): string {
  return `"${value.replace(/"/g, '`"')}"`
}

function buildSwarmShellBootstrap(swarmStatePath?: string): string {
  const shellStatePath =
    swarmStatePath && process.platform === 'win32' ? toWslPath(swarmStatePath) : swarmStatePath
  const stateArg = shellStatePath ? `--state ${quotePosix(shellStatePath)}` : ''
  const lines = [
    'export SWARM_TOOL_PATH="$PWD/.agents/skills/swarm-kanban/scripts/swarm_tool.py"',
  ]

  if (shellStatePath) {
    lines.push(`export SWARM_STATE_PATH=${quotePosix(shellStatePath)}`)
  }

  lines.push(
    `swarm() { python3 "$PWD/scripts/swarm_tool.py" ${stateArg} "$@"; }`,
    'export -f swarm >/dev/null 2>&1 || true',
  )

  return lines.join('; ')
}

function buildWslStartupInput(cwd: string, sessionId: string, resume = false, swarmStatePath?: string): string {
  const shellScript = [
    `cd ${quotePosix(toWslPath(cwd))}`,
    buildSwarmShellBootstrap(swarmStatePath),
    buildClaudeLaunchCommand(sessionId, resume),
    'exec bash -li',
  ].join('; ')

  return `wsl.exe -e bash -lic ${quotePowerShell(shellScript)}`
}

function getShellLaunchConfig(
  cwd: string,
  sessionId: string,
  resume = false,
  swarmStatePath?: string
): ShellLaunchConfig {
  if (process.platform === 'win32') {
    return {
      command: 'powershell.exe',
      args: ['-NoLogo', '-NoProfile'],
      initialInput: `${buildWslStartupInput(cwd, sessionId, resume, swarmStatePath)}\r`,
    }
  }

  const shellPath = process.env.SHELL || 'bash'
  const shellName = shellPath.split(/[\\/]/).at(-1)
  const args = shellName === 'bash' || shellName === 'zsh' ? ['-l'] : []

  return {
    command: shellPath,
    args,
    initialInput: `${[buildSwarmShellBootstrap(swarmStatePath), buildClaudeLaunchCommand(sessionId, resume)].join('; ')}\r`,
  }
}

function buildClaudeLaunchCommand(sessionId: string, resume = false): string {
  const quotedSessionId = quotePosix(sessionId)

  if (!resume) {
    return `claude --session-id ${quotedSessionId}`
  }

  // Some panes get a generated session id before the user actually starts a Claude
  // conversation. In that case there is nothing persisted to resume yet, so fall
  // back to starting a fresh session with the same id instead of surfacing the
  // "No conversation found" error on every app launch.
  return [
    `if find "$HOME/.claude/projects" -type f -name ${quotePosix(`${sessionId}.jsonl`)} -print -quit 2>/dev/null | grep -q .; then`,
    `claude --resume ${quotedSessionId};`,
    `else`,
    `claude --session-id ${quotedSessionId};`,
    `fi`,
  ].join(' ')
}

function sendTerminalEvent(
  sender: Electron.WebContents,
  channel: string,
  payload: string | number
): void {
  if (!sender.isDestroyed()) {
    sender.send(channel, payload)
  }
}

function getTerminalErrorMessage(error: unknown): string {
  if (error instanceof Error && /enoent/i.test(error.message)) {
    return process.platform === 'win32'
      ? 'WSL could not be started. Make sure your default WSL distro is installed and available.'
      : 'Claude CLI shell could not be started. Make sure your login shell is available.'
  }

  return error instanceof Error ? error.message : String(error)
}

function disposeTerminal(sessionId: string): void {
  terminals.get(sessionId)?.kill()
  terminals.delete(sessionId)
}

function disposeFileWatcher(watchId: string): void {
  const fileWatcher = fileWatchers.get(watchId)
  if (!fileWatcher) return

  fileWatcher.watcher.close()
  fileWatchers.delete(watchId)
}

function disposeFileWatchersForSender(senderId: number): void {
  for (const [watchId, fileWatcher] of fileWatchers.entries()) {
    if (fileWatcher.senderId === senderId) {
      fileWatcher.watcher.close()
      fileWatchers.delete(watchId)
    }
  }
}

ipcMain.handle(
  'terminal:spawn',
  (event, { sessionId, cols, rows, cwd, resume, swarmStatePath }: TerminalSpawnPayload) => {
    disposeTerminal(sessionId)

    try {
      const workingDirectory = cwd || process.cwd()
      const { command, args, initialInput } = getShellLaunchConfig(
        workingDirectory,
        sessionId,
        resume,
        swarmStatePath
      )
      const termProcess = pty.spawn(command, args, {
        name: 'xterm-256color',
        cols: Math.max(cols || 80, 20),
        rows: Math.max(rows || 24, 8),
        cwd: workingDirectory,
        env: getTerminalEnv(),
      })

      terminals.set(sessionId, termProcess)

      termProcess.onData((data) => {
        sendTerminalEvent(event.sender, `terminal:data:${sessionId}`, data)
      })

      termProcess.onExit((e) => {
        terminals.delete(sessionId)
        sendTerminalEvent(event.sender, `terminal:exit:${sessionId}`, e.exitCode)
      })

      if (initialInput) {
        // Start Claude inside the interactive shell so the user can keep using the terminal afterward.
        termProcess.write(initialInput)
      }
    } catch (error) {
      sendTerminalEvent(event.sender, `terminal:error:${sessionId}`, getTerminalErrorMessage(error))
      sendTerminalEvent(event.sender, `terminal:exit:${sessionId}`, 1)
    }
  }
)

ipcMain.handle('terminal:write', (_, { sessionId, data }: { sessionId: string; data: string }) => {
  terminals.get(sessionId)?.write(data)
})

ipcMain.handle('terminal:resize', (_, { sessionId, cols, rows }: { sessionId: string; cols: number; rows: number }) => {
  try {
    terminals.get(sessionId)?.resize(cols, rows)
  } catch (e) {
    // ignore resize errors if process died
  }
})

ipcMain.handle('terminal:kill', (_, sessionId: string) => {
  disposeTerminal(sessionId)
})

// ── File system IPC handlers ──────────────────────────────────────────────────

ipcMain.handle('fs:watch-start', (event, dirPath: string) => {
  if (!trackedWatcherSenders.has(event.sender.id)) {
    trackedWatcherSenders.add(event.sender.id)
    event.sender.once('destroyed', () => {
      trackedWatcherSenders.delete(event.sender.id)
      disposeFileWatchersForSender(event.sender.id)
    })
  }

  const watchId = `watch-${++nextFileWatcherId}`
  const recursive = process.platform === 'win32' || process.platform === 'darwin'

  const createWatcher = (useRecursive: boolean): FSWatcher =>
    watch(dirPath, { recursive: useRecursive }, (eventType, filename) => {
      if (event.sender.isDestroyed()) return
      event.sender.send(`fs:watch-event:${watchId}`, {
        eventType,
        path: typeof filename === 'string' ? filename : null,
      })
    })

  try {
    const watcher = createWatcher(recursive)
    fileWatchers.set(watchId, { watcher, senderId: event.sender.id })
    return watchId
  } catch (error) {
    if (!recursive) {
      throw error
    }

    const watcher = createWatcher(false)
    fileWatchers.set(watchId, { watcher, senderId: event.sender.id })
    return watchId
  }
})

ipcMain.handle('fs:watch-stop', (_, watchId: string) => {
  disposeFileWatcher(watchId)
})

ipcMain.handle('fs:readdir', async (_, dirPath: string) => {
  const entries = await readdir(dirPath, { withFileTypes: true })
  return entries.map((e) => ({ name: e.name, isDir: e.isDirectory() }))
})

ipcMain.handle('fs:readfile', async (_, filePath: string) => {
  return readFile(filePath, 'utf-8')
})

ipcMain.handle('fs:writefile', async (_, filePath: string, content: string) => {
  await writeFile(filePath, content, 'utf-8')
})

ipcMain.handle('fs:create-file', async (_, parentDir: string, name: string) => {
  const filePath = join(parentDir, name)
  await writeFile(filePath, '', { encoding: 'utf-8', flag: 'wx' })
  return filePath
})

ipcMain.handle('fs:create-dir', async (_, parentDir: string, name: string) => {
  const dirPath = join(parentDir, name)
  await mkdir(dirPath)
  return dirPath
})

ipcMain.handle('fs:rename', async (_, sourcePath: string, nextName: string) => {
  const targetPath = join(dirname(sourcePath), nextName)
  if (targetPath === sourcePath) return targetPath

  if (await pathExists(targetPath)) {
    throw new Error(`A file or folder named "${nextName}" already exists.`)
  }

  await rename(sourcePath, targetPath)
  return targetPath
})

ipcMain.handle('fs:copy', async (_, sourcePath: string, destinationDir: string) => {
  const sourceName = basename(sourcePath)
  const destinationPath = await getUniqueCopyPath(destinationDir, sourceName, sourcePath)

  await cp(sourcePath, destinationPath, {
    errorOnExist: true,
    force: false,
    recursive: true,
  })

  return destinationPath
})

ipcMain.handle('fs:dialog:opendir', async (event) => {
  const win = BrowserWindow.fromWebContents(event.sender)
  const result = await dialog.showOpenDialog(win!, {
    properties: ['openDirectory'],
    title: 'Open Folder',
  })
  return result.filePaths[0] ?? null
})

ipcMain.handle('fs:dialog:savefile', async (event, options: Electron.SaveDialogOptions) => {
  const win = BrowserWindow.fromWebContents(event.sender)
  const result = await dialog.showSaveDialog(win!, options ?? {})
  return result.filePath ?? null
})

ipcMain.handle('fs:dialog:openfile', async (event, options: Electron.OpenDialogOptions) => {
  const win = BrowserWindow.fromWebContents(event.sender)
  const result = await dialog.showOpenDialog(win!, {
    ...(options ?? {}),
    properties: ['openFile'],
  })
  return result.filePaths[0] ?? null
})

ipcMain.handle('app:show-context-menu', async (event, items: ContextMenuItem[]) => {
  const win = BrowserWindow.fromWebContents(event.sender)
  if (!win) return null

  return await new Promise<string | null>((resolve) => {
    let settled = false
    const menu = Menu.buildFromTemplate(
      items.map((item) => {
        if (item.type === 'separator') {
          return { type: 'separator' }
        }

        return {
          label: item.label ?? '',
          enabled: item.enabled ?? true,
          click: () => {
            if (settled) return
            settled = true
            resolve(item.id ?? null)
          },
        }
      })
    )

    menu.popup({
      window: win,
      callback: () => {
        if (settled) return
        settled = true
        resolve(null)
      },
    })
  })
})

ipcMain.handle('app:show-menubar-menu', async (
  event,
  menuLabel: string,
  position?: { x?: number; y?: number }
) => {
  const win = BrowserWindow.fromWebContents(event.sender)
  const appMenu = Menu.getApplicationMenu()
  if (!win || !appMenu) return false

  const topLevelItem = appMenu.items.find((item) => item.label === menuLabel)
  if (!topLevelItem?.submenu) return false

  topLevelItem.submenu.popup({
    window: win,
    x: typeof position?.x === 'number' ? Math.round(position.x) : undefined,
    y: typeof position?.y === 'number' ? Math.round(position.y) : undefined,
  })

  return true
})

async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await access(targetPath)
    return true
  } catch {
    return false
  }
}

async function getUniqueCopyPath(
  destinationDir: string,
  sourceName: string,
  sourcePath: string
): Promise<string> {
  const base = await buildCopyBaseName(sourceName, sourcePath)
  let attempt = 0

  while (true) {
    const candidateName = attempt === 0 ? base.first : base.next(attempt + 1)
    const candidatePath = join(destinationDir, candidateName)
    if (!(await pathExists(candidatePath))) {
      return candidatePath
    }
    attempt += 1
  }
}

async function buildCopyBaseName(
  sourceName: string,
  sourcePath: string
): Promise<{ first: string; next: (count: number) => string }> {
  const sourceStats = await stat(sourcePath)
  const sourceIsDirectory = sourceStats.isDirectory()

  if (sourceIsDirectory) {
    return {
      first: `${sourceName} copy`,
      next: (count) => `${sourceName} copy ${count}`,
    }
  }

  const parsed = parse(sourceName)
  return {
    first: `${parsed.name} copy${parsed.ext}`,
    next: (count) => `${parsed.name} copy ${count}${parsed.ext}`,
  }
}

// ── App lifecycle ─────────────────────────────────────────────────────────────

app.whenReady().then(() => {
  if (process.platform === 'win32') {
    app.setAppUserModelId(
      process.env['ELECTRON_RENDERER_URL'] ? process.execPath : 'com.free-ai-ide'
    )
  }

  Menu.setApplicationMenu(createAppMenu())
  createWindow()

  // Check for updates in production only (no update server configured = silent no-op)
  if (!process.env['ELECTRON_RENDERER_URL']) {
    autoUpdater.checkForUpdatesAndNotify().catch(() => {
      // No update server configured yet — ignore silently
    })
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
