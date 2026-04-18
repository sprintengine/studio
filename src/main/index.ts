import { app, shell, BrowserWindow, ipcMain, dialog } from 'electron'
import { join } from 'path'
import { readdir, readFile, writeFile } from 'fs/promises'
import { spawn, type ChildProcess } from 'child_process'
import { autoUpdater } from 'electron-updater'

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

// ── Claude Code CLI IPC ───────────────────────────────────────────────────────

const claudeProcs = new Map<string, ChildProcess>()

ipcMain.handle('claude:run', (event, { agentId, prompt }: { agentId: string; prompt: string }) => {
  // Kill any prior run for this agent
  claudeProcs.get(agentId)?.kill()
  claudeProcs.delete(agentId)

  const isWin = process.platform === 'win32'
  const child = spawn(isWin ? 'claude.cmd' : 'claude', ['--print'], {
    stdio: ['pipe', 'pipe', 'pipe'],
    // shell:false on unix (no .cmd lookup needed); shell:true on win as fallback
    shell: isWin,
  })

  claudeProcs.set(agentId, child)

  child.stdout.on('data', (data: Buffer) => {
    event.sender.send(`claude:chunk:${agentId}`, data.toString())
  })

  child.on('close', () => {
    claudeProcs.delete(agentId)
    event.sender.send(`claude:done:${agentId}`)
  })

  child.on('error', (err: Error) => {
    claudeProcs.delete(agentId)
    const msg = err.message.includes('ENOENT')
      ? 'claude CLI not found — make sure Claude Code is installed and in your PATH'
      : err.message
    event.sender.send(`claude:error:${agentId}`, msg)
  })

  // Pipe prompt via stdin — avoids any shell-quoting issues
  child.stdin.write(prompt)
  child.stdin.end()
})

ipcMain.handle('claude:cancel', (_, agentId: string) => {
  claudeProcs.get(agentId)?.kill()
  claudeProcs.delete(agentId)
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
