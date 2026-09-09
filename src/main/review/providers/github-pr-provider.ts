// GitHub pull-request source provider (MC-1678). Registers the `pull-request` arm
// of the ingestion service: a PR URL becomes a validated ReviewChangeSet. Works
// for github.com and GitHub Enterprise Server; a later Bitbucket provider slots in
// without touching this file (the URL classifier already types it).
//
// Fetch order: the `gh` CLI when installed (it inherits the user's existing auth,
// including GHES hosts), then a REST fallback carrying a token from the standard
// GitHub environment variables. Both paths yield PR metadata plus a unified diff
// that MC-1676's patch parser turns into hunks — one parser, no provider-specific
// diff handling. Secrets stay in main: the token is never logged, never returned
// through IPC, and never written into changeset.json (`source.url` is the public
// URL only). Node/Electron-main only.

import {
  canonicalPullRequestUrl,
  parsePullRequestUrl,
  type ParsedPullRequest,
  type PullRequestProvider,
  type ReviewSource,
} from '../../../shared/review'
import type { ReviewSourceInput, ReviewSourceProbe } from '../../../shared/electron-api'
import {
  MAX_CHANGESET_FILES,
  MAX_PATCH_BYTES,
  registerReviewSourceProvider,
  type ReviewSourceProvider,
} from '../changeset-service'
import { parsePatch } from '../patch-parse'
import { runGitCommand } from '../../git-utils'
import { defaultResolveToken, sharedGhRunner, type GhRunner } from '../../github/gh'
import { isRecord } from '../../../shared/records'

// A probe must answer fast enough to never wedge the creation flow's step pane; a
// build may pull a large diff and is allowed longer.
const PROBE_TIMEOUT_MS = 3000
const BUILD_FETCH_TIMEOUT_MS = 60_000

const JSON_ACCEPT = 'application/vnd.github+json'
const DIFF_ACCEPT = 'application/vnd.github.v3.diff'
const API_VERSION = '2022-11-28'
const USER_AGENT = 'Multicode-Review'

const NOT_A_GITHUB_PR = 'That does not look like a GitHub pull request URL (expected …/owner/repo/pull/123).'
const BITBUCKET_UNSUPPORTED = 'Bitbucket support is planned. For now, paste a GitHub pull request URL or use a branch/patch source.'

// A minimal fetch surface so this module does not depend on DOM lib types; the
// default binds Node's global fetch, tests inject a stub.
export interface FetchResponseLike {
  ok: boolean
  status: number
  json(): Promise<unknown>
  text(): Promise<string>
}
export type FetchLike = (
  url: string,
  init?: { headers?: Record<string, string>; signal?: AbortSignal }
) => Promise<FetchResponseLike>

export interface GithubPrProviderDeps {
  gh: GhRunner
  fetchImpl: FetchLike
  // Resolves the REST token for a host, or null when none is configured. Kept
  // behind a seam so the real env lookup never runs in tests.
  resolveToken: (host: string, provider: PullRequestProvider) => Promise<string | null>
}

interface PullRequestMeta {
  title: string
  description?: string
  baseRef: string
  baseSha: string
  headRef: string
  headSha: string
  changedFiles?: number
  additions: number
  deletions: number
}

class ProbeTimeout extends Error {}

