import type { MobileBridgePresence, MobileControlCapability, MobileControlDevice, MobilePushProvider, MobilePushRegistration } from './index';
export declare function isMobileControlDevice(input: unknown): input is MobileControlDevice;
export declare function isMobileControlCapability(input: unknown): input is MobileControlCapability;
export declare function isMobilePushRegistration(input: unknown): input is MobilePushRegistration;
export declare function isMobilePushProvider(input: unknown): input is MobilePushProvider;
export declare function redactPushRegistration(registration: MobilePushRegistration): MobilePushRegistration;
export declare function isMobileBridgePresence(input: string): input is MobileBridgePresence;
