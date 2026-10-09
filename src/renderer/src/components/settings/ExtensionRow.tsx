import React, { useCallback, useId, useRef, type JSX } from 'react'

import type { ThirdPartyModuleView } from '../../../../shared/modules/manifest'
import { ExtensionIcon } from '../ui/ExtensionIcon'
import {
  AccessCareList,
  AccessChips,
  AccessGlyphs,
  DefinitionList,
  InlineNotice,
  LifecycleGlyph,
  LinkButton,
  OutlineButton,
  OverflowMenu,
  Popover,
  RefreshIcon,
  Switch,
  type AccessItem,
  type OverflowMenuItem,
} from '../ui'
import type { ExtensionContribution } from './extensionContributions'
import { RUN_STATE_LABEL, publisherName, type ExtensionRunState } from './extensionsModel'

// One installed extension, as Settings → Extensions draws it: its mark, its
// name with publisher · source · signature, one warning glyph per scope that
// needs care, its whole summary (it wraps; a one-line summary was the row's
// most-read text cut in half), and at the trailing edge either Review (not
// trusted yet) or its state word and the one switch. The name opens the
// details; so does a click anywhere on the row that is not one of its
// controls. Everything rarer lives in the ⋯ menu and the details.

// ── State word ───────────────────────────────────────────────────────────

/**
 * The state as a word and a shape — never a dot (owner ruling 2026-09-28).
 * Running is the done mark, waiting on a restart is the restart arrow, off is
 * the held ring, a failure is the failed ring in the error ink with its words.
 */
export function ExtensionStateLabel({ state }: { state: ExtensionRunState }): JSX.Element {
  const glyph =
    state === 'running' || state === 'on' ? (
      <LifecycleGlyph state="done" live={false} />
    ) : state === 'pending' || state === 'stopping' ? (
      <RefreshIcon className="icon-sm shrink-0 text-[color:var(--text-muted)]" />
    ) : state === 'failed' ? (
      <LifecycleGlyph state="failed" live={false} />
    ) : (
      <LifecycleGlyph state="blocked" live={false} />
    )
  return (
    <span
      className={[
        'inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap text-meta',
        state === 'failed'
          ? 'text-[color:var(--tone-error)]'
          : state === 'off'
            ? 'text-[color:var(--text-subtle)]'
            : 'text-[color:var(--text-muted)]',
      ].join(' ')}
    >
      {glyph}
      {RUN_STATE_LABEL[state]}
    </span>
  )
}

// ── Details popover ──────────────────────────────────────────────────────

export type ExtensionDetailsProps = {
  module: ThirdPartyModuleView
  titleId: string
  icon: React.ReactNode
  /** The state word, or the untrusted mark. */
  status: React.ReactNode
  adds: ExtensionContribution[] | null
  care: AccessItem[]
  standard: AccessItem[]
  facts: Array<{ term: string; description: React.ReactNode }>
  /** The footer: trust, files, uninstall. */
  actions: React.ReactNode
}

function DetailsHeading({ children }: { children: React.ReactNode }): JSX.Element {
  return <h4 className="mb-1.5 text-meta font-semibold text-[color:var(--text-muted)]">{children}</h4>
}

export function ExtensionDetails({
  module,
  titleId,
  icon,
  status,
  adds,
  care,
  standard,
  facts,
  actions,
}: ExtensionDetailsProps): JSX.Element {
  const { manifest } = module
  return (
    <div className="flex flex-col">
      <div className="flex items-start gap-3 px-4 pb-3 pt-4">
        {icon}
        <div className="min-w-0 flex-1">
          <div id={titleId} className="text-body font-semibold text-[color:var(--text-strong)]">
            {manifest.displayName}
          </div>
          <div className="text-meta text-[color:var(--text-subtle)] [overflow-wrap:anywhere]">
            {[publisherName(manifest), `v${manifest.version}`].filter(Boolean).join(' · ')}
            {' · '}
            <span className="font-mono text-micro">{manifest.id}</span>
          </div>
        </div>
        <div className="shrink-0 pt-0.5">{status}</div>
      </div>
      <div className="space-y-4 px-4 pb-4">
        {manifest.summary ? (
          <p className="text-body leading-5 text-[color:var(--text-muted)]">{manifest.summary}</p>
        ) : null}
        {adds ? (
          <section aria-label="Adds">
            <DetailsHeading>Adds</DetailsHeading>
            <ul className="grid grid-cols-2 gap-1">
              {adds.map((add, index) => (
                <li
                  key={`${add.kind}:${index}`}
                  className="rounded-sm bg-[color:var(--bg-well)] px-2 py-1.5 text-meta text-[color:var(--text-default)]"
                >
                  {add.label}
                </li>
              ))}
            </ul>
          </section>
        ) : null}
        {care.length > 0 || standard.length > 0 ? (
          <section aria-label="Access">
            <DetailsHeading>Access</DetailsHeading>
            <div className="space-y-2.5">
              <AccessCareList items={care} showIds ariaLabel="Needs care" />
              <AccessChips items={standard} ariaLabel={care.length > 0 ? 'Also' : 'Access'} />
            </div>
          </section>
        ) : null}
        <section aria-label="About">
          <DetailsHeading>About</DetailsHeading>
          <DefinitionList items={facts} className="text-meta text-[color:var(--text-default)]" />
        </section>
      </div>
      <div className="flex items-center gap-1.5 px-3 pb-3">{actions}</div>
    </div>
  )
}

// ── Row ──────────────────────────────────────────────────────────────────

