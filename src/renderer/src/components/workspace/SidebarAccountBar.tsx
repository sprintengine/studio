import React from 'react'
import { FOCUS_RING_CLASS, Popover, TONE_COLOR_VAR, TONE_SOFT_VAR, Tooltip, TruncatedText } from '../ui'
import type { SessionUser } from '../../../../shared/electron-api'
import { hasActiveProPlan } from './workspaceManagerHelpers'

// The account + Settings cluster lives at the sidebar bottom (Cursor-parity
// layout), relocated from WorkspaceTopBar. The account menu, its trigger, and
// the Settings gear keep their original handlers — only the mount point moved.

function accountInitials(user: SessionUser | null): string {
  const source = user?.displayName?.trim() || user?.email?.trim() || ''
  if (!source) return '?'
  const words = source.split(/\s+/).filter(Boolean)
  if (words.length >= 2) return `${words[0][0]}${words[1][0]}`.toUpperCase()
  return source[0].toUpperCase()
}

type AccountTier = 'free' | 'pro'

// Tier drives the colour of the account glyph: gold for an active Pro plan,
// green otherwise (free, trial, or entitlements not yet resolved).
function accountTier(authState: MulticodeAuthState): AccountTier {
  return hasActiveProPlan(authState) ? 'pro' : 'free'
}

const ACCOUNT_TIER_STYLE: Record<AccountTier, { color: string; soft: string; label: string }> = {
  free: { color: TONE_COLOR_VAR.good, soft: TONE_SOFT_VAR.good, label: 'Free' },
  pro: { color: TONE_COLOR_VAR.warn, soft: TONE_SOFT_VAR.warn, label: 'Pro' },
}

// Neutral person glyph shown when no display name/email initials are available,
// so a signed-in account still reads as a coloured tier badge rather than a "?".
function AccountUserGlyph({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <circle cx="12" cy="8.4" r="3.5" stroke="currentColor" strokeWidth={1.7} />
      <path
        d="M5.6 19c0-3.3 2.9-5.4 6.4-5.4s6.4 2.1 6.4 5.4"
        stroke="currentColor"
        strokeWidth={1.7}
        strokeLinecap="round"
      />
    </svg>
  )
}

// Symmetric 8-lobe cog (lucide "settings" geometry), centered in the viewBox so
// it reads balanced at small sizes. Replaces an earlier hand-rolled gear whose
// teeth were unevenly spaced.
function GearIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <circle cx="12" cy="12" r="3" stroke="currentColor" strokeWidth="1.6" />
    </svg>
  )
}

function sentenceCase(value: string): string {
  return value ? value[0].toUpperCase() + value.slice(1).replace(/_/g, ' ') : value
}

function formatShortDate(value: string | null): string {
  if (!value) return 'soon'
  return new Date(value).toLocaleString()
}

// Human plan label for the account row's secondary line ("Pro plan" / "Free").
function accountPlanLabel(authState: MulticodeAuthState): string {
  const plan = authState.entitlements?.plan ?? null
  if (plan) {
    return plan.status === 'active' ? `${sentenceCase(plan.code)} plan` : sentenceCase(plan.status)
  }
  return ACCOUNT_TIER_STYLE[accountTier(authState)].label
}

