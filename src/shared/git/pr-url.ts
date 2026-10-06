// Pull-request URL classifier. Node-free and shared: the creation flow
// calls it synchronously for instant feedback before the provider round-trips,
// and the GitHub provider calls it to resolve host/owner/repo/number. Rules:
// github.com → 'github'; any other host carrying a `/owner/repo/pull/N` path →
// 'github-enterprise'; a Bitbucket-shaped URL returns a typed unsupported marker
// so the UI can say "Bitbucket support is planned" instead of "invalid URL".
//
// `classifyPullRequestUrl` below is the wider reading the pull request record
// uses: which forge a pull (or merge) request URL is on, read from the PATH's
// shape so a self-hosted instance on any host is recognised too.

// 'bitbucket' joins this union later; the change-set validator rejects unknown
// providers explicitly rather than silently passing them.
export const PULL_REQUEST_PROVIDERS = ['github', 'github-enterprise'] as const
export type PullRequestProvider = (typeof PULL_REQUEST_PROVIDERS)[number]

export interface ParsedPullRequest {
  provider: PullRequestProvider
  /** Hostname only, lower-cased — never carries the port; see `port`. */
  host: string
  /**
   * The port, when the URL named a non-default one, as a string of digits. A
   * self-hosted GitHub Enterprise Server behind `https://host:8443` is reached
   * only WITH it: dropping the port sends the link and every `gh pr view <url>`
   * to a host that either does not answer or is not the one gh has auth for.
   * Absent for the ordinary `:443`/`:80` case, so a canonical URL is unchanged
   * for every github.com pull request. Repository KEYS still drop it
   * (`canonicalRepositoryKey` keys on the hostname), so one server's clones key
   * together however they were cloned.
   */
  port?: string
  owner: string
  repo: string
  number: number
}

// null = not a recognizable PR URL at all. The bitbucket marker is distinct so the
// UI can explain the gap rather than reject the paste as malformed.
export type PullRequestUrlResult = ParsedPullRequest | { unsupported: 'bitbucket' } | null

