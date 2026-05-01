/// <reference types="vite/client" />

type SaveDialogOptions = {
  title?: string
  defaultPath?: string
  filters?: { name: string; extensions: string[] }[]
}

type OpenDialogOptions = {
  title?: string
  defaultPath?: string
  filters?: { name: string; extensions: string[] }[]
}

interface ContextMenuItem {
  id?: string
  label?: string
  enabled?: boolean
  type?: 'normal' | 'separator'
}

interface FileWatchEvent {
  eventType: string
  path: string | null
}

type FileSearchEntry = {
  name: string
  path: string
  parentPath: string
  isDir: false
}
type FileSearchResult =
  | {
      ok: true
      results: FileSearchEntry[]
      truncated: boolean
      engine: 'ripgrep'
      elapsedMs: number
      resultCount: number
    }
  | {
      ok: false
      message: string
      engine: 'ripgrep' | null
    }

type ContentSearchEntry = {
  name: string
  path: string
  parentPath: string
  lineNumber: number
  column: number
  lineText: string
  matchText: string
}
type ContentSearchResult =
  | {
      ok: true
      results: ContentSearchEntry[]
      truncated: boolean
      engine: 'ripgrep'
      elapsedMs: number
      resultCount: number
    }
  | {
      ok: false
      message: string
      engine: 'ripgrep' | null
    }

type AgentCli = 'codex' | 'claude'
type AgentExecutionMode = 'current_workspace' | 'worktree'
type SwarmCliPermissionPreset = 'default' | 'auto_workspace' | 'bypass_all'
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
  executionMode?: AgentExecutionMode
  worktreeId?: string
  worktreePath?: string
  cliPermissionPreset?: SwarmCliPermissionPreset
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
  executionMode?: AgentExecutionMode
  worktreeId?: string
  worktreePath?: string
  startedAt: number
  lastOutputAt: number | null
  outputBufferLength: number
  retainedOutputBytes: number
}
type TerminalSpawnResult =
  | { ok: true; sessionId: string }
  | { ok: false; sessionId: string; message: string; exitCode: number }
type SpecialistActionId =
  | 'architect'
  | 'product-strategist'
  | 'developer'
  | 'devops-infra'
  | 'performance'
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
  commitWebUrl: string | null
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
type GitWorktreeEntry = {
  path: string
  head: string | null
  branch: string | null
  branchRef: string | null
  detached: boolean
  bare: boolean
  locked: boolean
  lockedReason: string | null
  prunable: boolean
  prunableReason: string | null
}
type GitWorktreeListSnapshot = {
  repoRoot: string
  worktrees: GitWorktreeEntry[]
  updatedAt: number
}
type GitWorktreeCopyIncludedResult = {
  copied: string[]
  skipped: { path: string; reason: string }[]
}
type GitWorktreeOperationResult<T> =
  | { ok: true; data: T; message: string | null; stdout?: string; stderr?: string }
  | { ok: false; message: string; stdout?: string; stderr?: string }
