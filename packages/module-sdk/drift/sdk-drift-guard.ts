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
  ModuleStorageToken as AppModuleStorageToken,
  WorkspaceContextToken as AppWorkspaceContextToken,
  WorkspaceServiceToken as AppWorkspaceServiceToken,
} from '../../../src/main/module-host/service-tokens'
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

expectType<Extends<React.ComponentProps<typeof sdkUi.PrimaryButton>, React.ComponentProps<typeof appSdkUi.PrimaryButton>>>()
expectType<IsExact<React.ComponentProps<typeof sdkUi.PrimaryButton>, React.ComponentProps<typeof appSdkUi.PrimaryButton>>>()
expectType<Extends<React.ComponentProps<typeof sdkUi.GhostButton>, React.ComponentProps<typeof appSdkUi.GhostButton>>>()
expectType<IsExact<React.ComponentProps<typeof sdkUi.GhostButton>, React.ComponentProps<typeof appSdkUi.GhostButton>>>()
expectType<Extends<React.ComponentProps<typeof sdkUi.OutlineButton>, React.ComponentProps<typeof appSdkUi.OutlineButton>>>()
expectType<IsExact<React.ComponentProps<typeof sdkUi.OutlineButton>, React.ComponentProps<typeof appSdkUi.OutlineButton>>>()
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
expectType<Extends<React.ComponentProps<typeof sdkUi.SegmentedControl>, React.ComponentProps<typeof appSdkUi.SegmentedControl>>>()
expectType<IsExact<React.ComponentProps<typeof sdkUi.SegmentedControl>, React.ComponentProps<typeof appSdkUi.SegmentedControl>>>()
expectType<Extends<React.ComponentProps<typeof sdkUi.Banner>, React.ComponentProps<typeof appSdkUi.Banner>>>()
expectType<IsExact<React.ComponentProps<typeof sdkUi.Banner>, React.ComponentProps<typeof appSdkUi.Banner>>>()
expectType<Extends<React.ComponentProps<typeof sdkUi.InlineNotice>, React.ComponentProps<typeof appSdkUi.InlineNotice>>>()
expectType<IsExact<React.ComponentProps<typeof sdkUi.InlineNotice>, React.ComponentProps<typeof appSdkUi.InlineNotice>>>()
expectType<Extends<React.ComponentProps<typeof sdkUi.EmptyState>, React.ComponentProps<typeof appSdkUi.EmptyState>>>()
expectType<IsExact<React.ComponentProps<typeof sdkUi.EmptyState>, React.ComponentProps<typeof appSdkUi.EmptyState>>>()
expectType<Extends<React.ComponentProps<typeof sdkUi.Spinner>, React.ComponentProps<typeof appSdkUi.Spinner>>>()
expectType<IsExact<React.ComponentProps<typeof sdkUi.Spinner>, React.ComponentProps<typeof appSdkUi.Spinner>>>()
expectType<Extends<React.ComponentProps<typeof sdkUi.StatusDot>, React.ComponentProps<typeof appSdkUi.StatusDot>>>()
expectType<IsExact<React.ComponentProps<typeof sdkUi.StatusDot>, React.ComponentProps<typeof appSdkUi.StatusDot>>>()
expectType<Extends<React.ComponentProps<typeof sdkUi.LifecycleGlyph>, React.ComponentProps<typeof appSdkUi.LifecycleGlyph>>>()
expectType<IsExact<React.ComponentProps<typeof sdkUi.LifecycleGlyph>, React.ComponentProps<typeof appSdkUi.LifecycleGlyph>>>()
expectType<Extends<React.ComponentProps<typeof sdkUi.Section>, React.ComponentProps<typeof appSdkUi.Section>>>()
expectType<IsExact<React.ComponentProps<typeof sdkUi.Section>, React.ComponentProps<typeof appSdkUi.Section>>>()
expectType<Extends<React.ComponentProps<typeof sdkUi.Drawer>, React.ComponentProps<typeof appSdkUi.Drawer>>>()
expectType<IsExact<React.ComponentProps<typeof sdkUi.Drawer>, React.ComponentProps<typeof appSdkUi.Drawer>>>()
expectType<Extends<React.ComponentProps<typeof sdkUi.Drawer.Body>, React.ComponentProps<typeof appSdkUi.Drawer.Body>>>()
expectType<Extends<React.ComponentProps<typeof sdkUi.TruncatedText>, React.ComponentProps<typeof appSdkUi.TruncatedText>>>()
expectType<IsExact<React.ComponentProps<typeof sdkUi.TruncatedText>, React.ComponentProps<typeof appSdkUi.TruncatedText>>>()
expectType<Extends<React.ComponentProps<typeof sdkUi.KbdChord>, React.ComponentProps<typeof appSdkUi.KbdChord>>>()
expectType<IsExact<React.ComponentProps<typeof sdkUi.KbdChord>, React.ComponentProps<typeof appSdkUi.KbdChord>>>()
expectType<Extends<React.ComponentProps<typeof sdkUi.CliModelPickerButton>, React.ComponentProps<typeof appSdkUi.CliModelPickerButton>>>()
expectType<IsExact<React.ComponentProps<typeof sdkUi.CliModelPickerButton>, React.ComponentProps<typeof appSdkUi.CliModelPickerButton>>>()

