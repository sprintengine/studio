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
    enabledSkillDirs: [] as string[],
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
  assert.deepEqual(copy.pluginDirs, [`${APP}/plugin-abc123def456/sprintengine-studio`])
  assert.deepEqual(copy.skillPluginDirs, {}, 'no launch skills without a source to write them from')
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

  // The Studio skills are the person's choice: the copy carries only those, and
  // a different choice is a different digest, so the helper writes the new tree.
  const skillsIn = (files: { path: string }[]) =>
    [
      ...new Set(
        files
          .map((file) => /^sprintengine-studio\/skills\/([^/]+)\//u.exec(file.path)?.[1])
          .filter((name): name is string => name !== undefined),
      ),
    ].sort()
  assert.deepEqual(skillsIn(copy.files), [], 'nothing chosen, no skill')
  const chosen = await buildWslPluginCopy({ ...sources, enabledSkillDirs: ['studio-canvas'] }, tokens)
  assert.ok(chosen)
  assert.deepEqual(skillsIn(chosen.files), ['studio-canvas'])
  assert.notEqual(chosen.digest, copy.digest)

  // The bundled skills a launch can ask for travel as plugins of their own,
  // named by their Linux paths in the distribution.
  const withLaunchSkills = await buildWslPluginCopy(
    { ...sources, launchSkillsSourceRoot: join(process.cwd(), 'resources', 'builtin-skills') },
    tokens,
  )
  assert.ok(withLaunchSkills)
  assert.deepEqual(withLaunchSkills.skillPluginDirs, {
    backlog: `${APP}/plugin-abc123def456/launch-skills/backlog`,
  })
  assert.ok(withLaunchSkills.files.some((file) => file.path === 'launch-skills/backlog/skills/backlog/SKILL.md'))
  assert.ok(withLaunchSkills.files.some((file) => file.path === 'launch-skills/backlog/.claude-plugin/plugin.json'))
  // Debug Mode's skill is retired: a copy made before it went differs in its
  // files, so its digest differs and the helper writes the tree again.
  assert.equal(
    withLaunchSkills.files.some((file) => file.path.startsWith('launch-skills/debug/')),
    false,
  )
  assert.equal(withLaunchSkills.pluginDirs.length, 1, 'and none of them is passed to every launch')
})
