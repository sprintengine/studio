import { Field, GhostButton, InlineNotice, Input, RowButton, TruncatedText } from '../../ui'
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
          {/* The kit's field at its `sm` step — the ramp height an input and
              the select beside it share. The 32px box this drew was off the
              26/30/34 ramp entirely. */}
          <Input
            value={filter}
            onChange={(event) => onChangeFilter(event.target.value)}
            placeholder="Filter repositories…"
            spellCheck={false}
            autoComplete="off"
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
                  // The kit's inset row. `selected` paints the neutral
                  // selection canon; `aria-current` is withheld because a
                  // listbox option states its state in `aria-selected`, which
                  // the caller passes.
                  <RowButton
                    key={repo.fullName}
                    density="row"
                    selected={selected}
                    aria-current={undefined}
                    role="option"
                    aria-selected={selected}
                    onClick={() => onSelectRepo(repo)}
                    className="pl-2.5 pr-2.5"
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
                  </RowButton>
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
      {/* The error edge rides `aria-invalid` inside the primitive, so the
          conditional border class this carried is gone: an attribute variant
          out-specifies both the resting border and the hover lift, which a
          plain conditional class does not. */}
      <Input
        value={urlDraft}
        onChange={(event) => onChangeUrlDraft(event.target.value)}
        placeholder="https://github.com/owner/repo"
        spellCheck={false}
        autoComplete="off"
        aria-label="Repository URL"
        aria-invalid={urlError ? true : undefined}
        className="font-mono"
      />
      {urlError ? <p className="px-0.5 text-micro leading-4 text-[color:var(--tone-error)]">{urlError}</p> : null}
    </div>
  )
}
