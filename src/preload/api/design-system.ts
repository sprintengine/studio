import { ipcRenderer } from 'electron'
import type { ElectronApi } from '../../shared/electron-api'
import type { DesignSystemRegenResult } from '../../shared/design-system/derived-files'
import type { DesignSystemScaffoldResult } from '../../shared/design-system/bundle-scaffold'
import type {
  DesignSystemLibraryListResult,
  DesignSystemLibraryReadResult,
  DesignSystemReleaseResult,
} from '../../shared/design-system/library'

export const designSystemApi = {
  regenerateDesignSystemDerivedFiles: (rootDir: string): Promise<DesignSystemRegenResult> =>
    ipcRenderer.invoke('design-system:regenerate-derived', rootDir),
  scaffoldDesignSystemBundle: (
    workspaceRoot: string,
    name: string,
    summary: string,
  ): Promise<DesignSystemScaffoldResult> =>
    ipcRenderer.invoke('design-system:scaffold-bundle', workspaceRoot, name, summary),
  resolveDesignSystemBrandDemoSeed: (): Promise<
    { ok: true; path: string } | { ok: false; message: string }
  > => ipcRenderer.invoke('design-system:resolve-brand-demo-seed'),
  releaseDesignSystemBundle: (bundleDir: string, version: string): Promise<DesignSystemReleaseResult> =>
    ipcRenderer.invoke('design-system:release', bundleDir, version),
  listDesignSystemLibrary: (): Promise<DesignSystemLibraryListResult> =>
    ipcRenderer.invoke('design-system:library-list'),
  readDesignSystemLibraryEntry: (name: string, version: string): Promise<DesignSystemLibraryReadResult> =>
    ipcRenderer.invoke('design-system:library-read', name, version),
} satisfies Pick<
  ElectronApi,
  | 'regenerateDesignSystemDerivedFiles'
  | 'scaffoldDesignSystemBundle'
  | 'resolveDesignSystemBrandDemoSeed'
  | 'releaseDesignSystemBundle'
  | 'listDesignSystemLibrary'
  | 'readDesignSystemLibraryEntry'
>
