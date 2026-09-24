// The app's hooks, skills and MCP gateway reach the agent sessions it launches,
// not the repository those sessions run in.
//
// Each case is one promise docs/agent-launch-isolation.md makes: a CLI whose
// launch carries the app's plugin directories gets nothing written into the
// workspace, and what an earlier build wrote there is taken back out — without
// breaking a CLI that still depends on the workspace copy.

import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { test } from 'vitest'

import type { McpSyncInput } from '../shared/electron-api'
import type { LoadedPlugin, PluginAgentStateSpec } from '../shared/plugin-manifest'
import type { SkillHarness } from '../shared/skills'
import {
  AGENT_STATE_HOOK_SCRIPT_REL,
  installAgentStateReporter,
  removeWorkspaceAgentStateRegistration,
  STATUS_LINE_HOOK_SCRIPT_REL,
} from './agent-state'
import { createAgentStateService } from './agent-state-service'
import {
  BUILTIN_SKILLS,
  createBuiltinSkillManager,
  ensureSkillInstalled,
  registerModuleSkills,
  setDefaultSkillManager,
  setLaunchDeliversBundledSkillsResolver,
  unregisterModuleSkills,
} from './builtin-skills'
import { removeManagedStudioGatewayFromClaudeWorkspace } from './mcp-config-service'
import { syncStudioMcpConfig } from './studio-mcp-sync'
import { createStudioPluginService } from './studio-plugin-service'
import { applyAgentIdentityEnv } from './terminal-launch'

const RESOURCES = resolve(process.cwd(), 'resources')
const REPORTER_SOURCE = join(RESOURCES, 'hooks', 'sprintengine-agent-state.mjs')
const STATUS_LINE_SOURCE = join(RESOURCES, 'hooks', 'sprintengine-status-line.mjs')
const STUDIO_SKILLS_SOURCE = join(RESOURCES, 'studio-plugin', 'studio-skills', 'skills')
const TEMPLATE_ROOT = join(RESOURCES, 'studio-plugin')

async function bundledSpec(id: string): Promise<PluginAgentStateSpec> {
  const manifest = JSON.parse(await readFile(join(RESOURCES, 'plugins', id, 'plugin.json'), 'utf8')) as {
    agentStateSpec?: PluginAgentStateSpec
  }
  assert.ok(manifest.agentStateSpec, `${id} must declare an agentStateSpec`)
  return manifest.agentStateSpec
}

async function scratch(label: string): Promise<{ root: string; workspace: string; home: string }> {
  const root = await mkdtemp(join(tmpdir(), `sprintengine-isolation-${label}-`))
  const workspace = join(root, 'workspace')
  const home = join(root, 'home')
  await mkdir(workspace, { recursive: true })
  await mkdir(home, { recursive: true })
  return { root, workspace, home }
}

/** Install a CLI's workspace registration the way an earlier build did. */
async function installTheOldWay(workspace: string, home: string, spec: PluginAgentStateSpec): Promise<void> {
  const result = await installAgentStateReporter(workspace, spec, {
    sourceScriptPath: REPORTER_SOURCE,
    socketPath: '/tmp/sprintengine-test.sock',
    statusLineScriptPath: STATUS_LINE_SOURCE,
    homeDir: home,
    env: {},
  })
  assert.equal(result.ok, true, JSON.stringify(result))
}

// ── Agent state ─────────────────────────────────────────────────────────────

test('a workspace hooks directory the app writes ignores itself', async () => {
  const { workspace, home } = await scratch('self-ignore')
  await installTheOldWay(workspace, home, await bundledSpec('codex'))
  assert.equal(await readFile(join(workspace, '.sprintengine', 'hooks', '.gitignore'), 'utf8'), '*\n')
})

