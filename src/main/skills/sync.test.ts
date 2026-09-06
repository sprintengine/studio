import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { McpServerConfig } from '../../shared/electron-api'
import { mcpServerConfigFromScanned } from '../../shared/mcp/server-from-scanned'
import type { ScanResult, ScannedMcpServer, ScannedSkill } from '../../shared/skills'
import { SKILL_PROVENANCE_FILE } from './install'
import { diffScannedSkills, installedSkillCopies, refreshInstalledSkills, refreshSourceMcpServers } from './sync'

const SOURCE = 'github:acme/skills'

function skill(id: string, files = ['SKILL.md']): ScannedSkill {
  return {
    id,
    name: id.split('/').slice(-1)[0],
    description: '',
    group: '',
    files: files.map((path) => ({ path, size: 1, blobSha: '', isEntry: path === 'SKILL.md' })),
    allowedTools: [],
    hasExecutables: false,
  }
}

function scanOf(skills: ScannedSkill[], commitSha = 'b81f77a'): ScanResult {
  return {
    skills,
    groups: [],
    groupingSignal: 'none',
    fileCount: skills.reduce((total, entry) => total + entry.files.length, 0),
    commitSha,
  }
}

/**
 * A workspace holding installed copies. Each entry names the harness dirs the
 * copy sits in and the source that installed it; `null` writes no provenance
 * marker, which is what a bundled skill or a hand-made directory looks like.
 */
async function workspaceWith(
  installed: Record<string, { harnessDirs: string[]; sourceId: string | null }>
): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'multicode-skill-sync-'))
  for (const [dirName, entry] of Object.entries(installed)) {
    for (const harnessDir of entry.harnessDirs) {
      const dir = join(root, harnessDir, 'skills', dirName)
      await mkdir(dir, { recursive: true })
      await writeFile(join(dir, 'SKILL.md'), 'the copy that was installed\n')
      if (entry.sourceId === null) continue
      await writeFile(
        join(dir, SKILL_PROVENANCE_FILE),
        JSON.stringify({ sourceId: entry.sourceId, skillId: `skills/${dirName}`, commitSha: 'b81f77a' })
      )
    }
  }
  return root
}

function fromSource(...harnessDirs: string[]): { harnessDirs: string[]; sourceId: string } {
  return { harnessDirs, sourceId: SOURCE }
}

async function reportsWhatCameInAndWhatWent(): Promise<void> {
  const previous = scanOf([skill('skills/tdd'), skill('skills/deprecated/jquery')])
  const next = scanOf([skill('skills/tdd'), skill('skills/triage'), skill('skills/teach')], 'c0ffee1')
  const changes = diffScannedSkills(previous, next)
  assert.deepEqual(changes.added, ['skills/triage', 'skills/teach'])
  assert.deepEqual(changes.removed, ['skills/deprecated/jquery'])

  // A source read for the first time has everything to say and nothing to
  // compare against; it must not report its whole list as "removed".
  const first = diffScannedSkills(null, next)
  assert.equal(first.added.length, 3)
  assert.deepEqual(first.removed, [])
  console.log('ok - sync reports what came in and what went')
}

