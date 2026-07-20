import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

import { parseBacklogFrontmatter } from '../../shared/backlog/frontmatter'
import type { BacklogReadResult } from '../../shared/electron-api'
import { readBacklogObjectStore } from '../backlog-service'

// Finds a representative already-materialized proxy item for a tracker connection,
// so the T11 write-back settings surface can enumerate that connection's status
// transitions from a REAL issue (plan §3.7 — transitions are per-issue in Jira and
// are never guessed). There is no reverse index from a connection to its items, so
// we scan the backlog object-store sidecar and return the first item whose flat
// underscore external identity (written by the T6 proxy writer) names this
// connection. A proxy whose upstream issue is gone (`external_unavailable`) is
// skipped — sampling it would 404. `null` when the connection has no local issue
// yet, which the UI renders as an honest "add an issue first" state.

export type ConnectionSampleIssue = { externalId: string; nativeKey: string }

export type ConnectionSampleIssueDeps = {
  readObjectStore(workspaceRoot: string): Promise<BacklogReadResult>
  readItemFrontmatter(workspaceRoot: string, relativePath: string): Promise<Record<string, string> | null>
}

export async function resolveConnectionSampleIssue(
  workspaceRoot: string,
  connectionId: string,
  deps: ConnectionSampleIssueDeps = defaultDeps(),
): Promise<ConnectionSampleIssue | null> {
  if (!workspaceRoot || !connectionId) return null

  const read = await deps.readObjectStore(workspaceRoot)
  if (!read.ok) return null

  for (const record of read.store.items) {
    const fields = await deps.readItemFrontmatter(workspaceRoot, record.source.relativePath)
    if (!fields) continue
    if (fields.external_connection?.trim() !== connectionId) continue
    if (typeof fields.external_unavailable === 'string' && fields.external_unavailable.trim()) continue

    const externalId = fields.external_id?.trim()
    if (!externalId) continue
    return { externalId, nativeKey: fields.external_key?.trim() || externalId }
  }
  return null
}

function defaultDeps(): ConnectionSampleIssueDeps {
  return {
    readObjectStore: (workspaceRoot) => readBacklogObjectStore(workspaceRoot),
    readItemFrontmatter: async (workspaceRoot, relativePath) => {
      let raw: string
      try {
        raw = await readFile(join(workspaceRoot, relativePath), 'utf-8')
      } catch {
        return null
      }
      return parseBacklogFrontmatter(raw).fields
    },
  }
}
