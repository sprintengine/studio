// Digests of a capability module's own files: what `sprintengine-module sign`
// records in a manifest's `files` field, and what the app checks before it
// trusts a module and again before it loads one.
//
// Reached through the `@sprintengine/module-sdk/signing` subpath (it needs
// node:crypto and node:fs, and the root index must stay loadable in a
// renderer). The app and the CLI both walk a folder through this file, so what
// an author signs and what the app accepts cannot disagree about which files
// count.
//
// The walk refuses what a module cannot vouch for rather than skipping it: a
// symbolic link (its bytes live somewhere the digest does not follow), anything
// that is not a regular file or a directory, and a name no manifest could
// record. Only manifest.json at the root is left out, because it carries the
// digests.

import { createHash } from 'node:crypto'
import { lstatSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

import type { ModuleFileDigests } from './index.js'
import {
  compareModuleFileDigests,
  isPackExcludedPath,
  isSafeManifestRelativePath,
  MODULE_MANIFEST_FILENAME,
  type ThirdPartyManifestIssue,
} from './manifest-validate.js'

/**
 * Which files count.
 *
 * - `installed` (the default): every file in the folder. node_modules, .git and
 *   key files are refused, because pack never ships them — a folder that has
 *   one is a source tree, not a module.
 * - `pack`: the folder as `sprintengine-module pack` will copy it, with those
 *   paths left out. What `sign` records, so a module can be signed in its
 *   source tree and still match once packed.
 */
export type ModuleFileWalk = 'installed' | 'pack'

export type ModuleFileDigestOptions = { walk?: ModuleFileWalk }

export type ModuleFileDigestsResult =
  { ok: true; files: ModuleFileDigests } | { ok: false; files: ModuleFileDigests; issues: ThirdPartyManifestIssue[] }

/** sha256 of every file the module ships, keyed by POSIX path relative to its root. */
export function computeModuleFileDigestsSync(
  moduleRoot: string,
  options: ModuleFileDigestOptions = {},
): ModuleFileDigestsResult {
  const walk = options.walk ?? 'installed'
  const found: ModuleFileDigests = {}
  const issues: ThirdPartyManifestIssue[] = []

  const visit = (absoluteDir: string, relativeDir: string): void => {
    let names: string[]
    try {
      names = readdirSync(absoluteDir).sort()
    } catch (error) {
      issues.push({ path: fileIssuePath(relativeDir), message: `could not be read: ${errorMessage(error)}.` })
      return
    }
    for (const name of names) {
      const relativePath = relativeDir ? `${relativeDir}/${name}` : name
      if (relativePath === MODULE_MANIFEST_FILENAME) continue
      const issuePath = fileIssuePath(relativePath)
      if (!isSafeManifestRelativePath(relativePath)) {
        issues.push({ path: issuePath, message: 'has a name a module manifest cannot record.' })
        continue
      }
      if (isPackExcludedPath(relativePath)) {
        if (walk === 'installed') {
          issues.push({
            path: issuePath,
            message: 'cannot be part of a module: node_modules, .git and key files are never packed or installed.',
          })
        }
        continue
      }
      const absolutePath = join(absoluteDir, name)
      let entry
      try {
        entry = lstatSync(absolutePath)
      } catch (error) {
        issues.push({ path: issuePath, message: `could not be read: ${errorMessage(error)}.` })
        continue
      }
      if (entry.isSymbolicLink()) {
        issues.push({ path: issuePath, message: 'is a symbolic link; a module ships regular files only.' })
      } else if (entry.isDirectory()) {
        visit(absolutePath, relativePath)
      } else if (!entry.isFile()) {
        issues.push({ path: issuePath, message: 'is not a regular file; a module ships regular files only.' })
      } else {
        found[relativePath] = createHash('sha256').update(readFileSync(absolutePath)).digest('hex')
      }
    }
  }

  let rootIsDirectory = false
  try {
    rootIsDirectory = statSync(moduleRoot).isDirectory()
  } catch {
    rootIsDirectory = false
  }
  if (rootIsDirectory) visit(moduleRoot, '')
  else issues.push({ path: 'files', message: 'the module folder does not exist or is not a directory.' })

  const files: ModuleFileDigests = {}
  for (const path of Object.keys(found).sort()) files[path] = found[path]!
  return issues.length > 0 ? { ok: false, files, issues } : { ok: true, files }
}

/**
 * Everything wrong between a module folder and the digests it is held to:
 * files that cannot be digested at all, then the exact-set comparison. Empty
 * means the folder holds exactly the listed files with exactly the listed
 * bytes.
 */
export function moduleFileDigestIssuesSync(
  moduleRoot: string,
  expected: ModuleFileDigests,
  options: ModuleFileDigestOptions & { label?: string } = {},
): ThirdPartyManifestIssue[] {
  const actual = computeModuleFileDigestsSync(moduleRoot, options)
  return [...(actual.ok ? [] : actual.issues), ...compareModuleFileDigests(expected, actual.files, options.label)]
}

function fileIssuePath(relativePath: string): string {
  return relativePath ? `files.${relativePath}` : 'files'
}

// The error code, not the message: a message names the absolute path, and
// these issues reach the app's UI.
function errorMessage(error: unknown): string {
  const code = typeof error === 'object' && error !== null ? (error as { code?: unknown }).code : undefined
  return typeof code === 'string' ? code : 'read error'
}
