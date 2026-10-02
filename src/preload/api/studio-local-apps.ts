import { ipcRenderer, type IpcRendererEvent } from 'electron'

import {
  STUDIO_LOCAL_APPS_CANCEL_OFFER_CHANNEL,
  STUDIO_LOCAL_APPS_CHANGED_CHANNEL,
  STUDIO_LOCAL_APPS_OFFER_CHANNEL,
  STUDIO_LOCAL_APPS_REVOKE_CHANNEL,
  STUDIO_LOCAL_APPS_SET_REACH_CHANNEL,
  STUDIO_LOCAL_APPS_STATUS_CHANNEL,
  type StudioLocalAppOfferInput,
  type StudioLocalAppToolReach,
  type StudioLocalAppOfferView,
  type StudioLocalAppsStatus,
} from '../../shared/studio-local-apps'
import type { ElectronApi } from '../../shared/electron-api'

// The apps paired with Studio's owner socket, for Settings: the list, the
// one-time pairing code, and revocation, with every change pushed.
export const studioLocalAppsApi = {
  studioLocalAppsStatus: (): Promise<StudioLocalAppsStatus> =>
    ipcRenderer.invoke(STUDIO_LOCAL_APPS_STATUS_CHANNEL) as Promise<StudioLocalAppsStatus>,
  studioLocalAppsOffer: (input: StudioLocalAppOfferInput): Promise<StudioLocalAppOfferView> =>
    ipcRenderer.invoke(STUDIO_LOCAL_APPS_OFFER_CHANNEL, input) as Promise<StudioLocalAppOfferView>,
  studioLocalAppsCancelOffer: (id: string): Promise<StudioLocalAppsStatus> =>
    ipcRenderer.invoke(STUDIO_LOCAL_APPS_CANCEL_OFFER_CHANNEL, id) as Promise<StudioLocalAppsStatus>,
  studioLocalAppsRevoke: (id: string): Promise<StudioLocalAppsStatus> =>
    ipcRenderer.invoke(STUDIO_LOCAL_APPS_REVOKE_CHANNEL, id) as Promise<StudioLocalAppsStatus>,
  studioLocalAppsSetReach: (id: string, reach: StudioLocalAppToolReach): Promise<StudioLocalAppsStatus> =>
    ipcRenderer.invoke(STUDIO_LOCAL_APPS_SET_REACH_CHANNEL, id, reach) as Promise<StudioLocalAppsStatus>,
  onStudioLocalAppsChanged: (cb: (status: StudioLocalAppsStatus) => void): (() => void) => {
    const handler = (_: IpcRendererEvent, status: StudioLocalAppsStatus) => cb(status)
    ipcRenderer.on(STUDIO_LOCAL_APPS_CHANGED_CHANNEL, handler)
    return () => ipcRenderer.removeListener(STUDIO_LOCAL_APPS_CHANGED_CHANNEL, handler)
  },
} satisfies Pick<
  ElectronApi,
  | 'studioLocalAppsStatus'
  | 'studioLocalAppsOffer'
  | 'studioLocalAppsCancelOffer'
  | 'studioLocalAppsRevoke'
  | 'studioLocalAppsSetReach'
  | 'onStudioLocalAppsChanged'
>
