// Tier 2 third-party capability modules: the permission vocabulary.
//
// A third-party module declares, in its manifest, the capabilities it needs. In
// the v1 security model (signing + trusted publisher, in-process execution),
// this list is install-time DISCLOSURE shown before you trust a
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
//   worktree lists), backlog reads, knowledge/memory reads, terminal session
//   lists (`terminalList`, `terminalStatus`), workspace backup reads.
// - `ipc:workspace-write` — changing workspace and project state through the
//   studio: `workspaceSyncDispatch`, filesystem mutation routes (`writefile`,
//   create/rename/copy/delete), git mutations (stage/commit/push/branch/
//   worktrees), backlog mutations, workspace backup writes.
// - `ipc:settings` — reading and changing studio settings and integrations:
//   module enablement, third-party module install/trust, MCP catalog/sync,
//   skill packs, the plugin registry, GitHub token, app
//   updates, mobile bridge settings, voice transcription settings.
//
// Agents have no `ipc:*` tier: a module reaches them through its own chats
// (`conversation:read` / `conversation:operate`) and companions
// (`agents:companion`), never through the app's terminal APIs.
//
// Surfaces outside every tier (window controls, dialogs, clipboard, auth/
// session, external-URL opening) are disclosed today only by the legacy broad
// scope. `ipc:invoke` remains valid for existing manifests and means "any
// internal API, including everything above"; the consent UI flags it as broad.
//
// ## The own-module bridge
//
// `module:bridge` is the narrow gate for the renderer→module-main bridge
// (`RendererHost.invoke` → the module's own `registerIpc` channels; see
// shared/modules/bridge.ts): a module's window code talking to its own
// background code, and nothing of the app's. It is the one place the main-side
// dispatcher actually checks a declaration, because the bridge is the
// highest-capability surface and the check is one map lookup. `ipc:invoke`
// still opens the bridge, so a manifest written before the split keeps
// working, but a module that only bridges to itself declares `module:bridge`
// and its consent prompt stops saying "any of the app's internal APIs".
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
  | 'ipc:settings'
  | 'ipc:invoke'
  // The renderer→own-main bridge alone (`RendererHost.invoke` to the module's
  // own `registerIpc` channels), split out of `ipc:invoke`. Checked by the
  // bridge dispatcher, which also still accepts `ipc:invoke`.
  | 'module:bridge'
  // Backlog-focused disclosure scopes. Finer-grained than the broad
  // `ipc:workspace-read`/`ipc:workspace-write` areas Backlog reads and writes
  // already fall under; additive disclosure for modules built around Backlog.
  | 'backlog.read'
  | 'backlog.write'
  | 'backlog.link.open'
  // Create and manage the module's own scheduled agents through the SDK's
  // scoped service. Disclosure-level like every other scope: the service does
  // not runtime-check it.
  | 'scheduled-agents.manage'
  // Attach workspace-bound background (companion) agents through the SDK's
  // Companion Agents service. Unlike the disclosure-only scopes above, the
  // companion service DOES check this one explicitly at attach time (there is no
  // shared runtime gate to inherit), so a module must declare it to attach.
  | 'agents:companion'
  // Persist the module's own data through the SDK's scoped storage service
  // (host-placed: workspace sidecar `modules/<id>/` or per-user app data).
  | 'storage'
  // Read the conversations the module started through the SDK's scoped
  // conversation service: their live events, transcripts and list.
  | 'conversation:read'
  // Start, prompt, interrupt and stop the module's own conversations, and open
  // a chat in the renderer (`RendererHost.openChat`). Implies read.
  | 'conversation:operate'
  // Run those conversations on `bypass`, where the agent asks before nothing,
  // and start them with tools the agent uses without asking (`allowedTools`).
  // Without it a module's chats go no looser than `auto`, whatever it asks
  // for; checked on every create and every preset switch.
  | 'conversation:bypass'
  // Store secrets the host sends only to origins the module named with them,
  // never handing the value back to module code.
  | 'secrets'
  // Call the GitHub API with the user's sign-in; the host attaches the token
  // and never hands it over.
  | 'github'
  // Contribute tools to the Studio MCP gateway (`MainHost.registerMcpTools`),
  // which agents in any workspace can then call.
  | 'mcp:tools'
  // ── Backlog, usage and activity services ──
  // Read token usage of every agent session on this machine — Studio's chats
  // and the agent CLIs' own session logs — through the SDK's usage service.
  // Checked on every call.
  | 'usage:read'
  // Read every Studio chat on this machine, read-only: chat summaries and the
  // person's prompts with the end of each reply (never tool output), through
  // the SDK's activity service. Checked on every call, and flagged as broad in
  // the consent prompt.
  | 'conversation:read-all'
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
  'ipc:settings',
  'ipc:invoke',
  // The renderer→own-main bridge, split out of `ipc:invoke`.
  'module:bridge',
  'backlog.read',
  'backlog.write',
  'backlog.link.open',
  'scheduled-agents.manage',
  'agents:companion',
  'storage',
  'conversation:read',
  'conversation:operate',
  'conversation:bypass',
  'secrets',
  'github',
  'mcp:tools',
  // Backlog, usage and activity services.
  'usage:read',
  'conversation:read-all',
]

