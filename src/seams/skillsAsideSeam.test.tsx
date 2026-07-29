import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { installJsdomEnvironment, withInertPreloadFallback } from './jsdomEnvironment'

// ── Seam: a capability, disk to pane (T1 → T2 → T3 → T4 → T8 → T9, epic 1956) ─
//
// Every task in this epic owns one hop of one chain: T1 turns the plugin
// manifests into a harness map and reads the skill directories, T2 reads each
// CLI's own MCP config through a per-format adapter, T3 watches the paths T1 and
// T2 resolved and invalidates, T4 writes a skill into every harness directory,
// T8 renders the answer, T9 parks an invocation in a terminal. Each has its own
// suite, and none of them can show that the hops meet:
//
//  * `workspace-skills-service.test` drives its own SkillDirectoryReader stub
//    and its own hand-built plugin list, so nothing there would notice if the
//    real `resources/plugins/*/plugin.json` stopped producing the map it
//    assumes;
//  * `read-path.test` parses fixture strings, and stops before a pane;
//  * `capability-watcher.test` injects a WatchDirectory port, so no real
//    `fs.watch` event is ever delivered;
//  * `SkillsPaneBody.test` renders hand-written snapshots, so it cannot notice
//    a resolver that stopped producing them;
//  * `terminalDrop.test` builds its own payload rather than the one the pane's
//    own drag handler writes.
//
// So this suite composes the real halves: the real plugin registry over the real
// bundled manifests, the real capability service, the real MCP adapters, a real
// `fs.watch`, the real IPC registration reached through the real preload
// passthrough, and the real pane rendering the result. The only fakes are the
// terminal (`terminalList` / `terminalWrite` are recorded, not spawned) and the
// CLI availability probe the installer asks (this machine does not have all six
// CLIs, and the fan-out under test is the manifest's, not this laptop's).
//
// WHAT IS STOOD IN FOR, stated so nothing here reads as more than it is: the
// pane is its real query hook (`useAgentCapabilities`), its real view derivation
// (`buildSkillsPaneView`) and its real renderer (`SkillsPaneBody`), but not
// `SkillsPanel`'s workspace-store wiring — which agent tab is focused and where
// its folder is are the store's business, asserted in the store's own suites and
// not part of this seam.
//
// FIXTURE FIDELITY. Nothing in here writes a harness path or a config path as a
// literal: every path the fixture creates is derived from the manifest that
// declares it, so a suite that still passes after a manifest changed is proving
// the resolver followed the manifest rather than agreeing with a copy of it.
// `$HOME` is redirected into the fixture, so no test reads the real machine.
//
// Labelled SEAM: per the run-A convention.

const dom = installJsdomEnvironment()
const domWindow = dom.window as unknown as Record<string, unknown>

// The skill picker scrolls its active row into view through `CSS.escape`, which
// jsdom does not implement. Escaping the ids this suite uses is the identity, so
// the stand-in is exact for the input it sees rather than an approximation of
// the spec.
;(globalThis as unknown as Record<string, unknown>).CSS = {
  escape: (value: string) => value.replace(/([^\w-])/g, '\\$1'),
  supports: () => false,
}

const temporaryDirs: string[] = []

function temporaryDir(prefix: string): string {
  const path = mkdtempSync(join(tmpdir(), prefix))
  temporaryDirs.push(path)
  return path
}

function writeFileDeep(path: string, contents: string): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, contents, 'utf8')
}

function skillDocument(name: string, description: string): string {
  return `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n`
}

/** Poll until `predicate` holds or the budget runs out — never a bare sleep. */
async function until(label: string, predicate: () => boolean, budgetMs = 5000): Promise<void> {
  const deadline = Date.now() + budgetMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  assert.fail(`timed out waiting for ${label}`)
}

