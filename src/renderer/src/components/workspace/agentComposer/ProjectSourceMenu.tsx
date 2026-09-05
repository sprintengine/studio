import React from 'react'

import type { GitHubRepoSummary } from '../../../../../shared/electron-api'
import {
  FOCUS_RING_CLASS,
  Input,
  MENU_DIVIDER_CLASS,
  MENU_GROUP_LABEL_CLASS,
  MENU_ITEM_STACKED_CLASS,
  MENU_LIST_CLASS,
  PrimaryButton,
} from '../../ui'
import { GitHubRepoPicker, toRepoListState, type GitHubRepoListState } from '../newWorkspace/GitHubRepoPicker'
import { resolveCloneSource } from '../newWorkspace/githubClone'
import { suggestedWorkspaceFolderName } from '../newWorkspace/folderCreation'
import { basename } from '../../../utils/paths'

// The New-chat project selector's body (remote-sessions-ux /
// project-selector-sources): one surface that searches the projects, browses
// the disk, and imports from Git — the shipped MC-2207 clone machinery
// (GitHubRepoPicker, github-repos, git-clone) resurfaced where the owner
// wants everything created, stepped in place rather than stacking a second
// dialog on the first.

export type ProjectSourceOption = { path: string; label: string }

export type ProjectCloneRequest = { url: string; parentDir: string; folderName: string }
export type ProjectCloneResult = { ok: true; path: string } | { ok: false; message: string }

