// Pull-request URL classifier. Node-free and shared: the creation flow
// calls it synchronously for instant feedback before the provider round-trips,
// and the GitHub provider calls it to resolve host/owner/repo/number. Rules:
// github.com → 'github'; any other host carrying a `/owner/repo/pull/N` path →
// 'github-enterprise'; a Bitbucket-shaped URL returns a typed unsupported marker
// so the UI can say "Bitbucket support is planned" instead of "invalid URL".

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
