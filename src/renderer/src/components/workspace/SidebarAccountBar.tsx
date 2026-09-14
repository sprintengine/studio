import React from 'react'
import { IconButton, MenuItem, OutlineButton, Popover, TONE_COLOR_VAR, TONE_SOFT_VAR, Tooltip, TruncatedText } from '../ui'
import type { MulticodeAuthState } from '../../../../shared/electron-api'
import { AccountAvatar, AccountUserGlyph } from './AccountAvatar'
import { hasPaidEntitlement, planDisplayTier, type PlanDisplayTier } from './accountEntitlements'

// The account + Settings cluster lives at the sidebar bottom, relocated from
// WorkspaceTopBar. The account menu, its trigger, and
// the Settings gear keep their original handlers — only the mount point moved.
//
// TWO controls, and no more. For four days it also hosted a trigger glyph per
// registered modal surface (doors→modals, 2026-09-01): Plugins, Automations and
// Design left the top-nav door band and opened as modals from beside the gear.
// The Extensions drawer ruling (2026-09-05) sent all three back to being doors
// — a destination the shell's own chrome offers routes the card region — so the
// cluster is the account and Settings again, and nothing renders a modal
// trigger anywhere. Settings stays here because it belongs to the WINDOW rather
// than to whichever section the sidebar is showing.

