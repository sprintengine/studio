// ReviewChangeSet — the normalized diff every review surface projects. Produced
// by ingestion (MC-1676 local, MC-1678 PR); never rendered raw. This module owns
// the types and the hand-rolled validator; it holds no I/O.

import {
  checkEnum,
  checkOptionalString,
  describeValue,
  isIsoTimestamp,
  isNonEmptyString,
  isNonNegativeInt,
  isPlainObject,
} from './guards'

export const CHANGESET_SCHEMA_VERSION = 1

export const REVIEW_SOURCE_KINDS = ['pull-request', 'branch', 'patch'] as const
export type ReviewSourceKind = (typeof REVIEW_SOURCE_KINDS)[number]

// 'bitbucket' joins this union later; the validator rejects unknown providers
// explicitly rather than silently passing them.
export const PULL_REQUEST_PROVIDERS = ['github', 'github-enterprise'] as const
export type PullRequestProvider = (typeof PULL_REQUEST_PROVIDERS)[number]

export const CHANGE_FILE_STATUSES = ['added', 'modified', 'deleted', 'renamed'] as const
export type ChangeFileStatus = (typeof CHANGE_FILE_STATUSES)[number]

export const HUNK_LINE_KINDS = ['context', 'add', 'del'] as const
export type HunkLineKind = (typeof HUNK_LINE_KINDS)[number]

export type ReviewSource =
  | {
      kind: 'pull-request'
      provider: PullRequestProvider
      host: string
      owner: string
      repo: string
      number: number
      url: string
    }
  | { kind: 'branch'; repoRoot: string; baseRef: string; headRef: string }
  | { kind: 'patch'; label?: string }

export interface ChangeSetHunk {
  oldStart: number
  oldLines: number
  newStart: number
  newLines: number
  lines: Array<{ kind: HunkLineKind; text: string }>
}

export interface ChangeSetFile {
  path: string
  oldPath?: string // set when status is 'renamed'
  status: ChangeFileStatus
  binary: boolean
  additions: number
  deletions: number
  hunks: ChangeSetHunk[] // empty when binary
}

export interface ReviewChangeSet {
  schemaVersion: 1
  id: string // stable content hash of (source identity + headSha/patch digest)
  source: ReviewSource
  title: string
  description?: string
  baseRef: string
  baseSha?: string
  headRef?: string
  headSha?: string // absent only for pasted patches
  files: ChangeSetFile[]
  stats: { files: number; additions: number; deletions: number }
  fetchedAt: string // ISO-8601
}

export type ChangeSetValidation =
  | { ok: true; value: ReviewChangeSet }
  | { ok: false; errors: string[] }

function validateSource(value: unknown, path: string, errors: string[]): void {
  if (!isPlainObject(value)) {
    errors.push(`${path} must be an object.`)
    return
  }
  if (!checkEnum(value.kind, REVIEW_SOURCE_KINDS, `${path}.kind`, errors)) return
  switch (value.kind) {
    case 'pull-request': {
      checkEnum(value.provider, PULL_REQUEST_PROVIDERS, `${path}.provider`, errors)
      if (!isNonEmptyString(value.host)) errors.push(`${path}.host must be a non-empty string.`)
      if (!isNonEmptyString(value.owner)) errors.push(`${path}.owner must be a non-empty string.`)
      if (!isNonEmptyString(value.repo)) errors.push(`${path}.repo must be a non-empty string.`)
      if (!Number.isInteger(value.number) || (value.number as number) <= 0) {
        errors.push(`${path}.number must be a positive integer; got ${describeValue(value.number)}.`)
      }
      if (!isNonEmptyString(value.url)) errors.push(`${path}.url must be a non-empty string.`)
      break
    }
    case 'branch': {
      if (!isNonEmptyString(value.repoRoot)) errors.push(`${path}.repoRoot must be a non-empty string.`)
      if (!isNonEmptyString(value.baseRef)) errors.push(`${path}.baseRef must be a non-empty string.`)
      if (!isNonEmptyString(value.headRef)) errors.push(`${path}.headRef must be a non-empty string.`)
      break
    }
    case 'patch': {
      checkOptionalString(value.label, `${path}.label`, errors)
      break
    }
  }
}

