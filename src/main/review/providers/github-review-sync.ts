// GitHub review write path (MC-1683). The read side (MC-1678) turns a PR URL into
// a change set; this closes the loop the other way: the human's pending comments
// post to the pull request as ONE review, under the reviewer's own account,
// anchored to the same lines they were drawn against.
//
// The rules this module enforces are strict because it is a human-outward action:
//   - COMMENT event only — never APPROVE / REQUEST_CHANGES. Verdicts stay on
//     GitHub's own UI; v1 posts explanation-neutral comments.
//   - Idempotent — a comment already on the PR (sync 'posted') is never re-sent;
//     re-posting a batch skips the already-posted ids.
//   - Never post to a guessed line. GitHub's create-review call is atomic (one bad
//     line rejects the whole batch), so every comment's target line is resolved
//     and validated LOCALLY first. A comment that can't be anchored on the PR's
//     current head is held pending with a visible "line moved" state, and only the
//     comments that resolve cleanly are sent.
//   - Auth is identical to the read path: the gh CLI first (it carries the user's
//     own auth, including GHES hosts), then a REST token fallback. Posts as the
//     authenticated user; there is no bot identity. Secrets never leave main.
//
// Node/Electron-main only; the renderer reaches it exclusively through
// review:post-review IPC (src/main/ipc/review-ipc.ts), which gates the call to a
// real application window — the guide (an agent in a terminal, with no renderer)
// can never reach it.

import { mkdtemp, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  shiftAnchor,
  type AnchorSide,
  type ChangeSetFile,
  type LineDelta,
  type PullRequestProvider,
  type ReviewChangeSet,
  type ReviewComment,
} from '../../../shared/review'
import type { ReviewCommentPostOutcome, ReviewPostReviewResult } from '../../../shared/electron-api'
import { parsePatch } from '../patch-parse'
import { createDefaultGhRunner, defaultResolveToken, type GhRunner } from './github-pr-provider'

const JSON_ACCEPT = 'application/vnd.github+json'
const DIFF_ACCEPT = 'application/vnd.github.v3.diff'
const API_VERSION = '2022-11-28'
const USER_AGENT = 'Multicode-Review'
const POST_FETCH_TIMEOUT_MS = 60_000

// The visible state a held comment keeps: it stays pending (retry-able) and is
// flagged so the tray shows "line moved — review this comment" rather than
// silently posting it somewhere wrong. Matches comments.ts' CommentAnchorStatus.
const MOVED: 'moved' = 'moved'

// A minimal fetch surface so this module needs no DOM lib types. Unlike the read
// path's GET-only shape this carries method + body for the review POST; the
// default binds Node's global fetch, tests inject a stub.
export interface WriteFetchResponseLike {
  ok: boolean
  status: number
  json(): Promise<unknown>
  text(): Promise<string>
}
export type WriteFetchLike = (
  url: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal }
) => Promise<WriteFetchResponseLike>

export interface GithubReviewSyncDeps {
  gh: GhRunner
  fetchImpl: WriteFetchLike
  resolveToken: (host: string, provider: PullRequestProvider) => Promise<string | null>
  // Injectable clock so a posted comment's postedAt is deterministic under test.
  now: () => string
}

// The per-comment outcome + whole-result shape live in the shared IPC contract
// (ReviewCommentPostOutcome / ReviewPostReviewResult) so the renderer applies them
// verbatim; postReview returns that result type directly.
export type PostReviewResult = ReviewPostReviewResult

// One resolved comment ready for the batch: its GitHub line addressing plus the
// originating comment id so the returned review comment can be mapped back to it.
interface ResolvedComment {
  id: string
  path: string
  side: AnchorSide
  startLine: number
  endLine: number
  body: string
}

class HttpError extends Error {
  constructor(
    message: string,
    readonly status: number
  ) {
    super(message)
  }
}