export function createGithubPrProvider(deps: GithubPrProviderDeps): ReviewSourceProvider {
  return {
    async build(input) {
      const parsed = requirePullRequest(input)
      const { meta, diff } = await fetchPullRequest(parsed, deps)
      assertFileCount(meta.changedFiles)
      assertDiffSize(diff)
      const result = parsePatch(diff)
      if (!result.ok) throw new Error(result.error)
      assertFileCount(result.files.length)

      const source: ReviewSource = {
        kind: 'pull-request',
        provider: parsed.provider,
        host: parsed.host,
        owner: parsed.owner,
        repo: parsed.repo,
        number: parsed.number,
        url: canonicalPullRequestUrl(parsed),
      }
      return {
        source,
        title: meta.title,
        description: meta.description,
        baseRef: meta.baseRef,
        baseSha: meta.baseSha,
        headRef: meta.headRef,
        headSha: meta.headSha,
        files: result.files,
        stats: result.stats,
        // headSha pins the identity: re-ingesting the same PR head yields the same
        // change-set id; a new push changes it.
        identity: `pull-request\n${parsed.host}\n${parsed.owner}/${parsed.repo}\n${parsed.number}\n${meta.headSha}`,
      }
    },

    async probe(input): Promise<ReviewSourceProbe> {
      if (input.kind !== 'pull-request') return { ok: false, error: NOT_A_GITHUB_PR }
      const parsed = parsePullRequestUrl(input.url)
      if (!parsed) return { ok: false, error: NOT_A_GITHUB_PR }
      if ('unsupported' in parsed) return { ok: false, error: BITBUCKET_UNSUPPORTED }
      try {
        const meta = await withTimeout(fetchMeta(parsed, deps, PROBE_TIMEOUT_MS), PROBE_TIMEOUT_MS)
        return {
          ok: true,
          title: meta.title,
          stats: { files: meta.changedFiles ?? 0, additions: meta.additions, deletions: meta.deletions },
          headSha: meta.headSha,
        }
      } catch (error) {
        // A slow network must not block the pane: report a still-checking state the
        // creation flow can render, keyed by a provisional title from the URL. Both
        // the overall probe deadline and an aborted in-flight fetch signal slowness.
        if (error instanceof ProbeTimeout || isAbortLike(error)) {
          return { ok: true, title: `${parsed.owner}/${parsed.repo} #${parsed.number}` }
        }
        return { ok: false, error: messageOf(error) }
      }
    },
  }
}

function requirePullRequest(input: ReviewSourceInput): ParsedPullRequest {
  if (input.kind !== 'pull-request') throw new Error('GitHub provider received a non-pull-request source.')
  const parsed = parsePullRequestUrl(input.url)
  if (!parsed) throw new Error(NOT_A_GITHUB_PR)
  if ('unsupported' in parsed) throw new Error(BITBUCKET_UNSUPPORTED)
  return parsed
}

// gh-first, then REST. gh owns its own auth; when it is absent or errors, the REST
// fallback resolves a token and maps HTTP status onto a user-facing error.
async function fetchPullRequest(
  parsed: ParsedPullRequest,
  deps: GithubPrProviderDeps
): Promise<{ meta: PullRequestMeta; diff: string }> {
  if (await deps.gh.available()) {
    const viaGh = await ghFetchFull(parsed, deps)
    if (viaGh.ok) return { meta: viaGh.meta, diff: viaGh.diff }
  }
  const token = await deps.resolveToken(parsed.host, parsed.provider)
  const url = restPullUrl(parsed)
  const meta = await restJson(deps, url, token, BUILD_FETCH_TIMEOUT_MS)
  if (!meta.ok) throw httpError(meta.status, parsed, Boolean(token))
  const diff = await restDiff(deps, url, token, BUILD_FETCH_TIMEOUT_MS)
  if (!diff.ok) throw httpError(diff.status, parsed, Boolean(token))
  return { meta: metaFromRest(meta.json), diff: diff.diff }
}

// Metadata only — no diff download — for the cheap live probe.
async function fetchMeta(
  parsed: ParsedPullRequest,
  deps: GithubPrProviderDeps,
  timeoutMs: number
): Promise<PullRequestMeta> {
  if (await deps.gh.available()) {
    const viaGh = await ghView(parsed, deps)
    if (viaGh.ok) return viaGh.meta
  }
  const token = await deps.resolveToken(parsed.host, parsed.provider)
  const meta = await restJson(deps, restPullUrl(parsed), token, timeoutMs)
  if (!meta.ok) throw httpError(meta.status, parsed, Boolean(token))
  return metaFromRest(meta.json)
}

