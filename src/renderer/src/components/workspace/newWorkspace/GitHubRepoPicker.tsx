import { Field, FOCUS_RING_CLASS, GhostButton, InlineNotice, TruncatedText } from '../../ui'
import type { GitHubRepoListResult, GitHubRepoSummary } from '../../../../../shared/electron-api'
import { filterGitHubRepos } from './githubClone'

export type GitHubRepoListState =
  | { status: 'loading' }
  | { status: 'ready'; repos: GitHubRepoSummary[] }
  | { status: 'error'; reason: 'no_token' | 'unauthorized' | 'network'; message: string }

export function toRepoListState(result: GitHubRepoListResult): GitHubRepoListState {
  return result.ok
    ? { status: 'ready', repos: result.repos }
    : { status: 'error', reason: result.reason, message: result.message }
}

/**
 * The workspace step's repository picker for the Clone-from-GitHub source:
 * a filter over the account's repositories (via the token saved in Settings →
 * Version control), with a paste-a-URL lane underneath that works with no
 * token at all. Selection is exclusive with the URL draft — the panel clears
 * one when the other is used.
 */
export function GitHubRepoPicker({
  listState,
  filter,
  onChangeFilter,
  selectedFullName,
  onSelectRepo,
  urlDraft,
  onChangeUrlDraft,
  urlError,
  onRetry,
}: {
  listState: GitHubRepoListState
  filter: string
  onChangeFilter: (value: string) => void
  selectedFullName: string | null
  onSelectRepo: (repo: GitHubRepoSummary) => void
  urlDraft: string
  onChangeUrlDraft: (value: string) => void
  urlError: string | null
  onRetry: () => void
}) {
  const visibleRepos = listState.status === 'ready' ? filterGitHubRepos(listState.repos, filter) : []

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2">
      <Field.Label>Repository</Field.Label>

      {listState.status === 'loading' ? (
        <p className="px-0.5 text-micro text-[color:var(--text-subtle)]">Loading repositories…</p>
      ) : null}

      {listState.status === 'error' && listState.reason === 'no_token' ? (
        // Not a failure — nothing was tried yet. A quiet pointer, and the URL
        // lane below still clones public repositories without any token.
        <p className="rounded-md border border-[color:var(--border-default)] bg-[color:var(--bg-surface-raised)] px-3 py-2.5 text-meta leading-5 text-[color:var(--text-muted)]">
          To browse your repositories, add a GitHub token in{' '}
          <span className="font-medium text-[color:var(--text-default)]">Settings → Version control</span>.
          Public repositories clone from a URL without one.
        </p>
      ) : null}

      {listState.status === 'error' && listState.reason !== 'no_token' ? (
        <InlineNotice
          tone="error"
          action={
            <GhostButton size="sm" onClick={onRetry}>
              Retry
            </GhostButton>
          }
        >
          {listState.message}
        </InlineNotice>
      ) : null}

      {listState.status === 'ready' ? (
        <>
          <input
            value={filter}
            onChange={(event) => onChangeFilter(event.target.value)}
            placeholder="Filter repositories…"
            spellCheck={false}
            autoComplete="off"
            className={`
              block h-8 w-full rounded-md border border-[color:var(--border-default)] bg-[color:var(--bg-surface)] px-2.5
              text-meta text-[color:var(--text-strong)] transition-colors
              placeholder:text-[color:var(--text-disabled)]
              hover:border-[color:var(--border-strong)] ${FOCUS_RING_CLASS}
            `}
          />
          {visibleRepos.length === 0 ? (
            <p className="px-0.5 text-micro text-[color:var(--text-subtle)]">
              {listState.repos.length === 0
                ? 'No repositories on this account.'
                : 'No repositories match the filter.'}
            </p>
          ) : (
            <div className="flex min-h-[88px] flex-1 flex-col gap-0.5 overflow-y-auto pr-1" role="listbox" aria-label="GitHub repositories">
              {visibleRepos.map((repo) => {
                const selected = repo.fullName === selectedFullName
                return (
                  <button
                    key={repo.fullName}
                    type="button"
                    role="option"
                    aria-selected={selected}
                    onClick={() => onSelectRepo(repo)}
                    className={`
                      flex w-full items-baseline gap-2 rounded-md px-2.5 py-1.5 text-left transition-colors
                      focus-visible:focus-ring
                      ${selected ? 'bg-[color:var(--bg-selected)]' : 'hover:bg-[color:var(--bg-hover)]'}
                    `}
                  >
                    <span className="shrink-0 text-body font-medium text-[color:var(--text-strong)]">
                      {repo.fullName}
                    </span>
                    <span className="shrink-0 rounded-full border border-[color:var(--border-default)] px-1.5 text-micro leading-4 text-[color:var(--text-subtle)]">
                      {repo.isPrivate ? 'Private' : 'Public'}
                    </span>
                    {repo.description ? (
                      <TruncatedText
                        as="span"
                        text={repo.description}
                        className="min-w-0 flex-1 truncate text-meta text-[color:var(--text-muted)]"
                      />
                    ) : null}
                  </button>
                )
              })}
            </div>
          )}
        </>
      ) : null}

      <div className="flex items-center gap-2.5" aria-hidden>
        <span className="h-px flex-1 bg-[color:var(--border-subtle)]" />
        <span className="text-micro font-medium text-[color:var(--text-subtle)]">
          or paste a URL
        </span>
        <span className="h-px flex-1 bg-[color:var(--border-subtle)]" />
      </div>
      <input
        value={urlDraft}
        onChange={(event) => onChangeUrlDraft(event.target.value)}
        placeholder="https://github.com/owner/repo"
        spellCheck={false}
        autoComplete="off"
        aria-label="Repository URL"
        aria-invalid={urlError ? true : undefined}
        className={`
          block h-8 w-full rounded-md border bg-[color:var(--bg-surface)] px-2.5
          font-mono text-meta text-[color:var(--text-strong)] transition-colors
          placeholder:text-[color:var(--text-disabled)]
          hover:border-[color:var(--border-strong)] ${FOCUS_RING_CLASS}
          ${urlError ? 'border-[color:var(--tone-error)]' : 'border-[color:var(--border-default)]'}
        `}
      />
      {urlError ? <p className="px-0.5 text-micro leading-4 text-[color:var(--tone-error)]">{urlError}</p> : null}
    </div>
  )
}
