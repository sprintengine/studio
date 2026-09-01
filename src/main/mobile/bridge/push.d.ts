import { type MobilePushRegistrationTarget } from '../sprintengine/activity';
import type { MobileControlDevice, MobilePushRegistration, MobilePushRegistrationInput } from './index';
export declare function registerMobilePushToken(pairedDevices: MobileControlDevice[], pushRegistrations: MobilePushRegistration[], input: MobilePushRegistrationInput): MobilePushRegistration;
export declare function revokeMobilePushRegistration(pushRegistrations: MobilePushRegistration[], registrationId: string): MobilePushRegistration;
export declare function listMobilePushRegistrations(pushRegistrations: MobilePushRegistration[]): MobilePushRegistration[];
export declare function listActiveMobilePushTargets(pairedDevices: MobileControlDevice[], pushRegistrations: MobilePushRegistration[]): MobilePushRegistrationTarget[];
export declare function revokePushRegistrationsForDevice(pushRegistrations: MobilePushRegistration[], deviceId: string, revokedAt: string): void;
