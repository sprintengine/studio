// Drift guard between the published SDK surface and the in-app contracts.
//
// The SDK (packages/module-sdk/src/index.ts) re-declares the public module
// contracts so the published tarball is self-contained. This file is the
// single source-of-truth enforcement: it fails `tsc -p tsconfig.drift.json`
// (wired into the repo verify pipeline) whenever the SDK and the app diverge,
// and fails at runtime (test:sdk:drift) when mirrored value exports drift.
//
// Two assertion strengths are used deliberately:
// - `IsExact` (type identity) for shapes the SDK mirrors exactly. Mutual
//   assignability is not enough here: `{a?: string}` and `{a?: string, b?: string}`
//   are mutually assignable, so optional-property drift — the most likely real
//   drift on these mostly-optional contracts — would pass silently.
// - One-directional `Extends` for sound narrowings: every SDK-typed module
//   must remain registrable against the app (SDK ≤ app), and every app host
//   handed to module code must satisfy the SDK view (app ≤ SDK).

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import type {
  CapabilityManifest as AppCapabilityManifest,
  ModuleEntry as AppModuleEntry,
  ModuleFileDigests as AppModuleFileDigests,
  ModuleSignature as AppModuleSignature,
  ModuleSource as AppModuleSource,
  ModuleTrustStatus as AppModuleTrustStatus,
} from '../../../src/shared/modules/manifest'
import { BUNDLED_MODULE_IDS as APP_BUNDLED_MODULE_IDS } from '../../../src/shared/modules/manifest'
import type {
  ScheduledAgent as AppScheduledAgent,
  ScheduledAgentAttachment as AppScheduledAgentAttachment,
  ScheduledAgentDraft as AppScheduledAgentDraft,
  ScheduledAgentLastRun as AppScheduledAgentLastRun,
  ScheduledAgentSchedule as AppScheduledAgentSchedule,
  ScheduledAgentView as AppScheduledAgentView,
  ScheduledAgentWriteResult as AppScheduledAgentWriteResult,
} from '../../../src/shared/scheduled-agents'
import type { CapabilityPermission as AppCapabilityPermission } from '../../../src/shared/modules/permissions'
import { KNOWN_CAPABILITY_PERMISSIONS as APP_KNOWN_CAPABILITY_PERMISSIONS } from '../../../src/shared/modules/permissions'
import type { ModuleBridgeRefusalCode as AppModuleBridgeRefusalCode } from '../../../src/shared/modules/bridge'
import type { ModuleEventEnvelope as AppModuleEventEnvelope } from '../../../src/shared/modules/events'
import type { FileDropPayload as AppFileDropPayload } from '../../../src/renderer/src/utils/terminalDrop'
import { SPRINTENGINE_FILE_DROP_MIME as APP_FILE_DROP_MIME } from '../../../src/renderer/src/utils/terminalDrop'
import type {
  ModuleNotification as AppModuleNotification,
  ModuleNotificationSeverity as AppModuleNotificationSeverity,
  ModuleNotifyInput as AppModuleNotifyInput,
} from '../../../src/shared/modules/notifications'
import type {
  MainHost as AppMainHost,
  SidecarHandle as AppSidecarHandle,
  SidecarRunState as AppSidecarRunState,
  SidecarRuntimeStatus as AppSidecarRuntimeStatus,
  SidecarSpec as AppSidecarSpec,
  SidecarStartOptions as AppSidecarStartOptions,
} from '../../../src/main/module-host/main-host'
import type {
  McpConnectionContext as AppMcpConnectionContext,
  McpConnectionMetadata as AppMcpConnectionMetadata,
  McpToolRegistration as AppMcpToolRegistration,
  McpToolResult as AppMcpToolResult,
} from '../../../src/shared/modules/mcp-tools'
import type {
  EnsureSkillInstalledResult as AppEnsureSkillInstalledResult,
  ModuleSkillRegistration as AppModuleSkillRegistration,
  ModuleSkillStatus as AppModuleSkillStatus,
  ModuleSkillStatusResult as AppModuleSkillStatusResult,
  ModuleSkillTargetPolicy as AppModuleSkillTargetPolicy,
} from '../../../src/shared/modules/skills'
import type { ModuleWorkspaceContextService as AppModuleWorkspaceContextService } from '../../../src/main/modules/module-workspace-service'
import type {
  ModuleStorageChange as AppModuleStorageChange,
  ModuleStorageErrorCode as AppModuleStorageErrorCode,
  ModuleStorageRegistry as AppModuleStorageRegistry,
  ModuleStorageResult as AppModuleStorageResult,
} from '../../../src/main/module-host/module-storage'
// Every token the host exports, read as one namespace so the key check below
// does not depend on what each token is called.
import * as appServiceTokens from '../../../src/main/module-host/service-tokens'
import {
  ConversationModuleServiceToken as AppConversationModuleServiceToken,
  GitHubModuleServiceToken as AppGitHubModuleServiceToken,
  ModuleSecretsServiceToken as AppModuleSecretsServiceToken,
} from '../../../src/main/module-host/service-tokens'
// The host-internal chat tokens, provided by agent-runtime-module.
import {
  ConversationLaunchServiceToken as AppConversationLaunchServiceToken,
  ConversationRuntimeToken as AppConversationRuntimeToken,
} from '../../../src/main/module-host/service-tokens'
import { THIRD_PARTY_SERVICE_KEYS as APP_THIRD_PARTY_SERVICE_KEYS } from '../../../src/main/module-host/main-host'
import type { CapabilityModule as AppCapabilityModule } from '../../../src/main/module-host/load-modules'
import type { ModuleFocusTabInput as AppModuleFocusTabInput } from '../../../src/renderer/src/modules/workspace-tabs'
import type { CompanionAgentsModuleRegistry as AppCompanionAgentsModuleRegistry } from '../../../src/main/companion-agent-service'
import type {
  BacklogItemAction as AppBacklogItemAction,
  BacklogItemActionContext as AppBacklogItemActionContext,
  BacklogLinkProvider as AppBacklogLinkProvider,
  BacklogLinkProviderInput as AppBacklogLinkProviderInput,
  FileAction as AppFileAction,
  FileActionContext as AppFileActionContext,
  FileActionEntry as AppFileActionEntry,
  FileActionState as AppFileActionState,
  DoorBadgeContribution as AppDoorBadgeContribution,
  NotificationAction as AppNotificationAction,
  NotificationActionContext as AppNotificationActionContext,
  NotificationActionProvider as AppNotificationActionProvider,
  GlobalSurfaceDefinition as AppGlobalSurfaceDefinition,
  ModalSurfaceComponentProps as AppModalSurfaceComponentProps,
  ModalSurfaceDefinition as AppModalSurfaceDefinition,
  ModalSurfaceLauncher as AppModalSurfaceLauncher,
  ModuleCommandDefinition as AppModuleCommandDefinition,
  RendererHost as AppRendererHost,
  SettingsSectionDefinition as AppSettingsSectionDefinition,
  TopBarItemDefinition as AppTopBarItemDefinition,
  SettingsSectionProps as AppSettingsSectionProps,
  SidebarNavEntryDefinition as AppSidebarNavEntryDefinition,
  WorkspaceCreationStepProps as AppWorkspaceCreationStepProps,
  WorkspacePanelComponent as AppWorkspacePanelComponent,
  WorkspaceTypeCreateContext as AppWorkspaceTypeCreateContext,
  WorkspaceTypeCreateHost as AppWorkspaceTypeCreateHost,
  WorkspaceTypeCreateRequest as AppWorkspaceTypeCreateRequest,
  WorkspaceTypeCreationStep as AppWorkspaceTypeCreationStep,
  WorkspaceTypeDefinition as AppWorkspaceTypeDefinition,
  WorkspaceTypeSupervisor as AppWorkspaceTypeSupervisor,
} from '../../../src/renderer/src/modules/renderer-host'
import type {
  WorkspaceRunGlyph as AppWorkspaceRunGlyph,
  WorkspaceRunGlyphProviderInput as AppWorkspaceRunGlyphProviderInput,
} from '../../../src/renderer/src/utils/workspaceRunGlyph'
import type {
  CommandAvailability as AppCommandAvailability,
  CommandScope as AppCommandScope,
  ModuleCommandContext as AppModuleCommandContext,
} from '../../../src/renderer/src/commands/types'
import type {
  ModuleWorkspaceGitInfoResult as AppModuleWorkspaceGitInfoResult,
  ModuleWorkspaceGitRemote as AppModuleWorkspaceGitRemote,
  ModuleWorkspaceListEntry as AppModuleWorkspaceListEntry,
  ModuleWorkspaceListOptions as AppModuleWorkspaceListOptions,
  ModuleWorkspaceView as AppModuleWorkspaceView,
} from '../../../src/shared/modules/workspace-view'
import type { WorkspaceFileWatchEvent as AppWorkspaceFileWatchEvent } from '../../../src/renderer/src/modules/workspace-file-watch'
import type { ModuleColorScheme as AppModuleColorScheme } from '../../../src/renderer/src/modules/color-scheme-watch'
import type {
  BacklogItemLink as AppBacklogItemLink,
  BacklogItemStatus as AppBacklogItemStatus,
  BacklogResolvedLink as AppBacklogResolvedLink,
} from '../../../src/renderer/src/utils/backlog'
import type {
  LayoutTemplate as AppLayoutTemplate,
  PreviewSlot as AppPreviewSlot,
} from '../../../src/renderer/src/types/workspace'

