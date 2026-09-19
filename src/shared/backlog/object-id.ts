// Single source of truth for the Backlog **object-store record id** — the key
// under which an item's app-owned churn (working-agent/execution links, the
// star/highlight, module metadata, timestamps) lives in
// `.sprintengine/backlog/items.json`. It is derived purely from the item's file
// path so every producer agrees on one key per file: the renderer, the main
// process, and the `/backlog` skill (which documents `backlog_` + FNV-1a).
//
// Contract: `backlog_` + FNV-1a (32-bit) of the path normalized to forward
// slashes and lowercased. FNV-1a is the canonical hash both processes MUST use;
// a former main-process djb2 variant produced divergent ids for the same file,
// forking each item's record (a link written by one side was invisible to the
// other). Records carrying that losing hash are migrated onto the canonical id
// on store load — see `reconcileBacklogObjectRecordIds`.
//
// This module is pure and shared by both processes (and, in spirit, the skill),
// so it must stay free of renderer-only or main-only runtime imports — the same
// rule `frontmatter.ts` and `item-id.ts` follow. The `import type` below is
// erased at build time and pulls in no runtime code.
import type { BacklogItemLinkPayload, BacklogObjectRecordPayload } from '../electron-api'

// Path normalization shared by the hash and by store lookups: forward slashes,
// no leading slash, collapsed duplicate separators. Case is preserved here; the
// hash lowercases on top of this so the id is case-insensitive.
export function normalizeBacklogObjectPath(relativePath: string): string {
  return relativePath.replace(/\\/g, '/').replace(/^\/+/, '').replace(/\/+/g, '/')
}

// The canonical object-store id for a backlog item file. Case-insensitive and
// slash-agnostic so a Windows-style or differently-cased path resolves to the
// same record as its canonical form.
export function stableBacklogObjectId(relativePath: string): string {
  const normalized = normalizeBacklogObjectPath(relativePath).toLowerCase()
  let hash = 2166136261
  for (let index = 0; index < normalized.length; index += 1) {
    hash ^= normalized.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }
  return `backlog_${(hash >>> 0).toString(36)}`
}

// Migration: re-key every record onto the canonical id derived from its path,
// merging any records that collapse onto the same canonical id — e.g. a
// djb2-keyed record written by an older main process and its FNV-keyed twin
// written by the renderer. Idempotent: once every record carries the canonical
// id, a re-run returns an equivalent list. Record lookup is by relative path
// (case-insensitive), never by id, so re-keying never orphans a record.
export function reconcileBacklogObjectRecordIds(records: BacklogObjectRecordPayload[]): BacklogObjectRecordPayload[] {
  const byCanonicalId = new Map<string, BacklogObjectRecordPayload>()
  for (const record of records) {
    const canonicalId = stableBacklogObjectId(record.source.relativePath)
    const rekeyed = record.id === canonicalId ? record : { ...record, id: canonicalId }
    const existing = byCanonicalId.get(canonicalId)
    byCanonicalId.set(canonicalId, existing ? mergeBacklogObjectRecords(existing, rekeyed) : rekeyed)
  }
  return [...byCanonicalId.values()]
}

// Merge two records that share a canonical id. The record with the newer
// `updatedAt` is authoritative for scalar fields (source/status/highlight/…);
// links are unioned by link id (newest per id wins), metadata is shallow-merged
// (newer keys win), `createdAt` keeps the earliest and `updatedAt` the latest.
function mergeBacklogObjectRecords(
  a: BacklogObjectRecordPayload,
  b: BacklogObjectRecordPayload,
): BacklogObjectRecordPayload {
  const [older, newer] = (a.updatedAt ?? '') <= (b.updatedAt ?? '') ? [a, b] : [b, a]
  return {
    id: newer.id,
    source: newer.source,
    status: newer.status ?? older.status,
    type: newer.type ?? older.type,
    difficulty: newer.difficulty ?? older.difficulty,
    criticality: newer.criticality ?? older.criticality,
    risk: newer.risk ?? older.risk,
    highlight: newer.highlight ?? older.highlight,
    metadata: { ...older.metadata, ...newer.metadata },
    links: mergeBacklogObjectLinks(older.links ?? [], newer.links ?? []),
    createdAt: earliest(a.createdAt, b.createdAt),
    updatedAt: latest(a.updatedAt, b.updatedAt),
  }
}

// Union links by their fixed `id` (e.g. `agent-runtime:working-agent`), keeping
// the entry with the newer `updatedAt`; ties and missing timestamps prefer the
// newer record's copy so a re-pointed working-agent link wins.
function mergeBacklogObjectLinks(
  olderLinks: BacklogItemLinkPayload[],
  newerLinks: BacklogItemLinkPayload[],
): BacklogItemLinkPayload[] {
  const byId = new Map<string, BacklogItemLinkPayload>()
  for (const link of olderLinks) byId.set(link.id, link)
  for (const link of newerLinks) {
    const prev = byId.get(link.id)
    if (!prev || (link.updatedAt ?? '') >= (prev.updatedAt ?? '')) byId.set(link.id, link)
  }
  return [...byId.values()]
}

function earliest(a: string | undefined, b: string | undefined): string | undefined {
  if (a === undefined) return b
  if (b === undefined) return a
  return a <= b ? a : b
}

function latest(a: string | undefined, b: string | undefined): string | undefined {
  if (a === undefined) return b
  if (b === undefined) return a
  return a >= b ? a : b
}
