import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  AGENT_INTEGRATION_LAYOUT,
  agentIntegrationRoot,
  ensureAgentIntegrationHome,
  launchPluginDirs,
  LAUNCH_REPORTER_REL,
  LAUNCH_STATUS_LINE_REL,
  pruneAgentIntegrationHomes,
} from './agent-integration-home'
import { hasUnsubstitutedTokens, TEMPLATE_COMMENT_KEY } from './skills/studio-plugin'
import { test } from 'vitest'

// Shared by the per-case tests below the legacy suite.
const TEMPLATE_ROOT = join(process.cwd(), 'resources', 'studio-plugin')
const REPORTER_SOURCE = join(process.cwd(), 'resources', 'hooks', 'sprintengine-agent-state.mjs')
const TOKENS = {
  nodeCommand: '/Applications/SprintEngine Studio.app/Contents/MacOS/Studio',
  bridgeScriptPath: '/Applications/SprintEngine Studio.app/Contents/Resources/bridge.mjs',
  userDataDir: '/Users/dev/Library/Application Support/sprintengine-studio',
  agentStateSocketPath: '/Users/dev/Library/Application Support/sprintengine-studio/agent-state.sock',
}

/** Every `$comment` key in every JSON file under `root`, as `file: key.path`. */
async function commentKeysUnder(root: string): Promise<string[]> {
  const found: string[] = []
  const walk = (value: unknown, path: string, file: string): void => {
    if (Array.isArray(value)) value.forEach((child, index) => walk(child, `${path}[${index}]`, file))
    else if (typeof value === 'object' && value !== null) {
      for (const [key, child] of Object.entries(value)) {
        if (key === TEMPLATE_COMMENT_KEY) found.push(`${file}: ${path || '<root>'}`)
        walk(child, path === '' ? key : `${path}.${key}`, file)
      }
    }
  }
  const entries = await readdir(root, { recursive: true, withFileTypes: true })
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue
    const file = join(entry.parentPath, entry.name)
    walk(JSON.parse(await readFile(file, 'utf8')), '', file.slice(root.length + 1))
  }
  return found
}

test('the copy a launch hands Claude Code carries no $comment key in any JSON file', async () => {
  // The template still explains itself — the strip is at materialisation, not
  // in the source — so this check is only meaningful while that stays true.
  assert.notDeepEqual(await commentKeysUnder(TEMPLATE_ROOT), [], 'the template keeps its explanatory comments')

  const dir = await mkdtemp(join(tmpdir(), 'sprintengine-agent-integration-'))
  const result = await ensureAgentIntegrationHome({
    templateRoot: TEMPLATE_ROOT,
    reporterSourcePath: REPORTER_SOURCE,
    userDataDir: dir,
    tokens: TOKENS,
  })
  assert.ok(result.ok, result.ok ? '' : result.message)
  // Claude Code prints `hooks.json: unknown key "$comment" ignored` for every
  // load of a plugin whose hook file carries one.
  assert.deepEqual(await commentKeysUnder(result.home.root), [])
  const hooks = JSON.parse(
    await readFile(join(result.home.root, 'sprintengine-studio', 'hooks', 'hooks.json'), 'utf8'),
  ) as { hooks: Record<string, unknown> }
  assert.ok(Object.keys(hooks.hooks).length >= 8, 'stripping the comment keeps the declaration')
})

test('a copy materialised before the comment strip is rebuilt, not trusted', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'sprintengine-agent-integration-'))
  const first = await ensureAgentIntegrationHome({
    templateRoot: TEMPLATE_ROOT,
    reporterSourcePath: REPORTER_SOURCE,
    userDataDir: dir,
    tokens: TOKENS,
  })
  assert.ok(first.ok, first.ok ? '' : first.message)
  const marker = join(first.home.root, '.installed.json')
  assert.equal((JSON.parse(await readFile(marker, 'utf8')) as { layout?: number }).layout, AGENT_INTEGRATION_LAYOUT)

  // The marker an earlier build wrote: the same plugin version, no layout.
  await writeFile(marker, JSON.stringify({ plugin: 'sprintengine-studio', version: first.home.version }), 'utf8')
  const sentinel = join(first.home.root, 'sentinel.txt')
  await writeFile(sentinel, 'should not survive', 'utf8')

  const second = await ensureAgentIntegrationHome({
    templateRoot: TEMPLATE_ROOT,
    reporterSourcePath: REPORTER_SOURCE,
    userDataDir: dir,
    tokens: TOKENS,
  })
  assert.equal(second.ok, true)
  await assert.rejects(readFile(sentinel, 'utf8'), 'an old-layout copy is replaced')
})