test('the Claude registration comes out, and the shared reporter stays while Codex still runs it', async () => {
  const { workspace, home } = await scratch('tidy-shared')
  const claude = await bundledSpec('claude-code')
  const codex = await bundledSpec('codex')
  await installTheOldWay(workspace, home, claude)
  await installTheOldWay(workspace, home, codex)
  assert.equal(existsSync(join(workspace, STATUS_LINE_HOOK_SCRIPT_REL)), true, 'precondition: a status line was set')

  const removed = await removeWorkspaceAgentStateRegistration(workspace, claude.registration, {
    otherSpecs: [claude, codex],
  })

  assert.ok(removed.includes('.claude/settings.local.json'))
  assert.equal(
    existsSync(join(workspace, '.claude')),
    false,
    'a settings file holding only our entries goes, and the directory it made with it',
  )
  assert.equal(existsSync(join(workspace, STATUS_LINE_HOOK_SCRIPT_REL)), false, 'the forwarder only Claude named goes')
  assert.equal(
    existsSync(join(workspace, AGENT_STATE_HOOK_SCRIPT_REL)),
    true,
    'the reporter stays: deleting it would break the Codex hook that still names it',
  )
  assert.ok((await readFile(join(workspace, '.codex', 'config.toml'), 'utf8')).includes('agent-state.mjs'))
})

test('the reporter and its directory go once no registration names them', async () => {
  const { workspace, home } = await scratch('tidy-last')
  const claude = await bundledSpec('claude-code')
  await installTheOldWay(workspace, home, claude)

  const removed = await removeWorkspaceAgentStateRegistration(workspace, claude.registration, {
    otherSpecs: [claude, await bundledSpec('codex')],
  })

  assert.ok(removed.includes(AGENT_STATE_HOOK_SCRIPT_REL))
  assert.equal(existsSync(join(workspace, '.sprintengine')), false, 'nothing of ours is left in the repository')
  assert.deepEqual(await readdir(workspace), [])

  assert.deepEqual(
    await removeWorkspaceAgentStateRegistration(workspace, claude.registration, { otherSpecs: [claude] }),
    [],
    'and a second pass finds nothing to do',
  )
})

test("a person's own settings survive the tidy, byte for byte when nothing in them is ours", async () => {
  const { workspace } = await scratch('tidy-theirs')
  const claude = await bundledSpec('claude-code')
  await mkdir(join(workspace, '.claude'), { recursive: true })
  const theirs =
    '{"permissions":{"allow":["Bash(ls)"]},   "hooks": {"Stop": [{"hooks": [{"type":"command","command":"say done"}]}]}}'
  await writeFile(join(workspace, '.claude', 'settings.local.json'), theirs, 'utf8')

  assert.deepEqual(await removeWorkspaceAgentStateRegistration(workspace, claude.registration), [])
  assert.equal(
    await readFile(join(workspace, '.claude', 'settings.local.json'), 'utf8'),
    theirs,
    'a file with nothing of ours in it is not even reformatted',
  )
})

test('a launch-injected CLI tidies the workspace instead of installing into it', async () => {
  const { root, workspace, home } = await scratch('service')
  const claude = await bundledSpec('claude-code')
  await installTheOldWay(workspace, home, claude)
  const diagnostics: string[] = []

  const service = createAgentStateService({
    resolveUserDataDir: () => join(root, 'userData'),
    resolveAgentStateSpec: (cli) => (cli === 'claude-code' ? claude : null),
    resolveReporterScriptPath: () => REPORTER_SOURCE,
    resolveStatusLineScriptPath: () => STATUS_LINE_SOURCE,
    resolveReporterTemplatePath: () => null,
    resolveHomeDir: () => home,
    resolveLaunchInjectsPlugins: () => true,
    listAgentStateSpecs: () => [claude],
    onFrame: () => undefined,
    logDiagnostic: (diagnostic) => diagnostics.push(`${diagnostic.level}: ${diagnostic.title}`),
  })

  await service.installForWorkspace(workspace, 'claude-code')

  assert.equal(existsSync(join(workspace, '.claude', 'settings.local.json')), false)
  assert.equal(existsSync(join(workspace, '.sprintengine')), false)
  assert.deepEqual(diagnostics, ['info: Workspace tidied'])
})

// ── Skills ──────────────────────────────────────────────────────────────────

test('every bundled skill ships in the plugin directory the launch carries', async () => {
  const shipped = await readdir(STUDIO_SKILLS_SOURCE)
  for (const skill of BUILTIN_SKILLS) {
    assert.ok(shipped.includes(skill.id), `${skill.id} must be in studio-skills, or a launch would not carry it`)
  }
})

