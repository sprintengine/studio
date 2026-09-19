// The hosted sources feed: `sources.json` at the root of the public
// sprintengine/studio-releases repo, edited there by pull request and fetched
// raw by every running studio.
//
// It is the replacement for shipping other people's software (MC-2519, owner
// ruling 2026-09-08). The studio used to carry a bundled MCP catalogue and
// three vendored third-party plugins; it now carries none, and instead
// *recommends places to get them*: a short, curated list of GitHub repositories
// in the Claude plugin marketplace format, which a person adds as a skill
// source with one click. We recommend sources; we do not host their contents,
// and adding one is the person's decision, not the release's.
//
// Node-free on purpose: `src/shared` cannot import `src/main` (TS6307). The
// fetcher, cache and poller live in src/main/hosted-feed.
//
// Deliberately its own schema and its own client beside the model feed's and
// the card feed's, not a shared abstraction over the three — the card feed
// states the reason and it holds here too: the schemas must be free to drift.
//
// The schema is a permanent contract: builds that are years old will keep
// reading it. Add fields; never remove or repurpose one. A body whose
// `schemaVersion` is not one this build knows is rejected whole, and the client
// keeps its last good copy.

import { isRecord } from './records'

const HOSTED_SOURCES_FEED_SCHEMA_VERSION = 1 as const

export const HOSTED_SOURCES_FEED_URL =
  'https://raw.githubusercontent.com/sprintengine/studio-releases/main/sources.json'

/**
 * The shapes a recommended source can have, and the vocabulary is not invented
 * here: the studio already auto-detects a repository's shape when it scans one
 * (`deriveShape` in src/main/skills/scan-plugins.ts), returning
 * `claude-marketplace` for a repo with `.claude-plugin/marketplace.json` and
 * `skills` for a bare tree of `SKILL.md` files. `kind` reuses those two names,
 * so a feed row says what a scan would find rather than something only the feed
 * understands — and a row whose `kind` turns out to be wrong is a wrong label
 * on a source that still scans correctly, never a broken add.
 */
export const HOSTED_SOURCE_KINDS = ['claude-marketplace', 'skills'] as const
export type HostedSourceKind = (typeof HOSTED_SOURCE_KINDS)[number]

export type HostedSource = {
  /** Stable id for the row itself. Not the skill-source id — see `hostedSourceId`. */
  id: string
  /** `owner/name`, and nothing else: a repository, never a URL. */
  repo: string
  kind: HostedSourceKind
  /** One or two sentences saying what is in there and who it is for. */
  description: string
}

export type HostedSourcesFeed = {
  schemaVersion: typeof HOSTED_SOURCES_FEED_SCHEMA_VERSION
  /**
   * Bumped on every edit. The tie-break between a bundled seed and a disk
   * cache: whichever was edited later wins, regardless of when it was fetched.
   */
  updatedAt: string
  sources: HostedSource[]
}

export type HostedSourcesFeedParse = { ok: true; feed: HostedSourcesFeed } | { ok: false; message: string }

/**
 * `owner/name`, and nothing else: no scheme, no host, no path beyond the two
 * segments, and neither segment a relative directory. The same rule the card
 * feed applies to `clone.repo`, for the same reason — a feed names a
 * repository, and the value reaches a URL builder and a path join.
 */
function isRepoName(value: unknown): value is string {
  if (typeof value !== 'string') return false
  const repo = value.trim()
  if (!/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(repo)) return false
  return !repo.split('/').some((segment) => segment === '.' || segment === '..')
}

/**
 * The skill-source id this recommendation would be added under, in the exact
 * form `src/main/skills/index.ts` mints (`github:owner/name`). Every
 * de-duplication against the sources a person already has goes through this, so
 * a recommendation and its installed copy can never be keyed differently.
 */
export function hostedSourceId(repo: string): string {
  return `github:${repo.trim()}`
}