import type {
  BacklogItemAction as SdkBacklogItemAction,
  BacklogItemActionContext as SdkBacklogItemActionContext,
  FileAction as SdkFileAction,
  FileActionContext as SdkFileActionContext,
  FileActionEntry as SdkFileActionEntry,
  FileActionState as SdkFileActionState,
  DoorBadgeContribution as SdkDoorBadgeContribution,
  NotificationAction as SdkNotificationAction,
  NotificationActionContext as SdkNotificationActionContext,
  NotificationActionProvider as SdkNotificationActionProvider,
  NotificationActionView as SdkNotificationActionView,
  BacklogItemLink as SdkBacklogItemLink,
  BacklogItemStatus as SdkBacklogItemStatus,
  BacklogLinkProvider as SdkBacklogLinkProvider,
  BacklogLinkProviderInput as SdkBacklogLinkProviderInput,
  BacklogResolvedLink as SdkBacklogResolvedLink,
  CapabilityManifest as SdkCapabilityManifest,
  CapabilityPermission as SdkCapabilityPermission,
  CommandAvailability as SdkCommandAvailability,
  CommandScope as SdkCommandScope,
  CompanionAgentEvent as SdkCompanionAgentEvent,
  CompanionAgentHandle as SdkCompanionAgentHandle,
  CompanionAgentSpec as SdkCompanionAgentSpec,
  CompanionAgentStatus as SdkCompanionAgentStatus,
  CompanionAgentsService as SdkCompanionAgentsService,
  CompanionRunStructuredOptions as SdkCompanionRunStructuredOptions,
  ScheduledAgent as SdkScheduledAgent,
  ScheduledAgentAttachment as SdkScheduledAgentAttachment,
  ScheduledAgentDraft as SdkScheduledAgentDraft,
  ScheduledAgentLastRun as SdkScheduledAgentLastRun,
  ScheduledAgentSchedule as SdkScheduledAgentSchedule,
  ScheduledAgentView as SdkScheduledAgentView,
  ScheduledAgentWriteResult as SdkScheduledAgentWriteResult,
  FileDropPayload as SdkFileDropPayload,
  GlobalSurfaceDefinition as SdkGlobalSurfaceDefinition,
  ModalSurfaceComponentProps as SdkModalSurfaceComponentProps,
  ModalSurfaceDefinition as SdkModalSurfaceDefinition,
  ModalSurfaceLauncher as SdkModalSurfaceLauncher,
  MainHost as SdkMainHost,
  McpConnectionContext as SdkMcpConnectionContext,
  McpConnectionMetadata as SdkMcpConnectionMetadata,
  McpToolRegistration as SdkMcpToolRegistration,
  EnsureSkillInstalledResult as SdkEnsureSkillInstalledResult,
  ModuleSkillRegistration as SdkModuleSkillRegistration,
  ModuleSkillStatus as SdkModuleSkillStatus,
  ModuleSkillStatusResult as SdkModuleSkillStatusResult,
  ModuleSkillTargetPolicy as SdkModuleSkillTargetPolicy,
  McpToolResult as SdkMcpToolResult,
  ModuleBridgeRefusalCode as SdkModuleBridgeRefusalCode,
  ModuleEventEnvelope as SdkModuleEventEnvelope,
  ModuleCommandContext as SdkModuleCommandContext,
  ModuleCommandDefinition as SdkModuleCommandDefinition,
  ModuleEntry as SdkModuleEntry,
  ModuleNotification as SdkModuleNotification,
  ModuleNotificationSeverity as SdkModuleNotificationSeverity,
  ModuleNotifyInput as SdkModuleNotifyInput,
  ModuleFileDigests as SdkModuleFileDigests,
  ModuleSignature as SdkModuleSignature,
  ModuleSource as SdkModuleSource,
  ModuleColorScheme as SdkModuleColorScheme,
  ModuleFocusTabInput as SdkModuleFocusTabInput,
  ModuleStorageChange as SdkModuleStorageChange,
  ModuleStorageErrorCode as SdkModuleStorageErrorCode,
  ModuleStorageResult as SdkModuleStorageResult,
  ModuleStorageService as SdkModuleStorageService,
  ModuleTrustStatus as SdkModuleTrustStatus,
  ModuleWorkspaceGitInfoResult as SdkModuleWorkspaceGitInfoResult,
  ModuleWorkspaceGitRemote as SdkModuleWorkspaceGitRemote,
  ModuleWorkspaceListEntry as SdkModuleWorkspaceListEntry,
  ModuleWorkspaceListOptions as SdkModuleWorkspaceListOptions,
  ModuleWorkspaceView as SdkModuleWorkspaceView,
  WorkspaceContextService as SdkWorkspaceContextService,
  PreviewSlot as SdkPreviewSlot,
  RegisterMain as SdkRegisterMain,
  RegisterRenderer as SdkRegisterRenderer,
  RendererHost as SdkRendererHost,
  SettingsSectionDefinition as SdkSettingsSectionDefinition,
  SettingsSectionProps as SdkSettingsSectionProps,
  SidebarNavEntryDefinition as SdkSidebarNavEntryDefinition,
  SidecarHandle as SdkSidecarHandle,
  SidecarRunState as SdkSidecarRunState,
  SidecarRuntimeStatus as SdkSidecarRuntimeStatus,
  SidecarSpec as SdkSidecarSpec,
  SidecarStartOptions as SdkSidecarStartOptions,
  TopBarItemDefinition as SdkTopBarItemDefinition,
  WorkspaceCreationStepProps as SdkWorkspaceCreationStepProps,
  WorkspaceLayoutTemplate as SdkWorkspaceLayoutTemplate,
  WorkspacePanelComponent as SdkWorkspacePanelComponent,
  WorkspaceFileWatchEvent as SdkWorkspaceFileWatchEvent,
  WorkspaceRunGlyph as SdkWorkspaceRunGlyph,
  WorkspaceRunGlyphInput as SdkWorkspaceRunGlyphInput,
  WorkspaceTypeCreateContext as SdkWorkspaceTypeCreateContext,
  WorkspaceTypeCreateHost as SdkWorkspaceTypeCreateHost,
  WorkspaceTypeCreateRequest as SdkWorkspaceTypeCreateRequest,
  WorkspaceTypeCreationStep as SdkWorkspaceTypeCreationStep,
  WorkspaceTypeDefinition as SdkWorkspaceTypeDefinition,
  WorkspaceTypeSupervisor as SdkWorkspaceTypeSupervisor,
} from '../src/index'
import {
  BUNDLED_MODULE_IDS as SDK_BUNDLED_MODULE_IDS,
  KNOWN_CAPABILITY_PERMISSIONS as SDK_KNOWN_CAPABILITY_PERMISSIONS,
  SPRINTENGINE_FILE_DROP_MIME as SDK_FILE_DROP_MIME,
  WorkspaceContextToken as SdkWorkspaceContextToken,
  WorkspaceServiceToken as SdkWorkspaceServiceToken,
} from '../src/index'

