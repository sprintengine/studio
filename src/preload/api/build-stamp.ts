import { ipcRenderer } from 'electron'
import { BUILD_STAMP_CHANNEL, type BuildStamp } from '../../shared/build-stamp'
import type { ElectronApi } from '../../shared/electron-api'

// Build-identity report. The stamp has to come from the renderer
// bundle, not from here: preload is rebuilt and reloaded with the window, while
// the renderer is the half that hot-reloads out from under a running main. This
// is only the wire.
export const buildStampApi = {
  // Fire-and-forget `send`, like the boot and startup-mark handshakes: main
  // answers by comparing and logging, and nothing in the window waits on it.
  reportBuildStamp: (stamp: BuildStamp): void => {
    ipcRenderer.send(BUILD_STAMP_CHANNEL, stamp)
  },
} satisfies Pick<ElectronApi, 'reportBuildStamp'>
