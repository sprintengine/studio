export type SaveDialogOptions = {
  title?: string
  defaultPath?: string
  filters?: { name: string; extensions: string[] }[]
}

export type OpenDialogOptions = {
  title?: string
  defaultPath?: string
  filters?: { name: string; extensions: string[] }[]
}

export interface ContextMenuItem {
  id?: string
  label?: string
  enabled?: boolean
  type?: 'normal' | 'separator'
}

export interface FileWatchEvent {
  eventType: string
  path: string | null
}

export type FileSearchEntry = {
  name: string
  path: string
  parentPath: string
  isDir: false
}

export type FileSearchResult =
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

export type ContentSearchEntry = {
  name: string
  path: string
  parentPath: string
  lineNumber: number
  column: number
  lineText: string
  matchText: string
}

export type ContentSearchResult =
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

export type MemoryGraphNodeKind = 'markdown' | 'image' | 'text' | 'asset'

export type MemoryGraphNode = {
  id: string
  path: string
  relativePath: string
  name: string
  kind: MemoryGraphNodeKind
  extension: string
  sizeBytes: number
  degree: number
  group: string
}

export type MemoryGraphEdge = {
  id: string
  source: string
  target: string
  sourcePath: string
  targetPath: string
}

export type MemoryUnresolvedLink = {
  sourcePath: string
  href: string
  resolvedRelativePath: string | null
  reason: 'missing' | 'outside-root'
}

export type MemoryRootStatus =
  | { ok: true; rootPath: string; relativeRoot: string }
  | {
      ok: false
      status: 'missing-workspace' | 'invalid-relative-path' | 'missing-memory-root' | 'inaccessible'
      relativeRoot: string | null
      message: string
    }

export type MemoryGraphIndexResult =
  | {
      ok: true
      rootPath: string
      relativeRoot: string
      nodes: MemoryGraphNode[]
      edges: MemoryGraphEdge[]
      groups: string[]
      unresolvedLinks: MemoryUnresolvedLink[]
      indexedAt: number
    }
  | Extract<MemoryRootStatus, { ok: false }>

export type MemoryPreviewResult =
  | { ok: true; node: MemoryGraphNode; previewKind: 'markdown' | 'text'; content: string }
  | { ok: true; node: MemoryGraphNode; previewKind: 'image'; dataUrl: string }
  | { ok: true; node: MemoryGraphNode; previewKind: 'unsupported'; message: string }
  | { ok: false; message: string }

export type AgentCli = 'codex' | 'claude'
export type AgentExecutionMode = 'current_workspace' | 'worktree'
export type SwarmCliPermissionPreset = 'default' | 'auto_workspace' | 'bypass_all'

export type CliRuntimeSettings = {
  command: string
  useWsl: boolean
}

export type TerminalKind = 'agent' | 'terminal'

export type TerminalSpawnMetadata = {
  kind?: TerminalKind
  workspaceId?: string
  agentId?: string
  terminalId?: string
  executionMode?: AgentExecutionMode
  worktreeId?: string
  worktreePath?: string
  cliPermissionPreset?: SwarmCliPermissionPreset
  memoryRootPath?: string
  memoryRelativeRoot?: string
}

