import { ipcRenderer } from 'electron'
import type { ElectronApi } from '../../shared/electron-api'
import type { DesignSystemRegenResult } from '../../shared/design-system/derived-files'

export const designSystemApi = {
  regenerateDesignSystemDerivedFiles: (rootDir: string): Promise<DesignSystemRegenResult> =>
    ipcRenderer.invoke('design-system:regenerate-derived', rootDir),
} satisfies Pick<ElectronApi, 'regenerateDesignSystemDerivedFiles'>
