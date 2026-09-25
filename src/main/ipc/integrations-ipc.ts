// Settings ▸ General ▸ Remove integrations: list what the app wrote outside
// its own data, then take it out. Both calls take the same options, so a plan
// and the removal it confirms always cover the same entries.

import type { IpcMain } from 'electron'

import {
  INTEGRATIONS_CHANNELS,
  type IntegrationRemovalOptions,
  type IntegrationRemovalPlan,
  type IntegrationRemovalReport,
} from '../../shared/integration-removal'

export type IntegrationRemovalService = {
  plan(options: IntegrationRemovalOptions): Promise<IntegrationRemovalPlan>
  remove(options: IntegrationRemovalOptions): Promise<IntegrationRemovalReport>
}

/** Only the known fields, with the right types: the renderer's object is not trusted. */
export function sanitizeRemovalOptions(input: unknown): IntegrationRemovalOptions {
  if (typeof input !== 'object' || input === null) return {}
  const raw = input as Record<string, unknown>
  const options: IntegrationRemovalOptions = {}
  if (raw.removeWorktrees === true) options.removeWorktrees = true
  if (raw.deleteAppData === true) options.deleteAppData = true
  if (typeof raw.hostId === 'string' && /^(?:local|wsl:[^\s/\\]+)$/u.test(raw.hostId)) options.hostId = raw.hostId
  return options
}

export function registerIntegrationsIpc(ipcMain: IpcMain, service: IntegrationRemovalService, quit: () => void): void {
  ipcMain.handle(INTEGRATIONS_CHANNELS.plan, (_, input: unknown) => service.plan(sanitizeRemovalOptions(input)))
  ipcMain.handle(INTEGRATIONS_CHANNELS.remove, (_, input: unknown) => service.remove(sanitizeRemovalOptions(input)))
  ipcMain.handle(INTEGRATIONS_CHANNELS.quit, () => {
    quit()
  })
}
