import type {
  GitBranchSnapshot,
  GitHistorySnapshot,
} from './git'
import { getGitHubRepoWebUrl } from './git-github'
import { runGit } from './git-utils'

export async function getGitBranches(repoRoot: string): Promise<GitBranchSnapshot> {
  const branchOutput = await runGit(repoRoot, [
    'branch',
    '--format=%(refname:short)%09%(HEAD)%09%(upstream:short)',
    '--sort=refname',
  ])
  const branches = branchOutput
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      const [name, head, upstream] = line.split('\t')
      return {
        name,
        current: head === '*',
        upstream: upstream || null,
      }
    })
  const current = branches.find((branch) => branch.current)?.name ?? null
  let ahead = 0
  let behind = 0

  try {
    const counts = await runGit(repoRoot, ['rev-list', '--left-right', '--count', 'HEAD...@{upstream}'])
    const [aheadText, behindText] = counts.trim().split(/\s+/)
    ahead = Number.parseInt(aheadText ?? '0', 10) || 0
    behind = Number.parseInt(behindText ?? '0', 10) || 0
  } catch {
    // Repositories without an upstream simply have no ahead/behind counts.
  }

  return { current, branches, ahead, behind }
}

export async function getGitHistory(repoRoot: string, limit = 12): Promise<GitHistorySnapshot> {
  try {
    const safeLimit = Math.min(Math.max(Math.floor(limit), 1), 50)
    const githubRepoWebUrl = await getGitHubRepoWebUrl(repoRoot)
    const stdout = await runGit(repoRoot, [
      'log',
      `--max-count=${safeLimit}`,
      '--date=short',
      '--pretty=format:%H%x1f%h%x1f%an%x1f%ad%x1f%D%x1f%s%x1e',
    ])

    const commits = stdout
      .split('\x1e')
      .map((record) => record.trim())
      .filter(Boolean)
      .map((record) => {
        const [hash = '', shortHash = '', author = '', date = '', refsText = '', subject = ''] = record.split('\x1f')
        return {
          hash,
          shortHash,
          author,
          date,
          refs: refsText.split(',').map((ref) => ref.trim()).filter(Boolean),
          subject,
          commitWebUrl: githubRepoWebUrl ? `${githubRepoWebUrl}/commit/${hash}` : null,
        }
      })

    return { commits, updatedAt: Date.now() }
  } catch {
    return { commits: [], updatedAt: Date.now() }
  }
}
