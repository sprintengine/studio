import type { MobileControlCommand } from '../sprintengine/command';
import type { MobileControlCommandType, MobileControlDevice, RelayCommandEnvelope, RelayCommandType } from './index';
export declare function relayCommandTypeToMobile(type: RelayCommandType): MobileControlCommandType;
export declare function relayEnvelopeToMobileCommand(input: {
    envelope: RelayCommandEnvelope;
    commandType: MobileControlCommandType;
    deviceId: MobileControlDevice['deviceId'];
    protocolVersion: MobileControlCommand['protocolVersion'];
}): MobileControlCommand;
