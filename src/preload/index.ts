import { contextBridge, ipcRenderer } from 'electron'
import { readFile } from 'fs/promises'
import { join } from 'path'

type SaveDialogOptions = Electron.SaveDialogOptions
type OpenDialogOptions = Electron.OpenDialogOptions
type ContextMenuItem = {
  id?: string
  label?: string
  enabled?: boolean
  type?: 'normal' | 'separator'
}
type FileWatchEvent = {
  eventType: string
  path: string | null
}
type AgentCli = 'codex' | 'claude'
type CliRuntimeSettings = {
  command: string
  useWsl: boolean
}
type TerminalKind = 'agent' | 'terminal'
type TerminalSpawnMetadata = {
  kind?: TerminalKind
  workspaceId?: string
  agentId?: string
  terminalId?: string
}
type TerminalSessionSnapshot = {
  sessionId: string
  running: boolean
  kind: TerminalKind
  workspaceId?: string
  agentId?: string
  terminalId?: string
  cli?: AgentCli
  cwd?: string
  swarmStatePath?: string
  startedAt: number
  lastOutputAt: number | null
  outputBufferLength: number
}
type TerminalSpawnResult =
  | { ok: true; sessionId: string }
  | { ok: false; sessionId: string; message: string; exitCode: number }
type SpecialistActionId =
  | 'architect'
  | 'product-strategist'
  | 'developer'
  | 'devops-infra'
  | 'qa-test'
  | 'security-review'
  | 'frontend-design-review'
  | 'code-review'
type SpecialistPromptResult =
  | { ok: true; prompt: string; path: string }
  | { ok: false; message: string; path: string | null }
type GitFileStatus = 'new' | 'modified' | 'deleted' | 'renamed' | 'conflicted'
type GitStatusEntry = {
  path: string
  relativePath: string
  status: GitFileStatus
  staged: boolean
  unstaged: boolean
}
type GitStatusSnapshot = {
  repoRoot: string
  files: Record<string, GitStatusEntry>
  updatedAt: number
}
type GitFileBaseResult =
  | { ok: true; content: string }
  | { ok: false; message: string }
type GitBranch = {
  name: string
  current: boolean
  upstream: string | null
}
type GitBranchSnapshot = {
  current: string | null
  branches: GitBranch[]
  ahead: number
  behind: number
}
type GitCommit = {
  hash: string
  shortHash: string
  author: string
  date: string
  refs: string[]
  subject: string
}
type GitHistorySnapshot = {
  commits: GitCommit[]
  updatedAt: number
}
type GitCommandResult = {
  ok: boolean
  stdout: string
  stderr: string
  message: string | null
}
type DiagnosticLevel = 'info' | 'warning' | 'error'
type DiagnosticSource = 'auth' | 'filesystem' | 'git' | 'swarm' | 'terminal' | 'workspace'
type DiagnosticLogInput = {
  level: DiagnosticLevel
  source: DiagnosticSource
  title: string
  message: string
  details?: string
  workspaceId?: string
  workspaceName?: string
  agentId?: string
  taskId?: string
  sessionId?: string
}
type DiagnosticLogEntry = DiagnosticLogInput & {
  id: string
  timestamp: string
  logPath?: string
}
type WorkspaceFolderCheckResult =
  | { ok: true; status: 'ready'; path: string; checkedPath: string; message: string }
  | {
    ok: false
    status: 'missing' | 'inaccessible' | 'timeout'
    path: string
    checkedPath: string
    message: string
    code?: string
  }
type WindowState = {
  isMaximized: boolean
  isFullScreen: boolean
}
type SwarmArtifactKind =
  | 'architect_plan'
  | 'branding'
  | 'design_notes'
  | 'html_mockup'
  | 'product_strategy'
  | 'requirements'
  | 'security_review'
  | 'validation_report'
type SwarmArtifactStatus =
  | 'approved'
  | 'changes_requested'
  | 'draft'
  | 'ready_for_review'
  | 'superseded'