export function ProjectSourceMenu({
  options,
  recentOptions = [],
  selectedPath,
  defaultParent,
  onSelect,
  onBrowse,
  onClone,
  onClose,
}: {
  options: ProjectSourceOption[]
  /** Projects the app knows but this window has not open: searched too. */
  recentOptions?: ProjectSourceOption[]
  selectedPath: string | null
  /** Where a cloned repository lands: the smart parent, or null on a cold start with nothing to go on. */
  defaultParent: string | null
  onSelect: (path: string) => void
  /** Absent hides the Browse… source (a host with no folder dialog). */
  onBrowse?: () => void
  /**
   * Runs the clone and ADOPTS the result. It lives with the host rather than
   * here: this popover can close mid-clone, and a success that arrived into
   * an unmounted menu used to be lost. The menu only reports progress and
   * git's error inline, and closes on success if it is still open.
   */
  onClone: (request: ProjectCloneRequest) => Promise<ProjectCloneResult>
  onClose: () => void
}) {
  const [step, setStep] = React.useState<'projects' | 'git'>('projects')
  const [query, setQuery] = React.useState('')
  const [repoList, setRepoList] = React.useState<GitHubRepoListState>({ status: 'loading' })
  const [repoFilter, setRepoFilter] = React.useState('')
  const [selectedRepo, setSelectedRepo] = React.useState<GitHubRepoSummary | null>(null)
  const [urlDraft, setUrlDraft] = React.useState('')
  const [cloning, setCloning] = React.useState(false)
  const [cloneError, setCloneError] = React.useState<string | null>(null)
  const repoRequestSeq = React.useRef(0)

  const loadRepos = React.useCallback(() => {
    const seq = ++repoRequestSeq.current
    setRepoList({ status: 'loading' })
    void window.api
      .listGitHubRepos()
      .then((result) => {
        if (repoRequestSeq.current === seq) setRepoList(toRepoListState(result))
      })
      .catch((error: unknown) => {
        if (repoRequestSeq.current === seq) {
          setRepoList({ status: 'error', reason: 'network', message: error instanceof Error ? error.message : String(error) })
        }
      })
  }, [])

  const openGitStep = () => {
    setStep('git')
    loadRepos()
  }

  const resolution = resolveCloneSource(selectedRepo, urlDraft)
  const canClone = Boolean(resolution.source) && !cloning

  // Still mounted? State writes after an unmount are no-ops in React 18, but
  // `onClose` into a host that already closed the popover is not.
  const mounted = React.useRef(true)
  React.useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])

  const runClone = async (): Promise<void> => {
    const source = resolution.source
    if (!source || cloning) return
    if (!defaultParent) {
      // Only a true cold start with no default parent from the app lands here.
      setCloneError('Choose a folder with Browse… first, so there is somewhere to clone into.')
      return
    }
    setCloning(true)
    setCloneError(null)
    try {
      const cloned = await onClone({
        url: source.url,
        parentDir: defaultParent,
        folderName: suggestedWorkspaceFolderName(source.repoName),
      })
      if (!mounted.current) return
      if (!cloned.ok) {
        // git's message, inline; the selection is untouched.
        setCloneError(cloned.message)
        return
      }
      onClose()
    } finally {
      if (mounted.current) setCloning(false)
    }
  }

  if (step === 'git') {
    return (
      <div className="flex w-[340px] flex-col gap-2 p-2">
        <button
          type="button"
          onClick={() => setStep('projects')}
          className={`inline-flex items-center gap-1.5 self-start rounded-sm px-1 py-0.5 text-meta text-[color:var(--text-subtle)] hover:text-[color:var(--text-default)] ${FOCUS_RING_CLASS}`}
        >
          <span aria-hidden="true">←</span> Import from Git
        </button>
        <GitHubRepoPicker
          listState={repoList}
          filter={repoFilter}
          onChangeFilter={setRepoFilter}
          selectedFullName={selectedRepo?.fullName ?? null}
          onSelectRepo={(repo) => {
            // Picking clears the URL draft; typing clears the pick — the two
            // lanes stay exclusive, same contract as the workspace hub.
            setSelectedRepo((current) => (current?.fullName === repo.fullName ? null : repo))
            setUrlDraft('')
            setCloneError(null)
          }}
          urlDraft={urlDraft}
          onChangeUrlDraft={(value) => {
            setUrlDraft(value)
            if (value.trim()) setSelectedRepo(null)
            setCloneError(null)
          }}
          urlError={resolution.error}
          onRetry={loadRepos}
        />
        {cloneError ? (
          <p role="alert" className="text-micro leading-4 text-[color:var(--tone-error)]">
            {cloneError}
          </p>
        ) : null}
        <div className="flex items-center justify-between gap-2">
          <span className="min-w-0 truncate text-micro text-[color:var(--text-subtle)]">
            {defaultParent ? `Clones into ${basename(defaultParent) || defaultParent}/` : ''}
          </span>
          <PrimaryButton size="sm" disabled={!canClone} onClick={() => void runClone()}>
            {cloning ? 'Cloning…' : 'Clone'}
          </PrimaryButton>
        </div>
      </div>
    )
  }

  const needle = query.trim().toLowerCase()
  const matches = (option: ProjectSourceOption) =>
    !needle || option.label.toLowerCase().includes(needle) || option.path.toLowerCase().includes(needle)
  const visible = options.filter(matches)
  const visibleRecent = recentOptions.filter(matches)

  const projectRow = (option: ProjectSourceOption) => (
    <button
      key={option.path}
      type="button"
      role="menuitemradio"
      aria-checked={option.path === selectedPath}
      onClick={() => {
        onSelect(option.path)
        onClose()
      }}
      className={`${MENU_ITEM_STACKED_CLASS} ${
        option.path === selectedPath
          ? 'bg-[color:var(--bg-selected)] text-[color:var(--text-strong)]'
          : 'text-[color:var(--text-default)]'
      }`}
    >
      <span className="min-w-0 flex-1">
        <span className="block truncate text-body font-medium">{option.label}</span>
        <span className="mt-0.5 block truncate font-mono text-micro text-[color:var(--text-subtle)]">
          {option.path}
        </span>
      </span>
    </button>
  )

  // The hosting Popover surface is the `role="menu"`; this is the list layer
  // inside it (menu spec anatomy), never a second menu.
  return (
    <div className={`w-[300px] ${MENU_LIST_CLASS}`}>
      {/* Search first (owner, 2026-09-03): typing narrows the projects. Off
          the roving order on purpose — the field is where focus lands. */}
      <div className="px-1.5 pb-1">
        <Input
          type="text"
          size="sm"
          autoFocus
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search projects…"
          aria-label="Search projects"
        />
      </div>
      {/* The sources lead (owner, 2026-09-04): Browse… and Import from Git are
          the two rows a person needs when the project they want is NOT in the
          list, and at the foot of a long list they were the rows that ran off
          the bottom of the window. Stacked glyph + name + what it does —
          all-or-nothing leading slot, per the menu spec. The projects grow
          below the separator; these two never move. */}
      {onBrowse ? (
        <button
          type="button"
          role="menuitem"
          onClick={() => {
            onBrowse()
            onClose()
          }}
          className={`${MENU_ITEM_STACKED_CLASS} text-[color:var(--text-default)]`}
        >
          <svg viewBox="0 0 16 16" fill="none" aria-hidden="true" className="mt-0.5 icon-xs shrink-0 text-[color:var(--text-muted)]">
            <path d="M2 5.5c0-.8.7-1.5 1.5-1.5h2.6l1.2 1.4h5.2c.8 0 1.5.7 1.5 1.5v5.1c0 .8-.7 1.5-1.5 1.5h-9c-.8 0-1.5-.7-1.5-1.5V5.5Z" stroke="currentColor" strokeWidth="1.4" />
            <path d="M8 7.5v3M6.5 9h3" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
          </svg>
          <span className="min-w-0 flex-1">
            <span className="block text-body font-medium">Browse…</span>
            <span className="mt-0.5 block text-meta text-[color:var(--text-subtle)]">Pick a folder on disk.</span>
          </span>
        </button>
      ) : null}
      <button
        type="button"
        role="menuitem"
        aria-haspopup="true"
        onClick={openGitStep}
        className={`${MENU_ITEM_STACKED_CLASS} text-[color:var(--text-default)]`}
      >
        <svg viewBox="0 0 16 16" fill="none" aria-hidden="true" className="mt-0.5 icon-xs shrink-0 text-[color:var(--text-muted)]">
          <path d="M6.5 9.5a2.6 2.6 0 0 0 3.7 0l2.3-2.3a2.6 2.6 0 1 0-3.7-3.7l-1 1" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
          <path d="M9.5 6.5a2.6 2.6 0 0 0-3.7 0L3.5 8.8a2.6 2.6 0 1 0 3.7 3.7l1-1" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
        </svg>
        <span className="min-w-0 flex-1">
          <span className="block text-body font-medium">Import from Git</span>
          <span className="mt-0.5 block text-meta text-[color:var(--text-subtle)]">Clone a repository and open it here.</span>
        </span>
        <span aria-hidden="true" className="mt-0.5 shrink-0 text-micro text-[color:var(--text-disabled)]">›</span>
      </button>
      <div className={MENU_DIVIDER_CLASS} role="separator" />
      {visible.map(projectRow)}
      {visibleRecent.length > 0 ? (
        // Known but not open here: the hub's recent folders, under the spec's
        // group label (never bolder than its rows).
        <div role="group" aria-label="Recent">
          <div className={`${MENU_GROUP_LABEL_CLASS} pb-0.5 pt-1.5`}>Recent</div>
          {visibleRecent.map(projectRow)}
        </div>
      ) : null}
      {visible.length === 0 && visibleRecent.length === 0 ? (
        <div className="px-2.5 py-1.5 text-meta text-[color:var(--text-muted)]">No matching projects.</div>
      ) : null}
    </div>
  )
}
