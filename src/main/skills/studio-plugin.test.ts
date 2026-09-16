// The app's own plugin, installed into a workspace.
//
// Everything here runs against the REAL bundled template under
// `resources/studio-plugin`, not a fixture: the thing that would actually break
// a workspace is the template drifting from the installer that reads it, and a
// fixture would keep passing while it did.

import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { SKILL_HARNESS_DIR } from '../../shared/skill-harnesses'
import { deriveStudioPluginRow, studioPluginRowMatches } from '../../shared/studio-plugin'
import { readSkillProvenance, SKILL_PROVENANCE_FILE } from './install'
import {
  CLAUDE_LOCAL_SETTINGS_RELATIVE_PATH,
  CLAUDE_SETTINGS_RELATIVE_PATH,
  hasUnsubstitutedTokens,
  installStudioPlugin,
  listStudioPluginSkillDirs,
  parsePluginHookRegistration,
  readStudioPluginTemplate,
  STUDIO_PLUGIN_ID,
  STUDIO_PLUGIN_NATIVE_CLAUDE_ENABLEMENT,
  STUDIO_PLUGIN_SOURCE_ID,
  STUDIO_PLUGIN_WORKSPACE_DIR,
  STUDIO_SKILLS_PLUGIN_ID,
  studioClaudePluginKey,
  substituteStudioPluginTokens,
  type StudioPluginTokens,
} from './studio-plugin'

// These suites are bundled into node_modules/.cache before they run, so
// `__dirname` says nothing about where the source lives. `npm run` sets the cwd
// to the package root, which is the one anchor that survives bundling.
const TEMPLATE_ROOT = resolve(process.cwd(), 'resources', 'studio-plugin')

function tokens(workspace: string): StudioPluginTokens {
  return {
    nodeCommand: '/Applications/SprintEngine Studio.app/Contents/MacOS/Studio',
    bridgeScriptPath: '/Applications/SprintEngine Studio.app/Contents/Resources/automation/mcp-stdio-bridge.mjs',
    userDataDir: '/Users/someone/Library/Application Support/sprintengine-studio',
    agentStateReporterPath: join(workspace, '.multicode', 'hooks', 'agent-state.mjs'),
    agentStateSocketPath: '/Users/someone/Library/Application Support/sprintengine-studio/agent-state.sock',
  }
}

async function workspaceAndReporter(): Promise<{ workspace: string; reporter: string }> {
  const workspace = await mkdtemp(join(tmpdir(), 'multicode-studio-plugin-'))
  const reporter = join(workspace, 'bundled-reporter.mjs')
  await writeFile(reporter, '// stand-in for resources/hooks/multicode-agent-state.mjs\n', 'utf8')
  return { workspace, reporter }
}

async function theTemplateShipsAndNamesItself(): Promise<void> {
  const read = await readStudioPluginTemplate(TEMPLATE_ROOT)
  assert.ok(read.ok, read.ok ? '' : read.message)
  assert.equal(read.template.version.length > 0, true)
  // The marketplace manifest is what a Claude-format marketplace is read by,
  // and the plugin entry's source must point at the directory we install from.
  const marketplace = JSON.parse(
    await readFile(join(TEMPLATE_ROOT, '.claude-plugin', 'marketplace.json'), 'utf8')
  ) as { name: string; plugins: { name: string; source: string }[] }
  assert.equal(marketplace.name, STUDIO_PLUGIN_ID)
  // That it LISTS us, at the directory we install from — not that it lists only
  // us. This marketplace is where every MCP server we ship becomes a plugin
  // (backlog/epics/plugins-from-the-official-marketplace.md), so an assertion
  // on the whole list would fail the moment the second one arrives.
  const listed = marketplace.plugins.find((entry) => entry.name === STUDIO_PLUGIN_ID)
  assert.notEqual(listed, undefined, 'the marketplace must list the plugin this installer installs')
  assert.equal(listed?.source, `./${STUDIO_PLUGIN_ID}`, 'and point at the directory it is installed from')
  // FIRST, not merely present: the catalogues draw the marketplace in listing
  // order, and our own plugin is the row the ruling puts at the top
  // (backlog/2026-09-06-studio-releases-is-a-claude-marketplace.md).
  assert.equal(marketplace.plugins[0]?.name, STUDIO_PLUGIN_ID, 'ours leads the listing')
  // Every in-tree entry has to be a directory that is actually here. The
  // bundled tree is the seed the catalogues list offline, and a listing whose
  // plugin has no manifest reads as a plugin that ships nothing.
  for (const entry of marketplace.plugins) {
    if (!entry.source.startsWith('./')) continue
    assert.equal(
      existsSync(join(TEMPLATE_ROOT, entry.source.slice(2), '.claude-plugin', 'plugin.json')),
      true,
      `${entry.name} is listed at ${entry.source}, which holds no plugin manifest`
    )
  }
  // The workflow skills are the marketplace's OTHER plugin, and they are here:
  // they moved out of `resources/skills` so one source answers for them in
  // every catalogue (studio-marketplace ruling, 2026-09-06).
  const workflow = await readdir(join(TEMPLATE_ROOT, STUDIO_SKILLS_PLUGIN_ID, 'skills'), { withFileTypes: true })
  assert.equal(
    workflow.filter((entry) => entry.isDirectory()).length,
    9,
    'the nine workflow skills ship inside the marketplace'
  )
  // Every file the plugin needs must be IN THE REPOSITORY. `.mcp.json` in
  // particular: the root `.gitignore` entry for the generated workspace config
  // is unanchored and matched this one too, which would have shipped a plugin
  // with no server at all.
  for (const relative of [['.mcp.json'], ['hooks', 'hooks.json'], ['.claude-plugin', 'plugin.json']]) {
    assert.equal(
      existsSync(join(read.template.pluginDir, ...relative)),
      true,
      `${relative.join('/')} is missing from the bundled plugin`
    )
  }
  const dirs = await listStudioPluginSkillDirs(read.template)
  assert.equal(dirs.length >= 4, true, 'one skill per area: backlog, automations, workspaces, design system')
  // …and ONLY those. The workflow skills live in the marketplace beside this
  // plugin, not inside it, precisely so a workspace open does not install
  // twelve general-purpose skills nobody asked for — and so `builtin-skills.ts`
  // stays the one installer that owns those directories.
  const workflowIds = new Set(workflow.filter((entry) => entry.isDirectory()).map((entry) => entry.name))
  for (const dirName of dirs) {
    assert.equal(workflowIds.has(dirName), false, `${dirName} is a workflow skill and must not install with the plugin`)
  }
}

