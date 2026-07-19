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

import { execFile } from 'child_process'
import { promisify } from 'util'
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

const execFileAsync = promisify(execFile)

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

export interface GhResult {
  found: boolean // false only when the gh binary itself is absent
  code: number
  stdout: string
  stderr: string
}
export interface GhRunner {
  available(): Promise<boolean>
  run(args: string[]): Promise<GhResult>
}

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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
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

// Default gh runner: a direct spawn, then — when the binary is not on PATH — a
// retry through the user's login+interactive shell. A GUI-launched app on macOS
// does not inherit the shell PATH, so a Homebrew/nvm `gh` is invisible to a bare
// spawn but present in the shell that PTY terminals use (mirrors detectCli's
// $SHELL -ilc fallback in cli-runtime-install.ts).
// Exported so the review-sync write path (MC-1683) shares the exact same gh
// runner — including the GUI-launched-app shell-PATH fallback — instead of
// duplicating it, keeping "gh-first auth" identical between read and write.
export function createDefaultGhRunner(): GhRunner {
  const maxBuffer = MAX_PATCH_BYTES + 1024 * 1024
  const runDirect = async (args: string[]): Promise<GhResult> => {
    try {
      const { stdout, stderr } = await execFileAsync('gh', args, { maxBuffer, windowsHide: true })
      return { found: true, code: 0, stdout, stderr }
    } catch (error) {
      const err = error as { code?: string | number; stdout?: string; stderr?: string }
      if (err.code === 'ENOENT') return { found: false, code: -1, stdout: '', stderr: '' }
      return { found: true, code: typeof err.code === 'number' ? err.code : 1, stdout: err.stdout ?? '', stderr: err.stderr ?? '' }
    }
  }
  const runViaShell = async (args: string[]): Promise<GhResult | null> => {
    const descriptor = buildShellGhDescriptor(args, process.env.SHELL)
    if (!descriptor) return null
    try {
      const { stdout, stderr } = await execFileAsync(descriptor.file, descriptor.args, { maxBuffer, windowsHide: true })
      return { found: true, code: 0, stdout, stderr }
    } catch (error) {
      const err = error as { code?: string | number; stdout?: string; stderr?: string }
      if (err.code === 'ENOENT') return { found: false, code: -1, stdout: '', stderr: '' }
      return { found: true, code: typeof err.code === 'number' ? err.code : 1, stdout: err.stdout ?? '', stderr: err.stderr ?? '' }
    }
  }
  const run = async (args: string[]): Promise<GhResult> => {
    const direct = await runDirect(args)
    if (direct.found) return direct
    return (await runViaShell(args)) ?? direct
  }
  return {
    run,
    async available() {
      const result = await run(['--version'])
      return result.found && result.code === 0
    },
  }
}

function buildShellGhDescriptor(args: string[], shell: string | undefined): { file: string; args: string[] } | null {
  if (process.platform !== 'darwin' && process.platform !== 'linux') return null
  const shellPath = shell?.trim()
  if (!shellPath) return null
  const shellName = shellPath.split('/').pop()
  if (shellName !== 'zsh' && shellName !== 'bash') return null
  const command = ['gh', ...args].map(posixSingleQuote).join(' ')
  return { file: shellPath, args: ['-ilc', command] }
}

function posixSingleQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

// Resolves the REST token from the same environment variables gh reads.
// github.com is fixed to api.github.com so GH_TOKEN can only ever reach GitHub.
// A GHES host, though, comes straight from the pasted URL: handing the enterprise
// token to an arbitrary host would leak it, so the token is released only when the
// host matches an explicitly configured enterprise host (gh's own GH_HOST). An
// unconfigured or mismatched host falls through unauthenticated.
export function defaultResolveToken(host: string, provider: PullRequestProvider): Promise<string | null> {
  if (provider === 'github') return Promise.resolve(pickEnv('GH_TOKEN', 'GITHUB_TOKEN'))
  const configuredHost = (process.env.GH_HOST ?? process.env.GH_ENTERPRISE_HOST ?? '').trim().toLowerCase()
  if (!configuredHost || configuredHost !== host.toLowerCase()) return Promise.resolve(null)
  return Promise.resolve(pickEnv('GH_ENTERPRISE_TOKEN', 'GITHUB_ENTERPRISE_TOKEN'))
}

function pickEnv(...names: string[]): string | null {
  for (const name of names) {
    const value = process.env[name]?.trim()
    if (value) return value
  }
  return null
}

function defaultDeps(): GithubPrProviderDeps {
  return {
    gh: createDefaultGhRunner(),
    fetchImpl: (url, init) => fetch(url, init) as unknown as Promise<FetchResponseLike>,
    resolveToken: defaultResolveToken,
  }
}

export const githubPrProvider = createGithubPrProvider(defaultDeps())
registerReviewSourceProvider('pull-request', githubPrProvider)