test('a bundled skill is not copied for a CLI whose launch carries it, and still is for one that does not', async () => {
  const { root, workspace } = await scratch('skills')
  setDefaultSkillManager(createBuiltinSkillManager({ sourceRoot: STUDIO_SKILLS_SOURCE, listPlugins: () => [] }))
  setLaunchDeliversBundledSkillsResolver((cli) => cli === 'claude-code')
  try {
    assert.deepEqual(await ensureSkillInstalled(workspace, 'debug', { cli: 'claude-code' }), {
      ok: true,
      status: 'delivered-at-launch',
    })
    assert.deepEqual(await readdir(workspace), [], 'a Claude launch leaves the repository as it found it')

    assert.equal((await ensureSkillInstalled(workspace, 'debug', { cli: 'codex' })).ok, true)
    assert.equal(existsSync(join(workspace, '.agents', 'skills', 'debug', 'SKILL.md')), true)

    // A module's skill lives in the module, not in the plugin directory, so it
    // has no launch-scoped route and is copied whatever the CLI.
    const moduleSkill = join(root, 'module', 'skills', 'isolation-probe')
    await mkdir(moduleSkill, { recursive: true })
    await writeFile(join(moduleSkill, 'SKILL.md'), '# probe\n', 'utf8')
    registerModuleSkills('isolation', [
      { id: 'isolation-probe', sourceDir: moduleSkill, targetPolicy: 'agents', description: 'probe' },
    ])
    assert.equal((await ensureSkillInstalled(workspace, 'isolation-probe', { cli: 'claude-code' })).status, 'installed')
    assert.equal(existsSync(join(workspace, '.agents', 'skills', 'isolation-probe', 'SKILL.md')), true)
  } finally {
    unregisterModuleSkills('isolation')
    setLaunchDeliversBundledSkillsResolver(null)
    setDefaultSkillManager(null)
  }
})

function nativeSkillPlugin(id: string, harnessId: string, dir: string): LoadedPlugin {
  return {
    source: 'bundled',
    manifestPath: join('/Users/dev/plugins', id, 'plugin.json'),
    pluginRoot: join('/Users/dev/plugins', id),
    manifest: {
      id,
      displayName: id,
      version: 1,
      binary: id,
      permissionPresets: { default: { label: 'Default', args: [] } },
      launch: { argv: [id] },
      promptInjection: { mode: 'positional-arg' },
      completion: { mode: 'process-exit' },
      capabilities: { resumeSession: true, sessionIdFromCaller: true, toolUse: true, mcpServers: true },
      skillIntegration: {
        support: 'native',
        harnessId,
        installTargets: [
          { scope: 'workspace', path: `{{workspaceRoot}}/${dir}/skills/{{skillId}}`, format: 'generic' },
        ],
      },
    },
  }
}

test("another CLI's launch-time install leaves out the directory Claude now gets from its launch", async () => {
  const { workspace } = await scratch('skills-fanout')
  const plugins = [nativeSkillPlugin('claude-code', 'claude', '.claude'), nativeSkillPlugin('codex', 'codex', '.codex')]
  setDefaultSkillManager(createBuiltinSkillManager({ sourceRoot: STUDIO_SKILLS_SOURCE, listPlugins: () => plugins }))
  setLaunchDeliversBundledSkillsResolver((cli) => cli === 'claude-code')
  try {
    // Debug Mode on a Codex launch: `debug` is all-native, so it used to land in
    // every CLI's directory, `.claude/skills` included.
    assert.equal((await ensureSkillInstalled(workspace, 'debug', { cli: 'codex' })).ok, true)
    assert.equal(existsSync(join(workspace, '.codex', 'skills', 'debug', 'SKILL.md')), true)
    assert.equal(existsSync(join(workspace, '.agents', 'skills', 'debug', 'SKILL.md')), true)
    assert.equal(existsSync(join(workspace, '.claude')), false, 'no copy for the CLI whose launch carries it')

    // A Claude-only skill asked for on a Codex launch has nowhere left to go,
    // which is an answer, not an error.
    assert.deepEqual(await ensureSkillInstalled(workspace, 'frontend-design', { cli: 'codex' }), {
      ok: true,
      status: 'installed',
    })
    assert.equal(existsSync(join(workspace, '.claude')), false)

    // Where the launch cannot carry the plugin (the copy failed, or Windows),
    // the fan-out is exactly what it was.
    setLaunchDeliversBundledSkillsResolver(() => false)
    assert.equal((await ensureSkillInstalled(workspace, 'debug', { cli: 'codex' })).ok, true)
    assert.equal(existsSync(join(workspace, '.claude', 'skills', 'debug', 'SKILL.md')), true)
  } finally {
    setLaunchDeliversBundledSkillsResolver(null)
    setDefaultSkillManager(null)
  }
})

