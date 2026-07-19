// Change-set ingestion service (MC-1676). Turns a review source — a branch-vs-base
// diff or a pasted patch — into a validated ReviewChangeSet and persists it for
// the workspace. The pull-request source (MC-1678) plugs into the same provider
// registry without touching this file's logic. Node/Electron-main only; the
// renderer reaches it exclusively through review IPC (src/main/ipc/review-ipc.ts).

import { createHash, randomUUID } from 'crypto'
import { mkdir, readFile, rename, unlink, writeFile } from 'fs/promises'
import { join } from 'path'
import type {
  ReviewChangeSetReadResult,
  ReviewSourceInput,
  ReviewSourceProbe,
} from '../../shared/electron-api'
import {
  validateReviewChangeSet,
  type ChangeSetFile,
  type ReviewChangeSet,
  type ReviewSource,
  type ReviewSourceKind,
} from '../../shared/review'
import { runGit } from '../git-utils'
import { parsePatch } from './patch-parse'

// Mirrors the 5 MiB text-read bound in src/main/filesystem-read-limits.ts and caps
// the number of files a single review can carry, so a runaway diff fails with a
// named limit instead of exhausting memory.
export const MAX_PATCH_BYTES = 5 * 1024 * 1024
export const MAX_CHANGESET_FILES = 400

const CHANGESET_FILE = 'changeset.json'
// A pasted patch carries no base ref; the schema requires a non-empty baseRef, so
// this synthetic marker stands in and reads clearly in the UI's base column.
const PATCH_BASE_REF = '(patch)'
const PULL_REQUEST_NOT_INSTALLED = 'Pull-request sources arrive with the GitHub provider.'

interface ReviewSourceBuild {
  source: ReviewSource
  title: string
  description?: string
  baseRef: string
  baseSha?: string
  headRef?: string
  headSha?: string
  files: ChangeSetFile[]
  stats: { files: number; additions: number; deletions: number }
  // Stable material identifying this content; the change-set id is its hash, so
  // re-ingesting unchanged content yields the same id.
  identity: string
}

export interface ReviewSourceProvider {
  probe(input: ReviewSourceInput): Promise<ReviewSourceProbe>
  build(input: ReviewSourceInput): Promise<ReviewSourceBuild>
}

const providers = new Map<ReviewSourceKind, ReviewSourceProvider>()

export function registerReviewSourceProvider(kind: ReviewSourceKind, provider: ReviewSourceProvider): void {
  providers.set(kind, provider)
}

export class ReviewChangeSetService {
  // Cheap probe used live by the creation flow. Never throws to the renderer —
  // an unresolvable ref or unparsable patch comes back as { ok: false, error }.
  async detect(input: ReviewSourceInput): Promise<ReviewSourceProbe> {
    const provider = providers.get(input.kind)
    if (!provider) return { ok: false, error: providerMissingMessage(input.kind) }
    try {
      return await provider.probe(input)
    } catch (error) {
      return { ok: false, error: messageOf(error) }
    }
  }

  // Normalize a source into a validated change set WITHOUT persisting it. This is
  // the freshness probe (MC-1682): the panel rebuilds the current change set to
  // compare its head sha + per-file diffs against the walkthrough it already has,
  // and must not overwrite the on-disk change set the current brief walks.
  async build(input: ReviewSourceInput): Promise<ReviewChangeSet> {
    const provider = providers.get(input.kind)
    if (!provider) throw new Error(providerMissingMessage(input.kind))
    const build = await provider.build(input)
    const changeset = assembleChangeSet(build)
    const validation = validateReviewChangeSet(changeset)
    if (!validation.ok) {
      throw new Error(`Internal error: produced an invalid change set (${validation.errors[0]}).`)
    }
    return validation.value
  }

  // Full normalization + atomic persistence. Throws on a bad source or an
  // internal normalization bug rather than writing an invalid file to disk.
  async ingest(input: ReviewSourceInput, targetDir: string): Promise<ReviewChangeSet> {
    const changeset = await this.build(input)
    await writeChangeSetAtomic(targetDir, changeset)
    return changeset
  }

