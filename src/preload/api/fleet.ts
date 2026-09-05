import { ipcRenderer, type IpcRendererEvent } from 'electron'

import {
  fleetTerminalEventChannel,
  FLEET_ATTACH_TERMINAL_CHANNEL,
  FLEET_BROWSE_CHANNEL,
  FLEET_CREATE_TERMINAL_CHANNEL,
  FLEET_WORKSPACE_CHECKOUT_CHANNEL,
  FLEET_DETACH_TERMINAL_CHANNEL,
  FLEET_FORGET_CHANNEL,
  FLEET_GET_LIVE_STATE_CHANNEL,
  FLEET_LIST_CONNECTIONS_CHANNEL,
  FLEET_LIST_RUNS_CHANNEL,
  FLEET_CANCEL_PAIRING_CHANNEL,
  FLEET_CHECK_REACHABILITY_CHANNEL,
  FLEET_COLLECT_PAIRING_CHANNEL,
  FLEET_PAIR_CHANNEL,
  FLEET_REQUEST_PAIRING_CHANNEL,
  FLEET_EVENT_CHANNEL,
  FLEET_TERMINAL_INPUT_CHANNEL,
  FLEET_TERMINAL_RESIZE_CHANNEL,
  type FleetAttachResult,
  type FleetBrowse,
  type FleetConnection,
  type FleetCreateTerminalResult,
  type FleetCheckoutRequest,
  type FleetWorkspaceCheckoutResult,
  type FleetCollectPairingResult,
  type FleetEvent,
  type FleetLiveState,
  type FleetPairResult,
  type FleetRequestPairingResult,
  type FleetRun,
  type FleetTerminalEvent,
} from '../../shared/tailnet-fleet'
import type { TailnetScope } from '../../shared/tailnet'
import type { ElectronApi } from '../../shared/electron-api'

