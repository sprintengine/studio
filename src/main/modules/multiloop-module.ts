import { registerMultiloopIpc } from '../ipc/multiloop-ipc'
import type { CapabilityModule } from '../module-host/load-modules'
import { initializeMultiloopState } from '../multiloop-init'

// Multiloop as a capability module. Like Switchboard, its `multiloop_core`
// Python is spawned per command, so a disabled module (registering no IPC)
// never spawns it.
export const multiloopModule: CapabilityModule = {
  manifest: {
    id: 'multiloop',
    displayName: 'Multiloop',
    version: 1,
    publisher: 'multicode',
    category: 'orchestration',
    summary: 'Milestone-driven loop: roadmap, active work, blockers, and evidence.',
    defaultEnabled: true,
    dependsOn: ['agent-runtime'],
  },
  registerMain(host) {
    host.registerSidecar({
      id: 'multiloop-core',
      kind: 'python-on-demand',
      module: 'multiloop_core',
      description: 'Spawned per command; never runs while this module is disabled.',
    })
    registerMultiloopIpc(host.ipcMain, { initializeMultiloopState })
  },
}
