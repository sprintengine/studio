import { getErrorMessage } from '../../error-message';
import { acceptedBridgeCommand, failedCommandResult } from './command-results';
import { stringPayload } from './command-payload';
export async function dispatchDeviceRevoke(input) {
    const { command, revokeDevice } = input;
    const deviceId = stringPayload(command.payload, 'deviceId');
    if (deviceId !== command.deviceId) {
        return failedCommandResult(command, 'unauthorized', 'Mobile devices can only revoke their own pairing.');
    }
    const payload = command.payload;
    const reason = typeof payload.reason === 'string' ? payload.reason : undefined;
    let device;
    try {
        device = await revokeDevice(deviceId, reason);
    }
    catch (error) {
        return failedCommandResult(command, 'relay_unavailable', getErrorMessage(error));
    }
    return acceptedBridgeCommand(command, { revoked: true, deviceId: device.deviceId });
}