type GitWorktreeCreateInput = {
  repoRoot: string
  containerPath: string
  destinationPath: string
  branchName: string
  baseRef: string
  copyIncludedFiles?: boolean
}
type GitWorktreeRemoveInput = {
  repoRoot: string
  path: string
  force?: boolean
}
type GitWorktreeRepairInput = {
  repoRoot: string
  path?: string
}
type GitWorktreeCopyIncludedInput = {
  repoRoot: string
  worktreePath: string
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
type SwarmArtifactCommandResult =
  | { ok: true; data: unknown }
  | { ok: false; message: string; stdout?: string; stderr?: string; exitCode?: number | string }
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

declare interface Window {
  api: {
    platform: string

    // Window chrome
    windowMinimize: () => Promise<void>
    windowToggleMaximize: () => Promise<WindowState | null>
    windowClose: () => Promise<void>
    getWindowState: () => Promise<WindowState | null>
    onWindowStateChanged: (cb: (state: WindowState) => void) => () => void
    authGetState: () => Promise<MulticodeAuthState>
    authLogin: (organizationId?: string | null) => Promise<{ state: string; authorizationUrl: string }>
    authLogout: () => Promise<{ loggedOut: true }>
    authRefreshEntitlements: () => Promise<MulticodeAuthState>
    authSelectOrganization: (organizationId: string) => Promise<{ organizationId: string }>
    authOpenUpgrade: (reason?: string) => Promise<{ opened: true; url: string }>
    authCheckPremiumAccess: (input: PremiumAccessRequest) => Promise<PremiumAccessDecision>
    authGetSession: () => Promise<SessionSnapshot>
    authGetEntitlements: (options?: { forceRefresh?: boolean }) => Promise<EntitlementSnapshot>
    authRequireEntitlement: (input: string | PremiumAccessRequest) => Promise<FeatureValue>
    authCheckUsage: (input: UsageRequest) => Promise<UsageResult>
    authConsumeUsage: (input: UsageRequest) => Promise<UsageResult>
    authReleaseUsage: (input: UsageRequest) => Promise<UsageResult>
    onAuthStateChanged: (cb: (state: MulticodeAuthState) => void) => () => void
    onAuthCallbackError: (cb: (message: string) => void) => () => void

    // File system
    readdir:   (path: string) => Promise<{ name: string; isDir: boolean }[]>
    searchFiles: (rootPath: string, query: string, options?: { limit?: number; excludes?: string[] }) => Promise<FileSearchResult>
    searchContent: (rootPath: string, query: string, options?: { limit?: number; excludes?: string[] }) => Promise<ContentSearchResult>
    cancelContentSearch: () => Promise<void>
    readfile:  (path: string) => Promise<string>
    pathExists: (path: string) => Promise<boolean>
    checkWorkspaceFolder: (path: string) => Promise<WorkspaceFolderCheckResult>
    logDiagnostic: (input: DiagnosticLogInput) => Promise<DiagnosticLogEntry>
    openDiagnosticsLogsFolder: () => Promise<{ opened: true; path: string }>
    readSpecialistPrompt: (specialistId: SpecialistActionId) => Promise<SpecialistPromptResult>
    writefile: (path: string, content: string) => Promise<void>
    createFile: (parentDir: string, name: string) => Promise<string>
    createDir: (parentDir: string, name: string) => Promise<string>
    ensureDir: (parentDir: string, name: string) => Promise<string>
    renamePath: (sourcePath: string, nextName: string) => Promise<string>
    copyPath: (sourcePath: string, destinationDir: string) => Promise<string>
    deletePath: (targetPath: string) => Promise<void>
    showItemInFolder: (targetPath: string) => Promise<void>
    watchPath: (path: string, cb: (event: FileWatchEvent) => void) => Promise<() => Promise<void>>
    openDir:   () => Promise<string | null>
    saveFile:  (options?: SaveDialogOptions) => Promise<string | null>
    openFile:  (options?: OpenDialogOptions) => Promise<string | null>
    showContextMenu: (items: ContextMenuItem[]) => Promise<string | null>
    showMenubarMenu: (label: string, position?: { x?: number; y?: number }) => Promise<boolean>
    getGitRepoRoot: (folderPath: string) => Promise<string | null>
    getGitStatus: (repoRoot: string) => Promise<GitStatusSnapshot>
    getGitFileBase: (repoRoot: string, filePath: string) => Promise<GitFileBaseResult>
    getGitBranches: (repoRoot: string) => Promise<GitBranchSnapshot>
    getGitHistory: (repoRoot: string, limit?: number) => Promise<GitHistorySnapshot>
    stageGitPaths: (repoRoot: string, paths: string[]) => Promise<GitCommandResult>
    unstageGitPaths: (repoRoot: string, paths: string[]) => Promise<GitCommandResult>
    revertGitPaths: (repoRoot: string, paths: string[]) => Promise<GitCommandResult>
    discardUnstagedGitChanges: (repoRoot: string, paths: string[]) => Promise<GitCommandResult>
    commitGitChanges: (repoRoot: string, message: string) => Promise<GitCommandResult>
    pushGitBranch: (repoRoot: string) => Promise<GitCommandResult>
    switchGitBranch: (repoRoot: string, branchName: string) => Promise<GitCommandResult>
    listGitWorktrees: (repoRoot: string) => Promise<GitWorktreeOperationResult<GitWorktreeListSnapshot>>
    createGitWorktree: (input: GitWorktreeCreateInput) => Promise<GitWorktreeOperationResult<GitWorktreeEntry>>
    removeGitWorktree: (input: GitWorktreeRemoveInput) => Promise<GitWorktreeOperationResult<GitCommandResult>>
    pruneGitWorktrees: (repoRoot: string) => Promise<GitWorktreeOperationResult<GitCommandResult>>
    repairGitWorktrees: (input: GitWorktreeRepairInput) => Promise<GitWorktreeOperationResult<GitCommandResult>>
    copyGitWorktreeIncludedFiles: (
      input: GitWorktreeCopyIncludedInput
    ) => Promise<GitWorktreeOperationResult<GitWorktreeCopyIncludedResult>>
    openSwarmArtifact: (
      statePath: string,
      artifactPath: string
    ) => Promise<SwarmArtifactCommandResult>
    approveSwarmArtifact: (
      statePath: string,
      artifactId: string
    ) => Promise<SwarmArtifactCommandResult>
    autoApproveSwarmArtifact: (
      statePath: string,
      artifactId: string
    ) => Promise<SwarmArtifactCommandResult>
    requestSwarmArtifactChanges: (
      statePath: string,
      artifactId: string,
      feedback: string
    ) => Promise<SwarmArtifactCommandResult>

    // Agent CLI Terminal
    terminalSpawn:  (sessionId: string, cols: number, rows: number, cwd?: string, resume?: boolean, swarmStatePath?: string, cli?: AgentCli, initialPrompt?: string, cliRuntimes?: Partial<Record<AgentCli, Partial<CliRuntimeSettings>>>, shellOnly?: boolean, metadata?: TerminalSpawnMetadata) => Promise<TerminalSpawnResult>
    terminalWrite:  (sessionId: string, data: string) => Promise<void>
    terminalResize: (sessionId: string, cols: number, rows: number) => Promise<void>
    terminalStatus: (sessionId: string) => Promise<{ running: boolean }>
    terminalList:   () => Promise<TerminalSessionSnapshot[]>
    terminalKill:   (sessionId: string) => Promise<void>

    onTerminalData: (sessionId: string, cb: (data: string) => void) => () => void
    onTerminalExit: (sessionId: string, cb: (code: number) => void) => () => void
    onTerminalError: (sessionId: string, cb: (message: string) => void) => () => void
    onTerminalSessionsChanged: (cb: (sessions: TerminalSessionSnapshot[]) => void) => () => void
    onAppMenuCommand: (cb: (command: string) => void) => () => void
  }
}
