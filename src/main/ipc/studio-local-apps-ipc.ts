import type { IpcMain, IpcMainInvokeEvent } from 'electron'

import {
  STUDIO_LOCAL_APPS_CANCEL_OFFER_CHANNEL,
  STUDIO_LOCAL_APPS_OFFER_CHANNEL,
  STUDIO_LOCAL_APPS_REVOKE_CHANNEL,
  STUDIO_LOCAL_APPS_SET_REACH_CHANNEL,
  STUDIO_LOCAL_APPS_STATUS_CHANNEL,
} from '../../shared/studio-local-apps'
import type { StudioRpcService } from '../studio-rpc/studio-rpc-service'

// Settings' front door for the apps paired with Studio's owner socket: read
// them, mint a pairing code, cancel one, revoke an app. IPC-only on purpose,
// as the tailnet's pairing is: no method on the socket reaches any of it, so a
// paired app can neither pair another nor widen its own grant.
//
// And only the app's own window: a code minted here grants a local process
// every scope it names, up to a bypass ceiling, so a module's iframe, a
// webview guest or a window that navigated elsewhere is refused, as the
// extension installer refuses them.
//
// The check is handed in: in main it is `assertAppSender`; in the Studio
// server the window's port is the check (main brokers one only to an app
// window), and `ipc-sender.ts` is Electron's.
export function registerStudioLocalAppsIpc(
  ipcMain: IpcMain,
  service: StudioRpcService,
  assertAppSender: (event: IpcMainInvokeEvent) => void,
): void {
  ipcMain.handle(STUDIO_LOCAL_APPS_STATUS_CHANNEL, (event: IpcMainInvokeEvent) => {
    assertAppSender(event)
    return service.getStatus()
  })
  ipcMain.handle(STUDIO_LOCAL_APPS_OFFER_CHANNEL, (event: IpcMainInvokeEvent, input: unknown) => {
    assertAppSender(event)
    return service.offer(input)
  })
  ipcMain.handle(STUDIO_LOCAL_APPS_CANCEL_OFFER_CHANNEL, (event: IpcMainInvokeEvent, id: unknown) => {
    assertAppSender(event)
    return service.cancelOffer(id)
  })
  ipcMain.handle(STUDIO_LOCAL_APPS_REVOKE_CHANNEL, (event: IpcMainInvokeEvent, id: unknown) => {
    assertAppSender(event)
    return service.revoke(id)
  })
  ipcMain.handle(STUDIO_LOCAL_APPS_SET_REACH_CHANNEL, (event: IpcMainInvokeEvent, id: unknown, reach: unknown) => {
    assertAppSender(event)
    return service.setToolReach(id, reach)
  })
}
