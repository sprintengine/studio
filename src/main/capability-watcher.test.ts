import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type {
  PluginManifest,
  PluginRegistryListEntry,
  PluginSkillCatalog,
} from '../shared/plugin-manifest'
import type { AgentCapabilitiesInvalidation } from '../shared/skills'
import { createMcpServerResolver } from './mcp-config-readers/resolve-servers'
import { createAgentCapabilityService, createFsSkillDirectoryReader } from './workspace-skills-service'
import {
  capabilityWatchGroups,
  createCapabilityWatcher,
  createFsWatchDirectory,
  type WatchDirectory,
  type WatchHandle,
} from './capability-watcher'

// Real `fs.watch` needs real time: the debounce, and then the OS delivering the
// event. Every wait below is a deadline on a condition, never a fixed sleep.
const DEBOUNCE_MS = 250
const DEADLINE_MS = 5000

function entry(id: string, skillIntegration?: PluginSkillCatalog): PluginRegistryListEntry {
  return {
    id,
    displayName: id,
    source: 'bundled',
    version: 1,
    binary: id,
    resumeSession: false,
    sessionIdFromCaller: false,
    ...(skillIntegration ? { skillIntegration } : {}),
  }
}

function nativeOn(harnessId: string, dir: string): PluginSkillCatalog {
  return {
    support: 'native',
    harnessId,
    installTargets: [
      { scope: 'workspace', path: `{{workspaceRoot}}/${dir}/skills/{{skillId}}`, format: 'claude-code', restartRequired: true },
    ],
  }
}

/** Only `mcpConfig` is read off the manifest, so only it is fixtured. */
function manifest(mcpConfig?: PluginManifest['mcpConfig']): PluginManifest {
  return { mcpConfig } as PluginManifest
}

const PLUGINS: PluginRegistryListEntry[] = [
  entry('claude-code', nativeOn('claude', '.claude')),
  entry('zai', nativeOn('claude', '.claude')),
  entry('codex', nativeOn('codex', '.codex')),
  // Declares an MCP config and no skill integration at all, the way cursor does.
  entry('cursor'),
]

const MANIFESTS = new Map<string, PluginManifest>([
  ['claude-code', manifest({ path: '{{workspaceRoot}}/.mcp.json', format: 'claude-code' })],
  ['zai', manifest({ path: '{{workspaceRoot}}/.mcp.json', format: 'claude-code' })],
  ['codex', manifest({ path: '{{workspaceRoot}}/.codex/config.toml', userPath: '{{home}}/.codex/config.toml', format: 'codex' })],
  ['cursor', manifest({ path: '{{workspaceRoot}}/.cursor/mcp.json', format: 'claude-code' })],
])

function watcherFor(options: {
  temp: string
  plugins?: PluginRegistryListEntry[]
  watchDirectory?: WatchDirectory
  onWorkspaceFocus?: (listener: () => void) => () => void
  maxWorkspaces?: number
  log?: (message: string) => void
}) {
  return createCapabilityWatcher({
    listPlugins: () => options.plugins ?? PLUGINS,
    lookupManifest: (pluginId) => MANIFESTS.get(pluginId),
    homeDir: () => join(options.temp, 'home'),
    debounceMs: DEBOUNCE_MS,
    watchDirectory: options.watchDirectory,
    onWorkspaceFocus: options.onWorkspaceFocus,
    maxWorkspaces: options.maxWorkspaces,
    log: options.log ?? (() => {}),
  })
}

function collector() {
  const events: AgentCapabilitiesInvalidation[] = []
  return {
    events,
    notify: (event: AgentCapabilitiesInvalidation) => {
      events.push(event)
    },
    async waitFor(predicate: () => boolean, what: string): Promise<void> {
      const deadline = Date.now() + DEADLINE_MS
      while (!predicate()) {
        if (Date.now() > deadline) assert.fail(`timed out waiting for ${what}; saw ${JSON.stringify(events)}`)
        await new Promise((resolve) => setTimeout(resolve, 10))
      }
    },
  }
}

/** Long enough that a second invalidation for the same change would have landed. */
async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, DEBOUNCE_MS * 6))
}

async function makeWorkspace(temp: string, name: string): Promise<string> {
  const workspaceRoot = join(temp, name)
  await mkdir(join(workspaceRoot, '.claude', 'skills'), { recursive: true })
  return workspaceRoot
}

