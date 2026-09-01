import type { MobileControlCommandType, MobileControlDevice, MobileControlErrorCode, MobileRelayAuthenticatedDevice, RelayCommandEnvelope } from './index';
export type MobileBridgeRelayAuthorizationError = {
    code: MobileControlErrorCode;
    message: string;
};
export declare function authorizeRelayCommand(input: {
    desktopRelaySessionId: string | null;
    pairedDevices: MobileControlDevice[];
    envelope: RelayCommandEnvelope;
    commandType: MobileControlCommandType;
    device: MobileRelayAuthenticatedDevice | null;
}): MobileBridgeRelayAuthorizationError | null;
