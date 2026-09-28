import assert from 'node:assert/strict'
import { mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'vitest'
import { ConversationAttachmentStore } from './conversation-attachment-store'
import { ConversationPlanStore, MAX_PLAN_DOCUMENT_BYTES } from './conversation-plan-store'

const key = { workspaceRoot: '/Users/dev/app', workspaceId: 'workspace', agentId: 'agent' }
const PLAN = '# Ship the pane\n\n## Context\n\nWhy.\n'

async function withDirs(run: (userData: string, elsewhere: string) => Promise<void>): Promise<void> {
  const userData = await mkdtemp(join(tmpdir(), 'conversation-plan-store-'))
  const elsewhere = await mkdtemp(join(tmpdir(), 'conversation-plan-agent-'))
  try {
    await run(userData, elsewhere)
  } finally {
    await rm(userData, { recursive: true, force: true })
    await rm(elsewhere, { recursive: true, force: true })
  }
}

test('the agent’s own plan file is used while it still holds the plan', async () => {
  await withDirs(async (userData, elsewhere) => {
    const store = new ConversationPlanStore(userData)
    const own = join(elsewhere, 'quiet-otter.md')
    // Line endings and surrounding whitespace are not a different plan.
    await writeFile(own, `\n${PLAN.replace(/\n/g, '\r\n')}\n\n`)
    assert.deepEqual(await store.document({ ...key, plan: PLAN, planFilePath: own }), { ok: true, path: own })
    // Nothing was copied.
    assert.deepEqual(await readdir(userData), [])
  })
})

test('a plan the agent’s file has moved past is copied from the transcript', async () => {
  await withDirs(async (userData, elsewhere) => {
    const store = new ConversationPlanStore(userData)
    const own = join(elsewhere, 'quiet-otter.md')
    await writeFile(own, '# A later plan\n')
    const result = await store.document({ ...key, plan: PLAN, title: 'Ship the pane', planFilePath: own })
    assert.equal(result.ok, true)
    if (!result.ok) return
    assert.notEqual(result.path, own)
    assert.ok(result.path.startsWith(join(userData, 'conversation-plans', ConversationAttachmentStore.folderFor(key))))
    assert.match(result.path, /ship-the-pane-[0-9a-f]{12}\.md$/)
    assert.equal(await readFile(result.path, 'utf8'), `${PLAN.trim()}\n`)
    // The same plan asked for again is the same file, not a second copy.
    assert.deepEqual(await store.document({ ...key, plan: PLAN, title: 'Ship the pane' }), result)
  })
})

test('only a plain markdown file at an absolute path is taken as the agent’s file', async () => {
  await withDirs(async (userData, elsewhere) => {
    const store = new ConversationPlanStore(userData)
    const text = join(elsewhere, 'plan.txt')
    await writeFile(text, PLAN)
    const target = join(elsewhere, 'target.md')
    await writeFile(target, PLAN)
    const link = join(elsewhere, 'link.md')
    await symlink(target, link)
    for (const planFilePath of [text, link, 'relative/plan.md', join(elsewhere, 'missing.md')]) {
      const result = await store.document({ ...key, plan: PLAN, planFilePath })
      assert.equal(result.ok, true)
      if (result.ok) assert.ok(result.path.startsWith(userData), `copied instead of ${planFilePath}`)
    }
  })
})

test('an empty or oversized plan is refused, and deleting the conversation removes its copies', async () => {
  await withDirs(async (userData) => {
    const store = new ConversationPlanStore(userData)
    assert.equal((await store.document({ ...key, plan: '  \n' })).ok, false)
    assert.equal((await store.document({ ...key, plan: 'x'.repeat(MAX_PLAN_DOCUMENT_BYTES + 1) })).ok, false)
    const result = await store.document({ ...key, plan: PLAN })
    assert.equal(result.ok, true)
    await store.deleteConversation(key)
    assert.deepEqual(await readdir(join(userData, 'conversation-plans')), [])
  })
})

test('without app data only the agent’s own file can be opened', async () => {
  await withDirs(async (_userData, elsewhere) => {
    const store = new ConversationPlanStore()
    const own = join(elsewhere, 'plan.md')
    await writeFile(own, PLAN)
    assert.deepEqual(await store.document({ ...key, plan: PLAN, planFilePath: own }), { ok: true, path: own })
    assert.equal((await store.document({ ...key, plan: PLAN })).ok, false)
  })
})
