import React, { useCallback, useEffect, useRef, useState } from 'react'
import { IconButton, PointerPopover, StatusDot, Tooltip, type Tone } from '../ui'
import CliIcon from '../CliIcon'
import { GitBranchGlyph } from './WorkspaceActions'
import { formatRelativeMsAgo } from '../../utils/relativeTime'
import type { AgentCli } from '../../types/workspace'

// Identity shown for an agent terminal tab. Assembled by the caller from the
// agent record + runtime state so this component stays presentational.
export type AgentTabIdentity = {
  name: string
  /** e.g. "No role", "Design specialist", "Nuclear reviewer · sprint". */
  roleLabel: string
  /** The launch model id (e.g. `claude-opus-4-8`); null → the CLI's own default. */
  model: string | null
  /** Runtime/CLI id used for the brand glyph; null when unknown. */
  cli: AgentCli | null
  /** Friendly runtime label (e.g. "Claude Code"); null when unknown. */
  cliLabel: string | null
  /** CLI session id; null when the agent has never started a session. */
  sessionId: string | null
  /** Sprint task id the agent is claimed on, when applicable. */
  taskId: string | null
  /**
   * Where the agent runs (MC-2440). `observed: true` comes from the session's
   * own lifecycle hooks, resolved through git — a worktree the agent created
   * mid-run, the primary checkout it went back to, or a folder outside any
   * repository. `observed: false` is the app's launch intent, shown until the
   * first hook frame answers. Null means launch intent says the main checkout
   * and nothing has been observed yet.
   */
  checkout: AgentTabCheckout | null
  status: { tone: Tone; pulse: boolean; label: string }
  /**
   * The last message sent to this agent, when one was captured. It belongs on
   * this card rather than in a peek popover of its own: an agent tab that
   * opened two hover surfaces at once put one over the other, and the answer to
   * "what is this tab" and "what was it asked" is one answer.
   */
  lastMessage: { text: string; at: number } | null
}

export type AgentTabCheckout =
  | { kind: 'worktree'; branch: string | null; cwd: string | null; observed: boolean }
  | { kind: 'main'; branch: string | null; cwd: string | null; observed: true }
  | { kind: 'folder'; cwd: string; observed: true }
  // The observed directory no longer exists (a worktree pruned under the agent).
  | { kind: 'missing'; cwd: string; observed: true }
  // A cwd was observed but git could not answer for it on this host (no git,
  // a WSL-internal path on a Windows main): say where, claim nothing more.
  | { kind: 'unverified'; cwd: string; observed: true }

// Hover opens after a beat so a quick sweep across the tab strip never flickers
// cards open; focus opens immediately so keyboard users don't wait. The close
// grace period lets the pointer travel from the tab into the card without it
// vanishing — that's what makes the copy button reachable, unlike a tooltip.
const OPEN_DELAY_MS = 260
const CLOSE_GRACE_MS = 140
const ANCHOR_GAP = 6

type ClipboardApi = { clipboardWriteText?: (text: string) => Promise<void> }

async function copyText(text: string): Promise<void> {
  const api = window.api as typeof window.api & ClipboardApi
  if (typeof api.clipboardWriteText !== 'function') throw new Error('Clipboard unavailable')
  await api.clipboardWriteText(text)
}

const CopyGlyph = ({ done }: { done: boolean }) =>
  done ? (
    <svg viewBox="0 0 24 24" className="icon-xs" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M4 12.5 9 17.5 20 6.5" />
    </svg>
  ) : (
    <svg viewBox="0 0 24 24" className="icon-xs" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="9" y="9" width="11" height="11" rx="2" />
      <path d="M5 15V5a2 2 0 0 1 2-2h8" />
    </svg>
  )

// The branch-node worktree mark, matching the tab's leading worktree glyph —
// the shared GitBranchGlyph fork, not a local drawing.
const BranchGlyph = () => (
  <GitBranchGlyph className="icon-xs shrink-0 text-[color:var(--text-muted)]" />
)

// The Checkout row. A worktree names its branch behind the branch glyph (the
// same mark the tab carries); the primary checkout says so plainly and adds
// its branch once the hooks have reported one; a folder outside any repository
// says that rather than pretending to be a checkout; a removed directory and
// an unverifiable cwd each say exactly that. The full path rides the hover
// title in every case it is known.
function CheckoutValue({ checkout }: { checkout: AgentTabCheckout | null }) {
  if (!checkout) return <>Main checkout</>
  if (checkout.kind === 'worktree') {
    return (
      <span className="inline-flex max-w-full items-center gap-1.5" title={checkout.cwd ?? undefined}>
        <BranchGlyph />
        <span className="truncate font-mono">{checkout.branch ?? 'worktree'}</span>
      </span>
    )
  }
  if (checkout.kind === 'folder' || checkout.kind === 'unverified') {
    return (
      <span className="inline-flex max-w-full items-center gap-1.5" title={checkout.cwd}>
        <span>{checkout.kind === 'folder' ? 'Folder' : 'Unverified'}</span>
        <span className="truncate font-mono text-[color:var(--text-muted)]">{checkout.cwd}</span>
      </span>
    )
  }
  if (checkout.kind === 'missing') {
    return (
      <span className="inline-flex max-w-full items-center gap-1.5" title={`Removed — ${checkout.cwd}`}>
        <span className="text-[color:var(--tone-error)]">Removed</span>
        <span className="truncate font-mono text-[color:var(--text-muted)]">{checkout.cwd}</span>
      </span>
    )
  }
  return (
    <span className="inline-flex max-w-full items-center gap-1.5" title={checkout.cwd ?? undefined}>
      <span>Main checkout</span>
      {checkout.branch ? (
        <span className="truncate font-mono text-[color:var(--text-muted)]">{checkout.branch}</span>
      ) : null}
    </span>
  )
}

function IdentityRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <>
      <dt className="text-micro text-[color:var(--text-subtle)]">{label}</dt>
      <dd className="min-w-0 text-meta text-[color:var(--text-strong)]">{children}</dd>
    </>
  )
}

/**
 * Presentational identity card — the surface content, with no portal or hover
 * mechanics, so it renders standalone (and is server-renderable for tests). The
 * copy button's state is lifted so the popover owns the "copied" flash.
 */
export function AgentTabIdentityCard({
  identity,
  copied,
  onCopy,
}: {
  identity: AgentTabIdentity
  copied: boolean
  onCopy: () => void
}) {
  return (
    <>
      <div className="flex items-center gap-2 border-b border-[color:var(--border-subtle)] px-3 py-2.5">
        {identity.cli ? (
          <CliIcon cli={identity.cli} className="icon-sm shrink-0 text-[color:var(--text-strong)]" />
        ) : null}
        <span className="min-w-0 flex-1 truncate text-body font-semibold text-[color:var(--text-strong)]">
          {identity.name}
        </span>
        <span className="flex shrink-0 items-center gap-1.5 text-micro text-[color:var(--text-muted)]">
          <StatusDot tone={identity.status.tone} pulse={identity.status.pulse} />
          {identity.status.label}
        </span>
      </div>
      <dl className="grid grid-cols-[58px_1fr] items-baseline gap-x-2.5 gap-y-1.5 px-3 py-2.5">
        <IdentityRow label="Role">{identity.roleLabel}</IdentityRow>
        <IdentityRow label="Model">
          {identity.model ? (
            <span className="font-mono tabular-nums">{identity.model}</span>
          ) : (
            <span className="text-[color:var(--text-muted)]">CLI default</span>
          )}
        </IdentityRow>
        {identity.cliLabel ? (
          <IdentityRow label="Runtime">
            <span className="inline-flex items-center gap-1.5">
              {identity.cli ? <CliIcon cli={identity.cli} className="icon-xs" /> : null}
              {identity.cliLabel}
            </span>
          </IdentityRow>
        ) : null}
        <IdentityRow label="Checkout">
          <CheckoutValue checkout={identity.checkout} />
        </IdentityRow>
        {identity.taskId ? (
          <IdentityRow label="Task">
            <span className="font-mono tabular-nums">{identity.taskId}</span>
          </IdentityRow>
        ) : null}
        {identity.sessionId ? (
          <IdentityRow label="Session">
            <span className="inline-flex max-w-full items-center gap-1.5">
              <span className="truncate font-mono tabular-nums">{identity.sessionId}</span>
              <IconButton
                size="sm"
                aria-label={copied ? 'Session ID copied' : 'Copy session ID'}
                onClick={onCopy}
                className="shrink-0"
              >
                <CopyGlyph done={copied} />
              </IconButton>
            </span>
          </IdentityRow>
        ) : null}
        {identity.lastMessage ? (
          <IdentityRow label="Last message">
            {/* Clamped to two lines here, with the whole message in a tooltip on
                the text itself: a prompt runs to any length, and a card that
                grew with it would cover the work it describes. */}
            <Tooltip
              content={identity.lastMessage.text}
              placement="bottom"
              multiline
              wrapperClassName="block min-w-0"
            >
              <span className="block min-w-0">
                <span className="line-clamp-2 whitespace-pre-wrap break-words leading-snug">
                  {identity.lastMessage.text}
                </span>
                <span className="mt-0.5 block text-micro text-[color:var(--text-subtle)]">
                  {formatRelativeMsAgo(identity.lastMessage.at, Date.now())}
                </span>
              </span>
            </Tooltip>
          </IdentityRow>
        ) : null}
      </dl>
    </>
  )
}

/**
 * Hover/focus info card for an agent terminal tab — the interactive,
 * stay-open-when-entered analog of `Tooltip` (which is `pointer-events-none`).
 * It wraps the tab's content composition, resolves the enclosing FlexLayout tab
 * button as the hover/focus anchor so the *whole* tab is the trigger, and
 * renders the card through the shared `PointerPopover` shell (portal, clamp,
 * elevation, Escape + outside-dismiss). Only the hover-intent open/close timing
 * lives here.
 */
