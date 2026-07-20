import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

import { parseBacklogFrontmatter } from '../../../shared/backlog/frontmatter'
import {
  runRelativePathForStatePath,
  safeProjectRelativeRunPath,
  sprintEngineRunLinkOf,
} from '../../../shared/backlog/sprintengine-links'
import type { BacklogReadResult } from '../../../shared/electron-api'
import type { TrackerProviderId } from '../../../shared/tracker/types'
import { readBacklogObjectStore } from '../../backlog-service'
import type { ProxyItemLookup, RunProxyItem } from './engine'

// Resolves which tracker proxy backlog items belong to a run (plan §3.5/§3.7).
// There is no reverse index from a run to its items, so we scan the object-store
// sidecar for the item whose Sprint Engine execution link resolves to THIS run's
// run.yaml, then read that item's flat underscore external identity from its
// frontmatter (the authoritative external-identity source). Multiple proxy items
// on one run each surface independently.

// The tracker-owned identity read off a proxy item's frontmatter.
type ProxyExternalIdentity = {
  provider: TrackerProviderId
  connectionId: string
  externalId: string
  nativeKey: string
}

// Injected so tests drive the lookup without a real workspace on disk.
export type ProxyItemLookupDeps = {
  readObjectStore(workspaceRoot: string): Promise<BacklogReadResult>
  readItemFrontmatter(workspaceRoot: string, relativePath: string): Promise<Record<string, string> | null>
}

const PROVIDERS: ReadonlySet<string> = new Set<TrackerProviderId>(['github', 'jira', 'linear'])

export function createProxyItemLookup(deps: ProxyItemLookupDeps = defaultDeps()): ProxyItemLookup {
  return {
    async proxyItemsForRun({ workspaceRoot, statePath }): Promise<RunProxyItem[]> {
      const runRelativePath = runRelativePathForStatePath(workspaceRoot, statePath)
      if (!runRelativePath) return []

      const read = await deps.readObjectStore(workspaceRoot)
      if (!read.ok) return []

      const items: RunProxyItem[] = []
      for (const record of read.store.items) {
        const links = record.links ?? []
        const runLink = sprintEngineRunLinkOf(links)
        if (!runLink) continue
        const linkPath = safeProjectRelativeRunPath(runLink.target.path ?? '')
        if (!linkPath || linkPath !== runRelativePath) continue

        const identity = await readExternalIdentity(deps, workspaceRoot, record.source.relativePath)
        if (!identity) continue
        items.push({ relativePath: record.source.relativePath, ...identity })
      }
      return items
    },
  }
}

async function readExternalIdentity(
  deps: ProxyItemLookupDeps,
  workspaceRoot: string,
  relativePath: string,
): Promise<ProxyExternalIdentity | null> {
  const fields = await deps.readItemFrontmatter(workspaceRoot, relativePath)
  if (!fields) return null
  // A proxy whose upstream issue is gone would 404 on a post; skip it rather than
  // manufacture a failure notice for a deleted issue.
  if (typeof fields.external_unavailable === 'string' && fields.external_unavailable.trim()) return null

  const provider = fields.external_provider?.trim()
  const connectionId = fields.external_connection?.trim()
  const externalId = fields.external_id?.trim()
  if (!provider || !PROVIDERS.has(provider) || !connectionId || !externalId) return null

  return {
    provider: provider as TrackerProviderId,
    connectionId,
    externalId,
    nativeKey: fields.external_key?.trim() || externalId,
  }
}

function defaultDeps(): ProxyItemLookupDeps {
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
