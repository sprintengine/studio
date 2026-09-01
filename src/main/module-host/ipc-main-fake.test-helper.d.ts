import type { IpcMain } from 'electron';
export type FakeIpcMain = {
    ipcMain: IpcMain;
    /** Every channel ever handled, in registration order; removal does not erase history. */
    handled: string[];
    /** Invoke a currently-registered handler the way ipcMain.handle would. */
    invoke(channel: string, ...args: unknown[]): Promise<unknown>;
};
export declare function createFakeIpcMain(): FakeIpcMain;