async function reCopiesOnlyTheHarnessesThatHoldTheSkill(): Promise<void> {
  const workspace = await workspaceWith({ tdd: fromSource('.claude', '.agents'), triage: fromSource('.claude') })
  const installed = await installedSkillCopies(workspace)
  assert.deepEqual(installed.get('tdd')?.map((copy) => copy.harness), ['claude', 'agents'])
  assert.deepEqual(installed.get('triage')?.map((copy) => copy.harness), ['claude'])

  const scan = scanOf([skill('skills/tdd', ['SKILL.md', 'reference/deep.md']), skill('skills/unwanted')])
  const result = await refreshInstalledSkills({
    workspaceRoot: workspace,
    sourceId: SOURCE,
    scan,
    installedCopies: installed,
    readFile: async (target, file) => Buffer.from(`${target.id}:${file.path} at head\n`, 'utf8'),
  })

  assert.deepEqual(result.refreshed, ['skills/tdd'])
  assert.deepEqual(result.failures, [])
  for (const harnessDir of ['.claude', '.agents']) {
    const root = join(workspace, harnessDir, 'skills', 'tdd')
    assert.equal(await readFile(join(root, 'SKILL.md'), 'utf8'), 'skills/tdd:SKILL.md at head\n')
    assert.equal(
      await readFile(join(root, 'reference', 'deep.md'), 'utf8'),
      'skills/tdd:reference/deep.md at head\n',
      'the whole directory is re-copied, not the entry alone',
    )
  }
  // A skill the workspace never installed is not installed by a sync, and no
  // copy appears in a harness directory the user never installed into.
  assert.deepEqual((await readdir(join(workspace, '.claude', 'skills'))).sort(), ['tdd', 'triage'])
  assert.deepEqual((await readdir(join(workspace, '.agents', 'skills'))).sort(), ['tdd'])
  console.log('ok - a sync re-copies exactly the copies the workspace already holds')
}

async function keepsASkillThatDisappearedUpstream(): Promise<void> {
  const workspace = await workspaceWith({ tdd: fromSource('.claude'), jquery: fromSource('.claude') })
  const result = await refreshInstalledSkills({
    workspaceRoot: workspace,
    sourceId: SOURCE,
    scan: scanOf([skill('skills/tdd')]),
    installedCopies: await installedSkillCopies(workspace),
    readFile: async () => Buffer.from('at head\n', 'utf8'),
  })

  assert.deepEqual(result.refreshed, ['skills/tdd'])
  // Dropping out of the source's list is not a reason to take a working skill
  // away from the agents reading it.
  assert.equal(
    await readFile(join(workspace, '.claude', 'skills', 'jquery', 'SKILL.md'), 'utf8'),
    'the copy that was installed\n',
  )
  console.log('ok - a skill removed upstream keeps the copy it already has')
}

async function reportsAFailedCopyWithoutStoppingTheRest(): Promise<void> {
  const workspace = await workspaceWith({ tdd: fromSource('.claude'), triage: fromSource('.claude') })
  const result = await refreshInstalledSkills({
    workspaceRoot: workspace,
    sourceId: SOURCE,
    scan: scanOf([skill('skills/tdd'), skill('skills/triage')]),
    installedCopies: await installedSkillCopies(workspace),
    readFile: async (target) => {
      if (target.id === 'skills/tdd') throw new Error('GitHub rate-limited this request.')
      return Buffer.from('at head\n', 'utf8')
    },
  })

  assert.deepEqual(result.refreshed, ['skills/triage'])
  assert.deepEqual(result.failures, [
    { skillId: 'skills/tdd', message: 'GitHub rate-limited this request.' },
  ])
  assert.equal(
    await readFile(join(workspace, '.claude', 'skills', 'tdd', 'SKILL.md'), 'utf8'),
    'the copy that was installed\n',
    'a failed download leaves the skill that was there, never a half-written one',
  )
  console.log('ok - a failed copy is reported and the rest still update')
}

// The reproduction filed as T10-F1: `prototype` is a skill Multicode ships and
// a skill mattpocock/skills ships, and before install recorded provenance the
// second silently replaced the first on a sync the user never asked for.
async function leavesABundledSkillOfTheSameNameAlone(): Promise<void> {
  const workspace = await workspaceWith({ prototype: { harnessDirs: ['.claude'], sourceId: null } })
  const bundled = join(workspace, '.claude', 'skills', 'prototype', 'SKILL.md')

  const result = await refreshInstalledSkills({
    workspaceRoot: workspace,
    sourceId: 'github:mattpocock/skills',
    scan: scanOf([skill('skills/engineering/prototype')]),
    installedCopies: await installedSkillCopies(workspace),
    readFile: async () => Buffer.from("the repository's own prototype\n", 'utf8'),
  })

  assert.deepEqual(result.refreshed, [], 'a skill this source never installed is not reported as refreshed')
  assert.equal(await readFile(bundled, 'utf8'), 'the copy that was installed\n', 'the bundled bytes are intact')
  console.log('ok - a directory with no provenance is never overwritten by a sync')
}

