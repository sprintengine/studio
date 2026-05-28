import { registerMemoryActivityIpc } from '../ipc/memory-activity-ipc'
import { registerMemoryIpc } from '../ipc/memory-ipc'
import type { CapabilityModule } from '../module-host/load-modules'

// First feature migrated onto the capability-module kernel. It's a leaf: one
// renderer panel, one store slice, no sidecar, no dependents — the safe proof
// that registration through the host is behavior-identical to the old direct
// `registerMemoryIpc(ipcMain)` calls in register-core-ipc.ts.
export const memoryModule: CapabilityModule = {
  manifest: {
    id: 'memory-graph',
    displayName: 'Memory Graph',
    version: 1,
    publisher: 'multicode',
    category: 'insight',
    summary: 'Knowledge-graph view of workspace memory plus live activity synapses.',
    defaultEnabled: true,
  },
  registerMain(host) {
    registerMemoryIpc(host.ipcMain)
    registerMemoryActivityIpc(host.ipcMain)
  },
}
