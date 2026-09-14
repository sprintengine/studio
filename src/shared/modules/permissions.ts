// Tier 2 third-party capability modules: the permission vocabulary.
//
// A third-party module declares, in its manifest, the capabilities it needs. In
// the v1 security model (signing + trusted publisher, in-process execution — the
// IDE-plugin model), this list is install-time DISCLOSURE shown before you trust a
// module, not a runtime-enforced cage. Runtime enforcement (a permission broker)
// is only needed in a future open-ecosystem phase that runs non-trusted authors'
// code. No consent string, doc, or UI copy may imply enforcement. This is
// deliberately separate from the BYO-CLI `permissionPresets` (opaque launch-arg
// bundles for a CLI, not capability scopes for code).
//
// See docs/module-authors/permissions.md for the author-facing reference.
//
// ## The `ipc:*` tiers
//
// `ipc:invoke` originally disclosed the entire `window.api` surface in one
// opaque scope. The tiers below let an author disclose the user-meaningful area
// they actually touch. The tier → `window.api` area mapping (disclosure only,
// nothing is brokered at runtime):
//
// - `ipc:workspace-read` — observing workspace and project state: workspace-sync
//   snapshots/events (`workspaceSyncGetSnapshot`, `onWorkspaceSyncEvent`),
//   window state, git read models (`getGitStatus`, branches/history/graph/
//   worktree lists), backlog reads, Sprint Engine reads
//   and projections, knowledge/memory reads, terminal session lists
//   (`terminalList`, `terminalStatus`), workspace backup reads.
// - `ipc:workspace-write` — changing workspace and project state through
//   Multicode: `workspaceSyncDispatch`, filesystem mutation routes (`writefile`,
//   create/rename/copy/delete), git mutations (stage/commit/push/branch/
//   worktrees), backlog mutations, Sprint Engine task
//   mutations, workspace backup writes.
// - `ipc:agents` — launching and controlling agents and terminals:
//   `terminalSpawn`/`terminalWrite`/`terminalKill` and terminal event streams,
//   conversation provider sessions, Sprint Engine runner/roster controls,
//   soul prompts.
// - `ipc:settings` — reading and changing Multicode settings and integrations:
//   module enablement, third-party module install/trust, MCP catalog/sync,
//   skill packs, plugin and role/template registries, GitHub token, app
//   updates, mobile bridge settings, voice transcription settings.
//
// Surfaces outside every tier (window controls, dialogs, clipboard, auth/
// session, external-URL opening) are disclosed today only by the legacy broad
// scope. `ipc:invoke` remains valid for existing manifests and means "any
// internal API, including everything above"; the consent UI flags it as broad.
// It is also the declared gate for the renderer→module-main bridge
// (`RendererHost.invoke` → the module's own `registerIpc` channels; see
// shared/modules/bridge.ts) — the one place the main-side dispatcher actually
// checks the declaration, because the bridge is the highest-capability surface
// and the check is one map lookup. A module that only uses the bridge still
// declares `ipc:invoke`.
// Unknown scopes stay forward-compatible: they validate structurally and are
// surfaced verbatim as unrecognized.

