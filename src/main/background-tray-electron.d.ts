/**
 * The Electron half of the background-mode tray (MC-2156) — everything
 * `background-presence.ts` deliberately does not import, so the last-window-
 * close decision stays testable without a display.
 */
import { Menu } from 'electron';
import { type BackgroundTrayItem } from '../shared/background-mode';
import type { BackgroundTrayActions, BackgroundTrayHandle } from './background-presence';
/**
 * Build the real tray. Returns null when Electron refuses one (no display, no
 * supported desktop environment) — the caller treats that as "no affordance",
 * never as "do not stay running".
 */
export declare function createElectronBackgroundTray(): BackgroundTrayHandle | null;
/** Render the pure item list into an Electron menu. */
export declare function buildElectronBackgroundMenu(items: readonly BackgroundTrayItem[], actions: BackgroundTrayActions): Menu;
