import type {
  SwitchboardAddCommentInput,
  SwitchboardCancelTaskInput,
  SwitchboardClaimTaskInput,
  SwitchboardClaimTaskResult,
  SwitchboardCreateTaskInput,
  SwitchboardInitApiResult,
  SwitchboardImportResult,
  SwitchboardMoveTaskInput,
  SwitchboardMutationResult,
  SwitchboardPromoteInboxTaskInput,
  SwitchboardPublishTaskInput,
  SwitchboardReadResult,
  SwitchboardRecoverLockInput,
  SwitchboardRecoverLockResult,
  SwitchboardRequeueTaskInput,
  SwitchboardRunnerResult,
  SwitchboardRunnerStartInput,
  SwitchboardRunnerWorkspaceInput,
  SwitchboardExecutionLogsInput,
  SwitchboardExecutionLogsResult,
  SwitchboardExecutionStatusInput,
  SwitchboardExecutionStatusResult,
  SwitchboardStopExecutionInput,
  SwitchboardStopExecutionResult,
  SwitchboardUpdateTaskInput,
  WatchtowerRunListResult,
  WatchtowerRunResult,
  WatchtowerStartReviewInput,
  WatchtowerStartTriageInput,
} from './switchboard'

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
  type?: 'normal' | 'separator' | 'checkbox'
  checked?: boolean
  submenu?: ContextMenuItem[]
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
  inboundDegree: number
  group: string
  title?: string
  type?: string
  tags?: string[]
  related?: string[]
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

export type MemoryActivityEvent = {
  workspaceRoot: string
  sessionId: string
  nodeId: string
  prevNodeId: string | null
  tool: string
  ts: number
  synapseCount: number
}

export type MemoryActivitySynapse = {
  src: string
  dst: string
  count: number
  lastTs: number
}

export type MemoryActivityStatus = {
  workspaceRoot: string | null
  isInstalled: boolean
  isWatching: boolean
  sessionsRecorded: number
  totalEvents: number
  eventsToday: number
  lastEventAt: number | null
}

export type MemoryActivityInstallResult =
  | { ok: true; settingsPath: string; hookScriptPath: string }
  | { ok: false; message: string }

export type MemoryActivityUninstallResult =
  | { ok: true }
  | { ok: false; message: string }

export type MemoryActivitySynapsesPayload = {
  workspaceRoot: string
  synapses: MemoryActivitySynapse[]
}

export type BuiltinSkill = {
  id: string
  name: string
  version: string
  description: string
}

export type BuiltinSkillStatus =
  | { ok: true; status: 'missing'; skill: BuiltinSkill; destinationPath: string }
  | { ok: true; status: 'installed'; skill: BuiltinSkill; destinationPath: string; installedVersion: string }
  | { ok: true; status: 'update-available'; skill: BuiltinSkill; destinationPath: string; installedVersion: string }
  | { ok: true; status: 'modified'; skill: BuiltinSkill; destinationPath: string; installedVersion: string }
  | { ok: true; status: 'local'; skill: BuiltinSkill; destinationPath: string; message: string }
  | { ok: false; status: 'unknown-skill' | 'missing-workspace' | 'missing-source'; skillId: string; message: string }

export type BuiltinSkillInstallResult =
  | { ok: true; status: 'installed' | 'updated'; skill: BuiltinSkill; destinationPath: string }
  | { ok: false; status: 'unknown-skill' | 'missing-workspace' | 'missing-source' | 'modified' | 'local'; skillId: string; message: string }

// Runtime CLI identity is a plugin id. Legacy stored values `codex` and
// `claude` still map to the bundled plugin manifests in the main process.
export type AgentCli = string
export type AgentExecutionMode = 'current_workspace' | 'worktree'
export type SprintEngineCliPermissionPreset = 'default' | 'auto_workspace' | 'bypass_all'

export type CliRuntimeSettings = {
  command: string
  useWsl: boolean
}

export type McpClientTarget = AgentCli
export type McpTransport = 'stdio' | 'http' | 'sse'
export type McpScope = 'workspace' | 'user'
export type McpServerSource = 'bundled' | 'custom'
export type McpRiskLevel = 'low' | 'network' | 'local-command' | 'secrets'

