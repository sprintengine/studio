import { automationsModule, createAutomationsModule } from './automations-module';
import { mobileRelayModule } from './mobile-relay-module';
import { reviewModule } from './review-module';
import { roadmapModule } from './roadmap-module';
import { sprintEngineModule } from './sprint-engine-module';
import { switchboardModule } from './switchboard-module';
export function createBundledMainModules(options = {}) {
    return [
        switchboardModule,
        sprintEngineModule,
        reviewModule,
        options.automations ? createAutomationsModule(options.automations) : automationsModule,
        roadmapModule,
        mobileRelayModule,
    ];
}
// Bundled main-process capability modules, in registration-priority order.
// Features migrate onto the kernel one at a time; this list grows as each is
// extracted from the static register-*-ipc / app-services wiring.
//
// Note: memory-graph and dev-tools have no main module — their backends
// (knowledge graph, filesystem) are foundational, always registered in
// register-core-ipc; only their renderer panels are capability modules.
export const BUNDLED_MAIN_MODULES = createBundledMainModules();
