import { app } from 'electron';
import { mkdir, readFile, writeFile } from 'fs/promises';
import { dirname, join } from 'path';
import { randomBase64Url } from './crypto';
import { isMobileControlDevice, isMobilePushRegistration, } from './validation';
export function getDefaultMobileBridgeStorePath() {
    return join(app.getPath('userData'), 'mobile-bridge.json');
}
export async function readMobileBridgeStore(storePath) {
    try {
        const payload = JSON.parse(await readFile(storePath, 'utf8'));
        return {
            enabled: payload.enabled === true,
            relayUrl: normalizeStoredRelayUrl(payload.relayUrl),
            desktopInstanceId: typeof payload.desktopInstanceId === 'string' && payload.desktopInstanceId
                ? payload.desktopInstanceId
                : `mdi_${randomBase64Url(18)}`,
            pairedDevices: Array.isArray(payload.pairedDevices)
                ? payload.pairedDevices.flatMap((device) => {
                    return isMobileControlDevice(device) ? [device] : [];
                })
                : [],
            pushRegistrations: Array.isArray(payload.pushRegistrations)
                ? payload.pushRegistrations.flatMap((registration) => {
                    return isMobilePushRegistration(registration) ? [registration] : [];
                })
                : [],
        };
    }
    catch {
        return {
            enabled: false,
            relayUrl: null,
            desktopInstanceId: `mdi_${randomBase64Url(18)}`,
            pairedDevices: [],
            pushRegistrations: [],
        };
    }
}
export async function writeMobileBridgeStore(storePath, state) {
    await mkdir(dirname(storePath), { recursive: true });
    const payload = {
        enabled: state.enabled,
        relayUrl: state.relayUrl,
        desktopInstanceId: state.desktopInstanceId,
        pairedDevices: state.pairedDevices,
        pushRegistrations: state.pushRegistrations,
    };
    await writeFile(storePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
}
function normalizeStoredRelayUrl(value) {
    if (typeof value !== 'string')
        return null;
    const trimmed = value.trim().replace(/\/+$/u, '');
    return trimmed ? trimmed : null;
}
