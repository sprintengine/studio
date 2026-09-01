import React, { useMemo } from 'react'
import { FOCUS_RING_CLASS, Popover, TONE_COLOR_VAR, TONE_SOFT_VAR, Tooltip, TruncatedText } from '../ui'
import { MENU_ITEM_CLASS } from '../ui/menuClasses'
import type { SessionUser } from '../../../../shared/electron-api'
import { getRendererHost, onThirdPartyRendererModulesLoaded, selectModuleEnabled } from '../../modules'
import { useWorkspaceStore } from '../../store/workspaceStore'
import { hasPaidEntitlement, planDisplayTier, type PlanDisplayTier } from './accountEntitlements'

// The account + Settings cluster lives at the sidebar bottom (Cursor-parity
// layout), relocated from WorkspaceTopBar. The account menu, its trigger, and
// the Settings gear keep their original handlers — only the mount point moved.
// The settings cluster also hosts the modal-surface trigger glyphs
// (doors→modals, 2026-09-01): Plugins, Automations and Design left the top-nav
// door band and open as modals from here, beside the gear.

function accountInitials(user: SessionUser | null): string {
  const source = user?.displayName?.trim() || user?.email?.trim() || ''
  if (!source) return '?'
  const words = source.split(/\s+/).filter(Boolean)
  if (words.length >= 2) return `${words[0][0]}${words[1][0]}`.toUpperCase()
  return source[0].toUpperCase()
}

// Tier drives the colour of the account glyph: gold for an active Pro plan,
// green otherwise (free, trial, or entitlements not yet resolved). Presentation
// only — what the account may do is `hasPaidEntitlement`.
const ACCOUNT_TIER_STYLE: Record<PlanDisplayTier, { color: string; soft: string; label: string }> = {
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

// One footer icon button, shared by the gear below and every modal-surface
// trigger, so the cluster cannot drift into rival idioms: `control-md` box,
// hover wash, and the open state carried as a bordered press (the same
// treatment the gear has always had). `aria-pressed` tracks the open modal.
function footerIconButtonClass(open: boolean): string {
  return `inline-flex size-control-md items-center justify-center rounded-md border transition-colors ${FOCUS_RING_CLASS} ${
    open
      ? 'border-[color:var(--color-5)] bg-[color:var(--bg-hover)] text-[color:var(--text-strong)]'
      : 'border-transparent text-[color:var(--text-muted)] hover:bg-[color:var(--bg-hover)] hover:text-[color:var(--text-default)]'
  }`
}

// The modal-surface trigger glyphs (doors→modals, 2026-09-01): one icon button
// per registered modal surface, enablement-filtered and order-sorted by the
// host registry, rendered immediately before the gear. Self-contained like a
// sidebar nav entry — it reads the local window's store and acts on it; the
// footer only owns placement. A plain open runs the surface's `onOpen` first
// (the Plugins surface discards a stale deep-link latch there), then opens the
// modal.
function ModalSurfaceTriggers() {
  const moduleOverrides = useWorkspaceStore((s) => s.appSettings.modules)
  const activeModalSurface = useWorkspaceStore((s) => s.activeModalSurface)
  const openModalSurface = useWorkspaceStore((s) => s.openModalSurface)
  // Third-party renderer modules can finish loading after first render (the
  // boot timeout race WorkspaceManager's moduleRegistryGeneration handles):
  // without this bump an SDK module's registerModalSurface would mount fine
  // but its trigger — the only user-visible way in — would stay absent until
  // an unrelated module toggle or a reload.
  const [registryGeneration, setRegistryGeneration] = React.useState(0)
  React.useEffect(
    () => onThirdPartyRendererModulesLoaded(() => setRegistryGeneration((n) => n + 1)),
    [],
  )
  const surfaces = useMemo(
    () => getRendererHost().getModalSurfaces((id) => selectModuleEnabled(moduleOverrides, id)),
    [moduleOverrides, registryGeneration],
  )
  return (
    <>
      {surfaces.map((surface) => {
        const open = activeModalSurface === surface.id
        return (
          <Tooltip key={surface.id} content={surface.label} placement="top">
            <button
              type="button"
              onClick={() => {
                surface.onOpen?.()
                openModalSurface(surface.id)
              }}
              className={footerIconButtonClass(open)}
              aria-label={surface.label}
              aria-pressed={open}
            >
              <surface.Icon className="size-icon-md" />
            </button>
          </Tooltip>
        )
      })}
    </>
  )
}

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
    <button
      type="button"
      role="menuitem"
      data-account-item="true"
      onClick={onSelect}
      onKeyDown={onKeyDown}
      // The shared menu row (MC-2103). It was a `px-3` row at `text-body` with
      // the OUTSET ring, which a full-bleed row's own surface border clips.
      className={`${MENU_ITEM_CLASS} text-[color:var(--text-default)] hover:text-[color:var(--text-strong)]`}
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

  return (
    <div data-account-menu="true" className="w-64 overflow-hidden">
      <div className="px-2.5 pb-2.5 pt-3">
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
        className={footerIconButtonClass(settingsOpen)}
        aria-label="Settings"
        aria-pressed={settingsOpen}
      >
        <GearIcon className="size-icon-md" />
      </button>
    </Tooltip>
  )

  // Icon-only in BOTH sidebar states (owner, 2026-09-01): the footer spends no
  // width on the account name or plan — the tier-coloured initials badge is
  // the whole control, the hover tooltip carries name · plan, and the click
  // popover keeps the full detail. (The badge shows initials; a provider
  // profile photo needs the auth payload to carry one — SessionUser has no
  // photo field today.)
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
      )}
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
      {collapsed ? (
        <>
          <ModalSurfaceTriggers />
          {settingsButton}
        </>
      ) : (
        // With the account control now icon-only, the settings cluster pins to
        // the row's right edge; the account badge holds the left.
        <div className="ml-auto flex items-center gap-1.5">
          <ModalSurfaceTriggers />
          {settingsButton}
        </div>
      )}
    </div>
  )
}
