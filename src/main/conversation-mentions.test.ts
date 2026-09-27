import { mkdtemp, mkdir, writeFile, symlink, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { resolveConversationMentions } from './conversation-mentions'

async function fixture(run: (workspaceRoot: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), 'conversation-mentions-'))
  try {
    await mkdir(join(root, 'src'))
    await writeFile(join(root, 'src', 'app.ts'), 'first\nsecond\nthird')
    await run(root)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}
test('a provider that reads @paths sees inline references while a tool-free provider receives bounded content', async () =>
  fixture(async (workspaceRoot) => {
    const mentions = [
      { path: 'src/app.ts', kind: 'file' as const, line: 2, endLine: 2 },
      { path: 'src', kind: 'folder' as const },
    ]
    const native = await resolveConversationMentions({
      workspaceRoot,
      mentions,
      tools: true,
      atMentions: true,
    })
    expect(native.context).toContain('@src/app.ts:2-2')
    expect(native.context).toContain('@src/')
    expect(native.context).not.toContain('second')
    const api = await resolveConversationMentions({
      workspaceRoot,
      mentions,
      tools: false,
      atMentions: false,
    })
    expect(api.context).toContain('"content":"second"')
    expect(api.context).not.toContain('first')
    expect(api.refs).toEqual(mentions)
    // A provider with tools that does not read @paths gets the plain path.
    const plain = await resolveConversationMentions({ workspaceRoot, mentions, tools: true, atMentions: false })
    expect(plain.context).toContain('\nsrc/app.ts:2-2')
    expect(plain.context).not.toContain('@src')
  }))
test('mentions refuse escapes, symlinks, binary data and per-file overflow', async () =>
  fixture(async (workspaceRoot) => {
    const base = { workspaceRoot, tools: false, atMentions: false }
    await symlink('/tmp', join(workspaceRoot, 'outside'))
    await expect(
      resolveConversationMentions({ ...base, mentions: [{ path: '../outside', kind: 'file' }] }),
    ).rejects.toThrow('outside')
    await expect(
      resolveConversationMentions({ ...base, mentions: [{ path: 'outside', kind: 'folder' }] }),
    ).rejects.toThrow('symbolic')
    await writeFile(join(workspaceRoot, 'binary'), Buffer.from([0, 1, 2]))
    await expect(
      resolveConversationMentions({ ...base, mentions: [{ path: 'binary', kind: 'file' }] }),
    ).rejects.toThrow('binary')
    await writeFile(join(workspaceRoot, 'large'), 'x'.repeat(64 * 1024 + 1))
    await expect(resolveConversationMentions({ ...base, mentions: [{ path: 'large', kind: 'file' }] })).rejects.toThrow(
      '64 KB',
    )
  }))
test('the total content cap is enforced and duplicate references count once', async () =>
  fixture(async (workspaceRoot) => {
    const mentions = []
    for (let i = 0; i < 5; i++) {
      await writeFile(join(workspaceRoot, `${i}.txt`), 'x'.repeat(64 * 1024))
      mentions.push({ path: `${i}.txt`, kind: 'file' as const })
    }
    await expect(
      resolveConversationMentions({ workspaceRoot, mentions, tools: false, atMentions: false }),
    ).rejects.toThrow('256 KB')
    const result = await resolveConversationMentions({
      workspaceRoot,
      mentions: [mentions[0], mentions[0]],
      tools: false,
      atMentions: false,
    })
    expect(result.refs).toHaveLength(1)
  }))