// Tier drives the colour of the account glyph: gold for an active Pro plan,
// green otherwise (free, trial, or entitlements not yet resolved). Presentation
// only — what the account may do is `hasPaidEntitlement`.
const ACCOUNT_TIER_STYLE: Record<PlanDisplayTier, { color: string; soft: string; label: string }> = {
  free: { color: TONE_COLOR_VAR.good, soft: TONE_SOFT_VAR.good, label: 'Free' },
  pro: { color: TONE_COLOR_VAR.warn, soft: TONE_SOFT_VAR.warn, label: 'Pro' },
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

// The footer cluster is `IconButton`, not a local lookalike. The helper that
// used to live here painted a `control-md` (34px) box with `rounded-md` — the
// OVERLAY radius, on a control — and carried its open state as a border plus
// `bg-hover`, where the kit's pressed state is the neutral `bg-selected` fill.
// Three divergences from the primitive it was imitating, on the most-used
// glyphs in the app. Retired 2026-09-02; the cluster now sits on the kit's
// icon ramp (30px) and speaks the kit's one pressed language.
//
// Deliberately NOT elevated. `control-raised` / `control-edge` are for filled
// and bordered buttons; a toolbar of lifted glyphs would read as a row of
// tiles and would spend depth on chrome rather than on the one primary action.

// The modal-surface trigger glyphs that used to sit here beside the gear
// (doors→modals, 2026-09-01) are rows of the sidebar's Extensions section now
// (ExtensionsRail, app shell 2026-09-05): one home for every surface a
// person can open, whether it mounts as a door or as a modal.

function sentenceCase(value: string): string {
  return value ? value[0].toUpperCase() + value.slice(1).replace(/_/g, ' ') : value
}

function formatShortDate(value: string | null): string {
  if (!value) return 'soon'
  return new Date(value).toLocaleString()
}

// The plan's own name, for printing: "Pro plan" while active, else the status
// ("Past due"). Null when there is no plan to name. Presentation only — it
// reads the plan code to SHOW it, and nothing may branch on what it returns.
function planLabel(authState: MulticodeAuthState): string | null {
  const plan = authState.entitlements?.plan
  if (!plan) return null
  return plan.status === 'active' ? `${sentenceCase(plan.code)} plan` : sentenceCase(plan.status)
}

// The account row's secondary line, which always shows something: the plan's
// name when there is one, else the tier word.
function accountPlanLabel(authState: MulticodeAuthState): string {
  return planLabel(authState) ?? ACCOUNT_TIER_STYLE[planDisplayTier(authState)].label
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
    // The kit's menu row. It passes `data-*` through now — this surface's own
    // roving-focus query selects on `data-account-item` — which is the one
    // thing that kept this a raw button element wearing `MENU_ITEM_CLASS`.
    <MenuItem data-account-item="true" onClick={onSelect} onKeyDown={onKeyDown}>
      {children}
    </MenuItem>
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
  const metaLine = [planLabel(authState), authState.selectedOrganization?.name]
    .filter(Boolean)
    .join(' · ')
  const primaryLine = authState.user?.displayName ?? authState.user?.email ?? 'Your account'
  const email = authState.user?.displayName ? authState.user?.email : null
  const accessStale = Boolean(message) || authState.entitlementStatus !== 'fresh'
  // Two independent questions that happen to share a section: whether to offer
  // the upgrade (an access question — does this account already hold paid
  // capability) and whether to offer a re-check (a freshness question).
  const offerUpgrade = !hasPaidEntitlement(authState)
  const tierStyle = ACCOUNT_TIER_STYLE[planDisplayTier(authState)]

  return (
    <div data-account-menu="true" className="w-64 overflow-hidden">
      {/* The header carries the same identity disc as the footer badge, one
          step larger, so the photo (or initials) sits beside the full name. */}
      <div className="flex items-center gap-2.5 px-2.5 pb-2.5 pt-3">
        <AccountAvatar
          user={authState.user}
          className="size-control-sm text-body"
          style={{ borderColor: tierStyle.color, backgroundColor: tierStyle.soft, color: tierStyle.color }}
          glyphClassName="icon-md"
        />
        <div className="min-w-0 flex-1">
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
      </div>

      {message || authState.entitlementStatus === 'offline_grace' ? (
        <div className="border-t border-[color:var(--border-subtle)] px-2.5 py-2 text-body leading-5 text-[color:var(--tone-warn)]">
          {message ?? `Offline access expires ${formatShortDate(authState.graceExpiresAt)}.`}
        </div>
      ) : null}

      {offerUpgrade || accessStale ? (
        <div className="border-t border-[color:var(--border-subtle)] py-1">
          {offerUpgrade ? (
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
  const tierStyle = ACCOUNT_TIER_STYLE[planDisplayTier(authState)]
  const accountName = authState.user?.displayName ?? authState.user?.email ?? 'Your account'

  // The tier-coloured ring stays around the photo: the colour is the plan
  // signal, and the photo replaces only the initials inside it.
  // On the rail (collapsed) the disc steps up with the square it sits in —
  // control-sm inside the rail's control-lg, the same glyph-to-square ratio the
  // section squares keep — so the foot is not a small cluster under big glyphs.
  const avatar = (
    <AccountAvatar
      user={authState.user}
      className={collapsed ? 'size-control-sm text-body' : 'size-control-xs text-meta'}
      style={{ borderColor: tierStyle.color, backgroundColor: tierStyle.soft, color: tierStyle.color }}
      glyphClassName="icon-sm"
    />
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
      <IconButton
        size={collapsed ? 'lg' : 'md'}
        pressed={settingsOpen}
        onClick={() => openSettings(false)}
        aria-label="Settings"
      >
        <GearIcon className={collapsed ? 'size-icon-lg' : 'size-icon-md'} />
      </IconButton>
    </Tooltip>
  )

  // Icon-only in BOTH sidebar states (owner, 2026-09-01): the footer spends no
  // width on the account name or plan — the tier-coloured badge (provider
  // photo when the session carries one, initials otherwise; MC-2220) is the
  // whole control, the hover tooltip carries name · plan, and the click
  // popover keeps the full detail.
  const accountControl = authState.authenticated ? (
    <Popover
      open={accountOpen}
      onOpenChange={setAccountOpen}
      ariaLabel="Account"
      popupRole="menu"
      placement="top-start"
      onOpenAutoFocus={(surface) => {
        surface.querySelector<HTMLButtonElement>('[data-account-item="true"]')?.focus()
      }}
      renderTrigger={({ ref, triggerProps, togglePopover }) => (
        <Tooltip
          content={`${accountName} · ${accountPlanLabel(authState)}`}
          placement={collapsed ? 'right' : 'top'}
        >
          <IconButton
            ref={ref}
            size={collapsed ? 'lg' : 'md'}
            pressed={accountOpen}
            onClick={togglePopover}
            aria-label={`Account · ${tierStyle.label} plan`}
            {...triggerProps}
          >
            {avatar}
          </IconButton>
        </Tooltip>
      )}
    >
      {accountMenu}
    </Popover>
  ) : (
    // Was a hand-rolled copy of OutlineButton — border, surface-raised fill,
    // both hover steps and the whole disabled:hover guard, restated inline.
    // It has to BE the primitive now: the outline variant grew a resting
    // elevation (`control-edge`) on 2026-09-02, and a lookalike is the one
    // button in the footer that would have stayed flat beside it.
    <OutlineButton
      onClick={() => void startLogin()}
      disabled={authState.status === 'checking'}
      // On the rail the icon-only sign-in fills the same control-lg square as
      // the glyphs above it. `min-h` rather than a fourth labelled size: the
      // outline variant's own `h-control-sm` is the height a LABELLED button
      // takes, and the button spec keeps lg for icon-only chrome.
      className={collapsed ? 'size-control-lg min-h-control-lg p-0' : 'min-w-0 flex-1'}
      aria-busy={authState.status === 'checking'}
      aria-label="Sign in"
    >
      {collapsed ? <AccountUserGlyph className="icon-md" /> : 'Sign in'}
    </OutlineButton>
  )

  return (
    // `app-no-drag` on the cluster, not on each button: the cluster mounts at the
    // foot of the app rail (app shell, 2026-09-05), and the rail is an
    // `app-drag` region the way the title strip is. A drag region swallows the
    // pointer before React sees it, so from the day the cluster moved there the
    // account badge and the gear painted but did not click. Every control in
    // this footer opts out here in one place, the popover trigger included.
    //
    // No rule above the cluster (owner, 2026-09-07): the rail is one column of
    // squares from its first glyph to its foot, and a hairline cutting the
    // account off from the sections above it boxed a strip that the space
    // already separates (principles, "Hairlines carry the structure").
    <div
      className={`app-no-drag shrink-0 ${
        collapsed ? 'flex flex-col items-center gap-1.5 px-2 py-2' : 'flex items-center gap-1.5 px-2 py-1.5'
      }`}
    >
      {accountControl}
      {collapsed ? (
        settingsButton
      ) : (
        // With the account control now icon-only, the settings gear pins to
        // the row's right edge; the account badge holds the left.
        <div className="ml-auto flex items-center gap-1.5">{settingsButton}</div>
      )}
    </div>
  )
}
