import { ipcRenderer } from 'electron'
import type { ElectronApi } from '../../shared/electron-api'
import type { DesignSystemBundleLintRunResult } from '../../shared/design-system/bundle-lint-run'
import type { DesignSystemRegenResult } from '../../shared/design-system/derived-files'
import type { DesignSystemScaffoldResult } from '../../shared/design-system/bundle-scaffold'
import type { DesignSystemBundleReadResult } from '../../shared/design-system/bundle-view'
import type {
  DesignSystemLibraryListResult,
  DesignSystemRegisterResult,
} from '../../shared/design-system/library'
import type {
  DesignSystemAttachResult,
  DesignSystemAttachSource,
  DesignSystemDetachResult,
} from '../../shared/design-system/attach'

export const designSystemApi = {
  regenerateDesignSystemDerivedFiles: (rootDir: string): Promise<DesignSystemRegenResult> =>
    ipcRenderer.invoke('design-system:regenerate-derived', rootDir),
  seedDesignSystemBundle: (
    sourceDir: string | null,
    targetDir: string,
    name: string,
    summary: string,
  ): Promise<DesignSystemScaffoldResult> =>
    ipcRenderer.invoke('design-system:seed-bundle', sourceDir, targetDir, name, summary),
  lintDesignSystemBundle: (bundleDir: string): Promise<DesignSystemBundleLintRunResult> =>
    ipcRenderer.invoke('design-system:lint-bundle', bundleDir),
  readDesignSystemBundle: (bundleDir: string): Promise<DesignSystemBundleReadResult> =>
    ipcRenderer.invoke('design-system:read-bundle', bundleDir),
  listDesignSystemLibrary: (): Promise<DesignSystemLibraryListResult> =>
    ipcRenderer.invoke('design-system:library-list'),
  registerDesignSystemFolder: (folderPath: string): Promise<DesignSystemRegisterResult> =>
    ipcRenderer.invoke('design-system:library-register', folderPath),
  forgetDesignSystemFolder: (id: string): Promise<{ ok: true; forgotten: boolean }> =>
    ipcRenderer.invoke('design-system:library-forget', id),
  attachDesignSystemBundle: (
    source: DesignSystemAttachSource,
    workspaceRoot: string,
  ): Promise<DesignSystemAttachResult> =>
    ipcRenderer.invoke('design-system:attach', source, workspaceRoot),
  detachDesignSystemBundle: (workspaceRoot: string): Promise<DesignSystemDetachResult> =>
    ipcRenderer.invoke('design-system:detach', workspaceRoot),
} satisfies Pick<
  ElectronApi,
  | 'regenerateDesignSystemDerivedFiles'
  | 'seedDesignSystemBundle'
  | 'lintDesignSystemBundle'
  | 'readDesignSystemBundle'
  | 'listDesignSystemLibrary'
  | 'registerDesignSystemFolder'
  | 'forgetDesignSystemFolder'
  | 'attachDesignSystemBundle'
  | 'detachDesignSystemBundle'
>