// 1. The watched set is derived from the harness map and the manifests, so a
//    CLI nobody has heard of is watched with no edit to the watcher.
function testWatchedPathsAreDerived(temp: string): void {
  const workspaceRoot = join(temp, 'derived')
  const withFixture = [...PLUGINS, entry('fixture-cli', nativeOn('fixture', '.fixture'))]
  const groups = capabilityWatchGroups({
    plugins: withFixture,
    lookupManifest: (pluginId) => MANIFESTS.get(pluginId),
    workspaceRoot,
    homeDir: () => join(temp, 'home'),
  })

  const byHarness = new Map(groups.map((group) => [group.harnessId || group.pluginIds[0], group]))
  const fixture = byHarness.get('fixture')
  assert.ok(fixture, 'a plugin declaring a new harness is watched')
  assert.equal(fixture.skillsDir, join(workspaceRoot, '.fixture', 'skills'))

  const claude = byHarness.get('claude')
  assert.ok(claude)
  assert.deepEqual(claude.pluginIds, ['claude-code', 'zai'], 'both CLIs on the harness are addressed')
  assert.equal(claude.skillsDir, join(workspaceRoot, '.claude', 'skills'))
  assert.deepEqual(claude.configFiles, [join(workspaceRoot, '.mcp.json')], 'one shared file, once')

  const codex = byHarness.get('codex')
  assert.ok(codex)
  assert.deepEqual(
    codex.configFiles,
    [join(workspaceRoot, '.codex', 'config.toml'), join(temp, 'home', '.codex', 'config.toml')],
    'both declared scopes are watched',
  )

  // A CLI with an MCP config and no skill integration cannot be addressed by a
  // harness id, so it is its own group and names itself.
  const cursor = byHarness.get('cursor')
  assert.ok(cursor)
  assert.equal(cursor.harnessId, '')
  assert.deepEqual(cursor.pluginIds, ['cursor'])
  assert.equal(cursor.skillsDir, null)

  // And the watcher acts on that derivation: subscribing watches the fixture's
  // directory, with no production edit anywhere for a harness nobody declared.
  const watched: string[] = []
  const watcher = createCapabilityWatcher({
    listPlugins: () => withFixture,
    lookupManifest: (pluginId) => MANIFESTS.get(pluginId),
    homeDir: () => join(temp, 'home'),
    debounceMs: DEBOUNCE_MS,
    watchDirectory: (target) => {
      watched.push(target.path)
      return { close: () => {} }
    },
  })
  const release = watcher.subscribe(workspaceRoot, () => {})
  assert.ok(watched.includes(join(workspaceRoot, '.fixture', 'skills')), 'the new harness directory is watched')
  assert.ok(watched.includes(join(workspaceRoot, '.mcp.json')), 'the shared config file is watched')
  assert.ok(watched.includes(workspaceRoot), 'and its parent, for atomic-rename saves')
  release()
}

// 2. A skill directory created outside Multicode moves the pane, and an install
//    that writes ten files moves it once.
async function testSkillCreationInvalidatesOnce(temp: string): Promise<void> {
  const workspaceRoot = await makeWorkspace(temp, 'created')
  const watcher = watcherFor({ temp })
  const seen = collector()
  const release = watcher.subscribe(workspaceRoot, seen.notify)

  const skillDir = join(workspaceRoot, '.claude', 'skills', 'outside-multicode')
  await mkdir(skillDir, { recursive: true })
  await writeFile(join(skillDir, 'SKILL.md'), '---\nname: outside\n---\n', 'utf-8')

  await seen.waitFor(() => seen.events.length > 0, 'the created skill directory to invalidate')
  assert.deepEqual(seen.events[0], {
    workspaceRoot,
    harnessId: 'claude',
    pluginIds: ['claude-code', 'zai'],
  })
  await settle()
  const afterCreate = seen.events.length

  // A ten-file install: one invalidation after the debounce, not ten.
  const installed = join(workspaceRoot, '.claude', 'skills', 'ten-files')
  await mkdir(installed, { recursive: true })
  await Promise.all(
    Array.from({ length: 10 }, (_unused, index) =>
      writeFile(join(installed, `file-${index}.md`), `body ${index}`, 'utf-8')),
  )
  await seen.waitFor(() => seen.events.length > afterCreate, 'the install to invalidate')
  await settle()
  assert.equal(seen.events.length, afterCreate + 1, 'ten files coalesce into one invalidation')

  release()
}

