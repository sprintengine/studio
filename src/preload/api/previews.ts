import type { IpcRendererEvent } from 'electron'
import { ipc as ipcRenderer } from '../ipc-router'

import type { ElectronApi } from '../../shared/electron-api'
import {
  WEB_PREVIEWS_CHANGED_CHANNEL,
  WEB_PREVIEWS_CLOSE_CHANNEL,
  WEB_PREVIEWS_LIST_CHANNEL,
  WEB_PREVIEWS_OPEN_CHANNEL,
  type PreviewSummary,
} from '../../shared/web-client'

// Previews of an agent's dev server (phase 9 spec, 3.6). Only a web tab has
// them: its server's web front door answers these channels over the tab's
// tunnel. A desktop window shows the native browser pane instead and never
// asks (`clientSupports('previews')` is false there), so main registers
// nothing for them.
export const previewsApi = {
  previewsList: () => ipcRenderer.invoke(WEB_PREVIEWS_LIST_CHANNEL),
  previewsOpen: (input: { port: number; typed?: boolean }) => ipcRenderer.invoke(WEB_PREVIEWS_OPEN_CHANNEL, input),
  previewsClose: (previewId: string) => ipcRenderer.invoke(WEB_PREVIEWS_CLOSE_CHANNEL, { previewId }),
  onPreviewsChanged: (cb: (previews: PreviewSummary[]) => void) => {
    const listener = (_event: IpcRendererEvent, previews: PreviewSummary[]) => cb(previews)
    ipcRenderer.on(WEB_PREVIEWS_CHANGED_CHANNEL, listener)
    return () => {
      ipcRenderer.removeListener(WEB_PREVIEWS_CHANGED_CHANNEL, listener)
    }
  },
} satisfies Pick<ElectronApi, 'previewsList' | 'previewsOpen' | 'previewsClose' | 'onPreviewsChanged'>
