import type { IpcMain } from 'electron'
import type {
  MobileBridgeDiagnosticEntry,
  MobileBridgePairingChallenge,
  MobileBridgeSettingsUpdate,
  MobileBridgeState,
  MobileControlDevice,
} from '../../shared/electron-api'

type MobileBridgeIpcBridge = {
  getState(): Promise<MobileBridgeState>
  updateSettings(input: MobileBridgeSettingsUpdate): Promise<MobileBridgeState>
  requestPairingCode(): Promise<MobileBridgePairingChallenge>
  revokeDevice(deviceId: string, reason?: string): Promise<MobileControlDevice>
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

  ipcMain.handle('mobile-bridge:revoke-device', (_, deviceId: string, reason?: string) => {
    return deps.bridge.revokeDevice(deviceId, reason)
  })

  ipcMain.handle('mobile-bridge:get-diagnostics', () => deps.bridge.getDiagnostics())
}
