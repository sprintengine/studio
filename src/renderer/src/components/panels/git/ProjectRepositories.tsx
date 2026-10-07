import React, { useState, type JSX } from 'react'

import { PROJECT_REPOSITORY_LIMIT, type ProjectRepositories } from '../../../../../shared/project-repositories'
import { useProjectRepositories } from '../../../hooks/useProjectRepositories'
import { Select } from '../../ui'

// The Git panel in a folder of several repositories
// (docs/design/multi-repo-projects.md, 4.2): a Repository row, and the panel
// for the chosen member, remounted per member so its scopes, branches, graph,
// stashes and watcher are that member's alone and only the member on screen is
// watched. Every read and action below the row is the panel a repository
// workspace gets, run in the member's folder.

/** What the panel body is opened on. All absent: the workspace's own folder, as always. */
export type GitPanelTarget = {
  /** The member: the folder every read and action runs in, in place of the workspace's own. */
  repository?: string
  /** Keeps each member's commit drafts apart, since every member has a scope called `main`. */
  draftPrefix?: string
  /** The Repository row, drawn above Branch and above any empty state. */
  switcher?: React.ReactNode
  /** The project's members are still being read: hold the "not a repository" verdict. */
  projectResolving?: boolean
  /** The person asked for a fresh read. */
  onFetch?: () => void
}

/**
 * The member each workspace's panel last showed, for the window's lifetime.
 * Not written to the workspace record: that rides workspace sync to every
 * window and device, and which member one panel shows is this panel's.
 */
const chosenMember = new Map<string, string>()

/** Forget every panel's chosen member. For tests. */
export function clearChosenProjectRepositories(): void {
  chosenMember.clear()
}

export function ProjectRepositoriesGitPanel({
  workspaceId,
  folderPath,
  renderBody,
}: {
  workspaceId: string
  folderPath: string | null
  renderBody: (target: GitPanelTarget) => JSX.Element
}): JSX.Element {
  const { status, project, refresh } = useProjectRepositories(folderPath)
  const [, chose] = useState(0)
  const chosen = chosenMember.get(workspaceId) ?? null
  const members = project?.repositories ?? []
  const member = members.find((candidate) => candidate.relativePath === chosen) ?? members[0] ?? null
  if (!project || !member) return renderBody({ projectResolving: status === 'loading' })
  const switcher = (
    <ProjectRepositoryRow
      project={project}
      value={member.relativePath}
      onChange={(next) => {
        chosenMember.set(workspaceId, next)
        chose((count) => count + 1)
      }}
    />
  )
  return (
    <React.Fragment key={member.path}>
      {renderBody({
        repository: member.path,
        draftPrefix: `repository:${member.relativePath}:`,
        switcher,
        onFetch: refresh,
      })}
    </React.Fragment>
  )
}

/** The Repository row: the project's members, in the same label-and-select grid as Branch. */
function ProjectRepositoryRow({
  project,
  value,
  onChange,
}: {
  project: ProjectRepositories
  value: string
  onChange: (relativePath: string) => void
}): JSX.Element {
  const items: Array<{ value: string; label: string; disabled?: boolean }> = project.repositories.map((member) => ({
    value: member.relativePath,
    label: member.relativePath,
  }))
  // Past the cap the list says so, rather than reading as everything there is.
  if (project.truncated)
    items.push({
      value: '',
      label: `Only the first ${PROJECT_REPOSITORY_LIMIT} repositories are listed`,
      disabled: true,
    })
  return (
    <div className="grid grid-cols-[4rem_minmax(0,1fr)] items-center gap-2" data-project-repositories="">
      <span className="text-micro text-[color:var(--text-subtle)]">Repository</span>
      <Select<string>
        ariaLabel="Repository"
        items={items}
        value={value}
        onChange={(next) => {
          if (next) onChange(next)
        }}
        className="w-full"
        triggerMinWidthClassName="min-w-0"
      />
    </div>
  )
}