async function ghFetchFull(
  parsed: ParsedPullRequest,
  deps: GithubPrProviderDeps
): Promise<{ ok: true; meta: PullRequestMeta; diff: string } | { ok: false }> {
  const view = await ghView(parsed, deps)
  if (!view.ok) return { ok: false }
  const diff = await deps.gh.run(['pr', 'diff', String(parsed.number), '--repo', ghRepoArg(parsed), '--patch'])
  if (diff.code !== 0) return { ok: false }
  return { ok: true, meta: view.meta, diff: diff.stdout }
}

async function ghView(
  parsed: ParsedPullRequest,
  deps: GithubPrProviderDeps
): Promise<{ ok: true; meta: PullRequestMeta } | { ok: false }> {
  const result = await deps.gh.run([
    'pr',
    'view',
    String(parsed.number),
    '--repo',
    ghRepoArg(parsed),
    '--json',
    'title,body,baseRefName,headRefName,baseRefOid,headRefOid,additions,deletions,changedFiles',
  ])
  if (result.code !== 0) return { ok: false }
  let json: unknown
  try {
    json = JSON.parse(result.stdout)
  } catch {
    return { ok: false }
  }
  return { ok: true, meta: metaFromGh(json) }
}

function ghRepoArg(parsed: ParsedPullRequest): string {
  return `${parsed.host}/${parsed.owner}/${parsed.repo}`
}

function restPullUrl(parsed: ParsedPullRequest): string {
  const base = parsed.provider === 'github' ? 'https://api.github.com' : `https://${parsed.host}/api/v3`
  return `${base}/repos/${encodeURIComponent(parsed.owner)}/${encodeURIComponent(parsed.repo)}/pulls/${parsed.number}`
}

function restHeaders(accept: string, token: string | null): Record<string, string> {
  const headers: Record<string, string> = {
    Accept: accept,
    'User-Agent': USER_AGENT,
    'X-GitHub-Api-Version': API_VERSION,
  }
  if (token) headers.Authorization = `Bearer ${token}`
  return headers
}

async function restJson(
  deps: GithubPrProviderDeps,
  url: string,
  token: string | null,
  timeoutMs: number
): Promise<{ ok: true; json: unknown } | { ok: false; status: number }> {
  const res = await deps.fetchImpl(url, { headers: restHeaders(JSON_ACCEPT, token), signal: timeoutSignal(timeoutMs) })
  if (!res.ok) return { ok: false, status: res.status }
  return { ok: true, json: await res.json() }
}

async function restDiff(
  deps: GithubPrProviderDeps,
  url: string,
  token: string | null,
  timeoutMs: number
): Promise<{ ok: true; diff: string } | { ok: false; status: number }> {
  const res = await deps.fetchImpl(url, { headers: restHeaders(DIFF_ACCEPT, token), signal: timeoutSignal(timeoutMs) })
  if (!res.ok) return { ok: false, status: res.status }
  return { ok: true, diff: await res.text() }
}

function metaFromRest(json: unknown): PullRequestMeta {
  if (!isRecord(json)) throw unexpectedPayload()
  const base = json.base
  const head = json.head
  if (!isRecord(base) || !isRecord(head)) throw unexpectedPayload()
  const meta: PullRequestMeta = {
    title: requireString(json.title),
    description: optionalString(json.body),
    baseRef: requireString(base.ref),
    baseSha: requireString(base.sha),
    headRef: requireString(head.ref),
    headSha: requireString(head.sha),
    changedFiles: optionalInt(json.changed_files),
    additions: optionalInt(json.additions) ?? 0,
    deletions: optionalInt(json.deletions) ?? 0,
  }
  return meta
}

function metaFromGh(json: unknown): PullRequestMeta {
  if (!isRecord(json)) throw unexpectedPayload()
  return {
    title: requireString(json.title),
    description: optionalString(json.body),
    baseRef: requireString(json.baseRefName),
    baseSha: requireString(json.baseRefOid),
    headRef: requireString(json.headRefName),
    headSha: requireString(json.headRefOid),
    changedFiles: optionalInt(json.changedFiles),
    additions: optionalInt(json.additions) ?? 0,
    deletions: optionalInt(json.deletions) ?? 0,
  }
}