// Post the pending comments as one review on the pull request the change set came
// from. `changeset` is the persisted (read-path) change set — its source carries
// the PR coordinates and the head the comments were anchored against; `comments`
// is the human's workspace-state comment list. Returns a per-comment outcome the
// renderer flips onto its state, and the review URL when anything was posted.
export async function postReview(
  changeset: ReviewChangeSet,
  comments: ReviewComment[],
  deps: GithubReviewSyncDeps
): Promise<PostReviewResult> {
  const source = changeset.source
  if (source.kind !== 'pull-request') {
    // Branch/patch reviews have no remote; the tray never offers Post for them, so
    // reaching here is a programming error, not a user-facing state.
    return { ok: false, error: 'Only pull-request reviews can be posted to a remote.' }
  }
  const pr: PrCoords = {
    provider: source.provider,
    host: source.host,
    owner: source.owner,
    repo: source.repo,
    number: source.number,
  }

  // Everything not already on the PR (pending, or a failed retry); a 'posted'
  // comment is skipped — that is what makes re-posting a batch idempotent.
  const postable = comments.filter((c) => c.sync.state === 'pending' || c.sync.state === 'failed')
  if (postable.length === 0) return { ok: true, outcomes: [] }

  let currentHead: string
  try {
    currentHead = await fetchHeadSha(pr, deps)
  } catch (error) {
    return { ok: false, error: authAwareMessage(error, pr) }
  }

  const headMoved = Boolean(changeset.headSha) && changeset.headSha !== currentHead

  // Files of the PR diff AT THE CURRENT HEAD, keyed by path, used to check that a
  // comment's target line is actually part of the diff (commentable) before it is
  // sent. When the head has not moved the stored change set already is that diff.
  let currentFiles: Map<string, ChangeSetFile>
  // New-side line deltas from the old head to the current head, per path, used to
  // re-anchor new-side comments onto shifted lines.
  let deltasByPath: Map<string, LineDelta[]>
  try {
    if (headMoved) {
      currentFiles = indexFiles(await fetchPullRequestDiff(pr, deps))
      deltasByPath = await fetchNewSideDeltas(pr, changeset.headSha!, currentHead, deps)
    } else {
      currentFiles = indexFiles(changeset.files)
      deltasByPath = new Map()
    }
  } catch (error) {
    return { ok: false, error: authAwareMessage(error, pr) }
  }

  const outcomes: ReviewCommentPostOutcome[] = []
  const batch: ResolvedComment[] = []
  for (const comment of postable) {
    const resolved = resolveComment(comment, headMoved, deltasByPath, currentFiles)
    if (resolved.ok) batch.push(resolved.value)
    else outcomes.push({ id: comment.id, sync: { state: 'pending' }, anchorStatus: MOVED })
  }

  if (batch.length === 0) {
    // Every postable comment moved — nothing to send. The held outcomes above are
    // the whole result; no empty review is created.
    return { ok: true, outcomes }
  }

  let review: PostedReview
  try {
    review = await createReview(pr, currentHead, batch, deps)
  } catch (error) {
    return { ok: false, error: authAwareMessage(error, pr) }
  }

  const postedAt = deps.now()
  for (const resolved of batch) {
    const url = review.commentUrls.get(commentKey(resolved)) ?? review.reviewUrl
    outcomes.push({ id: resolved.id, sync: { state: 'posted', url, postedAt } })
  }
  return { ok: true, reviewUrl: review.reviewUrl, outcomes }
}

interface PrCoords {
  provider: PullRequestProvider
  host: string
  owner: string
  repo: string
  number: number
}