async function leavesACopyInstalledFromAnotherSourceAlone(): Promise<void> {
  const workspace = await workspaceWith({
    prototype: { harnessDirs: ['.claude'], sourceId: 'github:other/skills' },
    tdd: fromSource('.claude'),
  })
  const other = join(workspace, '.claude', 'skills', 'prototype', 'SKILL.md')

  const result = await refreshInstalledSkills({
    workspaceRoot: workspace,
    sourceId: SOURCE,
    scan: scanOf([skill('skills/prototype'), skill('skills/tdd')]),
    installedCopies: await installedSkillCopies(workspace),
    readFile: async () => Buffer.from('at head\n', 'utf8'),
  })

  // Not an error and not a prompt: installing the same-named skill from two
  // repositories is a legitimate state, and the one the user chose stands.
  assert.deepEqual(result.refreshed, ['skills/tdd'])
  assert.equal(await readFile(other, 'utf8'), 'the copy that was installed\n')
  console.log('ok - a sync updates its own installs and leaves other sources alone')
}

// ── MCP servers ─────────────────────────────────────────────────────────────

function server(over: Partial<ScannedMcpServer> = {}): ScannedMcpServer {
  return {
    id: 'context7',
    name: 'Context7',
    description: 'Docs for libraries',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@upstash/context7-mcp@1'],
    url: '',
    env: {},
    envVarNames: [],
    headers: {},
    declaredIn: '.mcp.json',
    declaredBy: '',
    ...over,
  }
}

function scanWithServers(servers: ScannedMcpServer[], commitSha = 'newsha1'): ScanResult {
  return { ...scanOf([], commitSha), mcpServers: servers, shape: 'mcp-server' }
}

/** What the install wrote when this source's server was added, at the old commit. */
function installedFromSource(over: Partial<McpServerConfig> = {}): McpServerConfig {
  return {
    ...mcpServerConfigFromScanned(server(), ['claude-code'], {
      sourceId: SOURCE,
      itemId: 'context7',
      commitSha: 'oldsha0',
    }),
    ...over,
  }
}

function syncsTheServersItInstalledAndOnlyThose(): void {
  // The same server, at a new command the source now declares.
  const moved = server({ args: ['-y', '@upstash/context7-mcp@2'], description: 'Docs, faster', envVarNames: ['CONTEXT7_TOKEN'] })
  const handTyped: McpServerConfig = {
    id: 'context7-mine',
    name: 'My own context7',
    transport: 'stdio',
    command: 'node',
    args: ['server.js'],
    enabled: true,
    clients: ['claude-code'],
    scope: 'workspace',
    source: 'custom',
    riskLevel: 'local-command',
  }
  // A server of the SAME id from another source: name collisions across
  // sources are ordinary, and provenance is what tells them apart.
  const fromElsewhere: McpServerConfig = installedFromSource({
    sourceRef: { sourceId: 'github:other/plugins', itemId: 'context7', commitSha: 'oldsha0' },
  })
  const installed = installedFromSource({
    enabled: false,
    clients: ['codex'],
    env: { CONTEXT7_TOKEN: 'typed-by-hand' },
    envVarNames: ['CONTEXT7_TOKEN'],
  })

  const result = refreshSourceMcpServers({
    sourceId: SOURCE,
    servers: [installed, handTyped, fromElsewhere],
    scan: scanWithServers([moved]),
    commitSha: 'newsha1',
  })

  assert.deepEqual(result.changed, ['context7'], 'only the entry whose declaration moved is claimed as updated')
  assert.deepEqual(result.missing, [])
  assert.equal(result.updated.length, 1, 'the hand-typed server and the other source are not rewritten')
  const next = result.updated[0]
  assert.deepEqual(next.args, ['-y', '@upstash/context7-mcp@2'], 'the fresh declaration lands')
  assert.equal(next.description, 'Docs, faster')
  assert.equal(next.sourceRef?.commitSha, 'newsha1', 'and is pinned to the commit it was read at')
  // What the person chose survives the refresh; a source ships defaults, not
  // decisions, and never the token they typed.
  assert.equal(next.enabled, false)
  assert.deepEqual(next.clients, ['codex'])
  assert.deepEqual(next.env, { CONTEXT7_TOKEN: 'typed-by-hand' }, 'the value they filled in for a name the source declares')
  console.log('ok - a sync rewrites the servers this source installed and leaves every other one alone')
}

