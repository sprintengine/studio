// A project folder that is not itself a repository and holds several that are
// (`acme/` with `acme/api`, `acme/web`): what main found in it, and what an
// agent started there is told. The rules that find the repositories are in
// `src/main/project-repositories.ts`; the design is
// `docs/design/multi-repo-projects.md`.
//
// Pure: no I/O, so the renderer, main and the host-context document share it.

/** One repository inside the project folder. */
export type ProjectRepository = {
  /** Absolute path of the repository's root. */
  path: string
  /** Its path below the project folder, with `/` separators: `api`, `services/billing`. */
  relativePath: string
  /** What a list shows: the folder's own name. */
  name: string
}

export type ProjectRepositories = {
  /** The project folder, as it was asked about. */
  root: string
  /** Where the list came from: the folder's children, or the one `.code-workspace` file in it. */
  source: { kind: 'children' } | { kind: 'code-workspace'; file: string }
  /** At most {@link PROJECT_REPOSITORY_LIMIT}, in the workspace file's order or by name. */
  repositories: ProjectRepository[]
  /** True when the folder holds more than the limit, and only the first ones are listed. */
  truncated: boolean
}

/**
 * The most repositories one project lists. A folder with more is more likely a
 * directory of unrelated clones than a project, and everything per repository
 * (checkpoints above all) would cost that many times over.
 */
export const PROJECT_REPOSITORY_LIMIT = 20

/** Why a New chat or a `newWorktree` cannot cut a worktree here; one sentence, said in both places. */
export const PROJECT_REPOSITORIES_WORKTREE_REASON =
  'Worktrees are not available yet for a project of several repositories; the chat runs in the project folder.'

/**
 * The standing instruction an agent in a multi-repository project gets: the
 * folder is not a repository, which ones it holds, and to run git in each.
 * Short, because it is read on every turn. Null for a folder with none, so a
 * launch anywhere else carries nothing new.
 */
export function projectRepositoriesInstructions(project: ProjectRepositories | null): string | null {
  if (!project || project.repositories.length === 0) return null
  const count = project.repositories.length
  const lines = [
    `This project folder (\`${project.root}\`) is not itself a Git repository. It holds ${count === 1 ? 'one repository' : `${count} repositories`}, each with its own history, branches and remote:`,
    '',
    ...project.repositories.map((repository) => `- \`${repository.relativePath}/\``),
  ]
  if (project.truncated) lines.push('- and more, not listed here')
  lines.push(
    '',
    'Run git inside the repository you are working on (`git -C <repository> status`, or `cd` into it first); git run in the project folder itself fails. A change that spans repositories is a commit in each of them.',
  )
  return lines.join('\n')
}

/**
 * The member a project-relative path is in (`api/src/user.ts` → `api`), the
 * longest match first so a member listed below another is never shadowed.
 * Null when the path is in none of them.
 */
export function projectRepositoryOf<T extends Pick<ProjectRepository, 'relativePath'>>(
  repositories: readonly T[],
  path: string,
): { repository: T; inner: string } | null {
  let best: { repository: T; inner: string } | null = null
  for (const repository of repositories) {
    const prefix = `${repository.relativePath}/`
    if (!path.startsWith(prefix)) continue
    if (best && best.repository.relativePath.length >= repository.relativePath.length) continue
    best = { repository, inner: path.slice(prefix.length) }
  }
  return best
}
