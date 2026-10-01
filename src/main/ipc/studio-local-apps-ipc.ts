import type { IpcMain } from 'electron'

import {
  STUDIO_LOCAL_APPS_CANCEL_OFFER_CHANNEL,
  STUDIO_LOCAL_APPS_OFFER_CHANNEL,
  STUDIO_LOCAL_APPS_REVOKE_CHANNEL,
  STUDIO_LOCAL_APPS_STATUS_CHANNEL,
} from '../../shared/studio-local-apps'
import type { StudioRpcService } from '../studio-rpc/studio-rpc-service'

// Settings' front door for the apps paired with Studio's owner socket: read
// them, mint a pairing code, cancel one, revoke an app. IPC-only on purpose,
// as the tailnet's pairing is: no method on the socket reaches any of it, so a
// paired app can neither pair another nor widen its own grant.
export function registerStudioLocalAppsIpc(ipcMain: IpcMain, service: StudioRpcService): void {
  ipcMain.handle(STUDIO_LOCAL_APPS_STATUS_CHANNEL, () => service.getStatus())
  ipcMain.handle(STUDIO_LOCAL_APPS_OFFER_CHANNEL, (_event, input: unknown) => service.offer(input))
  ipcMain.handle(STUDIO_LOCAL_APPS_CANCEL_OFFER_CHANNEL, (_event, id: unknown) => service.cancelOffer(id))
  ipcMain.handle(STUDIO_LOCAL_APPS_REVOKE_CHANNEL, (_event, id: unknown) => service.revoke(id))
}
