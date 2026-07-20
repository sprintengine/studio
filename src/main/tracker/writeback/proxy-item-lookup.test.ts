import assert from 'node:assert/strict'

import type { BacklogItemLinkPayload, BacklogReadResult } from '../../../shared/electron-api'
import { createProxyItemLookup, type ProxyItemLookupDeps } from './proxy-item-lookup'

// Verifies the proxy-item lookup (MC-1640 / T10): only items whose Sprint Engine
// execution link resolves to THIS run are returned; their external identity is
// read from the underscore frontmatter; a proxy whose upstream issue is gone is
// skipped; and an item linked to a different run is not matched.

const STATE_PATH = '/ws/.multi-code/sprintengine/team/run.yaml'
const RUN_REL = '.multi-code/sprintengine/team/run.yaml'
const OTHER_REL = '.multi-code/sprintengine/other/run.yaml'

async function main(): Promise<void> {
  await testReturnsProxyItemsOnThisRun()
  await testIgnoresItemsLinkedToAnotherRun()
  await testSkipsUnavailableProxy()
  await testIgnoresNonProxyRunItems()

  console.log('tracker-writeback-proxy-item-lookup tests passed')
}

async function testReturnsProxyItemsOnThisRun(): Promise<void> {
  const lookup = createProxyItemLookup(
    deps({
      records: [
        record('backlog/gh.md', [runLink(RUN_REL)]),
        record('backlog/jira.md', [runLink(RUN_REL)]),
      ],
      frontmatter: {
        'backlog/gh.md': { external_provider: 'github', external_connection: 'conn-gh', external_id: 'o/r#7', external_key: '#7' },
        'backlog/jira.md': { external_provider: 'jira', external_connection: 'conn-jira', external_id: '10023', external_key: 'PROJ-17' },
      },
    }),
  )
  const items = await lookup.proxyItemsForRun({ workspaceRoot: '/ws', statePath: STATE_PATH })
  assert.equal(items.length, 2)
  const gh = items.find((i) => i.provider === 'github')
  assert.equal(gh?.connectionId, 'conn-gh')
  assert.equal(gh?.externalId, 'o/r#7')
  assert.equal(gh?.nativeKey, '#7')
}

async function testIgnoresItemsLinkedToAnotherRun(): Promise<void> {
  const lookup = createProxyItemLookup(
    deps({
      records: [record('backlog/other.md', [runLink(OTHER_REL)])],
      frontmatter: {
        'backlog/other.md': { external_provider: 'github', external_connection: 'c', external_id: 'x#1', external_key: '#1' },
      },
    }),
  )
  const items = await lookup.proxyItemsForRun({ workspaceRoot: '/ws', statePath: STATE_PATH })
  assert.equal(items.length, 0, 'an item linked to a different run is not matched')
}

async function testSkipsUnavailableProxy(): Promise<void> {
  const lookup = createProxyItemLookup(
    deps({
      records: [record('backlog/gone.md', [runLink(RUN_REL)])],
      frontmatter: {
        'backlog/gone.md': {
          external_provider: 'github',
          external_connection: 'c',
          external_id: 'x#1',
          external_key: '#1',
          external_unavailable: 'No longer available in GitHub.',
        },
      },
    }),
  )
  const items = await lookup.proxyItemsForRun({ workspaceRoot: '/ws', statePath: STATE_PATH })
  assert.equal(items.length, 0, 'a deleted-upstream proxy is skipped — no comment to a gone issue')
}

async function testIgnoresNonProxyRunItems(): Promise<void> {
  // A native item on the run (no external identity) is not a tracker proxy.
  const lookup = createProxyItemLookup(
    deps({
      records: [record('backlog/native.md', [runLink(RUN_REL)])],
      frontmatter: { 'backlog/native.md': { status: 'in_progress' } },
    }),
  )
  const items = await lookup.proxyItemsForRun({ workspaceRoot: '/ws', statePath: STATE_PATH })
  assert.equal(items.length, 0)
}

function runLink(runRelativePath: string): BacklogItemLinkPayload {
  return {
    id: 'sprint-engine:team',
    moduleId: 'sprint-engine',
    type: 'execution',
    label: 'Sprint',
    target: { kind: 'sprintengine.run', id: 'team', path: runRelativePath },
    status: 'active',
  }
}

function record(relativePath: string, links: BacklogItemLinkPayload[]) {
  return { id: `id-${relativePath}`, source: { type: 'file' as const, relativePath }, links }
}

function deps(input: {
  records: ReturnType<typeof record>[]
  frontmatter: Record<string, Record<string, string>>
}): ProxyItemLookupDeps {
  return {
    readObjectStore: async (): Promise<BacklogReadResult> => ({
      ok: true,
      store: { schemaVersion: 1, items: input.records },
    }),
    readItemFrontmatter: async (_workspaceRoot, relativePath) => input.frontmatter[relativePath] ?? null,
  }
}

void main()
