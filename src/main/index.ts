import { app, shell, BrowserWindow, ipcMain, dialog, Menu } from 'electron'
import { basename, dirname, join, parse } from 'path'
import { existsSync, watch, type FSWatcher } from 'fs'
import { access, cp, mkdir, readdir, readFile, rename, stat, writeFile } from 'fs/promises'
import { autoUpdater } from 'electron-updater'
import * as pty from 'node-pty'
import {
  commitGitChanges,
  discardUnstagedGitChanges,
  getGitBranches,
  getGitFileBase,
  getGitHistory,
  getGitRepoRoot,
  getGitStatus,
  pushGitBranch,
  revertGitPaths,
  stageGitPaths,
  switchGitBranch,
  unstageGitPaths,
} from './git'

function createWindow(): void {
  const win = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 800,
    minHeight: 600,
    show: false,
    ...(process.platform !== 'darwin'
      ? {
          frame: false,
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
  win.on('maximize', () => sendWindowState(win))
  win.on('unmaximize', () => sendWindowState(win))
  win.on('enter-full-screen', () => sendWindowState(win))
  win.on('leave-full-screen', () => sendWindowState(win))

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

function getWindowState(win: BrowserWindow): { isMaximized: boolean; isFullScreen: boolean } {
  return {
    isMaximized: win.isMaximized(),
    isFullScreen: win.isFullScreen(),
  }
}

function sendWindowState(win: BrowserWindow): void {
  if (win.isDestroyed()) return
  win.webContents.send('window:state-changed', getWindowState(win))
}

function getRequestWindow(event: Electron.IpcMainInvokeEvent): BrowserWindow | null {
  const win = BrowserWindow.fromWebContents(event.sender)
  if (!win || win.isDestroyed()) return null
  return win
}

function sendMenuCommand(win: Electron.BaseWindow | null, command: string): void {
  if (!win || win.isDestroyed()) return
  const browserWindow = BrowserWindow.fromId(win.id)
  if (!browserWindow || browserWindow.isDestroyed()) return
  browserWindow.webContents.send('app-menu:command', command)
}

function zoomFocusedWindowIn(win: Electron.BaseWindow | null): void {
  if (!win || win.isDestroyed()) return
  const browserWindow = BrowserWindow.fromId(win.id)
  if (!browserWindow || browserWindow.isDestroyed()) return
  browserWindow.webContents.setZoomLevel(browserWindow.webContents.getZoomLevel() + 0.5)
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
        {
          label: 'Zoom In',
          accelerator: 'CmdOrCtrl+=',
          click: (_, win) => zoomFocusedWindowIn(win ?? BrowserWindow.getFocusedWindow()),
        },
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

type SpecialistActionId =
  | 'architect'
  | 'developer'
  | 'devops-infra'
  | 'qa-test'
  | 'security-review'
  | 'frontend-design-review'
  | 'code-review'

type SpecialistPromptResult =
  | { ok: true; prompt: string; path: string }
  | { ok: false; message: string; path: string | null }

const specialistPromptFiles: Record<SpecialistActionId, string> = {
  architect: 'architect-prompt.md',
  developer: 'developer-prompt.md',
  'devops-infra': 'devops-infra-prompt.md',
  'frontend-design-review': 'frontend-design-promt.md',
  'qa-test': 'qa-test-prompt.md',
  'security-review': 'security-review-prompt.md',
  'code-review': 'code-reviewer-pre-prompt.md',
}

function getSpecialistPromptCandidates(fileName: string): string[] {
  return [
    join(process.cwd(), 'specialist-prompts', fileName),
    join(app.getAppPath(), 'specialist-prompts', fileName),
    join(__dirname, '..', '..', 'specialist-prompts', fileName),
    join(__dirname, '..', '..', '..', 'specialist-prompts', fileName),
  ]
}

async function readSpecialistPrompt(specialistId: SpecialistActionId): Promise<SpecialistPromptResult> {
  const fileName = specialistPromptFiles[specialistId]
  if (!fileName) {
    return {
      ok: false,
      message: `Unknown specialist prompt: ${specialistId}`,
      path: null,
    }
  }

  const candidates = getSpecialistPromptCandidates(fileName)

  for (const candidate of candidates) {
    try {
      return { ok: true, prompt: await readFile(candidate, 'utf-8'), path: candidate }
    } catch {
      // Try the next likely app/dev path before reporting a recoverable missing prompt.
    }
  }

  return {
    ok: false,
    message: `Prompt file missing: specialist-prompts/${fileName}`,
    path: candidates[0] ?? null,
  }
}

// ── Claude Code CLI Terminal IPC ──────────────────────────────────────────────

type TerminalSize = {
  cols: number
  rows: number
}

type TerminalSession = {
  process: pty.IPty
  sender: Electron.WebContents
  isReady: boolean
  hasExited: boolean
  isDisposed: boolean
  outputBuffer: string
  pendingResize?: TerminalSize
}

const TERMINAL_REPLAY_BUFFER_LIMIT = 2 * 1024 * 1024
const terminals = new Map<string, TerminalSession>()
const fileWatchers = new Map<string, { watcher: FSWatcher; senderId: number }>()
const trackedWatcherSenders = new Set<number>()
let nextFileWatcherId = 0

type AgentCli = 'codex' | 'claude'
type CliRuntimeSettings = {
  command: string
  useWsl: boolean
}

type TerminalSpawnPayload = {
  sessionId: string
  cols: number
  rows: number
  cwd?: string
  resume?: boolean
  swarmStatePath?: string
  cli?: AgentCli
  initialPrompt?: string
  cliRuntimes?: Partial<Record<AgentCli, Partial<CliRuntimeSettings>>>
  shellOnly?: boolean
}

type ShellLaunchConfig = {
  command: string
  args: string[]
  cwd?: string
  initialInput?: string
  env?: Record<string, string>
}

function getTerminalEnv(): Record<string, string> {
  const env = Object.fromEntries(
    Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === 'string')
  )

  delete env.ELECTRON_RUN_AS_NODE
  env.TERM = env.TERM || 'xterm-256color'

  return env
}

function withSwarmEnv(
  env: Record<string, string>,
  cwd: string,
  swarmStatePath?: string
): Record<string, string> {
  return {
    ...env,
    SWARM_REPO_TOOL_PATH: join(cwd, '.agents', 'skills', 'swarm-kanban', 'scripts', 'swarm_tool.py'),
    SWARM_REPO_WRAPPER_PATH: join(cwd, 'scripts', 'swarm_tool.py'),
    ...(swarmStatePath ? { SWARM_STATE_PATH: swarmStatePath } : {}),
  }
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

function toWindowsPath(dirPath: string): string {
  const normalized = dirPath.replace(/\\/g, '/')
  const wslMatch = normalized.match(/^\/mnt\/([A-Za-z])\/(.*)$/)

  if (!wslMatch) {
    return dirPath
  }

  const [, drive, rest] = wslMatch
  return `${drive.toUpperCase()}:\\${rest.replace(/\//g, '\\')}`
}

function isNativeWindowsPath(dirPath: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(dirPath) || /^\\\\/.test(dirPath)
}

function quotePosix(value: string): string {
  return `'${value.replace(/'/g, `'\"'\"'`)}'`
}

function quotePosixCommand(value: string): string {
  return /^[A-Za-z0-9._/-]+$/.test(value) ? value : quotePosix(value)
}

function quoteCmd(value: string): string {
  return `"${value.replace(/"/g, '""')}"`
}

function quoteCmdIfNeeded(value: string): string {
  return /[\s&()^|<>"]/g.test(value) ? quoteCmd(value) : value
}

function getCliRuntimeSettings(
  cli: AgentCli,
  cliRuntimes?: Partial<Record<AgentCli, Partial<CliRuntimeSettings>>>
): CliRuntimeSettings {
  return {
    command: cliRuntimes?.[cli]?.command?.trim() || cli,
    useWsl: Boolean(cliRuntimes?.[cli]?.useWsl),
  }
}

function getBundledSwarmToolPath(): string | null {
  const candidates = [
    join(process.cwd(), '.agents', 'skills', 'swarm-kanban', 'scripts', 'swarm_tool.py'),
    join(app.getAppPath(), '.agents', 'skills', 'swarm-kanban', 'scripts', 'swarm_tool.py'),
    join(__dirname, '..', '..', '.agents', 'skills', 'swarm-kanban', 'scripts', 'swarm_tool.py'),
    join(__dirname, '..', '..', '..', '.agents', 'skills', 'swarm-kanban', 'scripts', 'swarm_tool.py'),
  ]

  return candidates.find((candidate) => existsSync(candidate)) ?? null
}

function buildSwarmShellBootstrap(swarmStatePath?: string): string {
  const shellStatePath =
    swarmStatePath && process.platform === 'win32' ? toWslPath(swarmStatePath) : swarmStatePath
  const bundledToolPath = getBundledSwarmToolPath()
  const shellBundledToolPath =
    bundledToolPath && process.platform === 'win32' ? toWslPath(bundledToolPath) : bundledToolPath
  const stateArg = shellStatePath ? `--state ${quotePosix(shellStatePath)}` : ''
  const lines = [
    'export SWARM_REPO_TOOL_PATH="$PWD/.agents/skills/swarm-kanban/scripts/swarm_tool.py"',
    'export SWARM_REPO_WRAPPER_PATH="$PWD/scripts/swarm_tool.py"',
  ]

  if (shellStatePath) {
    lines.push(`export SWARM_STATE_PATH=${quotePosix(shellStatePath)}`)
  }

  if (shellBundledToolPath) {
    lines.push(`export MULTICODE_SWARM_TOOL_PATH=${quotePosix(shellBundledToolPath)}`)
  }

  lines.push(
    [
      'swarm() {',
      'local tool_path="";',
      'if [ -f "$SWARM_REPO_WRAPPER_PATH" ]; then tool_path="$SWARM_REPO_WRAPPER_PATH";',
      'elif [ -f "$SWARM_REPO_TOOL_PATH" ]; then tool_path="$SWARM_REPO_TOOL_PATH";',
      'elif [ -n "${MULTICODE_SWARM_TOOL_PATH:-}" ] && [ -f "$MULTICODE_SWARM_TOOL_PATH" ]; then tool_path="$MULTICODE_SWARM_TOOL_PATH";',
      'else echo "swarm tool not found" >&2; return 127; fi;',
      `python3 "$tool_path" ${stateArg} "$@";`,
      '}',
    ].join(' '),
    'export -f swarm >/dev/null 2>&1 || true',
  )

  return lines.join('; ')
}

function buildUserShellStartup(): string {
  return [
    'for profile in "$HOME/.bash_profile" "$HOME/.bash_login" "$HOME/.profile"; do [ -r "$profile" ] && . "$profile" && break; done',
    '[ -r "$HOME/.bashrc" ] && . "$HOME/.bashrc"',
    '[ -d "$HOME/.npm-global/bin" ] && export PATH="$HOME/.npm-global/bin:$PATH"',
  ].join('; ')
}

function buildWslShellScript(
  cwd: string,
  sessionId: string,
  resume = false,
  swarmStatePath?: string,
  cli: AgentCli = 'codex',
  initialPrompt?: string,
  cliRuntime?: CliRuntimeSettings
): string {
  return [
    buildUserShellStartup(),
    `cd ${quotePosix(toWslPath(cwd))}`,
    buildSwarmShellBootstrap(swarmStatePath),
    buildAgentLaunchCommand(cli, sessionId, resume, initialPrompt, cliRuntime),
    'exec bash -li',
  ].join('; ')
}

function getShellLaunchConfig(
  cwd: string,
  sessionId: string,
  resume = false,
  swarmStatePath?: string,
  cli: AgentCli = 'codex',
  initialPrompt?: string,
  cliRuntimes?: Partial<Record<AgentCli, Partial<CliRuntimeSettings>>>
): ShellLaunchConfig {
  const cliRuntime = getCliRuntimeSettings(cli, cliRuntimes)

  if (process.platform === 'win32' && !cliRuntime.useWsl) {
    const windowsCwd = toWindowsPath(cwd)
    const windowsStatePath = swarmStatePath ? toWindowsPath(swarmStatePath) : undefined
    if (!isNativeWindowsPath(windowsCwd)) {
      throw new Error(
        `Workspace path "${cwd}" is not available as a Windows path. Turn on "Run through WSL" for ${cli}.`
      )
    }
    const commandLine = buildNativeAgentLaunchCommand(
      cli,
      sessionId,
      resume,
      windowsCwd,
      initialPrompt,
      cliRuntime
    )

    return {
      command: 'cmd.exe',
      args: ['/d', '/k', commandLine],
      env: withSwarmEnv(getTerminalEnv(), windowsCwd, windowsStatePath),
      cwd: windowsCwd,
    }
  }

  if (process.platform === 'win32') {
    return {
      command: 'wsl.exe',
      args: [
        '-e',
        'bash',
        '-lic',
        buildWslShellScript(cwd, sessionId, resume, swarmStatePath, cli, initialPrompt, cliRuntime),
      ],
    }
  }

  const shellPath = process.env.SHELL || 'bash'
  const shellName = shellPath.split(/[\\/]/).at(-1)
  const args = shellName === 'bash' || shellName === 'zsh' ? ['-l'] : []

  return {
    command: shellPath,
    args,
    initialInput: `${[buildSwarmShellBootstrap(swarmStatePath), buildAgentLaunchCommand(cli, sessionId, resume, initialPrompt, cliRuntime)].join('; ')}\r`,
  }
}

function getPlainShellLaunchConfig(
  cwd: string,
  swarmStatePath?: string
): ShellLaunchConfig {
  if (process.platform === 'win32') {
    const windowsCwd = toWindowsPath(cwd)
    const windowsStatePath = swarmStatePath ? toWindowsPath(swarmStatePath) : undefined

    if (isNativeWindowsPath(windowsCwd)) {
      return {
        command: 'powershell.exe',
        args: ['-NoLogo'],
        env: withSwarmEnv(getTerminalEnv(), windowsCwd, windowsStatePath),
        cwd: windowsCwd,
      }
    }

    return {
      command: 'wsl.exe',
      args: [
        '-e',
        'bash',
        '-lic',
        [
          buildUserShellStartup(),
          `cd ${quotePosix(toWslPath(cwd))}`,
          buildSwarmShellBootstrap(swarmStatePath),
          'exec bash -li',
        ].join('; '),
      ],
    }
  }

  const shellPath = process.env.SHELL || 'bash'
  const shellName = shellPath.split(/[\\/]/).at(-1)
  const args = shellName === 'bash' || shellName === 'zsh' ? ['-l'] : []

  return {
    command: shellPath,
    args,
    env: withSwarmEnv(getTerminalEnv(), cwd, swarmStatePath),
    cwd,
  }
}

function buildNativeAgentLaunchCommand(
  cli: AgentCli,
  sessionId: string,
  resume: boolean,
  cwd: string,
  initialPrompt: string | undefined,
  cliRuntime: CliRuntimeSettings
): string {
  const command = quoteCmdIfNeeded(cliRuntime.command || cli)

  if (cli === 'codex') {
    const promptArg = initialPrompt ? ` ${quoteCmd(initialPrompt)}` : ''
    return `${command} -C ${quoteCmdIfNeeded(cwd)}${promptArg}`
  }

  const sessionFlag = resume ? '--resume' : '--session-id'
  return `${command} ${sessionFlag} ${quoteCmdIfNeeded(sessionId)}`
}

function buildAgentLaunchCommand(
  cli: AgentCli,
  sessionId: string,
  resume = false,
  initialPrompt?: string,
  cliRuntime?: CliRuntimeSettings
): string {
  if (cli === 'claude') return buildClaudeLaunchCommand(sessionId, resume, cliRuntime)
  return buildCodexLaunchCommand(initialPrompt, cliRuntime)
}

function buildCommandAvailabilityCheck(cli: AgentCli, command: string): string {
  return [
    `if ! command -v ${quotePosixCommand(command)} >/dev/null 2>&1; then`,
    `echo ${quotePosix(`${cli === 'codex' ? 'Codex' : 'Claude'} CLI was not found. Check the ${cli} command in Multicode Settings.`)};`,
    'else',
  ].join(' ')
}

function buildCodexLaunchCommand(
  initialPrompt?: string,
  cliRuntime?: CliRuntimeSettings
): string {
  const promptArg = initialPrompt ? ` ${quotePosix(initialPrompt)}` : ''
  const configuredCommand = cliRuntime?.command?.trim()

  return [
    buildCommandAvailabilityCheck('codex', configuredCommand || 'codex'),
    `${quotePosixCommand(configuredCommand || 'codex')}${promptArg};`,
    'fi',
  ].join(' ')
}

function buildClaudeLaunchCommand(
  sessionId: string,
  resume = false,
  cliRuntime?: CliRuntimeSettings
): string {
  const quotedSessionId = quotePosix(sessionId)
  const claudeCommand = quotePosixCommand(cliRuntime?.command?.trim() || 'claude')
  const configuredCommand = cliRuntime?.command?.trim() || 'claude'

  if (!resume) {
    return [
      buildCommandAvailabilityCheck('claude', configuredCommand),
      `${claudeCommand} --session-id ${quotedSessionId};`,
      'fi',
    ].join(' ')
  }

  // Some panes get a generated session id before the user actually starts a Claude
  // conversation. In that case there is nothing persisted to resume yet, so fall
  // back to starting a fresh session with the same id instead of surfacing the
  // "No conversation found" error on every app launch.
  return [
    buildCommandAvailabilityCheck('claude', configuredCommand),
    `if find "$HOME/.claude/projects" -type f -name ${quotePosix(`${sessionId}.jsonl`)} -print -quit 2>/dev/null | grep -q .; then`,
    `${claudeCommand} --resume ${quotedSessionId};`,
    `else`,
    `${claudeCommand} --session-id ${quotedSessionId};`,
    `fi`,
    'fi',
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
      : 'Agent CLI shell could not be started. Make sure your login shell is available.'
  }

  return error instanceof Error ? error.message : String(error)
}

function getTerminalSize(cols: number, rows: number): TerminalSize {
  return {
    cols: Math.max(Number.isFinite(cols) ? Math.floor(cols) : 80, 20),
    rows: Math.max(Number.isFinite(rows) ? Math.floor(rows) : 24, 8),
  }
}

function safeResizeTerminal(sessionId: string, cols: number, rows: number): void {
  const session = terminals.get(sessionId)
  if (!session || session.hasExited || session.isDisposed) return

  const size = getTerminalSize(cols, rows)
  if (process.platform === 'win32' && !session.isReady) {
    session.pendingResize = size
    return
  }

  try {
    session.process.resize(size.cols, size.rows)
  } catch {
    // node-pty can report resize-after-exit races before its exit event is delivered.
    session.hasExited = true
  }
}

function flushPendingTerminalResize(sessionId: string, session: TerminalSession): void {
  const pendingResize = session.pendingResize
  if (!pendingResize) return

  session.pendingResize = undefined
  safeResizeTerminal(sessionId, pendingResize.cols, pendingResize.rows)
}

function appendTerminalOutput(session: TerminalSession, data: string): void {
  session.outputBuffer += data
  if (session.outputBuffer.length > TERMINAL_REPLAY_BUFFER_LIMIT) {
    session.outputBuffer = session.outputBuffer.slice(-TERMINAL_REPLAY_BUFFER_LIMIT)
  }
}

function disposeTerminal(sessionId: string): void {
  const session = terminals.get(sessionId)
  if (!session) return

  session.isDisposed = true
  session.hasExited = true
  terminals.delete(sessionId)

  try {
    session.process.kill()
  } catch {
    // ignore kill errors if process died first
  }
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

ipcMain.handle('window:minimize', (event) => {
  getRequestWindow(event)?.minimize()
})

ipcMain.handle('window:toggle-maximize', (event) => {
  const win = getRequestWindow(event)
  if (!win) return null

  if (win.isFullScreen()) {
    win.setFullScreen(false)
  } else if (win.isMaximized()) {
    win.unmaximize()
  } else {
    win.maximize()
  }

  return getWindowState(win)
})

ipcMain.handle('window:close', (event) => {
  getRequestWindow(event)?.close()
})

ipcMain.handle('window:get-state', (event) => {
  const win = getRequestWindow(event)
  return win ? getWindowState(win) : null
})

ipcMain.handle(
  'terminal:spawn',
  (event, { sessionId, cols, rows, cwd, resume, swarmStatePath, cli = 'codex', initialPrompt, cliRuntimes, shellOnly }: TerminalSpawnPayload) => {
    const existingSession = terminals.get(sessionId)
    if (existingSession && !existingSession.hasExited && !existingSession.isDisposed) {
      existingSession.sender = event.sender
      safeResizeTerminal(sessionId, cols, rows)
      if (existingSession.outputBuffer) {
        sendTerminalEvent(event.sender, `terminal:data:${sessionId}`, existingSession.outputBuffer)
      }
      return
    }

    disposeTerminal(sessionId)

    try {
      const workingDirectory = cwd || process.cwd()
      const { command, args, cwd: launchCwd, initialInput, env } = shellOnly
        ? getPlainShellLaunchConfig(workingDirectory, swarmStatePath)
        : getShellLaunchConfig(
          workingDirectory,
          sessionId,
          resume,
          swarmStatePath,
          cli,
          initialPrompt,
          cliRuntimes
        )
      const initialSize = getTerminalSize(cols, rows)
      const termProcess = pty.spawn(command, args, {
        name: 'xterm-256color',
        cols: initialSize.cols,
        rows: initialSize.rows,
        cwd: launchCwd ?? workingDirectory,
        env: env ?? getTerminalEnv(),
      })
      const terminalSession: TerminalSession = {
        process: termProcess,
        sender: event.sender,
        isReady: process.platform !== 'win32',
        hasExited: false,
        isDisposed: false,
        outputBuffer: '',
      }

      terminals.set(sessionId, terminalSession)

      termProcess.onData((data) => {
        if (!terminalSession.isReady) {
          terminalSession.isReady = true
          flushPendingTerminalResize(sessionId, terminalSession)
        }
        appendTerminalOutput(terminalSession, data)
        sendTerminalEvent(terminalSession.sender, `terminal:data:${sessionId}`, data)
      })

      termProcess.onExit((e) => {
        terminalSession.hasExited = true
        if (terminals.get(sessionId) === terminalSession) {
          terminals.delete(sessionId)
        }
        if (!terminalSession.isDisposed) {
          sendTerminalEvent(terminalSession.sender, `terminal:exit:${sessionId}`, e.exitCode)
        }
      })

      if (initialInput) {
        // Start the selected agent CLI inside the interactive shell so the user can keep using the terminal afterward.
        termProcess.write(initialInput)
      }
    } catch (error) {
      sendTerminalEvent(event.sender, `terminal:error:${sessionId}`, getTerminalErrorMessage(error))
      sendTerminalEvent(event.sender, `terminal:exit:${sessionId}`, 1)
    }
  }
)

ipcMain.handle('terminal:write', (_, { sessionId, data }: { sessionId: string; data: string }) => {
  const session = terminals.get(sessionId)
  if (!session || session.hasExited || session.isDisposed) return

  try {
    session.process.write(data)
  } catch {
    session.hasExited = true
  }
})

ipcMain.handle('terminal:resize', (_, { sessionId, cols, rows }: { sessionId: string; cols: number; rows: number }) => {
  safeResizeTerminal(sessionId, cols, rows)
})

ipcMain.handle('terminal:kill', (_, sessionId: string) => {
  disposeTerminal(sessionId)
})

// ── File system IPC handlers ──────────────────────────────────────────────────

function isMissingPathError(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')
}

ipcMain.handle('fs:watch-start', async (event, dirPath: string) => {
  if (!trackedWatcherSenders.has(event.sender.id)) {
    trackedWatcherSenders.add(event.sender.id)
    event.sender.once('destroyed', () => {
      trackedWatcherSenders.delete(event.sender.id)
      disposeFileWatchersForSender(event.sender.id)
    })
  }

  if (!(await pathExists(dirPath))) return null

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
    if (isMissingPathError(error)) return null
    if (!recursive) {
      throw error
    }

    try {
      const watcher = createWatcher(false)
      fileWatchers.set(watchId, { watcher, senderId: event.sender.id })
      return watchId
    } catch (fallbackError) {
      if (isMissingPathError(fallbackError)) return null
      throw fallbackError
    }
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

ipcMain.handle('fs:path-exists', async (_, targetPath: string) => {
  return pathExists(targetPath)
})

ipcMain.handle('specialist:read-prompt', async (_, specialistId: SpecialistActionId) => {
  return readSpecialistPrompt(specialistId)
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

ipcMain.handle('fs:ensure-dir', async (_, parentDir: string, name: string) => {
  const dirPath = join(parentDir, name)
  await mkdir(dirPath, { recursive: true })
  return dirPath
})

ipcMain.handle('fs:rename', async (_, sourcePath: string, nextName: string) => {
  const normalizedName = nextName.trim()
  if (!normalizedName || normalizedName === '.' || normalizedName === '..' || /[/\\]/.test(normalizedName)) {
    throw new Error('Enter a valid file or folder name.')
  }

  const targetPath = join(dirname(sourcePath), normalizedName)
  if (targetPath === sourcePath) return targetPath

  if (await pathExists(targetPath)) {
    throw new Error(`A file or folder named "${normalizedName}" already exists.`)
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

ipcMain.handle('fs:delete', async (_, targetPath: string) => {
  await shell.trashItem(targetPath)
})

ipcMain.handle('fs:show-item-in-folder', async (_, targetPath: string) => {
  await access(targetPath)
  shell.showItemInFolder(targetPath)
})

ipcMain.handle('git:get-repo-root', async (_, folderPath: string) => {
  return getGitRepoRoot(folderPath)
})

ipcMain.handle('git:get-status', async (_, repoRoot: string) => {
  return getGitStatus(repoRoot)
})

ipcMain.handle('git:get-file-base', async (_, repoRoot: string, filePath: string) => {
  return getGitFileBase(repoRoot, filePath)
})

ipcMain.handle('git:get-branches', async (_, repoRoot: string) => {
  return getGitBranches(repoRoot)
})

ipcMain.handle('git:get-history', async (_, repoRoot: string, limit?: number) => {
  return getGitHistory(repoRoot, limit)
})

ipcMain.handle('git:stage', async (_, repoRoot: string, paths: string[]) => {
  return stageGitPaths(repoRoot, paths)
})

ipcMain.handle('git:unstage', async (_, repoRoot: string, paths: string[]) => {
  return unstageGitPaths(repoRoot, paths)
})

ipcMain.handle('git:revert', async (_, repoRoot: string, paths: string[]) => {
  return revertGitPaths(repoRoot, paths)
})

ipcMain.handle('git:discard-unstaged', async (_, repoRoot: string, paths: string[]) => {
  return discardUnstagedGitChanges(repoRoot, paths)
})

ipcMain.handle('git:commit', async (_, repoRoot: string, message: string) => {
  return commitGitChanges(repoRoot, message)
})

ipcMain.handle('git:push', async (_, repoRoot: string) => {
  return pushGitBranch(repoRoot)
})

ipcMain.handle('git:switch-branch', async (_, repoRoot: string, branchName: string) => {
  return switchGitBranch(repoRoot, branchName)
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
      process.env['ELECTRON_RENDERER_URL'] ? process.execPath : 'com.multicode'
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