export function AgentTabIdentityPopover({
  identity,
  children,
}: {
  identity: AgentTabIdentity
  children: React.ReactNode
}) {
  const anchorRef = useRef<HTMLSpanElement>(null)
  const tabButtonRef = useRef<HTMLElement | null>(null)
  const openTimer = useRef<number | null>(null)
  const closeTimer = useRef<number | null>(null)
  const copiedTimer = useRef<number | null>(null)

  const [open, setOpen] = useState(false)
  const [point, setPoint] = useState<{ x: number; y: number }>({ x: 0, y: 0 })
  const [copied, setCopied] = useState(false)

  const clearOpenTimer = useCallback(() => {
    if (openTimer.current !== null) {
      window.clearTimeout(openTimer.current)
      openTimer.current = null
    }
  }, [])
  const clearCloseTimer = useCallback(() => {
    if (closeTimer.current !== null) {
      window.clearTimeout(closeTimer.current)
      closeTimer.current = null
    }
  }, [])

  // Anchor the card to the tab button's bottom-left, computed at reveal so the
  // shell never flashes at 0,0 before positioning.
  const reveal = useCallback(() => {
    const rect = tabButtonRef.current?.getBoundingClientRect()
    if (rect) setPoint({ x: rect.left, y: rect.bottom + ANCHOR_GAP })
    setOpen(true)
  }, [])

  const openNow = useCallback(() => {
    clearOpenTimer()
    clearCloseTimer()
    reveal()
  }, [clearOpenTimer, clearCloseTimer, reveal])

  const openSoon = useCallback(() => {
    clearCloseTimer()
    if (openTimer.current !== null) return
    openTimer.current = window.setTimeout(() => {
      openTimer.current = null
      reveal()
    }, OPEN_DELAY_MS)
  }, [clearCloseTimer, reveal])

  const closeSoon = useCallback(() => {
    clearOpenTimer()
    if (closeTimer.current !== null) return
    closeTimer.current = window.setTimeout(() => {
      closeTimer.current = null
      setOpen(false)
    }, CLOSE_GRACE_MS)
  }, [clearOpenTimer])

  const closeNow = useCallback(() => {
    clearOpenTimer()
    clearCloseTimer()
    setOpen(false)
  }, [clearOpenTimer, clearCloseTimer])

  // Resolve the enclosing tab button once and wire hover/focus to it, so the
  // whole tab is the trigger (not just the label span) and FlexLayout's own
  // keyboard focus opens the card too.
  useEffect(() => {
    const el = anchorRef.current
    if (!el) return
    const button = el.closest<HTMLElement>('.flexlayout__tab_button') ?? el
    tabButtonRef.current = button

    const onEnter = () => openSoon()
    const onLeave = () => closeSoon()
    const onFocusIn = () => openNow()
    const onFocusOut = (event: FocusEvent) => {
      const next = event.relatedTarget as Node | null
      if (next && button.contains(next)) return
      closeSoon()
    }
    button.addEventListener('mouseenter', onEnter)
    button.addEventListener('mouseleave', onLeave)
    button.addEventListener('focusin', onFocusIn)
    button.addEventListener('focusout', onFocusOut)
    return () => {
      button.removeEventListener('mouseenter', onEnter)
      button.removeEventListener('mouseleave', onLeave)
      button.removeEventListener('focusin', onFocusIn)
      button.removeEventListener('focusout', onFocusOut)
    }
  }, [openSoon, closeSoon, openNow])

  useEffect(
    () => () => {
      clearOpenTimer()
      clearCloseTimer()
      if (copiedTimer.current !== null) window.clearTimeout(copiedTimer.current)
    },
    [clearOpenTimer, clearCloseTimer],
  )

  const handleCopy = useCallback(async () => {
    if (!identity.sessionId) return
    try {
      await copyText(identity.sessionId)
      setCopied(true)
      if (copiedTimer.current !== null) window.clearTimeout(copiedTimer.current)
      copiedTimer.current = window.setTimeout(() => setCopied(false), 1200)
    } catch {
      // Clipboard denied — the id stays on screen and selectable. No silent success.
    }
  }, [identity.sessionId])

  return (
    <span ref={anchorRef} className="inline-flex min-w-0 items-center gap-1.5">
      {children}
      {open ? (
        <PointerPopover
          x={point.x}
          y={point.y}
          ariaLabel={`${identity.name} details`}
          popupRole="dialog"
          onClose={closeNow}
          surfaceClassName="w-[264px]"
        >
          {/* Keep the card open while the pointer rests on it, so the session-id
              copy button is reachable across the gap from the tab. */}
          <div onMouseEnter={clearCloseTimer} onMouseLeave={closeSoon}>
            <AgentTabIdentityCard identity={identity} copied={copied} onCopy={handleCopy} />
          </div>
        </PointerPopover>
      ) : null}
    </span>
  )
}