async function main(): Promise<void> {
  let failures = 0
  const check = async (name: string, fn: () => Promise<void> | void): Promise<void> => {
    try {
      await fn()
      console.log(`ok - ${name}`)
    } catch (error) {
      failures += 1
      console.error(`not ok - ${name}`)
      console.error(error)
    }
  }

  /**
   * Let mounted React finish the work a resolver answer causes. The pane's query
   * is two awaited hops deep (preload -> IPC -> two filesystem reads), so a fixed
   * number of ticks is a race; this waits on the condition instead.
   */
  const settle = async (done: () => boolean, budgetMs = 5000): Promise<void> => {
    const deadline = Date.now() + budgetMs
    while (Date.now() < deadline) {
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 10))
      })
      if (done()) return
    }
    assert.fail('timed out waiting for the pane to settle')
  }

  const React = (await import('react')).default
  const { act } = await import('react')
  const { createRoot } = await import('react-dom/client')
  const { renderToStaticMarkup } = await import('react-dom/server')
  const { ipcMain } = await import('electron')

  const { createPluginRegistry } = await import('../main/plugin-registry')
  const { createAppPluginRegistryOptions } = await import('../main/plugin-registry-instance')
  const { createMcpServerResolver } = await import('../main/mcp-config-readers/resolve-servers')
  const {
    createAgentCapabilityService,
    createFsSkillDirectoryReader,
    createWorkspaceSkillsService,
  } = await import('../main/workspace-skills-service')
  const { createCapabilityWatcher } = await import('../main/capability-watcher')
  const { createAgentSkillInstaller, createFsSkillCopyIo } = await import('../main/agent-skill-installer')
  const { registerWorkspaceSkillsIpc } = await import('../main/ipc/workspace-skills-ipc')
  const { workspaceSkillsApi } = await import('../preload/api/workspace-skills')
  const { buildHarnessMap, skillsDirFromTemplate } = await import('../shared/harness-map')
  const { buildSkillsPaneView } = await import(
    '../renderer/src/components/workspace/skills/skillsPaneModel'
  )
  const { SkillsPaneBody } = await import(
    '../renderer/src/components/workspace/skills/SkillsPaneBody'
  )
  const { useAgentCapabilities } = await import(
    '../renderer/src/components/workspace/skills/useAgentCapabilities'
  )
  const { SkillPickerPopover } = await import('../renderer/src/components/ui/SkillPickerPopover')
  const { MULTICODE_SKILL_DROP_MIME, pasteDroppedSkillIntoTerminal, setSkillDropData } = await import(
    '../renderer/src/utils/terminalDrop'
  )

  type PluginManifest = import('../shared/plugin-manifest').PluginManifest
  type PluginRegistryListEntry = import('../shared/plugin-manifest').PluginRegistryListEntry
  type AgentCapabilitiesResult = import('../shared/skills').AgentCapabilitiesResult
  type CapabilitySnapshot = import(
    '../renderer/src/components/workspace/skills/skillsPaneModel'
  ).CapabilitySnapshot
  type SkillsPaneInput = import(
    '../renderer/src/components/workspace/skills/skillsPaneModel'
  ).SkillsPaneInput
  type OkCapabilities = Extract<AgentCapabilitiesResult, { ok: true }>
  type TerminalSessionSnapshot = import('../shared/electron-api').TerminalSessionSnapshot
  type BuiltinSkill = import('../shared/electron-api').BuiltinSkill

  // ── the stage ──────────────────────────────────────────────────────────────

  const workspaceRoot = temporaryDir('skills-aside-workspace-')
  const fixtureHome = temporaryDir('skills-aside-home-')
  const userPluginRoot = temporaryDir('skills-aside-user-plugins-')
  const cacheDir = temporaryDir('skills-aside-cache-')
  const homeDir = (): string => fixtureHome

  const registry = createPluginRegistry(
    createAppPluginRegistryOptions(
      cacheDir,
      join(process.cwd(), 'resources', 'plugins'),
      userPluginRoot,
    ),
  )
  registry.loadSync()

  const listPlugins = (): PluginRegistryListEntry[] => registry.list()
  const lookupManifest = (pluginId: string): PluginManifest | undefined =>
    registry.get(pluginId)?.manifest

  // Every directory under `resources/plugins`, which is what "the twelve bundled
  // CLIs" names. Read off disk rather than from the registry on purpose: three
  // of the twelve declare `kind: "provider"` and so never enter the CLI plugin
  // list at all, and that difference is one of the twelve answers this suite has
  // to prove is truthful rather than accidental.
  const BUNDLED_ROOT = join(process.cwd(), 'resources', 'plugins')
  const BUNDLED_IDS = readdirSync(BUNDLED_ROOT).sort()

  /**
   * What each manifest declares, read once. Every expectation below is derived
   * from this rather than restated, so the suite follows a manifest change
   * instead of contradicting it.
   */
  type Declared = {
    id: string
    /** A conversation provider, not an agent CLI: no harness, no config file. */
    conversationProvider: boolean
    /** Workspace-relative skills directory, or null when none is declared. */
    skillsDir: string | null
    support: 'native' | 'prompt-shim' | 'unsupported' | null
    harnessId: string | null
    /** Absolute workspace-scope MCP config path, or null. */
    mcpWorkspacePath: string | null
    /** Absolute user-scope MCP config path, under the fixture home; null when none. */
    mcpUserPath: string | null
    mcpFormat: string | null
  }

  const declaredFor = (pluginId: string): Declared => {
    // Parsed as the raw document, not as `PluginManifest`: that type models the
    // CLI plugins only, and `kind` is exactly how a conversation provider says
    // it is not one.
    const manifest = JSON.parse(
      readFileSync(join(BUNDLED_ROOT, pluginId, 'plugin.json'), 'utf8'),
    ) as Omit<Partial<PluginManifest>, 'kind'> & { kind?: string }
    const integration = manifest.skillIntegration
    const workspaceTarget = integration?.installTargets?.find((target) => target.scope === 'workspace')
    const mcp = manifest.mcpConfig
    return {
      id: pluginId,
      conversationProvider: manifest.kind === 'provider',
      skillsDir: workspaceTarget ? skillsDirFromTemplate(workspaceTarget.path) : null,
      support: integration?.support ?? null,
      harnessId: integration?.harnessId ?? null,
      mcpWorkspacePath: mcp?.path
        ? mcp.path.replace(/\{\{\s*workspaceRoot\s*\}\}/g, workspaceRoot)
        : null,
      mcpUserPath: mcp?.userPath
        ? mcp.userPath.replace(/\{\{\s*home\s*\}\}/g, fixtureHome).replace(/^~(?=\/|$)/, fixtureHome)
        : null,
      mcpFormat: mcp?.format ?? null,
    }
  }

  /**
   * A config file's bytes AND the server ids they declare, in the format the
   * manifest names. Returning both is what lets every expectation below be the
   * ids the fixture actually wrote rather than a second hand-kept list.
   */
  type ConfigFixture = { contents: string; serverIds: string[] }

  const CONFIG_BY_FORMAT: Record<string, (prefix: string) => ConfigFixture> = {
    'claude-code': (prefix) => ({
      serverIds: [`${prefix}-stdio`, `${prefix}-http`],
      contents: JSON.stringify({
        mcpServers: {
          [`${prefix}-stdio`]: { type: 'stdio', command: 'npx', args: ['-y', `${prefix}-mcp`] },
          [`${prefix}-http`]: { type: 'http', url: `https://example.test/${prefix}` },
        },
      }, null, 2),
    }),
    codex: (prefix) => ({
      serverIds: [`${prefix}-stdio`],
      contents: [
        'model = "gpt-5.6-sol"',
        '',
        `[mcp_servers.${prefix}-stdio]`,
        'command = "npx"',
        `args = ["-y", "${prefix}-mcp"]`,
        '',
      ].join('\n'),
    }),
    opencode: (prefix) => ({
      serverIds: [`${prefix}-stdio`],
      contents: JSON.stringify({
        mcp: { [`${prefix}-stdio`]: { type: 'local', command: ['npx', '-y', `${prefix}-mcp`] } },
      }, null, 2),
    }),
  }

  const configFixture = (format: string, prefix: string): ConfigFixture => {
    const write = CONFIG_BY_FORMAT[format]
    assert.ok(write, `no fixture writer for declared MCP format ${format}`)
    return write(prefix)
  }

  // ── the fixture, written from the manifests ────────────────────────────────
  //
  // Every harness that declares a workspace skills directory gets exactly one
  // skill, and every CLI that declares a workspace MCP config gets a config in
  // its declared format. The directory names come from `skillsDirFromTemplate`,
  // so `.claude/skills` is never typed here.

  const harnessSkillId = (harnessId: string): string => `${harnessId}-skill`
  // One skill every native harness holds, so a drag can be dropped on a CLI
  // that genuinely reads it. `${harnessId}-skill` is the opposite case: one
  // harness only, which is what proves a CLI is never handed a native form for
  // a skill it cannot see.
  const SHARED_SKILL_ID = 'shared-skill'

  /** Server ids the fixture wrote at each absolute config path. */
  const seededServerIds = new Map<string, string[]>()
  const seededHarnesses = new Set<string>()

  for (const id of BUNDLED_IDS) {
    const declared = declaredFor(id)
    if (declared.skillsDir && declared.harnessId && declared.support !== 'unsupported'
      && !seededHarnesses.has(declared.harnessId)) {
      seededHarnesses.add(declared.harnessId)
      const skillId = harnessSkillId(declared.harnessId)
      writeFileDeep(
        join(workspaceRoot, ...declared.skillsDir.split('/'), skillId, 'SKILL.md'),
        skillDocument(skillId, `Reachable from ${declared.harnessId}. Second sentence, not shown on the row.`),
      )
      writeFileDeep(
        join(workspaceRoot, ...declared.skillsDir.split('/'), SHARED_SKILL_ID, 'SKILL.md'),
        skillDocument(SHARED_SKILL_ID, 'Attached everywhere.'),
      )
    }
    if (!declared.mcpFormat) continue
    // Both scopes the manifest declares, each with its own server id, so a
    // reader that silently dropped one scope is visible rather than plausible.
    for (const [scope, path] of [
      ['workspace', declared.mcpWorkspacePath],
      ['user', declared.mcpUserPath],
    ] as const) {
      if (!path || seededServerIds.has(path)) continue
      const fixture = configFixture(declared.mcpFormat, `${declared.mcpFormat}-${scope}`)
      seededServerIds.set(path, fixture.serverIds)
      writeFileDeep(path, fixture.contents)
    }
  }

  // ── the real services, wired once ──────────────────────────────────────────

  const mcpResolver = createMcpServerResolver({ homeDir })
  const capabilityWatcher = createCapabilityWatcher({
    listPlugins,
    lookupManifest,
    homeDir,
    // Short enough that a test does not wait on a UI-tuned debounce; the
    // coalescing behaviour itself is `capability-watcher.test`'s business.
    debounceMs: 20,
    log: () => {},
  })
  const agentCapabilities = createAgentCapabilityService({
    reader: createFsSkillDirectoryReader(),
    listPlugins,
    lookupManifest,
    mcpResolver,
    freshness: capabilityWatcher,
  })
  const agentSkillInstaller = createAgentSkillInstaller({
    listPlugins,
    // The fan-out under test is the one the manifests declare. Probing this
    // laptop would make the assertion depend on which CLIs happen to be
    // installed on whichever machine runs the suite.
    detectAvailability: async () => Object.fromEntries(
      listPlugins().map((plugin) => [plugin.id, { installed: true, version: '0' }]),
    ) as never,
    io: createFsSkillCopyIo(),
    invalidate: (root, harnessId) => capabilityWatcher.invalidate(root, harnessId),
  })

  registerWorkspaceSkillsIpc(ipcMain, {
    workspaceSkills: createWorkspaceSkillsService(),
    agentCapabilities,
    capabilityWatcher,
    agentSkillInstaller,
  })

  // ── the renderer's side of the wire ────────────────────────────────────────

  const terminalWrites: Array<{ sessionId: string; data: string }> = []
  let terminalSessions: TerminalSessionSnapshot[] = []
  const builtinCatalogue: BuiltinSkill[] = [
    {
      id: 'review-guide',
      name: 'review-guide',
      version: '1',
      description: 'Build the walkthrough a human reviewer reads.',
      targetPolicy: 'all-native',
    } as BuiltinSkill,
  ]

  domWindow.api = withInertPreloadFallback({
    ...workspaceSkillsApi,
    pluginsList: async () => ({ ok: true as const, plugins: listPlugins() }),
    builtinSkillsList: async () => builtinCatalogue,
    terminalList: async () => terminalSessions,
    terminalWrite: async (sessionId: string, data: string) => {
      terminalWrites.push({ sessionId, data })
      return { ok: true }
    },
  })

  const api = domWindow.api as {
    agentCapabilities: (input: { workspaceRoot: string; pluginId: string }) => Promise<AgentCapabilitiesResult>
    agentSkillAttach: (input: { workspaceRoot: string; skillId: string }) => Promise<unknown>
  }

  const resolveThroughIpc = (pluginId: string): Promise<AgentCapabilitiesResult> =>
    api.agentCapabilities({ workspaceRoot, pluginId })

  const snapshotOf = (result: OkCapabilities): CapabilitySnapshot => ({
    support: result.support,
    harnessId: result.harnessId,
    skills: result.skills,
    servers: result.servers,
    diagnostics: result.diagnostics,
  })

  /** The pane's own markup for a resolver answer — T8's renderer, not a copy. */
  const renderPane = (
    result: OkCapabilities,
    overrides: Partial<SkillsPaneInput> = {},
    agentLabel = 'Test agent',
  ): string => {
    const view = buildSkillsPaneView({
      snapshot: snapshotOf(result),
      loading: false,
      unavailableMessage: null,
      agentLabel,
      query: '',
      catalogue: [],
      restartPending: [],
      writeReport: null,
      useError: null,
      ...overrides,
    })
    return renderToStaticMarkup(
      <SkillsPaneBody
        view={view}
        expandedKey={null}
        pendingSkillId={null}
        canWrite={result.support !== 'unsupported'}
        canUse={result.support !== 'unsupported'}
        agentLabel={agentLabel}
        implicitInvocation={false}
        onExpand={() => {}}
        onAdd={() => {}}
        onRemove={() => {}}
        onUse={() => {}}
        onDragStart={() => {}}
        onRetry={() => {}}
        onOpenExtensions={() => {}}
        onDismissWriteReport={() => {}}
        onDismissUseError={() => {}}
      />,
    )
  }

  // ── 1. every bundled CLI answers truthfully, from its own manifest ─────────
  //
  // Crosses T1 (harness map + skill read) and T2 (MCP read), over the real
  // manifests, and renders each answer through T8.

  await check('twelve bundled plugins ship, nine of them agent CLIs', () => {
    assert.equal(BUNDLED_IDS.length, 12)
    const declared = BUNDLED_IDS.map(declaredFor)
    // The three conversation providers are bundled plugins but not CLIs: no
    // binary, no harness, no config file. They are covered below anyway — the
    // pane is addressed by plugin id and must answer for one truthfully.
    assert.deepEqual(
      declared.filter((entry) => entry.conversationProvider).map((entry) => entry.id),
      ['claude-agent', 'openrouter', 'xai'],
    )
    assert.deepEqual(
      listPlugins().map((plugin) => plugin.id).sort(),
      declared.filter((entry) => !entry.conversationProvider).map((entry) => entry.id).sort(),
    )
  })

  await check('all three skill-support shapes are represented in the twelve', () => {
    const declared = BUNDLED_IDS.map(declaredFor)
    assert.equal(declared.filter((entry) => entry.support === 'native').length, 6)
    assert.equal(declared.filter((entry) => entry.support === 'unsupported').length, 1)
    assert.equal(declared.filter((entry) => entry.support === null).length, 5)
    assert.equal(declared.filter((entry) => entry.mcpWorkspacePath !== null).length, 7)
  })

  for (const pluginId of BUNDLED_IDS) {
    await check(`${pluginId}: the pane gets its skills, its servers, or a stated reason`, async () => {
      const declared = declaredFor(pluginId)
      const result = await resolveThroughIpc(pluginId)
      assert.ok(result.ok, `${pluginId} must resolve; a CLI is never an un-askable question`)

      // A CLI that declares no skill integration and one that declares
      // `unsupported` are BOTH support: 'unsupported' — and must still be
      // distinguishable, which is what the harness id carries.
      assert.equal(result.support, declared.support ?? 'unsupported')
      assert.equal(result.harnessId, declared.harnessId ?? '')

      if (declared.support === 'native' && declared.skillsDir && declared.harnessId) {
        assert.deepEqual(
          result.skills.map((skill) => skill.id).sort(),
          [harnessSkillId(declared.harnessId), SHARED_SKILL_ID].sort(),
          `${pluginId} reads ${declared.skillsDir}`,
        )
        // Attribution, not a per-CLI copy: every CLI on this harness is named.
        const bound = buildHarnessMap(listPlugins()).byHarness.get(declared.harnessId)
        assert.deepEqual(result.skills[0].pluginIds, bound?.pluginIds)
        // The form comes from this CLI's own manifest template, never guessed.
        const template = lookupManifest(pluginId)?.skillIntegration?.invocation?.explicitTemplate
        if (template) {
          assert.equal(
            result.skills.find((skill) => skill.id === SHARED_SKILL_ID)?.invocation,
            template.replace('{{skillId}}', SHARED_SKILL_ID),
          )
        }
      } else {
        assert.deepEqual(result.skills, [], `${pluginId} declares no readable skills directory`)
      }

      // Every scope this CLI's manifest declares, and nothing else: the ids the
      // fixture recorded when it wrote each file, never a restated list.
      const expectedByPath = new Map<string, { scope: 'workspace' | 'user'; ids: string[] }>()
      if (declared.mcpWorkspacePath) {
        expectedByPath.set(declared.mcpWorkspacePath, {
          scope: 'workspace',
          ids: seededServerIds.get(declared.mcpWorkspacePath) ?? [],
        })
      }
      if (declared.mcpUserPath) {
        expectedByPath.set(declared.mcpUserPath, {
          scope: 'user',
          ids: seededServerIds.get(declared.mcpUserPath) ?? [],
        })
      }
      assert.deepEqual(
        result.servers.map((server) => server.id).sort(),
        [...expectedByPath.values()].flatMap((entry) => entry.ids).sort(),
        `${pluginId} reads exactly the config files its manifest declares`,
      )
      for (const server of result.servers) {
        const expected = expectedByPath.get(server.configPath)
        assert.ok(expected, `${pluginId} read a path its manifest does not declare: ${server.configPath}`)
        assert.equal(server.scope, expected.scope)
        assert.ok(expected.ids.includes(server.id))
      }

      // Nothing in this fixture is unreadable, so no read fault may be invented.
      assert.deepEqual(
        result.diagnostics.filter((entry) => entry.capability !== 'freshness'),
        [],
      )

      // And the pane renders that answer rather than a bare empty list.
      const markup = renderPane(result, {}, pluginId)
      if (result.support === 'unsupported') {
        assert.match(markup, new RegExp(`${pluginId} does not read skills`))
      }
      if (result.skills.length === 0 && result.servers.length === 0) {
        assert.match(markup, /No skills or MCP servers for this agent\./)
      } else {
        assert.doesNotMatch(markup, /No skills or MCP servers for this agent\./)
      }
    })
  }

  await check('no surface renders a tool count the resolver never read', async () => {
    const result = await resolveThroughIpc('claude-code')
    assert.ok(result.ok)
    assert.ok(result.servers.length > 0, 'the fixture must have servers for this to mean anything')
    for (const server of result.servers) {
      assert.equal('toolCount' in server, false, 'no config file states a tool count')
    }
    const markup = renderPane(result)
    assert.doesNotMatch(markup, /tabular-nums[^>]*>0</, 'an unstated count is absent, never 0')
  })

  await check('the pane renders exactly what the resolver returned, and nothing else', async () => {
    const result = await resolveThroughIpc('claude-code')
    assert.ok(result.ok)
    const markup = renderPane(result, {}, 'Claude Code')

    // Section counts are what is on screen, so they must equal what came back.
    const counts = [...markup.matchAll(/>(Skills|MCP servers)<\/span><span class="[^"]*tabular-nums[^"]*">(\d+)</g)]
      .map((match) => [match[1], Number(match[2])] as const)
    assert.deepEqual(
      Object.fromEntries(counts),
      { Skills: result.skills.length, 'MCP servers': result.servers.length },
    )

    // And every row title is an id the resolver returned. A surface inventing a
    // row is the same defect as inventing a count, one level up.
    const rowTitles = [...markup.matchAll(/aria-label="Use ([^"]+?) in Claude Code"/g)].map((m) => m[1])
    const resolved = new Set(result.skills.map((skill) => skill.id))
    for (const title of rowTitles) assert.ok(resolved.has(title), `the pane invented a row: ${title}`)
  })

  // ── 2. a thirteenth CLI, from a manifest alone ─────────────────────────────
  //
  // The services above were built before this plugin existed and are not
  // rebuilt: the only new input is the manifest, which is the epic's acceptance
  // test for the whole backend (decision 2).

  const ATLAS_HARNESS = 'atlas'
  const ATLAS_SKILLS_DIR = '.atlas/skills'
  const ATLAS_MCP = '.atlas/mcp.json'

  await check('a thirteenth CLI appears in the pane from its manifest alone', async () => {
    writeFileDeep(join(userPluginRoot, 'atlas', 'plugin.json'), JSON.stringify({
      id: 'atlas',
      displayName: 'Atlas',
      publisher: 'test',
      version: 1,
      binary: 'atlas',
      permissionPresets: { default: { label: 'Default', args: [] } },
      launch: { argv: ['{{binary}}'] },
      promptInjection: { mode: 'positional-arg' },
      completion: { mode: 'process-exit' },
      mcpConfig: { path: `{{workspaceRoot}}/${ATLAS_MCP}`, format: 'claude-code' },
      skillIntegration: {
        support: 'native',
        harnessId: ATLAS_HARNESS,
        installTargets: [{
          scope: 'workspace',
          path: `{{workspaceRoot}}/${ATLAS_SKILLS_DIR}/{{skillId}}`,
          format: 'claude-code',
          restartRequired: false,
        }],
        invocation: { explicitTemplate: '/{{skillId}}', nativeSlashCommand: true },
      },
      capabilities: {
        resumeSession: false, sessionIdFromCaller: false, toolUse: true, mcpServers: true,
      },
    }, null, 2))
    writeFileDeep(
      join(workspaceRoot, ...ATLAS_SKILLS_DIR.split('/'), 'atlas-skill', 'SKILL.md'),
      skillDocument('atlas-skill', 'Only Atlas reads this.'),
    )
    const atlasConfig = configFixture('claude-code', 'atlas')
    writeFileDeep(join(workspaceRoot, ...ATLAS_MCP.split('/')), atlasConfig.contents)

    const report = registry.loadSync()
    assert.equal(
      report.rejected.filter((entry) => entry.manifestPath.includes('atlas')).length,
      0,
      'the thirteenth manifest must be accepted as written',
    )

    const result = await resolveThroughIpc('atlas')
    assert.ok(result.ok)
    assert.equal(result.harnessId, ATLAS_HARNESS)
    assert.deepEqual(result.skills.map((skill) => skill.id), ['atlas-skill'])
    assert.deepEqual(result.servers.map((server) => server.id).sort(), [...atlasConfig.serverIds].sort())

    // End to end, not at the resolver alone: the rendered pane carries them.
    const markup = renderPane(result, {}, 'Atlas')
    assert.match(markup, /atlas-skill/)
    assert.match(markup, new RegExp(atlasConfig.serverIds[0]))
    assert.match(markup, /Only Atlas reads this\./)
    assert.doesNotMatch(markup, /No skills or MCP servers for this agent\./)

    // And the invocation is rendered from the thirteenth manifest's own
    // template — the only place a CLI's form is allowed to come from.
    assert.equal(result.skills[0].invocation, '/atlas-skill')
  })

  await check('the twelve keep their own answers once a thirteenth is loaded', async () => {
    const claude = await resolveThroughIpc('claude-code')
    assert.ok(claude.ok)
    assert.deepEqual(
      claude.skills.map((skill) => skill.id).sort(),
      [harnessSkillId('claude'), SHARED_SKILL_ID].sort(),
    )
    assert.equal(claude.harnessId, 'claude')
  })

  // ── 3. a malformed config reaches the pane as a named fault ────────────────
  //
  // Crosses T2 and T8. `principles.md`: a failed dependency must never render
  // identically to an empty list.

  await check('a malformed .mcp.json reaches the pane as a danger banner naming the file', async () => {
    const claudeConfig = declaredFor('claude-code').mcpWorkspacePath
    assert.ok(claudeConfig)
    const goodBytes = readFileSync(claudeConfig, 'utf8')
    writeFileSync(claudeConfig, '{ "mcpServers": { "github": ', 'utf8')
    try {
      const result = await resolveThroughIpc('claude-code')
      assert.ok(result.ok, 'one broken path does not make the question un-askable')
      const fault = result.diagnostics.find((entry) => entry.capability === 'servers')
      assert.ok(fault, 'the unparseable config must be stated')
      assert.equal(fault.reason, 'malformed')
      assert.equal(fault.path, claudeConfig)
      // The other half is unaffected: an unparseable MCP config is not a reason
      // to stop listing skills.
      assert.deepEqual(
        result.skills.map((skill) => skill.id).sort(),
        [harnessSkillId('claude'), SHARED_SKILL_ID].sort(),
      )
      assert.deepEqual(result.servers, [])

      const markup = renderPane(result, {}, 'Claude Code')
      assert.match(markup, /Could not read this agent’s MCP servers\./)
      assert.match(markup, new RegExp(claudeConfig.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
      assert.match(markup, /Try again/)
      assert.doesNotMatch(markup, /No skills or MCP servers for this agent\./)
    } finally {
      writeFileSync(claudeConfig, goodBytes, 'utf8')
    }
  })

  await check('a servers-only fault with nothing else to show is a fault, not an empty pane', async () => {
    const cursorConfig = declaredFor('cursor').mcpWorkspacePath
    assert.ok(cursorConfig)
    const goodBytes = readFileSync(cursorConfig, 'utf8')
    writeFileSync(cursorConfig, 'not json at all', 'utf8')
    try {
      // Cursor reads no skills at all, so a broken config leaves the pane with
      // nothing — the exact case where "empty" would be a lie.
      const result = await resolveThroughIpc('cursor')
      assert.ok(result.ok)
      assert.deepEqual(result.skills, [])
      assert.deepEqual(result.servers, [])
      const markup = renderPane(result, {}, 'Cursor')
      assert.match(markup, /Could not read this agent’s MCP servers\./)
      assert.doesNotMatch(markup, /No skills or MCP servers for this agent\./)
    } finally {
      writeFileSync(cursorConfig, goodBytes, 'utf8')
    }
  })

  // ── 4. the pane and the picker resolve through one service ────────────────
  //
  // Crosses T1 and T8/T9's other consumer. Both are mounted for real against
  // the same fixture and their rendered rows compared: two implementations of
  // "what can this agent do" is the failure mode the epic exists to prevent.

  await check('the pane and SkillPickerPopover show the same reachable skills', async () => {
    const result = await resolveThroughIpc('claude-code')
    assert.ok(result.ok)

    const paneMarkup = renderPane(result, { catalogue: builtinCatalogue }, 'Claude Code')
    const paneRows = [...paneMarkup.matchAll(/aria-label="Use ([^"]+?) in Claude Code"/g)]
      .map((match) => match[1])
      .sort()

    const container = dom.window.document.createElement('div')
    dom.window.document.body.appendChild(container)
    const root = createRoot(container)
    await act(async () => {
      root.render(
        <SkillPickerPopover
          open
          onOpenChange={() => {}}
          workspaceRoot={workspaceRoot}
          pluginId="claude-code"
          onPick={() => {}}
        />,
      )
    })
    // The popover's inventory is two awaited calls deep, so settle until rows
    // appear rather than guessing a number of ticks.
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if (dom.window.document.querySelector('[data-skill-row]')) break
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 10))
      })
    }
    assert.ok(
      dom.window.document.querySelector('[data-skill-row]'),
      `the picker rendered no rows at all: ${container.innerHTML.slice(0, 400)} | ${dom.window.document.body.innerHTML.slice(0, 400)}`,
    )
    // The picker marks an installable row with "Install"; everything else in its
    // list is a skill it believes this agent can already reach.
    const pickerReachable = [...dom.window.document.querySelectorAll('[data-skill-row]')]
      .filter((node) => !(node.textContent ?? '').includes('Install'))
      .map((node) => node.getAttribute('data-skill-row') ?? '')
      .sort()
    await act(async () => {
      root.unmount()
    })
    container.remove()

    assert.ok(paneRows.length > 0, 'the pane must have reachable rows for this to mean anything')
    // Not "the picker contains what the pane has" — EQUAL. One resolver, so a
    // row either surface has and the other does not is the divergence this
    // convergence exists to prevent.
    assert.deepEqual(pickerReachable, paneRows)
  })

  // ── 5. a skill written outside Multicode reaches the pane, no restart ──────
  //
  // Crosses T3 (real fs.watch, real IPC push) and T1/T8. The pane's own query
  // hook and body renderer are mounted; only the workspace store around them is
  // stood in for, because the store is not part of this seam.

  await check('a skill directory written on disk changes the pane without a restart', async () => {
    const claudeSkillsDir = declaredFor('claude-code').skillsDir
    assert.ok(claudeSkillsDir)
    const handWrittenDir = join(workspaceRoot, ...claudeSkillsDir.split('/'), 'hand-written')
    let markup = ''
    let renders = 0

    function Pane(): JSX.Element {
      const capabilities = useAgentCapabilities(workspaceRoot, 'claude-code')
      const view = buildSkillsPaneView({
        snapshot: capabilities.snapshot,
        loading: capabilities.loading,
        unavailableMessage: capabilities.unavailableMessage,
        agentLabel: 'Claude Code',
        query: '',
        catalogue: [],
        restartPending: [],
        writeReport: null,
        useError: null,
      })
      renders += 1
      return (
        <SkillsPaneBody
          view={view}
          expandedKey={null}
          pendingSkillId={null}
          canWrite
          canUse
          agentLabel="Claude Code"
          implicitInvocation={false}
          onExpand={() => {}}
          onAdd={() => {}}
          onRemove={() => {}}
          onUse={() => {}}
          onDragStart={() => {}}
          onRetry={() => {}}
          onOpenExtensions={() => {}}
          onDismissWriteReport={() => {}}
          onDismissUseError={() => {}}
        />
      )
    }

    const container = dom.window.document.createElement('div')
    dom.window.document.body.appendChild(container)
    const root = createRoot(container)
    try {
      await act(async () => {
        root.render(<Pane />)
      })
      await settle(() => container.innerHTML.includes('shared-skill'))
      markup = container.innerHTML
      assert.match(markup, /claude-skill/, 'the first read must land before the change')
      assert.doesNotMatch(markup, /hand-written/, 'the new skill must not be there yet')

      const before = renders
      // Written by "someone else": no Multicode write path is involved, so only
      // a real filesystem watch can notice it. The directory is the one the
      // manifest declares, never a literal.
      writeFileDeep(join(handWrittenDir, 'SKILL.md'), skillDocument('hand-written', 'Created outside Multicode.'))

      await until('the pane to re-render with the new skill', () => {
        markup = container.innerHTML
        return markup.includes('hand-written')
      })
      assert.ok(renders > before, 'the pane re-rendered rather than being remounted')
      assert.match(container.innerHTML, /Created outside Multicode\./)
    } finally {
      await act(async () => {
        root.unmount()
      })
      container.remove()
      rmSync(handWrittenDir, { recursive: true, force: true })
    }
  })

  await check('a config file edited outside Multicode changes the pane without a restart', async () => {
    const claudeConfig = declaredFor('claude-code').mcpWorkspacePath
    assert.ok(claudeConfig)
    const goodBytes = readFileSync(claudeConfig, 'utf8')

    let markup = ''
    function Pane(): JSX.Element {
      const capabilities = useAgentCapabilities(workspaceRoot, 'claude-code')
      const view = buildSkillsPaneView({
        snapshot: capabilities.snapshot,
        loading: capabilities.loading,
        unavailableMessage: capabilities.unavailableMessage,
        agentLabel: 'Claude Code',
        query: '',
        catalogue: [],
        restartPending: [],
        writeReport: null,
        useError: null,
      })
      return (
        <SkillsPaneBody
          view={view}
          expandedKey={null}
          pendingSkillId={null}
          canWrite
          canUse
          agentLabel="Claude Code"
          implicitInvocation={false}
          onExpand={() => {}}
          onAdd={() => {}}
          onRemove={() => {}}
          onUse={() => {}}
          onDragStart={() => {}}
          onRetry={() => {}}
          onOpenExtensions={() => {}}
          onDismissWriteReport={() => {}}
          onDismissUseError={() => {}}
        />
      )
    }

    const container = dom.window.document.createElement('div')
    dom.window.document.body.appendChild(container)
    const root = createRoot(container)
    try {
      await act(async () => {
        root.render(<Pane />)
      })
      await settle(() => container.innerHTML.includes('shared-skill'))
      markup = container.innerHTML
      assert.doesNotMatch(markup, /hand-added-server/)

      writeFileSync(claudeConfig, JSON.stringify({
        mcpServers: { 'hand-added-server': { type: 'stdio', command: 'npx' } },
      }, null, 2), 'utf8')

      await until('the pane to show the hand-added server', () => {
        markup = container.innerHTML
        return markup.includes('hand-added-server')
      })
    } finally {
      await act(async () => {
        root.unmount()
      })
      container.remove()
      writeFileSync(claudeConfig, goodBytes, 'utf8')
    }
  })

  // ── 6. an attach fans out, and the pane reflects it ───────────────────────
  //
  // Crosses T4 (the write), T3 (the invalidation it raises) and T8.

  await check('attach writes every declared harness directory and the pane reflects it', async () => {
    // The four the twelve bundled CLIs declare between them, from six native
    // CLIs — three of which share `.claude/skills`.
    const bundledDirs = [...new Set(
      BUNDLED_IDS.map(declaredFor)
        .filter((entry) => entry.support === 'native' && entry.skillsDir)
        .map((entry) => entry.skillsDir as string),
    )]
    assert.equal(bundledDirs.length, 4, 'six native CLIs declare four distinct directories')
    // What the installer must actually fan out to is every native harness in the
    // registry AS IT STANDS — which now includes the thirteenth CLI's, loaded
    // from a manifest alone. Derived here rather than listed, so the fan-out is
    // asserted against the map instead of against a copy of it.
    const nativeHarnesses = [...buildHarnessMap(listPlugins()).byHarness.values()]
      .filter((binding) => binding.support === 'native' && binding.skillsDir)
      .map((binding) => binding.skillsDir as string)
    assert.ok(
      nativeHarnesses.includes(ATLAS_SKILLS_DIR),
      'the thirteenth CLI must be a fan-out target too, or decision 2 stops at the read path',
    )
    for (const dir of bundledDirs) assert.ok(nativeHarnesses.includes(dir))

    // A hand-authored skill in one harness: attaching spreads the copy the user
    // already has rather than a built-in this fixture does not ship.
    const originDir = declaredFor('claude-code').skillsDir
    assert.ok(originDir)
    const spreadId = 'spread-me'
    writeFileDeep(
      join(workspaceRoot, ...originDir.split('/'), spreadId, 'SKILL.md'),
      skillDocument(spreadId, 'Authored by hand in one harness.'),
    )

    let invalidatedHarnesses: string[] = []
    const release = capabilityWatcher.subscribe(workspaceRoot, (event) => {
      invalidatedHarnesses.push(event.harnessId)
    })
    try {
      const result = await api.agentSkillAttach({ workspaceRoot, skillId: spreadId }) as {
        ok: boolean
        targets: Array<{ path: string; status: string; harnessId: string }>
      }
      assert.equal(result.ok, true)
      // Every declared directory is reported, and the origin — which already
      // holds identical bytes — is reported as such rather than as a fresh write.
      assert.deepEqual(
        result.targets.map((target) => dirname(target.path)).sort(),
        [...nativeHarnesses].sort(),
        'the fan-out is exactly the harnesses the manifests declare',
      )
      // On disk, not only in the report: a write path that reported success it
      // did not achieve is exactly what "derived, never stored" exists to catch.
      for (const dir of nativeHarnesses) {
        assert.ok(
          existsSync(join(workspaceRoot, ...dir.split('/'), spreadId, 'SKILL.md')),
          `${dir} must hold the attached skill on disk`,
        )
      }

      await until('the attach to invalidate the harnesses it wrote', () =>
        invalidatedHarnesses.length > 0)

      // The pane re-reads and finds it in the other harnesses, through the same
      // query — never patched in by the write path.
      for (const pluginId of ['codex', 'opencode', 'grok']) {
        const capabilities = await resolveThroughIpc(pluginId)
        assert.ok(capabilities.ok)
        assert.ok(
          capabilities.skills.some((skill) => skill.id === spreadId),
          `${pluginId} must see the attached skill`,
        )
        const markup = renderPane(capabilities, {}, pluginId)
        assert.match(markup, new RegExp(spreadId))
      }
    } finally {
      release()
      for (const dir of nativeHarnesses) {
        rmSync(join(workspaceRoot, ...dir.split('/'), spreadId), { recursive: true, force: true })
      }
      invalidatedHarnesses = []
    }
  })

  // ── 7. a drag out of the pane parks the invocation in the target session ──
  //
  // Crosses T9's drag payload (written by the pane's own row handler) and the
  // existing terminal drop path. The invocation belongs to the session it lands
  // on, not to the pane it left.

  /**
   * Renders the Skills pane for `paneCli`, fires a real `dragstart` on the row
   * for `skillId`, and drops the payload the pane's own handler wrote onto a
   * session running `targetCli`. Returns what reached the terminal.
   *
   * Nothing about the payload is hand-built: if the pane stopped writing the
   * MIME entry the drop path reads, or stopped making the row draggable, this
   * fails here rather than in a user's terminal.
   */
  async function dragFromPaneToSession(input: {
    paneCli: string
    paneLabel: string
    skillId: string
    targetCli: string
  }): Promise<{ dropped: { ok: boolean; message?: string }; writes: typeof terminalWrites }> {
    const store = new Map<string, string>()
    // A minimal DataTransfer: jsdom constructs none, and the contract under test
    // is the pane and the drop path agreeing on one MIME entry.
    const dataTransfer = {
      effectAllowed: '',
      get types(): string[] { return [...store.keys()] },
      setData: (type: string, value: string) => { store.set(type, value) },
      getData: (type: string) => store.get(type) ?? '',
    } as unknown as DataTransfer

    const result = await resolveThroughIpc(input.paneCli)
    assert.ok(result.ok)
    const view = buildSkillsPaneView({
      snapshot: snapshotOf(result),
      loading: false,
      unavailableMessage: null,
      agentLabel: input.paneLabel,
      query: '',
      catalogue: [],
      restartPending: [],
      writeReport: null,
      useError: null,
    })

    const container = dom.window.document.createElement('div')
    dom.window.document.body.appendChild(container)
    const root = createRoot(container)
    try {
      await act(async () => {
        root.render(
          <SkillsPaneBody
            view={view}
            expandedKey={null}
            pendingSkillId={null}
            canWrite
            canUse
            agentLabel={input.paneLabel}
            implicitInvocation={false}
            onExpand={() => {}}
            onAdd={() => {}}
            onRemove={() => {}}
            onUse={() => {}}
            onDragStart={(skillId, transfer) =>
              setSkillDropData(transfer, { version: 1, skillId, workspaceId: 'ws-1' })}
            onRetry={() => {}}
            onOpenExtensions={() => {}}
            onDismissWriteReport={() => {}}
            onDismissUseError={() => {}}
          />,
        )
      })

      const row = [...container.querySelectorAll('[draggable="true"]')].find((candidate) =>
        candidate.querySelector(`[aria-label="Use ${input.skillId} in ${input.paneLabel}"]`))
      assert.ok(row, `the pane must offer ${input.skillId} as a drag handle`)
      const dragEvent = new dom.window.Event('dragstart', { bubbles: true }) as Event & {
        dataTransfer?: DataTransfer
      }
      dragEvent.dataTransfer = dataTransfer
      await act(async () => {
        row.dispatchEvent(dragEvent)
      })
      assert.equal(
        JSON.parse(dataTransfer.getData(MULTICODE_SKILL_DROP_MIME)).skillId,
        input.skillId,
        'the row dragstart reached the pane own handler',
      )

      terminalSessions = [{
        sessionId: `session-${input.targetCli}`,
        kind: 'agent',
        cli: input.targetCli,
        processAlive: true,
      } as unknown as TerminalSessionSnapshot]
      terminalWrites.length = 0

      const dropped = await pasteDroppedSkillIntoTerminal({
        dataTransfer,
        sessionId: `session-${input.targetCli}`,
        workspaceId: 'ws-1',
        workspaceRoot,
      })
      return { dropped, writes: [...terminalWrites] }
    } finally {
      await act(async () => {
        root.unmount()
      })
      container.remove()
    }
  }

  /** A bracketed paste of `text`, with the trailing space that leaves the caret ready. */
  const bracketed = (text: string): string => `[200~${text} [201~`

  await check('a drag from the pane parks the TARGET session invocation form', async () => {
    // Dragged out of Claude Code's pane onto a Codex tab. Both CLIs hold the
    // skill, so the form is the one the session it landed on declares — not the
    // one the pane it left would have used.
    const { dropped, writes } = await dragFromPaneToSession({
      paneCli: 'claude-code',
      paneLabel: 'Claude Code',
      skillId: SHARED_SKILL_ID,
      targetCli: 'codex',
    })
    assert.equal(dropped.ok, true, dropped.message)
    assert.equal(writes.length, 1, 'exactly one write reached the session')
    assert.equal(writes[0].sessionId, 'session-codex')

    const codexTemplate = lookupManifest('codex')?.skillIntegration?.invocation?.explicitTemplate
    const claudeTemplate = lookupManifest('claude-code')?.skillIntegration?.invocation?.explicitTemplate
    assert.ok(codexTemplate && claudeTemplate)
    assert.notEqual(codexTemplate, claudeTemplate, 'the two forms must differ for this to mean anything')
    assert.equal(
      writes[0].data,
      bracketed(codexTemplate.replace('{{skillId}}', SHARED_SKILL_ID)),
      'the target CLI own form, bracketed, with the caret left after a trailing space',
    )
    // Parked, not run. A bracketed paste is text at the prompt; a carriage
    // return here would submit the invocation on the user's behalf.
    assert.doesNotMatch(writes[0].data, /[\r\n]/)
  })

  await check('the same drag dropped on a Claude tab arrives in Claude form', async () => {
    const { dropped, writes } = await dragFromPaneToSession({
      paneCli: 'codex',
      paneLabel: 'Codex',
      skillId: SHARED_SKILL_ID,
      targetCli: 'claude-code',
    })
    assert.equal(dropped.ok, true, dropped.message)
    const claudeTemplate = lookupManifest('claude-code')?.skillIntegration?.invocation?.explicitTemplate
    assert.ok(claudeTemplate)
    assert.equal(writes[0].data, bracketed(claudeTemplate.replace('{{skillId}}', SHARED_SKILL_ID)))
  })

  await check('a skill the target cannot see never arrives in that CLI native form', async () => {
    // `claude-skill` lives only in Claude's harness directory. Codex would
    // answer `Use $claude-skill.` with nothing behind it, so the drop falls back
    // to the plain mention any agent can act on.
    const { dropped, writes } = await dragFromPaneToSession({
      paneCli: 'claude-code',
      paneLabel: 'Claude Code',
      skillId: harnessSkillId('claude'),
      targetCli: 'codex',
    })
    assert.equal(dropped.ok, true, dropped.message)
    const codexTemplate = lookupManifest('codex')?.skillIntegration?.invocation?.explicitTemplate
    assert.ok(codexTemplate)
    assert.notEqual(
      writes[0].data,
      bracketed(codexTemplate.replace('{{skillId}}', harnessSkillId('claude'))),
      'a native form implies the CLI can find the skill; this one cannot',
    )
    assert.equal(writes[0].data, bracketed(`Use the ${harnessSkillId('claude')} skill.`))
  })

  await check('the thirteenth CLI gets its own declared form on a drag, not the fallback', async () => {
    // Decision 2 does not stop at the resolver: a CLI added by manifest alone
    // must be able to USE what the pane says it can reach. Atlas declares
    // `/{{skillId}}` and holds `atlas-skill` in its own harness directory.
    const { dropped, writes } = await dragFromPaneToSession({
      paneCli: 'atlas',
      paneLabel: 'Atlas',
      skillId: 'atlas-skill',
      targetCli: 'atlas',
    })
    assert.equal(dropped.ok, true, dropped.message)
    const atlasTemplate = lookupManifest('atlas')?.skillIntegration?.invocation?.explicitTemplate
    assert.ok(atlasTemplate)
    assert.equal(writes[0].data, bracketed(atlasTemplate.replace('{{skillId}}', 'atlas-skill')))
  })

  await check('a drag onto a plain shell is refused rather than guessed at', async () => {
    const store = new Map<string, string>()
    const dataTransfer = {
      effectAllowed: '',
      get types(): string[] { return [...store.keys()] },
      setData: (type: string, value: string) => { store.set(type, value) },
      getData: (type: string) => store.get(type) ?? '',
    } as unknown as DataTransfer
    setSkillDropData(dataTransfer, { version: 1, skillId: harnessSkillId('claude'), workspaceId: 'ws-1' })

    terminalSessions = [{
      sessionId: 'session-shell',
      kind: 'terminal',
      processAlive: true,
    } as unknown as TerminalSessionSnapshot]
    terminalWrites.length = 0

    const dropped = await pasteDroppedSkillIntoTerminal({
      dataTransfer,
      sessionId: 'session-shell',
      workspaceId: 'ws-1',
      workspaceRoot,
    })
    assert.equal(dropped.ok, false)
    assert.equal(terminalWrites.length, 0, 'nothing is written to a session that cannot read it')
  })

  for (const path of temporaryDirs) rmSync(path, { recursive: true, force: true })

  if (failures > 0) {
    console.error(`skillsAsideSeam: ${failures} failing`)
    process.exitCode = 1
    return
  }
  console.log('skillsAsideSeam: ok')
}

void main()