  async read(targetDir: string): Promise<ReviewChangeSetReadResult> {
    const filePath = join(targetDir, CHANGESET_FILE)
    let raw: string
    try {
      raw = await readFile(filePath, 'utf-8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { ok: true, changeset: null }
      return { ok: false, error: messageOf(error) }
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      return { ok: false, error: 'Stored change set is not valid JSON.' }
    }
    const validation = validateReviewChangeSet(parsed)
    if (!validation.ok) return { ok: false, error: `Stored change set is invalid: ${validation.errors[0]}` }
    return { ok: true, changeset: validation.value }
  }
}

export function createReviewChangeSetService(): ReviewChangeSetService {
  return new ReviewChangeSetService()
}

// The service owns the persistence layout; callers pass workspace identity and
// never construct `.multi-code/review/...` paths themselves.
export function reviewChangeSetDir(workspaceRoot: string, workspaceId: string): string {
  if (!workspaceRoot) throw new Error('Review change set requires a workspace root.')
  if (!/^[A-Za-z0-9._-]+$/.test(workspaceId)) {
    throw new Error(`Invalid workspace id for review storage: ${JSON.stringify(workspaceId)}.`)
  }
  return join(workspaceRoot, '.multi-code', 'review', workspaceId)
}

function assembleChangeSet(build: ReviewSourceBuild): ReviewChangeSet {
  const changeset: ReviewChangeSet = {
    schemaVersion: 1,
    id: `cs_${sha256(build.identity).slice(0, 24)}`,
    source: build.source,
    title: build.title,
    baseRef: build.baseRef,
    files: build.files,
    stats: build.stats,
    fetchedAt: new Date().toISOString(),
  }
  if (build.description !== undefined) changeset.description = build.description
  if (build.baseSha !== undefined) changeset.baseSha = build.baseSha
  if (build.headRef !== undefined) changeset.headRef = build.headRef
  if (build.headSha !== undefined) changeset.headSha = build.headSha
  return changeset
}

// Write-temp-then-rename: a crash mid-write leaves the stale changeset.json (or
// nothing) intact rather than a truncated file, since rename is atomic on a POSIX
// filesystem and the temp file shares the target directory.
async function writeChangeSetAtomic(targetDir: string, changeset: ReviewChangeSet): Promise<void> {
  await mkdir(targetDir, { recursive: true })
  const finalPath = join(targetDir, CHANGESET_FILE)
  const tempPath = join(targetDir, `.${CHANGESET_FILE}.${randomUUID()}.tmp`)
  const data = `${JSON.stringify(changeset, null, 2)}\n`
  try {
    await writeFile(tempPath, data, 'utf-8')
    await rename(tempPath, finalPath)
  } catch (error) {
    await unlink(tempPath).catch(() => {})
    throw error
  }
}

const branchProvider: ReviewSourceProvider = {
  async build(input) {
    if (input.kind !== 'branch') throw new Error('Branch provider received a non-branch source.')
    const { repoRoot, baseRef, headRef } = input
    const baseSha = await resolveSha(repoRoot, baseRef)
    const headSha = await resolveSha(repoRoot, headRef)
    // Three-dot (merge-base) semantics: the changes on head since it forked from
    // base, ignoring commits added to base afterwards.
    const diffText = await runGit(repoRoot, ['diff', '--patch', '--find-renames', `${baseRef}...${headRef}`])
    assertPatchSize(diffText)
    const parsed = parsePatch(diffText)
    if (!parsed.ok) throw new Error(parsed.error)
    assertFileCount(parsed.files.length)
    return {
      source: { kind: 'branch', repoRoot, baseRef, headRef },
      title: `${headRef} → ${baseRef}`,
      baseRef,
      baseSha,
      headRef,
      headSha,
      files: parsed.files,
      stats: parsed.stats,
      identity: `branch\n${repoRoot}\n${baseSha}\n${headSha}\n${sha256(diffText)}`,
    }
  },
  probe(input) {
    return deriveProbe(this, input)
  },
}

const patchProvider: ReviewSourceProvider = {
  async build(input) {
    if (input.kind !== 'patch') throw new Error('Patch provider received a non-patch source.')
    const text = input.text
    if (text.trim().length === 0) throw new Error('The patch is empty.')
    assertPatchSize(text)
    const parsed = parsePatch(text)
    if (!parsed.ok) throw new Error(parsed.error)
    if (parsed.files.length === 0) {
      throw new Error("Not a unified diff — expected a 'diff --git' or '---' header.")
    }
    assertFileCount(parsed.files.length)
    const label = input.label?.trim()
    return {
      source: label ? { kind: 'patch', label } : { kind: 'patch' },
      title: label && label.length > 0 ? label : 'Pasted patch',
      baseRef: PATCH_BASE_REF,
      files: parsed.files,
      stats: parsed.stats,
      // Normalize CRLF so the same logical patch pasted from different editors
      // yields one stable id.
      identity: `patch\n${sha256(text.replace(/\r\n/g, '\n'))}`,
    }
  },
  probe(input) {
    return deriveProbe(this, input)
  },
}

// Built-in local sources. The pull-request kind is intentionally left
// unregistered until MC-1678 installs its provider; until then detect/ingest fail
// with a clear "not installed" message rather than crashing.
registerReviewSourceProvider('branch', branchProvider)
registerReviewSourceProvider('patch', patchProvider)

async function deriveProbe(provider: ReviewSourceProvider, input: ReviewSourceInput): Promise<ReviewSourceProbe> {
  const build = await provider.build(input)
  return { ok: true, title: build.title, stats: build.stats, headSha: build.headSha }
}

async function resolveSha(repoRoot: string, ref: string): Promise<string> {
  try {
    return (await runGit(repoRoot, ['rev-parse', '--verify', `${ref}^{commit}`])).trim()
  } catch {
    throw new Error(`Couldn't find "${ref}" in this repository.`)
  }
}

function assertPatchSize(text: string): void {
  const bytes = Buffer.byteLength(text, 'utf8')
  if (bytes > MAX_PATCH_BYTES) {
    throw new Error(`Patch is too large to review (${formatBytes(bytes)}; limit ${formatBytes(MAX_PATCH_BYTES)}).`)
  }
}

function assertFileCount(count: number): void {
  if (count > MAX_CHANGESET_FILES) {
    throw new Error(`Change set has too many files to review (${count}; limit ${MAX_CHANGESET_FILES}).`)
  }
}

function providerMissingMessage(kind: ReviewSourceKind): string {
  if (kind === 'pull-request') return PULL_REQUEST_NOT_INSTALLED
  return `Review source "${kind}" is not installed.`
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  const mib = bytes / (1024 * 1024)
  if (mib >= 1) return `${mib.toFixed(1)} MiB`
  return `${(bytes / 1024).toFixed(1)} KiB`
}
