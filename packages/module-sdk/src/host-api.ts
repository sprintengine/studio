// The host API version: one integer the app and a module agree on, so a module
// built against a newer contract is refused with a message instead of failing
// at the first call the host does not have.
//
// Pure (no Node APIs, no values imported from index) and safe in any runtime.

import type { CapabilityManifest } from './index.js'

/**
 * The host API this SDK describes. A module declares the version it was built
 * against as `engines.hostApi` in its manifest; the host loads it when that
 * number is within `[HOST_API_MIN_SUPPORTED, HOST_API_VERSION]`.
 */
export const HOST_API_VERSION = 1

/** The oldest host API a host still loads modules for. */
export const HOST_API_MIN_SUPPORTED = 1

/**
 * A feature a module can ask the running host about with `host.supports(...)`
 * before it relies on it. The version number says which contract a module was
 * built for; this says what the host in front of it actually provides today
 * (a service can be absent because its providing module is off). Unknown names
 * answer `false`, so a module may probe for capabilities newer than its SDK.
 */
export type HostCapability =
  | 'conversations'
  // The conversation service's controls: all four permission presets,
  // `setPermissionPreset`, `setModel` and approval `decision`s.
  | 'conversation-controls'
  // `follow` (a snapshot or the events after a cursor, a `synchronized`
  // fence, then live events) and a `commandId` on every mutating call.
  | 'conversation-streams'
  // `answerQuestion` and `resolvePlan`, each refused for a request of another kind.
  | 'conversation-requests'
  // The agent CLI's own `permissionMode` beside the preset, and `allowedTools` at `create`.
  | 'conversation-permissions'
  | 'chat.open'
  | 'companion-agents'
  // ── Agents, conversations and scheduled agents ──
  // A companion's structured run takes `tools` ('none' by default, 'ask',
  // 'auto'), its handle `respondToApproval`, and its engine a chat runtime id.
  | 'companion-tools'
  // `turn_completed` carries `text` and `usage`, and the conversation service
  // has `reply(ref, turnId?)`.
  | 'conversation-replies'
  // `getTextGenerationService(host).generate`: one prompt, no chat.
  | 'text-generation'
  // The conversation service's `create` takes `worktree`.
  | 'conversation-worktrees'
  // `RendererHost.openChat` takes `name` and `dedupeKey`, and a draft needs
  // only `chat:draft`. A renderer's, answered live like `chat.open`.
  | 'chat.open-options'
  // `MainHost.listChatRuntimes()`.
  | 'chat-runtimes'
  // Scheduled agents take `name` and `tag`, `lastRun` names its chat's
  // `agentId`, the service has `onRun`, and a run's chat summary carries
  // `scheduledAgentId` and `scheduledAgentTag`.
  | 'scheduled-agent-runs'
  | 'scheduled-agents'
  | 'secrets'
  | 'github'
  | 'storage'
  | 'mcp-tools'
  | 'skills'
  | 'module-assets'
  // `MainHost.notify` reaches the bell of every open window, with `target`
  // opening your own door. False where no client delivery is wired.
  | 'notifications'
  // The Backlog write API: `getBacklogService` in main, and the renderer's
  // `createBacklogItem` / `updateBacklogStatus` / … beside `listBacklogItems`.
  | 'backlog-write'
  // `getUsageService` and the renderer's `queryUsage` (permission `usage:read`).
  | 'usage'
  // `getActivityService` (permission `conversation:read-all`).
  | 'activity'
  // ── Shell surfaces & renderer host (all additive under host API 1) ──
  // Your `registerSidebarNavEntry` row is drawn as your door's row in the
  // Extensions drawer (entry id == surface id), handed the host's `badge`.
  | 'sidebar-nav-entries'
  // `registerDoorBadge({ rowId: <your surface id> })` counts on your door's row.
  | 'door-badges'
  // `RendererHost.toast(...)`; true once the window's toast region is wired.
  | 'toast'
  // `RendererHost.moduleId`.
  | 'module-id'
  // `ModuleCommandDefinition.run(context)` receives the `ModuleCommandContext`.
  | 'command-context'
  // `RendererHost.getActiveWorkspaceId()` and `watchActiveWorkspace(cb)`.
  | 'active-workspace'
  // `RendererHost.setSurfaceView(surfaceId, viewId)`.
  | 'surface-view'
  // `RendererHost.openExternal(url)`; true once the window's link opener is wired.
  | 'open-external'
  // The extended UI kit: TaskCard, BoardLane, ContextMenu/MenuItem,
  // DateTimeInput, Toggle, Chip, SafeMarkdown, SidebarNavButton, `Select`'s
  // `size`, an optional `SurfaceRail` `newAffordance`, and a
  // `CliModelPickerButton` that takes `listChatRuntimes()` as is.
  | 'ui-kit-extras'
  // `--chart-1` … `--chart-8` and `--chart-other` in THEME_TOKENS.
  | 'chart-tokens'
  // `entry.main` runs in the desktop's own main process, where `electron` can
  // be required. False wherever the main half runs in the Studio server, a
  // Node process with no Electron APIs; a module that cannot live without them
  // declares `requires.hostCapabilities: ['electron-main']` and runs only where
  // this is true.
  | 'electron-main'
  // ── Main-host plumbing: settings, workspaces, storage, GitHub, skills, MCP ──
  // `MainHost.getSkillStatus`: is a skill present, without writing it.
  | 'skill-status'
  // `McpConnectionMetadata.verified` on every module tool call, and core tool
  // name collisions refused at `registerMcpTools`.
  | 'mcp-verified-identity'
  // GitHub broker: allow-listed response `headers`, `ifNoneMatch` and `accept`.
  | 'github-headers'
  // GitHub broker: read-only `graphql(query, variables)`.
  | 'github-graphql'
  // GitHub broker: `download(route)` following GitHub's own storage redirect.
  | 'github-download'
  // Module storage: `list({ prefix })` and `getMany(keys)`.
  | 'storage-query'
  // Module storage: `watch({ workspaceRoot? }, cb)`.
  | 'storage-watch'
  // `MainHost.getModuleDataDir()`: a private directory for data past the value limit.
  | 'module-data-dir'
  // `MainHost.getAssetPath(relative)`: a verified file's path, for workers and the like.
  | 'main-asset-path'
  // `getWorkspaceGitInfo(workspaceId)` on both hosts.
  | 'workspace-git-info'
  // `WorkspaceContextService.list({ includeClosed })` and `open` on each entry.
  | 'workspace-history'
  // `MainHost.getModuleAppState` / `watchModuleAppState`: Settings values in entry.main.
  | 'main-app-state'
  | (string & {})

