import React from 'react'
import { AutomationsWorkspaceTypeIcon } from '../AppIcons'
import { GhostButton } from '../ui'

export type AutomationsHostBannerProps = {
  /** Returns the user to a normal workspace (or new-workspace setup when none). */
  onReturn: () => void
  /** Action copy — names where the return goes so the affordance is unambiguous. */
  returnLabel: string
}

// Identity strip shown while the hidden Automations host workspace is the active
// workspace. The host is never a rail row (utils/workspaceVisibility.ts), reached
// only via Automations "Open agent" / deep link, so this banner is the sole
// surface that (a) tells the user this is the background Automations host rather
// than a project workspace and (b) gives a keyboard-accessible way back. It docks
// directly under the workspace top bar, above the host's terminal content.
export function AutomationsHostBanner({ onReturn, returnLabel }: AutomationsHostBannerProps) {
  return (
    <div
      role="region"
      aria-label="Automations host workspace"
      className="flex items-center justify-between gap-3 border-b border-[color:var(--border-default)] bg-[color:var(--bg-surface-raised)] px-3 py-1.5"
    >
      <span className="flex min-w-0 items-center gap-2">
        <AutomationsWorkspaceTypeIcon className="icon-sm shrink-0 text-[color:var(--text-muted)]" />
        <span className="flex min-w-0 flex-col leading-tight">
          <span className="truncate text-[12px] font-medium text-[color:var(--text-strong)]">
            Automations host
          </span>
          <span className="truncate text-[11px] text-[color:var(--text-muted)]">
            Background workspace for automation runs — not a project workspace.
          </span>
        </span>
      </span>
      <GhostButton onClick={onReturn} className="shrink-0">
        {returnLabel}
      </GhostButton>
    </div>
  )
}
