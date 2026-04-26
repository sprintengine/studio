declare global {
  interface ContextMenuItem {
    id?: string
    label?: string
    enabled?: boolean
    type?: 'normal' | 'separator'
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
  type TerminalSpawnResult =
    | { ok: true; sessionId: string }
    | { ok: false; sessionId: string; message: string; exitCode: number }
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

  interface Window {
    api: {
      platform: string
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
      readdir:   (path: string) => Promise<{ name: string; isDir: boolean }[]>
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
      openDir:   () => Promise<string | null>
      saveFile:  (options?: Electron.SaveDialogOptions) => Promise<string | null>
      openFile:  (options?: Electron.OpenDialogOptions) => Promise<string | null>
      showContextMenu: (items: ContextMenuItem[]) => Promise<string | null>
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
      listSwarmArtifacts: (
        statePath: string,
        options?: SwarmArtifactListOptions
      ) => Promise<SwarmArtifactCommandResult>
      markSwarmArtifactReady: (
        statePath: string,
        artifactId: string,
        actorId: string
      ) => Promise<SwarmArtifactCommandResult>
      approveSwarmArtifact: (
        statePath: string,
        artifactId: string,
        actorId: string
      ) => Promise<SwarmArtifactCommandResult>
      requestSwarmArtifactChanges: (
        statePath: string,
        artifactId: string,
        actorId: string,
        feedback: string
      ) => Promise<SwarmArtifactCommandResult>
      openSwarmArtifact: (
        statePath: string,
        artifactPath: string
      ) => Promise<SwarmArtifactCommandResult>

      terminalSpawn:  (sessionId: string, cols: number, rows: number, cwd?: string, resume?: boolean, swarmStatePath?: string, cli?: AgentCli, initialPrompt?: string, cliRuntimes?: Partial<Record<AgentCli, Partial<CliRuntimeSettings>>>, shellOnly?: boolean, metadata?: TerminalSpawnMetadata) => Promise<TerminalSpawnResult>
      terminalWrite:  (sessionId: string, data: string) => Promise<void>
      terminalResize: (sessionId: string, cols: number, rows: number) => Promise<void>
      terminalStatus: (sessionId: string) => Promise<{ running: boolean }>
      terminalList:   () => Promise<TerminalSessionSnapshot[]>
      terminalKill:   (sessionId: string) => Promise<void>

      onTerminalData: (sessionId: string, cb: (data: string) => void) => () => void
      onTerminalExit: (sessionId: string, cb: (code: number) => void) => () => void
      onTerminalError: (sessionId: string, cb: (message: string) => void) => () => void
      onAppMenuCommand: (cb: (command: string) => void) => () => void
    }
  }
}