function unchangedDeclarationIsNotReportedAsAnUpdate(): void {
  const result = refreshSourceMcpServers({
    sourceId: SOURCE,
    servers: [installedFromSource()],
    scan: scanWithServers([server()]),
    commitSha: 'newsha1',
  })
  assert.deepEqual(result.changed, [], 'nothing moved, so the line may not claim an update')
  assert.equal(result.updated.length, 1)
  assert.equal(result.updated[0].sourceRef?.commitSha, 'newsha1', 'but the pin still follows the scan')
  console.log('ok - a server the source did not touch is re-pinned without being called updated')
}

function aServerThatLeftItsSourceKeepsWorkingAndSaysSo(): void {
  const installed = installedFromSource()
  const result = refreshSourceMcpServers({
    sourceId: SOURCE,
    servers: [installed],
    scan: scanWithServers([]),
    commitSha: 'newsha1',
  })
  assert.deepEqual(result.missing, ['context7'])
  assert.equal(result.updated.length, 1)
  const marked = result.updated[0]
  assert.equal(marked.sourceRef?.missing, true, 'the row draws its state line from this')
  assert.equal(marked.command, 'npx', 'and the config it runs on is untouched, so it keeps working')
  assert.equal(marked.enabled, true)

  // Marked once. A second sync of a source that still lacks it has nothing new
  // to say, and re-reporting would make every sync claim a fresh loss.
  const again = refreshSourceMcpServers({
    sourceId: SOURCE,
    servers: [marked],
    scan: scanWithServers([]),
    commitSha: 'newsha2',
  })
  assert.deepEqual(again.missing, [])
  assert.deepEqual(again.updated, [])
  console.log('ok - a server removed from its source keeps working, is marked once, and is never deleted')
}

function aServerThatComesBackLosesTheMark(): void {
  const marked = installedFromSource({
    sourceRef: { sourceId: SOURCE, itemId: 'context7', commitSha: 'oldsha0', missing: true },
  })
  const result = refreshSourceMcpServers({
    sourceId: SOURCE,
    servers: [marked],
    scan: scanWithServers([server()]),
    commitSha: 'newsha2',
  })
  assert.deepEqual(result.missing, [])
  assert.equal(result.updated[0].sourceRef?.missing, undefined, 'the state line goes when the reason does')
  console.log('ok - a server the source declares again stops saying it is gone')
}

function aRenamedEntryKeepsItsIdentityInTheSettingsMap(): void {
  // The settings map is keyed by id; rewriting the id would orphan the old
  // entry rather than update it.
  const installed = installedFromSource({ id: 'context7-renamed-by-the-user' })
  const result = refreshSourceMcpServers({
    sourceId: SOURCE,
    servers: [installed],
    scan: scanWithServers([server({ args: ['-y', '@upstash/context7-mcp@2'] })]),
    commitSha: 'newsha1',
  })
  assert.equal(result.updated[0].id, 'context7-renamed-by-the-user')
  assert.deepEqual(result.updated[0].args, ['-y', '@upstash/context7-mcp@2'])
  console.log('ok - a refresh updates the entry in place rather than adding a second one')
}