export type McpServerConfig = {
  id: string
  name: string
  category?: string
  description?: string
  transport: McpTransport
  command?: string
  args?: string[]
  url?: string
  env?: Record<string, string>
  envVarNames?: string[]
  headers?: Record<string, string>
  enabled: boolean
  required?: boolean
  clients: McpClientTarget[]
  scope: McpScope
  source: McpServerSource
  riskLevel: McpRiskLevel
  auth?: string
  capabilities?: string[]
  sourceUrl?: string
}

export type McpSettings = {
  syncEnabled: boolean
  servers: Record<string, McpServerConfig>
}

export type McpCatalogServer = Omit<McpServerConfig, 'enabled' | 'scope' | 'source'> & {
  defaultClients?: McpClientTarget[]
  recommendedScope?: McpScope
  setupNotes?: string
}

export type McpCatalogResult =
  | { ok: true; servers: McpCatalogServer[] }
  | { ok: false; message: string }

export type McpValidationIssue = {
  level: 'error' | 'warning'
  serverId?: string
  client?: McpClientTarget
  message: string
}

export type McpSyncTarget = {
  client: McpClientTarget
  path: string
  serverIds: string[]
}

export type McpSyncPreview =
  | { ok: true; targets: McpSyncTarget[]; issues: McpValidationIssue[] }
  | { ok: false; message: string; issues?: McpValidationIssue[] }

export type McpSyncResult =
  | { ok: true; targets: McpSyncTarget[]; issues: McpValidationIssue[] }
  | { ok: false; message: string; issues?: McpValidationIssue[] }

export type McpSyncInput = {
  workspaceRoot: string
  settings: McpSettings
  clients?: McpClientTarget[]
  managedSprintEngine?: {
    statePath: string
    workspaceRoot?: string
    allowedRoots?: string[]
    registryRoots?: string[]
    userRoot?: string
    actorId?: string
    workspaceId?: string
    agentId?: string
    role?: string
    cli?: McpClientTarget
    http?: {
      url: string
      authTokenEnvVar?: string
      headers?: Record<string, string>
    }
  }
  requiredOnly?: boolean
  write?: boolean
}

export type SkillPackHarness = 'claude' | 'codex' | 'cursor' | 'gemini' | 'opencode' | 'agents'
export type SkillPackSource = 'bundled' | 'custom'

export type SkillPackEntry = {
  id: string
  slug: string
  name: string
  category?: string
  description?: string
  version?: string
  sourceUrl?: string
  installedDirName?: string
  harnesses: SkillPackHarness[]
  source: SkillPackSource
  installedAt?: string
}

export type SkillPackCatalogEntry = Omit<SkillPackEntry, 'source' | 'installedAt'> & {
  recommended?: boolean
  setupNotes?: string
}

export type SkillPackCatalogResult =
  | { ok: true; packs: SkillPackCatalogEntry[] }
  | { ok: false; message: string }

export type SkillPackListInstalledInput = {
  workspaceRoot: string
}

export type SkillPackListInstalledResult =
  | { ok: true; installed: SkillPackEntry[] }
  | { ok: false; message: string }

export type SkillPackInstallInput = {
  workspaceRoot: string
  slug: string
  harnesses?: SkillPackHarness[]
  installedDirName?: string
}

export type SkillPackInstallResult =
  | { ok: true; installed: SkillPackEntry; log: string }
  | { ok: false; message: string; log?: string }

export type SkillPackRemoveInput = {
  workspaceRoot: string
  slug: string
  installedDirName?: string
  harnesses?: SkillPackHarness[]
}

export type SkillPackRemoveResult =
  | { ok: true; slug: string; log: string }
  | { ok: false; message: string; log?: string }

export type TerminalKind = 'agent' | 'terminal'
export type TerminalPathStyle = 'posix' | 'windows' | 'wsl'
export type AgentSessionSystem = 'switchboard' | 'watchtower' | 'sprintengine' | 'manual'

export type AgentSessionIdentity = {
  sessionId: string
  executionId: string
  system: AgentSessionSystem
  workspaceId: string
  workspaceRoot: string
  workId: string
  role: string
  displayName: string
}

export type AgentSessionMetadata = Omit<AgentSessionIdentity, 'sessionId'> & {
  sessionId?: string
}

