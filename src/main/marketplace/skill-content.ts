// Bundled skill payload integrity. The catalogue snapshot ships each plugin
// skill folder's bytes under resources/marketplace/skills/<entryId>/<folder>/
// and records per-file sha256 digests plus a folder contentDigest on the
// marketplace entry. This module recomputes those digests over the bundled
// bytes so an install never copies content that disagrees with what the
// packaged index (and the trust prompt) describe — tampered, truncated, or
// skewed payloads fail closed. Electron-free on purpose: the marketplace
// publish gate runs it under plain node.

import { createHash } from 'node:crypto'
import { lstat, readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'

import type { MarketplacePluginSkillFile } from '../../shared/marketplace'

/**
 * Folder digest formula, shared with the publishing tool that builds the
 * catalogue snapshot: sha256 over the sorted `<path>\0<sha256>` lines of the
 * file listing, joined with `\n`. Both sides must compute it the same way or
 * every bundled skill folder fails the integrity check on install.
 */
export function skillContentDigest(files: readonly MarketplacePluginSkillFile[]): string {
  const canonical = files
    .map((file) => `${file.path}\0${file.sha256}`)
    .sort()
    .join('\n')
  return createHash('sha256').update(canonical, 'utf8').digest('hex')
}

export type SkillFolderVerification = { ok: true } | { ok: false; message: string }

// A single bundled skill file this large is corrupt or hostile, not a real
// skill asset. Cap the read so a tampered multi-GB payload cannot OOM the main
// process before its digest can fail — verification exists to catch exactly
// this case, so it must never buffer the bad bytes whole to detect them.
const MAX_BUNDLED_FILE_BYTES = 8 * 1024 * 1024

/**
 * Verify a bundled skill folder byte-for-byte against its digest listing:
 * exactly the listed files (no extras, no gaps, regular files only) with
 * matching on-disk size AND sha256 per file, and a listing that reproduces
 * `contentDigest`.
 */
export async function verifyBundledSkillFolder(
  folderPath: string,
  files: readonly MarketplacePluginSkillFile[],
  contentDigest: string,
): Promise<SkillFolderVerification> {
  if (files.length === 0) return { ok: false, message: 'Digest listing is empty.' }
  if (skillContentDigest(files) !== contentDigest) {
    return { ok: false, message: 'Digest listing does not reproduce the recorded contentDigest.' }
  }
  const sizeByPath = new Map(files.map((file) => [file.path, file.size]))

  const found: string[] = []
  const walk = async (dir: string, relPrefix: string): Promise<string | undefined> => {
    let names: string[]
    try {
      names = (await readdir(dir)).sort()
    } catch {
      return `Bundled folder ${relPrefix || '.'} is unreadable.`
    }
    for (const name of names) {
      const rel = relPrefix === '' ? name : `${relPrefix}/${name}`
      let stats
      try {
        stats = await lstat(join(dir, name))
      } catch {
        return `Bundled entry ${rel} is unreadable.`
      }
      if (stats.isDirectory()) {
        const problem = await walk(join(dir, name), rel)
        if (problem !== undefined) return problem
        continue
      }
      if (!stats.isFile()) return `Bundled entry ${rel} is not a regular file.`
      // A grown file (or one over the sane cap) can never match its recorded
      // size/digest — reject on the stat, before any readFile buffers it.
      const recorded = sizeByPath.get(rel)
      if (recorded !== undefined && stats.size !== recorded) {
        return `Bundled file ${rel} size ${stats.size} does not match the recorded ${recorded} bytes.`
      }
      if (stats.size > MAX_BUNDLED_FILE_BYTES) {
        return `Bundled file ${rel} is ${stats.size} bytes, over the ${MAX_BUNDLED_FILE_BYTES}-byte cap.`
      }
      found.push(rel)
    }
    return undefined
  }
  const walkProblem = await walk(folderPath, '')
  if (walkProblem !== undefined) return { ok: false, message: walkProblem }

  const expected = new Set(files.map((file) => file.path))
  const extra = found.filter((path) => !expected.has(path))
  if (extra.length > 0) {
    return {
      ok: false,
      message: `Bundled content has files the digest listing does not: ${extra.slice(0, 3).join(', ')}.`,
    }
  }
  const foundSet = new Set(found)
  const missing = files.filter((file) => !foundSet.has(file.path))
  if (missing.length > 0) {
    return {
      ok: false,
      message: `Bundled content is missing listed files: ${missing
        .slice(0, 3)
        .map((file) => file.path)
        .join(', ')}.`,
    }
  }

  for (const file of files) {
    const bytes = await readFile(join(folderPath, file.path))
    const digest = createHash('sha256').update(bytes).digest('hex')
    if (digest !== file.sha256) {
      return { ok: false, message: `Bundled file ${file.path} does not match its recorded digest.` }
    }
  }
  return { ok: true }
}