// Plain, sentence-case descriptions for the install/trust consent prompt.
// Disclosure phrasing only — these describe what the module says it does,
// never what the app prevents.
const PERMISSION_DESCRIPTIONS: Record<string, string> = {
  'filesystem:read-workspace': 'Read files in the open workspace',
  'filesystem:write-workspace': 'Create and modify files in the open workspace',
  'filesystem:read-home': 'Read your app configuration and home folder',
  'process:spawn': 'Run external programs on your machine',
  network: 'Make network requests',
  'ipc:workspace-read': "See workspace, window, git, and task state through the app's APIs",
  'ipc:workspace-write': "Create and change workspaces, files, and tasks through the app's APIs",
  'ipc:settings': 'Read and change app settings and integrations',
  'ipc:invoke': "Call any of the app's internal APIs, including its own background code (broad scope)",
  'module:bridge': 'Let its window code talk to its own background code',
  'backlog.read': 'Read Backlog item details and source content',
  'backlog.write': 'Change Backlog item status, triage, links, and metadata, and create new items',
  'backlog.link.open': 'Open links and targets attached to Backlog items',
  'scheduled-agents.manage': 'Schedule agents of its own that start a chat on a timer',
  'agents:companion': 'Run its own background agents inside the workspace',
  storage: 'Save its own data in the workspace folder and app data',
  'conversation:read': 'Read the chats it started, including everything the agent says in them',
  'conversation:operate': 'Start chats with agents, send them messages, and stop them',
  'conversation:bypass': 'Let the agents in its chats edit files and run commands without asking you first',
  secrets: 'Store API keys and send them to the sites it names (the key is never shown back to the extension)',
  github: 'Use your GitHub sign-in to call the GitHub API (the token is never shown to the extension)',
  'mcp:tools': 'Add tools that agents in your workspaces can call',
  'usage:read': 'See token usage and cost of every agent session on this machine',
  'conversation:read-all': 'Read every chat on this machine, including what you and the agents wrote (broad scope)',
}

export function isKnownCapabilityPermission(value: string): boolean {
  return KNOWN_CAPABILITY_PERMISSIONS.includes(value)
}

// The legacy everything-scope. Kept valid so existing manifests do not break
// (it still opens the renderer→module-main bridge), and the consent UI flags
// it as broad; authors declare `module:bridge` for the bridge and the `ipc:*`
// tiers that match what they actually touch instead.
//
// `conversation:read-all` is broad for the other reason: it reads what the
// person wrote in every chat, so the prompt marks it the same way.
const BROAD_CAPABILITY_PERMISSIONS: ReadonlySet<string> = new Set(['ipc:invoke', 'conversation:read-all'])

export function isBroadCapabilityPermission(value: string): boolean {
  return BROAD_CAPABILITY_PERMISSIONS.has(value)
}

// A human-readable line for the consent prompt; unknown scopes are surfaced
// verbatim with a marker so the user can see exactly what was requested.
export function describeCapabilityPermission(permission: string): string {
  return PERMISSION_DESCRIPTIONS[permission] ?? `Unrecognized capability: ${permission}`
}

// The permissions validator lives in the published SDK so the app and the
// `sprintengine-module` CLI validate manifests identically; re-exported here for
// app code.
export { validateCapabilityPermissions } from '../../../packages/module-sdk/src/manifest-validate'
