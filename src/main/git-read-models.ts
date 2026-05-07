import type {
  GitBranchSnapshot,
  GitHistorySnapshot,
  GitRef,
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
    const totalCountOutput = await runGit(repoRoot, ['rev-list', '--count', 'HEAD'])
    const headHash = (await runGit(repoRoot, ['rev-parse', 'HEAD'])).trim()
    const refsOutput = await runGit(repoRoot, [
      'for-each-ref',
      '--format=%(refname:short)%09%(objectname)%09%(refname)',
      'refs/heads',
      'refs/remotes',
      'refs/tags',
    ])
    const stdout = await runGit(repoRoot, [
      'log',
      `--max-count=${safeLimit}`,
      '--date=format:%Y-%m-%d %H:%M',
      '--pretty=format:%H%x1f%h%x1f%an%x1f%ad%x1f%D%x1f%s%x1e',
    ])
    const totalCount = Number.parseInt(totalCountOutput.trim(), 10) || 0
    const refs: GitRef[] = [
      { name: 'HEAD', hash: headHash, type: 'other' },
      ...refsOutput
        .split(/\r?\n/)
        .filter(Boolean)
        .map((line): GitRef => {
          const [name = '', hash = '', fullRef = ''] = line.split('\t')
          const type = fullRef.startsWith('refs/heads/')
            ? 'head'
            : fullRef.startsWith('refs/remotes/')
              ? 'remote'
              : fullRef.startsWith('refs/tags/')
                ? 'tag'
                : 'other'
          return { name, hash, type }
        }),
    ]
    const refsByHash = new Map<string, string[]>()
    refs.forEach((ref) => {
      const names = refsByHash.get(ref.hash) ?? []
      names.push(ref.name)
      refsByHash.set(ref.hash, names)
    })

    const commits = stdout
      .split('\x1e')
      .map((record) => record.trim())
      .filter(Boolean)
      .map((record) => {
        const [hash = '', shortHash = '', author = '', date = '', refsText = '', subject = ''] = record.split('\x1f')
        const decoratedRefs = refsText.split(',').map((ref) => ref.trim()).filter(Boolean)
        const exactRefs = refsByHash.get(hash) ?? []
        return {
          hash,
          shortHash,
          author,
          date,
          refs: [...new Set([...decoratedRefs, ...exactRefs])],
          subject,
          commitWebUrl: githubRepoWebUrl ? `${githubRepoWebUrl}/commit/${hash}` : null,
        }
      })

    return { commits, refs, totalCount, updatedAt: Date.now() }
  } catch {
    return { commits: [], refs: [], totalCount: 0, updatedAt: Date.now() }
  }
}
