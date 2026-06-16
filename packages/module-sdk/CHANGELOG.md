# Changelog

## 0.3.0 — 2026-06-15

BYO-CLI plugin authoring and programmatic workspace creation.

- New CLI plugin authoring surface: `CliPluginManifest` (the `plugin.json`
  contract for adding an agent CLI), `validateCliPluginManifest` /
  `parseCliPluginManifest` (pure structural pre-flight validator that agrees
  with the app's loader), and the supporting token types (`CliLaunchSpec`,
  `CliResumeSpec`, `CliPromptInjection`, `CliCompletionSpec`, `CliCapabilities`,
  `CliMcpConfigSpec`, `CliModelSelectionSpec`, `CliSkillIntegration`, …). A CLI
  plugin is a folder dropped into `~/.multicode/plugins/<id>/`, or installed
  from Settings → Agents → "Install CLI from folder".
- New `WorkspaceService` + `WorkspaceServiceToken`: resolve with
  `host.requireService(WorkspaceServiceToken)` from `entry.main` to create a
  workspace programmatically. The creation runs the same renderer flow as the
  UI and is confirmed on the workspace-sync bus before it resolves.
- `CommandAvailability` mirror synced with the app (`diagnosticsEnabled`).

## 0.2.0 — 2026-06-11

Signing toolchain for module authors.

- New `multicode-module` CLI (`bin`): `keygen` (ed25519 PKCS#8 PEM keypair),
  `pack` (validate + assemble an installable module directory; excludes
  node_modules, .git, and key material), `sign` (detached ed25519 signature
  over the canonical manifest, normalized manifest written back to disk),
  `verify` (checks a module directory exactly like the Multicode app).
- New `@multicode/module-sdk/signing` subpath export:
  `generateModuleSigningKeyPair`, `signManifest`, `verifyModuleSignature`,
  `manifestFingerprint`, `publicKeyFingerprint`. The Multicode app's verifier
  imports these same functions, so signer and verifier cannot drift.
- Manifest validation (`parseThirdPartyModuleManifest`,
  `validateThirdPartyModuleManifest`, `canonicalManifestPayload`) is now the
  single source of truth consumed by both the app and the CLI.

## 0.1.0 — 2026-06-10

Initial published surface.

- Manifest contracts: `CapabilityManifest`, `ModuleEntry`, `ModuleSignature`,
  `ModuleSource`, `ModuleTrustStatus`, `CapabilityCategory`,
  `BUNDLED_MODULE_IDS`.
- Permission disclosure vocabulary: `CapabilityPermission`,
  `KNOWN_CAPABILITY_PERMISSIONS` (tiered `ipc:*` scopes; `ipc:invoke` legacy
  broad scope).
- Main host: `MainHost`, `RegisterMain`, `IpcInvokeHandler`, `ServiceToken`,
  `createServiceToken`, `SidecarSpec` (including `startOn` spawn policy),
  startup/shutdown hooks.
- Notifications: `ModuleNotifyInput`, `ModuleNotification`,
  `ModuleNotificationSeverity`.
- Renderer host: `RendererHost`, `RegisterRenderer`, panel types, workspace
  type definition + layout JSON subset, Backlog item actions and link
  providers, module commands (`ModuleCommandDefinition`, scopes,
  availability), settings sections.
- `entry.preload` documented as reserved, not loaded in v1.