// 3. Coalescing itself, without the OS in the way: however many changes arrive
//    inside the debounce window, the group is invalidated once.
async function testChangesCoalesceIntoOneEvent(temp: string): Promise<void> {
  const workspaceRoot = await makeWorkspace(temp, 'coalesce')
  const fired: Array<(filename: string | null) => void> = []
  const watcher = watcherFor({
    temp,
    watchDirectory: (_target, onChange) => {
      fired.push(onChange)
      return { close: () => {} }
    },
  })
  const seen = collector()
  const release = watcher.subscribe(workspaceRoot, seen.notify)

  const skillsWatch = fired[0]
  assert.ok(skillsWatch, 'the skills directory is watched')
  for (let index = 0; index < 10; index += 1) skillsWatch(`file-${index}.md`)
  assert.equal(seen.events.length, 0, 'nothing is emitted before the debounce elapses')

  await seen.waitFor(() => seen.events.length > 0, 'the coalesced invalidation')
  await settle()
  assert.equal(seen.events.length, 1, 'ten changes are one invalidation')
  release()
}

// 4. A config file saved through a temp file and a rename replaces the inode,
//    which silently drops a watch on the file itself.
async function testAtomicRenameInvalidates(temp: string): Promise<void> {
  const workspaceRoot = await makeWorkspace(temp, 'atomic')
  const configPath = join(workspaceRoot, '.mcp.json')
  await writeFile(configPath, '{"mcpServers":{}}', 'utf-8')

  const watcher = watcherFor({ temp })
  const seen = collector()
  const release = watcher.subscribe(workspaceRoot, seen.notify)

  const staging = join(workspaceRoot, '.mcp.json.tmp')
  await writeFile(staging, '{"mcpServers":{"linear":{"command":"npx"}}}', 'utf-8')
  await rename(staging, configPath)

  await seen.waitFor(() => seen.events.length > 0, 'the atomic save to invalidate')
  assert.equal(seen.events[0].harnessId, 'claude')
  assert.equal(await readFile(configPath, 'utf-8'), '{"mcpServers":{"linear":{"command":"npx"}}}')

  // The second save is the one that proves the parent-directory fallback: the
  // first rename already replaced the inode the file watch was attached to.
  await settle()
  const afterFirstSave = seen.events.length
  await writeFile(staging, '{"mcpServers":{"docs":{"url":"https://example.test/mcp"}}}', 'utf-8')
  await rename(staging, configPath)
  await seen.waitFor(() => seen.events.length > afterFirstSave, 'the second atomic save to invalidate')
  release()
}

// 5. A skills directory that does not exist yet is not a fault, and the skill
//    that creates it still moves the pane.
async function testMissingDirectoryIsCaughtWhenItAppears(temp: string): Promise<void> {
  const workspaceRoot = join(temp, 'no-claude-dir')
  await mkdir(workspaceRoot, { recursive: true })

  const watcher = watcherFor({ temp })
  const seen = collector()
  const release = watcher.subscribe(workspaceRoot, seen.notify)
  assert.deepEqual(
    watcher.diagnosticsFor(workspaceRoot, 'claude-code'),
    [],
    'a directory the CLI never created is normal, not a watch failure',
  )

  await mkdir(join(workspaceRoot, '.claude', 'skills', 'late'), { recursive: true })
  await seen.waitFor(() => seen.events.length > 0, 'the directory appearing to invalidate')
  assert.equal(seen.events[0].harnessId, 'claude')

  // And the real directory is watched now, not just its stand-in.
  const before = seen.events.length
  await writeFile(join(workspaceRoot, '.claude', 'skills', 'late', 'SKILL.md'), 'body', 'utf-8')
  await seen.waitFor(() => seen.events.length > before, 'the now-watched directory to invalidate')
  release()
}

// 6. Watchers belong to their subscribers: the last one out closes them, and
//    repeated open/close cycles leave nothing behind.
async function testLifecycleLeavesNothingOpen(temp: string): Promise<void> {
  const workspaceRoot = await makeWorkspace(temp, 'lifecycle')
  const real = createFsWatchDirectory()
  let open = 0
  const counting: WatchDirectory = (target, onChange) => {
    const handle = real(target, onChange)
    open += 1
    return {
      close: () => {
        open -= 1
        handle.close()
      },
    }
  }
  const watcher = watcherFor({ temp, watchDirectory: counting })

  for (let cycle = 0; cycle < 5; cycle += 1) {
    const first = watcher.subscribe(workspaceRoot, () => {})
    const opened = open
    assert.ok(opened > 0, 'subscribing starts the watchers')

    const second = watcher.subscribe(workspaceRoot, () => {})
    assert.equal(open, opened, 'a second consumer shares the watchers')
    second()
    assert.equal(open, opened, 'the watchers outlive one of two consumers')

    first()
    assert.equal(open, 0, `cycle ${cycle}: the last consumer to leave closes every watcher`)
  }

  // A second release from a stale handle must not tear down a live watcher.
  const release = watcher.subscribe(workspaceRoot, () => {})
  const other = watcher.subscribe(workspaceRoot, () => {})
  release()
  release()
  assert.ok(open > 0, 'releasing twice does not close another consumer’s watchers')
  other()
  assert.equal(open, 0)
}

