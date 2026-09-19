import type { IpcMain } from 'electron'

import type { CliVersionAdvisoriesInput, CliVersionAdvisoriesResult } from '../../shared/electron-api'
import { readCliVersionAdvisories, setCliVersionChecksEnabled } from '../cli-version-advisory-service'
import { isRecord } from '../../shared/records'

export type CliVersionIpcHandlers = {
  read(input?: CliVersionAdvisoriesInput): Promise<CliVersionAdvisoriesResult>
  setEnabled(enabled: boolean): boolean
}

// `cli-version:advisories` runs detection (cached a minute) and the registry
// lookups (cached an hour) and answers with one advisory per CLI. The service
// pushes `cli-version:advisories-changed` when the set of outdated CLIs moved,
// so a Settings re-check and the poller reach every window the same way.
export function registerCliVersionIpc(ipcMain: IpcMain, overrides: Partial<CliVersionIpcHandlers> = {}): void {
  const read = overrides.read ?? ((input?: CliVersionAdvisoriesInput) => readCliVersionAdvisories(input))
  const setEnabled = overrides.setEnabled ?? setCliVersionChecksEnabled

  ipcMain.handle('cli-version:advisories', async (_event, input?: unknown): Promise<CliVersionAdvisoriesResult> => {
    const parsed = isRecord(input) ? input : {}
    const request: CliVersionAdvisoriesInput = {
      ...(parsed.force === true ? { force: true } : {}),
      ...(isRecord(parsed.cliRuntimes)
        ? { cliRuntimes: parsed.cliRuntimes as CliVersionAdvisoriesInput['cliRuntimes'] }
        : {}),
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
