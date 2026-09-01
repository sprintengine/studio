import type { IpcMain } from 'electron';
import { type BuildSkewVerdict, type BuildStamp } from '../shared/build-stamp';
type BuildSkewWatchOptions = {
    mainStamp: BuildStamp;
    /** One line per event. Defaults to the console. */
    log?: (line: string) => void;
    /** Shows the operator one notice. Defaults to nothing — index.ts wires the dialog. */
    announce?: (notice: {
        headline: string;
        detail: string;
    }) => void;
};
export type BuildSkewWatch = {
    recordRendererStamp: (stamp: BuildStamp) => BuildSkewVerdict;
    /** Feeds a raw IPC payload through validation. Returns null when it was not a stamp. */
    recordReportedPayload: (payload: unknown) => BuildSkewVerdict | null;
};
export declare function createBuildSkewWatch({ mainStamp, log, announce, }: BuildSkewWatchOptions): BuildSkewWatch;
/**
 * Listens for the windows' reports. `on`, not `handle`: the renderer is telling
 * main something and must never wait on the answer, the same shape as the boot
 * and startup-mark handshakes.
 */
export declare function attachBuildSkewWatch(ipcMain: IpcMain, watch: BuildSkewWatch): void;
export {};