async function aMissingTemplateIsNamedNotGuessed(): Promise<void> {
  const empty = await mkdtemp(join(tmpdir(), 'multicode-studio-plugin-empty-'))
  const read = await readStudioPluginTemplate(empty)
  assert.equal(read.ok, false)
  assert.match(read.ok ? '' : read.message, /missing from this build/)
  await rm(empty, { recursive: true, force: true })
}

function tokensAreSplicedSafely(): void {
  const windows: StudioPluginTokens = {
    nodeCommand: 'C:\\Program Files\\Studio\\Studio.exe',
    bridgeScriptPath: 'C:\\Program Files\\Studio\\resources\\automation\\mcp-stdio-bridge.mjs',
    userDataDir: 'C:\\Users\\Someone\\AppData\\Roaming\\sprintengine-studio',
    agentStateReporterPath: 'C:\\repo\\.multicode\\hooks\\agent-state.mjs',
    agentStateSocketPath: '\\\\.\\pipe\\multicode-agent-state-abc123',
  }
  const out = substituteStudioPluginTokens(
    '{"a":"__SPRINTENGINE_NODE__","b":"__SPRINTENGINE_AGENT_STATE_SOCKET__"}',
    windows
  )
  const parsed = JSON.parse(out) as { a: string; b: string }
  // Paths become forward slashes (Node accepts `C:/...`); the named pipe keeps
  // its backslashes, because they are the name.
  assert.equal(parsed.a, 'C:/Program Files/Studio/Studio.exe')
  assert.equal(parsed.b, '\\\\.\\pipe\\multicode-agent-state-abc123')
  assert.equal(hasUnsubstitutedTokens(out), false)
}

function aPluginDeclaringTwoCommandsIsRefused(): void {
  assert.equal(
    parsePluginHookRegistration('{"hooks":{"Stop":[{"hooks":[{"command":"a"}]}],"SessionEnd":[{"hooks":[{"command":"b"}]}]}}'),
    null
  )
  assert.equal(parsePluginHookRegistration('not json'), null)
  assert.equal(parsePluginHookRegistration('{"hooks":{}}'), null)
  const bare = parsePluginHookRegistration('{"PostToolUse":[{"matcher":"*","hooks":[{"command":"go"}]}]}')
  assert.deepEqual(bare, { command: 'go', events: [{ event: 'PostToolUse', matcher: '*' }] })
}

