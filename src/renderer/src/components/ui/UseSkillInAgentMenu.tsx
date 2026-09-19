// "Use in agent", wherever a surface can name a skill.
//
// The button that opens the round trip in `utils/useSkillInAgent.ts`: it lists
// the live agents and hands the chosen one to the caller — and, where the
// caller asks for it (`directWhenSingle`), skips the menu entirely when there
// is only one answer. It was a private helper inside the Installed inventory,
// one navigation away from the doors where a person actually installs a skill;
// it is a kit component now so the skill page, the plugin page and the palette
// open the same door with the same words.
//
// The menu is presentation only. Every fact it shows and every effect it has
// comes from the flow module and from the caller's `onUse`.

import React, { useCallback, useEffect, useRef, useState, type JSX } from 'react'

import { InlineNotice } from './InlineNotice'
import { MENU_LIST_CLASS } from './menuClasses'
import { MenuDivider, MenuItem, roveMenuFocus } from './ContextMenu'
import { OutlineButton, PrimaryButton } from './Buttons'
import { Popover, type PopoverPlacement } from './Popover'
import { Spinner } from './Spinner'
import { listLiveAgentSessions, pickTargetSession, type LiveAgentSession } from '../../utils/useSkillInAgent'

export type UseSkillInAgentMenuProps = {
  /** Names the skill in the trigger's accessible label. */
  skillName: string
  /** Only this workspace's agents, when the surface knows which it is. */
  workspaceId?: string | null
  /** Preferred without asking: the pane in front of the user, when known. */
  preferred?: { sessionId?: string | null; agentId?: string | null } | null
  /**
   * Do the work. Returning a message shows it in the menu and keeps it open;
   * returning nothing (or void) closes it.
   */
  onUse: (session: LiveAgentSession) => Promise<string | null | void> | string | null | void
  /** The "New agent…" row, offered last when the caller can start one. */
  onNewAgent?: () => Promise<string | null | void> | string | null | void
  label?: string
  /** `outline` in a row of rows; `primary` when this is the page's one action. */
  emphasis?: 'outline' | 'primary'
  size?: 'sm' | 'md'
  placement?: PopoverPlacement
  disabled?: boolean
  /** Said instead of the menu when nothing can take a skill (no folder open). */
  unavailableReason?: string | null
  /**
   * Skip the menu when the answer is not a question: one live agent, or a
   * `preferred` one that is still live, is used on the first click. Off by
   * default — the Installed inventory's menu has always opened, and a list of
   * rows each with a hair-trigger action is not the same affordance.
   */
  directWhenSingle?: boolean
}