// The bridged UI kit and door shell (D6). The SDK restates these shapes by
// hand — it cannot import app source — so both halves are imported here as
// namespaces: the TYPES pin every prop shape, and the VALUES pin the export
// lists, which is the half a hand-written mirror actually loses.
import type * as React from 'react'
// Type-only on BOTH sides. The app halves are renderer modules whose graph
// reaches the workspace store (and, through it, the whole app); evaluating
// them inside this Node guard is not on. `keyof typeof` sees exactly the VALUE
// exports of a namespace — which is precisely what the import map bridges —
// so the export lists are pinned by `tsc -p tsconfig.drift.json`, the first
// step of test:sdk:drift, and the SDK's own list is re-checked against the
// emitted declarations at runtime below.
import type * as appSdkUi from '../../../src/renderer/src/modules/sdk-ui'
import type * as appSdkSurface from '../../../src/renderer/src/modules/sdk-surface'
// The SDK halves are TYPE-only imports on purpose: evaluating the published
// stub throws (that is its whole runtime job), so its export list is checked
// against the emitted declarations below instead of against a namespace.
import type * as sdkUi from '../src/ui'
import type * as sdkSurface from '../src/surface'
// Host API version, conversations and brokered credentials: the SDK side is
// read off the public index, the app side off its shared twins.
import type * as sdk from '../src/index'
import {
  HOST_API_MIN_SUPPORTED as SDK_HOST_API_MIN_SUPPORTED,
  HOST_API_VERSION as SDK_HOST_API_VERSION,
} from '../src/index'
import type * as appHostApi from '../../../src/shared/modules/host-api'
import {
  HOST_API_MIN_SUPPORTED as APP_HOST_API_MIN_SUPPORTED,
  HOST_API_VERSION as APP_HOST_API_VERSION,
} from '../../../src/shared/modules/host-api'
import type * as appConversation from '../../../src/shared/modules/conversation-service'
// The conversation contract itself. The SDK restates it rather than depending
// on the package, so its published tarball stays self-contained; these pins
// are what keep the restatement the contract.
import type * as protocol from '../../conversation-protocol/src/public'
import type * as appBrokers from '../../../src/shared/modules/brokers'

type Extends<A, B> = [A] extends [B] ? true : false
// Type identity via the generic-function-identity trick: detects added/removed
// optional properties, which mutual assignability cannot.
type IsExact<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false

// A failing assertion surfaces as `false is not assignable to true` on the
// exact line naming the drifted contract.
function expectType<_T extends true>(): void {}

// Exact mirrors (any structural difference, including optional-property
// drift, is a failure).
expectType<IsExact<AppCapabilityManifest, SdkCapabilityManifest>>()
expectType<IsExact<AppModuleEntry, SdkModuleEntry>>()
expectType<IsExact<AppModuleSignature, SdkModuleSignature>>()
expectType<IsExact<AppModuleFileDigests, SdkModuleFileDigests>>()
expectType<IsExact<AppModuleSource, SdkModuleSource>>()
expectType<IsExact<AppModuleTrustStatus, SdkModuleTrustStatus>>()
expectType<IsExact<AppCapabilityPermission, SdkCapabilityPermission>>()
expectType<IsExact<AppModuleBridgeRefusalCode, SdkModuleBridgeRefusalCode>>()
expectType<IsExact<AppFileDropPayload, SdkFileDropPayload>>()
expectType<IsExact<AppModuleNotification, SdkModuleNotification>>()
expectType<IsExact<AppModuleNotifyInput, SdkModuleNotifyInput>>()
expectType<IsExact<AppModuleNotificationSeverity, SdkModuleNotificationSeverity>>()
expectType<IsExact<AppSidecarSpec, SdkSidecarSpec>>()
expectType<IsExact<AppSidecarHandle, SdkSidecarHandle>>()
expectType<IsExact<AppSidecarRunState, SdkSidecarRunState>>()
expectType<IsExact<AppSidecarRuntimeStatus, SdkSidecarRuntimeStatus>>()
expectType<IsExact<AppSidecarStartOptions, SdkSidecarStartOptions>>()
expectType<IsExact<AppCommandScope, SdkCommandScope>>()
expectType<IsExact<AppCommandAvailability, SdkCommandAvailability>>()
// The published view module availability predicates are evaluated against:
// both processes must agree on its exact shape.
expectType<IsExact<AppModuleCommandContext, SdkModuleCommandContext>>()
expectType<IsExact<AppBacklogItemStatus, SdkBacklogItemStatus>>()
expectType<IsExact<AppBacklogItemLink, SdkBacklogItemLink>>()
expectType<IsExact<AppBacklogResolvedLink, SdkBacklogResolvedLink>>()
expectType<IsExact<AppSettingsSectionProps, SdkSettingsSectionProps>>()
// One app-side declaration (shared/modules/workspace-view) backs both process
// surfaces; the SDK mirror must match it exactly, and the main-side service
// provided under WorkspaceContextToken must match the SDK's contract.
expectType<IsExact<AppModuleWorkspaceView, SdkModuleWorkspaceView>>()
expectType<IsExact<AppModuleWorkspaceContextService, SdkWorkspaceContextService>>()
// Live runtime surfaces: the published views/inputs mirror the
// app-side declarations exactly; RendererHost method soundness rides the
// AppRendererHost extends SdkRendererHost assertion below.
expectType<IsExact<AppWorkspaceFileWatchEvent, SdkWorkspaceFileWatchEvent>>()
// The published 'light' | 'dark' must stay the app's own resolved scheme: the
// module host's watchColorScheme republishes exactly what useResolvedColorScheme
// resolves, and a third value added app-side has to be published or refused.
expectType<IsExact<AppModuleColorScheme, SdkModuleColorScheme>>()
// focusTab opens a chat or a file; pinned on the method so the input shape
// is checked wherever the host declares it.
expectType<IsExact<AppRendererHost['focusTab'], SdkRendererHost['focusTab']>>()
// …and the input itself, against the tab focuser that serves it.
expectType<IsExact<AppModuleFocusTabInput, SdkModuleFocusTabInput>>()
// Module storage: the SDK publishes the scoped service (getModuleStorage);
// the app provides the moduleId-first registry under 'core.module-storage'.
// The registry the app serves must accept exactly what the SDK helper
// forwards, and the shared result/error shapes must mirror exactly.
expectType<IsExact<AppModuleStorageErrorCode, SdkModuleStorageErrorCode>>()
expectType<IsExact<AppModuleStorageResult<{ found: boolean }>, SdkModuleStorageResult<{ found: boolean }>>>()
type SdkExpectedStorageRegistry = {
  [K in keyof SdkModuleStorageService]: (
    moduleId: string,
    ...args: Parameters<SdkModuleStorageService[K]>
  ) => ReturnType<SdkModuleStorageService[K]>
}
expectType<Extends<AppModuleStorageRegistry, SdkExpectedStorageRegistry>>()
expectType<IsExact<AppPreviewSlot, SdkPreviewSlot>>()
// Scheduled agents: the records an extension's scoped service hands back and
// takes are the app's own, field for field.
expectType<IsExact<AppScheduledAgentSchedule, SdkScheduledAgentSchedule>>()
expectType<IsExact<AppScheduledAgentAttachment, SdkScheduledAgentAttachment>>()
expectType<IsExact<AppScheduledAgentLastRun, SdkScheduledAgentLastRun>>()
expectType<IsExact<AppScheduledAgent, SdkScheduledAgent>>()
expectType<IsExact<AppScheduledAgentDraft, SdkScheduledAgentDraft>>()
expectType<IsExact<AppScheduledAgentView, SdkScheduledAgentView>>()
expectType<IsExact<AppScheduledAgentWriteResult, SdkScheduledAgentWriteResult>>()

// MCP tool contributions: the wire shapes mirror exactly — an
// optional-property drift on a tool registration would silently change what
// external modules can put on the gateway — and the contribution method is
// pinned exactly (the one-directional host assertion below would let a
// parameter widening ride through unnoticed).
expectType<IsExact<AppMcpToolResult, SdkMcpToolResult>>()
expectType<IsExact<AppMcpToolRegistration, SdkMcpToolRegistration>>()
expectType<IsExact<AppMcpConnectionMetadata, SdkMcpConnectionMetadata>>()
expectType<IsExact<AppMcpConnectionContext, SdkMcpConnectionContext>>()
expectType<IsExact<AppMainHost['registerMcpTools'], SdkMainHost['registerMcpTools']>>()