// The Fleet's data path (MC-2167): the machines this Studio drives, what they
// hold, and the terminals it has open on them.
//
// Nothing here carries a credential. The device tokens stay in main, which is
// also the only place that can dial the listener at all — it refuses any
// request with an `Origin` header, and a renderer always sends one.
export const fleetApi = {
  fleetListConnections: (): Promise<FleetConnection[]> =>
    ipcRenderer.invoke(FLEET_LIST_CONNECTIONS_CHANNEL) as Promise<FleetConnection[]>,
  fleetPair: (pairingUrl: string): Promise<FleetPairResult> =>
    ipcRenderer.invoke(FLEET_PAIR_CHANNEL, { pairingUrl }) as Promise<FleetPairResult>,
  fleetRequestPairing: (
    endpoint: string,
    options?: { reverseScopes?: TailnetScope[] }
  ): Promise<FleetRequestPairingResult> =>
    ipcRenderer.invoke(FLEET_REQUEST_PAIRING_CHANNEL, {
      endpoint,
      ...(options?.reverseScopes ? { reverseScopes: options.reverseScopes } : {}),
    }) as Promise<FleetRequestPairingResult>,
  fleetCheckReachability: (connectionId?: string): Promise<FleetLiveState> =>
    ipcRenderer.invoke(FLEET_CHECK_REACHABILITY_CHANNEL, connectionId ?? null) as Promise<FleetLiveState>,
  fleetCollectPairing: (requestId: string): Promise<FleetCollectPairingResult> =>
    ipcRenderer.invoke(FLEET_COLLECT_PAIRING_CHANNEL, requestId) as Promise<FleetCollectPairingResult>,
  fleetCancelPairing: (requestId: string): Promise<void> =>
    ipcRenderer.invoke(FLEET_CANCEL_PAIRING_CHANNEL, requestId) as Promise<void>,
  fleetForget: (connectionId: string): Promise<FleetConnection[]> =>
    ipcRenderer.invoke(FLEET_FORGET_CHANNEL, connectionId) as Promise<FleetConnection[]>,
  fleetBrowse: (connectionId: string): Promise<FleetBrowse> =>
    ipcRenderer.invoke(FLEET_BROWSE_CHANNEL, connectionId) as Promise<FleetBrowse>,
  fleetListRuns: (
    connectionId: string,
    workspaceId: string
  ): Promise<{ ok: true; runs: FleetRun[] } | { ok: false; code: string; message: string }> =>
    ipcRenderer.invoke(FLEET_LIST_RUNS_CHANNEL, { connectionId, workspaceId }) as Promise<
      { ok: true; runs: FleetRun[] } | { ok: false; code: string; message: string }
    >,
  fleetCreateTerminal: (input: {
    connectionId: string
    workspaceId?: string
    name?: string
    cli?: string
    prompt?: string
    cliModel?: string
    permissionPreset?: string
    checkout?: FleetCheckoutRequest
  }): Promise<FleetCreateTerminalResult> =>
    ipcRenderer.invoke(FLEET_CREATE_TERMINAL_CHANNEL, input) as Promise<FleetCreateTerminalResult>,
  fleetWorkspaceCheckout: (connectionId: string, workspaceId: string): Promise<FleetWorkspaceCheckoutResult> =>
    ipcRenderer.invoke(FLEET_WORKSPACE_CHECKOUT_CHANNEL, { connectionId, workspaceId }) as Promise<FleetWorkspaceCheckoutResult>,
  fleetAttachTerminal: (input: {
    attachId: string
    connectionId: string
    sessionId: string
  }): Promise<FleetAttachResult> =>
    ipcRenderer.invoke(FLEET_ATTACH_TERMINAL_CHANNEL, input) as Promise<FleetAttachResult>,
  fleetDetachTerminal: (attachId: string): Promise<void> =>
    ipcRenderer.invoke(FLEET_DETACH_TERMINAL_CHANNEL, attachId) as Promise<void>,
  fleetTerminalInput: (attachId: string, data: string): void => {
    // Fire-and-forget, like the local terminal's fast write: a keystroke that
    // waits for a round trip before the next one is read feels laggy.
    ipcRenderer.send(FLEET_TERMINAL_INPUT_CHANNEL, { attachId, data })
  },
  fleetTerminalResize: (attachId: string, cols: number, rows: number): void => {
    ipcRenderer.send(FLEET_TERMINAL_RESIZE_CHANNEL, { attachId, cols, rows })
  },
  onFleetTerminalEvent: (attachId: string, cb: (event: FleetTerminalEvent) => void): (() => void) => {
    const channel = fleetTerminalEventChannel(attachId)
    const handler = (_: IpcRendererEvent, event: FleetTerminalEvent) => cb(event)
    ipcRenderer.on(channel, handler)
    return () => ipcRenderer.removeListener(channel, handler)
  },
  // Whole-app fleet lifecycle (remote-sessions-ux): machine paired/forgotten
  // and attachment link-state changes, broadcast to every window.
  fleetGetLiveState: (): Promise<FleetLiveState> =>
    ipcRenderer.invoke(FLEET_GET_LIVE_STATE_CHANNEL) as Promise<FleetLiveState>,
  onFleetEvent: (cb: (event: FleetEvent) => void): (() => void) => {
    const handler = (_: IpcRendererEvent, event: FleetEvent) => cb(event)
    ipcRenderer.on(FLEET_EVENT_CHANNEL, handler)
    return () => ipcRenderer.removeListener(FLEET_EVENT_CHANNEL, handler)
  },
} satisfies Pick<
  ElectronApi,
  | 'fleetListConnections'
  | 'fleetPair'
  | 'fleetRequestPairing'
  | 'fleetCollectPairing'
  | 'fleetCancelPairing'
  | 'fleetCheckReachability'
  | 'fleetForget'
  | 'fleetBrowse'
  | 'fleetListRuns'
  | 'fleetCreateTerminal'
  | 'fleetWorkspaceCheckout'
  | 'fleetAttachTerminal'
  | 'fleetDetachTerminal'
  | 'fleetTerminalInput'
  | 'fleetTerminalResize'
  | 'onFleetTerminalEvent'
  | 'fleetGetLiveState'
  | 'onFleetEvent'
>
