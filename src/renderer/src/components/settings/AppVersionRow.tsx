import React from 'react'

import type { AppUpdateState } from '../../../../shared/electron-api'
import { formatRelativeMsAgo } from '../../utils/relativeTime'
import { ReleaseNotesIcon } from '../AppIcons'
import SprintEngineFrond from '../brand/SprintEngineFrond'
import { IconButton, PrimaryButton, RefreshIcon, Spinner, Tooltip } from '../ui'

// Settings ▸ General's version row: which SprintEngine Studio this is, and —
// when there is a newer one — that version, what it takes to get it, and how
// far along getting it is (owner ruling 2026-09-25):
//
//   up to date     SprintEngine Studio 0.6.0 · Stable · up to date        ⟳
//   available      … · Stable · 0.7.0 available                    Download
//   downloading    … · Stable · downloading 0.7.0 · 42%  [progress bar]
//   downloaded     … · Stable · 0.7.0 ready to install      Restart to update
//   installing     … · Stable · installing 0.7.0…              Restarting… (busy)
//
// and the two ways it can go wrong: a download that failed says why and offers
// Download again, and a restart main refused goes back to "ready" with the
// reason on the line.
//
// It reads update-service's own state (`update:state-changed`), not a flow of
// its own, so it draws whichever way an update arrives: offered and downloaded
// when asked (the default), or downloaded on its own when "Download updates
// automatically" is on. The actions are the update IPC's own — `updateDownload`
// is the consent to download, `updateQuitAndInstall` the restart that hands
// over to the installer, `updateCheck` — handed in by the panel, so this row
// and the update toast press the same buttons.
//
// One action at a time, the one the current step needs: the update is a line
// (check → download → restart), so only the next step renders.

export type AppVersionRowAction = 'check' | 'download' | 'restart' | 'installing' | 'none'

/** The one action the row offers for this state. */
export function appVersionRowAction(state: AppUpdateState | null): AppVersionRowAction {
  if (state && !state.packaged) return 'none'
  // Restart was pressed: the button stays, busy, until the app hands over.
  if (state?.status === 'installing') return 'installing'
  if (state?.downloaded) return 'restart'
  if (state?.status === 'available') return 'download'
  // A download that failed still has an update to take: offer it again.
  if (state?.status === 'error' && state.updateVersion) return 'download'
  // A download in flight has nothing to press: the bar is the answer.
  if (state?.status === 'downloading') return 'none'
  return 'check'
}

/** The download's progress as a whole percent, or null when none is running. */
export function appUpdateDownloadPercent(state: AppUpdateState | null): number | null {
  if (!state || state.downloaded || state.status !== 'downloading') return null
  return Math.max(0, Math.min(100, Math.round(state.progress?.percent ?? 0)))
}

export function formatUpdateChannel(channel: AppUpdateState['channel'] | undefined): string {
  switch (channel) {
    case 'stable':
      return 'Stable'
    case 'nightly':
      return 'Nightly'
    case 'dev':
      return 'Development'
    default:
      return 'Unknown'
  }
}

// One clause after the channel on the version row: a state, never a sentence.
// Where an update exists the clause names its version, so the row says which
// release Download fetches and Restart installs.
export function formatUpdateStatus(state: AppUpdateState | null, now: number = Date.now()): string {
  if (!state) return 'loading'
  if (!state.packaged) return 'unpackaged build'
  const next = state.updateVersion
  if (state.status === 'installing') return next ? `installing ${next}…` : 'installing…'
  // A refused restart comes back as `downloaded` with the reason.
  if (state.downloaded) return state.errorMessage ?? (next ? `${next} ready to install` : 'ready to install')
  switch (state.status) {
    case 'checking':
      return 'checking…'
    case 'available':
      return next ? `${next} available` : 'update available'
    case 'downloading': {
      const percent = appUpdateDownloadPercent(state) ?? 0
      return next ? `downloading ${next} · ${percent}%` : `downloading · ${percent}%`
    }
    case 'not_available':
      return 'up to date'
    case 'error':
      return state.errorMessage ?? 'check failed'
    default:
      return state.lastCheckedAt
        ? `checked ${formatRelativeMsAgo(Date.parse(state.lastCheckedAt), now) || 'just now'}`
        : 'not checked yet'
  }
}

export function AppVersionRow({
  state,
  pending,
  onCheck,
  onDownload,
  onRestart,
  onOpenReleaseNotes,
}: {
  state: AppUpdateState | null
  /** An update request the row started has not answered yet. */
  pending: boolean
  onCheck: () => void
  onDownload: () => void
  onRestart: () => void
  onOpenReleaseNotes: () => void
}): React.JSX.Element {
  const action = appVersionRowAction(state)
  const percent = appUpdateDownloadPercent(state)
  const next = state?.updateVersion ?? null
  return (
    <>
      {/* No rule under this row: the card below brings its own top border, and
          a hairline immediately above it was two rules saying one boundary. */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2.5">
          <SprintEngineFrond tone="current" className="icon-md shrink-0" />
          <div className="min-w-0">
            <div className="text-body font-medium text-[color:var(--text-strong)]">
              SprintEngine Studio <span className="tabular-nums">{state?.version ?? '…'}</span>
            </div>
            <div
              className={`mt-0.5 text-body tabular-nums ${
                state?.status === 'error' ? 'text-[color:var(--tone-error)]' : 'text-[color:var(--text-muted)]'
              }`}
            >
              {formatUpdateChannel(state?.channel)} · {formatUpdateStatus(state)}
            </div>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          <Tooltip content="Release notes">
            <IconButton aria-label="Release notes" onClick={onOpenReleaseNotes}>
              <ReleaseNotesIcon className="icon-sm" />
            </IconButton>
          </Tooltip>
          {action === 'restart' || action === 'installing' ? (
            <PrimaryButton
              size="md"
              onClick={onRestart}
              busy={pending || action === 'installing'}
              disabled={pending || action === 'installing'}
            >
              {pending || action === 'installing' ? <Spinner className="icon-sm" /> : null}
              {pending || action === 'installing' ? 'Restarting…' : 'Restart to update'}
            </PrimaryButton>
          ) : action === 'download' ? (
            <PrimaryButton
              size="md"
              onClick={onDownload}
              disabled={pending}
              aria-label={next ? `Download SprintEngine Studio ${next}` : 'Download the update'}
            >
              Download
            </PrimaryButton>
          ) : action === 'check' ? (
            <Tooltip content={state?.status === 'error' ? 'Retry check' : 'Check for updates'}>
              <IconButton
                aria-label={state?.status === 'error' ? 'Retry the update check' : 'Check for updates'}
                onClick={onCheck}
                disabled={pending || state?.status === 'checking'}
              >
                {state?.status === 'checking' ? <Spinner className="icon-sm" /> : <RefreshIcon />}
              </IconButton>
            </Tooltip>
          ) : null}
        </div>
      </div>
      {percent !== null ? (
        <div
          role="progressbar"
          aria-label={next ? `Downloading SprintEngine Studio ${next}` : 'Downloading the update'}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={percent}
          className="mt-3 h-1 overflow-hidden rounded-full bg-[color:var(--bg-active)]"
        >
          <div className="h-full rounded-full bg-[color:var(--accent-primary)]" style={{ width: `${percent}%` }} />
        </div>
      ) : null}
    </>
  )
}
