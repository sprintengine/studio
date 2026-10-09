// The host services a third-party module may resolve, and what each needs.
//
// Every SDK helper that reaches the host (`getConversationService`,
// `getModuleStorage`, …) and every published token (`WorkspaceContextToken`, …)
// resolves one service key. This table says, for each, which permission the
// manifest must declare and which module provides it, so a scaffolded
// project's smoke test and the `/testing` fakes check the same rules the host
// applies instead of keeping copies that go stale.
//
// A test in the app repository (packages/module-sdk/test/service-requirements.test.ts)
// fails when a key the SDK resolves is missing here, or when the host's
// third-party allow-list differs, so a new service cannot ship without its row.

import type { CapabilityPermission } from './index.js'

export type ModuleServiceRequirement = {
  /** The key the helper resolves with `host.requireService`. */
  key: string
  /** The SDK helper or token a module reaches it through. */
  via: string
  /** Any one of these must be declared in the manifest. */
  permissions: readonly CapabilityPermission[]
  /**
   * The bundled module that provides it. A module that resolves the service at
   * the top of `registerMain` lists it in `dependsOn` (or one that depends on
   * it — `scheduled-agents` reaches `agent-runtime`), so the provider
   * registers first.
   */
  providedBy: string
  /**
   * Whether the host refuses a call without the permission (`permission_missing`,
   * or a throw where a call has no failure shape). The rest are disclosure: the
   * host does not check them, but the person was told.
   */
  checked: boolean
}

export const MODULE_SERVICE_REQUIREMENTS: readonly ModuleServiceRequirement[] = [
  {
    key: 'core.workspace',
    via: 'WorkspaceServiceToken',
    permissions: ['ipc:workspace-write'],
    providedBy: 'agent-runtime',
    checked: false,
  },
  {
    key: 'core.workspace-context',
    via: 'WorkspaceContextToken',
    permissions: ['ipc:workspace-read'],
    providedBy: 'agent-runtime',
    checked: false,
  },
  {
    key: 'core.module-storage',
    via: 'getModuleStorage',
    permissions: ['storage'],
    providedBy: 'agent-runtime',
    checked: false,
  },
  {
    key: 'scheduled-agents.module-service',
    via: 'getScheduledAgentsService',
    permissions: ['scheduled-agents.manage'],
    providedBy: 'scheduled-agents',
    checked: false,
  },
  {
    key: 'companion-agents.module-service',
    via: 'getCompanionAgentsService',
    permissions: ['agents:companion'],
    providedBy: 'agent-runtime',
    checked: true,
  },
  {
    key: 'conversation.module-service',
    via: 'getConversationService',
    permissions: ['conversation:read', 'conversation:operate'],
    providedBy: 'agent-runtime',
    checked: true,
  },
  {
    key: 'module-secrets.module-service',
    via: 'getSecretsService',
    permissions: ['secrets'],
    providedBy: 'agent-runtime',
    checked: true,
  },
  {
    key: 'github.module-service',
    via: 'getGitHubService',
    permissions: ['github'],
    providedBy: 'agent-runtime',
    checked: true,
  },
  {
    key: 'backlog.module-service',
    via: 'getBacklogService',
    // Reads need `backlog.read` and writes `backlog.write`; each call is checked.
    permissions: ['backlog.read', 'backlog.write'],
    providedBy: 'agent-runtime',
    checked: true,
  },
  {
    key: 'usage.module-service',
    via: 'getUsageService',
    permissions: ['usage:read'],
    providedBy: 'agent-runtime',
    checked: true,
  },
  {
    key: 'activity.module-service',
    via: 'getActivityService',
    permissions: ['conversation:read-all'],
    providedBy: 'agent-runtime',
    checked: true,
  },
]

/**
 * The bundled modules a `dependsOn` entry reaches, itself included: naming
 * `scheduled-agents` also orders a module after `agent-runtime`.
 */
export const MODULE_DEPENDENCY_CHAINS: Readonly<Record<string, readonly string[]>> = {
  'agent-runtime': ['agent-runtime'],
  'scheduled-agents': ['scheduled-agents', 'agent-runtime'],
}

/** The requirement for `key`, or undefined for a key the SDK does not publish. */
export function moduleServiceRequirement(key: string): ModuleServiceRequirement | undefined {
  return MODULE_SERVICE_REQUIREMENTS.find((requirement) => requirement.key === key)
}

/** Whether a manifest's `dependsOn` orders the module after `provider`. */
export function dependsOnReaches(dependsOn: readonly string[] | undefined, provider: string): boolean {
  return (dependsOn ?? []).some((dependency) =>
    (MODULE_DEPENDENCY_CHAINS[dependency] ?? [dependency]).includes(provider),
  )
}
