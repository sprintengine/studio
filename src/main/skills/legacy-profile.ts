// Carrying a person's sources across the profile rename.
//
// The package was called `multicode` until 2026-09-08 (commit 5989627a2 renamed
// it to `sprintengine-studio`). Electron derives userData from that name, so
// the rename moved the whole profile: `~/Library/Application Support/multicode`
// stopped being read and `…/sprintengine-studio` started out empty. Nothing was
// deleted and nothing was migrated — from where the person sits, the sources
// they had added were simply gone, which is exactly the report we got.
//
// This carries the sources ACROSS, once, and only the ones a person added:
//
//   - only when the current store has no removable sources of its own, so a
//     profile already in use is never touched;
//   - only ids the current store does not already hold, so nothing is
//     duplicated and no newer record is overwritten;
//   - each carried source brings the scan cached beside it, so the tab lists
//     without a network round trip;
//   - a marker file is written afterwards, so this runs once even if the person
//     then removes everything it brought.
//
// Sources only. The old profile also holds `github-token.json`, the marketplace
// registry cache, module enablement and the rest of the app's state; those are
// orphaned too and are somebody else's ruling, not this file's.

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'

import type { ScanResult, SkillSource } from '../../shared/skills'
import {
  isRemovableSkillSource,
  parseSkillSourceBytes,
  skillSourceLog,
  type PersistedState,
  type SkillSourceLog,
} from './source-store'

/** The profile directory the app wrote before the rename. */
export const LEGACY_PROFILE_DIR_NAME = 'multicode'

const STORE_FILE = 'skill-sources.json'
const MARKER_FILE = 'skill-sources-legacy-adoption.json'

export type LegacyAdoptionPlan = {
  /** The whole list to write: what is there now, plus what is being carried. */
  state: PersistedState
  /** The ids carried over, in the order they were found. */
  carried: string[]
  /** How many of those arrived with a cached scan. */
  scansCarried: number
}

/**
 * What to carry, given both stores. Pure — the fs half is below it — because
 * this is the part with the rules in it.
 *
 * Returns null for "nothing to do", which covers both "the new profile is
 * already in use" and "the old one had nothing a person added".
 */
export function planLegacySourceAdoption(current: PersistedState, legacy: PersistedState): LegacyAdoptionPlan | null {
  // A profile with sources of its own is a profile in use. Merging into it
  // would resurrect sources the person may have removed deliberately since,
  // and this is a rescue, not a sync.
  if (current.sources.some((source) => isRemovableSkillSource(source.id))) return null

  const held = new Set(current.sources.map((source) => source.id))
  const carriedSources: SkillSource[] = []
  const scans: Record<string, ScanResult> = {}
  for (const source of legacy.sources) {
    // The always-present sources are this build's, not the old profile's: their
    // stored copy is only a scan cache, and the current build re-reads it.
    if (!isRemovableSkillSource(source.id)) continue
    if (held.has(source.id)) continue
    held.add(source.id)
    carriedSources.push(source)
    const scan = legacy.scans[source.id]
    if (scan) scans[source.id] = scan
  }
  if (carriedSources.length === 0) return null

  return {
    state: {
      sources: [...current.sources, ...carriedSources],
      // Current last: a scan this profile already holds is the newer read of
      // the two and is never overruled by the old profile's copy.
      scans: { ...scans, ...current.scans },
    },
    carried: carriedSources.map((source) => source.id),
    scansCarried: Object.keys(scans).length,
  }
}

/**
 * Whether this userData directory is the app's OWN profile rather than a
 * parallel dev instance's.
 *
 * The obvious gate would be `app.isPackaged`, and it is the wrong one. The
 * profile that lost its sources is the one a from-source run uses: `scripts/
 * dev.js` only overrides userData for a parallel instance on a non-default
 * renderer port (`SPRINTENGINE_USER_DATA_DIR=…/multicode-dev-<port>`), so an
 * ordinary `npm run dev` writes to `…/sprintengine-studio` — the very directory
 * the rename created empty. Gating on `isPackaged` would skip the machine we
 * are fixing.
 *
 * What must be excluded is a dev-instance profile: a throwaway directory that
 * never held the old sources and whose owner would be surprised to find another
 * profile's repositories in it. Electron derives the default userData as
 * `<appData>/<app.getName()>`, so a basename that still equals the app's name
 * is precisely "no override was applied" — and `multicode-dev-5174` is not.
 */
export function isDefaultProfileDir(userDataDir: string, appName: string): boolean {
  return basename(userDataDir) === appName && appName.length > 0
}

