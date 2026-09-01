import type { MobileControlCapability, MobileControlDevice, MobileRelayAuthenticatedDevice } from './index';
export declare function relayDeviceCapabilities(device: MobileRelayAuthenticatedDevice): MobileControlCapability[];
export declare function normalizeDevicePlatform(platform: MobileRelayAuthenticatedDevice['platform']): MobileControlDevice['platform'];
export declare function upsertRelayDevice(pairedDevices: MobileControlDevice[], device: MobileRelayAuthenticatedDevice, protocolVersion: MobileControlDevice['protocolVersion']): {
    pairedDevice: MobileControlDevice;
    inserted: boolean;
};
