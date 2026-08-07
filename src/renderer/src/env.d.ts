/// <reference types="vite/client" />

import type {
  AgentCli as SharedAgentCli,
  AgentConfigAdoptInput as SharedAgentConfigAdoptInput,
  AgentConfigAdoptResult as SharedAgentConfigAdoptResult,
  AgentConfigDetectedMcpServer as SharedAgentConfigDetectedMcpServer,
  AgentConfigDetectedSkill as SharedAgentConfigDetectedSkill,
  AgentConfigDetectInput as SharedAgentConfigDetectInput,
  AgentConfigDetectResult as SharedAgentConfigDetectResult,
  AgentConfigImportSource as SharedAgentConfigImportSource,
  AgentExecutionMode as SharedAgentExecutionMode,
  AppUpdateChannel as SharedAppUpdateChannel,
  AppUpdateCheckResult as SharedAppUpdateCheckResult,
  AppUpdateProgress as SharedAppUpdateProgress,
  AppUpdateState as SharedAppUpdateState,
  AppUpdateStatus as SharedAppUpdateStatus,
  BuiltinSkill as SharedBuiltinSkill,
  BuiltinSkillInstallResult as SharedBuiltinSkillInstallResult,
  BuiltinSkillStatus as SharedBuiltinSkillStatus,
  CliRuntimeSettings as SharedCliRuntimeSettings,
  ContentSearchEntry as SharedContentSearchEntry,
  ContentSearchResult as SharedContentSearchResult,
  ContextMenuItem as SharedContextMenuItem,
  DiagnosticLevel as SharedDiagnosticLevel,
  DiagnosticLogEntry as SharedDiagnosticLogEntry,
  DiagnosticLogInput as SharedDiagnosticLogInput,
  DiagnosticSource as SharedDiagnosticSource,
  ElectronApi,
  EntitlementSnapshot as SharedEntitlementSnapshot,
  FeatureValue as SharedFeatureValue,
  FileSearchEntry as SharedFileSearchEntry,
  FileSearchResult as SharedFileSearchResult,
  FileWatchEvent as SharedFileWatchEvent,
  GitBranch as SharedGitBranch,
  GitBranchSnapshot as SharedGitBranchSnapshot,
  GitCommandResult as SharedGitCommandResult,
  GitCommit as SharedGitCommit,
  GitConflictFile as SharedGitConflictFile,
  GitConflictFileContent as SharedGitConflictFileContent,
  GitConflictSnapshot as SharedGitConflictSnapshot,
  GitFileBaseResult as SharedGitFileBaseResult,
  GitFileStatus as SharedGitFileStatus,
  GitGraphCommit as SharedGitGraphCommit,
  GitGraphSnapshot as SharedGitGraphSnapshot,
  GitHistorySnapshot as SharedGitHistorySnapshot,
  GitRef as SharedGitRef,
  GitRepoOperation as SharedGitRepoOperation,
  GitResetMode as SharedGitResetMode,
  GitStashEntry as SharedGitStashEntry,
  GitStashListSnapshot as SharedGitStashListSnapshot,
  GitStatusEntry as SharedGitStatusEntry,
  GitStatusSnapshot as SharedGitStatusSnapshot,
  GitWorktreeCopyIncludedInput as SharedGitWorktreeCopyIncludedInput,
  GitWorktreeCopyIncludedResult as SharedGitWorktreeCopyIncludedResult,
  GitWorktreeCreateInput as SharedGitWorktreeCreateInput,
  GitWorktreeEntry as SharedGitWorktreeEntry,
  GitWorktreeListSnapshot as SharedGitWorktreeListSnapshot,
  GitWorktreeOperationResult as SharedGitWorktreeOperationResult,
  GitWorktreeRemoveInput as SharedGitWorktreeRemoveInput,
  GitWorktreeRepairInput as SharedGitWorktreeRepairInput,
  MemoryActivityEvent as SharedMemoryActivityEvent,
  MemoryActivityInstallResult as SharedMemoryActivityInstallResult,
  MemoryActivityStatus as SharedMemoryActivityStatus,
  MemoryActivitySynapse as SharedMemoryActivitySynapse,
  MemoryActivitySynapsesPayload as SharedMemoryActivitySynapsesPayload,
  MemoryActivityUninstallResult as SharedMemoryActivityUninstallResult,
  MemoryGraphEdge as SharedMemoryGraphEdge,
  MemoryGraphIndexResult as SharedMemoryGraphIndexResult,
  MemoryGraphNode as SharedMemoryGraphNode,
  MemoryGraphNodeKind as SharedMemoryGraphNodeKind,
  MemoryPreviewResult as SharedMemoryPreviewResult,
  MemoryRootStatus as SharedMemoryRootStatus,
  MemoryUnresolvedLink as SharedMemoryUnresolvedLink,
  MobileBridgeDiagnosticEntry as SharedMobileBridgeDiagnosticEntry,
  MobileBridgePairingChallenge as SharedMobileBridgePairingChallenge,
  MobileBridgePresence as SharedMobileBridgePresence,
  MobileBridgeRelayStatus as SharedMobileBridgeRelayStatus,
  MobileBridgeSettingsUpdate as SharedMobileBridgeSettingsUpdate,
  MobileBridgeState as SharedMobileBridgeState,
  MobileControlCapabilities as SharedMobileControlCapabilities,
  MobileControlCapability as SharedMobileControlCapability,
  MobileControlCommandType as SharedMobileControlCommandType,
  MobileControlDevice as SharedMobileControlDevice,
  MulticodeAuthState as SharedMulticodeAuthState,
  OpenDialogOptions as SharedOpenDialogOptions,
  PremiumAccessDecision as SharedPremiumAccessDecision,
  PremiumAccessRequest as SharedPremiumAccessRequest,
  SaveDialogOptions as SharedSaveDialogOptions,
  SessionOrganization as SharedSessionOrganization,
  SessionSnapshot as SharedSessionSnapshot,
  SessionUser as SharedSessionUser,
  SoulPromptResult as SharedSoulPromptResult,
  SpecialistActionId as SharedSpecialistActionId,
  SprintEngineArtifactCommandResult as SharedSprintEngineArtifactCommandResult,
  SprintEngineProjectionReadResult as SharedSprintEngineProjectionReadResult,
  SprintEngineCliPermissionPreset as SharedSprintEngineCliPermissionPreset,
  SessionActivity as SharedSessionActivity,
  AgentPhase as SharedAgentPhase,
  AgentState as SharedAgentState,
  AgentStateSource as SharedAgentStateSource,
  TerminalKind as SharedTerminalKind,
  TerminalPathStyle as SharedTerminalPathStyle,
  TerminalSessionSnapshot as SharedTerminalSessionSnapshot,
  TerminalSpawnMetadata as SharedTerminalSpawnMetadata,
  TerminalSpawnResult as SharedTerminalSpawnResult,
  WindowState as SharedWindowState,
  WorkspaceFolderCheckResult as SharedWorkspaceFolderCheckResult,
} from '../../shared/electron-api'