// Module-owned skills (WP-D): the registration and result shapes mirror
// exactly — an optional-property drift here would silently change what a
// module may ship — and both host methods are pinned exactly, because the
// one-directional host assertion below would let a parameter widening through.
expectType<IsExact<AppModuleSkillTargetPolicy, SdkModuleSkillTargetPolicy>>()
expectType<IsExact<AppModuleSkillRegistration, SdkModuleSkillRegistration>>()
expectType<IsExact<AppEnsureSkillInstalledResult, SdkEnsureSkillInstalledResult>>()
expectType<IsExact<AppMainHost['registerSkills'], SdkMainHost['registerSkills']>>()
expectType<IsExact<AppMainHost['ensureSkillInstalled'], SdkMainHost['ensureSkillInstalled']>>()

// ── Main-host plumbing (settings, workspaces, storage, GitHub, skills, MCP) ──
// Each addition pinned exactly, for the reason the whole file gives.
// Skills: the exhaustive status vocabulary and the read-only check.
expectType<IsExact<AppModuleSkillStatus, SdkModuleSkillStatus>>()
expectType<IsExact<AppModuleSkillStatusResult, SdkModuleSkillStatusResult>>()
expectType<IsExact<AppMainHost['getSkillStatus'], SdkMainHost['getSkillStatus']>>()
// Storage: the change signal a watch delivers, and the module's own directory
// and asset paths on the host.
expectType<IsExact<AppModuleStorageChange, SdkModuleStorageChange>>()
expectType<IsExact<AppMainHost['getModuleDataDir'], SdkMainHost['getModuleDataDir']>>()
expectType<IsExact<AppMainHost['getAssetPath'], SdkMainHost['getAssetPath']>>()
// Workspaces: closed history on the main-side list, and the git read on both hosts.
expectType<IsExact<AppModuleWorkspaceListEntry, SdkModuleWorkspaceListEntry>>()
expectType<IsExact<AppModuleWorkspaceListOptions, SdkModuleWorkspaceListOptions>>()
expectType<IsExact<AppModuleWorkspaceGitRemote, SdkModuleWorkspaceGitRemote>>()
expectType<IsExact<AppModuleWorkspaceGitInfoResult, SdkModuleWorkspaceGitInfoResult>>()
expectType<IsExact<AppMainHost['getWorkspaceGitInfo'], SdkMainHost['getWorkspaceGitInfo']>>()
expectType<IsExact<AppRendererHost['getWorkspaceGitInfo'], SdkRendererHost['getWorkspaceGitInfo']>>()

// Host soundness: the app host handed to module code satisfies the SDK view.
expectType<Extends<AppMainHost, SdkMainHost>>()
expectType<Extends<AppRendererHost, SdkRendererHost>>()
// Host parity: the hosts a module is handed carry exactly the members the SDK
// publishes, no more. `Extends` alone lets the app grow a member no module can
// type (or keep one the SDK removed); anything first-party-only belongs on the
// host's internal type, not on these.
expectType<IsExact<keyof AppMainHost, keyof SdkMainHost>>()
expectType<IsExact<keyof AppRendererHost, keyof SdkRendererHost>>()
// Per-module workspace state: the accessor pair is the pinned SDK
// shape for module-owned workspace state — exact identity, because the
// one-directional host assertion above would let an optional-parameter or
// return-type widening ride through unnoticed.
expectType<IsExact<AppRendererHost['getWorkspaceModuleState'], SdkRendererHost['getWorkspaceModuleState']>>()
expectType<IsExact<AppRendererHost['setWorkspaceModuleState'], SdkRendererHost['setWorkspaceModuleState']>>()

// Registrability: every SDK-typed contribution remains valid for the app.
expectType<Extends<SdkWorkspacePanelComponent, AppWorkspacePanelComponent>>()
expectType<Extends<SdkWorkspaceTypeDefinition, AppWorkspaceTypeDefinition>>()
// Supervisors + run glyphs (published as sound narrowings): an SDK-typed
// supervisor mounts as an app supervisor; an SDK glyph result satisfies the
// app's glyph shape (the published state union is a stable subset of the
// shell vocabulary); and what the app passes a provider satisfies the
// published minimal input view.
expectType<Extends<SdkWorkspaceTypeSupervisor, AppWorkspaceTypeSupervisor>>()
expectType<Extends<SdkWorkspaceRunGlyph, AppWorkspaceRunGlyph>>()
expectType<Extends<AppWorkspaceRunGlyphProviderInput, SdkWorkspaceRunGlyphInput>>()
// Module creation steps: a plain `Extends` on the whole definition
// cannot catch a missing/renamed optional property, so the step and its two
// wire shapes are pinned exactly — the hub mounts the SDK-typed Component with
// exactly WorkspaceCreationStepProps, and createTemplate receives exactly
// WorkspaceTypeCreateContext.
expectType<IsExact<AppWorkspaceCreationStepProps, SdkWorkspaceCreationStepProps>>()
expectType<IsExact<AppWorkspaceTypeCreateContext, SdkWorkspaceTypeCreateContext>>()
expectType<IsExact<AppWorkspaceTypeCreationStep, SdkWorkspaceTypeCreationStep>>()
expectType<Extends<SdkWorkspaceLayoutTemplate, AppLayoutTemplate>>()
expectType<Extends<SdkModuleCommandDefinition, AppModuleCommandDefinition>>()
expectType<Extends<SdkBacklogItemAction, AppBacklogItemAction>>()
expectType<Extends<SdkFileAction, AppFileAction>>()
expectType<IsExact<AppFileActionEntry, SdkFileActionEntry>>()
expectType<IsExact<AppFileActionState, SdkFileActionState>>()
expectType<IsExact<AppDoorBadgeContribution, SdkDoorBadgeContribution>>()
expectType<IsExact<AppRendererHost['registerDoorBadge'], SdkRendererHost['registerDoorBadge']>>()
expectType<Extends<SdkNotificationActionProvider, AppNotificationActionProvider>>()
expectType<Extends<SdkNotificationAction, AppNotificationAction>>()
expectType<Extends<AppNotificationActionContext, SdkNotificationActionContext>>()
expectType<
  Extends<AppRendererHost['registerNotificationActionProvider'], SdkRendererHost['registerNotificationActionProvider']>
>()
// The published notification view is what a module may read; the shell passes
// a richer in-app notification (same narrowing as FileActionContext).
expectType<
  Extends<Parameters<AppNotificationActionProvider['resolveActions']>[0]['notification'], SdkNotificationActionView>
>()
expectType<Extends<SdkBacklogLinkProvider, AppBacklogLinkProvider>>()
expectType<Extends<SdkSettingsSectionDefinition, AppSettingsSectionDefinition>>()
expectType<Extends<SdkSidebarNavEntryDefinition, AppSidebarNavEntryDefinition>>()
// Global door surfaces and top bar items. Pinned exactly,
// not merely `Extends<Sdk…, App…>`: the one-directional form catches an SDK
// type that the host would reject, but NOT an app-side widening — drop `order`
// from the app's item definition and `Extends` still passes while the SDK keeps
// documenting an ordering the host no longer implements. The host-soundness
// assertion above does not close it either, because TS compares method
// parameters bivariantly. Same discipline as registerMcpTools below/above.
expectType<IsExact<AppGlobalSurfaceDefinition, SdkGlobalSurfaceDefinition>>()
expectType<IsExact<AppTopBarItemDefinition, SdkTopBarItemDefinition>>()
expectType<IsExact<AppRendererHost['registerGlobalSurface'], SdkRendererHost['registerGlobalSurface']>>()
expectType<IsExact<AppRendererHost['registerTopBarItem'], SdkRendererHost['registerTopBarItem']>>()
// Modal surfaces (doors→modals, 2026-09-01): same exact-pin discipline. The
// contributed pane row and the props the shell mounts the body with are pinned
// beside the definition (D7, 2026-09-10) — a launcher field the app validates
// but the SDK does not publish is a registration error module authors cannot
// see coming, and a prop the shell passes but the SDK omits is context a
// module cannot type.
expectType<IsExact<AppModalSurfaceDefinition, SdkModalSurfaceDefinition>>()
expectType<IsExact<AppModalSurfaceLauncher, SdkModalSurfaceLauncher>>()
expectType<IsExact<AppModalSurfaceComponentProps, SdkModalSurfaceComponentProps>>()
expectType<IsExact<AppRendererHost['registerModalSurface'], SdkRendererHost['registerModalSurface']>>()
// The openers a module calls for its OWN surfaces (the host refuses another
// module's id); a module draws its own trigger, so these are its only way in.
expectType<IsExact<AppRendererHost['openGlobalSurface'], SdkRendererHost['openGlobalSurface']>>()
expectType<IsExact<AppRendererHost['openModalSurface'], SdkRendererHost['openModalSurface']>>()

