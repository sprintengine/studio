/**
 * What `Go` does, and what it refuses to do (item 2469).
 *
 * Every installer is injected, so this suite is about the EXECUTOR and not
 * about installing anything: there is no workspace on disk, no MCP catalogue,
 * no source store and no git. What is asserted is the four things only this
 * module can be wrong about.
 *
 *   1. The order. A card is an ordered list and the whole point of `open.chat`
 *      being last is that the chat opens onto tools that are already there, so
 *      the happy path asserts a call LOG rather than a set of calls.
 *   2. The first failure stops the rest, and says which ones did not run. A
 *      toast that named only what broke would leave the person guessing how
 *      much of the card had happened.
 *   3. A second press is a no-op. Pressing Go twice must not install twice,
 *      and "already there" is a success, not an error.
 *   4. `open.chat` is the last action or the card is refused before anything
 *      runs — a chat attached to a server that failed to install is worse than
 *      no chat.
 *
 * Plus the boundary: an id a feed made up resolves against nothing this app
 * holds, and a repository name is re-checked here rather than taken on the
 * parser's word.
 */
import assert from 'node:assert/strict'

import type {
  McpCatalogResult,
  McpServerConfig,
  SkillInstalledPluginsOutcome,
  SkillScanOutcome,
} from '../../shared/electron-api'
import type { CardAction } from '../../shared/hosted-card-feed'
import type { ScanResult, ScannedPlugin, ScannedSkill, SkillSource } from '../../shared/skills'
import { refuseCard, runCard, type CardRunDeps } from './run-card'

const WORKSPACE = '/tmp/workspace'
const PARENT = '/tmp/projects'

const CATALOG_SERVER = {
  id: 'io-github-playwright-mcp',
  name: 'Playwright',
  transport: 'stdio' as const,
  command: 'npx',
  args: ['@playwright/mcp'],
  clients: ['claude-code'],
  riskLevel: 'local-command' as const,
}

const SKILL: ScannedSkill = {
  id: 'studio-skills/skills/browser',
  name: 'Browser',
  description: 'Drive a browser.',
  group: '',
  files: [{ path: 'SKILL.md', size: 10, blobSha: '', isEntry: true }],
  allowedTools: [],
  hasExecutables: false,
}

const SOURCE: SkillSource = {
  id: 'github:sprintengine/studio-skills',
  kind: 'github',
  name: 'studio-skills',
  repo: 'sprintengine/studio-skills',
  monogram: 'SS',
  blurb: '',
  commitSha: 'abc',
  scannedAt: '2026-09-06T00:00:00.000Z',
}

// Only the fields the executor reads. `scanPlugins` completes the rest, which
// is exactly what it exists for, so the cast is a fixture shortcut and not a
// claim about the shape.
const PLUGIN = {
  id: 'playwright',
  name: 'Playwright',
  origin: { kind: 'in-tree', path: 'plugins/playwright' },
} as unknown as ScannedPlugin

function scan(overrides: Partial<ScanResult> = {}): ScanResult {
  return {
    skills: [SKILL],
    groups: [],
    groupingSignal: 'none',
    fileCount: 1,
    commitSha: 'abc',
    plugins: [PLUGIN],
    ...overrides,
  }
}

type Recorder = { calls: string[]; deps: CardRunDeps }

/**
 * Every dependency records itself before answering, so a test can read the run
 * as a sentence. The defaults are the "nothing is installed yet" machine; each
 * case overrides only the fact it is about.
 */