// Resolve a comment to its GitHub line addressing on the current head, or reject
// it (→ held) when it cannot be anchored without guessing.
function resolveComment(
  comment: ReviewComment,
  headMoved: boolean,
  deltasByPath: Map<string, LineDelta[]>,
  currentFiles: Map<string, ChangeSetFile>
): { ok: true; value: ResolvedComment } | { ok: false } {
  // A comment already flagged moved by a freshness re-run is never posted from
  // that state — the reviewer re-reviews it first.
  if (comment.anchorStatus === MOVED) return { ok: false }

  let startLine = comment.anchor.startLine
  let endLine = comment.anchor.endLine

  // Only new-side anchors can move: the old side points at the base, which is
  // fixed across head pushes. Re-anchor new-side comments through the old→new
  // head deltas; a collapsed range (its content was deleted) is held.
  if (headMoved && comment.anchor.side === 'new') {
    const deltas = deltasByPath.get(comment.path)
    if (deltas && deltas.length > 0) {
      const shifted = shiftAnchor(comment.anchor, deltas)
      if (!shifted) return { ok: false }
      startLine = shifted.startLine
      endLine = shifted.endLine
    }
  }

  // Never post to a guessed line: both endpoints must be commentable lines in the
  // current PR diff for this side. A file no longer in the diff, or a line outside
  // any hunk, holds the comment.
  const file = currentFiles.get(comment.path)
  if (!file) return { ok: false }
  const commentable = commentableLines(file, comment.anchor.side)
  if (!commentable.has(startLine) || !commentable.has(endLine)) return { ok: false }

  return { ok: true, value: { id: comment.id, path: comment.path, side: comment.anchor.side, startLine, endLine, body: comment.body } }
}

// The set of line numbers (on the given side) a GitHub review comment may anchor
// to: lines that appear in the diff for that side. New side → added + context
// lines (new-side numbering); old side → deleted + context lines (old-side
// numbering).
function commentableLines(file: ChangeSetFile, side: AnchorSide): Set<number> {
  const lines = new Set<number>()
  for (const hunk of file.hunks) {
    let oldLine = hunk.oldStart
    let newLine = hunk.newStart
    for (const { kind } of hunk.lines) {
      if (side === 'new') {
        if (kind === 'add' || kind === 'context') lines.add(newLine)
      } else if (kind === 'del' || kind === 'context') {
        lines.add(oldLine)
      }
      if (kind !== 'add') oldLine++
      if (kind !== 'del') newLine++
    }
  }
  return lines
}

function indexFiles(files: ChangeSetFile[]): Map<string, ChangeSetFile> {
  return new Map(files.map((file) => [file.path, file]))
}

// Build new-side line deltas per file from a compare(oldHead...newHead) diff. The
// deltas are in old-head (source) line numbering, which is exactly the numbering a
// new-side anchor drawn against oldHead uses, so shiftAnchor maps it to the new
// head. Each maximal run of removed/added lines within a hunk is one delta.
function newSideDeltasFromCompare(files: ChangeSetFile[]): Map<string, LineDelta[]> {
  const byPath = new Map<string, LineDelta[]>()
  for (const file of files) {
    const deltas: LineDelta[] = []
    for (const hunk of file.hunks) {
      let oldLine = hunk.oldStart
      let runStart = 0
      let removed = 0
      let added = 0
      const flush = (): void => {
        if (removed > 0 || added > 0) deltas.push({ start: runStart, removed, added })
        removed = 0
        added = 0
      }
      for (const { kind } of hunk.lines) {
        if (kind === 'context') {
          flush()
          oldLine++
          continue
        }
        if (removed === 0 && added === 0) runStart = oldLine
        if (kind === 'del') {
          removed++
          oldLine++
        } else {
          added++
        }
      }
      flush()
    }
    if (deltas.length > 0) byPath.set(file.path, deltas)
  }
  return byPath
}

async function fetchNewSideDeltas(
  pr: PrCoords,
  oldHead: string,
  newHead: string,
  deps: GithubReviewSyncDeps
): Promise<Map<string, LineDelta[]>> {
  const diff = await fetchCompareDiff(pr, oldHead, newHead, deps)
  const parsed = parsePatch(diff)
  if (!parsed.ok) throw new Error(parsed.error)
  return newSideDeltasFromCompare(parsed.files)
}

// ── GitHub transport: gh-first, REST fallback, mirroring the read path ──────────

