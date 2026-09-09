import type { IpcMain } from 'electron'

import type { DesignSystemBundleLintRunResult } from '../../shared/design-system/bundle-lint-run'
import type { DesignSystemRegenResult } from '../../shared/design-system/derived-files'
import type { DesignSystemScaffoldResult } from '../../shared/design-system/bundle-scaffold'
import type { DesignSystemArrivalsResult } from '../../shared/design-system/arrivals'
import type { DesignSystemBundleReadResult } from '../../shared/design-system/bundle-view'
import type {
  DesignSystemAttachResult,
  DesignSystemAttachSource,
  DesignSystemDetachResult,
} from '../../shared/design-system/attach'
import { regenerateDesignSystemDerivedFiles } from '../design-system/derived-file-runner'
import { forkBundleScriptInUtilityProcess } from '../design-system/utility-process-fork'
import { seedDesignSystemBundle } from '../design-system/bundle-scaffold'
import { resolveDesignSystemTemplatesDir } from '../design-system/templates-path'
import { runDesignSystemBundleLint } from '../design-system/bundle-lint-run'
import {
  defaultDesignSystemLibraryRoot,
  defaultDesignSystemRegistryPath,
  forgetDesignSystemFolder,
  listDesignSystemLibrary,
  registerDesignSystemFolder,
  type LibraryPaths,
} from '../design-system/library-registry'
import { listDesignSystemArrivals } from '../design-system/arrivals'
import { attachDesignSystemBundle, detachDesignSystemBundle } from '../design-system/attach'
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
// on demand (attach reuses it). A root with no bundle resolves ok
// with zero bundles, so non-design-system flows are untouched.
//
// Scaffolding stamps the bundle layout from resources/design-system/templates
// into the folder the user picked; it never overwrites an existing bundle.
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
  // The Design door's reader (item 2002): one call returns everything the door
  // draws for one bundle directory. Read-only — it opens files and nothing else.
  // On-demand bundle lint: forks the bundle's own scripts/lint.mjs. It is the
  // author's contribution gate — no surface calls it yet (orphan sweep,
  // 2026-09-08), and it is kept as the seam the Design door's bundle view would
  // use rather than deleted along with the runner it is the only route to.
  ipcMain.handle(
    'design-system:lint-bundle',
    (_event, bundleDir: unknown): Promise<DesignSystemBundleLintRunResult> => {
      if (typeof bundleDir !== 'string' || bundleDir.trim().length === 0) {
        return Promise.resolve({ ok: false, kind: 'error', message: 'No bundle directory provided.' })
      }
      return runDesignSystemBundleLint(bundleDir, forkBundleScriptInUtilityProcess)
    },
  )
  ipcMain.handle(
    'design-system:read-bundle',
    (_event, bundleDir: unknown): Promise<DesignSystemBundleReadResult> =>
      readDesignSystemBundle(typeof bundleDir === 'string' ? bundleDir : ''),
  )
  // The library: a REGISTRY OF PATHS the user pointed at (item 2004), read live.
  // Nothing here copies a bundle, and nothing writes inside a registered folder.
  ipcMain.handle('design-system:library-list', () => listDesignSystemLibrary(libraryPaths()))
  // The same library, reduced to arrival dates: what the Extensions drawer's
  // Design row counts without paying for a full read of every bundle.
  // One listing serves every window that asks within the window below, and
  // concurrent askers share one in-flight read: each listing is a `git log`
  // per registered bundle, and every window's rail hook asks at boot and
  // hourly (review, 2026-09-09). A library change drops the memo.
  let arrivalsMemo: { at: number; result: Promise<DesignSystemArrivalsResult> } | null = null
  const ARRIVALS_MEMO_MS = 10 * 60 * 1000
  const forgetArrivals = (): void => {
    arrivalsMemo = null
  }
  ipcMain.handle('design-system:library-arrivals', () => {
    if (arrivalsMemo && Date.now() - arrivalsMemo.at < ARRIVALS_MEMO_MS) return arrivalsMemo.result
    const result = listDesignSystemArrivals(libraryPaths()).catch((error: unknown) => {
      forgetArrivals()
      throw error
    })
    arrivalsMemo = { at: Date.now(), result }
    return result
  })
  ipcMain.handle('design-system:library-register', (_event, folderPath: unknown) => {
    forgetArrivals()
    return registerDesignSystemFolder(libraryPaths(), typeof folderPath === 'string' ? folderPath : '')
  })
  ipcMain.handle('design-system:library-forget', (_event, id: unknown) => {
    forgetArrivals()
    return forgetDesignSystemFolder(libraryPaths(), typeof id === 'string' ? id : '')
  })
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
  // Detach: remove the workspace's design-system/ copy (the Settings surface's
  // Detach/Replace path). The renderer owns the destructive confirmation.
  ipcMain.handle(
    'design-system:detach',
    (_event, workspaceRoot: unknown): Promise<DesignSystemDetachResult> => {
      if (typeof workspaceRoot !== 'string' || workspaceRoot.trim().length === 0) {
        return Promise.resolve({ ok: false, message: 'No workspace root provided.' })
      }
      return detachDesignSystemBundle(workspaceRoot)
    },
  )
}
