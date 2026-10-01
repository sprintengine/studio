// Where a repository source lives, as the one string every layer passes
// around: the source's `repo`, the tail of its id, and the argument to every
// reader call.
//
//   owner/name                          github.com over https — every source
//                                       written before other hosts existed;
//   host/path/to/name                   any other host over https: a
//                                       self-hosted GitHub, GitLab (whose
//                                       groups nest), Bitbucket, Gitea;
//   ssh://user@host[:port]/path/name    any host over ssh, read with the
//                                       person's own keys.
//
// Nothing here is specific to GitHub. Sources are read with git's own
// protocol (`git-repo-reader.ts`), which every one of those hosts speaks, so
// a repository is simply somewhere `git clone` can reach.

export const DEFAULT_SKILL_REPO_HOST = 'github.com'

/** How many path segments a repository may sit under — a GitLab group nests. */
export const MAX_SKILL_REPO_PATH_SEGMENTS = 8

export type SkillRepoSsh = { user: string; port: number | null }

/**
 * A repository split out of its `repo`. `owner` is every path segment before
 * the name, so on a host whose groups nest it holds slashes of its own.
 */
export type SkillRepoLocation = { host: string; owner: string; name: string; ssh?: SkillRepoSsh }

const SEGMENT = /^[A-Za-z0-9._-]+$/
// A bare, dotted hostname: no scheme, no port, no credentials. The dot is what
// tells `host/owner/name` from a mistyped `owner/name/extra` — no GitHub
// account name can hold one.
const HOST = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/
// The user never starts with a dash: it becomes part of an argument to ssh, and
// `-oProxyCommand=…` is the classic way to make a clone address run a command.
const SSH_REPO = /^ssh:\/\/([A-Za-z0-9._][A-Za-z0-9._-]*)@([^/:@]+)(?::(\d{1,5}))?\/(.+)$/

/** The host as a source records it, or '' when it is not one. `www.github.com` is github.com. */
export function normalizeSkillRepoHost(value: string): string {
  const host = value.trim().toLowerCase()
  if (host === 'www.github.com') return DEFAULT_SKILL_REPO_HOST
  return HOST.test(host) ? host : ''
}

/**
 * A path segment a repository may have. The names become URL path segments
 * and directories under the clone cache, so the three that are legal
 * characters but not names — `.`, `..` and a leading dash — are refused too.
 */
export function isSkillRepoSegment(segment: string): boolean {
  return SEGMENT.test(segment) && segment !== '.' && segment !== '..' && !segment.startsWith('-')
}

/** The path segments as a location, or null when they are not a repository on that host. */
function locate(host: string, segments: readonly string[], ssh?: SkillRepoSsh): SkillRepoLocation | null {
  if (!host) return null
  // github.com over https is exactly `owner/name`; anywhere else may nest.
  const exact = !ssh && host === DEFAULT_SKILL_REPO_HOST
  if (segments.length < 2 || (exact && segments.length !== 2)) return null
  if (segments.length > MAX_SKILL_REPO_PATH_SEGMENTS) return null
  if (!segments.every(isSkillRepoSegment)) return null
  const name = segments[segments.length - 1]
  return { host, owner: segments.slice(0, -1).join('/'), name, ...(ssh ? { ssh } : {}) }
}

/** The `repo` a source records for this location. */
export function joinSkillRepo(location: SkillRepoLocation): string {
  const host = normalizeSkillRepoHost(location.host) || DEFAULT_SKILL_REPO_HOST
  const path = `${location.owner}/${location.name}`
  if (location.ssh) {
    const port = location.ssh.port ? `:${location.ssh.port}` : ''
    return `ssh://${location.ssh.user}@${host}${port}/${path}`
  }
  return host === DEFAULT_SKILL_REPO_HOST ? path : `${host}/${path}`
}

/** A source's `repo` split into its parts; null for anything that is not one. */
export function splitSkillRepo(repo: string): SkillRepoLocation | null {
  const trimmed = repo.trim()
  const ssh = SSH_REPO.exec(trimmed)
  if (ssh) {
    const port = ssh[3] ? Number.parseInt(ssh[3], 10) : null
    if (port !== null && (port < 1 || port > 65_535)) return null
    return locate(normalizeSkillRepoHost(ssh[2]), ssh[4].split('/'), { user: ssh[1], port })
  }
  if (trimmed.includes('://') || trimmed.includes('@')) return null
  const segments = trimmed.split('/')
  if (segments.length === 2) return locate(DEFAULT_SKILL_REPO_HOST, segments)
  const host = normalizeSkillRepoHost(segments[0])
  // github.com is always written without its host; a `github.com/o/n` is not
  // a spelling this file produces, so it is not one it reads.
  if (host === DEFAULT_SKILL_REPO_HOST) return null
  return locate(host, segments.slice(1))
}

/** What a repository is called on screen: `owner/name` on github.com, `host/path/name` anywhere else. */
export function skillRepoLabel(repo: string): string {
  const location = splitSkillRepo(repo)
  if (!location) return repo
  const path = `${location.owner}/${location.name}`
  return !location.ssh && location.host === DEFAULT_SKILL_REPO_HOST ? path : `${location.host}/${path}`
}

/** The address `git clone` takes for this repository. */
export function skillRepoCloneUrl(repo: string): string | null {
  const location = splitSkillRepo(repo)
  if (!location) return null
  const path = `${location.owner}/${location.name}.git`
  if (location.ssh) {
    const port = location.ssh.port ? `:${location.ssh.port}` : ''
    return `ssh://${location.ssh.user}@${location.host}${port}/${path}`
  }
  return `https://${location.host}/${path}`
}

/**
 * The repository's page in a browser, or null when there is no telling. Every
 * host serves its repository page at `https://host/path`, except that an ssh
 * address on a port of its own (a Bitbucket Server's 7999) names a path the
 * web side does not share.
 */
export function skillRepoWebUrl(repo: string): string | null {
  const location = splitSkillRepo(repo)
  if (!location || location.ssh?.port) return null
  return `https://${location.host}/${location.owner}/${location.name}`
}

/**
 * True for a github.com repository, the one host whose page layout — the
 * `/tree/<sha>/<path>` and `/commits/<sha>` a deep link is built from — this
 * app can count on. Every other host gets its repository page, which is
 * always right, rather than a deep link each host spells differently.
 */
export function isGithubDotComRepo(repo: string): boolean {
  const location = splitSkillRepo(repo)
  return location !== null && location.host === DEFAULT_SKILL_REPO_HOST
}
