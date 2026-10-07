/**
 * The Electron half of the quit question — what `quit-confirmation.ts`
 * deliberately does not import, so its rules stay testable without a display.
 *
 * A native message box rather than the renderer's ConfirmDialog: the quit is
 * decided in main, and the moment it is asked the renderer may be busy, mid
 * reload, or gone (a tray Quit with every window closed). The native box needs
 * none of it, sits on the focused window as a sheet on macOS, and stands alone
 * when there is no window.
 */
import { BrowserWindow, dialog, type MessageBoxOptions } from 'electron'

import { STUDIO_PRODUCT_NAME } from '../shared/product-identity'
import { isCanvasWorkerWindow } from './canvas/canvas-worker-window'
import { quitConfirmationDetail, type QuitConfirmationAnswer } from './quit-confirmation'

const QUIT_BUTTON = 0
const CANCEL_BUTTON = 1

export async function askToQuitWhileWorking(input: {
  count: number
  signal: AbortSignal
}): Promise<QuitConfirmationAnswer> {
  const options: MessageBoxOptions = {
    type: 'warning',
    message: `Quit ${STUDIO_PRODUCT_NAME}?`,
    detail: quitConfirmationDetail(input.count),
    buttons: ['Quit', 'Cancel'],
    // Return and Escape both cancel: a key pressed out of habit, or a second
    // Cmd+Q's Return, must not stop agents mid-turn. Quitting takes a click.
    defaultId: CANCEL_BUTTON,
    cancelId: CANCEL_BUTTON,
    checkboxLabel: "Don't ask again",
    checkboxChecked: false,
    noLink: true,
    signal: input.signal,
  }
  const focused = BrowserWindow.getFocusedWindow()
  const parent = focused && !focused.isDestroyed() && !isCanvasWorkerWindow(focused) ? focused : null
  const result = parent ? await dialog.showMessageBox(parent, options) : await dialog.showMessageBox(options)
  return { quit: result.response === QUIT_BUTTON, dontAskAgain: result.checkboxChecked }
}