export function parsePullRequestUrl(rawUrl: string): PullRequestUrlResult {
  const trimmed = rawUrl.trim()
  if (!trimmed) return null

  let url: URL
  try {
    url = new URL(trimmed)
  } catch {
    return null
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null

  const host = url.hostname.toLowerCase()
  // `URL.port` is '' for the protocol's default port, which is exactly when the
  // canonical URL must not carry one.
  const port = url.port
  const segments = url.pathname
    .split('/')
    .map(decodeSegment)
    .filter((segment) => segment.length > 0)

  // Bitbucket cloud (`/<workspace>/<repo>/pull-requests/N`) and server
  // (`/projects/X/repos/Y/pull-requests/N`) both carry a `pull-requests` segment.
  if (segments.includes('pull-requests') || host === 'bitbucket.org' || host.endsWith('.bitbucket.org')) {
    return { unsupported: 'bitbucket' }
  }

  // GitHub shape: `<owner>/<repo>/pull/<N>` with optional trailing segments
  // (`/files`, `/commits`, …). Scan for a `pull` marker that has two path
  // segments before it and a positive integer after it, so a repository literally
  // named `pull` does not derail the match.
  for (let i = 2; i < segments.length - 1; i++) {
    if (segments[i] !== 'pull') continue
    const number = parsePositiveInt(segments[i + 1])
    if (number === null) continue
    const owner = segments[i - 2]
    const repo = segments[i - 1]
    if (!owner || !repo) continue
    const provider: PullRequestProvider = host === 'github.com' ? 'github' : 'github-enterprise'
    return { provider, host, ...(port ? { port } : {}), owner, repo, number }
  }

  return null
}

/**
 * The forges a pull request URL can be read off. GitHub covers GitHub
 * Enterprise; `gitea` covers Forgejo and Codeberg, which share its paths.
 */
export type PullRequestForge = 'github' | 'gitlab' | 'gitea' | 'bitbucket' | 'azure-devops'

/** One pull (or merge) request URL, read. */
export type ClassifiedPullRequest = {
  forge: PullRequestForge
  /** The canonical URL: scheme, host (and a non-default port), the request's own path, nothing else. */
  url: string
  /** The repository's web URL, `https://<host>[:port]/<repository path>`. */
  repositoryUrl: string
  number: number
}

/**
 * Which forge a pull request URL is on, and its canonical form; null when the
 * URL is not one. Read from the path, not the host, because every one of these
 * forges is self-hosted somewhere:
 *
 * - GitLab: `/<group>[/<subgroup>…]/<project>/-/merge_requests/<n>`
 * - Azure DevOps: `/<org>/<project>/_git/<repo>/pullrequest/<n>` (on
 *   `*.visualstudio.com` the org is the host)
 * - Bitbucket: `/<workspace>/<repo>/pull-requests/<n>` (Cloud) and
 *   `/projects/<key>/repos/<repo>/pull-requests/<n>` (Server)
 * - Gitea, Forgejo, Codeberg: `/<owner>/<repo>/pulls/<n>`
 * - GitHub and GitHub Enterprise: `/<owner>/<repo>/pull/<n>`
 *
 * A doubtful match is no match. The number must be the whole segment, so a
 * "create one" link (`/pull/new/<branch>`, `/-/merge_requests/new?…`) is
 * not a pull request, and the shapes are exact about what comes before the
 * marker, so an API URL (`api.github.com/repos/<o>/<r>/pulls/<n>`, a Gitea
 * `/api/v1/repos/…/pulls/<n>`) is not one either.
 */
export function classifyPullRequestUrl(rawUrl: string): ClassifiedPullRequest | null {
  const trimmed = rawUrl.trim()
  if (!trimmed) return null
  let url: URL
  try {
    url = new URL(trimmed)
  } catch {
    return null
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
  const host = url.hostname.toLowerCase()
  if (!host) return null
  const origin = `https://${url.port ? `${host}:${url.port}` : host}`
  const segments = url.pathname
    .split('/')
    .map(decodeSegment)
    .filter((segment) => segment.length > 0)
  const read = (forge: PullRequestForge, repository: string[], marker: string[], number: number) => {
    const repositoryPath = repository.map(encodeURIComponent).join('/')
    return {
      forge,
      url: `${origin}/${repositoryPath}/${marker.join('/')}/${number}`,
      repositoryUrl: `${origin}/${repositoryPath}`,
      number,
    }
  }

  const gitlab = segments.indexOf('-')
  if (gitlab >= 2 && segments[gitlab + 1] === 'merge_requests') {
    const number = parsePositiveInt(segments[gitlab + 2])
    return number === null ? null : read('gitlab', segments.slice(0, gitlab), ['-', 'merge_requests'], number)
  }

  const git = segments.indexOf('_git')
  if (git >= 1 && segments[git + 2]?.toLowerCase() === 'pullrequest') {
    const number = parsePositiveInt(segments[git + 3])
    return number === null ? null : read('azure-devops', segments.slice(0, git + 2), ['pullrequest'], number)
  }

  const bitbucket = segments.indexOf('pull-requests')
  if (bitbucket >= 2) {
    const number = parsePositiveInt(segments[bitbucket + 1])
    const repository = segments.slice(0, bitbucket)
    const server = repository.length === 4 && repository[2] === 'repos'
    if (number === null || (repository.length !== 2 && !server)) return null
    return read('bitbucket', repository, ['pull-requests'], number)
  }

  if (segments[2] === 'pulls') {
    const number = parsePositiveInt(segments[3])
    return number === null ? null : read('gitea', segments.slice(0, 2), ['pulls'], number)
  }

  const github = parsePullRequestUrl(trimmed)
  if (!github || 'unsupported' in github) return null
  // GitHub reads owner and repository without regard to case (`Acme/App` and
  // `acme/app` are one repository), as the repository key does: lower case,
  // so one pull request has one canonical URL and one record entry.
  const canonical = canonicalPullRequestUrl({
    ...github,
    owner: github.owner.toLowerCase(),
    repo: github.repo.toLowerCase(),
  })
  return {
    forge: 'github',
    url: canonical,
    repositoryUrl: canonical.slice(0, canonical.lastIndexOf('/pull/')),
    number: github.number,
  }
}

// The canonical public URL for a parsed PR — query noise and trailing tabs
// stripped. Persisted as `changeset.source.url` so the stored record never
// carries the paste's incidental cruft.
export function canonicalPullRequestUrl(parsed: ParsedPullRequest): string {
  const authority = parsed.port ? `${parsed.host}:${parsed.port}` : parsed.host
  return `https://${authority}/${parsed.owner}/${parsed.repo}/pull/${parsed.number}`
}

function parsePositiveInt(value: string | undefined): number | null {
  if (!value || !/^\d+$/.test(value)) return null
  const parsed = Number(value)
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null
}

function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment)
  } catch {
    return segment
  }
}