// 404 and 401 map to distinct actionable errors; both name the two auth paths so a
// no-auth private-repo probe tells the user exactly what to set up.
function httpError(status: number, parsed: ParsedPullRequest, hasToken: boolean): Error {
  const setup = authSetupHint(parsed)
  if (status === 401) {
    return new Error(`GitHub rejected the credentials (401). ${setup}`)
  }
  if (status === 404) {
    return hasToken
      ? new Error(`Pull request not found, or the token cannot access ${parsed.owner}/${parsed.repo} (404).`)
      : new Error(`Pull request not found. If the repository is private, set up access — ${lowerFirst(setup)}`)
  }
  if (status === 403) {
    return new Error(`GitHub denied the request (403) — rate limit or missing scope. ${setup}`)
  }
  return new Error(`GitHub request failed (HTTP ${status}).`)
}

function authSetupHint(parsed: ParsedPullRequest): string {
  return `Install the GitHub CLI and run \`gh auth login\`, or set a ${tokenEnvName(parsed.provider)} environment token with access to this repository.`
}

function tokenEnvName(provider: PullRequestProvider): string {
  return provider === 'github' ? 'GH_TOKEN' : 'GH_ENTERPRISE_TOKEN'
}

function assertFileCount(count: number | undefined): void {
  if (typeof count === 'number' && count > MAX_CHANGESET_FILES) {
    throw new Error(`Pull request has too many files to review (${count}; limit ${MAX_CHANGESET_FILES}).`)
  }
}

function assertDiffSize(diff: string): void {
  const bytes = Buffer.byteLength(diff, 'utf8')
  if (bytes > MAX_PATCH_BYTES) {
    throw new Error(`Pull request diff is too large to review (limit ${(MAX_PATCH_BYTES / (1024 * 1024)).toFixed(0)} MiB).`)
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new ProbeTimeout()), ms)
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (error) => {
        clearTimeout(timer)
        reject(error)
      }
    )
  })
}

function timeoutSignal(ms: number): AbortSignal | undefined {
  try {
    return AbortSignal.timeout(ms)
  } catch {
    return undefined
  }
}

function requireString(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0) throw unexpectedPayload()
  return value
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function optionalInt(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : undefined
}

function unexpectedPayload(): Error {
  return new Error('GitHub returned an unexpected pull request payload.')
}

function lowerFirst(text: string): string {
  return text.length > 0 ? text[0].toLowerCase() + text.slice(1) : text
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

// A fetch aborted by its timeout signal rejects with an AbortError/TimeoutError —
// the same "too slow" verdict a probe deadline reaches, not a definitive failure.
function isAbortLike(error: unknown): boolean {
  return error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError')
}

// PR-project inference (MC-1787). A pasted pull-request URL identifies a repo by
// host + owner/repo; the same triple, read from each open project's git remotes,
// tells us which local checkout (if any) that PR belongs to — so a reviewer who
// pastes a URL never has to pick a project up front. Ingestion itself never needs a
// local checkout (it fetches over gh/REST); this only resolves *where* the review
// is stored and which workspace the guide runs in.

export interface RemoteRepoRef {
  host: string
  owner: string
  repo: string
}

// Parse a git remote URL into { host, owner, repo }. Handles every form `git
// remote` stores: https/http/ssh/git:// URLs and the scp-like `git@host:owner/repo`
// shorthand, with or without a trailing `.git`. Host and owner/repo are lower-cased
// so matching is case-insensitive. Returns null for anything that does not resolve
// to a host plus an owner/repo pair (so a malformed remote is a non-match, never a
// throw). A user:token@ prefix is dropped with the rest of the URL authority — a
// credential embedded in a remote never reaches the result.
export function parseGitRemoteRef(rawRemote: string): RemoteRepoRef | null {
  const trimmed = rawRemote.trim()
  if (!trimmed) return null
  // A scp-like remote carries no scheme: `[user@]host:owner/repo`. Guard against a
  // Windows drive path (`C:\repo`) that would otherwise misparse as host `c`.
  if (!trimmed.includes('://')) {
    if (/^[a-zA-Z]:[\\/]/.test(trimmed)) return null
    const scp = /^(?:[^@/]+@)?([^/:]+):(.+)$/.exec(trimmed)
    return scp ? refFromHostAndPath(scp[1], scp[2]) : null
  }
  let url: URL
  try {
    url = new URL(trimmed)
  } catch {
    return null
  }
  // hostname drops any `user[:token]@` authority and the port.
  return refFromHostAndPath(url.hostname, url.pathname)
}

function refFromHostAndPath(host: string, path: string): RemoteRepoRef | null {
  const normalizedHost = host.trim().toLowerCase()
  if (!normalizedHost) return null
  const segments = path
    .replace(/\.git$/i, '')
    .split('/')
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0)
  if (segments.length < 2) return null
  return {
    host: normalizedHost,
    owner: segments[segments.length - 2].toLowerCase(),
    repo: segments[segments.length - 1].toLowerCase(),
  }
}

