import type { MobileControlCommand, MobileSprintEngineCommandResult } from '../sprintengine/command';
import type { MobileControlDevice } from './index';
export declare function dispatchDeviceRevoke(input: {
    command: MobileControlCommand;
    revokeDevice: (deviceId: string, reason?: string) => Promise<MobileControlDevice>;
}): Promise<MobileSprintEngineCommandResult>;