export type TerminalSpawnMetadata = {
  kind?: TerminalKind
  workspaceId?: string
  agentId?: string
  terminalId?: string
  executionMode?: AgentExecutionMode
  worktreeId?: string
  worktreePath?: string
  cliPermissionPreset?: SprintEngineCliPermissionPreset
  memoryRootPath?: string
  memoryRelativeRoot?: string
  agentSession?: AgentSessionMetadata
  visible?: boolean
  mcpSettings?: McpSettings
}

export type SessionActivity =
  | { kind: 'working'; since: number }
  | { kind: 'idle'; since: number }
  | { kind: 'exited'; at: number; exitCode: number }
  | { kind: 'failed'; at: number; exitCode: number; message?: string }

export type TerminalSessionSnapshot = {
  sessionId: string
  processAlive: boolean
  kind: TerminalKind
  pathStyle?: TerminalPathStyle
  workspaceId?: string
  agentId?: string
  terminalId?: string
  cli?: AgentCli
  cwd?: string
  sprintEngineStatePath?: string
  executionMode?: AgentExecutionMode
  worktreeId?: string
  worktreePath?: string
  agentSession?: AgentSessionIdentity
  visible: boolean
  startedAt: number
  lastOutputAt: number | null
  lastInputAt: number | null
  activity: SessionActivity
  exitedAt: number | null
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
  | 'blog-writer'
  | 'qa-test'
  | 'security-review'
  | 'frontend-design-review'
  | 'code-review'
  | 'spec-review'

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
  pushedCommitCount?: number
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

export type GitHubRepoRef = {
  owner: string
  repo: string
  webUrl: string
}

export type GitHubTokenStatus = {
  configured: boolean
  source: 'settings' | 'environment' | 'none'
  encryptionAvailable: boolean
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

export type SprintEngineMutationEventMetadata = {
  id?: string
  type?: string
  timestamp?: string
  actor?: string
  message?: string
}

export type SprintEngineMutationRefreshData = {
  projectionContent?: string
  events?: SprintEngineMutationEventMetadata[]
  latestEvent?: SprintEngineMutationEventMetadata
  latestEventId?: string
  [key: string]: unknown
}

export type SprintEngineArtifactCommandResult =
  | { ok: true; data: SprintEngineMutationRefreshData }
  | { ok: false; message: string; stdout?: string; stderr?: string; exitCode?: number | string }

export type SprintEngineProjectionReadResult =
  | { ok: true; data: unknown }
  | { ok: false; message: string }

export type SprintEngineRegistryRolesReadInput = {
  workspaceRoot: string
  includeShadowed?: boolean
}

export type SprintEngineRegistryRoleReadInput = {
  workspaceRoot: string
  roleId: string
}

export type SprintEngineDispatchReadInput = {
  statePath: string
  agentId: string
  lastDispatchId?: string
}

export type SprintEngineMcpReadResult =
  | { ok: true; data: unknown }
  | { ok: false; message: string; stdout?: string; stderr?: string; exitCode?: number | string }

export type SprintEngineTaskMutationRole =
  | 'architect'
  | 'product'
  | 'developer'
  | 'frontend'
  | 'tester'
  | 'security'
  | 'code_reviewer'
  | 'spec_reviewer'
  | 'performance'

export type SprintEngineTaskUpdateInput = {
  statePath: string
  taskId: string
  title?: string
  description?: string
  role?: SprintEngineTaskMutationRole
  acceptanceCriteria?: string[]
  implementationNotes?: string[]
  notes?: string[]
}

export type SprintEngineTaskCreateInput = {
  statePath: string
  title: string
  description?: string
  role: SprintEngineTaskMutationRole
  acceptanceCriteria?: string[]
  implementationNotes?: string[]
  notes?: string[]
  manualDispatch?: boolean
}

export type SprintEngineTaskCommentInput = {
  statePath: string
  taskId: string
  body: string
}

export type SprintEngineStateInitializeInput = {
  statePath: string
  name: string
  goal: string
  agents: Record<string, unknown>
  tasks?: unknown[]
  events?: unknown[]
  artifacts?: unknown[]
}

export type SprintEngineCliWatchPolling = 'enabled' | 'disabled'

export type SprintEngineRunnerSetInput = {
  statePath: string
  // Whether `sprintengine join --watch` keeps polling for ready work. CLI
  // runtime only — Multicode supervisor ignores this. Existing IPC callers
  // that send `mode: 'auto' | 'off'` are translated by the main-process
  // handler in `src/main/sprintengine-artifacts.ts` to preserve backward
  // compatibility for one release cycle.
  cliWatchPolling: SprintEngineCliWatchPolling
}

export type SprintEngineRosterReplenishInput = {
  statePath: string
  role?: SprintEngineTaskMutationRole
}

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
  | 'sprintengines.create'
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

export type MobileBridgeCommandEvent = {
  id: string
  commandId: string
  commandType: MobileControlCommandType
  deviceId: string | null
  deviceName: string | null
  receivedAt: string
  completedAt?: string
  status: 'received' | 'completed' | 'failed'
  resultCode?: string
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
  recentCommands: MobileBridgeCommandEvent[]
}

export type MobileBridgeSettingsUpdate = {
  enabled?: boolean
  relayUrl?: string | null
}

export type WorkspaceBackupPayload = {
  version: number
  writtenAt: string
  data: unknown
}

export type WorkspaceBackupReadResult =
  | { ok: true; payload: WorkspaceBackupPayload }
  | { ok: false; reason: 'missing' | 'unreadable' | 'parse_error'; message?: string }

export type WorkspaceBackupWriteResult = { ok: boolean; message?: string }

export type ModuleEnablementOverrides = Record<string, boolean>
export type ModuleEnablementWriteResult = { ok: boolean; message?: string }

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
  getPathForFile: (file: unknown) => string
  checkWorkspaceFolder: (path: string) => Promise<WorkspaceFolderCheckResult>
  memoryResolveRoot: (input: { workspaceRoot: string | null; relativeRoot: string | null }) => Promise<MemoryRootStatus>
  memoryIndex: (input: { workspaceRoot: string | null; relativeRoot: string | null }) => Promise<MemoryGraphIndexResult>
  memoryReadPreview: (
    input: { workspaceRoot: string | null; relativeRoot: string | null; relativePath: string }
  ) => Promise<MemoryPreviewResult>
  memoryActivityInstall: (
    input: { workspaceRoot: string | null; memoryRelativeRoot: string | null }
  ) => Promise<MemoryActivityInstallResult>
  memoryActivityUninstall: (
    input: { workspaceRoot: string | null }
  ) => Promise<MemoryActivityUninstallResult>
  memoryActivityStartWatching: (
    input: { workspaceRoot: string | null; memoryRelativeRoot: string | null }
  ) => Promise<{ ok: true }>
  memoryActivityStopWatching: (
    input: { workspaceRoot: string | null }
  ) => Promise<{ ok: true }>
  memoryActivityGetStatus: (
    input: { workspaceRoot: string | null }
  ) => Promise<MemoryActivityStatus>
  memoryActivityGetSynapses: (
    input: { workspaceRoot: string | null }
  ) => Promise<MemoryActivitySynapse[]>
  memoryActivityIsInstalled: (
    input: { workspaceRoot: string | null }
  ) => Promise<boolean>
  memoryActivityClearHistory: (
    input: { workspaceRoot: string | null }
  ) => Promise<{ ok: true }>
  onMemoryActivityEvent: (cb: (event: MemoryActivityEvent) => void) => () => void
  onMemoryActivityStatus: (cb: (status: MemoryActivityStatus) => void) => () => void
  onMemoryActivitySynapses: (cb: (payload: MemoryActivitySynapsesPayload) => void) => () => void
  builtinSkillsList: () => Promise<BuiltinSkill[]>
  builtinSkillStatus: (
    input: { workspaceRoot: string | null; skillId: string }
  ) => Promise<BuiltinSkillStatus>
  builtinSkillInstall: (
    input: { workspaceRoot: string | null; skillId: string }
  ) => Promise<BuiltinSkillInstallResult>
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
  writeBinaryFile: (path: string, base64Content: string) => Promise<void>
  createFile: (parentDir: string, name: string) => Promise<string>
  createDir: (parentDir: string, name: string) => Promise<string>
  ensureDir: (parentDir: string, name: string) => Promise<string>
  renamePath: (sourcePath: string, nextName: string) => Promise<string>
  copyPath: (sourcePath: string, destinationDir: string) => Promise<string>
  copyPathInto: (sourcePath: string, destinationDir: string, options?: { overwrite?: boolean }) => Promise<string>
  deletePath: (targetPath: string) => Promise<void>
  showItemInFolder: (targetPath: string) => Promise<void>
  openHtmlFileInBrowser: (targetPath: string) => Promise<void>
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
  getGitHubTokenStatus: () => Promise<GitHubTokenStatus>
  setGitHubToken: (token: string) => Promise<GitHubTokenStatus>
  clearGitHubToken: () => Promise<GitHubTokenStatus>
  mcpListCatalog: () => Promise<McpCatalogResult>
  mcpPreviewSync: (input: McpSyncInput) => Promise<McpSyncPreview>
  mcpSync: (input: McpSyncInput) => Promise<McpSyncResult>
  skillPackListCatalog: () => Promise<SkillPackCatalogResult>
  skillPackListInstalled: (input: SkillPackListInstalledInput) => Promise<SkillPackListInstalledResult>
  skillPackInstall: (input: SkillPackInstallInput) => Promise<SkillPackInstallResult>
  skillPackRemove: (input: SkillPackRemoveInput) => Promise<SkillPackRemoveResult>
  openSprintEngineArtifact: (statePath: string, artifactPath: string) => Promise<SprintEngineArtifactCommandResult>
  approveSprintEngineArtifact: (statePath: string, artifactId: string) => Promise<SprintEngineArtifactCommandResult>
  autoApproveSprintEngineArtifact: (statePath: string, artifactId: string) => Promise<SprintEngineArtifactCommandResult>
  requestSprintEngineArtifactChanges: (
    statePath: string,
    artifactId: string,
    feedback: string
  ) => Promise<SprintEngineArtifactCommandResult>
  readySprintEngineTask: (statePath: string, taskId: string) => Promise<SprintEngineArtifactCommandResult>
  initializeSprintEngineState: (input: SprintEngineStateInitializeInput) => Promise<SprintEngineArtifactCommandResult>
  updateSprintEngineTask: (input: SprintEngineTaskUpdateInput) => Promise<SprintEngineArtifactCommandResult>
  createSprintEngineTask: (input: SprintEngineTaskCreateInput) => Promise<SprintEngineArtifactCommandResult>
  commentSprintEngineTask: (input: SprintEngineTaskCommentInput) => Promise<SprintEngineArtifactCommandResult>
  setSprintEngineRunnerMode: (input: SprintEngineRunnerSetInput) => Promise<SprintEngineArtifactCommandResult>
  replenishSprintEngineRoster: (input: SprintEngineRosterReplenishInput) => Promise<SprintEngineArtifactCommandResult>
  readSprintEngineProjection: (statePath: string) => Promise<SprintEngineProjectionReadResult>
  readSprintEngineRegistryRoles: (input: SprintEngineRegistryRolesReadInput) => Promise<SprintEngineMcpReadResult>
  readSprintEngineRegistryRole: (input: SprintEngineRegistryRoleReadInput) => Promise<SprintEngineMcpReadResult>
  readSprintEngineDispatch: (input: SprintEngineDispatchReadInput) => Promise<SprintEngineMcpReadResult>
  initializeSwitchboard: (workspaceRoot: string) => Promise<SwitchboardInitApiResult>
  readSwitchboardTasks: (workspaceRoot: string) => Promise<SwitchboardReadResult>
  createSwitchboardTask: (input: SwitchboardCreateTaskInput) => Promise<SwitchboardMutationResult>
  updateSwitchboardTask: (input: SwitchboardUpdateTaskInput) => Promise<SwitchboardMutationResult>
  moveSwitchboardTask: (input: SwitchboardMoveTaskInput) => Promise<SwitchboardMutationResult>
  promoteSwitchboardInboxTask: (input: SwitchboardPromoteInboxTaskInput) => Promise<SwitchboardMutationResult>
  cancelSwitchboardTask: (input: SwitchboardCancelTaskInput) => Promise<SwitchboardMutationResult>
  addSwitchboardComment: (input: SwitchboardAddCommentInput) => Promise<SwitchboardMutationResult>
  claimSwitchboardTask: (input: SwitchboardClaimTaskInput) => Promise<SwitchboardClaimTaskResult>
  publishSwitchboardTask: (input: SwitchboardPublishTaskInput) => Promise<SwitchboardMutationResult>
  recoverSwitchboardLock: (input: SwitchboardRecoverLockInput) => Promise<SwitchboardRecoverLockResult>
  requeueSwitchboardTask: (input: SwitchboardRequeueTaskInput) => Promise<SwitchboardMutationResult>
  startSwitchboardRunner: (input: SwitchboardRunnerStartInput) => Promise<SwitchboardRunnerResult>
  pauseSwitchboardRunner: (workspaceRoot: string) => Promise<SwitchboardRunnerResult>
  resumeSwitchboardRunner: (input: SwitchboardRunnerWorkspaceInput) => Promise<SwitchboardRunnerResult>
  stopSwitchboardRunner: (workspaceRoot: string) => Promise<SwitchboardRunnerResult>
  tickSwitchboardRunner: (input: SwitchboardRunnerWorkspaceInput) => Promise<SwitchboardRunnerResult>
  getSwitchboardRunnerState: (input?: string | SwitchboardRunnerWorkspaceInput) => Promise<SwitchboardRunnerResult>
  stopSwitchboardExecution: (input: SwitchboardStopExecutionInput) => Promise<SwitchboardStopExecutionResult>
  getSwitchboardExecutionStatus: (input: SwitchboardExecutionStatusInput) => Promise<SwitchboardExecutionStatusResult>
  getSwitchboardExecutionLogs: (input: SwitchboardExecutionLogsInput) => Promise<SwitchboardExecutionLogsResult>
  startWatchtowerReview: (input: WatchtowerStartReviewInput) => Promise<WatchtowerRunResult>
  startWatchtowerTriage: (input: WatchtowerStartTriageInput) => Promise<WatchtowerRunResult>
  getWatchtowerRun: (input: { workspaceRoot: string; runId: string }) => Promise<WatchtowerRunResult>
  listWatchtowerRuns: (workspaceRoot: string) => Promise<WatchtowerRunListResult>
  importGitHubIssuesToWatchtower: (workspaceRoot: string) => Promise<SwitchboardImportResult>
  importJiraIssuesToWatchtower: (workspaceRoot: string) => Promise<SwitchboardImportResult>
  initializeMultiloopState: (input: MultiloopInitInput) => Promise<MultiloopInitResult>
  terminalSpawn: (
    sessionId: string,
    cols: number,
    rows: number,
    cwd?: string,
    resume?: boolean,
    sprintEngineStatePath?: string,
    cli?: AgentCli,
    initialPrompt?: string,
    cliRuntimes?: Partial<Record<AgentCli, Partial<CliRuntimeSettings>>>,
    shellOnly?: boolean,
    metadata?: TerminalSpawnMetadata
  ) => Promise<TerminalSpawnResult>
  terminalWrite: (sessionId: string, data: string) => Promise<void>
  terminalWriteFast: (sessionId: string, data: string) => void
  terminalResize: (sessionId: string, cols: number, rows: number) => Promise<void>
  terminalStatus: (sessionId: string) => Promise<{ processAlive: boolean }>
  terminalList: () => Promise<TerminalSessionSnapshot[]>
  terminalSetVisible: (sessionId: string, visible: boolean) => Promise<void>
  terminalKill: (sessionId: string) => Promise<void>
  onTerminalData: (sessionId: string, cb: (data: string) => void) => () => void
  onTerminalExit: (sessionId: string, cb: (code: number) => void) => () => void
  onTerminalError: (sessionId: string, cb: (message: string) => void) => () => void
  onTerminalSessionsChanged: (cb: (sessions: TerminalSessionSnapshot[]) => void) => () => void
  onAppMenuCommand: (cb: (command: string) => void) => () => void
  workspaceBackupWrite: (payload: WorkspaceBackupPayload) => Promise<WorkspaceBackupWriteResult>
  workspaceBackupRead: () => Promise<WorkspaceBackupReadResult>
  getModuleEnablement: () => Promise<ModuleEnablementOverrides>
  setModuleEnablement: (overrides: ModuleEnablementOverrides) => Promise<ModuleEnablementWriteResult>
}
