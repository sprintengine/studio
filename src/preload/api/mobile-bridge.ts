import { ipcRenderer, type IpcRendererEvent } from 'electron'
import type {
  ElectronApi,
  MobileBridgeDiagnosticEntry,
  MobileBridgePairingChallenge,
  MobileBridgeSettingsUpdate,
  MobileBridgeState,
  MobileControlDevice,
} from '../../shared/electron-api'

export const mobileBridgeApi = {
  mobileBridgeGetState: (): Promise<MobileBridgeState> =>
    ipcRenderer.invoke('mobile-bridge:get-state'),
  mobileBridgeUpdateSettings: (input: MobileBridgeSettingsUpdate): Promise<MobileBridgeState> =>
    ipcRenderer.invoke('mobile-bridge:update-settings', input),
  mobileBridgeRequestPairingCode: (): Promise<MobileBridgePairingChallenge> =>
    ipcRenderer.invoke('mobile-bridge:request-pairing-code'),
  mobileBridgeRevokeDevice: (deviceId: string, reason?: string): Promise<MobileControlDevice> =>
    ipcRenderer.invoke('mobile-bridge:revoke-device', deviceId, reason),
  mobileBridgeGetDiagnostics: (): Promise<MobileBridgeDiagnosticEntry[]> =>
    ipcRenderer.invoke('mobile-bridge:get-diagnostics'),
  onMobileBridgeStateChanged: (cb: (state: MobileBridgeState) => void): (() => void) => {
    const ch = 'mobile-bridge:state-changed'
    const handler = (_: IpcRendererEvent, state: MobileBridgeState) => cb(state)
    ipcRenderer.on(ch, handler)
    return () => ipcRenderer.removeListener(ch, handler)
  },
} satisfies Pick<
  ElectronApi,
  | 'mobileBridgeGetState'
  | 'mobileBridgeUpdateSettings'
  | 'mobileBridgeRequestPairingCode'
  | 'mobileBridgeRevokeDevice'
  | 'mobileBridgeGetDiagnostics'
  | 'onMobileBridgeStateChanged'
>
