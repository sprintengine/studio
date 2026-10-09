import { app, type IpcMain } from 'electron'

import { moduleAppStateMirrorFor } from '../module-host/module-app-state-mirror'

/**
 * Push route for module app state: the renderer's `module:<id>` namespaces
 * (Settings section values, `setModuleAppState`). Same one-way contract as
 * module enablement: the renderer owns the values, main keeps the persisted
 * copy a module's `entry.main` reads (`MainHost.getModuleAppState`), and
 * there is no read path back.
 */
export function registerModuleAppStateIpc(ipcMain: IpcMain): void {
  ipcMain.handle('modules:set-app-state', (_event, bag: unknown): void => {
    moduleAppStateMirrorFor(app.getPath('userData')).set(bag)
  })
}
