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

declare interface Window {
  api: {
    platform: string

    // Window chrome
    windowMinimize: () => Promise<void>
    windowToggleMaximize: () => Promise<WindowState | null>
    windowClose: () => Promise<void>
    getWindowState: () => Promise<WindowState | null>
    onWindowStateChanged: (cb: (state: WindowState) => void) => () => void

    // File system
    readdir:   (path: string) => Promise<{ name: string; isDir: boolean }[]>
    readfile:  (path: string) => Promise<string>
    pathExists: (path: string) => Promise<boolean>
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

    // Agent CLI Terminal
    terminalSpawn:  (sessionId: string, cols: number, rows: number, cwd?: string, resume?: boolean, swarmStatePath?: string, cli?: AgentCli, initialPrompt?: string, cliRuntimes?: Partial<Record<AgentCli, Partial<CliRuntimeSettings>>>, shellOnly?: boolean, metadata?: TerminalSpawnMetadata) => Promise<void>
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
