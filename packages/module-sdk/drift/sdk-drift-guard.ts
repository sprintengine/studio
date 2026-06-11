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
  MainHost as SdkMainHost,
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
  SettingsSectionDefinition as SdkSettingsSectionDefinition,
  SettingsSectionProps as SdkSettingsSectionProps,
  SidecarSpec as SdkSidecarSpec,
  WorkspaceLayoutTemplate as SdkWorkspaceLayoutTemplate,
  WorkspacePanelComponent as SdkWorkspacePanelComponent,
  WorkspaceTypeDefinition as SdkWorkspaceTypeDefinition,
} from '../src/index'
import { BUNDLED_MODULE_IDS as SDK_BUNDLED_MODULE_IDS, KNOWN_CAPABILITY_PERMISSIONS as SDK_KNOWN_CAPABILITY_PERMISSIONS } from '../src/index'

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

// The published surface must not contain `any` (the source is also compiled
// with strict settings; this guards the emitted declarations the tarball ships).
// test:sdk:drift runs from the repo root (the script builds dist first).
const publicTypes = readFileSync(join(process.cwd(), 'packages', 'module-sdk', 'dist', 'index.d.ts'), 'utf8')
assert.equal(
  (publicTypes.match(/\bany\b/g) ?? []).length,
  0,
  'SDK public declaration surface must not contain `any`'
)

console.log('module-sdk drift guard passed')
