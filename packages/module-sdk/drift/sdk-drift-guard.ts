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
  ModuleSignature as AppModuleSignature,
  ModuleSource as AppModuleSource,
  ModuleTrustStatus as AppModuleTrustStatus,
} from '../../../src/shared/modules/manifest'
import { BUNDLED_MODULE_IDS as APP_BUNDLED_MODULE_IDS } from '../../../src/shared/modules/manifest'
import type { CapabilityPermission as AppCapabilityPermission } from '../../../src/shared/modules/permissions'
import { KNOWN_CAPABILITY_PERMISSIONS as APP_KNOWN_CAPABILITY_PERMISSIONS } from '../../../src/shared/modules/permissions'
import type {
  ActionContext as AppActionContext,
  ActionKind as AppActionKind,
  AutomationActionProvider as AppAutomationActionProvider,
  AutomationDefinition as AppAutomationDefinition,
  AutomationDefinitionDraft as AppAutomationDefinitionDraft,
  AutomationDefinitionPatch as AppAutomationDefinitionPatch,
  AutomationRun as AppAutomationRun,
  AutomationRunEventStatus as AppAutomationRunEventStatus,
  AutomationRunEventTrigger as AppAutomationRunEventTrigger,
  AutomationRunStatus as AppAutomationRunStatus,
  AutomationsRunEvent as AppAutomationsRunEvent,
  AutomationStatus as AppAutomationStatus,
  ModuleAutomationsError as AppModuleAutomationsError,
  ModuleAutomationsService as AppModuleAutomationsService,
  AutomationTriggerPollContext as AppAutomationTriggerPollContext,
  AutomationTriggerPollEvent as AppAutomationTriggerPollEvent,
  AutomationTriggerPollResult as AppAutomationTriggerPollResult,
  AutomationTriggerProvider as AppAutomationTriggerProvider,
  JsonSchema as AppJsonSchema,
  ScheduleTriggerConfig as AppScheduleTriggerConfig,
  TriggerKind as AppTriggerKind,
} from '../../../src/shared/automations/contracts'
import type { ModuleBridgeRefusalCode as AppModuleBridgeRefusalCode } from '../../../src/shared/modules/bridge'
import type { ModuleEventEnvelope as AppModuleEventEnvelope } from '../../../src/shared/modules/events'
import type { FileDropPayload as AppFileDropPayload } from '../../../src/renderer/src/utils/terminalDrop'
import { MULTICODE_FILE_DROP_MIME as APP_FILE_DROP_MIME } from '../../../src/renderer/src/utils/terminalDrop'
import type {
  ModuleNotification as AppModuleNotification,
  ModuleNotificationSeverity as AppModuleNotificationSeverity,
  ModuleNotifyInput as AppModuleNotifyInput,
} from '../../../src/shared/modules/notifications'
import type { MainHost as AppMainHost, SidecarSpec as AppSidecarSpec } from '../../../src/main/module-host/main-host'
import type {
  McpConnectionContext as AppMcpConnectionContext,
  McpConnectionMetadata as AppMcpConnectionMetadata,
  McpToolRegistration as AppMcpToolRegistration,
  McpToolResult as AppMcpToolResult,
} from '../../../src/shared/modules/mcp-tools'
import type { ModuleWorkspaceContextService as AppModuleWorkspaceContextService } from '../../../src/main/modules/module-workspace-service'
import type {
  ModuleStorageErrorCode as AppModuleStorageErrorCode,
  ModuleStorageRegistry as AppModuleStorageRegistry,
  ModuleStorageResult as AppModuleStorageResult,
} from '../../../src/main/module-host/module-storage'
import {
  AgentSessionsModuleServiceToken as AppAgentSessionsModuleServiceToken,
  ModuleStorageToken as AppModuleStorageToken,
  WorkspaceContextToken as AppWorkspaceContextToken,
  WorkspaceServiceToken as AppWorkspaceServiceToken,
} from '../../../src/main/module-host/service-tokens'
import type {
  ModuleAgentExitEvent as AppModuleAgentExitEvent,
  ModuleAgentSessionRecord as AppModuleAgentSessionRecord,
  ModuleAgentSessionService as AppModuleAgentSessionService,
  ModuleAgentSpawnRequest as AppModuleAgentSpawnRequest,
  ModuleAgentSpawnResult as AppModuleAgentSpawnResult,
} from '../../../src/shared/modules/agent-sessions'
import type {
  AgentIdNamespaceDefinition as AppAgentIdNamespaceDefinition,
  BacklogItemAction as AppBacklogItemAction,
  BacklogItemActionContext as AppBacklogItemActionContext,
  BacklogLinkProvider as AppBacklogLinkProvider,
  BacklogLinkProviderInput as AppBacklogLinkProviderInput,
  GlobalSurfaceDefinition as AppGlobalSurfaceDefinition,
  ModalSurfaceDefinition as AppModalSurfaceDefinition,
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
import type { CommandAvailability as AppCommandAvailability, CommandScope as AppCommandScope, ModuleCommandContext as AppModuleCommandContext } from '../../../src/renderer/src/commands/types'
import type { ModuleWorkspaceView as AppModuleWorkspaceView } from '../../../src/shared/modules/workspace-view'
import type { WorkspaceFileWatchEvent as AppWorkspaceFileWatchEvent } from '../../../src/renderer/src/modules/workspace-file-watch'
import type { ModuleAgentSessionView as AppModuleAgentSessionView } from '../../../src/renderer/src/modules/agent-session-watch'
import type {
  ModuleAgentRuntimeOption as AppModuleAgentRuntimeOption,
  ModuleFocusTabInput as AppModuleFocusTabInput,
  ModuleSpawnAgentInput as AppModuleSpawnAgentInput,
  ModuleSpawnAgentResult as AppModuleSpawnAgentResult,
} from '../../../src/renderer/src/modules/agent-spawn'
import type {
  BacklogItemLink as AppBacklogItemLink,
  BacklogItemStatus as AppBacklogItemStatus,
  BacklogResolvedLink as AppBacklogResolvedLink,
} from '../../../src/renderer/src/utils/backlog'
import type { LayoutTemplate as AppLayoutTemplate, PreviewSlot as AppPreviewSlot } from '../../../src/renderer/src/types/workspace'

import type {
  AgentIdNamespaceDefinition as SdkAgentIdNamespaceDefinition,
  BacklogItemAction as SdkBacklogItemAction,
  BacklogItemActionContext as SdkBacklogItemActionContext,
  BacklogItemLink as SdkBacklogItemLink,
  BacklogItemStatus as SdkBacklogItemStatus,
  BacklogLinkProvider as SdkBacklogLinkProvider,
  BacklogLinkProviderInput as SdkBacklogLinkProviderInput,
  BacklogResolvedLink as SdkBacklogResolvedLink,
  CapabilityManifest as SdkCapabilityManifest,
  CapabilityPermission as SdkCapabilityPermission,
  CommandAvailability as SdkCommandAvailability,
  CommandScope as SdkCommandScope,
  ActionContext as SdkActionContext,
  ActionKind as SdkActionKind,
  AutomationActionProvider as SdkAutomationActionProvider,
  AutomationDefinition as SdkAutomationDefinition,
  AutomationDefinitionDraft as SdkAutomationDefinitionDraft,
  AutomationDefinitionPatch as SdkAutomationDefinitionPatch,
  AutomationRun as SdkAutomationRun,
  AutomationRunEventStatus as SdkAutomationRunEventStatus,
  AutomationRunEventTrigger as SdkAutomationRunEventTrigger,
  AutomationRunStatus as SdkAutomationRunStatus,
  AutomationsRunEvent as SdkAutomationsRunEvent,
  AutomationStatus as SdkAutomationStatus,
  ModuleAutomationsError as SdkModuleAutomationsError,
  ModuleAutomationsService as SdkModuleAutomationsService,
  AutomationTriggerPollContext as SdkAutomationTriggerPollContext,
  AutomationTriggerPollEvent as SdkAutomationTriggerPollEvent,
  AutomationTriggerPollResult as SdkAutomationTriggerPollResult,
  AutomationTriggerProvider as SdkAutomationTriggerProvider,
  JsonSchema as SdkJsonSchema,
  FileDropPayload as SdkFileDropPayload,
  GlobalSurfaceDefinition as SdkGlobalSurfaceDefinition,
  ModalSurfaceDefinition as SdkModalSurfaceDefinition,
  MainHost as SdkMainHost,
  McpConnectionContext as SdkMcpConnectionContext,
  McpConnectionMetadata as SdkMcpConnectionMetadata,
  McpToolRegistration as SdkMcpToolRegistration,
  McpToolResult as SdkMcpToolResult,
  ModuleBridgeRefusalCode as SdkModuleBridgeRefusalCode,
  ModuleEventEnvelope as SdkModuleEventEnvelope,
  ModuleCommandContext as SdkModuleCommandContext,
  ModuleCommandDefinition as SdkModuleCommandDefinition,
  ModuleEntry as SdkModuleEntry,
  ModuleNotification as SdkModuleNotification,
  ModuleNotificationSeverity as SdkModuleNotificationSeverity,
  ModuleNotifyInput as SdkModuleNotifyInput,
  ModuleSignature as SdkModuleSignature,
  ModuleSource as SdkModuleSource,
  ModuleAgentRuntimeOption as SdkModuleAgentRuntimeOption,
  ModuleAgentSessionView as SdkModuleAgentSessionView,
  ModuleFocusTabInput as SdkModuleFocusTabInput,
  ModuleSpawnAgentInput as SdkModuleSpawnAgentInput,
  ModuleAgentExitEvent as SdkModuleAgentExitEvent,
  ModuleAgentSessionRecord as SdkModuleAgentSessionRecord,
  ModuleAgentSessionService as SdkModuleAgentSessionService,
  ModuleAgentSpawnRequest as SdkModuleAgentSpawnRequest,
  ModuleAgentSpawnResult as SdkModuleAgentSpawnResult,
  ModuleSpawnAgentResult as SdkModuleSpawnAgentResult,
  ModuleStorageErrorCode as SdkModuleStorageErrorCode,
  ModuleStorageResult as SdkModuleStorageResult,
  ModuleStorageService as SdkModuleStorageService,
  ModuleTrustStatus as SdkModuleTrustStatus,
  ModuleWorkspaceView as SdkModuleWorkspaceView,
  WorkspaceContextService as SdkWorkspaceContextService,
  PreviewSlot as SdkPreviewSlot,
  RendererHost as SdkRendererHost,
  ScheduleTriggerConfig as SdkScheduleTriggerConfig,
  SettingsSectionDefinition as SdkSettingsSectionDefinition,
  SettingsSectionProps as SdkSettingsSectionProps,
  SidebarNavEntryDefinition as SdkSidebarNavEntryDefinition,
  SidecarSpec as SdkSidecarSpec,
  TopBarItemDefinition as SdkTopBarItemDefinition,
  TriggerKind as SdkTriggerKind,
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
import { BUNDLED_MODULE_IDS as SDK_BUNDLED_MODULE_IDS, KNOWN_CAPABILITY_PERMISSIONS as SDK_KNOWN_CAPABILITY_PERMISSIONS, MULTICODE_FILE_DROP_MIME as SDK_FILE_DROP_MIME } from '../src/index'

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
expectType<IsExact<AppModuleSource, SdkModuleSource>>()
expectType<IsExact<AppModuleTrustStatus, SdkModuleTrustStatus>>()
expectType<IsExact<AppCapabilityPermission, SdkCapabilityPermission>>()
expectType<IsExact<AppModuleBridgeRefusalCode, SdkModuleBridgeRefusalCode>>()
expectType<IsExact<AppFileDropPayload, SdkFileDropPayload>>()
expectType<IsExact<AppModuleNotification, SdkModuleNotification>>()
expectType<IsExact<AppModuleNotifyInput, SdkModuleNotifyInput>>()
expectType<IsExact<AppModuleNotificationSeverity, SdkModuleNotificationSeverity>>()
expectType<IsExact<AppSidecarSpec, SdkSidecarSpec>>()
expectType<IsExact<AppCommandScope, SdkCommandScope>>()
expectType<IsExact<AppCommandAvailability, SdkCommandAvailability>>()
// The published view module availability predicates are evaluated against
// (MC-1533): both processes must agree on its exact shape.
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
// Agent sessions (D5 / WP-B): the five public shapes a module's entry.main
// programs against. Exact, not assignable — an optional field added on one side
// only is precisely the drift a module author would discover as a spawn that
// silently ignored what they asked for.
expectType<IsExact<AppModuleAgentSessionRecord, SdkModuleAgentSessionRecord>>()
expectType<IsExact<AppModuleAgentSpawnRequest, SdkModuleAgentSpawnRequest>>()
expectType<IsExact<AppModuleAgentSpawnResult, SdkModuleAgentSpawnResult>>()
expectType<IsExact<AppModuleAgentExitEvent, SdkModuleAgentExitEvent>>()
expectType<IsExact<AppModuleAgentSessionService, SdkModuleAgentSessionService>>()
// Live runtime surfaces (MC-1535): the published views/inputs mirror the
// app-side declarations exactly; RendererHost method soundness rides the
// AppRendererHost extends SdkRendererHost assertion below.
expectType<IsExact<AppWorkspaceFileWatchEvent, SdkWorkspaceFileWatchEvent>>()
expectType<IsExact<AppModuleAgentSessionView, SdkModuleAgentSessionView>>()
expectType<IsExact<AppModuleAgentRuntimeOption, SdkModuleAgentRuntimeOption>>()
expectType<IsExact<AppModuleSpawnAgentInput, SdkModuleSpawnAgentInput>>()
expectType<IsExact<AppModuleSpawnAgentResult, SdkModuleSpawnAgentResult>>()
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
expectType<IsExact<AppJsonSchema, SdkJsonSchema>>()
expectType<IsExact<AppAutomationStatus, SdkAutomationStatus>>()
expectType<IsExact<AppAutomationRunStatus, SdkAutomationRunStatus>>()
expectType<IsExact<AppTriggerKind, SdkTriggerKind>>()
expectType<IsExact<AppScheduleTriggerConfig, SdkScheduleTriggerConfig>>()
expectType<IsExact<AppAutomationTriggerPollContext, SdkAutomationTriggerPollContext>>()
expectType<IsExact<AppAutomationTriggerPollEvent, SdkAutomationTriggerPollEvent>>()
expectType<IsExact<AppAutomationTriggerPollResult, SdkAutomationTriggerPollResult>>()
expectType<IsExact<AppAutomationTriggerProvider, SdkAutomationTriggerProvider>>()
expectType<IsExact<AppActionKind, SdkActionKind>>()
expectType<IsExact<AppAutomationRun, SdkAutomationRun>>()
expectType<IsExact<AppAutomationDefinition, SdkAutomationDefinition>>()
expectType<IsExact<AppAutomationDefinitionDraft, SdkAutomationDefinitionDraft>>()
expectType<IsExact<AppAutomationDefinitionPatch, SdkAutomationDefinitionPatch>>()
expectType<IsExact<AppAutomationRunEventStatus, SdkAutomationRunEventStatus>>()
expectType<IsExact<AppAutomationRunEventTrigger, SdkAutomationRunEventTrigger>>()
expectType<IsExact<AppAutomationsRunEvent, SdkAutomationsRunEvent>>()
expectType<IsExact<AppModuleAutomationsError, SdkModuleAutomationsError>>()
expectType<IsExact<AppModuleAutomationsService, SdkModuleAutomationsService>>()
expectType<IsExact<AppActionContext, SdkActionContext>>()
expectType<IsExact<AppAutomationActionProvider, SdkAutomationActionProvider>>()

// MCP tool contributions (MC-1855): the wire shapes mirror exactly — an
// optional-property drift on a tool registration would silently change what
// external modules can put on the gateway — and the contribution method is
// pinned exactly (the one-directional host assertion below would let a
// parameter widening ride through unnoticed).
expectType<IsExact<AppMcpToolResult, SdkMcpToolResult>>()
expectType<IsExact<AppMcpToolRegistration, SdkMcpToolRegistration>>()
expectType<IsExact<AppMcpConnectionMetadata, SdkMcpConnectionMetadata>>()
expectType<IsExact<AppMcpConnectionContext, SdkMcpConnectionContext>>()
expectType<IsExact<AppMainHost['registerMcpTools'], SdkMainHost['registerMcpTools']>>()

// Host soundness: the app host handed to module code satisfies the SDK view.
expectType<Extends<AppMainHost, SdkMainHost>>()
expectType<Extends<AppRendererHost, SdkRendererHost>>()
// Per-module workspace state (MC-1573): the accessor pair is the pinned SDK
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
// Module creation steps (MC-1534): a plain `Extends` on the whole definition
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
expectType<Extends<SdkBacklogLinkProvider, AppBacklogLinkProvider>>()
expectType<Extends<SdkSettingsSectionDefinition, AppSettingsSectionDefinition>>()
expectType<Extends<SdkSidebarNavEntryDefinition, AppSidebarNavEntryDefinition>>()
// Global door surfaces (MC-1854) and top bar items (MC-1861). Pinned exactly,
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
// Modal surfaces (doors→modals, 2026-09-01): same exact-pin discipline.
expectType<IsExact<AppModalSurfaceDefinition, SdkModalSurfaceDefinition>>()
expectType<IsExact<AppRendererHost['registerModalSurface'], SdkRendererHost['registerModalSurface']>>()

// ── The four module-boundary surfaces (MC-2090) ──────────────────────────────
// Each is pinned exactly rather than by `Extends`, for the reason spelled out
// above: the one-directional host assertion compares method parameters
// bivariantly, so an app-side widening (or a dropped optional) would ride
// through unnoticed on all four.

// 1. Async workspace creation: the hook and both of its wire shapes.
expectType<IsExact<AppWorkspaceTypeCreateRequest, SdkWorkspaceTypeCreateRequest>>()
expectType<IsExact<AppWorkspaceTypeCreateHost, SdkWorkspaceTypeCreateHost>>()
expectType<IsExact<
  NonNullable<AppWorkspaceTypeDefinition['createWorkspace']>,
  NonNullable<SdkWorkspaceTypeDefinition['createWorkspace']>
>>()

// 2. Module-owned agent-id namespaces.
expectType<IsExact<AppAgentIdNamespaceDefinition, SdkAgentIdNamespaceDefinition>>()
expectType<IsExact<AppRendererHost['registerAgentIdNamespace'], SdkRendererHost['registerAgentIdNamespace']>>()

// 3. App-level module state — the renderer-side, synchronously-readable scope
// above the per-workspace bag. The accessor trio is pinned like MC-1573's pair.
expectType<IsExact<AppRendererHost['getModuleAppState'], SdkRendererHost['getModuleAppState']>>()
expectType<IsExact<AppRendererHost['setModuleAppState'], SdkRendererHost['setModuleAppState']>>()
expectType<IsExact<AppRendererHost['watchModuleAppState'], SdkRendererHost['watchModuleAppState']>>()

// 4. The module-owned event channel: the emit half on MainHost, the subscribe
// half on RendererHost, and the envelope both processes agree on.
expectType<IsExact<AppModuleEventEnvelope, SdkModuleEventEnvelope>>()
expectType<IsExact<AppMainHost['emit'], SdkMainHost['emit']>>()
expectType<IsExact<AppRendererHost['subscribe'], SdkRendererHost['subscribe']>>()

// Callback-input soundness: what the app passes into module callbacks
// satisfies the SDK's (intentionally widened) read views.
expectType<Extends<AppBacklogItemActionContext, SdkBacklogItemActionContext>>()
expectType<Extends<AppBacklogLinkProviderInput, SdkBacklogLinkProviderInput>>()

// Mirrored value exports must stay identical (run via test:sdk:drift).
assert.deepEqual([...SDK_BUNDLED_MODULE_IDS], [...APP_BUNDLED_MODULE_IDS], 'BUNDLED_MODULE_IDS drifted between SDK and app')
assert.deepEqual(
  [...SDK_KNOWN_CAPABILITY_PERMISSIONS],
  [...APP_KNOWN_CAPABILITY_PERMISSIONS],
  'KNOWN_CAPABILITY_PERMISSIONS drifted between SDK and app'
)
assert.equal(SDK_FILE_DROP_MIME, APP_FILE_DROP_MIME, 'MULTICODE_FILE_DROP_MIME drifted between SDK and app')

// Service-token keys the SDK mirrors as private literals: pin the app side to
// the documented strings so an accidental key edit fails here instead of
// silently unresolving every module's requireService at runtime.
assert.equal(AppWorkspaceServiceToken.key, 'core.workspace', 'WorkspaceServiceToken key drifted')
assert.equal(AppWorkspaceContextToken.key, 'core.workspace-context', 'WorkspaceContextToken key drifted')
assert.equal(AppModuleStorageToken.key, 'core.module-storage', 'ModuleStorageToken key drifted')
assert.equal(
  AppAgentSessionsModuleServiceToken.key,
  'agent-sessions.module-service',
  'AgentSessionsModuleServiceToken key drifted'
)

// The published surface must not contain `any` (the source is also compiled
// with strict settings; this guards the emitted declarations the tarball ships).
// test:sdk:drift runs from the repo root (the script builds dist first).
const publicTypes = readFileSync(join(process.cwd(), 'packages', 'module-sdk', 'dist', 'index.d.ts'), 'utf8')
assert.equal(
  (publicTypes.match(/\bany\b/g) ?? []).length,
  0,
  'SDK public declaration surface must not contain `any`'
)
assert.equal(
  publicTypes.includes('AutomationsProviderRegistryToken'),
  false,
  'SDK public surface must not expose the raw Automations provider registry token'
)
assert.equal(
  publicTypes.includes('AutomationsProviderRegistry'),
  false,
  'SDK public surface must not expose the raw Automations provider registry contract'
)
assert.equal(
  publicTypes.includes('AutomationsModuleRegistry'),
  false,
  'SDK public surface must not expose the raw moduleId-first Automations service registry'
)
assert.equal(
  publicTypes.includes('ModuleStorageRegistry'),
  false,
  'SDK public surface must not expose the raw moduleId-first storage registry'
)
assert.equal(
  publicTypes.includes('moduleStorageToken'),
  false,
  'SDK public surface must not expose the raw storage registry token'
)

console.log('module-sdk drift guard passed')