// 7. `fs.watch` is unreliable on network mounts and in some containers. A
//    watcher that will not start degrades to refetch-on-focus and says so.
async function testFailedWatcherDegradesHonestly(temp: string): Promise<void> {
  const workspaceRoot = await makeWorkspace(temp, 'degraded')
  const refusing: WatchDirectory = () => {
    throw Object.assign(new Error('EPERM: operation not permitted, watch'), { code: 'EPERM' })
  }
  const focusListeners: Array<() => void> = []
  const watcher = watcherFor({
    temp,
    watchDirectory: refusing,
    onWorkspaceFocus: (listener) => {
      focusListeners.push(listener)
      return () => focusListeners.splice(focusListeners.indexOf(listener), 1)
    },
  })

  const seen = collector()
  const release = watcher.subscribe(workspaceRoot, seen.notify)

  const diagnostics = watcher.diagnosticsFor(workspaceRoot, 'claude-code')
  assert.ok(diagnostics.length > 0, 'a watcher that cannot start is visible in the payload')
  assert.ok(diagnostics.every((diagnostic) => diagnostic.capability === 'freshness'))
  assert.ok(diagnostics.every((diagnostic) => diagnostic.reason === 'watch_unavailable'))
  assert.ok(
    diagnostics.some((diagnostic) => diagnostic.path === join(workspaceRoot, '.claude', 'skills')),
    'the diagnostic names the path it could not watch',
  )
  assert.ok(diagnostics.every((diagnostic) => diagnostic.message.includes('focus')), 'it states the fallback')
  assert.deepEqual(
    watcher.diagnosticsFor(workspaceRoot, 'codex'),
    watcher.diagnosticsFor(workspaceRoot, 'codex'),
    'diagnostics are per CLI and repeatable',
  )

  assert.equal(seen.events.length, 0, 'nothing is invalidated until the fallback fires')
  assert.equal(focusListeners.length, 1, 'the fallback subscribed to focus')
  focusListeners[0]()
  assert.ok(seen.events.length > 0, 'regaining focus refetches what could not be watched')
  assert.ok(seen.events.some((event) => event.harnessId === 'claude'))

  release()
  assert.equal(focusListeners.length, 0, 'the focus listener goes when the last workspace does')
  assert.deepEqual(watcher.diagnosticsFor(workspaceRoot, 'claude-code'), [], 'nothing is watched, nothing is claimed')
}

// 8. The workspace cap is stated, not applied silently.
async function testWorkspaceCapIsStated(temp: string): Promise<void> {
  const logged: string[] = []
  let opened = 0
  const counting: WatchDirectory = (): WatchHandle => {
    opened += 1
    return { close: () => {} }
  }
  const watcher = watcherFor({
    temp,
    watchDirectory: counting,
    maxWorkspaces: 1,
    log: (message) => logged.push(message),
  })

  const first = await makeWorkspace(temp, 'capped-1')
  const second = await makeWorkspace(temp, 'capped-2')
  const releaseFirst = watcher.subscribe(first, () => {})
  const afterFirst = opened
  const releaseSecond = watcher.subscribe(second, () => {})

  assert.equal(opened, afterFirst, 'past the cap nothing new is watched')
  assert.equal(logged.length, 1, 'the cap is logged when it bites')
  assert.ok(logged[0].includes(second))
  const capped = watcher.diagnosticsFor(second, 'claude-code')
  assert.equal(capped.length, 1)
  assert.equal(capped[0].reason, 'watch_unavailable')
  assert.deepEqual(watcher.diagnosticsFor(first, 'claude-code'), [], 'the watched workspace is not maligned')

  releaseFirst()
  releaseSecond()
}

