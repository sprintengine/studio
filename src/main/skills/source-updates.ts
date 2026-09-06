// Update detection for repository sources (backlog/2026-09-05-plugin-sources.md,
// "Update notifications").
//
// One request per source per check: `GET /repos/{owner}/{repo}/commits/{ref}`
// resolves the head, and a head that differs from the commit the source was
// scanned at marks the source as having an update. Nothing is fetched beyond
// that and nothing is copied — a source is one API call an hour, well inside
// the unauthenticated budget, and applying an update is Sync, which the person
// presses (an installed skill may have been edited in place, and the re-copy
// is blind within a source).
//
// The result is broadcast to every window as one event per check. The
// renderer turns a check that found new drift into one toast, and the rails
// show the mark until the source is synced.

import type { SkillSourceUpdateCheck, SkillSourceUpdateEntry } from '../../shared/electron-api'
import type { SkillSource } from '../../shared/skills'
import { parseSkillRepoRef, resolveSkillRepoCommit, type SkillGithubOptions } from './github-tree'
import type { SkillSourceStore } from './source-store'

export const SKILL_SOURCES_UPDATED_CHANNEL = 'skills:sources-updated'

export type SourceUpdateCheckerDeps = {
  store: SkillSourceStore
  resolveToken: () => Promise<string>
  github?: SkillGithubOptions
  /** Injected in tests. */
  resolveHead?: (source: SkillSource, token: string) => Promise<string>
  now?: () => Date
}

export type SourceUpdateChecker = {
  /**
   * Resolve every repository source's head and record it. `newlyChanged`
   * names the sources whose drift this check discovered — the ones worth a
   * toast; `changed` is every source currently behind its head, for the rails.
   */
  check(): Promise<SkillSourceUpdateCheck>
}

export function createSourceUpdateChecker(deps: SourceUpdateCheckerDeps): SourceUpdateChecker {
  const now = deps.now ?? (() => new Date())
  const resolveHead =
    deps.resolveHead
    ?? (async (source: SkillSource, token: string): Promise<string> => {
      const ref = parseSkillRepoRef(source.repo)
      if (!ref) throw new Error(`${source.repo} is not a repository that can be checked.`)
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
    const sources = (await deps.store.listSources()).filter((source) => source.kind === 'github')
    const token = await deps.resolveToken().catch(() => '')
    const entries: SkillSourceUpdateEntry[] = []
    const newlyChanged: string[] = []
    const failures: { sourceId: string; message: string }[] = []
    // Sequential on purpose: N sources are N API calls, and a fan-out is what
    // a rate limit is for.
    for (const source of sources) {
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
      if (source.headSha !== headSha || source.headCheckedAt === undefined) {
        await deps.store.putSource(
          { ...source, headSha, headCheckedAt: now().toISOString() },
          await deps.store.getScan(source.id)
        )
      }
      entries.push({ sourceId: source.id, name: source.repo || source.name, headSha, changed })
    }
    return {
      checkedAt: now().toISOString(),
      sources: entries,
      changed: entries.filter((entry) => entry.changed).map((entry) => entry.sourceId),
      newlyChanged,
      failures,
    }
  }
}