// Renderer host additions for module-owned surfaces (WP-C, 2026-09-10). Pinned
// exactly for the reason the whole file gives: the one-directional host
// assertion compares method parameters bivariantly, so a widened parameter or
// a dropped optional would ride through unnoticed.
expectType<IsExact<AppRendererHost['listWorkspaces'], SdkRendererHost['listWorkspaces']>>()
expectType<IsExact<AppRendererHost['watchWorkspaces'], SdkRendererHost['watchWorkspaces']>>()
expectType<IsExact<AppRendererHost['watchColorScheme'], SdkRendererHost['watchColorScheme']>>()

// ── The three module-boundary surfaces ──────────────────────────────
// Each is pinned exactly rather than by `Extends`, for the reason spelled out
// above: the one-directional host assertion compares method parameters
// bivariantly, so an app-side widening (or a dropped optional) would ride
// through unnoticed on all three.

// 1. Async workspace creation: the hook and both of its wire shapes.
expectType<IsExact<AppWorkspaceTypeCreateRequest, SdkWorkspaceTypeCreateRequest>>()
expectType<IsExact<AppWorkspaceTypeCreateHost, SdkWorkspaceTypeCreateHost>>()
expectType<
  IsExact<
    NonNullable<AppWorkspaceTypeDefinition['createWorkspace']>,
    NonNullable<SdkWorkspaceTypeDefinition['createWorkspace']>
  >
>()

// 2. App-level module state — the renderer-side, synchronously-readable scope
// above the per-workspace bag. The accessor trio is pinned like the workspace-state pair.
expectType<IsExact<AppRendererHost['getModuleAppState'], SdkRendererHost['getModuleAppState']>>()
expectType<IsExact<AppRendererHost['setModuleAppState'], SdkRendererHost['setModuleAppState']>>()
expectType<IsExact<AppRendererHost['watchModuleAppState'], SdkRendererHost['watchModuleAppState']>>()

// 3. The module-owned event channel: the emit half on MainHost, the subscribe
// half on RendererHost, and the envelope both processes agree on.
expectType<IsExact<AppModuleEventEnvelope, SdkModuleEventEnvelope>>()
expectType<IsExact<AppMainHost['emit'], SdkMainHost['emit']>>()
expectType<IsExact<AppRendererHost['subscribe'], SdkRendererHost['subscribe']>>()

// The entry contracts may be async: the main loader awaits what registerMain
// returns, so the SDK's export contract must be exactly what it accepts.
expectType<IsExact<ReturnType<NonNullable<AppCapabilityModule['registerMain']>>, ReturnType<SdkRegisterMain>>>()
expectType<IsExact<Parameters<SdkRegisterMain>, [host: SdkMainHost]>>()
expectType<IsExact<Parameters<SdkRegisterRenderer>, [host: SdkRendererHost]>>()
expectType<IsExact<ReturnType<SdkRegisterRenderer>, void | Promise<void>>>()

// ── Host API version, conversations, brokered credentials ──────────────────
// Every shape exact. The event, status and attachment types are the app's own
// conversation-runtime types on the app side, so these pin the SDK's hand
// restatement to what the chat runtime actually emits.
expectType<IsExact<appHostApi.HostCapability, sdk.HostCapability>>()
expectType<IsExact<appHostApi.HostApiCompatibility, sdk.HostApiCompatibility>>()
expectType<IsExact<AppMainHost['hostApiVersion'], SdkMainHost['hostApiVersion']>>()
expectType<IsExact<AppMainHost['supports'], SdkMainHost['supports']>>()
expectType<IsExact<AppRendererHost['hostApiVersion'], SdkRendererHost['hostApiVersion']>>()
expectType<IsExact<AppRendererHost['supports'], SdkRendererHost['supports']>>()
expectType<IsExact<AppRendererHost['openChat'], SdkRendererHost['openChat']>>()
expectType<IsExact<AppRendererHost['listChatRuntimes'], SdkRendererHost['listChatRuntimes']>>()

expectType<IsExact<appConversation.ModuleConversationEventType, sdk.ModuleConversationEventType>>()
expectType<IsExact<appConversation.ModuleConversationEvent, sdk.ModuleConversationEvent>>()
expectType<IsExact<appConversation.ModuleConversationStatus, sdk.ModuleConversationStatus>>()
expectType<IsExact<appConversation.ModuleConversationRef, sdk.ModuleConversationRef>>()
expectType<IsExact<appConversation.ModuleConversationSummary, sdk.ModuleConversationSummary>>()
expectType<IsExact<appConversation.ModuleConversationImageAttachment, sdk.ModuleConversationImageAttachment>>()
expectType<IsExact<appConversation.ModuleConversationPermissionPreset, sdk.ModuleConversationPermissionPreset>>()
expectType<IsExact<appConversation.ModuleConversationApprovalDecision, sdk.ModuleConversationApprovalDecision>>()
expectType<IsExact<appConversation.ModuleConversationErrorCode, sdk.ModuleConversationErrorCode>>()
expectType<IsExact<appConversation.ModuleConversationCreateInput, sdk.ModuleConversationCreateInput>>()
expectType<
  IsExact<
    appConversation.ModuleConversationResult<{ events: appConversation.ModuleConversationEvent[] }>,
    sdk.ModuleConversationResult<{ events: sdk.ModuleConversationEvent[] }>
  >
>()
expectType<IsExact<appConversation.ModuleConversationService, sdk.ModuleConversationService>>()
expectType<IsExact<appConversation.ModuleOpenChatInput, sdk.ModuleOpenChatInput>>()
expectType<IsExact<appConversation.ModuleOpenChatResult, sdk.ModuleOpenChatResult>>()
expectType<IsExact<appConversation.ModuleChatRuntimeOption, sdk.ModuleChatRuntimeOption>>()
expectType<IsExact<appConversation.ModuleConversationPlanDecision, sdk.ModuleConversationPlanDecision>>()
expectType<IsExact<appConversation.ModuleConversationPage, sdk.ModuleConversationPage>>()
expectType<IsExact<appConversation.ModuleConversationStreamFrame, sdk.ModuleConversationStreamFrame>>()
expectType<IsExact<appConversation.ModuleConversationFollowOptions, sdk.ModuleConversationFollowOptions>>()
expectType<IsExact<appConversation.ModuleConversationCommandOptions, sdk.ModuleConversationCommandOptions>>()

// Against the protocol package directly, so a change there fails here even
// where the app's module contract would let it through.
expectType<IsExact<protocol.ConversationEventType, sdk.ModuleConversationEventType>>()
expectType<IsExact<protocol.ConversationEvent, sdk.ModuleConversationEvent>>()
expectType<IsExact<protocol.ConversationSessionStatus, sdk.ModuleConversationStatus>>()
expectType<IsExact<protocol.ConversationWirePermissionPreset, sdk.ModuleConversationPermissionPreset>>()
expectType<IsExact<protocol.ConversationRequestDecision, sdk.ModuleConversationApprovalDecision>>()
expectType<IsExact<protocol.ConversationPlanDecision, sdk.ModuleConversationPlanDecision>>()
expectType<IsExact<protocol.ConversationPage, sdk.ModuleConversationPage>>()
expectType<IsExact<protocol.ConversationStreamFrame, sdk.ModuleConversationStreamFrame>>()
// What a module's create shares with the contract's create means the same.
expectType<
  IsExact<
    Pick<protocol.ConversationCreateRequest, keyof protocol.ConversationCreateRequest>,
    Pick<sdk.ModuleConversationCreateInput, keyof protocol.ConversationCreateRequest>
  >
