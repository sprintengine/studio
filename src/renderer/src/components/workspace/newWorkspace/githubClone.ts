/**
 * Pure helpers for the workspace step's Clone-from-GitHub source: resolving
 * the clone URL from a picked repo or a pasted URL, and filtering the repo
 * list. Kept beside folderCreation.ts and unit-tested the same way.
 */
import type { GitHubRepoSummary } from '../../../../../shared/electron-api'
import { validateCloneUrl } from '../../../../../shared/git-clone-url'

type CloneSource = { url: string; repoName: string; label: string }

export type CloneSourceResolution = { source: CloneSource; error: null } | { source: null; error: string | null }

/**
 * The active clone source: a picked repository wins (picking clears the URL
 * draft, typing clears the pick — the caller maintains that exclusivity).
 * A blank URL draft is "nothing chosen yet" (error: null); a non-blank draft
 * that does not parse carries the validation error for inline display.
 */
export function resolveCloneSource(selectedRepo: GitHubRepoSummary | null, urlDraft: string): CloneSourceResolution {
  if (selectedRepo) {
    return {
      source: {
        url: selectedRepo.cloneUrl,
        repoName: selectedRepo.name,
        label: selectedRepo.fullName,
      },
      error: null,
    }
  }
  const trimmed = urlDraft.trim()
  if (!trimmed) return { source: null, error: null }
  const validated = validateCloneUrl(trimmed)
  if (!validated.ok) return { source: null, error: validated.error }
  return {
    source: { url: validated.url, repoName: validated.repoName, label: validated.repoName },
    error: null,
  }
}

/** Case-insensitive substring filter over full name and description. */
export function filterGitHubRepos(repos: readonly GitHubRepoSummary[], filter: string): GitHubRepoSummary[] {
  const needle = filter.trim().toLowerCase()
  if (!needle) return [...repos]
  return repos.filter(
    (repo) => repo.fullName.toLowerCase().includes(needle) || (repo.description ?? '').toLowerCase().includes(needle),
  )
}