function recorder(overrides: Partial<CardRunDeps> = {}): Recorder {
  const calls: string[] = []
  const deps: CardRunDeps = {
    listMcpCatalog: (): McpCatalogResult => {
      calls.push('listMcpCatalog')
      return { ok: true, servers: [CATALOG_SERVER] }
    },
    syncMcp: (input) => {
      calls.push(`syncMcp ${Object.keys(input.settings.servers).join(',')}`)
      return { ok: true, targets: [], issues: [] }
    },
    getSkillScan: async (input): Promise<SkillScanOutcome> => {
      calls.push(`getSkillScan ${input.sourceId}`)
      return input.sourceId === SOURCE.id
        ? { ok: true, source: SOURCE, scan: scan() }
        : { ok: false, message: 'That source is not in your list.' }
    },
    installSkill: async (input) => {
      calls.push(`installSkill ${input.skillId}`)
      return { ok: true, dirName: 'browser', harnesses: ['claude'], paths: [], fileCount: 1 }
    },
    installPlugin: async (input) => {
      calls.push(`installPlugin ${input.pluginId}`)
      return {
        ok: true,
        plugin: PLUGIN,
        harnesses: [],
        mcpServers: [],
        claudePluginKey: '',
        warnings: [],
      }
    },
    listInstalledPlugins: async (): Promise<SkillInstalledPluginsOutcome> => {
      calls.push('listInstalledPlugins')
      return { ok: true, plugins: [] }
    },
    installedSkillCopies: async () => {
      calls.push('installedSkillCopies')
      return new Map<string, readonly { sourceId: string }[]>()
    },
    listAgentCliIds: () => ['claude-code', 'codex'],
    detectCli: async (cli) => {
      calls.push(`detectCli ${cli}`)
      return { installed: true }
    },
    cloneRepo: async (input) => {
      calls.push(`cloneRepo ${input.url} -> ${input.parentDir}/${input.folderName}`)
      return { ok: true, path: `${input.parentDir}/${input.folderName}` }
    },
    pathExists: () => false,
    joinPath: (...segments) => segments.join('/'),
    ...overrides,
  }
  return { calls, deps }
}

function run(actions: CardAction[], deps: CardRunDeps, mcpServers: McpServerConfig[] = []) {
  return runCard(
    { slug: 'browser', actions, workspaceRoot: WORKSPACE, cloneParentDir: PARENT, mcpServers },
    deps,
  )
}

const HAPPY: CardAction[] = [
  { verb: 'require.cli', cli: 'claude-code' },
  { verb: 'install.mcp', id: CATALOG_SERVER.id },
  { verb: 'install.skill', source: SOURCE.id, id: SKILL.id },
  { verb: 'open.chat', prompt: 'Open example.com and read the headline.', skills: ['browser'], send: true },
]