export type LegacyAdoptionOutcome = {
  carried: string[]
  /** Why nothing was carried, when nothing was. */
  reason?: 'already-run' | 'no-legacy-profile' | 'nothing-to-carry' | 'failed'
}

/**
 * The fs half: read both stores, plan, write, mark. Synchronous because it runs
 * in the boot path before any service reads the store, and it is at most two
 * small file reads on the launches that still have anything to do.
 *
 * Never throws. A rescue that failed is a log line, not a boot failure.
 */
export function adoptLegacySkillSources(options: {
  userDataDir: string
  /** Overridden in tests; production reads the sibling `multicode` profile. */
  legacyDir?: string
  log?: SkillSourceLog
}): LegacyAdoptionOutcome {
  const log = options.log ?? skillSourceLog
  const userDataDir = options.userDataDir
  const markerPath = join(userDataDir, MARKER_FILE)
  const legacyDir = options.legacyDir ?? join(dirname(userDataDir), LEGACY_PROFILE_DIR_NAME)
  try {
    if (existsSync(markerPath)) return { carried: [], reason: 'already-run' }
    if (legacyDir === userDataDir) return { carried: [], reason: 'no-legacy-profile' }
    const legacyPath = join(legacyDir, STORE_FILE)
    // No old profile is the common case on every machine installed after the
    // rename. No marker is written for it: there is nothing to be idempotent
    // about, and one `existsSync` a launch is not a cost.
    if (!existsSync(legacyPath)) return { carried: [], reason: 'no-legacy-profile' }

    const current = readCurrentState(join(userDataDir, STORE_FILE), log)
    const legacy = readLegacyState(legacyPath, log)
    const plan = planLegacySourceAdoption(current, legacy)
    if (!plan) {
      writeMarker(markerPath, { adoptedAt: new Date().toISOString(), from: legacyPath, carried: [] })
      return { carried: [], reason: 'nothing-to-carry' }
    }

    writeState(join(userDataDir, STORE_FILE), plan.state)
    writeMarker(markerPath, { adoptedAt: new Date().toISOString(), from: legacyPath, carried: plan.carried })
    log('legacy-profile-adopted', { from: legacyPath, carried: plan.carried, scans: plan.scansCarried })
    return { carried: plan.carried }
  } catch (error) {
    log('legacy-profile-adoption-failed', {
      from: legacyDir,
      message: error instanceof Error ? error.message : String(error),
    })
    return { carried: [], reason: 'failed' }
  }
}

/** The bytes of a store, or null when there is no store. Anything else throws. */
function readStoreBytes(path: string): string | null {
  try {
    return readFileSync(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}

/**
 * The current store, read to be WRITTEN OVER — which is the store's own
 * write-path question, and gets the store's own answer. ENOENT is "no store
 * yet". Any other error, and any bytes that are present but not JSON, abort
 * the rescue: parsing an unreadable store to an empty one and then writing the
 * plan over it would lose every source it holds, which is precisely the drop
 * path the store closed (2026-09-10) and this file must not reopen. No marker
 * is written for a failure, so the rescue simply runs again next launch; the
 * unparsable case clears itself, because the store quarantines those bytes on
 * its next write.
 */
function readCurrentState(path: string, log: SkillSourceLog): PersistedState {
  const raw = readStoreBytes(path)
  if (raw === null) return { sources: [], scans: {} }
  const { state, unparsable } = parseSkillSourceBytes(raw, log)
  if (unparsable && raw.trim().length > 0) {
    throw new Error(`${path} holds bytes that are not a store; left for the store to quarantine`)
  }
  return state
}

/**
 * The old store, read only to be COPIED FROM. Bytes nobody can parse carry
 * nothing, and the marker records that. A file that could not be read at all
 * still aborts rather than marking "nothing to carry" over a store that was
 * never looked at.
 */
function readLegacyState(path: string, log: SkillSourceLog): PersistedState {
  const raw = readStoreBytes(path)
  return raw === null ? { sources: [], scans: {} } : parseSkillSourceBytes(raw, log).state
}

/** The same temp-then-rename the store writes with, so a crash mid-write cannot truncate it. */
function writeState(path: string, state: PersistedState): void {
  mkdirSync(dirname(path), { recursive: true })
  const temp = `${path}.tmp`
  writeFileSync(temp, JSON.stringify(state), { mode: 0o600 })
  renameSync(temp, path)
}

function writeMarker(path: string, detail: { adoptedAt: string; from: string; carried: string[] }): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify(detail), { mode: 0o600 })
}
