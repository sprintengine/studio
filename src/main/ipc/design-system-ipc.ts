import type { IpcMain } from 'electron'

import type { DesignSystemRegenResult } from '../../shared/design-system/derived-files'
import { regenerateDesignSystemDerivedFiles } from '../design-system/derived-file-runner'
import { forkBundleScriptInUtilityProcess } from '../design-system/utility-process-fork'

// Regenerates design-system derived files (tokens.css, catalog/index.html) by
// forking the bundle's own generator scripts in a utility process. Triggered
// on designer-turn completion in the guided-brief studio and callable on
// demand (release and attach reuse it). A root with no bundle resolves ok
// with zero bundles, so non-design-system flows are untouched.
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
}
