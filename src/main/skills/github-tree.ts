// Fetching a GitHub repository for the skill scan.
//
// Scanning is one request: `GET /git/trees/{sha}?recursive=1` returns every
// path with its blob SHA, which is the whole scan. File bytes come from
// raw.githubusercontent.com and are fetched only for the skill being read or
// installed, pinned to the commit the scan resolved.
//
// The repository tarball was the earlier plan and was rejected: this repo ships
// no tar reader, and adding one means parsing an archive from a repository we
// do not control — a path-traversal and symlink surface — to gain nothing the
// tree does not already give.

import {
  MARKETPLACE_EXTRA_HOSTS_ENV,
  isMarketplaceSourceHostAllowed,
  parseMarketplaceExtraHosts,
} from '../../shared/marketplace/source-policy'
import type { SkillTreeEntry } from './scan'

export type SkillFetch = (url: string, init: RequestInit) => Promise<Response>

export const DEFAULT_SKILL_FETCH_TIMEOUT_MS = 30_000
export const DEFAULT_SKILL_MAX_FILE_BYTES = 2 * 1024 * 1024
// A tree this large is not a skill repository. The cap bounds the single scan
// request's parse cost; GitHub itself truncates far larger trees, which we
// report rather than silently scanning a partial repository.
export const DEFAULT_SKILL_MAX_TREE_ENTRIES = 200_000

export type SkillRepoRef = { owner: string; repo: string; ref: string }

export type SkillRepoTree = {
  commitSha: string
  entries: SkillTreeEntry[]
}

export type SkillGithubOptions = {
  fetcher?: SkillFetch
  timeoutMs?: number
  maxFileBytes?: number
  /** Resolved GitHub token; '' fetches unauthenticated. */
  token?: string
}

/**
 * Accept what a user actually has in their clipboard: `owner/repo`, a repo URL,
 * a `/tree/<ref>` deep link, or a `.git` clone URL. Anything else is refused
 * rather than guessed at.
 */
export function parseSkillRepoRef(input: string): SkillRepoRef | null {
  const trimmed = input.trim()
  if (trimmed.length === 0) return null

  if (!trimmed.includes('://')) {
    const segments = trimmed.split('/').filter((segment) => segment.length > 0)
    if (segments.length !== 2) return null
    return validRef({ owner: segments[0], repo: stripGitSuffix(segments[1]), ref: '' })
  }

  let url: URL
  try {
    url = new URL(trimmed)
  } catch {
    return null
  }
  if (url.protocol !== 'https:' || url.hostname.toLowerCase() !== 'github.com') return null
  const segments = url.pathname.split('/').filter((segment) => segment.length > 0)
  if (segments.length < 2) return null
  const ref = segments.length >= 4 && segments[2] === 'tree' ? segments[3] : ''
  return validRef({ owner: segments[0], repo: stripGitSuffix(segments[1]), ref })
}

function stripGitSuffix(value: string): string {
  return value.endsWith('.git') ? value.slice(0, -4) : value
}

function validRef(ref: SkillRepoRef): SkillRepoRef | null {
  const namePattern = /^[A-Za-z0-9._-]+$/
  if (!namePattern.test(ref.owner) || !namePattern.test(ref.repo)) return null
  if (ref.ref !== '' && !/^[A-Za-z0-9._/-]+$/.test(ref.ref)) return null
  return ref
}

export class SkillFetchError extends Error {
  constructor(message: string, readonly statusCode?: number) {
    super(message)
  }
}

/** Resolve a ref (or the default branch) to the commit SHA the scan pins to. */
export async function resolveSkillRepoCommit(
  ref: SkillRepoRef,
  options: SkillGithubOptions = {}
): Promise<string> {
  const target = ref.ref || (await fetchDefaultBranch(ref, options))
  const body = await fetchJson<{ sha?: unknown }>(
    `https://api.github.com/repos/${ref.owner}/${ref.repo}/commits/${encodeURIComponent(target)}`,
    options
  )
  if (typeof body.sha !== 'string' || body.sha.length === 0) {
    throw new SkillFetchError(`GitHub did not return a commit for ${ref.owner}/${ref.repo}.`)
  }
  return body.sha
}

async function fetchDefaultBranch(ref: SkillRepoRef, options: SkillGithubOptions): Promise<string> {
  const body = await fetchJson<{ default_branch?: unknown }>(
    `https://api.github.com/repos/${ref.owner}/${ref.repo}`,
    options
  )
  if (typeof body.default_branch !== 'string' || body.default_branch.length === 0) {
    throw new SkillFetchError(`GitHub did not report a default branch for ${ref.owner}/${ref.repo}.`)
  }
  return body.default_branch
}

/**
 * The whole repository listing in one call. A tree GitHub reports as truncated
 * fails rather than scanning a partial repository — a source silently missing
 * half its skills is worse than a source that says it could not be read.
 */
