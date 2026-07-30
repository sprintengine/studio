import type { IpcMain } from 'electron'

import type { DesignSystemBundleLintRunResult } from '../../shared/design-system/bundle-lint-run'
import type { DesignSystemRegenResult } from '../../shared/design-system/derived-files'
import type { DesignSystemScaffoldResult } from '../../shared/design-system/bundle-scaffold'
import type { DesignSystemLibraryReadResult } from '../../shared/design-system/library'
import type {
  DesignSystemAttachResult,
  DesignSystemAttachSource,
} from '../../shared/design-system/attach'
import { regenerateDesignSystemDerivedFiles } from '../design-system/derived-file-runner'
import { forkBundleScriptInUtilityProcess } from '../design-system/utility-process-fork'
import { scaffoldDesignSystemBundle } from '../design-system/bundle-scaffold'
import { resolveDesignSystemTemplatesDir } from '../design-system/templates-path'
import { resolveDesignSystemBrandDemoSeedDir } from '../design-system/brand-demo-path'
import { runDesignSystemBundleLint } from '../design-system/bundle-lint-run'
import {
  defaultDesignSystemLibraryRoot,
  listDesignSystemLibrary,
  readDesignSystemLibraryEntry,
} from '../design-system/library-registry'
import { attachDesignSystemBundle } from '../design-system/attach'

function parseAttachSource(value: unknown): DesignSystemAttachSource | null {
  if (typeof value !== 'object' || value === null) return null
  const source = value as Record<string, unknown>
  if (
    source.kind === 'library' &&
    typeof source.name === 'string' &&
    typeof source.version === 'string'
  ) {
    return { kind: 'library', name: source.name, version: source.version }
  }
  if (source.kind === 'folder' && typeof source.path === 'string' && source.path.trim().length > 0) {
    return { kind: 'folder', path: source.path }
  }
  return null
}

// Regenerates design-system derived files (tokens.css, catalog/index.html) by
// forking the bundle's own generator scripts in a utility process. Triggered
// on designer-turn completion in the guided-brief studio and callable on
// demand (attach reuses it). A root with no bundle resolves ok
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
  // On-demand bundle lint: the guided-brief studio's validating preview, which
  // forks the bundle's own scripts/lint.mjs. It is the author's contribution
  // gate — no viewer surface calls it.
  ipcMain.handle(
    'design-system:lint-bundle',
    (_event, bundleDir: unknown): Promise<DesignSystemBundleLintRunResult> => {
      if (typeof bundleDir !== 'string' || bundleDir.trim().length === 0) {
        return Promise.resolve({ ok: false, kind: 'error', message: 'No bundle directory provided.' })
      }
      return runDesignSystemBundleLint(bundleDir, forkBundleScriptInUtilityProcess)
    },
  )
  // Library list/read: bundles under ~/.multicode/design-systems/<name>/<version>/
  // (library-registry.ts). Read-only — the app-local release pipeline that used
  // to write them was removed 2026-07-30.
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
  // Attach: one-time copy of a bundle (library entry or browsed
  // folder) into a consuming workspace at design-system/, provenance stamped
  // into the copy. An existing design-system/ is a typed 'conflict' refusal.
  ipcMain.handle(
    'design-system:attach',
    (_event, source: unknown, workspaceRoot: unknown): Promise<DesignSystemAttachResult> => {
      const parsedSource = parseAttachSource(source)
      if (!parsedSource) {
        return Promise.resolve({
          ok: false,
          stage: 'request',
          message: 'An attach source (library name+version, or a folder path) is required.',
        })
      }
      if (typeof workspaceRoot !== 'string' || workspaceRoot.trim().length === 0) {
        return Promise.resolve({ ok: false, stage: 'request', message: 'No workspace root provided.' })
      }
      return attachDesignSystemBundle(parsedSource, workspaceRoot, defaultDesignSystemLibraryRoot())
    },
  )
}