async function aWorkspaceOpenInstallsTheWholePlugin(): Promise<void> {
  const { workspace, reporter } = await workspaceAndReporter()
  const result = await installStudioPlugin({
    workspaceRoot: workspace,
    templateRoot: TEMPLATE_ROOT,
    harnesses: ['agents', 'claude'],
    tokens: tokens(workspace),
    agentStateReporterSourcePath: reporter,
    hooksAcknowledged: true,
    registerWithClaude: true,
  })
  assert.ok(result.ok, result.ok ? '' : result.message)
  assert.deepEqual(result.warnings, [], 'a clean install warns about nothing')

  // 1. The materialised plugin, with every token replaced.
  const materialised = join(workspace, STUDIO_PLUGIN_WORKSPACE_DIR)
  assert.equal(result.root, materialised)
  const mcp = await readFile(join(materialised, STUDIO_PLUGIN_ID, '.mcp.json'), 'utf8')
  assert.equal(hasUnsubstitutedTokens(mcp), false, 'the bridge command is rewritten at install')
  const server = (JSON.parse(mcp) as { mcpServers: Record<string, { command: string; args: string[] }> })
    .mcpServers['sprintengine-studio']
  assert.equal(server.args[0].endsWith('mcp-stdio-bridge.mjs'), true)
  // The materialised hook declaration is EMPTY while native loading is off.
  // Claude Code 2.1.266 registers our directory marketplace into its own
  // user-global registry and loads this plugin's hooks itself, so a declaration
  // here would be a SECOND registration beside the by-hand merge below — and
  // both would fire the reporter on every tool call, which is what doubled the
  // hover card's per-file ledger. It is written rather than deleted so the file
  // says the silence is deliberate.
  const hooksJson = await readFile(join(materialised, STUDIO_PLUGIN_ID, 'hooks', 'hooks.json'), 'utf8')
  assert.equal(hasUnsubstitutedTokens(hooksJson), false)
  const materialisedHooks = JSON.parse(hooksJson) as { hooks: Record<string, unknown>; $comment?: string }
  assert.deepEqual(materialisedHooks.hooks, {}, 'a natively-loaded copy of this plugin must register NOTHING')
  assert.match(materialisedHooks.$comment ?? '', /second registration/i, 'and must say why it is empty')
  assert.equal(
    hooksJson.includes('agent-state.mjs'),
    false,
    'no reporter command may survive in the copy Claude Code loads'
  )
  // The TEMPLATE still carries the real declaration: it is the authority for
  // what the by-hand merge registers, and blanking the copy must not blank it.
  const templateHooks = JSON.parse(
    await readFile(join(TEMPLATE_ROOT, STUDIO_PLUGIN_ID, 'hooks', 'hooks.json'), 'utf8')
  ) as { hooks: Record<string, unknown> }
  assert.equal(Object.keys(templateHooks.hooks).length >= 8, true, 'the template keeps the declaration the merge reads')

  // Substitution is textual, so a `$comment` that spelled a token name would be
  // rewritten into a sentence naming a path — which is what it said the first
  // time this was run against the live app. The prose must survive verbatim.
  // Only `.mcp.json` is checked: the hook declaration's copy is replaced
  // wholesale above, comment and all.
  for (const relative of [['.mcp.json']]) {
    const before = JSON.parse(
      await readFile(join(TEMPLATE_ROOT, STUDIO_PLUGIN_ID, ...relative), 'utf8')
    ) as { $comment?: string }
    const after = JSON.parse(
      await readFile(join(materialised, STUDIO_PLUGIN_ID, ...relative), 'utf8')
    ) as { $comment?: string }
    assert.equal(after.$comment, before.$comment, `${relative.join('/')}: the comment was rewritten by substitution`)
    assert.notEqual(before.$comment, undefined, `${relative.join('/')}: the template must explain itself`)
  }

  // 2. The skills, in every harness, each carrying provenance.
  assert.equal(result.skillDirNames.length >= 4, true)
  for (const harness of ['agents', 'claude'] as const) {
    for (const dirName of result.skillDirNames) {
      const dir = join(workspace, SKILL_HARNESS_DIR[harness], 'skills', dirName)
      assert.equal(existsSync(join(dir, 'SKILL.md')), true, `${harness}/${dirName} has its entry document`)
      const provenance = await readSkillProvenance(dir)
      assert.equal(provenance?.sourceId, STUDIO_PLUGIN_SOURCE_ID)
      assert.equal(provenance?.commitSha, result.version, 'the version is what a later sync compares')
    }
  }
  // 3. The hook, registered from the plugin's own declaration, into the file
  //    the claude-code manifest names — and pointing at a reporter that exists.
  assert.equal(result.hookSettingsPath, resolve(workspace, CLAUDE_LOCAL_SETTINGS_RELATIVE_PATH))
  const local = JSON.parse(await readFile(result.hookSettingsPath, 'utf8')) as {
    hooks: Record<string, { hooks: { command: string; _multicode?: string }[] }[]>
    extraKnownMarketplaces: Record<string, { source: { source: string; path: string } }>
  }
  assert.deepEqual(
    Object.keys(local.hooks).sort(),
    ['Notification', 'PostToolUse', 'SessionEnd', 'SessionStart', 'Stop', 'SubagentStart', 'SubagentStop', 'UserPromptSubmit']
  )
  const entry = local.hooks.Stop[0].hooks[0]
  assert.equal(entry._multicode, 'multicode-agent-state')
  assert.match(entry.command, /^node ".*\/\.multicode\/hooks\/agent-state\.mjs" --socket "/)
  assert.equal(existsSync(join(workspace, '.multicode', 'hooks', 'agent-state.mjs')), true)
  // PreToolUse is deliberately absent: PostToolUse alone is load-bearing.
  assert.equal('PreToolUse' in local.hooks, false)

  // 4. The two Claude keys, split across the committed and the gitignored file.
  assert.equal(result.claudePluginKey, studioClaudePluginKey())
  const project = JSON.parse(await readFile(resolve(workspace, CLAUDE_SETTINGS_RELATIVE_PATH), 'utf8')) as {
    enabledPlugins: Record<string, boolean>
  }
  assert.equal(project.enabledPlugins[studioClaudePluginKey()], true)
  assert.equal(
    'extraKnownMarketplaces' in (project as Record<string, unknown>),
    false,
    'the machine path must never land in the file a project commits'
  )
  assert.deepEqual(local.extraKnownMarketplaces[STUDIO_PLUGIN_ID].source, {
    source: 'directory',
    path: materialised,
  })

  await rm(workspace, { recursive: true, force: true })
}

async function installIsIdempotentAndPreservesWhatItFinds(): Promise<void> {
  const { workspace, reporter } = await workspaceAndReporter()
  // Someone's own settings in both files, and their own hook.
  await mkdir(join(workspace, '.claude'), { recursive: true })
  await writeFile(
    resolve(workspace, CLAUDE_SETTINGS_RELATIVE_PATH),
    JSON.stringify({ permissions: { allow: ['Bash(ls:*)'] }, enabledPlugins: { 'theirs@theirs': true } }, null, 2)
  )
  await writeFile(
    resolve(workspace, CLAUDE_LOCAL_SETTINGS_RELATIVE_PATH),
    JSON.stringify(
      {
        env: { THEIRS: '1' },
        hooks: { Stop: [{ hooks: [{ type: 'command', command: 'say done' }] }] },
        extraKnownMarketplaces: { theirs: { source: { source: 'github', repo: 'a/b' } } },
      },
      null,
      2
    )
  )

  const first = await installStudioPlugin({
    workspaceRoot: workspace,
    templateRoot: TEMPLATE_ROOT,
    harnesses: ['agents'],
    tokens: tokens(workspace),
    agentStateReporterSourcePath: reporter,
    hooksAcknowledged: true,
    registerWithClaude: true,
  })
  assert.ok(first.ok, first.ok ? '' : first.message)
  const second = await installStudioPlugin({
    workspaceRoot: workspace,
    templateRoot: TEMPLATE_ROOT,
    harnesses: ['agents'],
    tokens: tokens(workspace),
    agentStateReporterSourcePath: reporter,
    hooksAcknowledged: true,
    registerWithClaude: true,
  })
  assert.ok(second.ok, second.ok ? '' : second.message)

  const project = JSON.parse(await readFile(resolve(workspace, CLAUDE_SETTINGS_RELATIVE_PATH), 'utf8')) as {
    permissions: { allow: string[] }
    enabledPlugins: Record<string, boolean>
  }
  assert.deepEqual(project.permissions.allow, ['Bash(ls:*)'], 'someone else\u2019s settings survive')
  assert.equal(project.enabledPlugins['theirs@theirs'], true, 'someone else\u2019s plugin survives')
  assert.equal(project.enabledPlugins[studioClaudePluginKey()], true)

  const local = JSON.parse(await readFile(resolve(workspace, CLAUDE_LOCAL_SETTINGS_RELATIVE_PATH), 'utf8')) as {
    env: Record<string, string>
    hooks: Record<string, { hooks: { command: string }[] }[]>
    extraKnownMarketplaces: Record<string, unknown>
  }
  assert.deepEqual(local.env, { THEIRS: '1' })
  assert.equal('theirs' in local.extraKnownMarketplaces, true)
  const stopCommands = local.hooks.Stop.flatMap((block) => block.hooks.map((hook) => hook.command))
  assert.equal(stopCommands.includes('say done'), true, 'their own hook is preserved')
  assert.equal(
    stopCommands.filter((command) => command.includes('agent-state.mjs')).length,
    1,
    'a second install registers one reporter, not two'
  )

  await rm(workspace, { recursive: true, force: true })
}

async function anUnacknowledgedInstallStillShipsTheSkills(): Promise<void> {
  const { workspace, reporter } = await workspaceAndReporter()
  const result = await installStudioPlugin({
    workspaceRoot: workspace,
    templateRoot: TEMPLATE_ROOT,
    harnesses: ['agents'],
    tokens: tokens(workspace),
    agentStateReporterSourcePath: reporter,
    hooksAcknowledged: false,
    registerWithClaude: true,
  })
  assert.ok(result.ok, result.ok ? '' : result.message)
  assert.equal(result.hookSettingsPath, '', 'no hook is registered without the acknowledgement')
  assert.equal(result.skillDirNames.length >= 4, true, 'the skills are not held hostage by the hook')
  const local = resolve(workspace, CLAUDE_LOCAL_SETTINGS_RELATIVE_PATH)
  const parsed = JSON.parse(await readFile(local, 'utf8')) as Record<string, unknown>
  assert.equal('hooks' in parsed, false)
  await rm(workspace, { recursive: true, force: true })
}

async function unreadableSettingsAreLeftAloneNotOverwritten(): Promise<void> {
  const { workspace, reporter } = await workspaceAndReporter()
  await mkdir(join(workspace, '.claude'), { recursive: true })
  const path = resolve(workspace, CLAUDE_SETTINGS_RELATIVE_PATH)
  await writeFile(path, '{ "permissions": ', 'utf8')
  const result = await installStudioPlugin({
    workspaceRoot: workspace,
    templateRoot: TEMPLATE_ROOT,
    harnesses: ['agents'],
    tokens: tokens(workspace),
    agentStateReporterSourcePath: reporter,
    hooksAcknowledged: true,
    registerWithClaude: true,
  })
  // The skills still land; only the settings write is refused, and it says so.
  assert.ok(result.ok, result.ok ? '' : result.message)
  assert.equal(result.claudePluginKey, '')
  assert.equal(result.warnings.some((warning) => /not valid JSON/.test(warning)), true)
  assert.equal(await readFile(path, 'utf8'), '{ "permissions": ', 'the half-typed file is untouched')
  await rm(workspace, { recursive: true, force: true })
}

async function aMissingReporterStopsTheInstallBeforeItRegistersAnything(): Promise<void> {
  const workspace = await mkdtemp(join(tmpdir(), 'multicode-studio-plugin-noreporter-'))
  const result = await installStudioPlugin({
    workspaceRoot: workspace,
    templateRoot: TEMPLATE_ROOT,
    harnesses: ['agents'],
    tokens: tokens(workspace),
    agentStateReporterSourcePath: join(workspace, 'nope.mjs'),
    hooksAcknowledged: true,
    registerWithClaude: true,
  })
  assert.equal(result.ok, false)
  assert.match(result.ok ? '' : result.message, /reporter is missing/)
  assert.equal(existsSync(join(workspace, '.claude')), false, 'nothing was half-registered')
  await rm(workspace, { recursive: true, force: true })
}

async function aWorkspaceThatVanishedIsRefusedByName(): Promise<void> {
  const workspace = await mkdtemp(join(tmpdir(), 'multicode-studio-plugin-gone-'))
  await rm(workspace, { recursive: true, force: true })
  const result = await installStudioPlugin({
    workspaceRoot: workspace,
    templateRoot: TEMPLATE_ROOT,
    harnesses: ['agents'],
    tokens: tokens(workspace),
    agentStateReporterSourcePath: __filename,
    hooksAcknowledged: true,
    registerWithClaude: true,
  })
  assert.equal(result.ok, false)
  assert.match(result.ok ? '' : result.message, /no longer exists/)
  const blank = await installStudioPlugin({
    workspaceRoot: '   ',
    templateRoot: TEMPLATE_ROOT,
    harnesses: ['agents'],
    tokens: tokens('/tmp'),
    agentStateReporterSourcePath: __filename,
    hooksAcknowledged: true,
    registerWithClaude: true,
  })
  assert.equal(blank.ok, false)
}

async function handEditedSkillsAreRestoredOnTheNextOpen(): Promise<void> {
  const { workspace, reporter } = await workspaceAndReporter()
  const first = await installStudioPlugin({
    workspaceRoot: workspace,
    templateRoot: TEMPLATE_ROOT,
    harnesses: ['agents'],
    tokens: tokens(workspace),
    agentStateReporterSourcePath: reporter,
    hooksAcknowledged: true,
    registerWithClaude: true,
  })
  assert.ok(first.ok, first.ok ? '' : first.message)
  const victim = join(workspace, '.agents', 'skills', first.skillDirNames[0])
  await rm(victim, { recursive: true, force: true })
  const second = await installStudioPlugin({
    workspaceRoot: workspace,
    templateRoot: TEMPLATE_ROOT,
    harnesses: ['agents'],
    tokens: tokens(workspace),
    agentStateReporterSourcePath: reporter,
    hooksAcknowledged: true,
    registerWithClaude: true,
  })
  assert.ok(second.ok, second.ok ? '' : second.message)
  assert.equal(existsSync(join(victim, 'SKILL.md')), true, 'a built-in plugin cannot be removed by deleting it')
  await rm(workspace, { recursive: true, force: true })
}

async function skillsThePluginNoLongerShipsArePrunedOnTheNextOpen(): Promise<void> {
  // An earlier version shipped `studio-sprints`, which tells agents to call
  // sprint tools that no longer exist. The next open must take that copy out —
  // from every harness directory — while leaving alone a person's own skill and
  // a copy another source installed, even under a name the plugin once used.
  const { workspace, reporter } = await workspaceAndReporter()
  const options = {
    workspaceRoot: workspace,
    templateRoot: TEMPLATE_ROOT,
    harnesses: ['agents'] as const,
    tokens: tokens(workspace),
    agentStateReporterSourcePath: reporter,
    hooksAcknowledged: true,
    registerWithClaude: true,
  }
  const first = await installStudioPlugin(options)
  assert.ok(first.ok, first.ok ? '' : first.message)
  assert.equal(first.skillDirNames.includes('studio-sprints'), false, 'this build ships no sprint skill')

  const plant = async (harnessDir: string, name: string, marker: object | null): Promise<string> => {
    const dir = join(workspace, harnessDir, 'skills', name)
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'SKILL.md'), `---\nname: ${name}\n---\nplanted\n`, 'utf8')
    if (marker) await writeFile(join(dir, SKILL_PROVENANCE_FILE), JSON.stringify(marker), 'utf8')
    return dir
  }
  const ours = (skillId: string) => ({ sourceId: STUDIO_PLUGIN_SOURCE_ID, skillId, commitSha: '1.0.0' })
  const staleAgents = await plant(SKILL_HARNESS_DIR.agents, 'studio-sprints', ours('studio-sprints'))
  // A harness this install does not target still gets swept.
  const staleOpencode = await plant(SKILL_HARNESS_DIR.opencode, 'studio-sprints', ours('studio-sprints'))
  const usersOwn = await plant(SKILL_HARNESS_DIR.agents, 'my-sprints', null)
  const otherSource = await plant(
    SKILL_HARNESS_DIR.agents,
    'studio-roles',
    { sourceId: 'someone-elses-repo', skillId: 'studio-roles', commitSha: 'abc' },
  )

  const second = await installStudioPlugin(options)
  assert.ok(second.ok, second.ok ? '' : second.message)
  assert.deepEqual(second.warnings, [])
  assert.equal(existsSync(staleAgents), false, 'a copy this plugin installed and no longer ships is removed')
  assert.equal(existsSync(staleOpencode), false, 'from every harness directory, not only the targeted ones')
  assert.equal(existsSync(join(usersOwn, 'SKILL.md')), true, 'a skill with no marker is the person\'s and stays')
  assert.equal(existsSync(join(otherSource, 'SKILL.md')), true, 'a copy another source installed stays')
  for (const dirName of second.skillDirNames) {
    assert.equal(
      existsSync(join(workspace, SKILL_HARNESS_DIR.agents, 'skills', dirName, 'SKILL.md')),
      true,
      `${dirName} still ships and is still installed`,
    )
  }
  await rm(workspace, { recursive: true, force: true })
}

