import type { IpcMain } from 'electron'

import type { DesignSystemBundleLintRunResult } from '../../shared/design-system/bundle-lint-run'
import type { DesignSystemRegenResult } from '../../shared/design-system/derived-files'
import type { DesignSystemScaffoldResult } from '../../shared/design-system/bundle-scaffold'
import type { DesignSystemLibraryReadResult } from '../../shared/design-system/library'
import type { DesignSystemBundleReadResult } from '../../shared/design-system/bundle-view'
import type {
  DesignSystemAttachResult,
  DesignSystemAttachSource,
} from '../../shared/design-system/attach'
import { regenerateDesignSystemDerivedFiles } from '../design-system/derived-file-runner'
import { forkBundleScriptInUtilityProcess } from '../design-system/utility-process-fork'
import {
  scaffoldDesignSystemBundle,
  seedDesignSystemBundle,
} from '../design-system/bundle-scaffold'
import { resolveDesignSystemTemplatesDir } from '../design-system/templates-path'
import { resolveDesignSystemBrandDemoSeedDir } from '../design-system/brand-demo-path'
import { runDesignSystemBundleLint } from '../design-system/bundle-lint-run'
import {
  defaultDesignSystemLibraryRoot,
  defaultDesignSystemRegistryPath,
  forgetDesignSystemFolder,
  listDesignSystemLibrary,
  readDesignSystemLibraryEntry,
  registerDesignSystemFolder,
  type LibraryPaths,
} from '../design-system/library-registry'
import { attachDesignSystemBundle } from '../design-system/attach'
import { readDesignSystemBundle } from '../design-system/bundle-read'

/** The two paths the library needs: its registry file, and the legacy copy root. */
function libraryPaths(): LibraryPaths {
  return {
    registryPath: defaultDesignSystemRegistryPath(),
    legacyRoot: defaultDesignSystemLibraryRoot(),
  }
}

function parseAttachSource(value: unknown): DesignSystemAttachSource | null {
  if (typeof value !== 'object' || value === null) return null
  const source = value as Record<string, unknown>
  if (source.kind === 'library' && typeof source.id === 'string' && source.id.trim().length > 0) {
    return { kind: 'library', id: source.id }
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
  // Create a new bundle in a folder the user chose — seeded from one they have,
  // or bare from the shipped templates (item 2005). The ONE place the design
  // surface writes a bundle, and only ever into the folder the user picked.
  ipcMain.handle(
    'design-system:seed-bundle',
    (
      _event,
      sourceDir: unknown,
      targetDir: unknown,
      name: unknown,
      summary: unknown,
    ): Promise<DesignSystemScaffoldResult> =>
      seedDesignSystemBundle({
        sourceDir: typeof sourceDir === 'string' && sourceDir.trim() ? sourceDir : null,
        targetDir: typeof targetDir === 'string' ? targetDir : '',
        name: typeof name === 'string' ? name : '',
        summary: typeof summary === 'string' ? summary : '',
        templatesDir: resolveDesignSystemTemplatesDir(),
      }),
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
  // The Design door's reader (item 2002): one call returns everything the door
  // draws for one bundle directory. Read-only — it opens files and nothing else.
  ipcMain.handle(
    'design-system:read-bundle',
    (_event, bundleDir: unknown): Promise<DesignSystemBundleReadResult> =>
      readDesignSystemBundle(typeof bundleDir === 'string' ? bundleDir : ''),
  )
  // The library: a REGISTRY OF PATHS the user pointed at (item 2004), read live.
  // Nothing here copies a bundle, and nothing writes inside a registered folder.
  ipcMain.handle('design-system:library-list', () => listDesignSystemLibrary(libraryPaths()))
  ipcMain.handle(
    'design-system:library-read',
    (_event, id: unknown): Promise<DesignSystemLibraryReadResult> => {
      if (typeof id !== 'string' || id.trim().length === 0) {
        return Promise.resolve({
          ok: false,
          message: 'No design system id provided.',
          sourceState: 'missing',
        })
      }
      return readDesignSystemLibraryEntry(libraryPaths(), id)
    },
  )
  ipcMain.handle('design-system:library-register', (_event, folderPath: unknown) =>
    registerDesignSystemFolder(libraryPaths(), typeof folderPath === 'string' ? folderPath : ''),
  )
  ipcMain.handle('design-system:library-forget', (_event, id: unknown) =>
    forgetDesignSystemFolder(libraryPaths(), typeof id === 'string' ? id : ''),
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
      return attachDesignSystemBundle(parsedSource, workspaceRoot, libraryPaths())
    },
  )
}
