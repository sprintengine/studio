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
      className={`relative inline-flex h-8 w-8 items-center justify-center rounded-md border transition-colors focus:outline-none focus:ring-1 focus:ring-[#303139] ${
        error
          ? 'border-[#713036] bg-[#1d1114] text-[#ff787c] hover:border-[#8b3b42] hover:bg-[#2a1518] hover:text-[#ff9a9d]'
          : dimmed
            ? 'border-[#1b1c21] bg-[#0e0f12] text-[#4f535c] hover:border-[#24252b] hover:bg-[#111216] hover:text-[#6f7480]'
            : 'border-[#24252b] bg-[#111216] text-[#9a9aa2] hover:border-[#303139] hover:bg-[#17181d] hover:text-[#d7d7dc]'
      }`}
      title={tooltip}
      aria-label={ariaLabel}
      aria-busy={repoState === 'loading'}
    >
      <GitBranchIcon className="h-[18px] w-[18px]" />
      {hasChanges ? (
        <span className="absolute -right-1 -top-1 flex h-4 min-w-4 items-center justify-center rounded-full border border-[#0b0c0f] bg-[#f2a84b] px-1 text-[10px] font-bold leading-none text-[#1d1203]">
          {badgeLabel}
        </span>
      ) : null}
      {error ? (
        <span className="absolute -right-1 -top-1 flex h-4 w-4 items-center justify-center rounded-full border border-[#0b0c0f] bg-[#ff5a5f] text-[10px] font-bold leading-none text-[#240708]">
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
