import { nativeTheme } from 'electron';
import { setColorScheme } from '../color-scheme-store';
import { applyWindowMaterialToWorkspaceWindows } from '../window-factory';
import { setWindowMaterial } from '../window-material-store';
// Kernel-level (not feature-owned) IPC: the renderer pushes its resolved color
// scheme here so main can launch agent CLIs matching the app's light/dark
// surface. The renderer owns the source of truth (the theme preference), so
// there's no read path back — main only caches the latest pushed value.
export function registerAppearanceIpc(ipcMain) {
    ipcMain.handle('appearance:set-color-scheme', (_event, scheme) => {
        // Normalize defensively: any value that isn't an explicit 'light' falls back
        // to 'dark' rather than propagating a malformed scheme into a spawn argv.
        const normalized = scheme === 'light' ? 'light' : 'dark';
        setColorScheme(normalized);
        // Window appearance must track the resolved theme, not the OS setting:
        // the glass material (NSVisualEffectView) renders per window appearance,
        // so a dark theme on a light-mode OS would otherwise get a washed-out
        // light frost under its dark tint (spike finding, MC-1907). Also keeps
        // native menus/dialogs matching the app surface.
        nativeTheme.themeSource = normalized;
    });
    // Same push contract as the scheme: renderer owns the preference
    // (appSettings.appearance.windowMaterial); main persists a mirror so window
    // creation can apply vibrancy pre-boot, and re-applies live on change.
    ipcMain.handle('appearance:set-window-material', (_event, material) => {
        const normalized = material === 'glass' ? 'glass' : 'solid';
        setWindowMaterial(normalized);
        applyWindowMaterialToWorkspaceWindows(normalized);
    });
}
