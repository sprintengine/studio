import { ipcRenderer } from 'electron'
import type { ElectronApi } from '../../shared/electron-api'
import { STARTUP_MARK_CHANNEL, startupTimelineEnabledFor } from '../../shared/startup-timeline'

// Boot measurement channel. The gate is read from the same
// environment main reads, so the renderer never reports into a main process that
// is not listening — and never pays for the marks when nobody asked to measure.
export const startupApi = {
  startupTimelineEnabled: startupTimelineEnabledFor(process.env),
  // Fire-and-forget `send`, like the boot-complete handshake: main answers by
  // printing a read-out, and boot must never wait on a diagnostic.
  reportStartupMark: (id: string, atEpochMs: number): void => {
    ipcRenderer.send(STARTUP_MARK_CHANNEL, id, atEpochMs)
  },
} satisfies Pick<ElectronApi, 'startupTimelineEnabled' | 'reportStartupMark'>