export function parseHostedSourcesFeed(source: unknown): HostedSourcesFeedParse {
  let raw: unknown = source
  if (typeof source === 'string') {
    try {
      raw = JSON.parse(source)
    } catch {
      return { ok: false, message: 'The sources feed is not valid JSON.' }
    }
  }
  if (!isRecord(raw)) return { ok: false, message: 'The sources feed must be a JSON object.' }
  if (raw.schemaVersion !== HOSTED_SOURCES_FEED_SCHEMA_VERSION) {
    return {
      ok: false,
      message: `The sources feed declares schemaVersion ${String(raw.schemaVersion)}; this build reads 1.`,
    }
  }
  const updatedAt = typeof raw.updatedAt === 'string' ? raw.updatedAt.trim() : ''
  if (!updatedAt || Number.isNaN(Date.parse(updatedAt))) {
    return { ok: false, message: 'The sources feed needs an ISO `updatedAt`.' }
  }
  if (!Array.isArray(raw.sources)) return { ok: false, message: 'The sources feed needs a `sources` array.' }

  const sources: HostedSource[] = []
  const ids = new Set<string>()
  const repos = new Set<string>()
  for (const [index, entry] of raw.sources.entries()) {
    if (!isRecord(entry)) return { ok: false, message: `sources[${index}] is not an object.` }
    const id = typeof entry.id === 'string' ? entry.id.trim() : ''
    if (!id) return { ok: false, message: `sources[${index}] has no id.` }
    if (ids.has(id)) return { ok: false, message: `sources[${index}] repeats the id "${id}".` }
    if (!isRepoName(entry.repo)) {
      return { ok: false, message: `sources[${index}] ("${id}") needs a repo as owner/name.` }
    }
    const repo = entry.repo.trim()
    // Two rows for one repository would offer the same Add twice, and the
    // second could never be added because the first already claimed the id.
    if (repos.has(repo.toLowerCase())) {
      return { ok: false, message: `sources[${index}] repeats the repository "${repo}".` }
    }
    if (!HOSTED_SOURCE_KINDS.includes(entry.kind as HostedSourceKind)) {
      return {
        ok: false,
        message: `sources[${index}] ("${id}") has kind ${JSON.stringify(entry.kind)}; expected one of ${HOSTED_SOURCE_KINDS.join(', ')}.`,
      }
    }
    const description = typeof entry.description === 'string' ? entry.description.trim() : ''
    if (!description) return { ok: false, message: `sources[${index}] ("${id}") has no description.` }
    ids.add(id)
    repos.add(repo.toLowerCase())
    sources.push({ id, repo, kind: entry.kind as HostedSourceKind, description })
  }
  return { ok: true, feed: { schemaVersion: HOSTED_SOURCES_FEED_SCHEMA_VERSION, updatedAt, sources } }
}

/** Epoch millis of `updatedAt`, or 0 when unparsable: an undated copy loses every tie-break. */
export function hostedSourcesFeedUpdatedAtMs(feed: Pick<HostedSourcesFeed, 'updatedAt'>): number {
  const parsed = Date.parse(feed.updatedAt)
  return Number.isNaN(parsed) ? 0 : parsed
}

/**
 * The recommendations worth offering: the ones whose repository is not already
 * a source in this studio.
 *
 * `present` is every source id the person's list holds — which includes the
 * always-present ones (`ALWAYS_PRESENT_SKILL_SOURCES`: this repository and
 * `anthropics/claude-plugins-official`), because `listSources` returns those
 * first and they can never be removed. That matters: the official marketplace
 * leads the feed and is already installed on every machine, so without this it
 * would be offered as an Add that does nothing.
 *
 * Matching is by the minted id and case-folded, because GitHub treats
 * `SprintEngine` and `sprintengine` as one owner and a rule that did not would
 * be one capital letter away from listing a source twice.
 */
export function recommendedSourcesToAdd(
  feed: Pick<HostedSourcesFeed, 'sources'> | null | undefined,
  present: Iterable<string>,
): HostedSource[] {
  const have = new Set<string>()
  for (const id of present) have.add(id.trim().toLowerCase())
  return (feed?.sources ?? []).filter((source) => !have.has(hostedSourceId(source.repo).toLowerCase()))
}
