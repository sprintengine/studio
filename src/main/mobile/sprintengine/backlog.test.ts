import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { readBacklogEpicChildren, readMobileBacklogWorkspaceSnapshot } from './backlog'
import type { MobileControlBacklogItemSnapshot } from '../../../shared/mobile-control/protocol'

const generatedAt = '2026-06-27T00:00:00.000Z'

async function setupWorkspace(files: Record<string, string>, store?: unknown): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'multicode-mobile-backlog-'))
  for (const [relativePath, content] of Object.entries(files)) {
    const abs = join(root, relativePath)
    await mkdir(dirname(abs), { recursive: true })
    await writeFile(abs, content, 'utf-8')
  }
  if (store !== undefined) {
    const storeDir = join(root, '.multi-code', 'backlog')
    await mkdir(storeDir, { recursive: true })
    await writeFile(join(storeDir, 'items.json'), `${JSON.stringify(store, null, 2)}\n`, 'utf-8')
  }
  return root
}

function bySource(items: MobileControlBacklogItemSnapshot[], relativePath: string): MobileControlBacklogItemSnapshot {
  const found = items.find((item) => item.relativePath === relativePath)
  assert.ok(found, `expected a snapshot item for ${relativePath}`)
  return found
}

const tests: Array<{ name: string; body: () => Promise<void> }> = []
function run(name: string, body: () => Promise<void>): void {
  tests.push({ name, body })
}

run('v2 item: lifecycle/triage/epic come from frontmatter; slim sidecar is not migrated over it', async () => {
  // Real v2 shape: frontmatter is the source of truth and the sidecar record is
  // slim (id/source only, no lifecycle/triage). The read path must source every
  // field from frontmatter and leave the file untouched — no lazy migration fires
  // for a slim record, so authoritative frontmatter is never clobbered.
  const frontmatter =
    '---\nstatus: ready\ntype: feature\ndifficulty: m\ncriticality: high\nepic: auth-revamp\n---\n# Checkout\n\nSpeed up checkout.\n'
  const root = await setupWorkspace(
    { 'backlog/checkout.md': frontmatter },
    {
      schemaVersion: 1,
      items: [{ id: 'item_checkout', source: { type: 'file', relativePath: 'backlog/checkout.md' } }],
    },
  )
  try {
    const snapshot = await readMobileBacklogWorkspaceSnapshot(root, generatedAt)
    assert.ok(snapshot)
    const item = bySource(snapshot.items, 'backlog/checkout.md')
    assert.equal(item.status, 'ready')
    assert.equal(item.type, 'feature')
    assert.equal(item.difficulty, 'm')
    assert.equal(item.criticality, 'high')
    assert.equal(item.epic, 'auth-revamp')
    // The read is non-mutating for a steady-state v2 record: frontmatter is preserved.
    assert.equal(await readFile(join(root, 'backlog/checkout.md'), 'utf-8'), frontmatter)
  } finally {
    await rm(root, { force: true, recursive: true })
  }
})

run('not-yet-migrated item: falls back to the sidecar record fields', async () => {
  const root = await setupWorkspace(
    { 'backlog/legacy.md': '# Legacy item\n\nNo frontmatter yet.\n' },
    {
      schemaVersion: 1,
      items: [
        {
          id: 'item_legacy',
          source: { type: 'file', relativePath: 'backlog/legacy.md' },
          status: 'in_progress',
          type: 'bug',
          difficulty: 'l',
          criticality: 'normal',
        },
      ],
    },
  )
  try {
    const snapshot = await readMobileBacklogWorkspaceSnapshot(root, generatedAt)
    assert.ok(snapshot)
    const item = bySource(snapshot.items, 'backlog/legacy.md')
    assert.equal(item.status, 'in_progress')
    assert.equal(item.type, 'bug')
    assert.equal(item.difficulty, 'l')
    assert.equal(item.criticality, 'normal')
    assert.equal(item.epic, undefined)
  } finally {
    await rm(root, { force: true, recursive: true })
  }
})

run('an epic container surfaces type: epic', async () => {
  const root = await setupWorkspace({ 'backlog/platform.md': '---\ntype: epic\n---\n# Platform\n' })
  try {
    const snapshot = await readMobileBacklogWorkspaceSnapshot(root, generatedAt)
    assert.ok(snapshot)
    assert.equal(bySource(snapshot.items, 'backlog/platform.md').type, 'epic')
  } finally {
    await rm(root, { force: true, recursive: true })
  }
})

run('a frontmatter-archived item is excluded from the active snapshot', async () => {
  const root = await setupWorkspace({
    'backlog/done.md': '---\nstatus: archived\n---\n# Done\n',
    'backlog/live.md': '---\nstatus: ready\n---\n# Live\n',
  })
  try {
    const snapshot = await readMobileBacklogWorkspaceSnapshot(root, generatedAt)
    assert.ok(snapshot)
    assert.deepEqual(snapshot.items.map((item) => item.relativePath), ['backlog/live.md'])
  } finally {
    await rm(root, { force: true, recursive: true })
  }
})

run('readBacklogEpicChildren returns the active children pointing at a slug', async () => {
  const root = await setupWorkspace({
    'backlog/child-a.md': '---\nstatus: ready\nepic: auth-revamp\n---\n# Child A\n',
    'backlog/child-b.md': '---\nstatus: in_progress\nepic: auth-revamp\n---\n# Child B\n',
    'backlog/elsewhere.md': '---\nepic: billing\n---\n# Elsewhere\n',
    'backlog/loose.md': '# Loose\n',
  })
  try {
    const children = await readBacklogEpicChildren(root, 'auth-revamp')
    assert.deepEqual(
      children.map((item) => item.relativePath).sort(),
      ['backlog/child-a.md', 'backlog/child-b.md'],
    )
    assert.deepEqual(await readBacklogEpicChildren(root, 'billing').then((items) => items.map((i) => i.relativePath)), [
      'backlog/elsewhere.md',
    ])
    assert.deepEqual(await readBacklogEpicChildren(root, 'nonexistent'), [])
  } finally {
    await rm(root, { force: true, recursive: true })
  }
})

async function main(): Promise<void> {
  for (const test of tests) {
    try {
      await test.body()
      console.log(`ok - ${test.name}`)
    } catch (error) {
      console.error(`not ok - ${test.name}`)
      throw error
    }
  }
  console.log('mobile/sprintengine/backlog.test.ts: ok')
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
