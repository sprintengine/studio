import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { readBacklogEpicChildren, readMobileBacklogWorkspaceSnapshot, resolveBacklogStartContext } from './backlog'
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

run('MC-1498: the epics block carries display id, color, title, and a done/total rollup', async () => {
  const root = await setupWorkspace({
    '.multi-code/backlog/config.json': JSON.stringify({ schemaVersion: 1, key: 'MC' }),
    'backlog/epics/checkout.md': '---\ntype: epic\nid: 1493\ncolor: green\n---\n# Checkout epic\n',
    'backlog/cart.md': '---\nstatus: completed\nepic: checkout\n---\n# Cart\n',
    'backlog/pay.md': '---\nstatus: ready\nepic: checkout\n---\n# Pay\n',
    'backlog/loose.md': '---\nstatus: ready\n---\n# Loose\n',
  })
  try {
    const snapshot = await readMobileBacklogWorkspaceSnapshot(root, generatedAt)
    assert.ok(snapshot)
    const checkout = snapshot.epics?.find((epic) => epic.slug === 'checkout')
    assert.ok(checkout, 'the epics block includes the checkout epic')
    assert.equal(checkout.displayId, 'MC-1493')
    assert.equal(checkout.color, 'green')
    assert.equal(checkout.title, 'Checkout epic')
    assert.equal(checkout.totalCount, 2)
    assert.equal(checkout.doneCount, 1)
  } finally {
    await rm(root, { force: true, recursive: true })
  }
})

run('an epic launch resolves children under BOTH slug conventions', async () => {
  // The desktop's canonical epic slug is the file's stem, but an epic container
  // written as an ordinary item commonly names the epic in its own `epic:` field
  // and its children point at THAT. Matching only one convention resolves zero
  // children for the other — an epic launch that silently drops its children.
  const byStem = await setupWorkspace({
    'backlog/platform.md': '---\ntype: epic\n---\n# Platform\n\nThe epic.\n',
    'backlog/leaf.md': '---\ntype: feature\nstatus: ready\nepic: platform\n---\n# Leaf\n\nWork.\n',
  })
  try {
    const context = await resolveBacklogStartContext(byStem, 'backlog/platform.md')
    assert.equal(context.isEpic, true)
    assert.deepEqual(context.children.map((child) => child.relativePath), ['backlog/leaf.md'])
  } finally {
    await rm(byStem, { force: true, recursive: true })
  }

  const byField = await setupWorkspace({
    'backlog/2026-07-13-goal-runs.md': '---\ntype: epic\nepic: goal-runs\n---\n# Goal runs\n\nThe epic.\n',
    'backlog/child.md': '---\ntype: feature\nstatus: ready\nepic: goal-runs\n---\n# Child\n\nWork.\n',
    'backlog/other.md': '---\ntype: feature\nstatus: ready\nepic: elsewhere\n---\n# Other\n\nWork.\n',
  })
  try {
    const context = await resolveBacklogStartContext(byField, 'backlog/2026-07-13-goal-runs.md')
    assert.deepEqual(context.children.map((child) => child.relativePath), ['backlog/child.md'])
    // The epic container is never a child of itself, and a foreign epic's leaves
    // are never swept in.
    assert.equal(context.children.some((child) => child.relativePath.includes('goal-runs')), false)
    assert.equal(context.children.some((child) => child.relativePath === 'backlog/other.md'), false)
  } finally {
    await rm(byField, { force: true, recursive: true })
  }
})

run('a leaf item start is not an epic launch', async () => {
  const root = await setupWorkspace({
    'backlog/leaf.md': '---\ntype: feature\nstatus: ready\nepic: platform\n---\n# Leaf\n\nWork.\n',
  })
  try {
    const context = await resolveBacklogStartContext(root, 'backlog/leaf.md')
    assert.equal(context.isEpic, false)
    assert.deepEqual(context.children, [])
    assert.equal(context.title, 'Leaf')
    assert.equal(context.absolutePath, join(root, 'backlog/leaf.md'))
  } finally {
    await rm(root, { force: true, recursive: true })
  }
})


run('items nested in epic folders reach the phone', async () => {
  // The desktop walk and the renderer scan both recurse; this one listed only the
  // files directly under `backlog/`. Once items moved into their epic's folder
  // that showed the phone an empty backlog, so the fixture is nested on purpose —
  // a flat one cannot fail this way.
  const root = await setupWorkspace({
    'backlog/epics/auth-revamp.md': '---\ntype: epic\nstatus: in_progress\nid: 1\n---\n\n# Auth revamp\n',
    'backlog/auth-revamp/2026-09-01-token-rotation.md':
      '---\ntype: bug\nstatus: ready\nepic: auth-revamp\nid: 2\n---\n\n# Token rotation\n',
    'backlog/unfiled/2026-09-03-loose-thought.md':
      '---\ntype: spike\nstatus: idea\nid: 3\n---\n\n# Loose thought\n',
  })
  try {
    const snapshot = await readMobileBacklogWorkspaceSnapshot(root, generatedAt)
    assert.ok(snapshot)
    const paths = snapshot.items.map((item) => item.relativePath).sort()
    assert.ok(
      paths.includes('backlog/auth-revamp/2026-09-01-token-rotation.md'),
      `an item inside its epic folder reaches the phone (got ${JSON.stringify(paths)})`,
    )
    assert.ok(paths.includes('backlog/unfiled/2026-09-03-loose-thought.md'), 'and so does an unfiled one')
    assert.equal(bySource(snapshot.items, 'backlog/auth-revamp/2026-09-01-token-rotation.md').status, 'ready')
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
