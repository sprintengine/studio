import type { MobileControlDevice, MobilePushRegistration } from './index';
export type MobileBridgeStoredState = {
    enabled: boolean;
    relayUrl: string | null;
    desktopInstanceId: string;
    pairedDevices: MobileControlDevice[];
    pushRegistrations: MobilePushRegistration[];
};
export declare function getDefaultMobileBridgeStorePath(): string;
export declare function readMobileBridgeStore(storePath: string): Promise<MobileBridgeStoredState>;
export declare function writeMobileBridgeStore(storePath: string, state: MobileBridgeStoredState): Promise<void>;