export type ExtensionRowProps = {
  module: ThirdPartyModuleView
  /** The mark: the door's own glyph when its code registered one, else the monogram. */
  doorIcon: React.ComponentType<{ className?: string }> | null
  meta: string
  care: AccessItem[]
  /** Trailing controls: Review, or the state word and the switch. */
  trailing: React.ReactNode
  menuItems: OverflowMenuItem[]
  /** A failure or an incompatibility, said under the row. */
  notice?: { text: string; action?: React.ReactNode } | null
  /** The details surface's body, rendered only while open. */
  renderDetails: (args: { titleId: string }) => React.ReactNode
  /** Controlled, so the ⋯ menu's Details opens the same popover the name does. */
  detailsOpen: boolean
  onDetailsOpenChange: (open: boolean) => void
  dimmed?: boolean
}

export function ExtensionMark({
  module,
  doorIcon: DoorIcon,
  size,
}: {
  module: ThirdPartyModuleView
  doorIcon: React.ComponentType<{ className?: string }> | null
  size: number
}): JSX.Element {
  return (
    <ExtensionIcon
      name={module.manifest.displayName}
      size={size}
      {...(DoorIcon ? { mark: <DoorIcon className="text-[color:var(--icon-chip-ink)]" /> } : {})}
    />
  )
}

// What a click on the row should leave to the control it landed on.
const OWN_CONTROL = 'button, a, input, label, [role="switch"], [role="menuitem"]'

export function ExtensionRow({
  module,
  doorIcon,
  meta,
  care,
  trailing,
  menuItems,
  notice,
  renderDetails,
  detailsOpen: open,
  onDetailsOpenChange: setOpen,
  dimmed = false,
}: ExtensionRowProps): JSX.Element {
  const name = module.manifest.displayName
  const titleId = useId()
  // Whether the details were open when this press began. The popover closes
  // itself on any press outside it, so a click on the row body that found it
  // open is a click that closed it, and must not open it again.
  const wasOpen = useRef(false)

  const onRowClick = useCallback(
    (event: React.MouseEvent<HTMLLIElement>) => {
      const control = (event.target as Element).closest(OWN_CONTROL)
      if (control && event.currentTarget.contains(control)) return
      if (wasOpen.current) return
      setOpen(true)
    },
    [setOpen],
  )

  return (
    <li
      onMouseDownCapture={() => {
        wasOpen.current = open
      }}
      onClick={onRowClick}
      className={[
        'grid cursor-pointer grid-cols-[auto_minmax(0,1fr)_auto] gap-x-3 px-4 py-3 transition-colors',
        open ? 'bg-[color:var(--bg-active)]' : 'hover:bg-[color:var(--bg-hover)]',
      ].join(' ')}
    >
      <span className={dimmed ? 'opacity-60' : undefined}>
        <ExtensionMark module={module} doorIcon={doorIcon} size={36} />
      </span>
      <div className="min-w-0">
        <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5">
          <Popover
            open={open}
            onOpenChange={setOpen}
            ariaLabel={`${name} details`}
            popupRole="dialog"
            placement="bottom-start"
            surfaceClassName="w-[380px] max-w-[calc(100vw-16px)]"
            // Into the surface, so Tab walks its actions and a screen reader
            // starts at its name; Escape hands focus back to the name.
            onOpenAutoFocus={(surface) => surface.querySelector<HTMLElement>('[data-details-root]')?.focus()}
            renderTrigger={({ ref, togglePopover, triggerProps }) => (
              <LinkButton
                ref={ref}
                ink="name"
                size="inherit"
                underline="hover"
                {...triggerProps}
                onClick={togglePopover}
                className={`text-body font-semibold ${dimmed ? 'opacity-60' : ''}`}
              >
                {name}
              </LinkButton>
            )}
          >
            <div data-details-root tabIndex={-1} aria-labelledby={titleId} className="outline-none">
              {open ? renderDetails({ titleId }) : null}
            </div>
          </Popover>
          {meta ? <span className="text-meta text-[color:var(--text-subtle)]">{meta}</span> : null}
          <AccessGlyphs items={care} subject={name} />
        </div>
        {module.manifest.summary ? (
          <p className="mt-0.5 text-body leading-5 text-[color:var(--text-muted)]">{module.manifest.summary}</p>
        ) : null}
      </div>
      <div className="flex min-h-9 items-center gap-2.5 self-start">
        {trailing}
        <OverflowMenu ariaLabel={`More for ${name}`} triggerTooltip="More" items={menuItems} />
      </div>
      {notice ? (
        <InlineNotice tone="error" action={notice.action} className="col-span-2 col-start-2 mt-2.5">
          {notice.text}
        </InlineNotice>
      ) : null}
    </li>
  )
}

// ── Trailing controls ────────────────────────────────────────────────────

export function ReviewTrailing({ name, onReview }: { name: string; onReview: () => void }): JSX.Element {
  return (
    <OutlineButton size="xs" aria-label={`Review ${name}`} onClick={onReview}>
      Review
    </OutlineButton>
  )
}

export function InstalledTrailing({
  name,
  state,
  enabled,
  pending,
  onToggle,
}: {
  name: string
  state: ExtensionRunState
  enabled: boolean
  pending: boolean
  onToggle: (next: boolean) => void
}): JSX.Element {
  return (
    <>
      <ExtensionStateLabel state={state} />
      <Switch checked={enabled} disabled={pending} ariaLabel={`Enable ${name}`} onChange={onToggle} />
    </>
  )
}

export function CannotTrustTrailing(): JSX.Element {
  return <span className="whitespace-nowrap text-meta text-[color:var(--tone-error)]">Can’t be trusted</span>
}
