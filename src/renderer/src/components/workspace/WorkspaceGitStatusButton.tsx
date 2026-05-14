import React from 'react'
import { useGitStatus, type GitRepoState } from '../../hooks/useGitStatus'
import { focusOrAddComponentTab } from '../../utils/modelRegistry'

type WorkspaceGitStatusButtonProps = {
  workspaceId: string
  folderPath: string | null
  onOpen?: () => void
}

const MAX_BADGE_COUNT = 99

export default function WorkspaceGitStatusButton({
  workspaceId,
  folderPath,
  onOpen,
}: WorkspaceGitStatusButtonProps) {
  const { status, repoState, errorMessage } = useGitStatus(folderPath)
  const changeCount = Object.keys(status?.files ?? {}).length
  const hasChanges = repoState === 'ready' && changeCount > 0
  const dimmed = repoState === 'not-git' || repoState === 'idle'
  const error = repoState === 'error'
  const badgeLabel = changeCount > MAX_BADGE_COUNT ? `${MAX_BADGE_COUNT}+` : String(changeCount)
  const tooltip = getTooltip(repoState, changeCount, errorMessage)
  const ariaLabel = getAriaLabel(repoState, changeCount)

  const openGitPanel = () => {
    onOpen?.()
    focusOrAddComponentTab(workspaceId, 'git', 'Git')
  }

  return (
    <button
      type="button"
      onClick={openGitPanel}
      className={`relative inline-flex h-8 w-8 items-center justify-center rounded-md border transition-colors focus:outline-none focus:ring-1 focus:ring-[color:var(--border-strong)] ${
        error
          ? 'border-[color:var(--tone-error)] bg-[color:var(--tone-error-soft)] text-[color:var(--tone-error)] hover:border-[color:var(--tone-error)] hover:bg-[color:var(--tone-error-soft)] hover:text-[color:var(--tone-error)]'
          : dimmed
            ? 'border-[color:var(--bg-active)] bg-[color:var(--bg-surface)] text-[color:var(--text-disabled)] hover:border-[color:var(--bg-selected)] hover:bg-[color:var(--bg-surface-raised)] hover:text-[color:var(--text-subtle)]'
            : 'border-[color:var(--bg-selected)] bg-[color:var(--bg-surface-raised)] text-[color:var(--text-muted)] hover:border-[color:var(--border-strong)] hover:bg-[color:var(--bg-hover)] hover:text-[color:var(--text-default)]'
      }`}
      title={tooltip}
      aria-label={ariaLabel}
      aria-busy={repoState === 'loading'}
    >
      <GitBranchIcon className="h-[18px] w-[18px]" />
      {hasChanges ? (
        <span className="absolute -right-1 -top-1 flex h-4 min-w-4 items-center justify-center rounded-full border border-[color:var(--bg-app)] bg-[color:var(--tone-warn)] px-1 text-[10px] font-bold leading-none text-[color:var(--text-on-accent)]">
          {badgeLabel}
        </span>
      ) : null}
      {error ? (
        <span className="absolute -right-1 -top-1 flex h-4 w-4 items-center justify-center rounded-full border border-[color:var(--bg-app)] bg-[color:var(--tone-error)] text-[10px] font-bold leading-none text-[color:var(--text-on-accent)]">
          !
        </span>
      ) : null}
    </button>
  )
}

function getTooltip(
  repoState: GitRepoState,
  changeCount: number,
  errorMessage: string | null
): string {
  switch (repoState) {
    case 'idle':
      return 'Open a folder to use Git'
    case 'loading':
      return 'Checking Git status'
    case 'not-git':
      return 'No Git repository'
    case 'error':
      return `Git status unavailable${errorMessage ? `: ${errorMessage}` : ''}`
    case 'ready':
      return changeCount === 0
        ? 'Working tree clean'
        : `${changeCount} workspace ${changeCount === 1 ? 'change' : 'changes'}`
  }
}

function getAriaLabel(
  repoState: GitRepoState,
  changeCount: number
): string {
  switch (repoState) {
    case 'idle':
      return 'Open Git panel, no workspace folder'
    case 'loading':
      return 'Open Git panel, checking Git status'
    case 'not-git':
      return 'Open Git panel, no Git repository'
    case 'error':
      return 'Open Git panel, Git status unavailable'
    case 'ready':
      return changeCount === 0
        ? 'Open Git panel, working tree clean'
        : `Open Git panel, ${changeCount} workspace ${changeCount === 1 ? 'change' : 'changes'}`
  }
}

function GitBranchIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <circle cx="6.75" cy="6" r="2.25" stroke="currentColor" strokeWidth="1.7" />
      <circle cx="17.25" cy="6" r="2.25" stroke="currentColor" strokeWidth="1.7" />
      <circle cx="6.75" cy="18" r="2.25" stroke="currentColor" strokeWidth="1.7" />
      <path d="M6.75 8.25V15.75" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
      <path d="M9 6H12.4C14.25 6 15.75 7.5 15.75 9.35V13.75" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
    </svg>
  )
}
