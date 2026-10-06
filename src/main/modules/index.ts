import type { CapabilityModule } from '../module-host/load-modules'
import type { StudioPlatform } from '../../server/platform/platform'
import { createScheduledAgentsModule } from './scheduled-agents-module'

// Bundled main-process capability modules, in registration-priority order.
// Features migrate onto the kernel one at a time; this list grows as each is
// extracted from the static register-*-ipc / app-services wiring.
//
// Note: memory-graph and dev-tools have no main module — their backends
// (knowledge graph, filesystem) are foundational, always registered in
// register-core-ipc; only their renderer panels are capability modules.
//
// `getModulePermissions` answers for every module the app assembled, the
// bundled ones included, so it is read late: it may be built after this list.
export function createBundledMainModules(
  platform: StudioPlatform,
  getModulePermissions: (moduleId: string) => readonly string[] | undefined,
): CapabilityModule[] {
  return [createScheduledAgentsModule(platform, getModulePermissions)]
}
