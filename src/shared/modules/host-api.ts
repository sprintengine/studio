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
  'notifications',
  // Agents, conversations and scheduled agents.
  'companion-tools',
  'conversation-replies',
  'text-generation',
  'conversation-worktrees',
  'chat-runtimes',
  'scheduled-agent-runs',
])

export function hostSupports(capability: HostCapability): boolean {
  return HOST_CAPABILITIES.has(capability)
}
