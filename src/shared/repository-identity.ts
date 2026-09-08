// One repository across machines (one-project-across-machines, MC-2406).
//
// Two clones of the same repository — on this disk, on a paired machine's —
// are one logical project to the person using them: "run this repo on the
// faster machine", not "find that machine's copy of this repo". The identity
// that says two folders are the same repository is the remote they fetch
// from, normalised so the transport (ssh, https, scp-style) and the
// spelling (`.git`, trailing slash, case of the host) stop mattering.
//
// Pure and node-free, so the renderer (sidebar grouping, the launch panel's
// machine filter) and main (the `workspace.list` projection) derive the same
// key from the same string.

export type RepositoryIdentity = {
  /** `host/owner/name` (or the normalised URL when it has no such path): equal for every clone of one repository. */
  canonicalKey: string
  /** The remote URL as `git remote` reported it, for display and diagnosis. */
  remoteUrl: string
  /** The last path segment of the key — `multicode` for `github.com/acme/multicode`. */
  name: string
}

/**
 * The key two clones share. Lower-cased and stripped of `.git`, trailing
 * slashes and the transport, so `git@github.com:Acme/Multicode.git`,
 * `https://github.com/acme/multicode/` and `ssh://git@github.com/acme/multicode`
 * are one key: `github.com/acme/multicode`. A URL that cannot be read as
 * host + path is returned normalised as-is — still stable for that string.
 */
export function canonicalRepositoryKey(remoteUrl: string): string {
  const normalized = remoteUrl
    .trim()
    .replace(/\/+$/g, '')
    .replace(/\.git$/i, '')
    .toLowerCase()
  if (!normalized) return ''

  if (/^(?:ssh|https?|git|git\+ssh|ssh\+git):\/\//i.test(normalized)) {
    try {
      const url = new URL(normalized)
      const path = url.pathname
        .split('/')
        .filter((segment) => segment.length > 0)
        .join('/')
      if (url.hostname && path.includes('/')) return `${url.hostname}/${path}`
    } catch {
      return normalized
    }
    return normalized
  }

  // scp-style: `user@host:owner/name`. Only the host and the path matter.
  const scp = /^(?:[a-z0-9._-]+@)?([^:/\s]+):([^/\s]+(?:\/[^/\s]+)+)$/i.exec(normalized)
  if (scp?.[1] && scp[2]) return `${scp[1]}/${scp[2]}`

  return normalized
}

/** The repository's short name off its key: the last path segment. */
function repositoryNameFromKey(canonicalKey: string): string {
  const segments = canonicalKey.split('/').filter((segment) => segment.length > 0)
  return segments[segments.length - 1] ?? canonicalKey
}

/**
 * Build an identity from a remote URL, or null when the URL yields no key.
 */
export function repositoryIdentityFromRemote(remoteUrl: string): RepositoryIdentity | null {
  const canonicalKey = canonicalRepositoryKey(remoteUrl)
  if (!canonicalKey) return null
  return { canonicalKey, remoteUrl: stripRemoteCredentials(remoteUrl.trim()), name: repositoryNameFromKey(canonicalKey) }
}

/**
 * A remote URL as `git remote -v` prints it can carry a token
 * (`https://user:ghp_…@github.com/a/b.git`). The identity travels over the
 * gateway to every `workspace:read` device and into the workspace registry,
 * so the userinfo is cut before the URL leaves the reader. The key never had
 * it (`new URL().hostname`, and the scp form keeps host and path only).
 */
export function stripRemoteCredentials(remoteUrl: string): string {
  return remoteUrl.replace(/^([a-z][a-z0-9+.-]*:\/\/)[^/@\s]*@/i, '$1')
}

/**
 * Which remote names the repository when a clone has several. `upstream`
 * beats `origin` — a fork's origin is the fork, and the thing two machines
 * share is the repository it was forked from — and any other remote is
 * taken alphabetically, so the answer is stable rather than first-listed.
 */
export function pickPrimaryRemote(
  remotes: ReadonlyMap<string, string>
): { remoteName: string; remoteUrl: string } | null {
  for (const preferred of ['upstream', 'origin']) {
    const remoteUrl = remotes.get(preferred)
    if (remoteUrl) return { remoteName: preferred, remoteUrl }
  }
  const [first] = [...remotes.entries()].sort(([left], [right]) => left.localeCompare(right))
  return first ? { remoteName: first[0], remoteUrl: first[1] } : null
}

/**
 * Parse `git remote -v` into name → fetch URL. Push URLs are ignored: a
 * repository is identified by where it is read from.
 */
export function parseRemoteFetchUrls(stdout: string): Map<string, string> {
  const remotes = new Map<string, string>()
  for (const line of stdout.split(/\r?\n/)) {
    const match = /^(\S+)\s+(\S+)\s+\((fetch|push)\)$/.exec(line.trim())
    if (!match) continue
    const [, name = '', url = '', direction = ''] = match
    if (direction !== 'fetch' || !name || !url) continue
    remotes.set(name, url)
  }
  return remotes
}

/**
 * Whether two identities name one repository. Null on either side is "not
 * known", which never matches — an unidentified folder stays its own thing.
 */
export function sameRepository(
  left: Pick<RepositoryIdentity, 'canonicalKey'> | null | undefined,
  right: Pick<RepositoryIdentity, 'canonicalKey'> | null | undefined
): boolean {
  return Boolean(left?.canonicalKey && right?.canonicalKey && left.canonicalKey === right.canonicalKey)
}
