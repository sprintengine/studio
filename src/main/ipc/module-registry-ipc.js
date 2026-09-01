import { MODULE_REGISTRY_SNAPSHOT_CHANNEL, } from '../../shared/modules/registry-snapshot';
// Kernel-level (not feature-owned) IPC, alongside module enablement: the
// renderer pushes the module registry it resolves — the universe main cannot
// see — and main caches the last push for its own read surfaces (the `module.*`
// gateway tools). Push-only by design; the renderer owns the source of truth,
// so there is no read path back.
export function registerModuleRegistryIpc(ipcMain, mirror) {
    ipcMain.handle(MODULE_REGISTRY_SNAPSHOT_CHANNEL, async (_event, snapshot) => mirror.write(snapshot));
}
