import { runGit } from './git-utils'

export async function getGitHubRepoWebUrl(repoRoot: string): Promise<string | null> {
  try {
    const originUrl = await runGit(repoRoot, ['remote', 'get-url', 'origin'])
    const webUrl = githubWebUrlFromRemote(originUrl)
    if (webUrl) return webUrl
  } catch {
    // Ignore missing origin; fall through to scanning all remotes.
  }

  try {
    const remotes = await runGit(repoRoot, ['remote', '-v'])
    for (const line of remotes.split(/\r?\n/)) {
      const [, remoteUrl = ''] = line.trim().split(/\s+/)
      const webUrl = githubWebUrlFromRemote(remoteUrl)
      if (webUrl) return webUrl
    }
  } catch {
    return null
  }

  return null
}

function githubWebUrlFromRemote(remoteUrl: string): string | null {
  const trimmed = remoteUrl.trim()
  if (!trimmed) return null

  const sshMatch = trimmed.match(/^git@github\.com:([^/]+)\/(.+?)(?:\.git)?$/)
  if (sshMatch) return `https://github.com/${sshMatch[1]}/${sshMatch[2]}`

  const sshUrlMatch = trimmed.match(/^ssh:\/\/git@github\.com\/([^/]+)\/(.+?)(?:\.git)?$/)
  if (sshUrlMatch) return `https://github.com/${sshUrlMatch[1]}/${sshUrlMatch[2]}`

  const httpsMatch = trimmed.match(/^https:\/\/github\.com\/([^/]+)\/(.+?)(?:\.git)?$/)
  if (httpsMatch) return `https://github.com/${httpsMatch[1]}/${httpsMatch[2]}`

  return null
}
