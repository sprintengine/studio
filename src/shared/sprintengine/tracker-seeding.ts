import { parseBacklogFrontmatter } from '../backlog/frontmatter'
import type { TrackerProviderId } from '../electron-api'

// ---------------------------------------------------------------------------
// Tracker proxy sprint seeding (MC-1639, plan §3.6)
//
// The pure, node-testable pieces of the tracker-sprint seam, extracted from
// sprintengineWorkspaceCreation.ts so the imperative launch composition and
// these decision functions have separate homes (and the test that covers them
// is no longer named after a module that does not exist).
//
// A proxy backlog item mirrors an external tracker issue. When a sprint is
// seeded from one, the architect must read the FRESH issue — its current body
// and comment thread. Backlog launches are REFERENCE-mode (sourceReference),
// meaning the architect reads the on-disk file in place (see
// buildPlanFileSprintEngineHandoffPrompt) rather than an embedded snapshot; so
// freshness is delivered by refreshing that file through the T6 materialize
// upsert at seed time, then referencing it — not by composing content in the
// renderer (which the reference-mode handoff never reads).
//
// These functions read a proxy's external identity from frontmatter (to know
// what to refresh), locate the on-disk proxy item a one-step materialize just
// wrote (to reference it), and derive the run goal from the seed. The
// imperative materialize + create + link glue lives in the Backlog panel and
// reuses the shared plan-sourced creation path (D6: compose existing seams,
// never a bespoke sprint-from-tracker pipeline). A native (non-proxy) item
// never reaches any of this, so its seeding stays byte-identical to today.
// ---------------------------------------------------------------------------

// The run goal for a plan-sourced launch: the first markdown heading of the
// seed (§2 "title-as-goal"), falling back to a humanized filename stem when the
// seed has no heading. Shared by every plan-sourced creation path.
export function derivePlanSourcedGoal(sourceContent: string, sourcePath: string): string {
  const heading = sourceContent
    .split(/\r?\n/u)
    .map((line) => line.match(/^#{1,3}\s+(.+?)\s*$/u)?.[1]?.trim())
    .find((title): title is string => Boolean(title))
  if (heading) return heading

  const filename = sourcePath.replace(/\\/g, '/').split('/').pop() ?? ''
  const stem = filename.replace(/\.[^.]+$/u, '').trim()
  const normalized = stem.replace(/[-_]+/gu, ' ').replace(/\s+/gu, ' ').trim()
  return normalized || 'Sprint handoff'
}

// The external identity a proxy item carries in its flat underscore frontmatter
// keys (plan §3.4). provider/connection/id are required to refresh; key/url are
// best-effort display fields.
export type ProxyTrackerIdentity = {
  provider: TrackerProviderId
  connectionId: string
  externalId: string
  nativeKey: string
  url: string
}

function isTrackerProviderId(value: string): value is TrackerProviderId {
  return value === 'github' || value === 'jira' || value === 'linear'
}

// Read a backlog item's proxy identity from its frontmatter. Returns null for a
// native (non-proxy) item, or a proxy whose external block was stripped — the
// caller then takes the byte-identical native seeding path. Underscore keys only
// (a dotted key does not round-trip the frontmatter charset, plan §3.4).
export function parseProxyTrackerIdentity(sourceContent: string): ProxyTrackerIdentity | null {
  const { fields } = parseBacklogFrontmatter(sourceContent)
  const provider = fields.external_provider?.trim()
  const connectionId = fields.external_connection?.trim()
  const externalId = fields.external_id?.trim()
  if (!provider || !connectionId || !externalId || !isTrackerProviderId(provider)) return null
  return {
    provider,
    connectionId,
    externalId,
    nativeKey: fields.external_key?.trim() || '',
    url: fields.external_url?.trim() || '',
  }
}

// Locate the proxy backlog item that mirrors a given issue, by matching its
// one issue-typed sidecar link (target.kind `<provider>.issue`, target.id the
// externalId) written by the T6 materializer. Used after a one-step materialize
// to resolve the freshly written item's on-disk path + content. Pure over a
// minimal item shape (returns the caller's own item type).
export function matchProxyItemByIssue<
  T extends {
    relativePath: string
    path: string
    sourceContent: string
    links: ReadonlyArray<{ type: string; target?: { kind?: string; id?: string } }>
  },
>(items: ReadonlyArray<T>, provider: TrackerProviderId, externalId: string): T | null {
  const wantedKind = `${provider}.issue`
  for (const item of items) {
    for (const link of item.links) {
      if (link.type !== 'issue') continue
      if (link.target?.kind === wantedKind && link.target?.id === externalId) return item
    }
  }
  return null
}