function envDefaultsFollowTheSourceAndFilledInValuesStay(): void {
  // The source ships one default and NAMES one variable it does not value —
  // the second is where a person's token goes.
  const before = {
    ...installedFromSource(),
    env: { API_BASE: 'https://old.example.com', CONTEXT7_TOKEN: 'sk-live-typed-by-hand', OLD_SECRET: 'sk-live-abc' },
    envVarNames: ['CONTEXT7_TOKEN', 'OLD_SECRET'],
  }
  const now = server({ env: { API_BASE: 'https://new.example.com' }, envVarNames: ['CONTEXT7_TOKEN', 'NEW_TOKEN'] })

  const result = refreshSourceMcpServers({
    sourceId: SOURCE,
    servers: [before],
    scan: scanWithServers([now]),
    commitSha: 'newsha1',
  })

  assert.deepEqual(result.changed, ['context7'])
  assert.deepEqual(result.updated[0].env, {
    // The source corrected its own default, so the correction lands. Merging
    // the stored map over the fresh one made every default un-updatable.
    API_BASE: 'https://new.example.com',
    // Named, unvalued, filled in by the person: theirs survives.
    CONTEXT7_TOKEN: 'sk-live-typed-by-hand',
  })
  // The variable the source withdrew goes with it, rather than living on in
  // every CLI config this entry writes.
  assert.equal('OLD_SECRET' in (result.updated[0].env ?? {}), false)
  assert.equal(result.updated[0].env?.NEW_TOKEN, undefined, 'a name with no value is not invented')
  assert.deepEqual(result.updated[0].envVarNames, ['CONTEXT7_TOKEN', 'NEW_TOKEN'])
  console.log('ok - a refresh takes the source\u2019s env defaults and keeps only the values a person filled in')
}

function aScanThatNeverLookedForServersSaysNothingAboutThem(): void {
  // A folder scan, or a listing cached before MCP servers were scanned at all,
  // carries no `mcpServers` field. Reading that as "the source declares none"
  // would mark every server it installed as gone on the next sync.
  const scan = scanOf([])
  assert.equal(scan.mcpServers, undefined)
  const result = refreshSourceMcpServers({
    sourceId: SOURCE,
    servers: [installedFromSource()],
    scan,
    commitSha: 'newsha1',
  })
  assert.deepEqual(result, { updated: [], changed: [], missing: [] })
  // …where a scan that DID look and found none is a real removal.
  const looked = refreshSourceMcpServers({
    sourceId: SOURCE,
    servers: [installedFromSource()],
    scan: scanWithServers([]),
    commitSha: 'newsha1',
  })
  assert.deepEqual(looked.missing, ['context7'])
  console.log('ok - a scan that never read MCP servers is not a source that dropped them')
}

async function main(): Promise<void> {
  await reportsWhatCameInAndWhatWent()
  await reCopiesOnlyTheHarnessesThatHoldTheSkill()
  await keepsASkillThatDisappearedUpstream()
  await reportsAFailedCopyWithoutStoppingTheRest()
  await leavesABundledSkillOfTheSameNameAlone()
  await leavesACopyInstalledFromAnotherSourceAlone()
  syncsTheServersItInstalledAndOnlyThose()
  unchangedDeclarationIsNotReportedAsAnUpdate()
  aServerThatLeftItsSourceKeepsWorkingAndSaysSo()
  aServerThatComesBackLosesTheMark()
  aRenamedEntryKeepsItsIdentityInTheSettingsMap()
  envDefaultsFollowTheSourceAndFilledInValuesStay()
  aScanThatNeverLookedForServersSaysNothingAboutThem()
  console.log('skills sync tests passed')
}

void main().catch((error: unknown) => {
  console.error(error)
  process.exitCode = 1
})
