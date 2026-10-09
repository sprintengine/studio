import { useState, type JSX } from 'react'

import { GhostButton, PrimaryButton, RefreshIcon } from '../ui'

// One line for every extension whose main entry waits on the next launch, in
// place of a "loads on the next app launch" sentence under each of them. It is
// an offer, not a fault, so it is neither the kit's error/warn Banner nor an
// InlineNotice: the calm accent-soft line the Plugins door's update banner
// already draws for the same kind of offer. "Restart now" is the page's one
// primary action.

export function RestartBanner({
  title,
  onLater,
  onRestart,
}: {
  /** "Restart Studio to start PR Radar"; the banner draws nothing without one. */
  title: string | null
  onLater: () => void
  /** Absent where there is no app to relaunch (a browser tab): Later only. */
  onRestart: (() => Promise<void>) | null
}): JSX.Element | null {
  const [restarting, setRestarting] = useState(false)
  if (!title) return null
  return (
    <div
      role="status"
      className="flex items-center gap-3 rounded-lg border border-[color:var(--border-subtle)] bg-[color:var(--accent-primary-soft)] py-2.5 pl-3 pr-2.5"
    >
      <RefreshIcon className="icon-sm shrink-0 text-[color:var(--accent-primary)]" />
      <span className="min-w-0 flex-1 text-body font-medium text-[color:var(--text-strong)]">{title}</span>
      <GhostButton size="xs" onClick={onLater}>
        Later
      </GhostButton>
      {onRestart ? (
        <PrimaryButton
          size="xs"
          busy={restarting}
          disabled={restarting}
          onClick={() => {
            setRestarting(true)
            // A Cancel on the quit question leaves the app running; the
            // banner stays, ready to be pressed again.
            void onRestart().finally(() => setRestarting(false))
          }}
        >
          Restart now
        </PrimaryButton>
      ) : null}
    </div>
  )
}
