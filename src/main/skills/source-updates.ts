// Update detection for repository sources (backlog/2026-09-05-plugin-sources.md,
// "Update notifications").
//
// One request per source per check: `GET /repos/{owner}/{repo}/commits/{ref}`
// resolves the head, and a head that differs from the commit the source was
// scanned at marks the source as having an update. Nothing is fetched beyond
// that and nothing is copied — applying an update is Sync, which the person
// presses (an installed skill may have been edited in place, and the re-copy
// is blind within a source).
//
// **Over git the cadence is hourly for everyone** (git-transport ruling, owner
// 2026-09-08): a head check is one `git ls-remote`, which the REST limit does
// not count, so there is nothing left for a token to buy. What follows is the
// API fallback, where the token still decides.
//
// **On the API path the cadence depends on the GitHub token** (owner ruling,
// 2026-09-08). Anonymous GitHub allows 60 requests an hour for the
// whole machine, shared with every other read the app makes and with anything
// else on the same IP; a source checked every hour spends 24 of those a day on
// a question whose answer changes far less often, and a person with several
// sources can exhaust the budget on update checks alone and then find a scan or
// an install refused. So without a token each source is checked at most once a
// day, and with one — 5,000 requests an hour — hourly, as before.
//
// The window is per source and lives HERE rather than in the scheduler, so it
// holds for every caller: the hourly poller leg simply finds nothing due 23
// ticks out of 24, and a manual Check now counts against the same window
// instead of being a way around it. A skipped source says when it was last
// checked and why it is waiting, because a button that silently does nothing
// reads as broken.
//
// The result is broadcast to every window as one event per check. The
// renderer turns a check that found new drift into one toast, and the rails
// show the mark until the source is synced.

import type { SkillSourceUpdateCheck, SkillSourceUpdateEntry } from '../../shared/electron-api'
import { sourceHasUpdate, sourceUpdateIntervalMs, sourceUpdateSkipMessage, type SkillSource } from '../../shared/skills'
import { parseSkillRepoRef, resolveSkillRepoCommit, type SkillGithubOptions } from './github-tree'
import type { SkillRepoReader, SkillRepoTransport } from './repo-reader'
import type { SkillSourceStore } from './source-store'

export const SKILL_SOURCES_UPDATED_CHANNEL = 'skills:sources-updated'

export type SourceUpdateCheckerDeps = {
  store: SkillSourceStore
  resolveToken: () => Promise<string>
  github?: SkillGithubOptions
  /**
   * The reader the head check asks, when the service was given one. Over git
   * that is `git ls-remote`, which costs the REST limit nothing (git-transport
   * ruling, owner 2026-09-08); with none the check resolves the head over the
   * API exactly as it always did.
   */
  repoReader?: SkillRepoReader
  /** What that reader speaks. It is the cadence's other half; defaults to 'api'. */
  transport?: SkillRepoTransport
  /** Awaited before each check reads the two above; see `SkillsServiceDeps.refreshTransport`. */
  refreshTransport?: () => Promise<void>
  /** Injected in tests. */
  resolveHead?: (source: SkillSource, token: string) => Promise<string>
  now?: () => Date
}

export type SourceUpdateChecker = {
  /**
   * Resolve the head of every repository source whose cadence window has
   * elapsed, and record it. `newlyChanged` names the sources whose drift this
   * check discovered — the ones worth a toast; `changed` is every source
   * currently behind its head, for the rails; `skipped` names the ones inside
   * their window, with the sentence to show whoever asked for the check.
   */
  check(): Promise<SkillSourceUpdateCheck>
}

export function createSourceUpdateChecker(deps: SourceUpdateCheckerDeps): SourceUpdateChecker {
  const now = deps.now ?? (() => new Date())
  // Read per check, never captured: the integrator hands these in as getters
  // that change once git is probed or installed (`SkillsServiceDeps`).
  const transportNow = (): SkillRepoTransport => deps.transport ?? (deps.repoReader ? 'git' : 'api')
  const resolveHead =
    deps.resolveHead ??
    (async (source: SkillSource, token: string): Promise<string> => {
      const ref = parseSkillRepoRef(source.repo)
      if (!ref) throw new Error(`${source.repo} is not a repository that can be checked.`)
      // The reader's own head resolution when there is one — one round trip
      // either way, but git's is not counted by the API's hourly limit.
      const reader = deps.repoReader
      if (reader) return reader.resolveCommit(`${ref.owner}/${ref.repo}`, ref.ref)
      return resolveSkillRepoCommit(ref, { ...deps.github, token })
    })
  let inFlight: Promise<SkillSourceUpdateCheck> | null = null

  return {
    check() {
      if (inFlight) return inFlight
      inFlight = run().finally(() => {
        inFlight = null
      })
      return inFlight
    },
  }

  async function run(): Promise<SkillSourceUpdateCheck> {
    await deps.refreshTransport?.()
    const transport = transportNow()
    const sources = (await deps.store.listSources()).filter((source) => source.kind === 'github')
    const token = await deps.resolveToken().catch(() => '')
    const hasToken = token.trim() !== ''
    const intervalMs = sourceUpdateIntervalMs(hasToken, transport)
    const startedAt = now()
    const entries: SkillSourceUpdateEntry[] = []
    const newlyChanged: string[] = []
    const failures: { sourceId: string; message: string }[] = []
    const skipped: { sourceId: string; message: string }[] = []
    // Sequential on purpose: N sources are N API calls, and a fan-out is what
    // a rate limit is for.
    for (const source of sources) {
      const ageMs = checkAgeMs(source, startedAt)
      if (ageMs !== null && ageMs < intervalMs) {
        // Not asked. What the last real check recorded stands, so the rails
        // keep whatever mark they had — a source is not "up to date" merely
        // because this run did not look at it.
        skipped.push({ sourceId: source.id, message: sourceUpdateSkipMessage(ageMs, hasToken, transport) })
        entries.push({
          sourceId: source.id,
          name: source.repo || source.name,
          headSha: source.headSha ?? '',
          changed: sourceHasUpdate(source),
          checked: false,
        })
        continue
      }
      let headSha: string
      try {
        headSha = await resolveHead(source, token)
      } catch (error) {
        failures.push({ sourceId: source.id, message: error instanceof Error ? error.message : String(error) })
        continue
      }
      const changed = source.commitSha !== '' && headSha !== source.commitSha
      const knownBefore = source.headSha === headSha
      if (changed && !knownBefore) newlyChanged.push(source.id)
      // Written on every check that ran, not only on a head that moved: the
      // timestamp is what the window above reads, so a source whose head has
      // not budged in a week must still record that it was asked.
      await deps.store.putSource(
        { ...source, headSha, headCheckedAt: now().toISOString() },
        await deps.store.getScan(source.id),
      )
      entries.push({ sourceId: source.id, name: source.repo || source.name, headSha, changed, checked: true })
    }
    return {
      checkedAt: now().toISOString(),
      sources: entries,
      changed: entries.filter((entry) => entry.changed).map((entry) => entry.sourceId),
      newlyChanged,
      failures,
      skipped,
    }
  }
}

/**
 * How long ago this source was checked, or null when it never was — and also
 * when the recorded time is in the future, which a clock change can produce
 * and which must not park a source outside its window forever.
 */
function checkAgeMs(source: SkillSource, at: Date): number | null {
  if (source.headCheckedAt === undefined) return null
  const checkedAt = Date.parse(source.headCheckedAt)
  if (Number.isNaN(checkedAt)) return null
  const age = at.getTime() - checkedAt
  return age < 0 ? null : age
}