async function fetchHeadSha(pr: PrCoords, deps: GithubReviewSyncDeps): Promise<string> {
  if (await deps.gh.available()) {
    const result = await deps.gh.run(['api', ...ghApiHost(pr), pullApiPath(pr)])
    if (result.code === 0) {
      const head = readHeadSha(safeJson(result.stdout))
      if (head) return head
    }
  }
  const token = await deps.resolveToken(pr.host, pr.provider)
  const res = await deps.fetchImpl(restUrl(pr, pullApiPath(pr)), {
    headers: restHeaders(JSON_ACCEPT, token),
    signal: timeoutSignal(POST_FETCH_TIMEOUT_MS),
  })
  if (!res.ok) throw new HttpError(`GitHub request failed (HTTP ${res.status}).`, res.status)
  const head = readHeadSha(await res.json())
  if (!head) throw new Error('GitHub returned an unexpected pull request payload.')
  return head
}

async function fetchPullRequestDiff(pr: PrCoords, deps: GithubReviewSyncDeps): Promise<ChangeSetFile[]> {
  let diff: string | null = null
  if (await deps.gh.available()) {
    const result = await deps.gh.run(['pr', 'diff', String(pr.number), '--repo', ghRepoArg(pr), '--patch'])
    if (result.code === 0) diff = result.stdout
  }
  if (diff === null) {
    const token = await deps.resolveToken(pr.host, pr.provider)
    const res = await deps.fetchImpl(restUrl(pr, pullApiPath(pr)), {
      headers: restHeaders(DIFF_ACCEPT, token),
      signal: timeoutSignal(POST_FETCH_TIMEOUT_MS),
    })
    if (!res.ok) throw new HttpError(`GitHub request failed (HTTP ${res.status}).`, res.status)
    diff = await res.text()
  }
  const parsed = parsePatch(diff)
  if (!parsed.ok) throw new Error(parsed.error)
  return parsed.files
}

async function fetchCompareDiff(
  pr: PrCoords,
  base: string,
  head: string,
  deps: GithubReviewSyncDeps
): Promise<string> {
  const path = `repos/${pr.owner}/${pr.repo}/compare/${base}...${head}`
  if (await deps.gh.available()) {
    const result = await deps.gh.run(['api', ...ghApiHost(pr), path, '-H', `Accept: ${DIFF_ACCEPT}`])
    if (result.code === 0) return result.stdout
  }
  const token = await deps.resolveToken(pr.host, pr.provider)
  const res = await deps.fetchImpl(restUrl(pr, path), {
    headers: restHeaders(DIFF_ACCEPT, token),
    signal: timeoutSignal(POST_FETCH_TIMEOUT_MS),
  })
  if (!res.ok) throw new HttpError(`GitHub request failed (HTTP ${res.status}).`, res.status)
  return res.text()
}

interface PostedReview {
  reviewUrl: string
  // (path\nside\nline) -> per-comment html_url, when GitHub returned them.
  commentUrls: Map<string, string>
}

// Create ONE review (event COMMENT) carrying every resolved comment, then read the
// review's comments back to record their individual permalinks. The read-back is
// best-effort: the review is already posted, so a failure to fetch per-comment
// URLs falls back to the review URL rather than reporting a false failure.
async function createReview(
  pr: PrCoords,
  commitId: string,
  batch: ResolvedComment[],
  deps: GithubReviewSyncDeps
): Promise<PostedReview> {
  const body = JSON.stringify({
    commit_id: commitId,
    event: 'COMMENT',
    comments: batch.map(githubComment),
  })
  const reviewsPath = `repos/${pr.owner}/${pr.repo}/pulls/${pr.number}/reviews`

  // gh-first, then REST — but only when gh is ABSENT. Unlike the read helpers, a
  // gh POST that errors is not retried through REST: a create is a mutation, and a
  // gh call that failed for an ambiguous reason must not risk a second, duplicate
  // review. The error surfaces instead, and the reviewer retries deliberately.
  let review: unknown
  if (await deps.gh.available()) {
    review = await ghPostJson(reviewsPath, body, pr, deps)
  }
  if (review === undefined) {
    const token = await deps.resolveToken(pr.host, pr.provider)
    const res = await deps.fetchImpl(restUrl(pr, reviewsPath), {
      method: 'POST',
      headers: { ...restHeaders(JSON_ACCEPT, token), 'Content-Type': 'application/json' },
      body,
      signal: timeoutSignal(POST_FETCH_TIMEOUT_MS),
    })
    if (!res.ok) throw new HttpError(reviewPostMessage(res.status), res.status)
    review = await res.json()
  }

  const reviewId = readReviewId(review)
  const reviewUrl = readString(review, 'html_url') ?? prWebUrl(pr)
  const commentUrls =
    reviewId !== undefined ? await fetchReviewCommentUrls(pr, reviewId, deps).catch(() => new Map<string, string>()) : new Map<string, string>()
  return { reviewUrl, commentUrls }
}

