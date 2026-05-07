import { ipcRenderer, type IpcRendererEvent } from 'electron'
import type {
  ElectronApi,
  MobileBridgeDiagnosticEntry,
  MobileBridgePairingChallenge,
  MobileBridgePresence,
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
  mobileBridgeListDevices: (): Promise<MobileControlDevice[]> =>
    ipcRenderer.invoke('mobile-bridge:list-devices'),
  mobileBridgeRevokeDevice: (deviceId: string, reason?: string): Promise<MobileControlDevice> =>
    ipcRenderer.invoke('mobile-bridge:revoke-device', deviceId, reason),
  mobileBridgePublishPresence: (presence: MobileBridgePresence): Promise<MobileBridgeState> =>
    ipcRenderer.invoke('mobile-bridge:publish-presence', presence),
  mobileBridgeGetDiagnostics: (): Promise<MobileBridgeDiagnosticEntry[]> =>
    ipcRenderer.invoke('mobile-bridge:get-diagnostics'),
  mobileBridgeUpdateWorkspaceRoots: (roots: string[]): Promise<{ roots: string[] }> =>
    ipcRenderer.invoke('mobile-bridge:update-workspace-roots', roots),
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
  | 'mobileBridgeListDevices'
  | 'mobileBridgeRevokeDevice'
  | 'mobileBridgePublishPresence'
  | 'mobileBridgeGetDiagnostics'
  | 'mobileBridgeUpdateWorkspaceRoots'
  | 'onMobileBridgeStateChanged'
>
