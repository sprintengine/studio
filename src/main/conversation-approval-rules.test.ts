import { test, expect } from 'vitest'
import { mkdtemp, mkdir, symlink, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { ConversationApprovalRuleStore } from './conversation-approval-rules'

test('conversation grants expire; workspace grants persist and revoke without leaking across roots', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'conversation-grants-'))
  try {
    const store = new ConversationApprovalRuleStore(dir)
    const request = { action: 'Bash', input: { command: 'rg value src' } }
    await store.remember('/workspace/app', 'session', request, 'conversation')
    expect(await store.match('/workspace/app', 'session', request)).not.toBeNull()
    expect(await store.match('/workspace/app', 'other', request)).toBeNull()
    store.dropSession('session')
    expect(await store.match('/workspace/app', 'session', request)).toBeNull()
    const rule = await store.remember('/workspace/app', 'session', request, 'always')
    const reloaded = new ConversationApprovalRuleStore(dir)
    expect(await reloaded.match('/workspace/app', 'other', request)).not.toBeNull()
    expect(await reloaded.match('/workspace/other', 'other', request)).toBeNull()
    await reloaded.revoke(rule.id)
    expect(await new ConversationApprovalRuleStore(dir).list()).toEqual([])
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('symlink escapes and dangerous commands cannot create or use remembered grants', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'conversation-grant-scope-'))
  try {
    const root = join(dir, 'workspace')
    await mkdir(root)
    await mkdir(join(dir, 'outside'))
    const store = new ConversationApprovalRuleStore()
    const safe = { action: 'Write', input: { path: 'new/file.ts' } }
    await store.remember(root, 'session', safe, 'conversation')
    expect(await store.match(root, 'session', safe)).not.toBeNull()
    await symlink(join(dir, 'outside'), join(root, 'link'))
    const unsafe = { action: 'Write', input: { path: 'link/secret.ts' } }
    expect(await store.match(root, 'session', unsafe)).toBeNull()
    await expect(store.remember(root, 'session', unsafe, 'conversation')).rejects.toThrow('only be allowed once')
    await expect(
      store.remember(root, 'session', { action: 'Bash', input: { command: 'sudo ls' } }, 'conversation'),
    ).rejects.toThrow('only be allowed once')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
