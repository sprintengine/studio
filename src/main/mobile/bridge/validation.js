const MOBILE_CONTROL_CAPABILITIES = [
    'snapshots.read',
    'artifacts.read',
    'sprintengines.create',
    'tasks.start',
    'artifacts.review',
    'agents.followUp',
    'devices.revoke',
    'backlog.update',
    'backlog.start',
    'backlog.create',
    'sprintengines.pr',
    'sprintengines.automation',
    'automations.control',
];
const _capabilityListComplete = true;
void _capabilityListComplete;
export function isMobileControlDevice(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input))
        return false;
    const device = input;
    return device.protocolVersion === 2
        && typeof device.deviceId === 'string'
        && typeof device.displayName === 'string'
        && (device.platform === 'ios' || device.platform === 'android' || device.platform === 'web')
        && typeof device.appVersion === 'string'
        && typeof device.pairedAt === 'string'
        && Number.isFinite(Date.parse(device.pairedAt))
        && (device.lastSeenAt === undefined || Number.isFinite(Date.parse(device.lastSeenAt)))
        && (device.revokedAt === undefined || Number.isFinite(Date.parse(device.revokedAt)))
        && Array.isArray(device.capabilities)
        && device.capabilities.every(isMobileControlCapability);
}
export function isMobileControlCapability(input) {
    return MOBILE_CONTROL_CAPABILITIES.includes(input);
}
export function isMobilePushRegistration(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input))
        return false;
    const registration = input;
    return registration.protocolVersion === 2
        && typeof registration.registrationId === 'string'
        && typeof registration.deviceId === 'string'
        && isMobilePushProvider(registration.provider)
        && typeof registration.tokenHash === 'string'
        && /^[a-f0-9]{64}$/u.test(registration.tokenHash)
        && typeof registration.registeredAt === 'string'
        && Number.isFinite(Date.parse(registration.registeredAt))
        && (registration.lastUsedAt === undefined || Number.isFinite(Date.parse(registration.lastUsedAt)))
        && (registration.revokedAt === undefined || Number.isFinite(Date.parse(registration.revokedAt)));
}
export function isMobilePushProvider(input) {
    return input === 'apns' || input === 'fcm' || input === 'expo';
}
export function redactPushRegistration(registration) {
    return { ...registration };
}
export function isMobileBridgePresence(input) {
    return input === 'available' || input === 'busy' || input === 'idle' || input === 'offline';
}
