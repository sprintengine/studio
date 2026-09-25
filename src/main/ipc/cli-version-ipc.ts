import type { IpcMain } from 'electron'

import type { CliVersionAdvisoriesInput, CliVersionAdvisoriesResult } from '../../shared/electron-api'
import { readCliVersionAdvisories, setCliVersionChecksEnabled } from '../cli-version-advisory-service'
import { isRecord } from '../../shared/records'

export type CliVersionIpcHandlers = {
  read(input?: CliVersionAdvisoriesInput): Promise<CliVersionAdvisoriesResult>
  setEnabled(enabled: boolean): boolean
}

// `cli-version:advisories` answers with one advisory per CLI per machine,
// comparing the installed versions detection last found against the registry
// (cached an hour). `detect` is Settings' Re-check: every machine's CLIs are
// detected again first. The service pushes `cli-version:advisories-changed`
// when the answer moved, so a Settings re-check, an update and the poller reach
// every window the same way.
export function registerCliVersionIpc(ipcMain: IpcMain, overrides: Partial<CliVersionIpcHandlers> = {}): void {
  const read = overrides.read ?? ((input?: CliVersionAdvisoriesInput) => readCliVersionAdvisories(input))
  const setEnabled = overrides.setEnabled ?? setCliVersionChecksEnabled

  ipcMain.handle('cli-version:advisories', async (_event, input?: unknown): Promise<CliVersionAdvisoriesResult> => {
    const parsed = isRecord(input) ? input : {}
    const request: CliVersionAdvisoriesInput = {
      ...(parsed.force === true ? { force: true } : {}),
      ...(parsed.detect === true ? { detect: true } : {}),
    }
    try {
      return await read(request)
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : String(error) }
    }
  })

  ipcMain.handle('cli-version:set-enabled', async (_event, enabled?: unknown): Promise<{ enabled: boolean }> => ({
    enabled: setEnabled(enabled === true),
  }))
}
