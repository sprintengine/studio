import { ipcRenderer } from 'electron'
import type { ElectronApi } from '../../shared/electron-api'
import {
  INTEGRATIONS_CHANNELS,
  type IntegrationRemovalOptions,
  type IntegrationRemovalPlan,
  type IntegrationRemovalReport,
} from '../../shared/integration-removal'

// Settings ▸ General ▸ Remove integrations.
export const integrationsApi = {
  integrationsPlan: (options: IntegrationRemovalOptions): Promise<IntegrationRemovalPlan> =>
    ipcRenderer.invoke(INTEGRATIONS_CHANNELS.plan, options),
  integrationsRemove: (options: IntegrationRemovalOptions): Promise<IntegrationRemovalReport> =>
    ipcRenderer.invoke(INTEGRATIONS_CHANNELS.remove, options),
  integrationsQuitApp: (): Promise<void> => ipcRenderer.invoke(INTEGRATIONS_CHANNELS.quit),
} satisfies Pick<ElectronApi, 'integrationsPlan' | 'integrationsRemove' | 'integrationsQuitApp'>