// ── MCP gateway ─────────────────────────────────────────────────────────────

const MANAGED_GATEWAY = {
  type: 'stdio',
  command: '/Applications/SprintEngine Studio.app/Contents/MacOS/SprintEngine Studio',
  args: ['/Applications/SprintEngine Studio.app/Contents/Resources/automation/mcp-stdio-bridge.mjs'],
  env: { ELECTRON_RUN_AS_NODE: '1', SPRINTENGINE_USER_DATA_DIR: '/Users/dev/Library/Application Support/studio' },
}

test("the gateway an earlier launch pinned comes out of .mcp.json, and the person's servers stay", async () => {
  const { workspace } = await scratch('mcp-keep')
  await writeFile(
    join(workspace, '.mcp.json'),
    JSON.stringify({ mcpServers: { 'sprintengine-studio': MANAGED_GATEWAY, theirs: { command: 'their-server' } } }),
    'utf8',
  )

  assert.deepEqual(await removeManagedStudioGatewayFromClaudeWorkspace(workspace), ['.mcp.json'])
  const after = JSON.parse(await readFile(join(workspace, '.mcp.json'), 'utf8')) as {
    mcpServers: Record<string, unknown>
  }
  assert.deepEqual(Object.keys(after.mcpServers), ['theirs'])
})

test('files that held only the gateway and its approval are deleted, not left empty', async () => {
  const { workspace } = await scratch('mcp-empty')
  await writeFile(
    join(workspace, '.mcp.json'),
    JSON.stringify({ mcpServers: { 'sprintengine-studio': MANAGED_GATEWAY } }),
  )
  await mkdir(join(workspace, '.claude'), { recursive: true })
  await writeFile(
    join(workspace, '.claude', 'settings.local.json'),
    JSON.stringify({ enabledMcpjsonServers: ['sprintengine-studio'] }),
  )

  assert.deepEqual(await removeManagedStudioGatewayFromClaudeWorkspace(workspace), [
    '.mcp.json',
    '.claude/settings.local.json',
  ])
  assert.deepEqual(await readdir(workspace), [])
  assert.deepEqual(await removeManagedStudioGatewayFromClaudeWorkspace(workspace), [], 'idempotent')
})

test('an entry under the gateway id that is not the bundled bridge is left alone', async () => {
  const { workspace } = await scratch('mcp-squat')
  const squatter = { command: 'node', args: ['./tools/server.mjs'] }
  await writeFile(join(workspace, '.mcp.json'), JSON.stringify({ mcpServers: { 'sprintengine-studio': squatter } }))

  assert.deepEqual(await removeManagedStudioGatewayFromClaudeWorkspace(workspace), [])
  assert.deepEqual(JSON.parse(await readFile(join(workspace, '.mcp.json'), 'utf8')), {
    mcpServers: { 'sprintengine-studio': squatter },
  })
})

