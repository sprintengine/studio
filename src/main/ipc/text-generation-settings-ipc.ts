import type { IpcMain } from 'electron'

import type { TextGenerationSettingsStore } from '../text-generation/text-generation-settings-store'

/**
 * Push route for the model-written chat titles setting. Same contract as the
 * background-mode mirror: the renderer owns the preference in `appSettings`,
 * and the process that runs the chats keeps a copy it reads with no window to
 * ask. Registered with the Studio server's domains, because that process is
 * the one that titles the chats it runs. There is no read path back: nothing
 * here writes the value, so a broadcast would only be a second source of truth.
 */
export function registerTextGenerationSettingsIpc(
  ipcMain: IpcMain,
  store: Pick<TextGenerationSettingsStore, 'set'>,
): void {
  ipcMain.handle('text-generation:set-settings', (_event, settings: unknown): void => {
    store.set(settings)
  })
}