>()

expectType<IsExact<appBrokers.ModuleSecretsError, sdk.ModuleSecretsError>>()
expectType<IsExact<appBrokers.ModuleSecretFetchInit, sdk.ModuleSecretFetchInit>>()
expectType<IsExact<appBrokers.ModuleSecretFetchResult, sdk.ModuleSecretFetchResult>>()
expectType<IsExact<appBrokers.ModuleSecretsService, sdk.ModuleSecretsService>>()
expectType<IsExact<appBrokers.ModuleGitHubRequest, sdk.ModuleGitHubRequest>>()
expectType<IsExact<appBrokers.ModuleGitHubResponse, sdk.ModuleGitHubResponse>>()
expectType<IsExact<appBrokers.ModuleGitHubService, sdk.ModuleGitHubService>>()
// GitHub broker additions (headers, conditional requests, read-only GraphQL, download).
expectType<IsExact<appBrokers.ModuleGitHubMediaType, sdk.ModuleGitHubMediaType>>()
expectType<IsExact<appBrokers.ModuleGitHubErrorCode, sdk.ModuleGitHubErrorCode>>()
expectType<IsExact<appBrokers.ModuleGitHubDownloadRequest, sdk.ModuleGitHubDownloadRequest>>()
expectType<IsExact<appBrokers.ModuleGitHubDownloadResponse, sdk.ModuleGitHubDownloadResponse>>()

// The moduleId-first registries the app provides must accept exactly what the
// SDK helpers forward (the same derivation the storage registry is pinned by).
type SdkExpectedRegistry<S> = {
  [K in keyof S]: S[K] extends (...args: infer A) => infer R ? (moduleId: string, ...args: A) => R : never
}
expectType<IsExact<appConversation.ModuleConversationRegistry, SdkExpectedRegistry<sdk.ModuleConversationService>>>()
expectType<IsExact<appBrokers.ModuleSecretsRegistry, SdkExpectedRegistry<sdk.ModuleSecretsService>>>()
expectType<IsExact<appBrokers.ModuleGitHubRegistry, SdkExpectedRegistry<sdk.ModuleGitHubService>>>()

// Companion agents. The app declares these shapes inline on the registry it
// serves under 'companion-agents.module-service', so they are read off it: the
// spec `attach` takes, the handle it returns, and what the handle's methods
// take and give. Exact, except the event the handle streams: the SDK widens
// `type` to string so a new app event kind never breaks a compiled module, so
// the app's event must satisfy that view and carry exactly its fields.
type AppCompanionAttach = AppCompanionAgentsModuleRegistry['attach']
type AppCompanionAgentHandle = ReturnType<AppCompanionAttach>
type AppCompanionAgentEvent = Parameters<Parameters<AppCompanionAgentHandle['onEvent']>[0]>[0]
expectType<IsExact<Parameters<AppCompanionAttach>, [moduleId: string, spec: SdkCompanionAgentSpec]>>()
expectType<IsExact<keyof AppCompanionAgentsModuleRegistry, keyof SdkCompanionAgentsService>>()
expectType<IsExact<Omit<AppCompanionAgentHandle, 'onEvent'>, Omit<SdkCompanionAgentHandle, 'onEvent'>>>()
expectType<IsExact<keyof AppCompanionAgentHandle, keyof SdkCompanionAgentHandle>>()
expectType<IsExact<ReturnType<AppCompanionAgentHandle['status']>, SdkCompanionAgentStatus>>()
expectType<
  IsExact<Parameters<AppCompanionAgentHandle['runStructured']>[0], SdkCompanionRunStructuredOptions<unknown>>
>()
expectType<Extends<AppCompanionAgentEvent, SdkCompanionAgentEvent>>()
expectType<IsExact<keyof AppCompanionAgentEvent, keyof SdkCompanionAgentEvent>>()

// Callback-input soundness: what the app passes into module callbacks
// satisfies the SDK's (intentionally widened) read views.
expectType<Extends<AppBacklogItemActionContext, SdkBacklogItemActionContext>>()
expectType<Extends<AppFileActionContext, SdkFileActionContext>>()
expectType<Extends<AppBacklogLinkProviderInput, SdkBacklogLinkProviderInput>>()

// Mirrored value exports must stay identical (run via test:sdk:drift).
assert.deepEqual(
  [...SDK_BUNDLED_MODULE_IDS],
  [...APP_BUNDLED_MODULE_IDS],
  'BUNDLED_MODULE_IDS drifted between SDK and app',
)
assert.deepEqual(
  [...SDK_KNOWN_CAPABILITY_PERMISSIONS],
  [...APP_KNOWN_CAPABILITY_PERMISSIONS],
  'KNOWN_CAPABILITY_PERMISSIONS drifted between SDK and app',
)
assert.equal(SDK_FILE_DROP_MIME, APP_FILE_DROP_MIME, 'SPRINTENGINE_FILE_DROP_MIME drifted between SDK and app')
assert.equal(SDK_HOST_API_VERSION, APP_HOST_API_VERSION, 'HOST_API_VERSION drifted between SDK and app')
assert.equal(
  SDK_HOST_API_MIN_SUPPORTED,
  APP_HOST_API_MIN_SUPPORTED,
  'HOST_API_MIN_SUPPORTED drifted between SDK and app',
)

// Service-token keys. The SDK resolves every host service by a string key it
// keeps private (or publishes as a token), so the two sides agree only if the
// host provides a token under each of those exact strings. Checked both ways:
// every key below must appear in the emitted SDK, and the host must export a
// token with it — an accidental key edit on either side fails here instead of
// silently unresolving every module's requireService at runtime.
const SDK_SERVICE_TOKEN_KEYS = [
  'core.workspace',
  'core.workspace-context',
  'core.module-storage',
  'scheduled-agents.module-service',
  'companion-agents.module-service',
  'conversation.module-service',
  'module-secrets.module-service',
  'github.module-service',
] as const
const sdkRuntime = ['index.js', 'conversation.js', 'brokers.js']
  .map((file) => readFileSync(join(process.cwd(), 'packages', 'module-sdk', 'dist', file), 'utf8'))
  .join('\n')
const sdkKeysInRuntime = new Set(
  [...sdkRuntime.matchAll(/createServiceToken\(['"]([^'"]+)['"]\)|\{\s*key:\s*['"]([^'"]+)['"],?\s*\}/g)].map(
    (match) => match[1] ?? match[2],
  ),
)
assert.deepEqual(
  [...sdkKeysInRuntime].sort(),
  [...SDK_SERVICE_TOKEN_KEYS].sort(),
  'the SDK resolves a different set of host service keys than the drift guard pins',
)
const appServiceTokenKeys = new Set(
  Object.values(appServiceTokens as Record<string, unknown>)
    .filter((value): value is { key: string } => typeof (value as { key?: unknown } | null)?.key === 'string')
    .map((token) => token.key),
)
for (const key of SDK_SERVICE_TOKEN_KEYS) {
  assert.ok(appServiceTokenKeys.has(key), `the host provides no service token under the SDK key "${key}"`)
}
// The two tokens the SDK publishes by value are the same strings.
assert.equal(SdkWorkspaceServiceToken.key, 'core.workspace', 'WorkspaceServiceToken key drifted')
assert.equal(SdkWorkspaceContextToken.key, 'core.workspace-context', 'WorkspaceContextToken key drifted')
// The host tokens behind the SDK's conversation and broker helpers, by name,
// so a rename or a key edit on the host side fails here.
assert.equal(
  AppConversationModuleServiceToken.key,
  'conversation.module-service',
  'ConversationModuleServiceToken key drifted',
)
assert.equal(AppModuleSecretsServiceToken.key, 'module-secrets.module-service', 'ModuleSecretsServiceToken key drifted')
assert.equal(AppGitHubModuleServiceToken.key, 'github.module-service', 'GitHubModuleServiceToken key drifted')
// A third-party module may resolve exactly the keys the SDK resolves — every
// one of them, and nothing app-internal. The chat launch and the conversation
// runtime are first-party only: a module reaches chats through its own
// moduleId-scoped conversation service, never the unscoped host services.
assert.deepEqual(
  [...APP_THIRD_PARTY_SERVICE_KEYS].sort(),
  [...SDK_SERVICE_TOKEN_KEYS].sort(),
  'the third-party service allow-list differs from the keys the SDK resolves',
)
assert.equal(AppConversationLaunchServiceToken.key, 'core.conversation-launch')
assert.equal(AppConversationRuntimeToken.key, 'core.conversation-runtime')
for (const firstPartyOnly of [AppConversationLaunchServiceToken.key, AppConversationRuntimeToken.key]) {
  assert.equal(
    APP_THIRD_PARTY_SERVICE_KEYS.has(firstPartyOnly),
    false,
    `"${firstPartyOnly}" is first-party only and must not be on the third-party service allow-list`,
  )
}

