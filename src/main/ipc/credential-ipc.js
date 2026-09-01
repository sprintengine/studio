import { getSharedCredentialStore } from '../secret-store';
// Generic credential IPC: the single shared credential store surfaced for any
// owner kind (CLI plugins AND conversation providers). Inputs carry a manifest
// `id`; the store resolves the matching `auth` descriptor across all manifest
// kinds. The plaintext value only flows in on `set`; status/clear are id-only,
// and no decrypted value ever crosses back to the renderer.
function formatError(err) {
    return err instanceof Error ? err.message : 'Unexpected error.';
}
function parseId(input) {
    if (typeof input !== 'object' || input === null)
        return { ok: false, message: 'Invalid request.' };
    const id = input.id;
    if (typeof id !== 'string' || id.trim().length === 0)
        return { ok: false, message: 'Credential id is required.' };
    return { ok: true, id: id.trim() };
}
function parseSet(input) {
    const base = parseId(input);
    if (!base.ok)
        return base;
    const value = input.value;
    if (typeof value !== 'string')
        return { ok: false, message: 'Credential value is required.' };
    return { ok: true, id: base.id, value };
}
export function registerCredentialIpc(ipcMain, store = getSharedCredentialStore()) {
    ipcMain.handle('credential:secrets:status', async (_, input) => {
        const parsed = parseId(input);
        if (!parsed.ok)
            return parsed;
        try {
            return await store.getStatus(parsed.id);
        }
        catch (err) {
            return { ok: false, message: formatError(err) };
        }
    });
    ipcMain.handle('credential:secrets:set', async (_, input) => {
        const parsed = parseSet(input);
        if (!parsed.ok)
            return parsed;
        try {
            return await store.setSecret(parsed.id, parsed.value);
        }
        catch (err) {
            return { ok: false, message: formatError(err) };
        }
    });
    ipcMain.handle('credential:secrets:clear', async (_, input) => {
        const parsed = parseId(input);
        if (!parsed.ok)
            return parsed;
        try {
            return await store.clearSecret(parsed.id);
        }
        catch (err) {
            return { ok: false, message: formatError(err) };
        }
    });
}
