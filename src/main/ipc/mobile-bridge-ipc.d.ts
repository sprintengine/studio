import type { IpcMain } from 'electron';
import type { MobileBridgeDiagnosticEntry, MobileBridgePairingChallenge, MobileBridgePresence, MobileBridgeSettingsUpdate, MobileBridgeState, MobileControlDevice } from '../../shared/electron-api';
type MobileBridgeIpcBridge = {
    getState(): Promise<MobileBridgeState>;
    updateSettings(input: MobileBridgeSettingsUpdate): Promise<MobileBridgeState>;
    requestPairingCode(): Promise<MobileBridgePairingChallenge>;
    listDevices(): Promise<MobileControlDevice[]>;
    revokeDevice(deviceId: string, reason?: string): Promise<MobileControlDevice>;
    publishPresence(presence: MobileBridgePresence): Promise<MobileBridgeState>;
    getDiagnostics(): Promise<MobileBridgeDiagnosticEntry[]>;
};
type MobileBridgeIpcDependencies = {
    bridge: MobileBridgeIpcBridge;
};
export declare function registerMobileBridgeIpc(ipcMain: IpcMain, deps: MobileBridgeIpcDependencies): void;
export {};
