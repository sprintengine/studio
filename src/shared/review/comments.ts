// ReviewComment + ReviewWorkspaceState — the human's review. This lives OUTSIDE
// the brief on purpose: the brief is immutable guide output, while comments and
// reading progress are mutable workspace state a re-run must never clobber. The
// guide never authors a comment; only the human does.

import { ReviewAnchor, validateAnchor } from './anchors'
import {
  checkEnum,
  checkStringArray,
  describeValue,
  isNonEmptyString,
  isPlainObject,
} from './guards'

export const WORKSPACE_STATE_SCHEMA_VERSION = 1

export const COMMENT_SYNC_STATES = ['pending', 'posting', 'posted', 'failed'] as const
export type CommentSyncState = (typeof COMMENT_SYNC_STATES)[number]

export const DIFF_VIEWS = ['side-by-side', 'inline'] as const
export type DiffView = (typeof DIFF_VIEWS)[number]

export type CommentSync =
  | { state: 'pending' }
  | { state: 'posting' }
  | { state: 'posted'; url: string; postedAt: string }
  | { state: 'failed'; error: string } // stays pending; retry allowed

export interface ReviewComment {
  id: string
  path: string
  anchor: ReviewAnchor
  body: string // markdown, authored by the human
  createdAt: string
  sync: CommentSync
}

export interface ReviewWorkspaceState {
  schemaVersion: 1
  changeSetId: string
  readFiles: string[]
  activeStepId?: string
  diffView: DiffView
  comments: ReviewComment[]
}

export type CommentValidation = { ok: true; value: ReviewComment } | { ok: false; errors: string[] }
export type WorkspaceStateValidation =
  | { ok: true; value: ReviewWorkspaceState }
  | { ok: false; errors: string[] }

function validateSync(value: unknown, path: string, errors: string[]): void {
  if (!isPlainObject(value)) {
    errors.push(`${path} must be an object.`)
    return
  }
  if (!checkEnum(value.state, COMMENT_SYNC_STATES, `${path}.state`, errors)) return
  switch (value.state) {
    case 'posted': {
      if (!isNonEmptyString(value.url)) errors.push(`${path}.url must be a non-empty string.`)
      if (!isNonEmptyString(value.postedAt)) errors.push(`${path}.postedAt must be a non-empty string.`)
      break
    }
    case 'failed': {
      if (!isNonEmptyString(value.error)) errors.push(`${path}.error must be a non-empty string.`)
      break
    }
  }
}

function validateCommentShape(value: unknown, path: string, errors: string[]): void {
  if (!isPlainObject(value)) {
    errors.push(`${path} must be an object.`)
    return
  }
  if (!isNonEmptyString(value.id)) errors.push(`${path}.id must be a non-empty string.`)
  if (!isNonEmptyString(value.path)) errors.push(`${path}.path must be a non-empty string.`)
  validateAnchor(value.anchor, `${path}.anchor`, errors)
  if (typeof value.body !== 'string' || value.body.length === 0) errors.push(`${path}.body must be a non-empty string.`)
  if (!isNonEmptyString(value.createdAt)) errors.push(`${path}.createdAt must be a non-empty string.`)
  validateSync(value.sync, `${path}.sync`, errors)
}

export function validateReviewComment(input: unknown): CommentValidation {
  const errors: string[] = []
  validateCommentShape(input, 'comment', errors)
  return errors.length > 0 ? { ok: false, errors } : { ok: true, value: input as unknown as ReviewComment }
}

export function validateReviewWorkspaceState(input: unknown): WorkspaceStateValidation {
  if (!isPlainObject(input)) return { ok: false, errors: ['workspace state must be an object.'] }
  const errors: string[] = []

  if (input.schemaVersion !== WORKSPACE_STATE_SCHEMA_VERSION) {
    errors.push(`state.schemaVersion must be ${WORKSPACE_STATE_SCHEMA_VERSION}; got ${describeValue(input.schemaVersion)}.`)
  }
  if (!isNonEmptyString(input.changeSetId)) errors.push('state.changeSetId must be a non-empty string.')
  checkStringArray(input.readFiles, 'state.readFiles', errors)
  if (input.activeStepId !== undefined && typeof input.activeStepId !== 'string') {
    errors.push('state.activeStepId must be a string when present.')
  }
  checkEnum(input.diffView, DIFF_VIEWS, 'state.diffView', errors)

  if (!Array.isArray(input.comments)) {
    errors.push('state.comments must be an array.')
  } else {
    input.comments.forEach((comment, index) => validateCommentShape(comment, `state.comments[${index}]`, errors))
  }

  return errors.length > 0 ? { ok: false, errors } : { ok: true, value: input as unknown as ReviewWorkspaceState }
}
