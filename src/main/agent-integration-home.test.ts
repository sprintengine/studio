import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  agentIntegrationRoot,
  ensureAgentIntegrationHome,
  launchPluginDirs,
  LAUNCH_REPORTER_REL,
  LAUNCH_STATUS_LINE_REL,
  pruneAgentIntegrationHomes,
} from './agent-integration-home'
import { hasUnsubstitutedTokens } from './skills/studio-plugin'
import { test } from 'vitest'

test('agent-integration-home', async () => {
  // The REAL bundled template and the REAL reporter, for the same reason
  // studio-plugin.test.ts uses them: a fixture would keep passing while the
  // thing that actually ships drifted out from under it.
  const TEMPLATE_ROOT = join(process.cwd(), 'resources', 'studio-plugin')
  const REPORTER_SOURCE = join(process.cwd(), 'resources', 'hooks', 'multicode-agent-state.mjs')
  const STATUS_LINE_SOURCE = join(process.cwd(), 'resources', 'hooks', 'multicode-status-line.mjs')

  const TOKENS = {
    nodeCommand: '/Applications/SprintEngine Studio.app/Contents/MacOS/Studio',
    bridgeScriptPath: '/Applications/SprintEngine Studio.app/Contents/Resources/bridge.mjs',
    userDataDir: '/Users/someone/Library/Application Support/sprintengine-studio',
    agentStateSocketPath: '/Users/someone/Library/Application Support/sprintengine-studio/agent-state.sock',
  }

  async function userData(): Promise<string> {
    return mkdtemp(join(tmpdir(), 'multicode-agent-integration-'))
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
    // One flag per plugin directory — a marketplace root loads nothing. Only the
    // studio plugin is passed: `studio-skills` would duplicate the skills
    // `builtin-skills.ts` still writes into the workspace.
    assert.deepEqual(result.home.pluginDirs, [join(result.home.root, 'sprintengine-studio')])

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

  const suiteRun = run()
    .then(() => process.exit(0))
    .catch((error) => {
      console.error(error)
      process.exit(1)
    })

  await suiteRun
})