function validateHunk(value: unknown, path: string, errors: string[]): void {
  if (!isPlainObject(value)) {
    errors.push(`${path} must be an object.`)
    return
  }
  for (const field of ['oldStart', 'oldLines', 'newStart', 'newLines'] as const) {
    if (!isNonNegativeInt(value[field])) {
      errors.push(`${path}.${field} must be a non-negative integer; got ${describeValue(value[field])}.`)
    }
  }
  if (!Array.isArray(value.lines)) {
    errors.push(`${path}.lines must be an array.`)
    return
  }
  value.lines.forEach((line, index) => {
    const linePath = `${path}.lines[${index}]`
    if (!isPlainObject(line)) {
      errors.push(`${linePath} must be an object.`)
      return
    }
    checkEnum(line.kind, HUNK_LINE_KINDS, `${linePath}.kind`, errors)
    if (typeof line.text !== 'string') errors.push(`${linePath}.text must be a string.`)
  })
}

function validateFile(value: unknown, path: string, errors: string[]): void {
  if (!isPlainObject(value)) {
    errors.push(`${path} must be an object.`)
    return
  }
  if (!isNonEmptyString(value.path)) errors.push(`${path}.path must be a non-empty string.`)
  checkOptionalString(value.oldPath, `${path}.oldPath`, errors)
  const status = checkEnum(value.status, CHANGE_FILE_STATUSES, `${path}.status`, errors)
  if (status && value.status === 'renamed' && !isNonEmptyString(value.oldPath)) {
    errors.push(`${path}.oldPath is required when status is 'renamed'.`)
  }
  if (typeof value.binary !== 'boolean') errors.push(`${path}.binary must be a boolean.`)
  if (!isNonNegativeInt(value.additions)) errors.push(`${path}.additions must be a non-negative integer.`)
  if (!isNonNegativeInt(value.deletions)) errors.push(`${path}.deletions must be a non-negative integer.`)
  if (!Array.isArray(value.hunks)) {
    errors.push(`${path}.hunks must be an array.`)
    return
  }
  if (value.binary === true && value.hunks.length > 0) {
    errors.push(`${path}.hunks must be empty when binary is true.`)
  }
  value.hunks.forEach((hunk, index) => validateHunk(hunk, `${path}.hunks[${index}]`, errors))
}

function validateStats(value: unknown, path: string, errors: string[]): void {
  if (!isPlainObject(value)) {
    errors.push(`${path} must be an object.`)
    return
  }
  for (const field of ['files', 'additions', 'deletions'] as const) {
    if (!isNonNegativeInt(value[field])) {
      errors.push(`${path}.${field} must be a non-negative integer; got ${describeValue(value[field])}.`)
    }
  }
}

export function validateReviewChangeSet(input: unknown): ChangeSetValidation {
  if (!isPlainObject(input)) return { ok: false, errors: ['changeset must be an object.'] }
  const errors: string[] = []

  if (input.schemaVersion !== CHANGESET_SCHEMA_VERSION) {
    errors.push(`changeset.schemaVersion must be ${CHANGESET_SCHEMA_VERSION}; got ${describeValue(input.schemaVersion)}.`)
  }
  if (!isNonEmptyString(input.id)) errors.push('changeset.id must be a non-empty string.')
  validateSource(input.source, 'changeset.source', errors)
  if (!isNonEmptyString(input.title)) errors.push('changeset.title must be a non-empty string.')
  checkOptionalString(input.description, 'changeset.description', errors)
  if (!isNonEmptyString(input.baseRef)) errors.push('changeset.baseRef must be a non-empty string.')
  checkOptionalString(input.baseSha, 'changeset.baseSha', errors)
  checkOptionalString(input.headRef, 'changeset.headRef', errors)
  checkOptionalString(input.headSha, 'changeset.headSha', errors)

  if (!Array.isArray(input.files)) {
    errors.push('changeset.files must be an array.')
  } else {
    input.files.forEach((file, index) => validateFile(file, `changeset.files[${index}]`, errors))
  }

  validateStats(input.stats, 'changeset.stats', errors)
  if (!isIsoTimestamp(input.fetchedAt)) {
    errors.push('changeset.fetchedAt must be an ISO-8601 timestamp string.')
  }

  return errors.length > 0 ? { ok: false, errors } : { ok: true, value: input as unknown as ReviewChangeSet }
}