type SwarmArtifactCommandResult =
  | { ok: true; data: unknown }
  | { ok: false; message: string; stdout?: string; stderr?: string; exitCode?: number | string }
type SwarmArtifactListOptions = {
  taskId?: string
  kind?: SwarmArtifactKind
  status?: SwarmArtifactStatus
}
type SessionUser = {
  id: string
  email: string | null
  displayName: string | null
}
type SessionOrganization = {
  id: string
  name: string
  slug: string
  type: 'personal' | 'team' | 'enterprise'
}
type FeatureValue = boolean | number | string
type EntitlementSnapshot = {
  userId: string
  organizationId: string
  product: 'multicode'
  roles: string[]
  features: Record<string, FeatureValue>
  limits: Record<string, number>
  sources: Record<string, string>
  plan: {
    code: string
    status: string
  }
  issuedAt: string
  expiresAt: string
  schemaVersion: 1
}
type MulticodeAuthState = {
  authenticated: boolean
  user: SessionUser | null
  selectedOrganization: SessionOrganization | null
  entitlements: EntitlementSnapshot | null
  status: 'checking' | 'signed_out' | 'signed_in' | 'error'
  entitlementStatus: 'fresh' | 'offline_grace' | 'expired' | 'missing'
  message: string | null
  lastRefreshAt: string | null
  graceExpiresAt: string | null
}
type PremiumAccessRequest = {
  featureKey: string
  amount?: number
  hostedCost?: boolean
}
type PremiumAccessDecision = {
  allowed: boolean
  featureKey: string
  value: FeatureValue | undefined
  status: 'fresh' | 'offline_grace' | 'expired' | 'signed_out' | 'missing' | 'error'
  message: string
  limit?: number
  graceExpiresAt?: string
}
type UsageRequest = {
  featureKey: string
  amount?: number
  actorType?: 'user' | 'organization' | 'api_key'
  actorId?: string
  idempotencyKey: string
  window?: 'day' | 'month'
}
type UsageResult = {
  allowed: boolean
  featureKey: string
  amount: number
  used: number
  remaining: number | null
  limit: number | null
  idempotencyKey: string
  windowStart: string
  windowEnd: string
  replayed: boolean
  reason: 'allowed' | 'missing_entitlement' | 'limit_exceeded' | 'released'
}
type SessionSnapshot =
  | {
    authenticated: true
    user: SessionUser
    selectedOrganization: SessionOrganization
    session: {
      id: string
      expiresAt: string
    }
  }
  | {
    authenticated: false
    user: null
    selectedOrganization: null
  }

const specialistPromptFiles: Record<SpecialistActionId, string> = {
  architect: 'architect-prompt.md',
  'product-strategist': 'product-strategist-prompt.md',
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
    join(__dirname, '..', '..', 'specialist-prompts', fileName),
    join(__dirname, '..', '..', '..', 'specialist-prompts', fileName),
  ]
}

async function readSpecialistPromptFallback(specialistId: SpecialistActionId): Promise<SpecialistPromptResult> {
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
      // Keep checking the next dev/build prompt path.
    }
  }

  return {
    ok: false,
    message: `Prompt file missing: specialist-prompts/${fileName}`,
    path: candidates[0] ?? null,
  }
}

async function readSpecialistPrompt(specialistId: SpecialistActionId): Promise<SpecialistPromptResult> {
  try {
    return await ipcRenderer.invoke('specialist:read-prompt', specialistId)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (message.includes("No handler registered for 'specialist:read-prompt'")) {
      return readSpecialistPromptFallback(specialistId)
    }
    throw error
  }
}

