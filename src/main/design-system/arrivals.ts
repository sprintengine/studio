import { readFile } from 'fs/promises'
import { join } from 'path'

import {
  DESIGN_SYSTEM_MANIFEST_FILENAME,
  parseDesignSystemManifest,
} from '../../shared/design-system/manifest'
import type {
  DesignSystemArrivalsResult,
  DesignSystemBundleArrivals,
} from '../../shared/design-system/arrivals'
import { resolveDesignSystemAddedAt } from './entry-added-at'
import { listDesignSystemLibrary, type LibraryPaths } from './library-registry'

// Arrival dates for the whole library, WITHOUT reading a single bundle.
//
// `readDesignSystemBundle` already returns an `addedAt` map, but it returns it
// alongside every component's markup and every asset inlined as a data URI —
// megabytes across the IPC boundary, for a number the Extensions drawer wants on
// a row it draws whether or not the door was ever opened. This is the same fact
// on its own: manifest in, dates out.
//
// READ ONLY, like everything else the library does to a user's folder: the
// manifest is opened, `git log` is asked when the folder is in a repo, and
// nothing is written anywhere.

/**
 * Every registered bundle we can read, with when each declared entry arrived.
 *
 * A broken registration is SKIPPED rather than thrown: the library list is the
 * surface that shows a missing folder as a named broken row and offers the
 * repair. A count is not that surface — one unreadable folder must not delete
 * the number the other three systems earned.
 */
export async function listDesignSystemArrivals(
  paths: LibraryPaths,
): Promise<DesignSystemArrivalsResult> {
  const listed = await listDesignSystemLibrary(paths)
  const bundles: DesignSystemBundleArrivals[] = []
  for (const entry of listed.entries) {
    // The registry's own probe already decided which folders are bundles; only
    // those are worth opening again.
    if (entry.sourceState !== 'ok') continue
    const addedAt = await arrivalsFor(entry.path)
    if (!addedAt) continue
    bundles.push({ bundleId: entry.id, path: entry.path, addedAt })
  }
  return { bundles }
}

/** One folder's dates, or null when it stopped being a readable bundle. */
async function arrivalsFor(bundleDir: string): Promise<Record<string, string> | null> {
  try {
    const contents = await readFile(join(bundleDir, DESIGN_SYSTEM_MANIFEST_FILENAME), 'utf8')
    // The canonical parser, never a local re-read: a bundle declaring contents
    // groups we did not anticipate gets dates for them too.
    const manifest = parseDesignSystemManifest(contents)
    return await resolveDesignSystemAddedAt(bundleDir, manifest)
  } catch {
    // The folder moved, or the manifest broke, between the probe and here. That
    // is a row for the library list to explain, not a reason to fail the count.
    return null
  }
}
