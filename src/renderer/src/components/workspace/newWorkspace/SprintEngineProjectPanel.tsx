// The sprint wizard's project fields (item 1765, mockup §3). Two rows at the top
// of the "What" page: the project that holds the run, and the other projects it
// also works in.
//
// The primary project is a picker over the projects already open, because a
// sprint started from the Sprints door has no folder to inherit — the door is
// outside every project. "Also works in" declares the rest of the repo set at
// creation, so a run that spans three projects has three worktrees the moment it
// initializes instead of discovering them one `request_repo` at a time.

import React from 'react'

import { Field, Select } from '../../ui'
import { FOCUS_RING_CLASS } from '../../ui/tokens'
import { basename } from '../../../utils/paths'
import type { SprintDeclaredRepo, SprintProjectOption } from './sprintProjectSelection'

const BROWSE_VALUE = '__browse__'

export function SprintEngineProjectPanel({
  projects,
  primaryFolderPath,
  onSelectPrimary,
  onBrowsePrimary,
  declaredRepos,
  onToggleRepo,
  onBrowseRepo,
  repoError,
  showRepos,
}: {
  /** Every project the app knows about — the same set the Sprints door lists runs from. */
  projects: readonly SprintProjectOption[]
  primaryFolderPath: string | null
  onSelectPrimary: (folderPath: string) => void
  onBrowsePrimary: () => void
  declaredRepos: readonly SprintDeclaredRepo[]
  /** Toggling a known project on or off. Rejections surface through `repoError`. */
  onToggleRepo: (folderPath: string, displayName: string) => void
  onBrowseRepo: () => void
  /** Why the last selection was refused, in the user's words. */
  repoError: string | null
  /**
   * Withheld for a run that starts from a backlog item or an existing team: the
   * repo set of a run created from a plan comes from that plan's own project,
   * and a saved team's repos were fixed when it was created.
   */
  showRepos: boolean
}): JSX.Element {
  // The chosen project always appears in its own picker, even when it is not one
  // of the open projects (browsed from disk, or seeded by a backlog launch).
  const primaryItems = React.useMemo(() => {
    const known = projects.map((project) => ({ value: project.folderPath, label: project.displayName }))
    const listed = known.some((item) => item.value === primaryFolderPath)
    return [
      ...(primaryFolderPath && !listed
        ? [{ value: primaryFolderPath, label: basename(primaryFolderPath) }]
        : []),
      ...known,
      { value: BROWSE_VALUE, label: 'Choose another folder…' },
    ]
  }, [projects, primaryFolderPath])

  const declaredByPath = React.useMemo(
    () => new Map(declaredRepos.map((repo) => [repo.folderPath, repo])),
    [declaredRepos],
  )
  const otherProjects = projects.filter((project) => project.folderPath !== primaryFolderPath)
  // A declared project browsed from disk is not in the open-projects list, so it
  // rides after them rather than vanishing from the row that shows it is on.
  const browsedRepos = declaredRepos.filter(
    (repo) => !projects.some((project) => project.folderPath === repo.folderPath),
  )

  const hintId = React.useId()
  // One line under the chips that is true in every state, so an empty row never
  // reads as "there is nothing to add here".
  const repoHint = !primaryFolderPath
    ? 'Choose the primary project first.'
    : declaredRepos.length > 0
      ? 'Every agent works in one project at a time, so each of these gets its own worktree.'
      : otherProjects.length === 0
        ? 'No other project is open. Add a folder to work in one.'
        : 'None by default — a sprint works in one project unless you say otherwise.'

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-2">
        <Field.Label>Primary project — holds the run and its plan</Field.Label>
        <Select
          ariaLabel="Primary project"
          items={primaryItems}
          value={primaryFolderPath}
          onChange={(value) => (value === BROWSE_VALUE ? onBrowsePrimary() : onSelectPrimary(value))}
          placeholder="Choose a project…"
          className="w-full"
          triggerMinWidthClassName="min-w-0"
        />
        {primaryFolderPath ? (
          <span className="truncate font-mono text-[11px] leading-4 text-[color:var(--text-subtle)]">
            {primaryFolderPath}
          </span>
        ) : null}
      </div>

      {showRepos ? (
        <div className="flex flex-col gap-2">
          <Field.Label>Also works in — each repo gets its own branch and pull request</Field.Label>
          <div
            role="group"
            aria-label="Also works in"
            aria-describedby={hintId}
            className="flex flex-wrap gap-1.5"
          >
            {otherProjects.map((project) => (
              <ProjectRepoChip
                key={project.folderPath}
                label={project.displayName}
                selected={declaredByPath.has(project.folderPath)}
                disabled={!primaryFolderPath}
                onToggle={() => onToggleRepo(project.folderPath, project.displayName)}
              />
            ))}
            {browsedRepos.map((repo) => (
              <ProjectRepoChip
                key={repo.folderPath}
                label={repo.displayName}
                selected
                disabled={false}
                onToggle={() => onToggleRepo(repo.folderPath, repo.displayName)}
              />
            ))}
            <button
              type="button"
              onClick={onBrowseRepo}
              disabled={!primaryFolderPath}
              className={`
                h-[24px] rounded-full border border-dashed border-[color:var(--border-default)] px-2.5
                text-[11.5px] text-[color:var(--text-muted)] transition-colors
                hover:bg-[color:var(--bg-hover)] hover:text-[color:var(--text-strong)]
                disabled:cursor-not-allowed disabled:opacity-45 disabled:hover:bg-transparent
                ${FOCUS_RING_CLASS}
              `}
            >
              add folder…
            </button>
          </div>
          {/* One live region, so a rejection is announced where the hint sat
              rather than appearing silently beside the chips. */}
          <span
            id={hintId}
            role="status"
            className={`text-[11px] leading-4 ${
              repoError ? 'text-[color:var(--tone-error)]' : 'text-[color:var(--text-muted)]'
            }`}
          >
            {repoError ?? repoHint}
          </span>
        </div>
      ) : null}
    </div>
  )
}

// A selection chip, not a filter chip: `aria-pressed` carries the on state so the
// accent fill is never the only signal.
function ProjectRepoChip({
  label,
  selected,
  disabled,
  onToggle,
}: {
  label: string
  selected: boolean
  disabled: boolean
  onToggle: () => void
}): JSX.Element {
  return (
    <button
      type="button"
      aria-pressed={selected}
      disabled={disabled}
      onClick={onToggle}
      className={`h-[24px] max-w-full truncate rounded-full px-2.5 text-[11.5px] transition-colors disabled:cursor-not-allowed disabled:opacity-45 ${FOCUS_RING_CLASS} ${
        selected
          ? 'bg-[color:var(--accent-primary-soft)] font-medium text-[color:var(--accent-primary)]'
          : 'border border-[color:var(--border-default)] text-[color:var(--text-muted)] hover:bg-[color:var(--bg-hover)] hover:text-[color:var(--text-strong)]'
      }`}
    >
      {label}
      {selected ? <span aria-hidden="true"> ✓</span> : null}
    </button>
  )
}