// The published surface must not contain `any` (the source is also compiled
// with strict settings; this guards the emitted declarations the tarball ships).
// test:sdk:drift runs from the repo root (the script builds dist first).
const publicTypes = readFileSync(join(process.cwd(), 'packages', 'module-sdk', 'dist', 'index.d.ts'), 'utf8')
assert.equal((publicTypes.match(/\bany\b/g) ?? []).length, 0, 'SDK public declaration surface must not contain `any`')
assert.equal(
  publicTypes.includes('ScheduledAgentsModuleRegistry'),
  false,
  'SDK public surface must not expose the raw moduleId-first scheduled agents registry',
)
assert.equal(
  publicTypes.includes('ModuleStorageRegistry'),
  false,
  'SDK public surface must not expose the raw moduleId-first storage registry',
)
assert.equal(
  publicTypes.includes('moduleStorageToken'),
  false,
  'SDK public surface must not expose the raw storage registry token',
)
// The conversation and broker helpers keep their moduleId-first registries and
// tokens private the same way; their declarations ship as separate files.
for (const file of ['conversation.d.ts', 'brokers.d.ts', 'host-api.d.ts']) {
  const declarations = readFileSync(join(process.cwd(), 'packages', 'module-sdk', 'dist', file), 'utf8')
  assert.equal((declarations.match(/\bany\b/g) ?? []).length, 0, `SDK ${file} must not contain \`any\``)
  assert.equal(
    /Registry\b|ServiceToken\b/.test(declarations),
    false,
    `SDK ${file} must not expose a raw moduleId-first registry or its token`,
  )
}

// ── Bridged UI kit and door shell (D6) ───────────────────────────────────────
//
// Every bridged component is asserted twice over:
//   - `Extends<SdkProps, AppProps>` — soundness. Anything a module can write
//     against the published types is accepted by the component the host will
//     actually render. This is the assertion that must never be weakened.
//   - `IsExact` where the SDK restates the app's props verbatim, which is all
//     of them today. It catches the drift `Extends` cannot: a prop ADDED on
//     the app side, which a module would never be able to reach.
//
// The two runtime `Object.keys` checks below are the other half: a component
// added to (or dropped from) either side without the other fails here rather
// than at a module author's first `import`.

expectType<
  Extends<React.ComponentProps<typeof sdkUi.PrimaryButton>, React.ComponentProps<typeof appSdkUi.PrimaryButton>>
>()
expectType<
  IsExact<React.ComponentProps<typeof sdkUi.PrimaryButton>, React.ComponentProps<typeof appSdkUi.PrimaryButton>>
>()
expectType<Extends<React.ComponentProps<typeof sdkUi.GhostButton>, React.ComponentProps<typeof appSdkUi.GhostButton>>>()
expectType<IsExact<React.ComponentProps<typeof sdkUi.GhostButton>, React.ComponentProps<typeof appSdkUi.GhostButton>>>()
expectType<
  Extends<React.ComponentProps<typeof sdkUi.OutlineButton>, React.ComponentProps<typeof appSdkUi.OutlineButton>>
>()
expectType<
  IsExact<React.ComponentProps<typeof sdkUi.OutlineButton>, React.ComponentProps<typeof appSdkUi.OutlineButton>>
>()
expectType<Extends<React.ComponentProps<typeof sdkUi.LinkButton>, React.ComponentProps<typeof appSdkUi.LinkButton>>>()
expectType<IsExact<React.ComponentProps<typeof sdkUi.LinkButton>, React.ComponentProps<typeof appSdkUi.LinkButton>>>()
expectType<Extends<React.ComponentProps<typeof sdkUi.RowButton>, React.ComponentProps<typeof appSdkUi.RowButton>>>()
expectType<IsExact<React.ComponentProps<typeof sdkUi.RowButton>, React.ComponentProps<typeof appSdkUi.RowButton>>>()
expectType<Extends<React.ComponentProps<typeof sdkUi.Input>, React.ComponentProps<typeof appSdkUi.Input>>>()
expectType<IsExact<React.ComponentProps<typeof sdkUi.Input>, React.ComponentProps<typeof appSdkUi.Input>>>()
expectType<Extends<React.ComponentProps<typeof sdkUi.Textarea>, React.ComponentProps<typeof appSdkUi.Textarea>>>()
expectType<IsExact<React.ComponentProps<typeof sdkUi.Textarea>, React.ComponentProps<typeof appSdkUi.Textarea>>>()
expectType<Extends<React.ComponentProps<typeof sdkUi.Field>, React.ComponentProps<typeof appSdkUi.Field>>>()
expectType<IsExact<React.ComponentProps<typeof sdkUi.Field>, React.ComponentProps<typeof appSdkUi.Field>>>()
expectType<Extends<React.ComponentProps<typeof sdkUi.Select>, React.ComponentProps<typeof appSdkUi.Select>>>()
expectType<IsExact<React.ComponentProps<typeof sdkUi.Select>, React.ComponentProps<typeof appSdkUi.Select>>>()
expectType<
  Extends<React.ComponentProps<typeof sdkUi.SegmentedControl>, React.ComponentProps<typeof appSdkUi.SegmentedControl>>
>()
expectType<
  IsExact<React.ComponentProps<typeof sdkUi.SegmentedControl>, React.ComponentProps<typeof appSdkUi.SegmentedControl>>
>()
expectType<Extends<React.ComponentProps<typeof sdkUi.Banner>, React.ComponentProps<typeof appSdkUi.Banner>>>()
expectType<IsExact<React.ComponentProps<typeof sdkUi.Banner>, React.ComponentProps<typeof appSdkUi.Banner>>>()
// PanelHeader deliberately omits the host-internal tool identity vocabulary.
expectType<Extends<React.ComponentProps<typeof sdkUi.PanelHeader>, React.ComponentProps<typeof appSdkUi.PanelHeader>>>()
expectType<
  Extends<React.ComponentProps<typeof sdkUi.InlineNotice>, React.ComponentProps<typeof appSdkUi.InlineNotice>>
>()
expectType<
  IsExact<React.ComponentProps<typeof sdkUi.InlineNotice>, React.ComponentProps<typeof appSdkUi.InlineNotice>>
>()
expectType<Extends<React.ComponentProps<typeof sdkUi.EmptyState>, React.ComponentProps<typeof appSdkUi.EmptyState>>>()
expectType<IsExact<React.ComponentProps<typeof sdkUi.EmptyState>, React.ComponentProps<typeof appSdkUi.EmptyState>>>()
expectType<Extends<React.ComponentProps<typeof sdkUi.Spinner>, React.ComponentProps<typeof appSdkUi.Spinner>>>()
expectType<IsExact<React.ComponentProps<typeof sdkUi.Spinner>, React.ComponentProps<typeof appSdkUi.Spinner>>>()
expectType<Extends<React.ComponentProps<typeof sdkUi.StatusDot>, React.ComponentProps<typeof appSdkUi.StatusDot>>>()
expectType<IsExact<React.ComponentProps<typeof sdkUi.StatusDot>, React.ComponentProps<typeof appSdkUi.StatusDot>>>()
expectType<
  Extends<React.ComponentProps<typeof sdkUi.LifecycleGlyph>, React.ComponentProps<typeof appSdkUi.LifecycleGlyph>>
>()
expectType<
  IsExact<React.ComponentProps<typeof sdkUi.LifecycleGlyph>, React.ComponentProps<typeof appSdkUi.LifecycleGlyph>>
