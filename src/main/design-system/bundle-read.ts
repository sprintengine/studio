import { readFile, stat } from 'fs/promises'
import { join } from 'path'

import {
  DESIGN_SYSTEM_MANIFEST_FILENAME,
  parseDesignSystemManifest,
} from '../../shared/design-system/manifest'
import {
  parseTokenDocument,
  resolveAccentColor,
} from '../../shared/design-system/tokens-css'
import type {
  DesignSystemBundleReadResult,
  DesignSystemBundleReadFailure,
} from '../../shared/design-system/bundle-view'

// The Design door's reader (item 2002). Reads a bundle directory and returns
// what the door draws, in ONE call — see bundle-view.ts for why.
//
// Read-only by construction: this module opens files and nothing else. It never
// writes into the bundle, never forks its `scripts/*.mjs`, and never lints or
// regenerates. That is what makes pointing the door at a folder someone else
// authored safe, and item 2003 asserts it with a no-fork test.

/** Where a bundle keeps its declared token source of truth. */
const TOKENS_SOURCE_RELATIVE_PATH = join('foundations', 'tokens.tokens.json')

function failure(
  reason: DesignSystemBundleReadFailure,
  path: string,
  message: string,
): DesignSystemBundleReadResult {
  return { ok: false, reason, path, message }
}

/** Node error codes that mean "not there" versus "there but unreadable". */
function codeOf(error: unknown): string | null {
  return error !== null && typeof error === 'object' && 'code' in error
    ? String((error as { code: unknown }).code)
    : null
}

/**
 * Read one design-system bundle directory.
 *
 * Failure is typed and always carries the path, because the rail renders a
 * broken row rather than dropping it: a system whose folder moved is still a
 * system the user pointed at, and silently losing the row would hide the fact
 * that anything is wrong.
 */
export async function readDesignSystemBundle(
  bundleDir: string,
): Promise<DesignSystemBundleReadResult> {
  if (typeof bundleDir !== 'string' || bundleDir.trim().length === 0) {
    return failure('missing', String(bundleDir ?? ''), 'No bundle directory provided.')
  }

  try {
    const stats = await stat(bundleDir)
    if (!stats.isDirectory()) {
      return failure('missing', bundleDir, `Not a directory: ${bundleDir}`)
    }
  } catch (error) {
    const code = codeOf(error)
    if (code === 'ENOENT' || code === 'ENOTDIR') {
      return failure('missing', bundleDir, `That folder is no longer there: ${bundleDir}`)
    }
    return failure('unreadable', bundleDir, `Could not open ${bundleDir}: ${describe(error)}`)
  }

  let manifestContents: string
  try {
    manifestContents = await readFile(join(bundleDir, DESIGN_SYSTEM_MANIFEST_FILENAME), 'utf8')
  } catch (error) {
    const code = codeOf(error)
    if (code === 'ENOENT') {
      return failure(
        'no-manifest',
        bundleDir,
        `That folder has no ${DESIGN_SYSTEM_MANIFEST_FILENAME}, so it is not a design system.`,
      )
    }
    return failure(
      'unreadable',
      bundleDir,
      `Could not read ${DESIGN_SYSTEM_MANIFEST_FILENAME} in ${bundleDir}: ${describe(error)}`,
    )
  }

  // The canonical parser, never a local re-read: it validates schema v1 and
  // preserves unknown fields, which is what lets a bundle declaring contents
  // groups we did not anticipate still render (item 2003).
  let manifest
  try {
    manifest = parseDesignSystemManifest(manifestContents)
  } catch (error) {
    return failure('invalid-manifest', bundleDir, describe(error))
  }

  // Tokens are optional to READ: a bundle mid-authoring may have a manifest and
  // no token file yet. That is not a broken bundle — it is a bundle with no
  // accent to show, so the row renders without a chip.
  const accent = await readAccent(bundleDir)

  return {
    ok: true,
    view: {
      identity: {
        path: bundleDir,
        name: manifest.name,
        version: manifest.version,
        summary: manifest.summary,
        accent,
      },
      manifest,
    },
  }
}

async function readAccent(bundleDir: string): Promise<{ light: string | null; dark: string | null }> {
  let contents: string
  try {
    contents = await readFile(join(bundleDir, TOKENS_SOURCE_RELATIVE_PATH), 'utf8')
  } catch {
    return { light: null, dark: null }
  }
  const document = parseTokenDocument(contents)
  if (!document) return { light: null, dark: null }
  return {
    light: resolveAccentColor(document, 'light'),
    dark: resolveAccentColor(document, 'dark'),
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