function githubComment(resolved: ResolvedComment): Record<string, unknown> {
  const side = resolved.side === 'new' ? 'RIGHT' : 'LEFT'
  const comment: Record<string, unknown> = { path: resolved.path, line: resolved.endLine, side, body: resolved.body }
  if (resolved.endLine !== resolved.startLine) {
    comment.start_line = resolved.startLine
    comment.start_side = side
  }
  return comment
}

async function fetchReviewCommentUrls(
  pr: PrCoords,
  reviewId: number,
  deps: GithubReviewSyncDeps
): Promise<Map<string, string>> {
  const path = `repos/${pr.owner}/${pr.repo}/pulls/${pr.number}/reviews/${reviewId}/comments`
  let payload: unknown
  if (await deps.gh.available()) {
    const result = await deps.gh.run(['api', ...ghApiHost(pr), path])
    if (result.code === 0) payload = safeJson(result.stdout)
  }
  if (payload === undefined) {
    const token = await deps.resolveToken(pr.host, pr.provider)
    const res = await deps.fetchImpl(restUrl(pr, path), {
      headers: restHeaders(JSON_ACCEPT, token),
      signal: timeoutSignal(POST_FETCH_TIMEOUT_MS),
    })
    if (!res.ok) return new Map()
    payload = await res.json()
  }
  const urls = new Map<string, string>()
  if (Array.isArray(payload)) {
    for (const entry of payload) {
      if (!isRecord(entry)) continue
      const path_ = readString(entry, 'path')
      const url = readString(entry, 'html_url')
      const line = typeof entry.line === 'number' ? entry.line : undefined
      const side = entry.side === 'LEFT' ? 'old' : 'new'
      if (path_ && url && line !== undefined) urls.set(`${path_}\n${side}\n${line}`, url)
    }
  }
  return urls
}

function commentKey(resolved: ResolvedComment): string {
  return `${resolved.path}\n${resolved.side}\n${resolved.endLine}`
}

// gh api POST reads the JSON body from a file via --input; GhRunner runs argv-only
// (no stdin), so the body rides through a short-lived temp file that is always
// removed. gh prints the created resource as JSON on stdout.
async function ghPostJson(
  apiPath: string,
  body: string,
  pr: PrCoords,
  deps: GithubReviewSyncDeps
): Promise<unknown> {
  const dir = await mkdtemp(join(tmpdir(), 'review-post-'))
  const file = join(dir, 'body.json')
  try {
    await writeFile(file, body, 'utf-8')
    const result = await deps.gh.run(['api', ...ghApiHost(pr), apiPath, '--method', 'POST', '--input', file])
    if (result.code !== 0) throw new HttpError(ghErrorMessage(result.stderr), ghStatus(result.stderr))
    return safeJson(result.stdout) ?? {}
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {})
  }
}

function ghApiHost(pr: PrCoords): string[] {
  // gh api targets github.com by default; an enterprise host must be named.
  return pr.provider === 'github' ? [] : ['--hostname', pr.host]
}

function ghRepoArg(pr: PrCoords): string {
  return `${pr.host}/${pr.owner}/${pr.repo}`
}

