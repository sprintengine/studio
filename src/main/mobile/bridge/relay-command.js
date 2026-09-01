export function relayCommandTypeToMobile(type) {
    return type === 'agent.followup' ? 'agent.followUp' : type;
}
export function relayEnvelopeToMobileCommand(input) {
    const { envelope, commandType, deviceId, protocolVersion } = input;
    return {
        protocolVersion,
        commandId: envelope.commandId,
        type: commandType,
        issuedAt: envelope.issuedAt,
        deviceId,
        idempotencyKey: `relay:${envelope.commandId}`,
        ...(envelope.expectedSnapshotVersion ? { expectedSnapshotVersion: envelope.expectedSnapshotVersion } : {}),
        payload: envelope.payload,
    };
}
