# Changelog

## Unreleased

- Per-module, per-workspace storage: `getModuleStorage(host)` →
  `{ get, set, delete, list }` scoped to your module, with host-owned file
  placement (workspace `.multi-code/modules/<moduleId>/<key>.json`, or
  per-user app data for global keys). JSON values with a 1 MB cap, keys
  `^[a-z0-9][a-z0-9._-]{0,63}$`, atomic write-then-rename, honest errors
  (`invalid_key` / `invalid_value` / `value_too_large` /
  `invalid_workspace_root` / `io_error`; a corrupt record reads as
  `io_error`, never silently missing). New `storage` disclosure permission.
  Main-side only in v1 — renderer access rides the module's own
  `host.invoke` channels.
- `BacklogItemLink` mirror caught up with the app: `target.taskId?` (the task
  inside a run target that owns the item), `priorStatus?` (item status to
  restore if the linked work is abandoned), and the `pending` value in
  `BacklogItemLinkStatus`.
- Workspace context resolution (id → root/name/mode): renderer
  `RendererHost.getWorkspace(workspaceId)` and main-side
  `WorkspaceContextToken` (`core.workspace-context`, always-on) both resolve a
  read-only `ModuleWorkspaceView` (`{ id, name, folderPath, mode }`). Unknown
  ids resolve `null`, never a throw. Disclosure permission:
  `ipc:workspace-read`. Replaces deriving the workspace root from Backlog item
  paths or drop payloads.

## 0.4.0 — 2026-07-07

Calendar-class workspace parity: a module's renderer can now reach its own
`entry.main` (IPC bridge), create and observe real automations (scoped
service + one-shot `at` cadence), enumerate and watch the Backlog, accept
Backlog/Files drags, and style against published theme tokens.

- File-drop drag-and-drop contract: `MULTICODE_FILE_DROP_MIME`,
  `FileDropPayload`, `setFileDropData`, `hasFileDropData` (the dragover-safe
  presence check), and the null-safe `readFileDropPayload` (missing entry,
  bad JSON, unknown version, or invalid shape ⇒ `null`, never a throw; file
  entries are rebuilt, dropping unknown properties). Backlog-panel and
  Files-tree drags are now a supported module surface, drift-guarded against
  the app implementation.
- Theme token contract: `THEME_TOKENS` + `ThemeToken` publish the CSS
  custom-property names guaranteed present in every app theme (chrome,
  border, text, accent, and semantic tone families). Names only — values are
  theme-specific and retuned freely. A repo gate verifies presence per theme.

- Backlog read API on `RendererHost`: `listBacklogItems(workspaceId)` and
  `watchBacklogItems(workspaceId, cb)` expose the workspace's Backlog as
  read-only `BacklogItemView`s, backed by the same shared scan + watcher the
  Backlog panel uses. `watch` fires with the current snapshot, then on every
  change; unsubscribe via the returned closure. Declare the `backlog.read`
  disclosure permission. Both methods fail with a named cause when the
  backlog module is disabled or absent.

- `ScheduleTriggerConfig` gains the one-shot `at` cadence:
  `{ type: 'at', datetime: 'YYYY-MM-DDTHH:mm' }` — local wall-clock resolved
  in the config's `timezone` (seconds optional and ignored; a trailing
  `Z`/offset is rejected). Fires exactly once; after the fire time the
  automation stays listed with no upcoming run. A wall-clock inside a DST
  spring-forward gap resolves to the first instant after the gap, matching
  daily/weekly.

- Scoped Automations service: `getAutomationsService(host)` returns a
  `ModuleAutomationsService` with owned CRUD (`create`/`update`/`delete`/
  `list`/`listRuns`) and ownership-filtered `onRunEvent`. New mirrored types:
  `AutomationDefinition`, `AutomationDefinitionDraft`,
  `AutomationDefinitionPatch`, `AutomationsRunEvent`,
  `AutomationRunEventStatus`, `AutomationRunEventTrigger`,
  `ModuleAutomationsError`, `ModuleAutomationsResult`. Every method returns a
  structured result (`invalid_workspace` covers roots the app does not have
  open); writes require the workspace folder to be open in the app.
  `AutomationDefinition` gains `ownerModuleId` (stamped server-side;
  module-created automations show a "via <module>" attribution in the panel,
  and open panels refresh live when a module writes). New
  `automations.manage` disclosure permission.

- `RendererHost.invoke(channel, payload?)`: renderer→module-main IPC bridge.
  A module's renderer code can now call channels its own `entry.main`
  registered via `MainHost.registerIpc`. Channels must be `<moduleId>:`-
  prefixed; the host routes only to third-party-owned channels whose module
  declares `ipc:invoke`. Refused invokes reject with an Error carrying a
  structured `code` (new exported type `ModuleBridgeRefusalCode`). A
  contract, not a security boundary — trust gating remains the boundary.

- Licensed MIT (`LICENSE` added, `license` field set, included in published
  files). Permits building and selling modules, including closed-source;
  covers this SDK package only, not the Multicode app or marketplace terms.
- New Automations provider authoring surface:
  `registerAutomationTrigger`, `registerAutomationAction`, provider/context
  types for trusted modules that declare `dependsOn: ['automations']`.
- `BUNDLED_MODULE_IDS` now includes `automations`, matching the app reserved-id
  set.
- `BacklogItemLink.type` now includes `agent`, matching the app's
  lifecycle-neutral working-agent links.
- Three additive Backlog disclosure scopes — `backlog.read`, `backlog.write`,
  `backlog.link.open` — added to `CapabilityPermission` and
  `KNOWN_CAPABILITY_PERMISSIONS`. Install-time disclosure vocabulary only (no
  runtime enforcement), consistent with the existing `ipc:*` tiers.

## 0.3.0 — 2026-06-15

BYO-CLI plugin authoring and programmatic workspace creation.

- New CLI plugin authoring surface: `CliPluginManifest` (the `plugin.json`
  contract for adding an agent CLI), `validateCliPluginManifest` /
  `parseCliPluginManifest`, and the supporting token types (`CliLaunchSpec`,
  `CliResumeSpec`, `CliPromptInjection`, `CliCompletionSpec`, `CliCapabilities`,
  `CliMcpConfigSpec`, `CliModelSelectionSpec`, `CliSkillIntegration`,
  `CliSkillInstallTarget`, `CliSkillInvocation`, …). A CLI plugin is a folder
  dropped into `~/.multicode/plugins/<id>/`, or installed from
  Settings → Agents → "Install CLI from folder".
- `validateCliPluginManifest` is the **single source of truth** for CLI
  manifest validation: the Multicode app loads a `plugin.json` by delegating to
  it (no separate in-app copy), so the authoring contract and the loader cannot
  drift. As part of consolidating the two former copies, `version` is now
  required to be a positive integer (the app previously accepted any number).
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