>()
expectType<Extends<React.ComponentProps<typeof sdkUi.Section>, React.ComponentProps<typeof appSdkUi.Section>>>()
expectType<IsExact<React.ComponentProps<typeof sdkUi.Section>, React.ComponentProps<typeof appSdkUi.Section>>>()
expectType<Extends<React.ComponentProps<typeof sdkUi.Drawer>, React.ComponentProps<typeof appSdkUi.Drawer>>>()
expectType<IsExact<React.ComponentProps<typeof sdkUi.Drawer>, React.ComponentProps<typeof appSdkUi.Drawer>>>()
expectType<Extends<React.ComponentProps<typeof sdkUi.Drawer.Body>, React.ComponentProps<typeof appSdkUi.Drawer.Body>>>()
expectType<
  Extends<React.ComponentProps<typeof sdkUi.TruncatedText>, React.ComponentProps<typeof appSdkUi.TruncatedText>>
>()
expectType<
  IsExact<React.ComponentProps<typeof sdkUi.TruncatedText>, React.ComponentProps<typeof appSdkUi.TruncatedText>>
>()
expectType<Extends<React.ComponentProps<typeof sdkUi.KbdChord>, React.ComponentProps<typeof appSdkUi.KbdChord>>>()
expectType<IsExact<React.ComponentProps<typeof sdkUi.KbdChord>, React.ComponentProps<typeof appSdkUi.KbdChord>>>()
expectType<
  Extends<
    React.ComponentProps<typeof sdkUi.CliModelPickerButton>,
    React.ComponentProps<typeof appSdkUi.CliModelPickerButton>
  >
>()
expectType<
  IsExact<
    React.ComponentProps<typeof sdkUi.CliModelPickerButton>,
    React.ComponentProps<typeof appSdkUi.CliModelPickerButton>
  >
>()

// Shared vocabulary the kit's props are written in.
expectType<IsExact<typeof sdkUi.FOCUS_RING_CLASS, string>>()
expectType<IsExact<sdkUi.Tone, appSdkUi.Tone>>()
expectType<IsExact<sdkUi.LifecycleState, appSdkUi.LifecycleState>>()
expectType<IsExact<sdkUi.FilterMenuGroup, appSdkUi.FilterMenuGroup>>()
expectType<IsExact<sdkUi.SegmentedControlItem, appSdkUi.SegmentedControlItem>>()
expectType<IsExact<sdkUi.SelectItem, appSdkUi.SelectItem>>()

// The door shell.
expectType<
  Extends<
    React.ComponentProps<typeof sdkSurface.GlobalSurfaceShell>,
    React.ComponentProps<typeof appSdkSurface.GlobalSurfaceShell>
  >
>()
expectType<
  IsExact<
    React.ComponentProps<typeof sdkSurface.GlobalSurfaceShell>,
    React.ComponentProps<typeof appSdkSurface.GlobalSurfaceShell>
  >
>()
expectType<
  Extends<
    React.ComponentProps<typeof sdkSurface.SurfaceCanvasState>,
    React.ComponentProps<typeof appSdkSurface.SurfaceCanvasState>
  >
>()
expectType<
  IsExact<
    React.ComponentProps<typeof sdkSurface.SurfaceCanvasState>,
    React.ComponentProps<typeof appSdkSurface.SurfaceCanvasState>
  >
>()
expectType<
  Extends<React.ComponentProps<typeof sdkSurface.SurfaceRail>, React.ComponentProps<typeof appSdkSurface.SurfaceRail>>
>()
expectType<
  IsExact<React.ComponentProps<typeof sdkSurface.SurfaceRail>, React.ComponentProps<typeof appSdkSurface.SurfaceRail>>
>()
expectType<IsExact<typeof sdkSurface.useSurfaceBackNav, typeof appSdkSurface.useSurfaceBackNav>>()
expectType<IsExact<sdkSurface.GlobalSurfaceBar, appSdkSurface.GlobalSurfaceBar>>()
expectType<IsExact<sdkSurface.SurfaceRailRow, appSdkSurface.SurfaceRailRow>>()
expectType<IsExact<sdkSurface.SurfaceRailSearch, appSdkSurface.SurfaceRailSearch>>()
expectType<IsExact<sdkSurface.SurfaceRailFilter, appSdkSurface.SurfaceRailFilter>>()
expectType<IsExact<sdkSurface.SurfaceRailScope, appSdkSurface.SurfaceRailScope>>()
expectType<IsExact<sdkSurface.SurfaceRailGroup, appSdkSurface.SurfaceRailGroup>>()
expectType<IsExact<sdkSurface.SurfaceRailNewAffordance, appSdkSurface.SurfaceRailNewAffordance>>()

// The published export lists. Only VALUE exports count: a type-only export
// costs a module nothing at runtime, a missing component costs it everything.
const SDK_UI_EXPORT_NAMES = [
  'GhostButton',
  'OutlineButton',
  'PrimaryButton',
  'Banner',
  'PanelHeader',
  'Drawer',
  'EmptyState',
  'Field',
  'Input',
  'Textarea',
  'InlineNotice',
  'KbdChord',
  'LifecycleGlyph',
  'LinkButton',
  'RowButton',
  'Section',
  'SegmentedControl',
  'Select',
  'Spinner',
  'StatusDot',
  'TruncatedText',
  'FOCUS_RING_CLASS',
  'CliModelPickerButton',
] as const
const SDK_SURFACE_EXPORT_NAMES = [
  'GlobalSurfaceShell',
  'useSurfaceBackNav',
  'SurfaceCanvasState',
  'SurfaceRail',
] as const

// Both bridges must export exactly this list — no more, no less, on either
// side. Adding a component to the host without publishing it leaves a name no
// module can import; publishing one the host does not bridge leaves an import
// that resolves to the throwing stub.
expectType<IsExact<keyof typeof appSdkUi, (typeof SDK_UI_EXPORT_NAMES)[number]>>()
expectType<IsExact<keyof typeof sdkUi, (typeof SDK_UI_EXPORT_NAMES)[number]>>()
expectType<IsExact<keyof typeof appSdkSurface, (typeof SDK_SURFACE_EXPORT_NAMES)[number]>>()
expectType<IsExact<keyof typeof sdkSurface, (typeof SDK_SURFACE_EXPORT_NAMES)[number]>>()

// The same two lists read off the EMITTED declarations, so the tarball a
// module author actually installs is checked, not just the source it was
// compiled from.
const declaredExports = (file: string): string[] => {
  const source = readFileSync(join(process.cwd(), 'packages', 'module-sdk', 'dist', file), 'utf8')
  return [...source.matchAll(/^export declare const ([A-Za-z_$][\w$]*)/gm)].map((match) => match[1]!)
}
assert.deepEqual(
  declaredExports('ui.d.ts').sort(),
  [...SDK_UI_EXPORT_NAMES].sort(),
  '@sprintengine/module-sdk/ui declares a different set of components than the host bridges',
)
assert.deepEqual(
  declaredExports('surface.d.ts').sort(),
  [...SDK_SURFACE_EXPORT_NAMES].sort(),
  '@sprintengine/module-sdk/surface declares a different set of exports than the host bridges',
)

// The subpaths must be reachable as published entry points, not just as files.
const sdkPackageJson = JSON.parse(
  readFileSync(join(process.cwd(), 'packages', 'module-sdk', 'package.json'), 'utf8'),
) as { exports: Record<string, { types: string; default: string } | undefined> }
for (const subpath of ['./ui', './surface']) {
  assert.ok(sdkPackageJson.exports[subpath], `@sprintengine/module-sdk is missing the "${subpath}" export`)
}

// And the runtime stub must refuse loudly, so an author who forgot to mark the
// specifier external learns it at the first import rather than from a blank
// door. Asserted against the EMITTED module, because that is what ships.
for (const subpath of ['ui', 'surface'] as const) {
  const runtime = readFileSync(join(process.cwd(), 'packages', 'module-sdk', 'dist', `${subpath}.js`), 'utf8')
  assert.ok(
    runtime.includes(
      `const HOST_PROVIDED_MESSAGE = '@sprintengine/module-sdk/${subpath} is provided by the host at runtime; mark it external in your bundler'`,
    ) && runtime.includes('throw new Error(HOST_PROVIDED_MESSAGE)'),
    `@sprintengine/module-sdk/${subpath} must throw its host-provided message when it is bundled instead of externalised`,
  )
}

console.log('module-sdk drift guard passed')
