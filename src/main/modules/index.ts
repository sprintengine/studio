import type { CapabilityModule } from '../module-host/load-modules'
import { memoryModule } from './memory-module'
import { multiloopModule } from './multiloop-module'
import { switchboardModule } from './switchboard-module'

// Bundled main-process capability modules, in registration-priority order.
// Features migrate onto the kernel one at a time; this list grows as each is
// extracted from the static register-*-ipc / app-services wiring.
export const BUNDLED_MAIN_MODULES: CapabilityModule[] = [
  memoryModule,
  switchboardModule,
  multiloopModule,
]
