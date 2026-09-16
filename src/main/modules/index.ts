import type { CapabilityModule } from '../module-host/load-modules'
import { createAutomationsModule, type AutomationsModuleOptions } from './automations-module'
import { mobileRelayModule } from './mobile-relay-module'

export type BundledMainModuleOptions = {
  automations: AutomationsModuleOptions
}

// Bundled main-process capability modules, in registration-priority order.
// Features migrate onto the kernel one at a time; this list grows as each is
// extracted from the static register-*-ipc / app-services wiring.
//
// Note: memory-graph and dev-tools have no main module — their backends
// (knowledge graph, filesystem) are foundational, always registered in
// register-core-ipc; only their renderer panels are capability modules.
export function createBundledMainModules(options: BundledMainModuleOptions): CapabilityModule[] {
  return [
    createAutomationsModule(options.automations),
    mobileRelayModule,
  ]
}
