import { ipcRenderer } from 'electron'
import {
  AUTOMATION_GET_STATUS_CHANNEL,
  AUTOMATION_SET_ENABLED_CHANNEL,
  type AutomationServerStatus,
} from '../../shared/automation'
import {
  TAILNET_CANCEL_PAIRING_CHANNEL,
  TAILNET_GET_STATUS_CHANNEL,
  TAILNET_APPROVE_PAIR_REQUEST_CHANNEL,
  TAILNET_DENY_PAIR_REQUEST_CHANNEL,
  TAILNET_OFFER_PAIRING_CHANNEL,
  TAILNET_REVOKE_DEVICE_CHANNEL,
  TAILNET_SET_ENABLED_CHANNEL,
  type TailnetApprovePairRequestView,
  type TailnetPairingOfferView,
  type TailnetRemoteStatus,
  type TailnetScope,
} from '../../shared/tailnet'
import { TAILNET_LIST_PEERS_CHANNEL, type TailnetPeerScan } from '../../shared/tailnet-peers'
import type { ElectronApi } from '../../shared/electron-api'

// Status only for the always-on gateway. Its mutations are main services, so
// nothing asks a window to perform one and there is no request/respond pair
// here (MC-2161).
//
// The tailnet half is the Remote panel's whole data path (MC-2162, MC-2163):
// configuration for the opt-in listener — enable it, mint or cancel a one-time
// pairing code, revoke a device — plus the discovery sweep that finds the other
// machines on this tailnet.
export const automationApi = {
  automationGetStatus: (): Promise<AutomationServerStatus> =>
    ipcRenderer.invoke(AUTOMATION_GET_STATUS_CHANNEL) as Promise<AutomationServerStatus>,
  automationSetEnabled: (enabled: boolean): Promise<AutomationServerStatus> =>
    ipcRenderer.invoke(AUTOMATION_SET_ENABLED_CHANNEL, enabled) as Promise<AutomationServerStatus>,
  tailnetGetStatus: (): Promise<TailnetRemoteStatus> =>
    ipcRenderer.invoke(TAILNET_GET_STATUS_CHANNEL) as Promise<TailnetRemoteStatus>,
  tailnetSetEnabled: (enabled: boolean): Promise<TailnetRemoteStatus> =>
    ipcRenderer.invoke(TAILNET_SET_ENABLED_CHANNEL, enabled) as Promise<TailnetRemoteStatus>,
  tailnetOfferPairing: (scopes?: TailnetScope[]): Promise<TailnetPairingOfferView> =>
    ipcRenderer.invoke(TAILNET_OFFER_PAIRING_CHANNEL, scopes) as Promise<TailnetPairingOfferView>,
  tailnetCancelPairing: (): Promise<TailnetRemoteStatus> =>
    ipcRenderer.invoke(TAILNET_CANCEL_PAIRING_CHANNEL) as Promise<TailnetRemoteStatus>,
  tailnetRevokeDevice: (deviceId: string): Promise<TailnetRemoteStatus> =>
    ipcRenderer.invoke(TAILNET_REVOKE_DEVICE_CHANNEL, deviceId) as Promise<TailnetRemoteStatus>,
  tailnetApprovePairRequest: (id: string, scopes: TailnetScope[]): Promise<TailnetApprovePairRequestView> =>
    ipcRenderer.invoke(TAILNET_APPROVE_PAIR_REQUEST_CHANNEL, id, scopes) as Promise<TailnetApprovePairRequestView>,
  tailnetDenyPairRequest: (id: string): Promise<TailnetRemoteStatus> =>
    ipcRenderer.invoke(TAILNET_DENY_PAIR_REQUEST_CHANNEL, id) as Promise<TailnetRemoteStatus>,
  tailnetListPeers: (): Promise<TailnetPeerScan> =>
    ipcRenderer.invoke(TAILNET_LIST_PEERS_CHANNEL) as Promise<TailnetPeerScan>,
} satisfies Pick<
  ElectronApi,
  | 'automationGetStatus'
  | 'automationSetEnabled'
  | 'tailnetGetStatus'
  | 'tailnetSetEnabled'
  | 'tailnetOfferPairing'
  | 'tailnetCancelPairing'
  | 'tailnetRevokeDevice'
  | 'tailnetApprovePairRequest'
  | 'tailnetDenyPairRequest'
  | 'tailnetListPeers'
>
