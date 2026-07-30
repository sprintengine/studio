import { ipcRenderer } from 'electron'
import type { ElectronApi } from '../../shared/electron-api'
import type { DesignSystemBrandDemoResolveResult } from '../../shared/design-system/brand-demo'
import type { DesignSystemBundleLintRunResult } from '../../shared/design-system/bundle-lint-run'
import type { DesignSystemRegenResult } from '../../shared/design-system/derived-files'
import type { DesignSystemScaffoldResult } from '../../shared/design-system/bundle-scaffold'
import type {
  DesignSystemLibraryListResult,
  DesignSystemLibraryReadResult,
} from '../../shared/design-system/library'
import type {
  DesignSystemAttachResult,
  DesignSystemAttachSource,
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
  resolveDesignSystemBrandDemoSeed: (): Promise<DesignSystemBrandDemoResolveResult> =>
    ipcRenderer.invoke('design-system:resolve-brand-demo-seed'),
  lintDesignSystemBundle: (bundleDir: string): Promise<DesignSystemBundleLintRunResult> =>
    ipcRenderer.invoke('design-system:lint-bundle', bundleDir),
  listDesignSystemLibrary: (): Promise<DesignSystemLibraryListResult> =>
    ipcRenderer.invoke('design-system:library-list'),
  readDesignSystemLibraryEntry: (name: string, version: string): Promise<DesignSystemLibraryReadResult> =>
    ipcRenderer.invoke('design-system:library-read', name, version),
  attachDesignSystemBundle: (
    source: DesignSystemAttachSource,
    workspaceRoot: string,
  ): Promise<DesignSystemAttachResult> =>
    ipcRenderer.invoke('design-system:attach', source, workspaceRoot),
} satisfies Pick<
  ElectronApi,
  | 'regenerateDesignSystemDerivedFiles'
  | 'scaffoldDesignSystemBundle'
  | 'resolveDesignSystemBrandDemoSeed'
  | 'lintDesignSystemBundle'
  | 'listDesignSystemLibrary'
  | 'readDesignSystemLibraryEntry'
  | 'attachDesignSystemBundle'
>