// Once the launch hands Claude Code the plugin directories itself, this
// workspace must come out of the install with none of this app's Claude wiring
// in it: no hook in the person's settings, no `enabledPlugins` entry in the
// file their colleagues commit, and no absolute machine path anywhere. The
// skills for the OTHER harnesses still install — those CLIs still read them
// from the repository.
async function aLaunchInjectedWorkspaceKeepsItsClaudeFilesClean(): Promise<void> {
  const { workspace, reporter } = await workspaceAndReporter()
  const result = await installStudioPlugin({
    workspaceRoot: workspace,
    templateRoot: TEMPLATE_ROOT,
    // What the service passes once launch injection is live: the claude harness
    // filtered out, because those copies arrive with the session instead.
    harnesses: ['agents'],
    tokens: tokens(workspace),
    agentStateReporterSourcePath: reporter,
    hooksAcknowledged: true,
    registerWithClaude: false,
  })
  assert.ok(result.ok, result.ok ? '' : result.message)
  if (!result.ok) return

  // The skills the remaining harnesses read are still installed.
  assert.ok(result.skillDirNames.length > 0, 'the other CLIs still get their skills')
  for (const dirName of result.skillDirNames) {
    const dir = join(workspace, SKILL_HARNESS_DIR.agents, 'skills', dirName)
    assert.equal(existsSync(join(dir, 'SKILL.md')), true, `${dirName} is installed for .agents`)
  }

  // And nothing Claude-shaped was written.
  assert.equal(result.hookSettingsPath, '', 'no hook is registered when the launch carries it')
  assert.equal(result.claudePluginKey, '', 'and no plugin key is claimed')
  assert.equal(
    existsSync(resolve(workspace, CLAUDE_LOCAL_SETTINGS_RELATIVE_PATH)),
    false,
    'the gitignored Claude settings file is never created'
  )
  assert.equal(
    existsSync(resolve(workspace, CLAUDE_SETTINGS_RELATIVE_PATH)),
    false,
    'and neither is the one a project commits'
  )
  assert.equal(
    existsSync(join(workspace, SKILL_HARNESS_DIR.claude, 'skills')),
    false,
    'no .claude/skills copy: Claude reads them from the directory the launch passes'
  )

  await rm(workspace, { recursive: true, force: true })
}

