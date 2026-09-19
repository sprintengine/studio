// Part of the IPC contract: the backlog object service.
// ../electron-api.ts re-exports everything here.

import type { BacklogItemStatusPayload, BacklogTypePayload } from './app'

export type BacklogDifficultyPayload = 'xs' | 's' | 'm' | 'l' | 'xl'
export type BacklogCriticalityPayload = 'low' | 'normal' | 'high' | 'critical'
export type BacklogRiskPayload = 'low' | 'normal' | 'high'
// Declared fresh in shared (no renderer imports); the renderer's HighlightColor
// union must stay assignable to this payload type.
export type BacklogHighlightColorPayload = 'red' | 'orange' | 'amber' | 'green' | 'blue' | 'purple' | 'pink'

export type BacklogHighlightPayload = {
  starred: boolean
  color: BacklogHighlightColorPayload | null
}

export type BacklogItemLinkPayload = {
  id: string
  moduleId: string
  // `agent` is lifecycle-neutral: unlike `execution`, an active agent link
  // never drives item status (see nextBacklogItemStatusFromLinks). It records
  // which agent terminal is working the item, for two-way navigation.
  type: 'execution' | 'issue' | 'review' | 'artifact' | 'external' | 'agent'
  label: string
  target: {
    kind: string
    id: string
    path?: string
    url?: string
  }
  // `pending` is recorded-but-not-started: the link exists so the item shows its
  // work, but it does not drive the item to `in_progress` yet.
  status?: 'pending' | 'active' | 'completed' | 'canceled' | 'failed' | 'unknown'
  updatedAt?: string
}

export type BacklogObjectRecordPayload = {
  id: string
  source: {
    type: 'file'
    relativePath: string
  }
  status?: BacklogItemStatusPayload
  type?: BacklogTypePayload
  difficulty?: BacklogDifficultyPayload
  criticality?: BacklogCriticalityPayload
  risk?: BacklogRiskPayload
  highlight?: BacklogHighlightPayload
  metadata?: Record<string, unknown>
  links?: BacklogItemLinkPayload[]
  createdAt?: string
  updatedAt?: string
}

export type BacklogObjectStorePayload = {
  schemaVersion: 1
  items: BacklogObjectRecordPayload[]
}

export type BacklogItemRecordInput = {
  relativePath: string
  status?: BacklogItemStatusPayload
  type?: BacklogTypePayload
  difficulty?: BacklogDifficultyPayload
  criticality?: BacklogCriticalityPayload
}

export type BacklogReadResult = { ok: true; store: BacklogObjectStorePayload } | { ok: false; message: string }

// Scan-time id allocation: the renderer hands the main process every scanned
// item with its current frontmatter id (or null), and the service writes the
// next sequential id into the frontmatter of those without one. `assignments`
// maps relativePath -> the newly minted numeric id (only for items that gained
// one); `key` is the workspace display key so the panel can render `KEY-n`.
export type BacklogEnsureIdsItemInput = {
  relativePath: string
  numericId?: number | null
}

export type BacklogEnsureIdsInput = {
  workspaceRoot: string
  items: BacklogEnsureIdsItemInput[]
}

export type BacklogEnsureIdsResult =
  { ok: true; key: string; assignments: Record<string, number> } | { ok: false; message: string }

/**
 * Where a workspace's backlog items live. `root` is `<workspaceRoot>/backlog`
 * unless the workspace has pointed its backlog elsewhere.
 *
 * `exists` is reported separately from `isDefault` because a configured root can
 * be legitimately absent — an unplugged drive, a folder that has not been cloned
 * yet — and that is worth saying out loud rather than rendering as an empty
 * backlog that looks like lost work.
 */
export type BacklogLocationInfo = {
  workspaceRoot: string
  root: string
  isDefault: boolean
  exists: boolean
}

export type BacklogLocationResult = { ok: true; location: BacklogLocationInfo } | { ok: false; message: string }

/** `root: null` resets the workspace to the default `<workspaceRoot>/backlog`. */
export type BacklogSetRootInput = {
  workspaceRoot: string
  root: string | null
}

export type BacklogMutationResult = { ok: true; store: BacklogObjectStorePayload } | { ok: false; message: string }

export type BacklogStatusInput = {
  workspaceRoot: string
  relativePath: string
  status: BacklogItemStatusPayload
}

export type BacklogTypeInput = {
  workspaceRoot: string
  relativePath: string
  type: BacklogTypePayload | null
}

export type BacklogTriageInput = {
  workspaceRoot: string
  relativePath: string
  difficulty?: BacklogDifficultyPayload | null
  criticality?: BacklogCriticalityPayload | null
  risk?: BacklogRiskPayload | null
}

export type BacklogHighlightInput = {
  workspaceRoot: string
  relativePath: string
  starred: boolean
  color: BacklogHighlightColorPayload | null
}

export type BacklogAddOrUpdateLinkInput = {
  workspaceRoot: string
  relativePath: string
  link: BacklogItemLinkPayload
  status?: BacklogItemStatusPayload
}

export type BacklogRemoveLinkInput = {
  workspaceRoot: string
  relativePath: string
  linkId: string
}

export type BacklogModuleMetadataInput = {
  workspaceRoot: string
  relativePath: string
  moduleId: string
  value: unknown
}

export type BacklogMoveSourceInput = {
  workspaceRoot: string
  relativePath: string
  nextRelativePath: string
}

export type BacklogRemoveRecordInput = {
  workspaceRoot: string
  relativePath: string
}

// Epic membership is the child-side write: `epic` is the up-pointing slug to set
// on the child item's frontmatter, or null to remove it from its epic. The
// down-direction (epic -> children) stays derived, never stored.
export type BacklogEpicInput = {
  workspaceRoot: string
  relativePath: string
  epic: string | null
}

// Prerequisites are the dependent-side write: `dependsOn` is the list of item
// slugs this item waits on, serialized to the single comma-separated `dependsOn:`
// frontmatter line. An empty list or null clears the line. The reverse "blocks"
// edges and the waiting signal stay derived (see backlogDependencies.ts), never
// stored.
export type BacklogDependenciesInput = {
  workspaceRoot: string
  relativePath: string
  dependsOn: string[] | null
}

// The epic-side ordering mark: the author asserting that this epic's
// children are ordered — deliberately parallel counts — so work may start from
// it with no further ordering pass. `true` writes `dependenciesPlanned: true`;
// `false` removes the line, since absent is the same assertion as false.
export type BacklogDependenciesPlannedInput = {
  workspaceRoot: string
  relativePath: string
  dependenciesPlanned: boolean
}

// Mockup attachments are the item-side write: `mockups` is the list of
// project-relative mockup paths, serialized to the single comma-separated
// `mockups:` frontmatter line (mirrors `dependsOn`). An empty list or null clears
// the line. Body-prose references stay derived (see backlogMockups.ts), never
// written back here.
export type BacklogMockupsInput = {
  workspaceRoot: string
  relativePath: string
  mockups: string[] | null
}

export type BacklogCreateEpicInput = {
  workspaceRoot: string
  title: string
}

// Epic identity colour is an epic-only write: one of the seven highlight colours
// to set on the epic file's `color:` frontmatter, or null to clear it. Unlike the
// per-item `highlight` (owned by items.json) this lives in the epic's markdown,
// so its members can derive the colour at scan time.
export type BacklogEpicColorInput = {
  workspaceRoot: string
  relativePath: string
  color: BacklogHighlightColorPayload | null
}

export type BacklogCreateEpicResult = { ok: true; slug: string; relativePath: string } | { ok: false; message: string }
