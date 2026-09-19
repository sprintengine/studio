import type { GitHubTokenStore } from './github-token-store'
import type { GitHubRepoListResult, GitHubRepoSummary } from '../shared/electron-api'

type GitHubRepoApiRecord = {
  full_name?: unknown
  name?: unknown
  owner?: unknown
  private?: unknown
  description?: unknown
  clone_url?: unknown
  default_branch?: unknown
  pushed_at?: unknown
}

// Three pages of 100 covers the accounts this feature serves; the listing is a
// picker, not a sync, so an enormous account simply filters by typing (or
// pastes the URL, which needs no listing at all).
const MAX_PAGES = 3

/**
 * The signed-in user's repositories for the new-workspace clone picker.
 * Never throws — the picker renders each failure reason differently (connect
 * hint vs. bad token vs. retry), so the reason travels in the result.
 */
export async function listGitHubRepos(tokenStore: GitHubTokenStore): Promise<GitHubRepoListResult> {
  const token = await tokenStore.resolveToken()
  if (!token) {
    return { ok: false, reason: 'no_token', message: 'No GitHub token is configured.' }
  }

  const headers: Record<string, string> = {
    Accept: 'application/vnd.github+json',
    Authorization: `Bearer ${token}`,
    'User-Agent': 'sprintengine-workspace-clone',
    'X-GitHub-Api-Version': '2022-11-28',
  }

  const repos: GitHubRepoSummary[] = []
  let nextUrl: string | null =
    'https://api.github.com/user/repos?per_page=100&sort=pushed&affiliation=owner,collaborator,organization_member'
  try {
    for (let page = 0; nextUrl && page < MAX_PAGES; page += 1) {
      const response = await fetch(nextUrl, { headers })
      if (response.status === 401 || response.status === 403) {
        return {
          ok: false,
          reason: 'unauthorized',
          message: 'GitHub rejected the saved token. Check it in Settings → Version control.',
        }
      }
      if (!response.ok) {
        return { ok: false, reason: 'network', message: `GitHub returned HTTP ${response.status}.` }
      }
      const payload = await response.json()
      if (!Array.isArray(payload)) {
        return { ok: false, reason: 'network', message: 'GitHub returned an unexpected response shape.' }
      }
      for (const record of payload) {
        const repo = toRepoSummary(record)
        if (repo) repos.push(repo)
      }
      nextUrl = nextGitHubPageUrl(response.headers.get('link'))
    }
  } catch (error) {
    return {
      ok: false,
      reason: 'network',
      message: error instanceof Error ? error.message : 'Could not reach GitHub.',
    }
  }
  return { ok: true, repos }
}

function toRepoSummary(record: unknown): GitHubRepoSummary | null {
  const repo = record as GitHubRepoApiRecord
  if (typeof repo.full_name !== 'string' || typeof repo.name !== 'string' || typeof repo.clone_url !== 'string') {
    return null
  }
  const owner =
    repo.owner && typeof repo.owner === 'object' && typeof (repo.owner as { login?: unknown }).login === 'string'
      ? (repo.owner as { login: string }).login
      : (repo.full_name.split('/')[0] ?? '')
  return {
    fullName: repo.full_name,
    name: repo.name,
    owner,
    isPrivate: repo.private === true,
    description: typeof repo.description === 'string' ? repo.description : null,
    cloneUrl: repo.clone_url,
    defaultBranch: typeof repo.default_branch === 'string' ? repo.default_branch : null,
    pushedAt: typeof repo.pushed_at === 'string' ? repo.pushed_at : null,
  }
}

// The next-page URL comes from a response header; the Authorization header
// rides every fetch, so only an https api.github.com continuation may be
// followed — anything else in the Link header is dropped, never paged into.
function nextGitHubPageUrl(linkHeader: string | null): string | null {
  if (!linkHeader) return null
  for (const part of linkHeader.split(',')) {
    const match = part.trim().match(/^<([^>]+)>;\s*rel="([^"]+)"$/)
    if (match && match[2] === 'next') {
      try {
        const next = new URL(match[1])
        if (next.protocol === 'https:' && next.hostname === 'api.github.com') return match[1]
      } catch {
        return null
      }
      return null
    }
  }
  return null
}
