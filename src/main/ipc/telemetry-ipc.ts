import type { IpcMain } from 'electron'

import type { TelemetryConsentStore } from '../telemetry/consent-store'

/**
 * Push route for "Share anonymous usage data". Same contract as the background-
 * mode and appearance mirrors: the renderer owns the preference in
 * `appSettings`, main persists a copy so it can read it with no window open.
 *
 * There is no read path back, and no route for recording an event. The renderer
 * cannot ask main to send anything — every event is emitted where it happens,
 * in main — so this channel is the entire renderer-facing telemetry surface and
 * the only thing it can do is turn collection off.
 */
export function registerTelemetryIpc(ipcMain: IpcMain, store: TelemetryConsentStore): void {
  ipcMain.handle('app:set-telemetry-enabled', (_event, enabled: unknown): void => {
    store.set(enabled !== false)
  })
}