export type TerminalSessionSnapshot = {
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

export type TerminalSpawnResult =
  | { ok: true; sessionId: string }
  | { ok: false; sessionId: string; message: string; exitCode: number }

export type SpecialistActionId =
  | 'architect'
  | 'product-strategist'
  | 'developer'
  | 'devops-infra'
  | 'performance'
  | 'qa-test'
  | 'security-review'
  | 'frontend-design-review'
  | 'code-review'

export type SoulPromptResult =
  | { ok: true; prompt: string; path: string }
  | { ok: false; message: string; path: string | null }

export type MultiloopRole =
  | 'coordinator'
  | 'architect'
  | 'product'
  | 'developer'
  | 'frontend'
  | 'tester'
  | 'security'
  | 'code_reviewer'
  | 'performance'

export type GitFileStatus = 'new' | 'modified' | 'deleted' | 'renamed' | 'conflicted'

export type GitStatusEntry = {
  path: string
  relativePath: string
  status: GitFileStatus
  staged: boolean
  unstaged: boolean
}

export type GitStatusSnapshot = {
  repoRoot: string
  files: Record<string, GitStatusEntry>
  updatedAt: number
}

export type GitFileBaseResult =
  | { ok: true; content: string }
  | { ok: false; message: string }

export type GitBranch = {
  name: string
  current: boolean
  upstream: string | null
}

export type GitBranchSnapshot = {
  current: string | null
  branches: GitBranch[]
  ahead: number
  behind: number
}

export type GitCommit = {
  hash: string
  shortHash: string
  author: string
  date: string
  refs: string[]
  subject: string
  commitWebUrl: string | null
}

export type GitRef = {
  name: string
  hash: string
  type: 'head' | 'remote' | 'tag' | 'other'
}

export type GitHistorySnapshot = {
  commits: GitCommit[]
  refs: GitRef[]
  totalCount: number
  updatedAt: number
}

export type GitCommandResult = {
  ok: boolean
  stdout: string
  stderr: string
  message: string | null
}

export type GitWorktreeEntry = {
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

export type GitWorktreeListSnapshot = {
  repoRoot: string
  worktrees: GitWorktreeEntry[]
  updatedAt: number
}

export type GitWorktreeCopyIncludedResult = {
  copied: string[]
  skipped: { path: string; reason: string }[]
}

export type GitWorktreeOperationResult<T> =
  | { ok: true; data: T; message: string | null; stdout?: string; stderr?: string }
  | { ok: false; message: string; stdout?: string; stderr?: string }

export type GitWorktreeCreateInput = {
  repoRoot: string
  containerPath: string
  destinationPath: string
  branchName: string
  baseRef: string
  copyIncludedFiles?: boolean
}

export type GitWorktreeRemoveInput = {
  repoRoot: string
  path: string
  force?: boolean
}

export type GitWorktreeRepairInput = {
  repoRoot: string
  path?: string
}

export type GitWorktreeCopyIncludedInput = {
  repoRoot: string
  worktreePath: string
}

export type GitConflictFile = {
  path: string
  relativePath: string
  status: string
}

export type GitConflictSnapshot = {
  repoRoot: string
  files: GitConflictFile[]
  updatedAt: number
}

export type GitConflictFileContent = {
  path: string
  relativePath: string
  base: string | null
  ours: string | null
  theirs: string | null
  result: string
}

export type DiagnosticLevel = 'info' | 'warning' | 'error'
export type DiagnosticSource = 'auth' | 'filesystem' | 'git' | 'sprintengine' | 'terminal' | 'update' | 'workspace'

export type DiagnosticLogInput = {
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

export type DiagnosticLogEntry = DiagnosticLogInput & {
  id: string
  timestamp: string
  logPath?: string
}

export type WorkspaceFolderCheckResult =
  | { ok: true; status: 'ready'; path: string; checkedPath: string; message: string }
  | {
      ok: false
      status: 'missing' | 'inaccessible' | 'timeout'
      path: string
      checkedPath: string
      message: string
      code?: string
    }

export type WindowState = {
  isMaximized: boolean
  isFullScreen: boolean
}

export type AppUpdateStatus =
  | 'idle'
  | 'checking'
  | 'available'
  | 'downloading'
  | 'downloaded'
  | 'not_available'
  | 'error'

export type AppUpdateChannel = 'dev' | 'preview' | 'stable'

export type AppUpdateProgress = {
  percent: number
  transferred: number
  total: number
  bytesPerSecond: number
}

export type AppUpdateState = {
  status: AppUpdateStatus
  version: string
  channel: AppUpdateChannel
  packaged: boolean
  updateVersion: string | null
  releaseName: string | null
  releaseNotes: string | null
  releaseNotesUrl: string | null
  downloaded: boolean
  progress: AppUpdateProgress | null
  errorMessage: string | null
  lastCheckedAt: string | null
}

export type AppUpdateCheckResult =
  | { ok: true; state: AppUpdateState; message: string }
  | { ok: false; state: AppUpdateState; message: string }

export type SwarmArtifactCommandResult =
  | { ok: true; data: unknown }
  | { ok: false; message: string; stdout?: string; stderr?: string; exitCode?: number | string }

export type MultiloopInitInput = {
  workspaceRoot: string
  loopName: string
  finalGoal: string
}

export type MultiloopInitResult =
  | {
      ok: true
      data: {
        workspaceRoot: string
        loopName: string
        loopSlug: string
        loopDirectory: string
        statePath: string
        created: boolean
      }
    }
  | { ok: false; message: string; stdout?: string; stderr?: string; exitCode?: number | string }

export type SessionUser = {
  id: string
  email: string | null
  displayName: string | null
}

export type SessionOrganization = {
  id: string
  name: string
  slug: string
  type: 'personal' | 'team' | 'enterprise'
}

export type FeatureValue = boolean | number | string

export type EntitlementSnapshot = {
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

export type MulticodeAuthState = {
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

export type PremiumAccessRequest = {
  featureKey: string
  amount?: number
  hostedCost?: boolean
}

export type PremiumAccessDecision = {
  allowed: boolean
  featureKey: string
  value: FeatureValue | undefined
  status: 'fresh' | 'offline_grace' | 'expired' | 'signed_out' | 'missing' | 'error'
  message: string
  limit?: number
  graceExpiresAt?: string
}

export type UsageRequest = {
  featureKey: string
  amount?: number
  actorType?: 'user' | 'organization' | 'api_key'
  actorId?: string
  idempotencyKey: string
  window?: 'day' | 'month'
}

export type UsageResult = {
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

export type SessionSnapshot =
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

export type MobileControlCommandType =
  | 'snapshot.request'
  | 'artifact.read'
  | 'sprintengine.create'
  | 'task.start'
  | 'artifact.approve'
  | 'artifact.requestChanges'
  | 'agent.followUp'
  | 'device.revoke'

export type MobileControlCapability =
  | 'snapshots.read'
  | 'artifacts.read'
  | 'swarms.create'
  | 'tasks.start'
  | 'artifacts.review'
  | 'agents.followUp'
  | 'devices.revoke'

export type MobileControlDevice = {
  protocolVersion: 1
  deviceId: string
  displayName: string
  platform: 'ios' | 'android' | 'web'
  appVersion: string
  pairedAt: string
  lastSeenAt?: string
  revokedAt?: string
  capabilities: MobileControlCapability[]
}

export type MobileControlCapabilities = {
  protocolVersion: 1
  deviceId: string
  commands: MobileControlCommandType[]
  capabilities: MobileControlCapability[]
  artifactPreviewModes: ('text' | 'markdown' | 'restrictedHtml')[]
  maxFollowUpCharacters: number
  snapshotTtlMs: number
}

export type MobileBridgeRelayStatus =
  | 'disabled'
  | 'unconfigured'
  | 'connecting'
  | 'connected'
  | 'retrying'
  | 'error'

export type MobileBridgePresence = 'available' | 'busy' | 'idle' | 'offline'

export type MobileBridgeDiagnosticEntry = {
  id: string
  timestamp: string
  level: 'info' | 'warning' | 'error'
  code: string
  message: string
  retryable: boolean
}

export type MobileBridgePairingChallenge = {
  pairingChallengeId: string
  pairingCode: string
  pairingUri: string
  expiresAt: string
  requestedScopes: MobileControlCapability[]
}

export type MobileBridgeState = {
  enabled: boolean
  relayStatus: MobileBridgeRelayStatus
  relayUrl: string | null
  desktopInstanceId: string
  desktopRelaySessionId: string | null
  relayTokenExpiresAt: string | null
  nextReconnectAt: string | null
  presence: MobileBridgePresence
  lastPresenceAt: string | null
  pairingChallenge: Omit<MobileBridgePairingChallenge, 'pairingCode' | 'pairingUri'> | null
  pairedDevices: MobileControlDevice[]
  capabilities: MobileControlCapabilities
  diagnostics: MobileBridgeDiagnosticEntry[]
}

export type MobileBridgeSettingsUpdate = {
  enabled?: boolean
}

export type ElectronApi = {
  platform: string
  isDevelopment: boolean
  isDiagnosticsEnabled: boolean
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
  mobileBridgeGetState: () => Promise<MobileBridgeState>
  mobileBridgeUpdateSettings: (input: MobileBridgeSettingsUpdate) => Promise<MobileBridgeState>
  mobileBridgeRequestPairingCode: () => Promise<MobileBridgePairingChallenge>
  mobileBridgeListDevices: () => Promise<MobileControlDevice[]>
  mobileBridgeRevokeDevice: (deviceId: string, reason?: string) => Promise<MobileControlDevice>
  mobileBridgePublishPresence: (presence: MobileBridgePresence) => Promise<MobileBridgeState>
  mobileBridgeGetDiagnostics: () => Promise<MobileBridgeDiagnosticEntry[]>
  mobileBridgeUpdateWorkspaceRoots: (roots: string[]) => Promise<{ roots: string[] }>
  onMobileBridgeStateChanged: (cb: (state: MobileBridgeState) => void) => () => void
  readdir: (path: string) => Promise<{ name: string; isDir: boolean }[]>
  searchFiles: (rootPath: string, query: string, options?: { limit?: number; excludes?: string[] }) => Promise<FileSearchResult>
  searchContent: (rootPath: string, query: string, options?: { limit?: number; excludes?: string[] }) => Promise<ContentSearchResult>
  cancelContentSearch: () => Promise<void>
  readfile: (path: string) => Promise<string>
  readImageDataUrl: (path: string) => Promise<string>
  pathExists: (path: string) => Promise<boolean>
  checkWorkspaceFolder: (path: string) => Promise<WorkspaceFolderCheckResult>
  memoryResolveRoot: (input: { workspaceRoot: string | null; relativeRoot: string | null }) => Promise<MemoryRootStatus>
  memoryIndex: (input: { workspaceRoot: string | null; relativeRoot: string | null }) => Promise<MemoryGraphIndexResult>
  memoryReadPreview: (
    input: { workspaceRoot: string | null; relativeRoot: string | null; relativePath: string }
  ) => Promise<MemoryPreviewResult>
  logDiagnostic: (input: DiagnosticLogInput) => Promise<DiagnosticLogEntry>
  openDiagnosticsLogsFolder: () => Promise<{ opened: true; path: string }>
  updateGetState: () => Promise<AppUpdateState>
  updateCheck: () => Promise<AppUpdateCheckResult>
  updateDownload: () => Promise<AppUpdateCheckResult>
  updateQuitAndInstall: () => Promise<AppUpdateCheckResult>
  updateOpenReleaseNotes: () => Promise<{ opened: true; url: string }>
  onUpdateStateChanged: (cb: (state: AppUpdateState) => void) => () => void
  readSpecialistSoul: (specialistId: SpecialistActionId) => Promise<SoulPromptResult>
  readMultiloopPrompt: (role: MultiloopRole) => Promise<SoulPromptResult>
  writefile: (path: string, content: string) => Promise<void>
  createFile: (parentDir: string, name: string) => Promise<string>
  createDir: (parentDir: string, name: string) => Promise<string>
  ensureDir: (parentDir: string, name: string) => Promise<string>
  renamePath: (sourcePath: string, nextName: string) => Promise<string>
  copyPath: (sourcePath: string, destinationDir: string) => Promise<string>
  deletePath: (targetPath: string) => Promise<void>
  showItemInFolder: (targetPath: string) => Promise<void>
  watchPath: (path: string, cb: (event: FileWatchEvent) => void) => Promise<() => Promise<void>>
  openDir: () => Promise<string | null>
  saveFile: (options?: SaveDialogOptions) => Promise<string | null>
  openFile: (options?: OpenDialogOptions) => Promise<string | null>
  showContextMenu: (items: ContextMenuItem[]) => Promise<string | null>
  showMenubarMenu: (label: string, position?: { x?: number; y?: number }) => Promise<boolean>
  getGitRepoRoot: (folderPath: string) => Promise<string | null>
  getGitStatus: (repoRoot: string) => Promise<GitStatusSnapshot>
  getGitFileBase: (repoRoot: string, filePath: string) => Promise<GitFileBaseResult>
  getGitBranches: (repoRoot: string) => Promise<GitBranchSnapshot>
  getGitHistory: (repoRoot: string, limit?: number) => Promise<GitHistorySnapshot>
  getGitConflicts: (repoRoot: string) => Promise<GitConflictSnapshot>
  getGitConflictFile: (repoRoot: string, filePath: string) => Promise<GitConflictFileContent | null>
  resolveGitConflict: (repoRoot: string, filePath: string, content: string) => Promise<GitCommandResult>
  stageGitPaths: (repoRoot: string, paths: string[]) => Promise<GitCommandResult>
  unstageGitPaths: (repoRoot: string, paths: string[]) => Promise<GitCommandResult>
  revertGitPaths: (repoRoot: string, paths: string[]) => Promise<GitCommandResult>
  discardUnstagedGitChanges: (repoRoot: string, paths: string[]) => Promise<GitCommandResult>
  commitGitChanges: (repoRoot: string, message: string) => Promise<GitCommandResult>
  pushGitBranch: (repoRoot: string) => Promise<GitCommandResult>
  fetchGitRemotes: (repoRoot: string) => Promise<GitCommandResult>
  pullGitBranchWithStash: (repoRoot: string) => Promise<GitCommandResult>
  switchGitBranch: (repoRoot: string, branchName: string) => Promise<GitCommandResult>
  listGitWorktrees: (repoRoot: string) => Promise<GitWorktreeOperationResult<GitWorktreeListSnapshot>>
  createGitWorktree: (input: GitWorktreeCreateInput) => Promise<GitWorktreeOperationResult<GitWorktreeEntry>>
  removeGitWorktree: (input: GitWorktreeRemoveInput) => Promise<GitWorktreeOperationResult<GitCommandResult>>
  pruneGitWorktrees: (repoRoot: string) => Promise<GitWorktreeOperationResult<GitCommandResult>>
  repairGitWorktrees: (input: GitWorktreeRepairInput) => Promise<GitWorktreeOperationResult<GitCommandResult>>
  copyGitWorktreeIncludedFiles: (
    input: GitWorktreeCopyIncludedInput
  ) => Promise<GitWorktreeOperationResult<GitWorktreeCopyIncludedResult>>
  openSwarmArtifact: (statePath: string, artifactPath: string) => Promise<SwarmArtifactCommandResult>
  approveSwarmArtifact: (statePath: string, artifactId: string) => Promise<SwarmArtifactCommandResult>
  autoApproveSwarmArtifact: (statePath: string, artifactId: string) => Promise<SwarmArtifactCommandResult>
  requestSwarmArtifactChanges: (
    statePath: string,
    artifactId: string,
    feedback: string
  ) => Promise<SwarmArtifactCommandResult>
  initializeMultiloopState: (input: MultiloopInitInput) => Promise<MultiloopInitResult>
  terminalSpawn: (
    sessionId: string,
    cols: number,
    rows: number,
    cwd?: string,
    resume?: boolean,
    swarmStatePath?: string,
    cli?: AgentCli,
    initialPrompt?: string,
    cliRuntimes?: Partial<Record<AgentCli, Partial<CliRuntimeSettings>>>,
    shellOnly?: boolean,
    metadata?: TerminalSpawnMetadata
  ) => Promise<TerminalSpawnResult>
  terminalWrite: (sessionId: string, data: string) => Promise<void>
  terminalWriteFast: (sessionId: string, data: string) => void
  terminalResize: (sessionId: string, cols: number, rows: number) => Promise<void>
  terminalStatus: (sessionId: string) => Promise<{ running: boolean }>
  terminalList: () => Promise<TerminalSessionSnapshot[]>
  terminalKill: (sessionId: string) => Promise<void>
  onTerminalData: (sessionId: string, cb: (data: string) => void) => () => void
  onTerminalExit: (sessionId: string, cb: (code: number) => void) => () => void
  onTerminalError: (sessionId: string, cb: (message: string) => void) => () => void
  onTerminalSessionsChanged: (cb: (sessions: TerminalSessionSnapshot[]) => void) => () => void
  onAppMenuCommand: (cb: (command: string) => void) => () => void
}