export function UseSkillInAgentMenu({
  skillName,
  workspaceId,
  preferred,
  onUse,
  onNewAgent,
  label = 'Use in agent',
  emphasis = 'outline',
  size = 'sm',
  placement = 'bottom-end',
  disabled = false,
  unavailableReason = null,
  directWhenSingle = false,
}: UseSkillInAgentMenuProps): JSX.Element {
  const [open, setOpen] = useState(false)
  const [sessions, setSessions] = useState<LiveAgentSession[] | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!open) return
    // Nothing to list when the surface has already said why this cannot work
    // (no folder open): the reason is the whole content of the menu.
    if (unavailableReason) {
      setSessions([])
      setError(unavailableReason)
      return
    }
    let cancelled = false
    setSessions(null)
    void listLiveAgentSessions({ workspaceId }).then((live) => {
      if (!cancelled) setSessions(live)
    })
    return () => {
      cancelled = true
    }
  }, [open, workspaceId, unavailableReason])

  // Focus enters the menu on open, on the first row that can take it — the
  // menu-button contract `OverflowMenu` and `SplitButton` keep. The rows here
  // arrive asynchronously (`sessions` is null while the list is in flight and
  // the surface holds only the loading row), so on open there may be nothing to
  // focus yet. Park focus on the menu body itself in that case — it carries the
  // `roveMenuFocus` keydown handler, so the arrow keys are live — and move onto
  // row 1 the moment the rows exist.
  const menuBodyRef = useRef<HTMLDivElement | null>(null)
  const focusMenu = useCallback(() => {
    const body = menuBodyRef.current
    if (!body) return
    const first = body.querySelector<HTMLButtonElement>('[data-menu-item="true"]:not([disabled])')
    if (first) first.focus()
    else body.focus()
  }, [])
  // Stable identity: `Popover` keys its auto-focus effect on this callback.
  // Next frame, so the Popover has positioned (and un-hidden) its surface.
  const handleOpenAutoFocus = useCallback(() => {
    requestAnimationFrame(focusMenu)
  }, [focusMenu])
  useEffect(() => {
    if (!open || sessions === null) return
    const body = menuBodyRef.current
    if (!body) return
    // Do not steal focus back if it already sits on a row the person moved to.
    const active = document.activeElement
    if (active && active !== body && body.contains(active)) return
    const frame = requestAnimationFrame(focusMenu)
    return () => cancelAnimationFrame(frame)
  }, [open, sessions, focusMenu])

  // `busy` the state drives the disabled attributes; `busyRef` is the guard.
  // A second click can land before React has re-rendered the trigger disabled
  // — the direct path awaits the session list before it sets any state — and
  // a guard read from the render closure would let both through: two
  // installs, two invocations at the prompt. The ref is written synchronously
  // on the click, so the second one finds it set.
  const busyRef = useRef(false)
  const guarded = async (work: () => Promise<void>): Promise<void> => {
    if (busyRef.current) return
    busyRef.current = true
    setBusy(true)
    try {
      await work()
    } finally {
      busyRef.current = false
      setBusy(false)
    }
  }

  type Outcome = Promise<string | null | void> | string | null | void

  // A returned message stays in the menu, open; anything else closes it.
  const finish = (message: Awaited<Outcome>): void => {
    if (typeof message === 'string' && message) {
      setError(message)
      setOpen(true)
    } else {
      setOpen(false)
    }
  }

  const run = (action: () => Outcome): Promise<void> =>
    guarded(async () => {
      setError(null)
      finish(await action())
    })

  // One live agent is not a question. Where the caller asks for it, the trigger
  // answers it itself and the menu never appears; everywhere else the click
  // opens the menu, synchronously, before anything is listed. A direct use that
  // fails has no open menu to speak in, so `finish` opens it around the message
  // — which is why the open effect above leaves `error` alone.
  const openOrUse = (togglePopover: () => void): Promise<void> =>
    guarded(async () => {
      if (disabled) return
      setError(unavailableReason)
      if (!directWhenSingle || unavailableReason) {
        togglePopover()
        return
      }
      const target = pickTargetSession(await listLiveAgentSessions({ workspaceId }), preferred)
      if (!target) {
        togglePopover()
        return
      }
      finish(await onUse(target))
    })

  const Trigger = emphasis === 'primary' ? PrimaryButton : OutlineButton

  return (
    <Popover
      open={open}
      onOpenChange={setOpen}
      ariaLabel={`Use ${skillName} in an agent`}
      popupRole="menu"
      placement={placement}
      // The kit's list layer on the Popover's own `role="menu"` surface; the
      // rows are `MenuItem`, so arrow keys rove and a divider is the menu's own.
      surfaceClassName={`w-[240px] ${MENU_LIST_CLASS}`}
      onOpenAutoFocus={handleOpenAutoFocus}
      renderTrigger={({ ref, triggerProps, togglePopover }) => (
        <Trigger
          ref={ref}
          size={size}
          disabled={disabled || busy}
          onClick={() => void openOrUse(togglePopover)}
          {...triggerProps}
        >
          {label}
        </Trigger>
      )}
    >
      <div
        ref={menuBodyRef}
        tabIndex={-1}
        className="flex flex-col outline-none"
        onKeyDown={(event) => roveMenuFocus(event, event.currentTarget.closest<HTMLElement>('[role="menu"]'))}
      >
        {error ? (
          <div className="px-2 pb-1">
            <InlineNotice tone="error">{error}</InlineNotice>
          </div>
        ) : null}
        {sessions === null ? (
          <div className="flex items-center gap-2 px-2.5 py-2 text-body text-[color:var(--text-muted)]" role="status">
            <Spinner size={14} />
            Finding running agents…
          </div>
        ) : (
          <>
            {sessions.length === 0 ? (
              <div className="px-2.5 py-1.5 text-meta text-[color:var(--text-muted)]">No running agents</div>
            ) : (
              sessions.map((session) => (
                <MenuItem
                  key={session.sessionId}
                  disabled={busy}
                  onClick={() => void run(() => onUse(session))}
                  trailing={
                    session.cli ? (
                      <span className="shrink-0 text-micro text-[color:var(--text-subtle)]">{session.cli}</span>
                    ) : undefined
                  }
                >
                  {session.label}
                </MenuItem>
              ))
            )}
            {onNewAgent ? (
              <>
                <MenuDivider />
                <MenuItem disabled={busy} onClick={() => void run(() => onNewAgent())}>
                  New agent…
                </MenuItem>
              </>
            ) : null}
          </>
        )}
      </div>
    </Popover>
  )
}