// The parsed PR URL's host already comes lower-cased from parsePullRequestUrl;
// owner/repo are lower-cased on both sides here so the compare is case-insensitive.
export function remoteMatchesPullRequest(remote: RemoteRepoRef, pr: ParsedPullRequest): boolean {
  return (
    remote.host === pr.host.toLowerCase() &&
    remote.owner === pr.owner.toLowerCase() &&
    remote.repo === pr.repo.toLowerCase()
  )
}

// Read every configured remote URL for a project root. `runGitCommand` pins
// LC_ALL=C ([[git-panel-operations-v2]]); `git config --get-regexp` exits non-zero
// when the directory is not a repo or has no remotes, which we treat as "no remotes"
// (an empty list, a non-match) rather than an error that aborts inference.
export async function readProjectRemoteUrls(root: string): Promise<string[]> {
  const result = await runGitCommand(root, ['config', '--get-regexp', '^remote\\..*\\.url$'])
  if (!result.ok) return []
  return result.stdout
    .split(/\r?\n/)
    .map((line) => {
      const space = line.indexOf(' ')
      return space === -1 ? '' : line.slice(space + 1).trim()
    })
    .filter((value) => value.length > 0)
}

// Return exactly the given roots whose git remote points at the same repository as
// the pasted PR URL — one, many, or zero. A non-PR or unsupported URL yields no
// matches (not an error). Roots are de-duplicated and their order is preserved; the
// git reader is injected so the match logic is unit-testable without spawning git.
export async function matchPrProjectRoots(
  url: string,
  roots: readonly string[],
  readRemoteUrls: (root: string) => Promise<string[]> = readProjectRemoteUrls
): Promise<string[]> {
  const parsed = parsePullRequestUrl(url)
  if (!parsed || 'unsupported' in parsed) return []
  const matches: string[] = []
  const seen = new Set<string>()
  for (const root of roots) {
    if (typeof root !== 'string' || root.length === 0 || seen.has(root)) continue
    seen.add(root)
    const remoteUrls = await readRemoteUrls(root)
    const matched = remoteUrls.some((remoteUrl) => {
      const ref = parseGitRemoteRef(remoteUrl)
      return ref !== null && remoteMatchesPullRequest(ref, parsed)
    })
    if (matched) matches.push(root)
  }
  return matches
}

function defaultDeps(): GithubPrProviderDeps {
  return {
    gh: sharedGhRunner(),
    fetchImpl: (url, init) => fetch(url, init) as unknown as Promise<FetchResponseLike>,
    resolveToken: defaultResolveToken,
  }
}

const githubPrProvider = createGithubPrProvider(defaultDeps())
registerReviewSourceProvider('pull-request', githubPrProvider)