export type CapabilityPermission =
  | 'filesystem:read-workspace'
  | 'filesystem:write-workspace'
  | 'filesystem:read-home'
  | 'process:spawn'
  | 'network'
  | 'ipc:workspace-read'
  | 'ipc:workspace-write'
  | 'ipc:agents'
  | 'ipc:settings'
  | 'ipc:invoke'
  // Backlog-focused disclosure scopes. Finer-grained than the broad
  // `ipc:workspace-read`/`ipc:workspace-write` areas Backlog reads and writes
  // already fall under; additive disclosure for modules built around Backlog.
  | 'backlog.read'
  | 'backlog.write'
  | 'backlog.link.open'
  // Create and manage the module's own automations through the SDK's scoped
  // Automations service. Disclosure-level like every other scope: the service
  // does not runtime-check it.
  | 'automations.manage'
  // Attach workspace-bound background (companion) agents through the SDK's
  // Companion Agents service. Unlike the disclosure-only scopes above, the
  // companion service DOES check this one explicitly at attach time (there is no
  // shared runtime gate to inherit), so a module must declare it to attach.
  | 'agents:companion'
  // Launch, prompt and stop the module's OWN agent terminals through the SDK's
  // scoped agent-sessions service. Runtime-checked like `agents:companion`, and
  // scoped further by agent-id namespace: a module reaches the sessions it
  // started and named, never another module's and never the user's.
  | 'agents:session'
  // Persist the module's own data through the SDK's scoped storage service
  // (host-placed: workspace `.sprintengine/modules/<id>/` or per-user app data).
  | 'storage'
  // Extensible: unknown scopes validate structurally but are flagged as unknown
  // so the consent UI can warn rather than silently grant something opaque.
  | (string & {})

export const KNOWN_CAPABILITY_PERMISSIONS: readonly string[] = [
  'filesystem:read-workspace',
  'filesystem:write-workspace',
  'filesystem:read-home',
  'process:spawn',
  'network',
  'ipc:workspace-read',
  'ipc:workspace-write',
  'ipc:agents',
  'ipc:settings',
  'ipc:invoke',
  'backlog.read',
  'backlog.write',
  'backlog.link.open',
  'automations.manage',
  'agents:companion',
  'agents:session',
  'storage',
]

// Plain, sentence-case descriptions for the install/trust consent prompt.
// Disclosure phrasing only — these describe what the module says it does,
// never what the app prevents.
const PERMISSION_DESCRIPTIONS: Record<string, string> = {
  'filesystem:read-workspace': 'Read files in the open workspace',
  'filesystem:write-workspace': 'Create and modify files in the open workspace',
  'filesystem:read-home': 'Read your Multicode configuration and home folder',
  'process:spawn': 'Run external programs on your machine',
  network: 'Make network requests',
  'ipc:workspace-read': 'See workspace, window, git, and task state through Multicode APIs',
  'ipc:workspace-write': 'Create and change workspaces, files, and tasks through Multicode APIs',
  'ipc:agents': 'Launch and control agents and terminals',
  'ipc:settings': 'Read and change Multicode settings and integrations',
  'ipc:invoke': "Call any of Multicode's internal APIs, including its own background code (broad scope)",
  'backlog.read': 'Read Backlog item details and source content',
  'backlog.write': 'Change Backlog item status, links, and metadata',
  'backlog.link.open': 'Open links and targets attached to Backlog items',
  'automations.manage': 'Create and manage its own scheduled automations',
  'agents:companion': 'Run its own background agents inside the workspace',
  'agents:session': 'Launch, prompt and stop its own agent terminals',
  storage: 'Save its own data in the workspace folder and app data',
}

export function isKnownCapabilityPermission(value: string): boolean {
  return KNOWN_CAPABILITY_PERMISSIONS.includes(value)
}

// The legacy everything-scope, and the declared gate for the renderer→module-
// main bridge (RendererHost.invoke). Kept valid so existing manifests do not
// break, and the consent UI flags it as broad; authors whose module does not
// use the bridge should declare the `ipc:*` tiers that match what they
// actually touch instead.
export function isBroadCapabilityPermission(value: string): boolean {
  return value === 'ipc:invoke'
}

// A human-readable line for the consent prompt; unknown scopes are surfaced
// verbatim with a marker so the user can see exactly what was requested.
export function describeCapabilityPermission(permission: string): string {
  return PERMISSION_DESCRIPTIONS[permission] ?? `Unrecognized capability: ${permission}`
}

// The permissions validator lives in the published SDK so the app and the
// `multicode-module` CLI validate manifests identically; re-exported here for
// app code.
export {
  validateCapabilityPermissions,
} from '../../../packages/module-sdk/src/manifest-validate'
