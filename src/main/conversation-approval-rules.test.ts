import { test, expect } from 'vitest'
import { mkdtemp, mkdir, readFile, symlink, rm, writeFile } from 'fs/promises'
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

test('saved program-wide command grants are narrowed on load and written back', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'conversation-grant-migrate-'))
  try {
    const legacy = (program: string) => ({
      id: program,
      workspaceRoot: '/workspace/app',
      toolKind: 'command',
      toolName: 'Bash',
      matcher: { type: 'program', program },
      label: `Bash: ${program}`,
      createdAt: 1,
    })
    const file = join(dir, 'conversation-approval-rules.json')
    await writeFile(file, JSON.stringify([legacy('git'), legacy('rg')]))
    const store = new ConversationApprovalRuleStore(dir)
    const status = { action: 'Bash', input: { command: 'git rebase --exec=./evil.sh HEAD~1' } }
    expect(await store.match('/workspace/app', 'session', status)).toBeNull()
    expect(
      await store.match('/workspace/app', 'session', { action: 'Bash', input: { command: 'rg x' } }),
    ).not.toBeNull()
    const saved = JSON.parse(await readFile(file, 'utf8'))
    expect(saved.map((rule: { id: string; matcher: unknown }) => [rule.id, rule.matcher])).toEqual([
      ['rg', { type: 'command', program: 'rg' }],
    ])
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('a file grant does not follow a symlink into the git directory', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'conversation-grant-git-'))
  try {
    const root = join(dir, 'workspace')
    await mkdir(join(root, '.git', 'hooks'), { recursive: true })
    const store = new ConversationApprovalRuleStore()
    await store.remember(root, 'session', { action: 'Write', input: { path: 'src/a.ts' } }, 'conversation')
    await symlink(join(root, '.git', 'hooks'), join(root, 'tools'))
    expect(await store.match(root, 'session', { action: 'Write', input: { path: 'tools/pre-commit' } })).toBeNull()
    expect(await store.match(root, 'session', { action: 'Write', input: { path: '.git/hooks/pre-commit' } })).toBeNull()
    expect(await store.match(root, 'session', { action: 'Write', input: { path: 'src/b.ts' } })).not.toBeNull()
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('a revoked app’s tools lose every approval, in either spelling, saved or for a session', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'conversation-grant-apps-'))
  try {
    const store = new ConversationApprovalRuleStore(dir)
    const call = (tool: string) => ({
      action: `mcp__sprintengine-studio__${tool}`,
      input: {},
      toolKind: 'mcp' as const,
    })
    await store.remember('/workspace/app', 'session', call('game_spawn_enemy'), 'always')
    await store.remember('/workspace/app', 'session', call('game.screenshot'), 'conversation')
    await store.remember('/workspace/app', 'session', call('gamepad_press'), 'always')
    await store.remember('/workspace/app', 'session', call('browser_open'), 'always')
    expect(await store.forgetGatewayToolsets(['game'])).toBe(1)
    expect(await store.match('/workspace/app', 'session', call('game_spawn_enemy'))).toBeNull()
    expect(await store.match('/workspace/app', 'session', call('game.screenshot'))).toBeNull()
    // Another toolset whose name only starts the same, and Studio's own tools, keep theirs.
    expect(await store.match('/workspace/app', 'session', call('gamepad_press'))).not.toBeNull()
    expect(await store.match('/workspace/app', 'session', call('browser_open'))).not.toBeNull()
    const saved = JSON.parse(await readFile(join(dir, 'conversation-approval-rules.json'), 'utf8')) as Array<{
      matcher: { tool: string }
    }>
    expect(saved.map((rule) => rule.matcher.tool).sort()).toEqual(['browser_open', 'gamepad_press'])
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
