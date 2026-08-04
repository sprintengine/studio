import { ipcRenderer } from 'electron'
import type { ElectronApi } from '../../shared/electron-api'
import type { DesignSystemBrandDemoResolveResult } from '../../shared/design-system/brand-demo'
import type { DesignSystemBundleLintRunResult } from '../../shared/design-system/bundle-lint-run'
import type { DesignSystemRegenResult } from '../../shared/design-system/derived-files'
import type { DesignSystemScaffoldResult } from '../../shared/design-system/bundle-scaffold'
import type { DesignSystemBundleReadResult } from '../../shared/design-system/bundle-view'
import type {
  DesignSystemLibraryListResult,
  DesignSystemLibraryReadResult,
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
  scaffoldDesignSystemBundle: (
    workspaceRoot: string,
    name: string,
    summary: string,
  ): Promise<DesignSystemScaffoldResult> =>
    ipcRenderer.invoke('design-system:scaffold-bundle', workspaceRoot, name, summary),
  seedDesignSystemBundle: (
    sourceDir: string | null,
    targetDir: string,
    name: string,
    summary: string,
  ): Promise<DesignSystemScaffoldResult> =>
    ipcRenderer.invoke('design-system:seed-bundle', sourceDir, targetDir, name, summary),
  resolveDesignSystemBrandDemoSeed: (): Promise<DesignSystemBrandDemoResolveResult> =>
    ipcRenderer.invoke('design-system:resolve-brand-demo-seed'),
  lintDesignSystemBundle: (bundleDir: string): Promise<DesignSystemBundleLintRunResult> =>
    ipcRenderer.invoke('design-system:lint-bundle', bundleDir),
  readDesignSystemBundle: (bundleDir: string): Promise<DesignSystemBundleReadResult> =>
    ipcRenderer.invoke('design-system:read-bundle', bundleDir),
  listDesignSystemLibrary: (): Promise<DesignSystemLibraryListResult> =>
    ipcRenderer.invoke('design-system:library-list'),
  readDesignSystemLibraryEntry: (id: string): Promise<DesignSystemLibraryReadResult> =>
    ipcRenderer.invoke('design-system:library-read', id),
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
  | 'scaffoldDesignSystemBundle'
  | 'seedDesignSystemBundle'
  | 'resolveDesignSystemBrandDemoSeed'
  | 'lintDesignSystemBundle'
  | 'readDesignSystemBundle'
  | 'listDesignSystemLibrary'
  | 'readDesignSystemLibraryEntry'
  | 'registerDesignSystemFolder'
  | 'forgetDesignSystemFolder'
  | 'attachDesignSystemBundle'
  | 'detachDesignSystemBundle'
>