function pullApiPath(pr: PrCoords): string {
  return `repos/${pr.owner}/${pr.repo}/pulls/${pr.number}`
}

function restUrl(pr: PrCoords, apiPath: string): string {
  const base = pr.provider === 'github' ? 'https://api.github.com' : `https://${pr.host}/api/v3`
  return `${base}/${apiPath}`
}

function prWebUrl(pr: PrCoords): string {
  return `https://${pr.host}/${pr.owner}/${pr.repo}/pull/${pr.number}`
}

function restHeaders(accept: string, token: string | null): Record<string, string> {
  const headers: Record<string, string> = { Accept: accept, 'User-Agent': USER_AGENT, 'X-GitHub-Api-Version': API_VERSION }
  if (token) headers.Authorization = `Bearer ${token}`
  return headers
}

// ── Error copy (kept in step with the read path's github-pr-provider) ───────────

function authAwareMessage(error: unknown, pr: PrCoords): string {
  if (error instanceof HttpError) {
    const setup = authSetupHint(pr.provider)
    if (error.status === 401) return `GitHub rejected the credentials (401). ${setup}`
    if (error.status === 403) return `GitHub denied the request (403) — rate limit or missing scope. ${setup}`
    if (error.status === 404) return `Pull request not found, or your credentials cannot access ${pr.owner}/${pr.repo} (404). ${setup}`
    return error.message
  }
  return error instanceof Error ? error.message : String(error)
}

function reviewPostMessage(status: number): string {
  // A 422 on create-review is GitHub rejecting a line we believed was in the diff
  // (e.g. the head moved between our read and the POST). Name it plainly.
  if (status === 422) return 'GitHub could not anchor one of the comments (422) — the pull request may have changed. Refresh the review and try again.'
  return `Posting the review failed (HTTP ${status}).`
}

function authSetupHint(provider: PullRequestProvider): string {
  const token = provider === 'github' ? 'GH_TOKEN' : 'GH_ENTERPRISE_TOKEN'
  return `Install the GitHub CLI and run \`gh auth login\`, or set a ${token} environment token with access to this repository.`
}

// gh prints "HTTP 401" / "gh: ... (HTTP 404)" style diagnostics on stderr; pull the
// status back out so the review sync can render the same auth-aware copy as REST.
function ghStatus(stderr: string): number {
  const match = stderr.match(/HTTP (\d{3})/)
  return match ? Number(match[1]) : 0
}

function ghErrorMessage(stderr: string): string {
  const status = ghStatus(stderr)
  if (status === 401 || status === 403 || status === 404 || status === 422) return `GitHub request failed (HTTP ${status}).`
  const firstLine = stderr.split('\n').find((line) => line.trim().length > 0)
  return firstLine?.trim() || 'The GitHub CLI could not post the review.'
}

// ── Small payload readers ───────────────────────────────────────────────────────

function readHeadSha(json: unknown): string | null {
  if (!isRecord(json)) return null
  const head = json.head
  if (isRecord(head) && typeof head.sha === 'string' && head.sha.length > 0) return head.sha
  return null
}

function readReviewId(json: unknown): number | undefined {
  if (isRecord(json) && typeof json.id === 'number') return json.id
  return undefined
}

function readString(json: unknown, key: string): string | undefined {
  if (isRecord(json) && typeof json[key] === 'string' && (json[key] as string).length > 0) return json[key] as string
  return undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

function timeoutSignal(ms: number): AbortSignal | undefined {
  try {
    return AbortSignal.timeout(ms)
  } catch {
    return undefined
  }
}

// Default deps: the shared gh runner (identical to the read path, shell-PATH
// fallback included), Node's global fetch, the read path's env-token resolver, and
// a real clock.
export function defaultReviewSyncDeps(): GithubReviewSyncDeps {
  return {
    gh: createDefaultGhRunner(),
    fetchImpl: (url, init) => fetch(url, init) as unknown as Promise<WriteFetchResponseLike>,
    resolveToken: defaultResolveToken,
    now: () => new Date().toISOString(),
  }
}