async function nativeEnablementIsOffAndSaysSo(): Promise<void> {
  // Measured twice, and both measurements are in the constant's comment:
  // against Claude Code 2.1.261 a workspace-scoped `directory` marketplace
  // loaded nothing until it also appeared in Claude Code's user-global
  // registry, and against 2.1.263 the published GITHUB marketplace needed that
  // registry AND a user-global `claude plugin install` — and then loaded the
  // published plugin, whose tokens are still unsubstituted.
  assert.equal(STUDIO_PLUGIN_NATIVE_CLAUDE_ENABLEMENT, false)

  // And the coupling the comment promises: when it flips, the by-hand hook
  // merge must stop, or Claude Code's registration and ours both fire the
  // agent-state reporter on every event. Asserted on the source because the
  // flag is a constant — nothing can flip it at runtime to observe the
  // behaviour, and "we'll remember" is what this test exists instead of.
  const source = await readFile(resolve(process.cwd(), 'src', 'main', 'skills', 'studio-plugin.ts'), 'utf8')
  assert.match(
    source,
    /if \(options\.registerWithClaude && !STUDIO_PLUGIN_NATIVE_CLAUDE_ENABLEMENT && options\.hooksAcknowledged\) \{/,
    'the hook merge must be gated on the flag, so flipping it stops the double registration'
  )
  // The other half of the same coupling, measured against 2.1.266 on
  // 2026-09-09: Claude Code writes a directory marketplace named in a PROJECT's
  // settings into its own user-global registry and then loads the plugin's
  // hooks natively, whatever this flag says. So while the flag is false the
  // materialised declaration must be blanked, or both registrations fire —
  // which is the bug that found this. Gated on the same flag from the other
  // side, so flipping it restores the real declaration in one move.
  // The copier is shared with the app-owned copy behind `--plugin-dir`, which
  // keeps its hooks precisely because there it IS the only registration. So the
  // coupling is now asserted on the flag the workspace caller passes.
  assert.match(
    source,
    /neuterHooks: !STUDIO_PLUGIN_NATIVE_CLAUDE_ENABLEMENT/,
    'the workspace copy must be blanked while the by-hand merge is the registration'
  )
  assert.match(
    source,
    /2\.1\.266/,
    'the finding that made native loading unavoidable belongs in the constant`s own comment'
  )
}

async function proseThatNamesATokenSurvivesVerbatim(): Promise<void> {
  // The README explains the tokens by naming them, so it must not be copied
  // through substitution — and it describes this repository's tree, not a
  // workspace's, so it is not part of what a workspace receives at all.
  const readme = await readFile(join(TEMPLATE_ROOT, 'README.md'), 'utf8')
  assert.equal(hasUnsubstitutedTokens(readme), true, 'the README must still document the token names')

  const { workspace, reporter } = await workspaceAndReporter()
  const result = await installStudioPlugin({
    workspaceRoot: workspace,
    templateRoot: TEMPLATE_ROOT,
    harnesses: ['agents'],
    tokens: tokens(workspace),
    agentStateReporterSourcePath: reporter,
    hooksAcknowledged: true,
    registerWithClaude: true,
  })
  assert.ok(result.ok, result.ok ? '' : result.message)
  assert.equal(existsSync(join(result.root, 'README.md')), false)

  // A skill that mentioned a token would keep its words too: only JSON is
  // rewritten. Prove it with a skill copy, byte-for-byte against the template.
  const dirName = result.skillDirNames[0]
  assert.equal(
    await readFile(join(result.root, STUDIO_PLUGIN_ID, 'skills', dirName, 'SKILL.md'), 'utf8'),
    await readFile(join(TEMPLATE_ROOT, STUDIO_PLUGIN_ID, 'skills', dirName, 'SKILL.md'), 'utf8')
  )
  await rm(workspace, { recursive: true, force: true })
}

async function anUnchangedSettingsFileIsNotRewritten(): Promise<void> {
  const { workspace, reporter } = await workspaceAndReporter()
  const options = {
    workspaceRoot: workspace,
    templateRoot: TEMPLATE_ROOT,
    harnesses: ['agents'] as const,
    tokens: tokens(workspace),
    agentStateReporterSourcePath: reporter,
    hooksAcknowledged: true,
    registerWithClaude: true,
  }
  const first = await installStudioPlugin({ ...options })
  assert.ok(first.ok, first.ok ? '' : first.message)
  const path = resolve(workspace, CLAUDE_SETTINGS_RELATIVE_PATH)
  const before = (await stat(path)).mtimeMs
  await new Promise((done) => setTimeout(done, 20))
  const second = await installStudioPlugin({ ...options })
  assert.ok(second.ok, second.ok ? '' : second.message)
  // `.claude/settings.json` is a file a project commits; an identical rewrite
  // would show up as a touched file in everyone's editor for nothing.
  assert.equal((await stat(path)).mtimeMs, before, 'an unchanged settings file must not be rewritten')
  await rm(workspace, { recursive: true, force: true })
}

async function everyMaterialisedFileIsFreeOfTokens(): Promise<void> {
  const { workspace, reporter } = await workspaceAndReporter()
  const result = await installStudioPlugin({
    workspaceRoot: workspace,
    templateRoot: TEMPLATE_ROOT,
    harnesses: ['agents'],
    tokens: tokens(workspace),
    agentStateReporterSourcePath: reporter,
    hooksAcknowledged: true,
    registerWithClaude: true,
  })
  assert.ok(result.ok, result.ok ? '' : result.message)
  const offenders: string[] = []
  async function walk(dir: string): Promise<void> {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) await walk(path)
      else if (entry.isFile() && hasUnsubstitutedTokens(await readFile(path, 'utf8'))) offenders.push(path)
    }
  }
  await walk(result.root)
  assert.deepEqual(offenders, [])
  await rm(workspace, { recursive: true, force: true })
}