function AccountMenuItem({ onSelect, children }: { onSelect: () => void; children: React.ReactNode }) {
  const onKeyDown = (event: React.KeyboardEvent<HTMLButtonElement>) => {
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return
    event.preventDefault()
    const surface = event.currentTarget.closest('[data-account-menu="true"]')
    if (!surface) return
    const items = Array.from(surface.querySelectorAll<HTMLButtonElement>('[data-account-item="true"]'))
    if (items.length === 0) return
    const idx = items.indexOf(event.currentTarget)
    const next = event.key === 'Home'
      ? items[0]
      : event.key === 'End'
        ? items[items.length - 1]
        : items[(idx + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length]
    next?.focus()
  }
  return (
    <button
      type="button"
      role="menuitem"
      data-account-item="true"
      onClick={onSelect}
      onKeyDown={onKeyDown}
      className={`flex w-full items-center px-3 py-1.5 text-left text-body text-[color:var(--text-default)] transition-colors hover:bg-[color:var(--bg-hover)] hover:text-[color:var(--text-strong)] ${FOCUS_RING_CLASS}`}
    >
      {children}
    </button>
  )
}

function AccountPopover({
  authState,
  message,
  onCheckAccess,
  onLogout,
  onUpgrade,
}: {
  authState: MulticodeAuthState
  message: string | null
  onCheckAccess: () => void
  onLogout: () => void
  onUpgrade: () => void
}) {
  const plan = authState.entitlements?.plan ?? null
  const planLabel = plan
    ? plan.status === 'active' ? `${sentenceCase(plan.code)} plan` : sentenceCase(plan.status)
    : null
  const metaLine = [planLabel, authState.selectedOrganization?.name]
    .filter(Boolean)
    .join(' · ')
  const primaryLine = authState.user?.displayName ?? authState.user?.email ?? 'Your account'
  const email = authState.user?.displayName ? authState.user?.email : null
  const accessStale = Boolean(message) || authState.entitlementStatus !== 'fresh'

  return (
    <div data-account-menu="true" className="w-64 overflow-hidden">
      <div className="px-3 pb-2.5 pt-3">
        <TruncatedText
          as="div"
          text={primaryLine}
          className="text-heading font-medium text-[color:var(--text-strong)]"
        />
        {email ? (
          <TruncatedText
            as="div"
            text={email}
            className="mt-0.5 text-body text-[color:var(--text-muted)]"
          />
        ) : null}
        {metaLine ? (
          <TruncatedText
            as="div"
            text={metaLine}
            className="mt-1 text-meta text-[color:var(--text-subtle)]"
          />
        ) : null}
      </div>

      {message || authState.entitlementStatus === 'offline_grace' ? (
        <div className="border-t border-[color:var(--border-subtle)] px-3 py-2 text-body leading-5 text-[color:var(--tone-warn)]">
          {message ?? `Offline access expires ${formatShortDate(authState.graceExpiresAt)}.`}
        </div>
      ) : null}

      {!hasActiveProPlan(authState) || accessStale ? (
        <div className="border-t border-[color:var(--border-subtle)] py-1">
          {!hasActiveProPlan(authState) ? (
            <AccountMenuItem onSelect={onUpgrade}>Upgrade to Pro</AccountMenuItem>
          ) : null}
          {accessStale ? (
            <AccountMenuItem onSelect={onCheckAccess}>Check access again</AccountMenuItem>
          ) : null}
        </div>
      ) : null}
      <div className="border-t border-[color:var(--border-subtle)] py-1">
        <AccountMenuItem onSelect={onLogout}>Sign out</AccountMenuItem>
      </div>
    </div>
  )
}

export type SidebarAccountBarProps = {
  collapsed: boolean
  authState: MulticodeAuthState
  authMessage: string | null
  accountOpen: boolean
  setAccountOpen: React.Dispatch<React.SetStateAction<boolean>>
  startLogin: () => void | Promise<void>
  refreshAuthState: () => void | Promise<void>
  logout: () => void | Promise<void>
  openSettings: (checkForUpdates?: boolean, targetTab?: string | null) => void
  settingsOpen: boolean
}

// Sidebar-bottom account + Settings row. Expanded: a tier-coloured avatar with
// name + plan opens the account menu, and the Settings gear sits to its right.
// Collapsed: the avatar and gear stack as centred icons in the rail.
export default function SidebarAccountBar({
  collapsed,
  authState,
  authMessage,
  accountOpen,
  setAccountOpen,
  startLogin,
  refreshAuthState,
  logout,
  openSettings,
  settingsOpen,
}: SidebarAccountBarProps) {
  const tier = accountTier(authState)
  const tierStyle = ACCOUNT_TIER_STYLE[tier]
  const initials = accountInitials(authState.user)
  const accountName = authState.user?.displayName ?? authState.user?.email ?? 'Your account'

  const avatar = (
    <span
      aria-hidden="true"
      className="flex size-control-xs shrink-0 items-center justify-center rounded-full border text-meta font-semibold"
      style={{ borderColor: tierStyle.color, backgroundColor: tierStyle.soft, color: tierStyle.color }}
    >
      {initials === '?' ? <AccountUserGlyph className="icon-sm" /> : initials}
    </span>
  )

  const accountMenu = (
    <AccountPopover
      authState={authState}
      message={authMessage}
      onCheckAccess={() => void refreshAuthState()}
      onLogout={() => void logout()}
      onUpgrade={() => {
        setAccountOpen(false)
        void window.api.authOpenUpgrade('sprintengine')
      }}
    />
  )

  const settingsButton = (
    <Tooltip content="Settings" placement="top">
      <button
        type="button"
        onClick={() => openSettings(false)}
        className={`inline-flex size-control-md items-center justify-center rounded-md border transition-colors ${FOCUS_RING_CLASS} ${
          settingsOpen
            ? 'border-[color:var(--color-5)] bg-[color:var(--bg-hover)] text-[color:var(--text-strong)]'
            : 'border-transparent text-[color:var(--text-muted)] hover:bg-[color:var(--bg-hover)] hover:text-[color:var(--text-default)]'
        }`}
        aria-label="Settings"
        aria-pressed={settingsOpen}
      >
        <GearIcon className="size-icon-md" />
      </button>
    </Tooltip>
  )

  const accountControl = authState.authenticated ? (
    <Popover
      open={accountOpen}
      onOpenChange={setAccountOpen}
      ariaLabel="Account"
      popupRole="menu"
      placement="top-start"
      // The popover's trigger wrapper is inline-flex and shrink-wraps, which
      // would park the Settings gear right beside the account text instead of
      // at the row's right edge — grow it so the account trigger fills the row.
      className={collapsed ? undefined : 'min-w-0 flex-1'}
      onOpenAutoFocus={(surface) => {
        surface.querySelector<HTMLButtonElement>('[data-account-item="true"]')?.focus()
      }}
      renderTrigger={({ ref, triggerProps, togglePopover }) =>
        collapsed ? (
          <Tooltip content={`Account · ${accountName}`} placement="right">
            <button
              ref={ref}
              type="button"
              onClick={togglePopover}
              className={`flex size-control-md items-center justify-center rounded-md border transition-colors ${FOCUS_RING_CLASS} ${
                accountOpen ? 'border-[color:var(--color-5)] bg-[color:var(--bg-hover)]' : 'border-transparent hover:bg-[color:var(--bg-hover)]'
              }`}
              aria-label={`Account · ${tierStyle.label} plan`}
              {...triggerProps}
            >
              {avatar}
            </button>
          </Tooltip>
        ) : (
          <button
            ref={ref}
            type="button"
            onClick={togglePopover}
            className={`flex h-control-md min-w-0 flex-1 items-center gap-2 rounded-md border px-1.5 text-left transition-colors ${FOCUS_RING_CLASS} ${
              accountOpen
                ? 'border-[color:var(--color-5)] bg-[color:var(--bg-hover)]'
                : 'border-transparent hover:bg-[color:var(--bg-hover)]'
            }`}
            aria-label={`Account · ${tierStyle.label} plan`}
            {...triggerProps}
          >
            {avatar}
            <span className="min-w-0 flex-1">
              <TruncatedText
                as="span"
                text={accountName}
                className="block text-body font-medium text-[color:var(--text-strong)]"
              />
              <span className="block truncate text-meta text-[color:var(--text-subtle)]">
                {accountPlanLabel(authState)}
              </span>
            </span>
          </button>
        )
      }
    >
      {accountMenu}
    </Popover>
  ) : (
    <button
      type="button"
      onClick={() => void startLogin()}
      disabled={authState.status === 'checking'}
      className={`inline-flex h-control-md items-center rounded-md border border-[color:var(--bg-selected)] bg-[color:var(--bg-surface-raised)] text-body font-semibold text-[color:var(--text-default)] transition-colors hover:border-[color:var(--color-5)] hover:bg-[color:var(--bg-hover)] hover:text-[color:var(--text-strong)] disabled:cursor-default disabled:opacity-60 ${FOCUS_RING_CLASS} ${
        collapsed ? 'w-8 justify-center' : 'min-w-0 flex-1 justify-center px-3'
      }`}
      aria-busy={authState.status === 'checking'}
      aria-label="Sign in"
    >
      {collapsed ? <AccountUserGlyph className="icon-sm" /> : 'Sign in'}
    </button>
  )

  return (
    <div
      className={`shrink-0 border-t border-[color:var(--border-subtle)] ${
        collapsed ? 'flex flex-col items-center gap-1.5 px-1.5 py-1.5' : 'flex items-center gap-1.5 px-2 py-1.5'
      }`}
    >
      {accountControl}
      {settingsButton}
    </div>
  )
}
