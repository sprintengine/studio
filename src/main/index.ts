import { app, shell, BrowserWindow, ipcMain, dialog } from 'electron'
import { join } from 'path'
import { readdir, readFile, writeFile } from 'fs/promises'
import { autoUpdater } from 'electron-updater'
import * as pty from 'node-pty'

function createWindow(): void {
  const win = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 800,
    minHeight: 600,
    show: false,
    autoHideMenuBar: true,
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

// ── Claude Code CLI Terminal IPC ──────────────────────────────────────────────

const terminals = new Map<string, pty.IPty>()

type TerminalSpawnPayload = {
  sessionId: string
  cols: number
  rows: number
  cwd?: string
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

function buildWslStartupInput(cwd: string, sessionId: string): string {
  const shellScript = [
    `cd ${quotePosix(toWslPath(cwd))} && ${buildClaudeLaunchCommand(sessionId)}`,
    'exec bash -li',
  ].join('; ')

  return `wsl.exe -e bash -lic ${quotePowerShell(shellScript)}`
}

function getShellLaunchConfig(cwd: string, sessionId: string): ShellLaunchConfig {
  if (process.platform === 'win32') {
    return {
      command: 'powershell.exe',
      args: ['-NoLogo', '-NoProfile'],
      initialInput: `${buildWslStartupInput(cwd, sessionId)}\r`,
    }
  }

  const shellPath = process.env.SHELL || 'bash'
  const shellName = shellPath.split(/[\\/]/).at(-1)
  const args = shellName === 'bash' || shellName === 'zsh' ? ['-l'] : []

  return {
    command: shellPath,
    args,
    initialInput: `${buildClaudeLaunchCommand(sessionId)}\r`,
  }
}

function buildClaudeLaunchCommand(sessionId: string): string {
  return `claude --session-id ${sessionId}`
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

ipcMain.handle(
  'terminal:spawn',
  (event, { sessionId, cols, rows, cwd }: TerminalSpawnPayload) => {
    disposeTerminal(sessionId)

    try {
      const workingDirectory = cwd || process.cwd()
      const { command, args, initialInput } = getShellLaunchConfig(workingDirectory, sessionId)
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

// ── App lifecycle ─────────────────────────────────────────────────────────────

app.whenReady().then(() => {
  if (process.platform === 'win32') {
    app.setAppUserModelId(
      process.env['ELECTRON_RENDERER_URL'] ? process.execPath : 'com.free-ai-ide'
    )
  }

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