export type HostApiCompatibility =
  { ok: true } | { ok: false; code: 'host_api_missing' | 'host_api_too_new' | 'host_api_too_old'; message: string }

/**
 * Whether this host can load a module with this manifest. A third-party module
 * must declare `engines.hostApi`; a bundled (first-party) one ships with the
 * host it runs on, so an absent `engines` is compatible by construction.
 */
export function checkHostApiCompatibility(
  manifest: Pick<CapabilityManifest, 'engines' | 'source'>,
): HostApiCompatibility {
  const hostApi = manifest.engines?.hostApi
  if (hostApi === undefined) {
    if (manifest.source !== 'third-party') return { ok: true }
    return {
      ok: false,
      code: 'host_api_missing',
      message: `The module does not say which host API it was built for; add "engines": { "hostApi": ${HOST_API_VERSION} } to its manifest.`,
    }
  }
  // A manifest is JSON someone wrote by hand: `"1"` or `1.5` is no version at all.
  if (typeof hostApi !== 'number' || !Number.isInteger(hostApi)) {
    return {
      ok: false,
      code: 'host_api_missing',
      message: `The module's "engines.hostApi" must be a whole number, such as ${HOST_API_VERSION}.`,
    }
  }
  if (hostApi > HOST_API_VERSION) {
    return {
      ok: false,
      code: 'host_api_too_new',
      message: `The module needs host API ${hostApi}, and this version of the app provides ${HOST_API_VERSION}. Update the app to use it.`,
    }
  }
  if (hostApi < HOST_API_MIN_SUPPORTED) {
    return {
      ok: false,
      code: 'host_api_too_old',
      message: `The module was built for host API ${hostApi}, and this version of the app loads ${HOST_API_MIN_SUPPORTED} or newer. Rebuild it against a current SDK.`,
    }
  }
  return { ok: true }
}