test('agent-integration-home', async () => {
  // The REAL bundled template and the REAL reporter, for the same reason
  // studio-plugin.test.ts uses them: a fixture would keep passing while the
  // thing that actually ships drifted out from under it.
  const TEMPLATE_ROOT = join(process.cwd(), 'resources', 'studio-plugin')
  const REPORTER_SOURCE = join(process.cwd(), 'resources', 'hooks', 'sprintengine-agent-state.mjs')
  const STATUS_LINE_SOURCE = join(process.cwd(), 'resources', 'hooks', 'sprintengine-status-line.mjs')

  const TOKENS = {
    nodeCommand: '/Applications/SprintEngine Studio.app/Contents/MacOS/Studio',
    bridgeScriptPath: '/Applications/SprintEngine Studio.app/Contents/Resources/bridge.mjs',
    userDataDir: '/Users/someone/Library/Application Support/sprintengine-studio',
    agentStateSocketPath: '/Users/someone/Library/Application Support/sprintengine-studio/agent-state.sock',
  }

  async function userData(): Promise<string> {
    return mkdtemp(join(tmpdir(), 'sprintengine-agent-integration-'))
  }

  // --- the copy a launch points at ---------------------------------------------

  async function aBuildMaterialisesItsOwnCopy(): Promise<void> {
    const dir = await userData()
    const result = await ensureAgentIntegrationHome({
      templateRoot: TEMPLATE_ROOT,
      reporterSourcePath: REPORTER_SOURCE,
      statusLineSourcePath: STATUS_LINE_SOURCE,
      userDataDir: dir,
      tokens: TOKENS,
    })
    assert.equal(result.ok, true, 'the bundled template must materialise')
    if (!result.ok) return

    assert.equal(result.home.root, agentIntegrationRoot(dir, result.home.version))
    assert.deepEqual(result.home.pluginDirs, launchPluginDirs(result.home.root))
    // One flag per plugin directory — a marketplace root loads nothing. Both
    // plugins are passed: the studio plugin (hooks, MCP bridge, studio skills)
    // and `studio-skills`, which is how the bundled workflow skills reach a
    // Claude session now that they are no longer copied into the workspace.
    assert.deepEqual(result.home.pluginDirs, [
      join(result.home.root, 'sprintengine-studio'),
      join(result.home.root, 'studio-skills'),
    ])
    // Each directory has to be a loadable plugin in its own right, with every
    // bundled workflow skill inside the second one.
    for (const dir of result.home.pluginDirs) {
      const manifest = await readFile(join(dir, '.claude-plugin', 'plugin.json'), 'utf8')
      assert.ok(JSON.parse(manifest).name, `${dir} must carry a plugin manifest`)
    }
    const shippedSkills = await readdir(join(result.home.root, 'studio-skills', 'skills'))
    for (const id of ['debug', 'backlog', 'frontend-design']) {
      assert.ok(shippedSkills.includes(id), `the launch-scoped skills plugin must carry ${id}`)
    }

    // The reporter the hook command names has to BE there. A registered hook whose
    // script is missing is the MODULE_NOT_FOUND every session reports forever.
    const reporter = await readFile(join(result.home.root, LAUNCH_REPORTER_REL), 'utf8')
    assert.ok(reporter.includes('agent_state'), 'the copied reporter must be the real one')

    // And the status-line forwarder beside it: the launch names this script in
    // its `--settings`, and it is the only way the app learns how much of a
    // session's context window is gone.
    const forwarder = await readFile(join(result.home.root, LAUNCH_STATUS_LINE_REL), 'utf8')
    assert.ok(
      forwarder.includes('usedPercentage') || forwarder.includes('StatusLine'),
      'the copied forwarder must be the real one',
    )

    // Unlike the workspace copy, this one's hook declaration is the ONLY
    // registration there is, so it must survive materialising intact.
    const hooks = await readFile(join(result.home.root, 'sprintengine-studio', 'hooks', 'hooks.json'), 'utf8')
    const parsed = JSON.parse(hooks) as { hooks: Record<string, unknown> }
    assert.ok(Object.keys(parsed.hooks).length >= 8, 'the app-owned copy keeps its hooks')
    assert.ok(hooks.includes(LAUNCH_REPORTER_REL.split('\\').join('/')), 'the hook command names the copied reporter')
    assert.equal(hasUnsubstitutedTokens(hooks), false, 'no token may survive into a materialised file')

    const mcp = await readFile(join(result.home.root, 'sprintengine-studio', '.mcp.json'), 'utf8')
    assert.equal(hasUnsubstitutedTokens(mcp), false)
    assert.ok(mcp.includes('bridge.mjs'), 'the bridge path is substituted')
  }

  // --- the settled path ---------------------------------------------------------

  async function aSecondCallLeavesTheCopyAlone(): Promise<void> {
    const dir = await userData()
    const first = await ensureAgentIntegrationHome({
      templateRoot: TEMPLATE_ROOT,
      reporterSourcePath: REPORTER_SOURCE,
      userDataDir: dir,
      tokens: TOKENS,
    })
    assert.equal(first.ok, true)
    if (!first.ok) return

    // A sentinel inside the copy: if ensure rewrote the tree it would be gone,
    // and every running agent's plugin directory would have been swapped under it.
    const sentinel = join(first.home.root, 'sentinel.txt')
    await writeFile(sentinel, 'still here', 'utf8')

    const second = await ensureAgentIntegrationHome({
      templateRoot: TEMPLATE_ROOT,
      reporterSourcePath: REPORTER_SOURCE,
      userDataDir: dir,
      tokens: TOKENS,
    })
    assert.equal(second.ok, true)
    assert.equal(await readFile(sentinel, 'utf8'), 'still here', 'a settled copy is not rewritten')
  }

  async function aHalfWrittenCopyIsNotTrusted(): Promise<void> {
    const dir = await userData()
    const first = await ensureAgentIntegrationHome({
      templateRoot: TEMPLATE_ROOT,
      reporterSourcePath: REPORTER_SOURCE,
      userDataDir: dir,
      tokens: TOKENS,
    })
    assert.equal(first.ok, true)
    if (!first.ok) return

    // The marker is what says "complete". Without it the copy is rebuilt, which is
    // what makes an interrupted install heal itself rather than launch agents at
    // a directory holding half a plugin.
    await writeFile(join(first.home.root, '.installed.json'), '{"version":"0.0.0-other"}\n', 'utf8')
    const sentinel = join(first.home.root, 'sentinel.txt')
    await writeFile(sentinel, 'should not survive', 'utf8')

    const second = await ensureAgentIntegrationHome({
      templateRoot: TEMPLATE_ROOT,
      reporterSourcePath: REPORTER_SOURCE,
      userDataDir: dir,
      tokens: TOKENS,
    })
    assert.equal(second.ok, true)
    await assert.rejects(readFile(sentinel, 'utf8'), 'a copy whose marker does not match is replaced')
  }

  // --- a build that shipped nothing ---------------------------------------------

  async function aBuildWithoutItsResourcesSaysSo(): Promise<void> {
    const dir = await userData()
    const noTemplate = await ensureAgentIntegrationHome({
      templateRoot: null,
      reporterSourcePath: REPORTER_SOURCE,
      userDataDir: dir,
      tokens: TOKENS,
    })
    assert.equal(noTemplate.ok, false)

    const noReporter = await ensureAgentIntegrationHome({
      templateRoot: TEMPLATE_ROOT,
      reporterSourcePath: join(dir, 'nothing-here.mjs'),
      userDataDir: dir,
      tokens: TOKENS,
    })
    assert.equal(noReporter.ok, false, 'a plugin whose reporter is missing must not be handed to a launch')

    // Nothing half-made left behind for a later run to trust.
    const entries = await readdir(dir)
    assert.deepEqual(entries, [], 'a failed ensure writes nothing')
  }

  // --- pruning ------------------------------------------------------------------

  async function oldVersionsAreCleanedUpAtStartup(): Promise<void> {
    const dir = await userData()
    const result = await ensureAgentIntegrationHome({
      templateRoot: TEMPLATE_ROOT,
      reporterSourcePath: REPORTER_SOURCE,
      userDataDir: dir,
      tokens: TOKENS,
    })
    assert.equal(result.ok, true)
    if (!result.ok) return

    const stale = agentIntegrationRoot(dir, '0.0.1-previous')
    await mkdir(stale, { recursive: true })
    await writeFile(join(stale, 'marker'), 'old', 'utf8')

    await pruneAgentIntegrationHomes(dir, result.home.version)
    const remaining = await readdir(join(dir, 'agent-integration'))
    assert.deepEqual(remaining, [result.home.version], 'only the version in use survives')

    // Nothing to prune is not a failure: the first run of a fresh profile.
    await pruneAgentIntegrationHomes(join(dir, 'no-such-profile'), result.home.version)
  }

  async function run(): Promise<void> {
    await aBuildMaterialisesItsOwnCopy()
    await aSecondCallLeavesTheCopyAlone()
    await aHalfWrittenCopyIsNotTrusted()
    await aBuildWithoutItsResourcesSaysSo()
    await oldVersionsAreCleanedUpAtStartup()
    console.log('agent-integration-home.test.ts: all assertions passed')
  }

  const suiteRun = run().catch((error) => {
    console.error(error)
    process.exit(1)
  })

  await suiteRun
})
