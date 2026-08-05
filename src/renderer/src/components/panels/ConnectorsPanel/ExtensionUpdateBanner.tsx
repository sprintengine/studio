// The manage canvas's update banner (MC-1873), built to
// backlog/mockups/2026-07-26-extensions-manage-canvas.html § 4: one calm
// accent-soft line above the Capability modules group with the version delta
// and the one Update action. The trust re-check the update path runs
// (updateFromRegistry re-classifies) surfaces here too: a version that now
// needs a trust decision gets the same disclosure prompt the storefront
// install uses — never a silent grant, never a fake success.

import type { ReactNode } from 'react'

import type { CapabilityPermission } from '../../../../../shared/modules/permissions'
import { GhostButton, InlineNotice, OutlineButton, PrimaryButton, Spinner, StatusDot } from '../../ui'
import { TrustPrompt, type PluginTrust } from '../../settings/BrowseStorefront'
import {
  COULDNT_CHECK_COPY,
  manageUpdateBannerCopy,
  type ManageUpdateBanner,
} from './extensionUpdates'

// The in-flight state of the banner's update run. `busy` covers both the
// pre-update verify and the update itself; `needs-trust` pauses the run on the
// re-classification disclosure until the user decides.
export type ModuleUpdateFlow =
  | { status: 'idle' }
  | { status: 'busy'; label: string }
  | {
      status: 'needs-trust'
      tier: PluginTrust['tier']
      permissions: CapabilityPermission[]
      files: string[] | null
    }

export type ModuleUpdateNotice = { tone: 'good' | 'warn' | 'error'; message: string }

export function ModuleUpdateBanner({
  banner,
  flow,
  notice,
  onUpdate,
  onTrustConfirm,
  onCancelTrust,
}: {
  banner: ManageUpdateBanner
  flow: ModuleUpdateFlow
  notice: ModuleUpdateNotice | null
  onUpdate: () => void
  onTrustConfirm: () => void
  onCancelTrust: () => void
}): JSX.Element | null {
  if (banner.kind === 'none' && !notice) return null

  let line: ReactNode = null
  if (banner.kind === 'couldnt-check') {
    line = <div className="text-meta leading-4 text-[color:var(--text-muted)]">{COULDNT_CHECK_COPY}</div>
  } else if (banner.kind === 'updates') {
    // Ruling (MC-2115): this row stays its own accent-soft line rather than
    // becoming `ui/Banner`. The kit's banner is the two-tone notice — a failure
    // or a degraded state, dot-led, with a recovery. "There is a newer version"
    // is neither: it is an offer, and painting it error or warn would say the
    // module is broken. What DID belong to the kit was its control, below.
    const copy = manageUpdateBannerCopy(banner.updates)
    line = (
      <div className="flex items-center gap-2 rounded-md border border-[color:var(--border-subtle)] bg-[color:var(--accent-primary-soft)] px-2.5 py-1.5 text-meta text-[color:var(--text-default)]">
        <svg
          viewBox="0 0 14 14"
          fill="none"
          aria-hidden="true"
          className="h-[13px] w-[13px] shrink-0 text-[color:var(--accent-primary)]"
        >
          <path
            d="M7 11.5v-8M3.5 7 7 3.5 10.5 7"
            stroke="currentColor"
            strokeWidth="1.4"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
        <span className="min-w-0 truncate">
          {copy.strong ? (
            <b className="font-medium text-[color:var(--text-strong)]">{copy.strong}</b>
          ) : null}
          {copy.text}
        </span>
        {flow.status === 'busy' ? (
          <span role="status" className="ml-auto flex shrink-0 items-center gap-1.5 text-[color:var(--text-muted)]">
            <Spinner size={12} />
            {flow.label}
          </span>
        ) : (
          // The kit's button (MC-2115). This was a hand-rolled `<button>` with its
          // own radius, padding and hover — the one control in this banner, and
          // the only one in the manage canvas that was not a kit primitive.
          // Outline, not ghost: it sits on the row's own accent-soft tint, where a
          // borderless control reads as inert.
          <OutlineButton size="xs" onClick={onUpdate} disabled={flow.status !== 'idle'} className="ml-auto shrink-0">
            {copy.actionLabel}
          </OutlineButton>
        )}
      </div>
    )
  }

  return (
    <div className="space-y-2">
      {line}
      {flow.status === 'needs-trust' ? (
        <div className="space-y-2">
          <TrustPrompt
            tier={flow.tier}
            permissions={flow.permissions}
            inlineServers={[]}
            files={flow.files}
          />
          <div className="flex gap-2">
            <PrimaryButton size="sm" onClick={onTrustConfirm}>
              Trust and update
            </PrimaryButton>
            <GhostButton size="sm" onClick={onCancelTrust}>
              Cancel
            </GhostButton>
          </div>
        </div>
      ) : null}
      {notice ? (
        notice.tone === 'good' ? (
          <div className="flex items-center gap-2 text-body text-[color:var(--text-muted)]" role="status">
            <StatusDot tone="good" />
            <span>{notice.message}</span>
          </div>
        ) : (
          <InlineNotice tone={notice.tone}>{notice.message}</InlineNotice>
        )
      ) : null}
    </div>
  )
}
