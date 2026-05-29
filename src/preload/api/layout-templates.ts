import { ipcRenderer } from 'electron'
import type { ElectronApi } from '../../shared/electron-api'
import type {
  LayoutTemplateInstallResult,
  UserLayoutTemplateListResult,
} from '../../shared/layouts/template-manifest'

export const layoutTemplatesApi = {
  installUserLayoutTemplateFolder: (srcDir: string): Promise<LayoutTemplateInstallResult> =>
    ipcRenderer.invoke('layout-templates:install-folder', srcDir),
  listUserLayoutTemplates: (): Promise<UserLayoutTemplateListResult> =>
    ipcRenderer.invoke('layout-templates:list'),
} satisfies Pick<ElectronApi, 'installUserLayoutTemplateFolder' | 'listUserLayoutTemplates'>
