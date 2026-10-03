import assert from 'node:assert/strict'
import { test } from 'vitest'

import { createWslPathEdge, WslEdgeError } from './wsl-path-edge'

test('a root inside the distribution and one on a drive cross as Linux paths, under the learned mount root', () => {
  const edge = createWslPathEdge({ distro: 'Ubuntu-24.04', driveMountRoot: '/win/' })
  assert.equal(edge.rootIn('\\\\wsl.localhost\\Ubuntu-24.04\\home\\dev\\repo'), '/home/dev/repo')
  assert.equal(edge.rootIn('\\\\wsl$\\ubuntu-24.04\\home\\dev\\other'), '/home/dev/other', 'either share, any case')
  assert.equal(edge.rootIn('C:\\Users\\dev\\repo'), '/win/c/Users/dev/repo')
  assert.equal(edge.rootIn('/home/dev/already'), '/home/dev/already')
  assert.throws(() => edge.rootIn('\\\\wsl.localhost\\Debian\\home\\dev'), /in WSL: Debian, not in Ubuntu-24.04/u)
  assert.throws(() => edge.rootIn('\\\\fileserver\\share\\repo'), /network share/u)
})

test('a drive path is refused in words when the distribution mounts no drives', () => {
  const edge = createWslPathEdge({ distro: 'Ubuntu', driveMountRoot: null })
  assert.throws(
    () => edge.rootIn('C:\\Users\\dev\\repo'),
    (error: unknown) => error instanceof WslEdgeError && /automount is off/u.test(error.message),
  )
  assert.equal(edge.rootIn('\\\\wsl.localhost\\Ubuntu\\home\\dev\\repo'), '/home/dev/repo', 'inside it still works')
})

test("a call's key, its MCP servers, mentions and skills are respelled; tool inputs and text are not", () => {
  const edge = createWslPathEdge({ distro: 'Ubuntu', driveMountRoot: '/mnt/' })
  const [start] = edge.args('startSession', [
    {
      workspaceRoot: 'C:\\Users\\dev\\repo',
      workspaceId: 'ws-1',
      agentId: 'a',
      providerId: 'claude',
      modelId: 'default',
      mcpServers: [
        {
          id: 'tools',
          name: 'Tools',
          transport: 'stdio',
          command: 'C:\\tools\\node.exe',
          args: ['C:\\tools\\s.js', '--flag'],
        },
        { id: 'web', name: 'Web', transport: 'http', url: 'http://127.0.0.1:9/' },
      ],
    },
  ]) as [Record<string, any>]
  assert.equal(start.workspaceRoot, '/mnt/c/Users/dev/repo')
  assert.equal(start.mcpServers[0].command, '/mnt/c/tools/node.exe')
  assert.deepEqual(start.mcpServers[0].args, ['/mnt/c/tools/s.js', '--flag'])
  assert.deepEqual(start.mcpServers[1], { id: 'web', name: 'Web', transport: 'http', url: 'http://127.0.0.1:9/' })

  const [send] = edge.args('sendTurn', [
    {
      sessionId: 's',
      message: 'look at C:\\Users\\dev\\repo\\a.ts',
      mentions: [
        { path: 'src/a.ts', kind: 'file' },
        { path: 'C:\\Users\\dev\\repo\\b.ts', kind: 'file' },
      ],
      skills: [{ id: 'x', sourcePath: 'C:\\Users\\dev\\skills\\x' }],
    },
  ]) as [Record<string, any>]
  assert.equal(send.message, 'look at C:\\Users\\dev\\repo\\a.ts', 'the message is the person’s own words')
  assert.deepEqual(
    send.mentions.map((mention: { path: string }) => mention.path),
    ['src/a.ts', '/mnt/c/Users/dev/repo/b.ts'],
  )
  assert.equal(send.skills[0].sourcePath, '/mnt/c/Users/dev/skills/x')

  const [diff, extra] = edge.args('getTurnDiff', [
    {
      key: { workspaceRoot: '\\\\wsl.localhost\\Ubuntu\\home\\dev\\repo', workspaceId: 'ws', agentId: 'a' },
      turnSeq: 3,
    },
    'kept',
  ]) as [Record<string, any>, string]
  assert.equal(diff.key.workspaceRoot, '/home/dev/repo')
  assert.equal(extra, 'kept')
})

test('typed paths that come back read as the caller spelled the root', () => {
  const edge = createWslPathEdge({ distro: 'Ubuntu', driveMountRoot: '/mnt/' })
  edge.rootIn('\\\\wsl$\\Ubuntu\\home\\dev\\repo')
  edge.rootIn('C:\\Users\\dev\\win-repo')
  assert.deepEqual(edge.result('planDocument', { ok: true, path: '/home/dev/repo/.plans/p.md' }), {
    ok: true,
    path: '\\\\wsl$\\Ubuntu\\home\\dev\\repo\\.plans\\p.md',
  })
  assert.deepEqual(edge.result('planDocument', { ok: true, path: '/home/dev/.local/share/x.md' }), {
    ok: true,
    path: '\\\\wsl.localhost\\Ubuntu\\home\\dev\\.local\\share\\x.md',
  })
  const handoff = edge.result('terminalHandoffTarget', {
    ok: true,
    target: {
      workspaceRoot: '/mnt/c/Users/dev/win-repo',
      cliRuntimes: { claude: { command: 'claude' } },
      providerSessionId: 'p',
    },
  }) as { target: Record<string, any> }
  assert.equal(handoff.target.workspaceRoot, 'C:\\Users\\dev\\win-repo')
  assert.equal(handoff.target.cliRuntimes.claude.hostId, 'wsl:Ubuntu', 'the terminal that takes over runs in WSL')
  const rules = edge.result('listApprovalRules', {
    ok: true,
    rules: [{ id: 'r', workspaceRoot: '/home/dev/repo' }],
  }) as { rules: Array<{ workspaceRoot: string }> }
  assert.equal(rules.rules[0].workspaceRoot, '\\\\wsl$\\Ubuntu\\home\\dev\\repo')
  assert.deepEqual(edge.result('listThreads', { ok: false, message: 'x' }), { ok: false, message: 'x' })
})
