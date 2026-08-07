import { registerMobileBridgeIpc } from '../ipc/mobile-bridge-ipc'
import { discoverMobileSprintEngineStatePaths } from '../mobile-sprintengine-discovery'
import { MobileBridge } from '../mobile/bridge'
import { MobileSprintEngineSnapshotService } from '../mobile/sprintengine/snapshot'
import { MulticodeAuthToken, TerminalRuntimeToken, WorkspaceSyncServiceToken } from '../module-host/service-tokens'
import { listKnownWorkspaceRoots, uniqueResolvedRoots } from '../workspace-roots'
import type { CapabilityModule } from '../module-host/load-modules'

// Mobile relay as a capability module. The bridge pairs the desktop app with a
// phone over an encrypted relay; it depends on the agent runtime (terminal
// command service) and auth (relay session + access token), both consumed
// through the service bridge rather than direct imports.
//
// Disabling the module means its `registerMain` never runs: the MobileBridge is
// never constructed, its relay client never connects, and the mobile IPC is
// never registered — the renderer's Mobile settings tab is gated to match. The
// relay client is a network sidecar gated by the module being enabled, not a
// spawned process.
export const mobileRelayModule: CapabilityModule = {
  manifest: {
    id: 'mobile-relay',
    displayName: 'Mobile Relay',
    version: 1,
    publisher: 'multicode',
    category: 'connectivity',
    summary: 'Pair a phone with the desktop app over an encrypted relay to drive agents remotely.',
    defaultEnabled: true,
    // Needs the agent runtime (terminal command service) and auth, both seeded
    // by the agent-runtime core module via the service bridge.
    dependsOn: ['agent-runtime'],
  },
  registerMain(host) {
    const terminalRuntime = host.requireService(TerminalRuntimeToken)
    const multicodeAuth = host.requireService(MulticodeAuthToken)
    const workspaceSync = host.requireService(WorkspaceSyncServiceToken)

    // The phone's scope is read from main's own registry (MC-2158). The renderer
    // push this used to union in is gone: its only remaining job was supplying
    // folders the routing-placeholder model had lost, and there are no
    // placeholders left — every record main holds carries its real folder,
    // whether or not a window has ever opened it this session.
    const resolveWorkspaceRoots = (): string[] =>
      uniqueResolvedRoots(listKnownWorkspaceRoots(workspaceSync.getSnapshot()))
    const snapshotService = new MobileSprintEngineSnapshotService()
    const bridge = new MobileBridge(() => multicodeAuth.getSession(), {
      accessTokenProvider: () => multicodeAuth.getRelayAccessToken(),
      commandService: terminalRuntime.commandService,
      snapshotService,
      statePathsProvider: () => discoverMobileSprintEngineStatePaths(resolveWorkspaceRoots()),
      workspaceRootsProvider: async () => resolveWorkspaceRoots(),
    })

    host.registerSidecar({
      id: 'mobile-relay-client',
      kind: 'relay-client',
      description: 'Encrypted relay connection; only active while this module is enabled.',
    })

    registerMobileBridgeIpc(host.ipcMain, { bridge })

    host.onShutdown(() => bridge.shutdown())
  },
}
