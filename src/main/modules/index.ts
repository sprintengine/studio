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
export function createBundledMainModules(platform: StudioPlatform): CapabilityModule[] {
  return [createScheduledAgentsModule(platform)]
}
