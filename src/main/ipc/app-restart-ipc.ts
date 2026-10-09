import type { IpcMain, IpcMainInvokeEvent } from 'electron'

import type { AppRestartResult } from '../../shared/electron-api'
import type { QuitDecision } from '../quit-confirmation'
import { assertAppSender } from './ipc-sender'

export const APP_RESTART_CHANNEL = 'app:restart'

// "Restart now" from inside the app — Settings → Extensions, when a module's
// main entry is waiting on the next launch. A restart stops every agent turn
// in flight the same way a quit does, so it is asked about exactly as a quit
// is: the person's own quit-confirmation question, when the setting is on and
// agents are working. Only once that answers Quit does the app relaunch —
// scheduling `app.relaunch()` first and letting a cancelled quit leave it
// armed would restart the app at whatever quit came next.
export function registerAppRestartIpc(
  ipcMain: Pick<IpcMain, 'handle'>,
  deps: {
    confirm(): Promise<QuitDecision>
    relaunch(): void
    /** Test seam; the real check refuses anything but the app's own window. */
    assertSender?: (event: IpcMainInvokeEvent) => void
  },
): void {
  const assertSender = deps.assertSender ?? assertAppSender
  ipcMain.handle(APP_RESTART_CHANNEL, async (event: IpcMainInvokeEvent): Promise<AppRestartResult> => {
    assertSender(event)
    const decision = await deps.confirm()
    // `pending`: the question is already up for an earlier quit, whose answer
    // decides; this request does nothing of its own.
    if (decision !== 'quit') return { restarting: false }
    deps.relaunch()
    return { restarting: true }
  })
}