// 9. The fallback is not just knowable, it is *in the payload*: the capability
//    answer a surface renders carries the freshness fault beside the read ones.
async function testDegradeReachesTheCapabilityResult(temp: string): Promise<void> {
  const workspaceRoot = await makeWorkspace(temp, 'payload')
  const watcher = watcherFor({
    temp,
    watchDirectory: () => {
      throw Object.assign(new Error('EPERM: operation not permitted, watch'), { code: 'EPERM' })
    },
  })
  const capabilities = createAgentCapabilityService({
    reader: createFsSkillDirectoryReader(),
    listPlugins: () => PLUGINS,
    lookupManifest: (pluginId) => MANIFESTS.get(pluginId),
    mcpResolver: createMcpServerResolver({ homeDir: () => join(temp, 'home') }),
    freshness: watcher,
  })

  const before = await capabilities.resolve({ workspaceRoot, pluginId: 'claude-code' })
  assert.ok(before.ok)
  assert.deepEqual(before.diagnostics, [], 'nothing is subscribed, so nothing claims to be watching')

  const release = watcher.subscribe(workspaceRoot, () => {})
  const during = await capabilities.resolve({ workspaceRoot, pluginId: 'claude-code' })
  assert.ok(during.ok)
  assert.ok(
    during.diagnostics.some((diagnostic) =>
      diagnostic.capability === 'freshness' && diagnostic.reason === 'watch_unavailable'),
    'the surface can say the list may be stale',
  )
  assert.ok(during.skills.length >= 0 && during.diagnostics.every((diagnostic) => diagnostic.reason !== 'unreadable'),
    'a watch failure is not reported as a failed read')
  release()
}

// 10. No polling, anywhere in the added code — `fs.watchFile` polls, and so does
//    any interval. The one timer is the debounce.
async function testNoPollingLoop(): Promise<void> {
  const source = await readFile(join(process.cwd(), 'src', 'main', 'capability-watcher.ts'), 'utf-8')
  // Comments discuss what this file refuses to do, so they are not code.
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
  assert.ok(!/setInterval/.test(code), 'no interval')
  assert.ok(!/watchFile/.test(code), 'no fs.watchFile, which polls')
  assert.ok(!/while\s*\(\s*true\s*\)/.test(code), 'no spin loop')
  assert.equal(
    (code.match(/setTimeout/g) ?? []).length,
    1,
    'the only timer is the debounce',
  )
}

// 11. A write Multicode made itself says so, without waiting on the OS — and
//     the filesystem events that same write causes do not double it.
async function testInProcessWriteInvalidates(temp: string): Promise<void> {
  const workspaceRoot = await makeWorkspace(temp, 'attached')
  const watcher = watcherFor({ temp })
  const seen = collector()
  const release = watcher.subscribe(workspaceRoot, seen.notify)

  const skillDir = join(workspaceRoot, '.claude', 'skills', 'attached-by-multicode')
  await mkdir(skillDir, { recursive: true })
  await writeFile(join(skillDir, 'SKILL.md'), '---\nname: attached\n---\n', 'utf-8')
  watcher.invalidate(workspaceRoot, 'claude')

  await seen.waitFor(() => seen.events.length > 0, 'the write to invalidate')
  assert.deepEqual(seen.events[0], { workspaceRoot, harnessId: 'claude', pluginIds: ['claude-code', 'zai'] })
  await settle()
  assert.equal(seen.events.length, 1, 'the explicit call and the fs events it caused are one invalidation')

  // A harness nothing was written to stays quiet, and so does a workspace with
  // no subscriber — there is no surface holding a stale answer to correct.
  watcher.invalidate(workspaceRoot, 'codex')
  await settle()
  assert.equal(seen.events.length, 2, 'a second harness is its own invalidation')
  watcher.invalidate(join(temp, 'never-subscribed'), 'claude')
  await settle()
  assert.equal(seen.events.length, 2)

  release()
}

async function main(): Promise<void> {
  const temp = await mkdtemp(join(tmpdir(), 'multicode-capability-watcher-'))
  try {
    testWatchedPathsAreDerived(temp)
    await testSkillCreationInvalidatesOnce(temp)
    await testChangesCoalesceIntoOneEvent(temp)
    await testAtomicRenameInvalidates(temp)
    await testMissingDirectoryIsCaughtWhenItAppears(temp)
    await testLifecycleLeavesNothingOpen(temp)
    await testFailedWatcherDegradesHonestly(temp)
    await testWorkspaceCapIsStated(temp)
    await testDegradeReachesTheCapabilityResult(temp)
    await testInProcessWriteInvalidates(temp)
    await testNoPollingLoop()
    console.log('capability-watcher tests passed')
  } finally {
    await rm(temp, { recursive: true, force: true })
  }
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