test('a launch that carries the gateway pins nothing, but still writes the servers the person synced', async () => {
  const { workspace } = await scratch('mcp-sync')
  const passes: McpSyncInput[] = []
  const deps = {
    mcpConfigService: {
      sync: async (input: McpSyncInput) => {
        passes.push(input)
        return { ok: true as const, targets: [], issues: [] }
      },
    },
    studioGateway: () => ({
      command: '/bin/studio',
      args: ['/bin/bridge.mjs'],
      env: { SPRINTENGINE_USER_DATA_DIR: '/tmp/u' },
    }),
  }

  await syncStudioMcpConfig(
    {
      workspaceRoot: workspace,
      settings: { syncEnabled: false, servers: {} },
      clients: ['claude-code'],
      studioGatewayDeliveredAtLaunch: true,
    },
    deps,
  )
  assert.deepEqual(passes, [], 'no gateway pass, and nothing of the person to write')

  const theirs = {
    syncEnabled: true,
    servers: { theirs: { id: 'theirs' } as McpSyncInput['settings']['servers'][string] },
  }
  await syncStudioMcpConfig(
    { workspaceRoot: workspace, settings: theirs, clients: ['claude-code'], studioGatewayDeliveredAtLaunch: true },
    deps,
  )
  assert.equal(passes.length, 1)
  // Read back through the declared type: the empty-array assertion above
  // narrows `passes` to `never[]` for the compiler.
  const written = (passes as McpSyncInput[])[0]
  assert.deepEqual(Object.keys(written.settings.servers), ['theirs'], 'only their servers are written')
  assert.equal('studioGatewayDeliveredAtLaunch' in written, false, 'the launch flag is not handed to the writer')
})

test('the agent CLI rides the session env, so the plugin-carried gateway can still attribute calls', () => {
  const stale = { PATH: '/usr/bin', SPRINTENGINE_AGENT_CLI: 'stale' }
  assert.equal(
    applyAgentIdentityEnv(stale, { agentId: 'a-1', cli: 'claude-code' }).SPRINTENGINE_AGENT_CLI,
    'claude-code',
  )
  assert.equal(
    'SPRINTENGINE_AGENT_CLI' in applyAgentIdentityEnv(stale, {}),
    false,
    'a plain terminal inherits no stale CLI identity',
  )
})

// ── Opening a workspace ─────────────────────────────────────────────────────

async function serviceHarness(label: string) {
  const { root, workspace } = await scratch(label)
  const userData = join(root, 'userData')
  await mkdir(userData, { recursive: true })
  return {
    root,
    workspace,
    options: {
      resolveTemplateRoot: () => TEMPLATE_ROOT,
      resolveAgentStateReporterPath: () => REPORTER_SOURCE,
      resolveBridgeScriptPath: () => join(root, 'mcp-stdio-bridge.mjs'),
      resolveNodeCommand: () => join(root, 'Electron'),
      resolveUserDataDir: () => userData,
      resolveAgentStateSocketPath: () => join(userData, 'agent-state.sock'),
      listHarnesses: async (): Promise<SkillHarness[]> => ['agents', 'claude'],
    },
  }
}

test('a workspace opened while the launch copy is still landing is never installed the old way', async () => {
  const { workspace, options } = await serviceHarness('settle')
  let active = false
  let settle: () => void = () => undefined
  const settled = new Promise<void>((done) => {
    settle = () => {
      active = true
      done()
    }
  })
  const service = createStudioPluginService({
    ...options,
    resolveLaunchPluginsActive: () => active,
    whenLaunchPluginsSettled: () => settled,
  })

  const opening = service.ensureInstalled(workspace)
  settle()
  await opening

  assert.equal(service.installed(workspace)?.launchPluginsActive, true)
  assert.equal(existsSync(join(workspace, '.claude')), false, 'no hook, settings key or skill copy for Claude')
  assert.equal(existsSync(join(workspace, '.sprintengine', 'studio-plugin')), false, 'and no workspace plugin copy')
  assert.equal(existsSync(join(workspace, '.sprintengine', 'hooks')), false)
  assert.equal(existsSync(join(workspace, '.agents', 'skills')), true, 'CLIs without a launch route still get skills')
})

test("opening a workspace keeps the reporter a Codex hook still runs, while taking Claude's out", async () => {
  const { workspace, options } = await serviceHarness('shared-reporter')
  const claude = await bundledSpec('claude-code')
  const codex = await bundledSpec('codex')
  await installTheOldWay(workspace, join(workspace, '..', 'home'), claude)
  await installTheOldWay(workspace, join(workspace, '..', 'home'), codex)

  const service = createStudioPluginService({
    ...options,
    resolveLaunchPluginsActive: () => true,
    listAgentStateSpecs: () => [claude, codex],
  })
  await service.ensureInstalled(workspace)

  assert.equal(existsSync(join(workspace, '.claude', 'settings.local.json')), false)
  assert.equal(existsSync(join(workspace, AGENT_STATE_HOOK_SCRIPT_REL)), true, 'Codex still names it')
})
