// The durable half of a Backlog item's links, expressed as flat frontmatter
// scalars so the item's own markdown file carries them — committed, diffable,
// and carried along by a `git mv`.
//
// Links used to live entirely in `.multi-code/backlog/items.json`, a single
// tracked file every agent and branch wrote to. Two problems came with that: the
// file was a permanent merge-conflict surface, and most of what it held was not
// durable at all. A link mixes two kinds of fact:
//
//   durable   which sprint run, which pull request — a human's decision, changes
//             rarely, belongs in the file beside the item it describes
//   volatile  whether that run is still going, whether that PR is still open,
//             which agent terminal currently has the item — re-derived from the
//             world every few minutes and worthless after a restart
//
// Only the durable half lives here. The volatile half belongs in the gitignored
// cache (see src/main/backlog-link-cache.ts), which is why writing a resolved
// status can no longer dirty a tracked file.
//
// Everything else about a link is reconstructed: labels are constants, the run
// path follows the sprintengine layout, and the PR target repeats its URL. That
// is the whole reason a link fits in a scalar — the sidecar was storing derived
// data as if it were input.
//
// Pure and shared by both processes, like frontmatter.ts and item-id.ts: no
// renderer-only or main-only imports.
import type { BacklogItemLink } from './scan'
import {
  buildSprintEnginePullRequestLink,
  buildSprintEngineRunLink,
  SPRINT_ENGINE_MODULE_ID,
  SPRINT_ENGINE_PR_TARGET_KIND,
  SPRINT_ENGINE_RUN_TARGET_KIND,
} from './sprintengine-links'

// Frontmatter keys this module owns. `pr` and `sprints` follow the existing
// comma-separated scalar convention (`dependsOn`, `mockups`) rather than
// inventing a nested shape the flat parser cannot round-trip.
export const DURABLE_LINK_FIELDS = ['sprints', 'pr'] as const

// The sprintengine run layout. One definition so the derivation here and the
// runtime that owns those directories cannot drift.
export function sprintRunPath(slug: string): string {
  return `.multi-code/sprintengine/${slug}/run.yaml`
}

// `<slug>` or `<slug>#<taskId>` — the task suffix is present only for an epic
// child owned by one task inside the run (MC-2017), which is why it is optional
// rather than a second field.
function parseSprintEntry(entry: string): { slug: string; taskId?: string } | null {
  const trimmed = entry.trim()
  if (!trimmed) return null
  const hash = trimmed.indexOf('#')
  if (hash < 0) return { slug: trimmed }
  const slug = trimmed.slice(0, hash).trim()
  const taskId = trimmed.slice(hash + 1).trim()
  if (!slug) return null
  return taskId ? { slug, taskId } : { slug }
}

function splitScalarList(value: string | undefined): string[] {
  if (!value) return []
  return value
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
}

// Rebuild the durable links an item's frontmatter declares. Status is
// deliberately absent: it is volatile, and the caller merges it in from the
// cache. A link with no cached status renders as `unknown`, which is exactly
// what it is before anything resolves it.
export function durableBacklogLinksFromFrontmatter(
  fields: Readonly<Record<string, string>>,
): BacklogItemLink[] {
  const links: BacklogItemLink[] = []

  for (const entry of splitScalarList(fields.sprints)) {
    const parsed = parseSprintEntry(entry)
    if (!parsed) continue
    // Built by the canonical builder, not re-specified here, so the label, id
    // scheme and target shape cannot drift from the ones a live run writes.
    // `status`/`priorStatus` are stripped: both are volatile, and persisting a
    // status to a tracked file is the churn this migration exists to end.
    const { status: _status, priorStatus: _priorStatus, ...link } = buildSprintEngineRunLink({
      teamSlug: parsed.slug,
      runRelativePath: sprintRunPath(parsed.slug),
      ...(parsed.taskId ? { taskId: parsed.taskId } : {}),
    })
    links.push(link)
  }

  for (const entry of splitScalarList(fields.pr)) {
    const parsed = parsePrEntry(entry)
    if (!parsed) continue
    const { status: _status, updatedAt: _updatedAt, ...link } = buildSprintEnginePullRequestLink({
      pullRequestUrl: parsed.url,
      updatedAt: '',
      ...(parsed.repoId ? { repoId: parsed.repoId, repoLabel: parsed.repoId } : {}),
    })
    links.push(link)
  }

  return links
}

// True when this link's identity is fully recoverable from frontmatter, so the
// caller knows not to also write it to the volatile cache. An agent-terminal
// link is the counterexample: its target is a live terminal id that means
// nothing after a restart.
export function isDurableBacklogLink(link: BacklogItemLink): boolean {
  if (link.moduleId !== SPRINT_ENGINE_MODULE_ID) return false
  return (
    link.target.kind === SPRINT_ENGINE_RUN_TARGET_KIND
    || link.target.kind === SPRINT_ENGINE_PR_TARGET_KIND
  )
}

// The inverse: the frontmatter scalars that reproduce these links. Returns a
// value for every key this module owns, using null to clear — the frontmatter
// writer's contract for "remove this line" — so a link removed from an item
// removes its scalar rather than leaving a stale one behind.
export function durableBacklogLinkFields(
  links: readonly BacklogItemLink[],
): Record<(typeof DURABLE_LINK_FIELDS)[number], string | null> {
  const sprints: string[] = []
  const prs: string[] = []

  for (const link of links) {
    if (!isDurableBacklogLink(link)) continue
    if (link.target.kind === SPRINT_ENGINE_RUN_TARGET_KIND) {
      const slug = link.target.id.trim()
      if (!slug) continue
      const entry = link.target.taskId ? `${slug}#${link.target.taskId}` : slug
      if (!sprints.includes(entry)) sprints.push(entry)
      continue
    }
    const url = (link.target.url ?? link.target.id).trim()
    if (!url) continue
    // A sibling project's PR carries its repo id so the link keeps its own id on
    // the way back (`sprint-engine:pull-request:<repoId>`); the primary's stays
    // the bare url it has always been.
    const repoId = repoIdFromPullRequestLinkId(link.id)
    const entry = repoId ? `${repoId}=${url}` : url
    if (!prs.includes(entry)) prs.push(entry)
  }

  return {
    sprints: sprints.length > 0 ? sprints.join(',') : null,
    pr: prs.length > 0 ? prs.join(',') : null,
  }
}

// `<url>` for the primary project, `<repoId>=<url>` for a sibling. `=` is safe as
// the separator: a repo id is a slug and a pull-request URL has no query string.
function parsePrEntry(entry: string): { url: string; repoId?: string } | null {
  const trimmed = entry.trim()
  if (!trimmed) return null
  const eq = trimmed.indexOf('=')
  if (eq < 0) return { url: trimmed }
  const repoId = trimmed.slice(0, eq).trim()
  const url = trimmed.slice(eq + 1).trim()
  if (!url) return null
  return repoId ? { url, repoId } : { url }
}

// The inverse of sprintEnginePullRequestLinkId: the repo id a sibling link is
// suffixed with, or null for the primary's bare id.
function repoIdFromPullRequestLinkId(linkId: string): string | null {
  const parts = linkId.split(':')
  return parts.length > 2 ? parts.slice(2).join(':') : null
}
