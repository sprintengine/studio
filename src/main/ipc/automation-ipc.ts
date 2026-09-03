import type { IpcMain } from 'electron'
import {
  AUTOMATION_GET_STATUS_CHANNEL,
  AUTOMATION_SET_ENABLED_CHANNEL,
} from '../../shared/automation'
import {
  TAILNET_CANCEL_PAIRING_CHANNEL,
  TAILNET_GET_LIVE_STATE_CHANNEL,
  TAILNET_GET_STATUS_CHANNEL,
  TAILNET_APPROVE_PAIR_REQUEST_CHANNEL,
  TAILNET_DENY_PAIR_REQUEST_CHANNEL,
  TAILNET_OFFER_PAIRING_CHANNEL,
  TAILNET_REVOKE_DEVICE_CHANNEL,
  TAILNET_SET_ENABLED_CHANNEL,
} from '../../shared/tailnet'
import { TAILNET_LIST_PEERS_CHANNEL } from '../../shared/tailnet-peers'
import type { AutomationService } from '../automation/automation-service'

// Status only: a window reads whether the gateway is up and may turn it off.
// The respond half of the old renderer-delegate pair went with the delegate
// (MC-2161) — no gateway request travels to a window any more.
//
// The tailnet channels are the configuration front door for the opt-in remote
// listener (MC-2162): enable it, mint or cancel a pairing code, revoke a paired
// device. They are IPC-only on purpose — none of this is reachable through the
// MCP gateway itself, so no agent (local or remote) can pair a new device or
// widen its own reach.
export function registerAutomationIpc(ipcMain: IpcMain, service: AutomationService): void {
  ipcMain.handle(AUTOMATION_GET_STATUS_CHANNEL, () => service.getStatus())
  ipcMain.handle(AUTOMATION_SET_ENABLED_CHANNEL, (_event, enabled: unknown) =>
    service.setEnabled(enabled === true)
  )
  ipcMain.handle(TAILNET_GET_STATUS_CHANNEL, () => service.getTailnetStatus())
  // The initial read behind the push channel: a subscriber takes this snapshot
  // once, then stores each pushed payload's fresher copy.
  ipcMain.handle(TAILNET_GET_LIVE_STATE_CHANNEL, () => service.getTailnetLiveState())
  ipcMain.handle(TAILNET_SET_ENABLED_CHANNEL, (_event, enabled: unknown) =>
    service.setTailnetEnabled(enabled === true)
  )
  ipcMain.handle(TAILNET_OFFER_PAIRING_CHANNEL, (_event, scopes: unknown) =>
    service.offerTailnetPairing({ scopes })
  )
  ipcMain.handle(TAILNET_CANCEL_PAIRING_CHANNEL, () => service.cancelTailnetPairing())
  // Answering a request is the same authority as minting a code, so it lives on
  // the same IPC-only front door: a remote device can ask, and only this
  // keyboard can say yes.
  ipcMain.handle(TAILNET_APPROVE_PAIR_REQUEST_CHANNEL, (_event, id: unknown, scopes: unknown) =>
    service.approveTailnetPairRequest({ id: typeof id === 'string' ? id : '', scopes })
  )
  ipcMain.handle(TAILNET_DENY_PAIR_REQUEST_CHANNEL, (_event, id: unknown) =>
    service.denyTailnetPairRequest(typeof id === 'string' ? id : '')
  )
  ipcMain.handle(TAILNET_REVOKE_DEVICE_CHANNEL, (_event, deviceId: unknown) =>
    service.revokeTailnetDevice(typeof deviceId === 'string' ? deviceId : '')
  )
  // Discovery is a read of the local Tailscale daemon plus a probe of a public
  // health endpoint, so it changes nothing and is safe to call with the
  // listener off. It is still IPC-only for the same reason as the rest: a
  // remote device must not be able to make this machine enumerate the tailnet.
  ipcMain.handle(TAILNET_LIST_PEERS_CHANNEL, () => service.listTailnetPeers())
}
