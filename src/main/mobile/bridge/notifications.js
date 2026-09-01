import { randomUUID } from 'crypto';
import { getAllBrowserWindows } from './desktop';
const MAX_DIAGNOSTICS = 50;
export function recordMobileBridgeDiagnostic(diagnostics, level, code, message, retryable) {
    const previous = diagnostics[0];
    if (previous?.code === code && previous.message === message)
        return diagnostics;
    return [{
            id: randomUUID(),
            timestamp: new Date().toISOString(),
            level,
            code,
            message,
            retryable,
        }, ...diagnostics].slice(0, MAX_DIAGNOSTICS);
}
export function emitMobileBridgeStateChanged(state) {
    for (const win of getAllBrowserWindows()) {
        if (!win.isDestroyed()) {
            win.webContents.send('mobile-bridge:state-changed', state);
        }
    }
}