contextBridge.exposeInMainWorld('api', {
  platform: process.platform,

  // Window chrome
  windowMinimize: () => ipcRenderer.invoke('window:minimize'),
  windowToggleMaximize: (): Promise<WindowState | null> => ipcRenderer.invoke('window:toggle-maximize'),
  windowClose: () => ipcRenderer.invoke('window:close'),
  getWindowState: (): Promise<WindowState | null> => ipcRenderer.invoke('window:get-state'),
  onWindowStateChanged: (cb: (state: WindowState) => void): (() => void) => {
    const ch = 'window:state-changed'
    const handler = (_: Electron.IpcRendererEvent, state: WindowState) => cb(state)
    ipcRenderer.on(ch, handler)
    return () => ipcRenderer.removeListener(ch, handler)
  },
  authGetState: (): Promise<MulticodeAuthState> => ipcRenderer.invoke('auth:get-state'),
  authLogin: (organizationId?: string | null): Promise<{ state: string; authorizationUrl: string }> =>
    ipcRenderer.invoke('auth:login', organizationId),
  authLogout: (): Promise<{ loggedOut: true }> => ipcRenderer.invoke('auth:logout'),
  authRefreshEntitlements: (): Promise<MulticodeAuthState> => ipcRenderer.invoke('auth:refresh-entitlements'),
  authSelectOrganization: (organizationId: string): Promise<{ organizationId: string }> =>
    ipcRenderer.invoke('auth:select-organization', organizationId),
  authOpenUpgrade: (reason?: string): Promise<{ opened: true; url: string }> =>
    ipcRenderer.invoke('auth:open-upgrade', reason),
  authCheckPremiumAccess: (input: PremiumAccessRequest): Promise<PremiumAccessDecision> =>
    ipcRenderer.invoke('auth:check-premium-access', input),
  authGetSession: (): Promise<SessionSnapshot> => ipcRenderer.invoke('auth:get-session'),
  authGetEntitlements: (options?: { forceRefresh?: boolean }): Promise<EntitlementSnapshot> =>
    ipcRenderer.invoke('auth:get-entitlements', options),
  authRequireEntitlement: (input: string | PremiumAccessRequest): Promise<FeatureValue> =>
    ipcRenderer.invoke('auth:require-entitlement', input),
  authCheckUsage: (input: UsageRequest): Promise<UsageResult> =>
    ipcRenderer.invoke('auth:check-usage', input),
  authConsumeUsage: (input: UsageRequest): Promise<UsageResult> =>
    ipcRenderer.invoke('auth:consume-usage', input),
  authReleaseUsage: (input: UsageRequest): Promise<UsageResult> =>
    ipcRenderer.invoke('auth:release-usage', input),
  onAuthStateChanged: (cb: (state: MulticodeAuthState) => void): (() => void) => {
    const ch = 'auth:state-changed'
    const handler = (_: Electron.IpcRendererEvent, state: MulticodeAuthState) => cb(state)
    ipcRenderer.on(ch, handler)
    return () => ipcRenderer.removeListener(ch, handler)
  },
  onAuthCallbackError: (cb: (message: string) => void): (() => void) => {
    const ch = 'auth:callback-error'
    const handler = (_: Electron.IpcRendererEvent, message: string) => cb(message)
    ipcRenderer.on(ch, handler)
    return () => ipcRenderer.removeListener(ch, handler)
  },

  // File system
  readdir:   (path: string)                    => ipcRenderer.invoke('fs:readdir', path),
  readfile:  (path: string)                    => ipcRenderer.invoke('fs:readfile', path),
  pathExists: (path: string)                   => ipcRenderer.invoke('fs:path-exists', path),
  checkWorkspaceFolder: (path: string): Promise<WorkspaceFolderCheckResult> =>
    ipcRenderer.invoke('fs:check-workspace-folder', path),
  logDiagnostic: (input: DiagnosticLogInput): Promise<DiagnosticLogEntry> =>
    ipcRenderer.invoke('diagnostics:log', input),
  openDiagnosticsLogsFolder: (): Promise<{ opened: true; path: string }> =>
    ipcRenderer.invoke('diagnostics:open-logs-folder'),
  readSpecialistPrompt,
  writefile: (path: string, content: string)   => ipcRenderer.invoke('fs:writefile', path, content),
  createFile: (parentDir: string, name: string) => ipcRenderer.invoke('fs:create-file', parentDir, name),
  createDir:  (parentDir: string, name: string) => ipcRenderer.invoke('fs:create-dir', parentDir, name),
  ensureDir:  (parentDir: string, name: string) => ipcRenderer.invoke('fs:ensure-dir', parentDir, name),
  renamePath: (sourcePath: string, nextName: string) => ipcRenderer.invoke('fs:rename', sourcePath, nextName),
  copyPath:   (sourcePath: string, destinationDir: string) => ipcRenderer.invoke('fs:copy', sourcePath, destinationDir),
  deletePath: (targetPath: string) => ipcRenderer.invoke('fs:delete', targetPath),
  showItemInFolder: (targetPath: string) => ipcRenderer.invoke('fs:show-item-in-folder', targetPath),
  watchPath:  async (path: string, cb: (event: FileWatchEvent) => void) => {
    const watchId = await ipcRenderer.invoke('fs:watch-start', path)
    if (!watchId) {
      throw new Error(`Cannot watch missing path: ${path}`)
    }
    const ch = `fs:watch-event:${watchId}`
    const handler = (_: Electron.IpcRendererEvent, event: FileWatchEvent) => cb(event)
    ipcRenderer.on(ch, handler)
    return async () => {
      ipcRenderer.removeListener(ch, handler)
      await ipcRenderer.invoke('fs:watch-stop', watchId)
    }
  },
  openDir:   ()                                => ipcRenderer.invoke('fs:dialog:opendir'),
  saveFile:  (options?: SaveDialogOptions)     => ipcRenderer.invoke('fs:dialog:savefile', options),
  openFile:  (options?: OpenDialogOptions)     => ipcRenderer.invoke('fs:dialog:openfile', options),
  showContextMenu: (items: ContextMenuItem[])  => ipcRenderer.invoke('app:show-context-menu', items),
  showMenubarMenu: (label: string, position?: { x?: number; y?: number }) =>
    ipcRenderer.invoke('app:show-menubar-menu', label, position),
  getGitRepoRoot: (folderPath: string): Promise<string | null> =>
    ipcRenderer.invoke('git:get-repo-root', folderPath),
  getGitStatus: (repoRoot: string): Promise<GitStatusSnapshot> =>
    ipcRenderer.invoke('git:get-status', repoRoot),
  getGitFileBase: (repoRoot: string, filePath: string): Promise<GitFileBaseResult> =>
    ipcRenderer.invoke('git:get-file-base', repoRoot, filePath),
  getGitBranches: (repoRoot: string): Promise<GitBranchSnapshot> =>
    ipcRenderer.invoke('git:get-branches', repoRoot),
  getGitHistory: (repoRoot: string, limit?: number): Promise<GitHistorySnapshot> =>
    ipcRenderer.invoke('git:get-history', repoRoot, limit),
  stageGitPaths: (repoRoot: string, paths: string[]): Promise<GitCommandResult> =>
    ipcRenderer.invoke('git:stage', repoRoot, paths),
  unstageGitPaths: (repoRoot: string, paths: string[]): Promise<GitCommandResult> =>
    ipcRenderer.invoke('git:unstage', repoRoot, paths),
  revertGitPaths: (repoRoot: string, paths: string[]): Promise<GitCommandResult> =>
    ipcRenderer.invoke('git:revert', repoRoot, paths),
  discardUnstagedGitChanges: (repoRoot: string, paths: string[]): Promise<GitCommandResult> =>
    ipcRenderer.invoke('git:discard-unstaged', repoRoot, paths),
  commitGitChanges: (repoRoot: string, message: string): Promise<GitCommandResult> =>
    ipcRenderer.invoke('git:commit', repoRoot, message),
  pushGitBranch: (repoRoot: string): Promise<GitCommandResult> =>
    ipcRenderer.invoke('git:push', repoRoot),
  switchGitBranch: (repoRoot: string, branchName: string): Promise<GitCommandResult> =>
    ipcRenderer.invoke('git:switch-branch', repoRoot, branchName),
  listSwarmArtifacts: (
    statePath: string,
    options?: SwarmArtifactListOptions
  ): Promise<SwarmArtifactCommandResult> =>
    ipcRenderer.invoke('swarm:artifact:list', { statePath, ...options }),
  markSwarmArtifactReady: (
    statePath: string,
    artifactId: string,
    actorId: string
  ): Promise<SwarmArtifactCommandResult> =>
    ipcRenderer.invoke('swarm:artifact:ready', { statePath, artifactId, actorId }),
  approveSwarmArtifact: (
    statePath: string,
    artifactId: string,
    actorId: string
  ): Promise<SwarmArtifactCommandResult> =>
    ipcRenderer.invoke('swarm:artifact:approve', { statePath, artifactId, actorId }),
  requestSwarmArtifactChanges: (
    statePath: string,
    artifactId: string,
    actorId: string,
    feedback: string
  ): Promise<SwarmArtifactCommandResult> =>
    ipcRenderer.invoke('swarm:artifact:request-changes', { statePath, artifactId, actorId, feedback }),
  openSwarmArtifact: (
    statePath: string,
    artifactPath: string
  ): Promise<SwarmArtifactCommandResult> =>
    ipcRenderer.invoke('swarm:artifact:open', { statePath, artifactPath }),

  // Agent CLI Terminal
  terminalSpawn:  (sessionId: string, cols: number, rows: number, cwd?: string, resume?: boolean, swarmStatePath?: string, cli?: AgentCli, initialPrompt?: string, cliRuntimes?: Partial<Record<AgentCli, Partial<CliRuntimeSettings>>>, shellOnly?: boolean, metadata?: TerminalSpawnMetadata): Promise<TerminalSpawnResult> => ipcRenderer.invoke('terminal:spawn', { sessionId, cols, rows, cwd, resume, swarmStatePath, cli, initialPrompt, cliRuntimes, shellOnly, ...metadata }),
  terminalWrite:  (sessionId: string, data: string) => ipcRenderer.invoke('terminal:write', { sessionId, data }),
  terminalResize: (sessionId: string, cols: number, rows: number) => ipcRenderer.invoke('terminal:resize', { sessionId, cols, rows }),
  terminalStatus: (sessionId: string): Promise<{ running: boolean }> => ipcRenderer.invoke('terminal:status', sessionId),
  terminalList:   (): Promise<TerminalSessionSnapshot[]> => ipcRenderer.invoke('terminal:list'),
  terminalKill:   (sessionId: string) => ipcRenderer.invoke('terminal:kill', sessionId),

  onTerminalData: (sessionId: string, cb: (data: string) => void): (() => void) => {
    const ch = `terminal:data:${sessionId}`
    const handler = (_: Electron.IpcRendererEvent, data: string) => cb(data)
    ipcRenderer.on(ch, handler)
    return () => ipcRenderer.removeListener(ch, handler)
  },

  onTerminalExit: (sessionId: string, cb: (code: number) => void): (() => void) => {
    const ch = `terminal:exit:${sessionId}`
    const handler = (_: Electron.IpcRendererEvent, code: number) => cb(code)
    ipcRenderer.once(ch, handler)
    return () => ipcRenderer.removeListener(ch, handler)
  },

  onTerminalError: (sessionId: string, cb: (message: string) => void): (() => void) => {
    const ch = `terminal:error:${sessionId}`
    const handler = (_: Electron.IpcRendererEvent, message: string) => cb(message)
    ipcRenderer.on(ch, handler)
    return () => ipcRenderer.removeListener(ch, handler)
  },

  onAppMenuCommand: (cb: (command: string) => void): (() => void) => {
    const ch = 'app-menu:command'
    const handler = (_: Electron.IpcRendererEvent, command: string) => cb(command)
    ipcRenderer.on(ch, handler)
    return () => ipcRenderer.removeListener(ch, handler)
  },
})