async function main(): Promise<void> {

  // ── 1. The happy path, in the card's own order ───────────────────────────────
  {
    const { calls, deps } = recorder()
    const result = await run(HAPPY, deps)
    assert.equal(result.ok, true, 'a card whose every action succeeds is a run that succeeded')
    assert.deepEqual(
      result.outcomes.map((outcome) => `${outcome.verb}:${outcome.status}`),
      ['require.cli:already', 'install.mcp:done', 'install.skill:done', 'open.chat:done'],
      'one outcome per action, in the card’s order, with the CLI that was already there reported as a no-op',
    )
    assert.deepEqual(
      calls,
      [
        'detectCli claude-code',
        'listMcpCatalog',
        `syncMcp ${CATALOG_SERVER.id}`,
        `getSkillScan ${SOURCE.id}`,
        'installedSkillCopies',
        `installSkill ${SKILL.id}`,
      ],
      'the installers ran in the card’s order — the MCP server is in before the skill, and both before the chat',
    )
    assert.deepEqual(
      result.chat,
      {
        prompt: 'Open example.com and read the headline.',
        send: true,
        skills: ['browser'],
        mcpServers: [],
      },
      'the chat is handed back for the renderer to open, and it carries `send` (R4: Go goes)',
    )
    assert.equal(result.surface, null, 'a card that named no door hands back no door')
    assert.deepEqual(
      result.mcpServers.map((server) => server.id),
      [CATALOG_SERVER.id],
      'the servers as they now stand go back to the store, because MCP settings live in the renderer',
    )
    assert.equal(result.workspaceRoot, WORKSPACE, 'nothing cloned, so the workspace is the one it started in')
  }

  // ── 2. The first failure stops the rest, and names what did not run ──────────
  {
    const { calls, deps } = recorder({
      listMcpCatalog: (): McpCatalogResult => {
        calls.push('listMcpCatalog')
        return { ok: false, message: 'Bundled MCP catalog was not found.' }
      },
    })
    const result = await run(HAPPY, deps)
    assert.equal(result.ok, false)
    assert.equal(result.message, 'Bundled MCP catalog was not found.', 'the toast leads with what actually broke')
    assert.deepEqual(
      result.outcomes.map((outcome) => `${outcome.verb}:${outcome.status}`),
      ['require.cli:already', 'install.mcp:failed', 'install.skill:skipped', 'open.chat:skipped'],
      'everything after the failure is reported as not run, so the toast can say how much did not happen',
    )
    assert.ok(
      !calls.some((call) => call.startsWith('installSkill')),
      'and nothing after the failure ran — no skill was installed behind a server that is not there',
    )
    assert.equal(result.chat, null, 'a failed run opens no chat')
  }

  // ── 3. A second press installs nothing ───────────────────────────────────────
  {
    const installedServer = { ...CATALOG_SERVER, enabled: true, scope: 'workspace', source: 'bundled' } as McpServerConfig
    const { calls, deps } = recorder({
      installedSkillCopies: async () => {
        calls.push('installedSkillCopies')
        return new Map<string, readonly { sourceId: string }[]>([['browser', [{ sourceId: SOURCE.id }]]])
      },
    })
    const result = await run(HAPPY, deps, [installedServer])
    assert.equal(result.ok, true, 'pressing Go a second time succeeds — already satisfied is a no-op, not an error')
    assert.deepEqual(
      result.outcomes.map((outcome) => `${outcome.verb}:${outcome.status}`),
      ['require.cli:already', 'install.mcp:already', 'install.skill:already', 'open.chat:done'],
      'every install reports itself already done',
    )
    assert.ok(
      !calls.some((call) => call.startsWith('installSkill') || call.startsWith('syncMcp')),
      'and nothing was written a second time',
    )
    assert.deepEqual(result.mcpServers, [], 'a run that changed no server asks the store to write nothing')
    assert.ok(result.chat, 'the person still lands in the chat, which is what makes a second press useful')
  }

  // ── 4. `open.chat` is last, or the card is refused before anything runs ──────
  {
    assert.equal(refuseCard(HAPPY), null, 'a chat in last place is the shape a card is allowed to have')
    const outOfOrder: CardAction[] = [
      { verb: 'open.chat', prompt: 'Go on then.', send: true },
      { verb: 'install.mcp', id: CATALOG_SERVER.id },
    ]
    assert.ok(refuseCard(outOfOrder), 'a chat before an install is refused')
    assert.ok(
      refuseCard([...HAPPY, { verb: 'open.chat', prompt: 'again', send: true }]),
      'and so is a card that opens two chats',
    )

    const { calls, deps } = recorder()
    const result = await run(outOfOrder, deps)
    assert.equal(result.ok, false)
    assert.deepEqual(calls, [], 'the refusal happens BEFORE anything runs — nothing is half-installed by a bad card')
    assert.deepEqual(
      result.outcomes.map((outcome) => outcome.status),
      ['skipped', 'skipped'],
      'and every action reports that it did not run',
    )
    assert.equal(result.chat, null)
  }

  // ── The workspace is the app's, and only `clone.repo` moves it ───────────────
  {
    const { calls, deps } = recorder()
    const result = await run(
      [
        { verb: 'clone.repo', repo: 'sprintengine/example', folderName: 'example' },
        { verb: 'install.skill', source: SOURCE.id, id: SKILL.id },
      ],
      deps,
    )
    assert.equal(result.ok, true)
    assert.ok(
      calls.includes(`cloneRepo https://github.com/sprintengine/example.git -> ${PARENT}/example`),
      'the URL is BUILT from a fixed host and the validated owner/name — a card names a repository, never a URL',
    )
    assert.equal(result.workspaceRoot, `${PARENT}/example`, 'the clone becomes the workspace the run ends in')
  }

  {
    // The same card twice: the folder is already there, so the clone is a no-op
    // and the run still adopts it as its workspace.
    const { calls, deps } = recorder({ pathExists: () => true })
    const result = await run([{ verb: 'clone.repo', repo: 'sprintengine/example' }], deps)
    assert.equal(result.outcomes[0]?.status, 'already', 'a clone target that is already there is a no-op')
    assert.ok(!calls.some((call) => call.startsWith('cloneRepo')), 'and git is never run a second time')
    assert.equal(result.workspaceRoot, `${PARENT}/example`, 'the folder name defaults to the repository’s own name')
  }

  // ── Nothing a feed says is trusted as a path, an id or a host ────────────────
  {
    const { calls, deps } = recorder()
    // `..` passes the owner/name character class on its own, which is exactly why
    // the check is repeated at this boundary rather than assumed upstream.
    const traversal = await run([{ verb: 'clone.repo', repo: '../../etc' }], deps)
    assert.equal(traversal.ok, false, 'a repository name that is a relative path is refused')
    assert.ok(!calls.some((call) => call.startsWith('cloneRepo')), 'and git never sees it')

    const escape = await run(
      [{ verb: 'clone.repo', repo: 'owner/name', folderName: '../elsewhere' }],
      deps,
    )
    assert.equal(escape.ok, false, 'a folder name with a separator in it never reaches a path join')
  }

  {
    const { calls, deps } = recorder()
    const unknownSource = await run([{ verb: 'install.skill', source: 'github:someone/else', id: 'x' }], deps)
    assert.equal(unknownSource.ok, false, 'a source this app does not hold resolves to nothing')
    assert.ok(!calls.some((call) => call.startsWith('installSkill')), 'and no install is attempted against it')

    const unknownSkill = await run([{ verb: 'install.skill', source: SOURCE.id, id: 'not/in/the/scan' }], deps)
    assert.equal(unknownSkill.ok, false, 'an id that is not in the source’s scan is refused')

    const unknownServer = await run([{ verb: 'install.mcp', id: 'made-up' }], deps)
    assert.equal(unknownServer.ok, false, 'an MCP id that is not in the bundled catalogue is refused')

    const unknownCli = await run([{ verb: 'require.cli', cli: '/usr/bin/anything' }], deps)
    assert.equal(unknownCli.ok, false, 'a `cli` that is not a registered agent-CLI plugin id never reaches a probe')
    assert.ok(!calls.some((call) => call.startsWith('detectCli /usr/bin')), 'the probe was never called with it')
  }

  // ── A missing CLI is a refusal with somewhere to go, never a silent install ──
  {
    const { calls, deps } = recorder({
      detectCli: async (cli) => {
        calls.push(`detectCli ${cli}`)
        return { installed: false }
      },
    })
    const result = await run(HAPPY, deps)
    assert.equal(result.ok, false)
    assert.match(
      result.message ?? '',
      /Agent CLIs/,
      'Go says which CLI is missing and where to install it — it never runs an installer nobody has seen',
    )
    assert.deepEqual(calls, ['detectCli claude-code'], 'and it stops there')
  }

  // ── A plugin already in the receipts is not installed again ──────────────────
  {
    const { calls, deps } = recorder({
      listInstalledPlugins: async (): Promise<SkillInstalledPluginsOutcome> => {
        calls.push('listInstalledPlugins')
        return {
          ok: true,
          plugins: [
            {
              workspaceRoot: WORKSPACE,
              sourceId: SOURCE.id,
              pluginId: PLUGIN.id,
              pluginName: PLUGIN.name,
              marketplaceName: '',
              claudePluginKey: '',
              skillDirNames: [],
              mcpServerIds: [],
              commitSha: '',
              installedAt: '2026-09-06T00:00:00.000Z',
            },
          ],
        }
      },
    })
    const result = await run([{ verb: 'install.plugin', source: SOURCE.id, id: PLUGIN.id }], deps)
    assert.equal(result.outcomes[0]?.status, 'already')
    assert.ok(!calls.some((call) => call.startsWith('installPlugin')), 'the receipt is what makes a second Go free')
  }

  // ── A plugin whose hooks nobody has read is refused, not acknowledged ────────
  {
    const { deps } = recorder({
      installPlugin: async () => ({
        ok: false,
        needsHookAcknowledgement: true,
        message: 'Playwright runs 2 hook commands on your machine. Review them, then install.',
      }),
    })
    const result = await run([{ verb: 'install.plugin', source: SOURCE.id, id: PLUGIN.id }], deps)
    assert.equal(result.ok, false)
    assert.match(
      result.message ?? '',
      /Plugins/,
      'a card may not answer a hooks disclosure on the person’s behalf — it sends them to the surface that shows it',
    )
  }

  // ── A door is a hand-off too ─────────────────────────────────────────────────
  {
    const { deps } = recorder()
    const result = await run([{ verb: 'open.surface', view: 'skills', installed: true }], deps)
    assert.equal(result.ok, true)
    assert.deepEqual(result.surface, { view: 'skills', installed: true })
  }

  // ── With no workspace open, an install says so rather than guessing one ──────
  {
    const { calls, deps } = recorder()
    const result = await runCard(
      {
        slug: 'browser',
        actions: [{ verb: 'install.mcp', id: CATALOG_SERVER.id }],
        workspaceRoot: null,
        cloneParentDir: PARENT,
        mcpServers: [],
      },
      deps,
    )
    assert.equal(result.ok, false)
    assert.match(result.message ?? '', /Open a project/, 'a card carries no workspace, so the app has to have one')
    assert.deepEqual(calls, [], 'and nothing was reached for without one')
  }

  console.log('run-card.test.ts: ok')
}

void main()