declare global {
  type SaveDialogOptions = SharedSaveDialogOptions
  type OpenDialogOptions = SharedOpenDialogOptions
  interface ContextMenuItem extends SharedContextMenuItem {}
  interface FileWatchEvent extends SharedFileWatchEvent {}
  type FileSearchEntry = SharedFileSearchEntry
  type FileSearchResult = SharedFileSearchResult
  type ContentSearchEntry = SharedContentSearchEntry
  type ContentSearchResult = SharedContentSearchResult
  type MemoryGraphNodeKind = SharedMemoryGraphNodeKind
  type MemoryGraphNode = SharedMemoryGraphNode
  type MemoryGraphEdge = SharedMemoryGraphEdge
  type MemoryUnresolvedLink = SharedMemoryUnresolvedLink
  type MemoryRootStatus = SharedMemoryRootStatus
  type MemoryGraphIndexResult = SharedMemoryGraphIndexResult
  type MemoryPreviewResult = SharedMemoryPreviewResult
  type MemoryActivityEvent = SharedMemoryActivityEvent
  type MemoryActivitySynapse = SharedMemoryActivitySynapse
  type MemoryActivitySynapsesPayload = SharedMemoryActivitySynapsesPayload
  type MemoryActivityStatus = SharedMemoryActivityStatus
  type MemoryActivityInstallResult = SharedMemoryActivityInstallResult
  type MemoryActivityUninstallResult = SharedMemoryActivityUninstallResult
  type BuiltinSkill = SharedBuiltinSkill
  type BuiltinSkillStatus = SharedBuiltinSkillStatus
  type BuiltinSkillInstallResult = SharedBuiltinSkillInstallResult
  type AgentCli = SharedAgentCli
  type AgentConfigImportSource = SharedAgentConfigImportSource
  type AgentConfigDetectedMcpServer = SharedAgentConfigDetectedMcpServer
  type AgentConfigDetectedSkill = SharedAgentConfigDetectedSkill
  type AgentConfigDetectInput = SharedAgentConfigDetectInput
  type AgentConfigDetectResult = SharedAgentConfigDetectResult
  type AgentConfigAdoptInput = SharedAgentConfigAdoptInput
  type AgentConfigAdoptResult = SharedAgentConfigAdoptResult
  type AgentExecutionMode = SharedAgentExecutionMode
  type AppUpdateStatus = SharedAppUpdateStatus
  type AppUpdateChannel = SharedAppUpdateChannel
  type AppUpdateProgress = SharedAppUpdateProgress
  type AppUpdateState = SharedAppUpdateState
  type AppUpdateCheckResult = SharedAppUpdateCheckResult
  type SprintEngineCliPermissionPreset = SharedSprintEngineCliPermissionPreset
  type CliRuntimeSettings = SharedCliRuntimeSettings
  type SessionActivity = SharedSessionActivity
  type AgentPhase = SharedAgentPhase
  type AgentState = SharedAgentState
  type AgentStateSource = SharedAgentStateSource
  type TerminalKind = SharedTerminalKind
  type TerminalPathStyle = SharedTerminalPathStyle
  type TerminalSpawnMetadata = SharedTerminalSpawnMetadata
  type TerminalSessionSnapshot = SharedTerminalSessionSnapshot
  type TerminalSpawnResult = SharedTerminalSpawnResult
  type SpecialistActionId = SharedSpecialistActionId
  type SoulPromptResult = SharedSoulPromptResult
  type GitFileStatus = SharedGitFileStatus
  type GitRepoOperation = SharedGitRepoOperation
  type GitResetMode = SharedGitResetMode
  type GitStashEntry = SharedGitStashEntry
  type GitStashListSnapshot = SharedGitStashListSnapshot
  type GitStatusEntry = SharedGitStatusEntry
  type GitStatusSnapshot = SharedGitStatusSnapshot
  type GitFileBaseResult = SharedGitFileBaseResult
  type GitBranch = SharedGitBranch
  type GitBranchSnapshot = SharedGitBranchSnapshot
  type GitCommit = SharedGitCommit
  type GitGraphCommit = SharedGitGraphCommit
  type GitGraphSnapshot = SharedGitGraphSnapshot
  type GitRef = SharedGitRef
  type GitHistorySnapshot = SharedGitHistorySnapshot
  type GitCommandResult = SharedGitCommandResult
  type GitConflictFile = SharedGitConflictFile
  type GitConflictFileContent = SharedGitConflictFileContent
  type GitConflictSnapshot = SharedGitConflictSnapshot
  type GitWorktreeEntry = SharedGitWorktreeEntry
  type GitWorktreeListSnapshot = SharedGitWorktreeListSnapshot
  type GitWorktreeCopyIncludedResult = SharedGitWorktreeCopyIncludedResult
  type GitWorktreeOperationResult<T> = SharedGitWorktreeOperationResult<T>
  type GitWorktreeCreateInput = SharedGitWorktreeCreateInput
  type GitWorktreeRemoveInput = SharedGitWorktreeRemoveInput
  type GitWorktreeRepairInput = SharedGitWorktreeRepairInput
  type GitWorktreeCopyIncludedInput = SharedGitWorktreeCopyIncludedInput
  type DiagnosticLevel = SharedDiagnosticLevel
  type DiagnosticSource = SharedDiagnosticSource
  type DiagnosticLogInput = SharedDiagnosticLogInput
  type DiagnosticLogEntry = SharedDiagnosticLogEntry
  type WorkspaceFolderCheckResult = SharedWorkspaceFolderCheckResult
  type WindowState = SharedWindowState
  type SprintEngineArtifactCommandResult = SharedSprintEngineArtifactCommandResult
  type SprintEngineProjectionReadResult = SharedSprintEngineProjectionReadResult
  type SessionUser = SharedSessionUser
  type SessionOrganization = SharedSessionOrganization
  type FeatureValue = SharedFeatureValue
  type EntitlementSnapshot = SharedEntitlementSnapshot
  type MulticodeAuthState = SharedMulticodeAuthState
  type PremiumAccessRequest = SharedPremiumAccessRequest
  type PremiumAccessDecision = SharedPremiumAccessDecision
  type SessionSnapshot = SharedSessionSnapshot
  type MobileControlCommandType = SharedMobileControlCommandType
  type MobileControlCapability = SharedMobileControlCapability
  type MobileControlDevice = SharedMobileControlDevice
  type MobileControlCapabilities = SharedMobileControlCapabilities
  type MobileBridgeRelayStatus = SharedMobileBridgeRelayStatus
  type MobileBridgePresence = SharedMobileBridgePresence
  type MobileBridgeDiagnosticEntry = SharedMobileBridgeDiagnosticEntry
  type MobileBridgePairingChallenge = SharedMobileBridgePairingChallenge
  type MobileBridgeState = SharedMobileBridgeState
  type MobileBridgeSettingsUpdate = SharedMobileBridgeSettingsUpdate

  interface Window {
    api: ElectronApi
  }
}

export {}
