import { normalizeModuleRegistrySnapshot, } from '../../shared/modules/registry-snapshot';
export function createModuleRegistryMirror() {
    let snapshot = null;
    return {
        read: () => snapshot,
        write(value) {
            const normalized = normalizeModuleRegistrySnapshot(value);
            if (!normalized) {
                return { ok: false, message: 'Malformed module registry snapshot; the cached registry is unchanged.' };
            }
            snapshot = normalized;
            return { ok: true };
        },
    };
}