export async function fetchSkillRepoTree(
  ref: SkillRepoRef,
  commitSha: string,
  options: SkillGithubOptions = {}
): Promise<SkillRepoTree> {
  const body = await fetchJson<{ tree?: unknown; truncated?: unknown }>(
    `https://api.github.com/repos/${ref.owner}/${ref.repo}/git/trees/${encodeURIComponent(commitSha)}?recursive=1`,
    options
  )
  if (body.truncated === true) {
    throw new SkillFetchError(
      `${ref.owner}/${ref.repo} is too large for GitHub to list in one request, so it cannot be scanned completely.`
    )
  }
  if (!Array.isArray(body.tree)) {
    throw new SkillFetchError(`GitHub returned no file listing for ${ref.owner}/${ref.repo}.`)
  }
  if (body.tree.length > DEFAULT_SKILL_MAX_TREE_ENTRIES) {
    throw new SkillFetchError(
      `${ref.owner}/${ref.repo} lists more than ${DEFAULT_SKILL_MAX_TREE_ENTRIES} files, which is too large to scan.`
    )
  }
  return { commitSha, entries: body.tree.map(normalizeTreeEntry).filter(isTreeEntry) }
}

function normalizeTreeEntry(value: unknown): SkillTreeEntry | null {
  if (!value || typeof value !== 'object') return null
  const raw = value as Record<string, unknown>
  if (typeof raw.path !== 'string' || typeof raw.type !== 'string') return null
  return {
    path: raw.path,
    mode: typeof raw.mode === 'string' ? raw.mode : '',
    type: raw.type,
    sha: typeof raw.sha === 'string' ? raw.sha : '',
    ...(typeof raw.size === 'number' ? { size: raw.size } : {}),
  }
}

function isTreeEntry(value: SkillTreeEntry | null): value is SkillTreeEntry {
  return value !== null
}

/** Read one file's bytes at the scanned commit. */
export async function fetchSkillRepoFile(
  ref: SkillRepoRef,
  commitSha: string,
  path: string,
  options: SkillGithubOptions = {}
): Promise<Buffer> {
  const encoded = path.split('/').map(encodeURIComponent).join('/')
  return fetchBytes(
    `https://raw.githubusercontent.com/${ref.owner}/${ref.repo}/${encodeURIComponent(commitSha)}/${encoded}`,
    { accept: '*/*' },
    options
  )
}

async function fetchJson<T>(url: string, options: SkillGithubOptions): Promise<T> {
  const body = await fetchBytes(url, { accept: 'application/vnd.github+json' }, options)
  try {
    return JSON.parse(body.toString('utf8')) as T
  } catch {
    throw new SkillFetchError('GitHub returned a response that could not be read as JSON.')
  }
}

async function fetchBytes(
  url: string,
  headers: Record<string, string>,
  options: SkillGithubOptions
): Promise<Buffer> {
  const parsed = parseAllowedUrl(url)
  const fetcher = options.fetcher ?? defaultFetch
  const maxBytes = options.maxFileBytes ?? DEFAULT_SKILL_MAX_FILE_BYTES
  const token = options.token?.trim()
  const controller = new AbortController()
  const timeout = setTimeout(
    () => controller.abort(),
    options.timeoutMs ?? DEFAULT_SKILL_FETCH_TIMEOUT_MS
  )
  try {
    let response: Response
    try {
      response = await fetcher(parsed.toString(), {
        method: 'GET',
        headers: { ...headers, ...(token ? { authorization: `Bearer ${token}` } : {}) },
        signal: controller.signal,
      })
    } catch (error) {
      throw new SkillFetchError(
        `Could not reach GitHub. ${error instanceof Error ? error.message : String(error)}`
      )
    }
    if (!response.ok) throw new SkillFetchError(githubErrorMessage(response), response.status)
    const bytes = Buffer.from(await response.arrayBuffer())
    if (bytes.byteLength > maxBytes) {
      throw new SkillFetchError(`A file in this repository is larger than ${maxBytes} bytes.`)
    }
    return bytes
  } finally {
    clearTimeout(timeout)
  }
}

function githubErrorMessage(response: Response): string {
  if (response.status === 404) return 'That repository could not be found, or it is not public.'
  if (response.status === 403 || response.status === 429) {
    return 'GitHub rate-limited this request. Adding a GitHub token in Settings raises the limit.'
  }
  return `GitHub replied with HTTP ${response.status}.`
}

/**
 * Every URL this module touches is one it built from a parsed owner/repo, but
 * the allowlist is still enforced here so the skills path can never widen the
 * set of hosts the app fetches from beyond what the marketplace downloader
 * already enforces.
 */
function parseAllowedUrl(value: string): URL {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new SkillFetchError('Skill source URL is invalid.')
  }
  if (url.protocol !== 'https:') throw new SkillFetchError('Skill source URL must use HTTPS.')
  const extraHosts = parseMarketplaceExtraHosts(process.env[MARKETPLACE_EXTRA_HOSTS_ENV])
  if (!isMarketplaceSourceHostAllowed(url.hostname, extraHosts)) {
    throw new SkillFetchError(`Skill source host "${url.hostname}" is not on the allowlist.`)
  }
  return url
}

async function defaultFetch(url: string, init: RequestInit): Promise<Response> {
  if (typeof globalThis.fetch !== 'function') throw new SkillFetchError('fetch is not available.')
  return globalThis.fetch(url, init)
}
