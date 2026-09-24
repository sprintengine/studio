// The app's Claude plugin copy as it is written into a WSL distribution: every
// path in it is the distribution's own, and every hook runs the pinned Node.

import assert from 'node:assert/strict'
import { join } from 'node:path'
import { test } from 'vitest'

import { hasUnsubstitutedTokens } from '../skills/studio-plugin'
import { buildWslPluginCopy, pinHookNode } from './wsl-plugin-copy'

const NODE = '/home/dev/.local/share/sprintengine-studio/runtime/node-v24.21.0/bin/node'
const APP = '/home/dev/.local/share/sprintengine-studio/0.4.0'

test('hook commands run the pinned Node, not whatever node is on PATH', () => {
  const pinned = pinHookNode(
    JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: 'node "/a/b.mjs" --socket "/s"' }] }] } }),
    NODE,
  )
  const parsed = JSON.parse(pinned) as { hooks: { Stop: Array<{ hooks: Array<{ command: string }> }> } }
  assert.equal(parsed.hooks.Stop[0].hooks[0].command, `'${NODE}' "/a/b.mjs" --socket "/s"`)
  assert.equal(pinHookNode('not json', NODE), 'not json')
})

test('the copy carries Linux paths throughout, and the same inputs give the same digest', async () => {
  const sources = {
    templateRoot: join(process.cwd(), 'resources', 'studio-plugin'),
    reporterSourcePath: join(process.cwd(), 'resources', 'hooks', 'sprintengine-agent-state.mjs'),
    statusLineSourcePath: join(process.cwd(), 'resources', 'hooks', 'sprintengine-status-line.mjs'),
  }
  const tokens = {
    profile: 'abc123def456',
    nodeCommand: NODE,
    appDir: APP,
    userDataDir: '/run/user/1000/sprintengine/abc123def456',
    agentStateSocketPath: '/run/user/1000/sprintengine/abc123def456/agent.sock',
  }
  const copy = await buildWslPluginCopy(sources, tokens)
  assert.ok(copy)
  assert.deepEqual(copy.pluginDirs, [
    `${APP}/plugin-abc123def456/sprintengine-studio`,
    `${APP}/plugin-abc123def456/studio-skills`,
  ])
  assert.equal(copy.statusLineScriptPath, `${APP}/plugin-abc123def456/sprintengine-studio/hooks/status-line.mjs`)
  const text = (path: string) =>
    Buffer.from(copy.files.find((file) => file.path === path)?.b64 ?? '', 'base64').toString('utf8')
  const mcp = JSON.parse(text('sprintengine-studio/.mcp.json')) as {
    mcpServers: Record<string, { command: string; args: string[]; env: Record<string, string> }>
  }
  const gateway = Object.values(mcp.mcpServers)[0]
  assert.equal(gateway.command, NODE)
  assert.deepEqual(gateway.args, [`${APP}/automation/mcp-stdio-bridge.mjs`])
  assert.equal(gateway.env.SPRINTENGINE_USER_DATA_DIR, tokens.userDataDir)
  const hooks = text('sprintengine-studio/hooks/hooks.json')
  assert.ok(
    hooks.includes(`'${NODE}' \\"${APP}/plugin-abc123def456/sprintengine-studio/hooks/agent-state.mjs\\"`),
    hooks,
  )
  assert.ok(hooks.includes(tokens.agentStateSocketPath))
  assert.ok(!/node \\"/u.test(hooks), 'no hook runs a bare node')
  for (const file of copy.files) {
    const content = Buffer.from(file.b64, 'base64').toString('utf8')
    assert.equal(hasUnsubstitutedTokens(content), false, file.path)
    assert.doesNotMatch(content, /[A-Z]:[\\/]Users|\\\\wsl/u, `${file.path} names no Windows path`)
  }
  assert.ok(copy.files.some((file) => file.path === 'sprintengine-studio/hooks/agent-state.mjs'))
  const again = await buildWslPluginCopy(sources, tokens)
  assert.equal(again?.digest, copy.digest)
  assert.equal(copy.tree, 'plugin-abc123def456', 'each profile has a tree of its own')
  const other = await buildWslPluginCopy(sources, { ...tokens, profile: 'fedcba987654' })
  assert.equal(other?.tree, 'plugin-fedcba987654')
  assert.equal(await buildWslPluginCopy({ ...sources, templateRoot: null }, tokens), null)
})