// Shared vocabulary the kit's props are written in.
expectType<IsExact<typeof sdkUi.FOCUS_RING_CLASS, string>>()
expectType<IsExact<sdkUi.Tone, appSdkUi.Tone>>()
expectType<IsExact<sdkUi.LifecycleState, appSdkUi.LifecycleState>>()
expectType<IsExact<sdkUi.FilterMenuGroup, appSdkUi.FilterMenuGroup>>()
expectType<IsExact<sdkUi.SegmentedControlItem, appSdkUi.SegmentedControlItem>>()
expectType<IsExact<sdkUi.SelectItem, appSdkUi.SelectItem>>()

// The door shell.
expectType<Extends<React.ComponentProps<typeof sdkSurface.GlobalSurfaceShell>, React.ComponentProps<typeof appSdkSurface.GlobalSurfaceShell>>>()
expectType<IsExact<React.ComponentProps<typeof sdkSurface.GlobalSurfaceShell>, React.ComponentProps<typeof appSdkSurface.GlobalSurfaceShell>>>()
expectType<Extends<React.ComponentProps<typeof sdkSurface.SurfaceCanvasState>, React.ComponentProps<typeof appSdkSurface.SurfaceCanvasState>>>()
expectType<IsExact<React.ComponentProps<typeof sdkSurface.SurfaceCanvasState>, React.ComponentProps<typeof appSdkSurface.SurfaceCanvasState>>>()
expectType<Extends<React.ComponentProps<typeof sdkSurface.SurfaceRail>, React.ComponentProps<typeof appSdkSurface.SurfaceRail>>>()
expectType<IsExact<React.ComponentProps<typeof sdkSurface.SurfaceRail>, React.ComponentProps<typeof appSdkSurface.SurfaceRail>>>()
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
  'GhostButton', 'OutlineButton', 'PrimaryButton',
  'Banner', 'Drawer', 'EmptyState', 'Field', 'Input', 'Textarea', 'InlineNotice',
  'KbdChord', 'LifecycleGlyph', 'LinkButton', 'RowButton', 'Section',
  'SegmentedControl', 'Select', 'Spinner', 'StatusDot', 'TruncatedText',
  'FOCUS_RING_CLASS', 'CliModelPickerButton',
] as const
const SDK_SURFACE_EXPORT_NAMES = [
  'GlobalSurfaceShell', 'useSurfaceBackNav', 'SurfaceCanvasState', 'SurfaceRail',
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
  '@multicode/module-sdk/ui declares a different set of components than the host bridges'
)
assert.deepEqual(
  declaredExports('surface.d.ts').sort(),
  [...SDK_SURFACE_EXPORT_NAMES].sort(),
  '@multicode/module-sdk/surface declares a different set of exports than the host bridges'
)

// The subpaths must be reachable as published entry points, not just as files.
const sdkPackageJson = JSON.parse(
  readFileSync(join(process.cwd(), 'packages', 'module-sdk', 'package.json'), 'utf8')
) as { exports: Record<string, { types: string; default: string } | undefined> }
for (const subpath of ['./ui', './surface']) {
  assert.ok(sdkPackageJson.exports[subpath], `@multicode/module-sdk is missing the "${subpath}" export`)
}

// And the runtime stub must refuse loudly, so an author who forgot to mark the
// specifier external learns it at the first import rather than from a blank
// door. Asserted against the EMITTED module, because that is what ships.
for (const subpath of ['ui', 'surface'] as const) {
  const runtime = readFileSync(join(process.cwd(), 'packages', 'module-sdk', 'dist', `${subpath}.js`), 'utf8')
  assert.ok(
    runtime.includes(
      `const HOST_PROVIDED_MESSAGE = '@multicode/module-sdk/${subpath} is provided by the host at runtime; mark it external in your bundler'`
    ) && runtime.includes('throw new Error(HOST_PROVIDED_MESSAGE)'),
    `@multicode/module-sdk/${subpath} must throw its host-provided message when it is bundled instead of externalised`
  )
}

console.log('module-sdk drift guard passed')
