/**
 * Background mode (MC-2156): what happens when the last window closes, and the
 * tray presence that stands in for it.
 *
 * Closing a window becomes a pure presentation event — main services (Studio
 * gateway, `SprintRuntime`, the automations engine, the mobile bridge) are
 * never consulted here and never touched, which is what makes "close the
 * window at night, sprints keep running" true. The power-save blocker is
 * likewise untouched: it is refcounted off active runs in
 * `sprint-power-manager.ts`, and a window closing is not a run going idle.
 *
 * Electron is injected rather than imported so the last-window-close decision —
 * the one behavior an unattended machine depends on — is testable with no
 * window and no display. The real Tray/Menu wiring lives in
 * `background-tray-electron.ts`.
 */
import { type BackgroundStatus, type BackgroundTrayItem } from '../shared/background-mode';
/** The slice of Electron's `Tray` this presence uses. */
export type BackgroundTrayHandle = {
    setToolTip(text: string): void;
    setContextMenu(menu: unknown): void;
    on(event: 'click' | 'right-click', listener: () => void): void;
    destroy(): void;
};
export type BackgroundTrayActions = {
    open(): void;
    quit(): void;
};
export type BackgroundPresenceDeps = {
    platform: string;
    /** Read at close time, not captured: the user can flip the setting mid-session. */
    isBackgroundModeEnabled: () => boolean;
    readStatus: () => BackgroundStatus;
    /** Null when no tray could be created (no display, unsupported desktop). */
    createTray: () => BackgroundTrayHandle | null;
    buildMenu: (items: readonly BackgroundTrayItem[], actions: BackgroundTrayActions) => unknown;
    actions: BackgroundTrayActions;
    logDiagnostic?: (input: {
        level: 'info' | 'warning';
        title: string;
        message: string;
    }) => void;
    timers?: {
        setInterval(handler: () => void, ms: number): unknown;
        clearInterval(handle: unknown): void;
    };
};
export type BackgroundPresence = ReturnType<typeof createBackgroundPresence>;
export declare function createBackgroundPresence(deps: BackgroundPresenceDeps): {
    /**
     * The last-window-close decision. `'stay'` leaves the process (and every
     * main service with it) running; `'quit'` is today's behavior.
     */
    onWindowAllClosed(): "quit" | "stay";
    /** A window is on screen again: the tray is a stand-in for one, so it goes. */
    onWindowOpened(): void;
    /** Quit disposes the tray before the graceful shutdown path runs. */
    onBeforeQuit(): void;
    isTrayVisible(): boolean;
};
