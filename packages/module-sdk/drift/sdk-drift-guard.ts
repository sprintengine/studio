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
import type { FileDropPayload as AppFileDropPayload } from '../../../src/renderer/src/utils/terminalDrop'
import { MULTICODE_FILE_DROP_MIME as APP_FILE_DROP_MIME } from '../../../src/renderer/src/utils/terminalDrop'
import type {
  ModuleNotification as AppModuleNotification,
  ModuleNotificationSeverity as AppModuleNotificationSeverity,
  ModuleNotifyInput as AppModuleNotifyInput,
} from '../../../src/shared/modules/notifications'
import type { MainHost as AppMainHost, SidecarSpec as AppSidecarSpec } from '../../../src/main/module-host/main-host'
import type {
  BacklogItemAction as AppBacklogItemAction,
  BacklogItemActionContext as AppBacklogItemActionContext,
  BacklogLinkProvider as AppBacklogLinkProvider,
  BacklogLinkProviderInput as AppBacklogLinkProviderInput,
  ModuleCommandDefinition as AppModuleCommandDefinition,
  RendererHost as AppRendererHost,
  SettingsSectionDefinition as AppSettingsSectionDefinition,
  SettingsSectionProps as AppSettingsSectionProps,
  WorkspacePanelComponent as AppWorkspacePanelComponent,
  WorkspaceTypeDefinition as AppWorkspaceTypeDefinition,
} from '../../../src/renderer/src/modules/renderer-host'
import type { CommandAvailability as AppCommandAvailability, CommandScope as AppCommandScope } from '../../../src/renderer/src/commands/types'
import type {
  BacklogItemLink as AppBacklogItemLink,
  BacklogItemStatus as AppBacklogItemStatus,
  BacklogResolvedLink as AppBacklogResolvedLink,
} from '../../../src/renderer/src/utils/backlog'
import type { LayoutTemplate as AppLayoutTemplate, PreviewSlot as AppPreviewSlot } from '../../../src/renderer/src/types/workspace'

import type {
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
  MainHost as SdkMainHost,
  ModuleBridgeRefusalCode as SdkModuleBridgeRefusalCode,
  ModuleCommandDefinition as SdkModuleCommandDefinition,
  ModuleEntry as SdkModuleEntry,
  ModuleNotification as SdkModuleNotification,
  ModuleNotificationSeverity as SdkModuleNotificationSeverity,
  ModuleNotifyInput as SdkModuleNotifyInput,
  ModuleSignature as SdkModuleSignature,
  ModuleSource as SdkModuleSource,
  ModuleTrustStatus as SdkModuleTrustStatus,
  PreviewSlot as SdkPreviewSlot,
  RendererHost as SdkRendererHost,
  ScheduleTriggerConfig as SdkScheduleTriggerConfig,
  SettingsSectionDefinition as SdkSettingsSectionDefinition,
  SettingsSectionProps as SdkSettingsSectionProps,
  SidecarSpec as SdkSidecarSpec,
  TriggerKind as SdkTriggerKind,
  WorkspaceLayoutTemplate as SdkWorkspaceLayoutTemplate,
  WorkspacePanelComponent as SdkWorkspacePanelComponent,
  WorkspaceTypeDefinition as SdkWorkspaceTypeDefinition,
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
expectType<IsExact<AppBacklogItemStatus, SdkBacklogItemStatus>>()
expectType<IsExact<AppBacklogItemLink, SdkBacklogItemLink>>()
expectType<IsExact<AppBacklogResolvedLink, SdkBacklogResolvedLink>>()
expectType<IsExact<AppSettingsSectionProps, SdkSettingsSectionProps>>()
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

// Host soundness: the app host handed to module code satisfies the SDK view.
expectType<Extends<AppMainHost, SdkMainHost>>()
expectType<Extends<AppRendererHost, SdkRendererHost>>()

// Registrability: every SDK-typed contribution remains valid for the app.
expectType<Extends<SdkWorkspacePanelComponent, AppWorkspacePanelComponent>>()
expectType<Extends<SdkWorkspaceTypeDefinition, AppWorkspaceTypeDefinition>>()
expectType<Extends<SdkWorkspaceLayoutTemplate, AppLayoutTemplate>>()
expectType<Extends<SdkModuleCommandDefinition, AppModuleCommandDefinition>>()
expectType<Extends<SdkBacklogItemAction, AppBacklogItemAction>>()
expectType<Extends<SdkBacklogLinkProvider, AppBacklogLinkProvider>>()
expectType<Extends<SdkSettingsSectionDefinition, AppSettingsSectionDefinition>>()

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

console.log('module-sdk drift guard passed')
