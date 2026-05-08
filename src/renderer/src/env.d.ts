/// <reference types="vite/client" />

import type {
  AgentCli as SharedAgentCli,
  AgentExecutionMode as SharedAgentExecutionMode,
  AppUpdateChannel as SharedAppUpdateChannel,
  AppUpdateCheckResult as SharedAppUpdateCheckResult,
  AppUpdateProgress as SharedAppUpdateProgress,
  AppUpdateState as SharedAppUpdateState,
  AppUpdateStatus as SharedAppUpdateStatus,
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
  GitHistorySnapshot as SharedGitHistorySnapshot,
  GitRef as SharedGitRef,
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
  MultiloopRole as SharedMultiloopRole,
  MultiloopInitInput as SharedMultiloopInitInput,
  MultiloopInitResult as SharedMultiloopInitResult,
  OpenDialogOptions as SharedOpenDialogOptions,
  PremiumAccessDecision as SharedPremiumAccessDecision,
  PremiumAccessRequest as SharedPremiumAccessRequest,
  SaveDialogOptions as SharedSaveDialogOptions,
  SessionOrganization as SharedSessionOrganization,
  SessionSnapshot as SharedSessionSnapshot,
  SessionUser as SharedSessionUser,
  SoulPromptResult as SharedSoulPromptResult,
  SpecialistActionId as SharedSpecialistActionId,
  SwarmArtifactCommandResult as SharedSwarmArtifactCommandResult,
  SwarmCliPermissionPreset as SharedSwarmCliPermissionPreset,
  TerminalKind as SharedTerminalKind,
  TerminalPathStyle as SharedTerminalPathStyle,
  TerminalSessionSnapshot as SharedTerminalSessionSnapshot,
  TerminalSpawnMetadata as SharedTerminalSpawnMetadata,
  TerminalSpawnResult as SharedTerminalSpawnResult,
  UsageRequest as SharedUsageRequest,
  UsageResult as SharedUsageResult,
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
  type AgentCli = SharedAgentCli
  type AgentExecutionMode = SharedAgentExecutionMode
  type AppUpdateStatus = SharedAppUpdateStatus
  type AppUpdateChannel = SharedAppUpdateChannel
  type AppUpdateProgress = SharedAppUpdateProgress
  type AppUpdateState = SharedAppUpdateState
  type AppUpdateCheckResult = SharedAppUpdateCheckResult
  type SwarmCliPermissionPreset = SharedSwarmCliPermissionPreset
  type CliRuntimeSettings = SharedCliRuntimeSettings
  type TerminalKind = SharedTerminalKind
  type TerminalPathStyle = SharedTerminalPathStyle
  type TerminalSpawnMetadata = SharedTerminalSpawnMetadata
  type TerminalSessionSnapshot = SharedTerminalSessionSnapshot
  type TerminalSpawnResult = SharedTerminalSpawnResult
  type SpecialistActionId = SharedSpecialistActionId
  type SoulPromptResult = SharedSoulPromptResult
  type MultiloopRole = SharedMultiloopRole
  type GitFileStatus = SharedGitFileStatus
  type GitStatusEntry = SharedGitStatusEntry
  type GitStatusSnapshot = SharedGitStatusSnapshot
  type GitFileBaseResult = SharedGitFileBaseResult
  type GitBranch = SharedGitBranch
  type GitBranchSnapshot = SharedGitBranchSnapshot
  type GitCommit = SharedGitCommit
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
  type SwarmArtifactCommandResult = SharedSwarmArtifactCommandResult
  type MultiloopInitInput = SharedMultiloopInitInput
  type MultiloopInitResult = SharedMultiloopInitResult
  type SessionUser = SharedSessionUser
  type SessionOrganization = SharedSessionOrganization
  type FeatureValue = SharedFeatureValue
  type EntitlementSnapshot = SharedEntitlementSnapshot
  type MulticodeAuthState = SharedMulticodeAuthState
  type PremiumAccessRequest = SharedPremiumAccessRequest
  type PremiumAccessDecision = SharedPremiumAccessDecision
  type UsageRequest = SharedUsageRequest
  type UsageResult = SharedUsageResult
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
