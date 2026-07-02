import type { IpcMain } from 'electron'

import type { DesignSystemRegenResult } from '../../shared/design-system/derived-files'
import type { DesignSystemScaffoldResult } from '../../shared/design-system/bundle-scaffold'
import type {
  DesignSystemLibraryReadResult,
  DesignSystemReleaseResult,
} from '../../shared/design-system/library'
import { regenerateDesignSystemDerivedFiles } from '../design-system/derived-file-runner'
import { forkBundleScriptInUtilityProcess } from '../design-system/utility-process-fork'
import { scaffoldDesignSystemBundle } from '../design-system/bundle-scaffold'
import { resolveDesignSystemTemplatesDir } from '../design-system/templates-path'
import { resolveDesignSystemBrandDemoSeedDir } from '../design-system/brand-demo-path'
import {
  defaultDesignSystemLibraryRoot,
  listDesignSystemLibrary,
  readDesignSystemLibraryEntry,
  releaseDesignSystemBundle,
} from '../design-system/library-registry'

// Regenerates design-system derived files (tokens.css, catalog/index.html) by
// forking the bundle's own generator scripts in a utility process. Triggered
// on designer-turn completion in the guided-brief studio and callable on
// demand (release and attach reuse it). A root with no bundle resolves ok
// with zero bundles, so non-design-system flows are untouched.
//
// Scaffolding stamps the bundle layout from resources/design-system/templates
// into a workspace for the Design Wizard's design-system preset; it never
// overwrites an existing bundle.
export function registerDesignSystemIpc(ipcMain: IpcMain): void {
  ipcMain.handle(
    'design-system:regenerate-derived',
    (_event, rootDir: unknown): Promise<DesignSystemRegenResult> => {
      if (typeof rootDir !== 'string' || rootDir.trim().length === 0) {
        return Promise.resolve({ ok: false, bundles: [], message: 'No root directory provided.' })
      }
      return regenerateDesignSystemDerivedFiles(rootDir, forkBundleScriptInUtilityProcess)
    },
  )
  ipcMain.handle(
    'design-system:scaffold-bundle',
    (_event, workspaceRoot: unknown, name: unknown, summary: unknown): Promise<DesignSystemScaffoldResult> => {
      if (typeof workspaceRoot !== 'string' || workspaceRoot.trim().length === 0) {
        return Promise.resolve({ ok: false, message: 'No workspace root provided.' })
      }
      return scaffoldDesignSystemBundle({
        workspaceRoot,
        name: typeof name === 'string' ? name : '',
        summary: typeof summary === 'string' ? summary : '',
        templatesDir: resolveDesignSystemTemplatesDir(),
      })
    },
  )
  ipcMain.handle('design-system:resolve-brand-demo-seed', () =>
    resolveDesignSystemBrandDemoSeedDir(),
  )
  // Library release + list/read: immutable versioned copies under
  // ~/.multicode/design-systems/<name>/<version>/ (library-registry.ts).
  ipcMain.handle(
    'design-system:release',
    (_event, bundleDir: unknown, version: unknown): Promise<DesignSystemReleaseResult> => {
      if (typeof bundleDir !== 'string' || bundleDir.trim().length === 0) {
        return Promise.resolve({ ok: false, stage: 'request', message: 'No bundle directory provided.' })
      }
      if (typeof version !== 'string' || version.trim().length === 0) {
        return Promise.resolve({ ok: false, stage: 'request', message: 'No release version provided.' })
      }
      return releaseDesignSystemBundle(
        bundleDir,
        version,
        defaultDesignSystemLibraryRoot(),
        forkBundleScriptInUtilityProcess,
      )
    },
  )
  ipcMain.handle('design-system:library-list', () =>
    listDesignSystemLibrary(defaultDesignSystemLibraryRoot()),
  )
  ipcMain.handle(
    'design-system:library-read',
    (_event, name: unknown, version: unknown): Promise<DesignSystemLibraryReadResult> => {
      if (typeof name !== 'string' || typeof version !== 'string') {
        return Promise.resolve({ ok: false, message: 'A design-system name and version are required.' })
      }
      return readDesignSystemLibraryEntry(defaultDesignSystemLibraryRoot(), name, version)
    },
  )
}
