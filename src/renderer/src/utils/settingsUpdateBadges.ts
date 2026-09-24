// The update badges Settings wears (owner ruling 2026-09-25): an agent CLI with
// a newer release, and a newer SprintEngine Studio, each point the person at the
// place that installs it — and they point there from wherever the person is.
//
//   Settings rail glyph   every outstanding update, CLI and app together
//   Settings ▸ General    the app update
//   Settings ▸ Agents     the CLI updates
//   machine switcher      the CLI updates on that machine
//   a CLI's row           that CLI, beside its Update button
//
// One derivation feeds all five, so the glyph, the nav and the rows can never
// disagree about how many there are. Every one is the kit's count badge, named
// ("2 updates available") so the number is never the only thing a screen reader
// or a person who does not see the accent gets.
//
// An update stops being counted when it is installed (the advisory stops saying
// `behind_latest`; the app state stops offering a version) or when the person
// dismisses it — pressing Dismiss or Later on its toast. A dismissal names one
// version, so the next release badges again. Dismissing clears the badges and
// nothing else: the Update button and the version line stay, because the update
// is still there to take.
//
// Pure: the hook that reads the stores is `useSettingsUpdateBadges`.

import type { AppUpdateState, CliVersionAdvisory, CliVersionAdvisoryMap } from '../../../shared/electron-api'
import { LOCAL_HOST_ID, type ExecutionHostId } from '../../../shared/execution-host'
import type { Tone } from '../components/ui/tokens'

export type SettingsUpdateBadge = {
  count: number
  tone: Tone
  /** The accessible name with the place in it: "Agents: 2 CLI updates available". */
  label: string
  /** What is counted, for a control that already names the place: "2 CLI updates available". */
  detail: string
}

// News, not trouble: the accent, the tone the rail gives plain news.
const UPDATE_TONE: Tone = 'accent'

/** The dismissal key for one CLI's one release. */
export function cliUpdateKey(advisory: Pick<CliVersionAdvisory, 'cli' | 'latestVersion'>): string {
  return `cli:${advisory.cli}@${advisory.latestVersion ?? ''}`
}

/** The dismissal key for one app release. */
export function appUpdateKey(version: string | null): string {
  return `app@${version ?? ''}`
}

/**
 * The CLIs with a newer release the person has not dismissed.
 *
 * Only what the Agents rows would offer Update for: version checks on, the
 * advisory behind with a version to name, and the CLI detected on this machine
 * (a stale advisory for a CLI since removed must not count a row that shows no
 * Update). The advisories are this machine's — main compares the version its
 * own probe found, and there is no per-distribution check — so every one of
 * these is This PC's.
 */
export function outstandingCliUpdates(input: {
  advisories: CliVersionAdvisoryMap
  checkCliVersions: boolean
  installed: (cli: string) => boolean
  dismissed: readonly string[]
}): CliVersionAdvisory[] {
  if (!input.checkCliVersions) return []
  const dismissed = new Set(input.dismissed)
  return Object.values(input.advisories).filter(
    (advisory): advisory is CliVersionAdvisory =>
      advisory !== undefined &&
      advisory.status === 'behind_latest' &&
      Boolean(advisory.latestVersion) &&
      input.installed(advisory.cli) &&
      !dismissed.has(cliUpdateKey(advisory)),
  )
}

// The steps between "there is one" and "it installed". `installing` is the
// step after Restart to update where the update flow has one; naming it here
// keeps the badge on through it rather than dropping it a moment early.
const PENDING_APP_UPDATE_STATUSES: ReadonlySet<string> = new Set([
  'available',
  'downloading',
  'downloaded',
  'installing',
])

/**
 * The app release waiting to be installed, unless it was dismissed. Read off
 * update-service's own state, so it holds whichever way the update arrives —
 * offered and downloaded when asked, or downloaded on its own and ready.
 */
export function outstandingAppUpdate(input: {
  state: AppUpdateState | null
  dismissed: readonly string[]
}): { version: string | null } | null {
  const state = input.state
  if (!state || !state.packaged) return null
  const pending = state.downloaded || PENDING_APP_UPDATE_STATUSES.has(state.status)
  if (!pending) return null
  if (input.dismissed.includes(appUpdateKey(state.updateVersion))) return null
  return { version: state.updateVersion }
}

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`
}

export type SettingsUpdateBadges = {
  rail: SettingsUpdateBadge | null
  general: SettingsUpdateBadge | null
  agents: SettingsUpdateBadge | null
  /** Per machine on the Agents switcher; a machine with none is absent. */
  machines: Readonly<Partial<Record<ExecutionHostId, SettingsUpdateBadge>>>
  /** The CLIs whose rows wear a badge beside Update. */
  clis: ReadonlySet<string>
}

export function settingsUpdateBadges(input: {
  cliUpdates: readonly CliVersionAdvisory[]
  appUpdate: { version: string | null } | null
}): SettingsUpdateBadges {
  const cliCount = input.cliUpdates.length
  const cliDetail = plural(cliCount, 'CLI update available', 'CLI updates available')
  const agents: SettingsUpdateBadge | null =
    cliCount > 0 ? { count: cliCount, tone: UPDATE_TONE, label: `Agents: ${cliDetail}`, detail: cliDetail } : null
  const general: SettingsUpdateBadge | null = input.appUpdate
    ? { count: 1, tone: UPDATE_TONE, label: 'General: update available', detail: 'Update available' }
    : null
  const total = cliCount + (input.appUpdate ? 1 : 0)
  const totalDetail = plural(total, 'update available', 'updates available')
  return {
    rail: total > 0 ? { count: total, tone: UPDATE_TONE, label: totalDetail, detail: totalDetail } : null,
    general,
    agents,
    // Every advisory is this machine's (see `outstandingCliUpdates`), so the
    // switcher badges This PC and never a distribution.
    machines: agents ? { [LOCAL_HOST_ID]: agents } : {},
    clis: new Set(input.cliUpdates.map((advisory) => advisory.cli)),
  }
}
