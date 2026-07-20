import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { materializeTrackerIssues, type MaterializeTrackerAccess } from './materialize-service'
import type {
  NormalizedIssue,
  TrackerConnection,
  TrackerFetchIssueInput,
  TrackerFetchIssueResult,
} from '../../../shared/tracker/types'

// Orchestrator tests (plan §3.4): fetch → proxy write, added/refreshed/failed
// tallying, deleted-upstream → unavailable (counts as refreshed), exactly one
// issue-typed sidecar link per item, and honest degradation on a transient
// failure — all with an injected fetch, so no tracker HTTP is exercised.

const CONNECTION: TrackerConnection = {
  id: 'trk-1',
  provider: 'github',
  baseUrl: null,
  authMode: 'github_pat',
  label: 'GitHub',
  envVar: null,
}

function issue(externalId: string, title: string, category: 'open' | 'closed' = 'open'): NormalizedIssue {
  const number = externalId.split('#')[1]
  return {
    provider: 'github',
    connectionId: 'trk-1',
    externalId,
    nativeKey: `#${number}`,
    title,
    bodyMarkdown: `Body for ${title}.`,
    state: { category, nativeName: category === 'closed' ? 'Closed' : 'Open' },
    labels: [],
    url: `https://github.com/acme/web/issues/${number}`,
    comments: [],
  }
}

function accessFrom(
  issues: Record<string, NormalizedIssue>,
  errors: Record<string, TrackerFetchIssueResult> = {}
): { access: MaterializeTrackerAccess; fetchCount: () => number } {
  let fetches = 0
  return {
    fetchCount: () => fetches,
    access: {
      getConnection: async (id) => (id === CONNECTION.id ? CONNECTION : undefined),
      fetchIssue: async (input: TrackerFetchIssueInput): Promise<TrackerFetchIssueResult> => {
        fetches += 1
        if (errors[input.externalId]) return errors[input.externalId]
        const found = issues[input.externalId]
        if (found) return { ok: true, issue: found }
        return { ok: false, error: { kind: 'not_found', message: 'gone' } }
      },
    },
  }
}

async function readSidecar(root: string): Promise<{ items: Array<{ source: { relativePath: string }; links?: unknown[] }> }> {
  return JSON.parse(await readFile(join(root, '.multi-code', 'backlog', 'items.json'), 'utf-8'))
}

async function main(): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'multicode-materialize-'))
  await mkdir(join(root, 'backlog'), { recursive: true })
  try {
    const { access } = accessFrom({
      'acme/web#1': issue('acme/web#1', 'First issue'),
      'acme/web#2': issue('acme/web#2', 'Second issue'),
    })

    // --- first pass: two new proxies -------------------------------------
    const first = await materializeTrackerIssues({
      workspaceRoot: root,
      connectionId: 'trk-1',
      externalIds: ['acme/web#1', 'acme/web#2', 'acme/web#1'], // duplicate id de-duped
      tracker: access,
    })
    assert.equal(first.ok, true)
    assert.deepEqual(first.ok && { added: first.added, refreshed: first.refreshed, failed: first.failed }, {
      added: 2,
      refreshed: 0,
      failed: [],
    })

    let sidecar = await readSidecar(root)
    assert.equal(sidecar.items.length, 2, 'two proxy items registered')
    for (const record of sidecar.items) {
      const issueLinks = (record.links ?? []).filter((l) => (l as { type?: string }).type === 'issue')
      assert.equal(issueLinks.length, 1, 'exactly one issue-typed sidecar link per proxy item')
      const link = issueLinks[0] as { moduleId: string; target: { kind: string; id: string; url: string } }
      assert.equal(link.target.kind, 'github.issue')
      assert.match(link.target.url, /github\.com/)
    }

    // --- second pass: same ids refresh, no new items, still one link -----
    const second = await materializeTrackerIssues({
      workspaceRoot: root,
      connectionId: 'trk-1',
      externalIds: ['acme/web#1', 'acme/web#2'],
      tracker: access,
    })
    assert.equal(second.ok, true)
    assert.deepEqual(second.ok && { added: second.added, refreshed: second.refreshed }, { added: 0, refreshed: 2 })
    sidecar = await readSidecar(root)
    assert.equal(sidecar.items.length, 2, 're-materialize never duplicates items')
    for (const record of sidecar.items) {
      assert.equal((record.links ?? []).filter((l) => (l as { type?: string }).type === 'issue').length, 1)
    }

    // --- deleted upstream + transient failure ---------------------------
    const { access: mixed } = accessFrom(
      { 'acme/web#1': issue('acme/web#1', 'First issue', 'closed') },
      {
        'acme/web#2': { ok: false, error: { kind: 'not_found', message: 'gone' } }, // was materialized ⇒ mark unavailable
        'acme/web#5': { ok: false, error: { kind: 'auth', message: 'GitHub rejected the credential.' } }, // transient
        'acme/web#9': { ok: false, error: { kind: 'not_found', message: 'gone' } }, // never materialized ⇒ failed
      }
    )
    const third = await materializeTrackerIssues({
      workspaceRoot: root,
      connectionId: 'trk-1',
      externalIds: ['acme/web#1', 'acme/web#2', 'acme/web#5', 'acme/web#9'],
      tracker: mixed,
    })
    assert.equal(third.ok, true)
    assert.equal(third.ok && third.added, 0)
    assert.equal(third.ok && third.refreshed, 2, '#1 refreshed + #2 flipped to unavailable both count as refreshed')
    const failedIds = third.ok ? third.failed.map((f) => f.externalId).sort() : []
    assert.deepEqual(failedIds, ['acme/web#5', 'acme/web#9'], 'transient auth + never-seen 404 are failures')
    const authFail = third.ok ? third.failed.find((f) => f.externalId === 'acme/web#5') : undefined
    assert.equal(authFail?.reason, 'GitHub rejected the credential.', 'the provider message is surfaced verbatim')

    // The unavailable proxy stayed (not deleted) and is flagged.
    const item2 = sidecar.items.find((r) => /second-issue/.test(r.source.relativePath))
    assert.ok(item2, 'the unavailable item is still in the sidecar')
    const raw2 = await readFile(join(root, item2!.source.relativePath), 'utf-8')
    assert.match(raw2, /external_unavailable:/)

    // --- unknown connection degrades honestly ---------------------------
    const noConn = await materializeTrackerIssues({
      workspaceRoot: root,
      connectionId: 'missing',
      externalIds: ['acme/web#1'],
      tracker: access,
    })
    assert.equal(noConn.ok, false)
    assert.equal(noConn.ok === false && noConn.error.kind, 'not_configured')

    console.log('materialize-service tests passed')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
