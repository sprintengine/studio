// The host API version and what this host provides behind it.
//
// The version, its floor and the compatibility check live in the published SDK
// so the app and the `sprintengine-module` CLI agree on one number; they are
// re-exported here for app code. The capability table is the host's own: what
// `supports()` answers on every MainHost and RendererHost.

import type { HostCapability } from '../../../packages/module-sdk/src/host-api'

export {
  HOST_API_MIN_SUPPORTED,
  HOST_API_VERSION,
  checkHostApiCompatibility,
  type HostApiCompatibility,
  type HostCapability,
} from '../../../packages/module-sdk/src/host-api'

// Only what exists today. A capability joins this list in the same change that
// makes it real, so `supports()` never promises a service nobody provides.
// `chat.open` is not here: it is a renderer's, and true only once the window's
// shell has registered its chat opener (renderer-host.ts answers it live).
// The same goes for every capability whose answer depends on wiring rather
// than on this build: `notifications` (main-host.ts: a client delivery is
// wired; renderer-host.ts: the window's bell is), `toast` and
// `open-external` (renderer-host.ts: the window's toast region and link
// opener are).
const HOST_CAPABILITIES: ReadonlySet<HostCapability> = new Set<HostCapability>([
  'conversations',
  'conversation-controls',
  'conversation-streams',
  'conversation-requests',
  'conversation-permissions',
  'secrets',
  'github',
  'companion-agents',
  'scheduled-agents',
  'storage',
  'mcp-tools',
  'skills',
  'module-assets',
  // Backlog, usage and activity services (main/module-host/module-backlog.ts,
  // main/usage, main/module-host/module-activity.ts).
  'backlog-write',
  'usage',
  'activity',
  // Shell surfaces & renderer host: real in every window of this build.
  'sidebar-nav-entries',
  'door-badges',
  'module-id',
  'command-context',
  'active-workspace',
  'surface-view',
  'ui-kit-extras',
  'chart-tokens',
  // Main-host plumbing: settings, workspaces, storage, GitHub, skills, MCP.
  'skill-status',
  'mcp-verified-identity',
  'github-headers',
  'github-graphql',
  'github-download',
  'storage-query',
  'storage-watch',
  'module-data-dir',
  'main-asset-path',
  'workspace-git-info',
  'workspace-history',
  'main-app-state',
])

export function hostSupports(capability: HostCapability): boolean {
  return HOST_CAPABILITIES.has(capability)
}
