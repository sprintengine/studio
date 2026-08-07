import type { IpcMain } from 'electron'
import type {
  MobileBridgeDiagnosticEntry,
  MobileBridgePairingChallenge,
  MobileBridgePresence,
  MobileBridgeSettingsUpdate,
  MobileBridgeState,
  MobileControlDevice,
} from '../../shared/electron-api'

type MobileBridgeIpcBridge = {
  getState(): Promise<MobileBridgeState>
  updateSettings(input: MobileBridgeSettingsUpdate): Promise<MobileBridgeState>
  requestPairingCode(): Promise<MobileBridgePairingChallenge>
  listDevices(): Promise<MobileControlDevice[]>
  revokeDevice(deviceId: string, reason?: string): Promise<MobileControlDevice>
  publishPresence(presence: MobileBridgePresence): Promise<MobileBridgeState>
  getDiagnostics(): Promise<MobileBridgeDiagnosticEntry[]>
}

type MobileBridgeIpcDependencies = {
  bridge: MobileBridgeIpcBridge
}

export function registerMobileBridgeIpc(ipcMain: IpcMain, deps: MobileBridgeIpcDependencies): void {
  ipcMain.handle('mobile-bridge:get-state', () => deps.bridge.getState())

  ipcMain.handle('mobile-bridge:update-settings', (_, input: MobileBridgeSettingsUpdate) => {
    return deps.bridge.updateSettings(input)
  })

  ipcMain.handle('mobile-bridge:request-pairing-code', () => deps.bridge.requestPairingCode())

  ipcMain.handle('mobile-bridge:list-devices', () => deps.bridge.listDevices())

  ipcMain.handle('mobile-bridge:revoke-device', (_, deviceId: string, reason?: string) => {
    return deps.bridge.revokeDevice(deviceId, reason)
  })

  ipcMain.handle('mobile-bridge:publish-presence', (_, presence: MobileBridgePresence) => {
    return deps.bridge.publishPresence(presence)
  })

  ipcMain.handle('mobile-bridge:get-diagnostics', () => deps.bridge.getDiagnostics())
}