function theBuiltinRowStatesWhatItKnows(): void {
  assert.equal(deriveStudioPluginRow(null), null, 'no status, no row')
  assert.equal(
    deriveStudioPluginRow({
      bundledVersion: '',
      installedVersion: '',
      skillDirNames: [],
      claudePluginKey: '',
      hooksAcknowledgedAt: '',
    }),
    null,
    'a build that shipped no plugin shows no row rather than an empty version'
  )

  // The status crosses IPC, so a partial or absent payload is a real input:
  // an older preload, a stub, or a handler that is not registered. It must
  // produce a row or no row, never a thrown render.
  assert.equal(deriveStudioPluginRow({} as never), null)
  assert.equal(
    deriveStudioPluginRow({ bundledVersion: '1.0.0', installedVersion: '1.0.0' } as never)?.summary,
    'Version 1.0.0. 0 skills in this workspace.'
  )

  const noWorkspace = deriveStudioPluginRow({
    bundledVersion: '1.0.0',
    installedVersion: '',
    skillDirNames: [],
    claudePluginKey: '',
    hooksAcknowledgedAt: '',
  })
  assert.deepEqual(noWorkspace?.chips, ['Plugin', 'Built in'])
  assert.match(noWorkspace?.summary ?? '', /Open a workspace/)

  const installed = deriveStudioPluginRow({
    bundledVersion: '1.0.0',
    installedVersion: '1.0.0',
    skillDirNames: ['a', 'b', 'c', 'd', 'e'],
    claudePluginKey: studioClaudePluginKey(),
    hooksAcknowledgedAt: '2026-09-06T00:00:00.000Z',
  })
  assert.deepEqual(installed?.chips, ['Plugin', 'Installed', 'Built in'])
  assert.equal(installed?.updateAvailable, false)
  assert.match(installed?.summary ?? '', /5 skills/)

  const drifted = deriveStudioPluginRow({
    bundledVersion: '1.1.0',
    installedVersion: '1.0.0',
    skillDirNames: ['a'],
    claudePluginKey: studioClaudePluginKey(),
    hooksAcknowledgedAt: '2026-09-06T00:00:00.000Z',
  })
  assert.deepEqual(drifted?.chips, ['Plugin', 'Installed', 'Built in', 'Update available'])
  assert.equal(drifted?.updateAvailable, true)
  assert.match(drifted?.summary ?? '', /1\.0\.0.*1\.1\.0/)

  // Searching the tab must not make the built-in row vanish for a query that
  // names it, and must not keep it for one that does not.
  assert.equal(studioPluginRowMatches(installed!, ''), true)
  assert.equal(studioPluginRowMatches(installed!, 'sprint'), true)
  assert.equal(studioPluginRowMatches(installed!, 'built in'), true)
  assert.equal(studioPluginRowMatches(installed!, 'telegram'), false)
}

async function main(): Promise<void> {
  await theTemplateShipsAndNamesItself()
  await aMissingTemplateIsNamedNotGuessed()
  tokensAreSplicedSafely()
  aPluginDeclaringTwoCommandsIsRefused()
  await aWorkspaceOpenInstallsTheWholePlugin()
  await installIsIdempotentAndPreservesWhatItFinds()
  await anUnacknowledgedInstallStillShipsTheSkills()
  await unreadableSettingsAreLeftAloneNotOverwritten()
  await aMissingReporterStopsTheInstallBeforeItRegistersAnything()
  await aWorkspaceThatVanishedIsRefusedByName()
  await handEditedSkillsAreRestoredOnTheNextOpen()
  await skillsThePluginNoLongerShipsArePrunedOnTheNextOpen()
  await aLaunchInjectedWorkspaceKeepsItsClaudeFilesClean()
  await nativeEnablementIsOffAndSaysSo()
  await proseThatNamesATokenSurvivesVerbatim()
  await anUnchangedSettingsFileIsNotRewritten()
  await everyMaterialisedFileIsFreeOfTokens()
  theBuiltinRowStatesWhatItKnows()
  console.log('studio plugin: ok')
}

void main()
