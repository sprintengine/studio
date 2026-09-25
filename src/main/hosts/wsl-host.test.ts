// A WSL machine answers everything through its helper. These cases pin what
// main asks the helper (and in which form: Linux paths, argv arrays, deadlines)
// and how its answers come back, with a stand-in helper.

import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, test } from 'vitest'

import { STUB_HELPER_INFO, stubWslHelper } from '../../../tests/wsl-helper-stub'
import { createPluginRegistry } from '../plugin-registry'
import { __resetPluginRegistryForTest, __setPluginRegistryForTest } from '../plugin-registry-instance'
import { createWslHost, nativeGitOutput, wslGitArg, wslHostState } from './wsl-host'
import type { WslPluginCopy } from './wsl-plugin-copy'
import { WslSetupError } from './wsl-setup-error'

let temp = ''

beforeAll(() => {
  temp = mkdtempSync(join(tmpdir(), 'se-wsl-host-'))
  __resetPluginRegistryForTest()
  const registry = createPluginRegistry({
    bundledRoot: join(process.cwd(), 'resources', 'plugins'),
    userRoot: join(temp, 'no-user-plugins'),
  })
  __setPluginRegistryForTest(registry, registry.loadSync())
})

afterAll(() => {
  __resetPluginRegistryForTest()
  rmSync(temp, { recursive: true, force: true })
})

const PLUGIN_COPY: WslPluginCopy = {
  files: [{ path: 'sprintengine-studio/hooks/hooks.json', b64: '' }],
  digest: 'ab'.repeat(32),
  tree: 'plugin-abc123def456',
  root: `${STUB_HELPER_INFO.appDir}/plugin-abc123def456`,
  pluginDirs: [
    `${STUB_HELPER_INFO.appDir}/plugin-abc123def456/sprintengine-studio`,
    `${STUB_HELPER_INFO.appDir}/plugin-abc123def456/studio-skills`,
  ],
  statusLineScriptPath: `${STUB_HELPER_INFO.appDir}/plugin-abc123def456/sprintengine-studio/hooks/status-line.mjs`,
}

function hostWith(
  handlers: Parameters<typeof stubWslHelper>[1],
  extra: { plugin?: WslPluginCopy | null; launcher?: 'written' | 'failed' } = {},
) {
  const helper = stubWslHelper('Debian', handlers)
  const host = createWslHost('Debian', {
    readSettings: () => undefined,
    listed: () => undefined,
    helper,
    buildPluginCopy: async () => (extra.plugin === undefined ? PLUGIN_COPY : extra.plugin),
    survivorDelayMs: 0,
    ensureLauncher: async () => {
      if (extra.launcher === 'failed') throw new Error('the distribution refused the write')
    },
  })
  return { helper, host }
}

test('a git argument that is a Windows path crosses as the path in the distribution', () => {
  assert.equal(
    wslGitArg('C:\\Users\\dev\\repo\\.sprintengine-worktrees\\x'),
    '/mnt/c/Users/dev/repo/.sprintengine-worktrees/x',
  )
  assert.equal(wslGitArg('\\\\wsl.localhost\\Ubuntu\\home\\dev\\wt'), '/home/dev/wt')
  assert.equal(wslGitArg('--git-dir=C:\\repo\\.git'), '--git-dir=/mnt/c/repo/.git')
  assert.equal(wslGitArg('status'), 'status')
  assert.equal(wslGitArg(':(literal)src/[id].tsx'), ':(literal)src/[id].tsx')
  assert.equal(wslGitArg('origin/main'), 'origin/main')
})

test("git's absolute paths come back as Windows opens them", () => {
  assert.equal(
    nativeGitOutput(['rev-parse', '--show-toplevel'], '/home/dev/repo\n', 'Ubuntu'),
    '//wsl.localhost/Ubuntu/home/dev/repo\n',
  )
  assert.equal(
    nativeGitOutput(['rev-parse', '--show-toplevel'], '/mnt/c/Users/dev/repo\n', 'Ubuntu'),
    'C:/Users/dev/repo\n',
  )
  assert.equal(nativeGitOutput(['rev-parse', 'HEAD'], 'abc123\n', 'Ubuntu'), 'abc123\n', 'a sha is not a path')
  assert.equal(
    nativeGitOutput(
      ['worktree', 'list', '--porcelain'],
      'worktree /home/dev/repo\nHEAD abc\nbranch refs/heads/main\n\nworktree /home/dev/wt\n',
      'Ubuntu',
    ),
    'worktree //wsl.localhost/Ubuntu/home/dev/repo\nHEAD abc\nbranch refs/heads/main\n\nworktree //wsl.localhost/Ubuntu/home/dev/wt\n',
  )
  assert.equal(nativeGitOutput(['status', '--porcelain'], ' M /not/a/path\n', 'Ubuntu'), ' M /not/a/path\n')
})

test('with -z every worktree record comes back native, not only the first', () => {
  // What `git worktree list --porcelain -z` prints: NUL after each field, and
  // a second NUL between worktrees.
  const listing = [
    'worktree /home/dev/repo',
    'HEAD abc',
    'branch refs/heads/main',
    '',
    'worktree /home/dev/repo/.sprintengine-worktrees/repo/fix',
    'HEAD def',
    'branch refs/heads/fix',
    '',
    'worktree /mnt/c/Users/dev/other',
    'HEAD 123',
    'detached',
    '',
    '',
  ].join('\0')
  const native = nativeGitOutput(['worktree', 'list', '--porcelain', '-z'], listing, 'Ubuntu').split('\0')
  assert.deepEqual(
    native.filter((field) => field.startsWith('worktree ')),
    [
      'worktree //wsl.localhost/Ubuntu/home/dev/repo',
      'worktree //wsl.localhost/Ubuntu/home/dev/repo/.sprintengine-worktrees/repo/fix',
      'worktree C:/Users/dev/other',
    ],
  )
  assert.equal(native.length, listing.split('\0').length, 'the record structure is kept')
  assert.ok(!native.join('\0').includes('\n'), 'no newline is invented')
})

test("git's subcommand is read past its global options, so a -c value is never taken for it", () => {
  assert.equal(
    nativeGitOutput(['-c', 'core.quotepath=off', 'rev-parse', '--show-toplevel'], '/home/dev/repo\n', 'Ubuntu'),
    '//wsl.localhost/Ubuntu/home/dev/repo\n',
  )
  assert.equal(
    nativeGitOutput(['-C', '/home/dev/repo', 'worktree', 'list', '--porcelain'], 'worktree /home/dev/wt\n', 'Ubuntu'),
    'worktree //wsl.localhost/Ubuntu/home/dev/wt\n',
  )
  // A -c value that looks like a subcommand is still only a value.
  assert.equal(
    nativeGitOutput(['-c', 'rev-parse', 'status', '--porcelain'], ' M /x\n', 'Ubuntu'),
    ' M /x\n',
    'status output is left alone',
  )
})

test("git's stdin crosses to the helper as base64, byte for byte", async () => {
  const { helper, host } = hostWith({ git: () => ({ code: 0, stdout: 'a\0', stderr: '', timedOut: false }) })
  const patch = 'diff --git a/x b/x\r\n--- a/x\r\n+++ b/x\r\n@@ -1 +1 @@\r\n-é\r\n+ü\r\n'
  await host.runGit('\\\\wsl.localhost\\Debian\\home\\dev\\repo', ['apply', '--cached', '-'], {
    timeoutMs: null,
    env: {},
    stdin: patch,
  })
  const params = helper.requests[0].params as { stdinB64?: string }
  assert.equal(Buffer.from(params.stdinB64 ?? '', 'base64').toString('utf8'), patch)
  await host.runGit('\\\\wsl.localhost\\Debian\\home\\dev\\repo', ['status'], { timeoutMs: 1_000, env: {} })
  assert.equal('stdinB64' in (helper.requests[1].params as object), false, 'no stdin, no field')
})

test('a distribution row reads as a host state', () => {
  assert.equal(wslHostState({ name: 'Ubuntu', isDefault: true, state: 'Running', version: 2 }).state, 'ready')
  assert.equal(wslHostState({ name: 'Ubuntu', isDefault: true, state: 'Stopped', version: 2 }).state, 'stopped')
  assert.equal(wslHostState({ name: 'Ubuntu', isDefault: true, state: 'Converting', version: 2 }).state, 'starting')
  assert.equal(wslHostState(undefined).state, 'unavailable')
})

test('git runs through the helper with Linux paths, the runner env and its deadline; a write keeps none', async () => {
  const { helper, host } = hostWith({
    git: () => ({ code: 0, stdout: '/home/dev/repo\n', stderr: '', timedOut: false }),
  })
  const git = await host.runGit('\\\\wsl.localhost\\Debian\\home\\dev\\repo', ['rev-parse', '--show-toplevel'], {
    timeoutMs: 15_000,
    env: { LC_ALL: 'C' },
  })
  assert.equal(git.stdout, '//wsl.localhost/Debian/home/dev/repo\n')
  assert.deepEqual(helper.requests[0], {
    method: 'git',
    params: { cwd: '/home/dev/repo', args: ['rev-parse', '--show-toplevel'], timeoutMs: 15_000, env: { LC_ALL: 'C' } },
    timeoutMs: 25_000,
  })
  await host.runGit('C:\\repo', ['worktree', 'add', 'C:\\repo\\wt'], { timeoutMs: null, env: {} })
  assert.deepEqual(helper.requests[1].params, {
    cwd: '/mnt/c/repo',
    args: ['worktree', 'add', '/mnt/c/repo/wt'],
    timeoutMs: null,
    env: {},
  })
  assert.equal(helper.requests[1].timeoutMs, null, 'main waits as long as the write takes')
})

test('a command is an argv run by the helper, and a helper that cannot start is a failed run, not a throw', async () => {
  const { helper, host } = hostWith({
    run: () => ({ code: 0, stdout: 'git version 2.43.0\n', stderr: '', timedOut: false }),
  })
  const outcome = await host.runCommand(['git', '--version'], { timeoutMs: 5_000, cwd: 'C:\\repo' })
  assert.equal(outcome.stdout, 'git version 2.43.0\n')
  assert.deepEqual(helper.requests[0].params, { argv: ['git', '--version'], cwd: '/mnt/c/repo', timeoutMs: 5_000 })
  helper.failWith = new WslSetupError("Couldn't set up WSL: no network to download Node.js", {
    fatal: true,
    code: 'node-download',
  })
  await helper.shutdown()
  const failed = await host.runCommand(['git', '--version'], { timeoutMs: 5_000 })
  assert.equal(failed.spawnFailed, true)
  assert.match(failed.stderr, /no network to download Node\.js/u)
  assert.equal(host.summary().state, 'unavailable', 'the machine says why it cannot be used')
  assert.match(host.summary().reason ?? '', /no network/u)
})

test('the reaper reads sessions by pid-file key; a failed read holds them all', async () => {
  let fail = false
  const { helper, host } = hostWith({
    'proc.snapshot': () => {
      if (fail) throw new Error('gone')
      return { verdicts: { 'sid-a-1': 'listening_port', 'sid-b-2': null } }
    },
  })
  const refs = [
    { sessionId: 'a', rootPid: 11, startupScriptPath: 'C:\\Users\\dev\\terminal-startup\\sid-a-1.sh' },
    { sessionId: 'b', rootPid: 12, startupScriptPath: 'C:\\Users\\dev\\terminal-startup\\sid-b-2.sh' },
    { sessionId: 'c', rootPid: 13, startupScriptPath: 'C:\\Users\\dev\\terminal-startup\\sid-c-3.sh' },
    { sessionId: 'd', rootPid: 14 },
  ]
  const verdicts = await host.probeSubtrees(refs)
  assert.deepEqual(helper.requests[0].params, { keys: ['sid-a-1', 'sid-b-2', 'sid-c-3'] })
  assert.equal(verdicts.get('a'), 'listening_port')
  assert.equal(verdicts.get('b'), null)
  assert.equal(verdicts.has('c'), false, 'no verdict is undetermined')
  assert.equal(verdicts.has('d'), false, 'no pid file, no verdict')
  fail = true
  assert.equal((await host.probeSubtrees(refs)).size, 0)
})

test('the survivor kill names the session id and the pid file, and does nothing without either', async () => {
  const { helper, host } = hostWith({ 'proc.killSession': () => ({ killed: [101, 102] }) })
  assert.deepEqual(
    await host.killSessionSurvivors('11111111-2222', { startupScriptPath: 'C:\\x\\terminal-startup\\k-1.sh' }),
    [101, 102],
  )
  assert.deepEqual(helper.requests[0].params, { cliSessionId: '11111111-2222', key: 'k-1' })
  // A plain terminal has no CLI session: its shell's subtree is still ended.
  await host.killSessionSurvivors('', { startupScriptPath: 'C:\\x\\terminal-startup\\k-2.sh' })
  assert.deepEqual(helper.requests[1].params, { cliSessionId: '', key: 'k-2' })
  assert.deepEqual(await host.killSessionSurvivors(''), [])
  assert.equal(helper.requests.length, 2)
})

test('CLI detection is one request, read with the same parser as every probe', async () => {
  const { helper, host } = hostWith({
    'cli.detect': () => ({
      results: [
        { found: true, path: '/home/dev/.local/bin/claude', output: 'Welcome\n2.1.4 (Claude Code)', timedOut: false },
        { found: false },
        { error: 'EACCES' },
      ],
    }),
  })
  const results = await host.detectClis([
    { cli: 'claude-code' },
    { cli: 'codex', runtime: { command: '/opt/codex/bin/codex' } },
    { cli: 'opencode' },
    { cli: 'not-a-cli' },
  ])
  const asked = (helper.requests[0].params as { requests: Array<{ binary: string }> }).requests
  assert.deepEqual(
    asked.map((request) => request.binary),
    ['claude', '/opt/codex/bin/codex', 'opencode'],
  )
  assert.deepEqual(
    results.map((result) => [result.cli, result.installed, result.version, result.resolvedPath, result.hostId]),
    [
      ['claude-code', true, '2.1.4 (Claude Code)', '/home/dev/.local/bin/claude', 'wsl:Debian'],
      ['codex', false, null, null, 'wsl:Debian'],
      ['opencode', false, null, null, 'wsl:Debian'],
      ['not-a-cli', false, null, null, 'wsl:Debian'],
    ],
  )
  assert.equal(results[1].error, null, 'not found is an answer')
  assert.equal(results[2].error, 'EACCES', 'a failed check is not "not installed"')
  assert.match(results[3].error ?? '', /No plugin manifest/u)
  assert.equal('force' in (helper.requests[0].params as object), false, 'a plain read may reuse remembered versions')
})

// The helper keeps each binary's `--version` while its size and mtime stand
// still, and an npm update can leave both of a launcher script unchanged: the
// check after an update, and Re-check, must make it run `--version` again.
test('a forced detection tells the helper to look again', async () => {
  const { helper, host } = hostWith({ 'cli.detect': () => ({ results: [{ found: false }] }) })
  await host.detectClis([{ cli: 'claude-code' }], { force: true })
  assert.equal((helper.requests[0].params as { force?: boolean }).force, true)
})

test('prepare starts the helper, writes the plugin copy only when it changed, and exposes the integration', async () => {
  const trees: Array<{ digest: string; files: boolean }> = []
  let current = false
  const { host } = hostWith({
    home: () => ({ home: '/home/dev', env: { CLAUDE_CONFIG_DIR: '/home/dev/.claude-work', BAD: 'relative' } }),
    'files.ensureTree': (params: { digest: string; files?: unknown[] }) => {
      trees.push({ digest: params.digest, files: Array.isArray(params.files) })
      const answer = { root: PLUGIN_COPY.root, current: current || Array.isArray(params.files) }
      return answer
    },
  })
  assert.equal(host.agentIntegration(), null, 'nothing before the helper is up')
  await host.prepare()
  assert.deepEqual(trees, [
    { digest: PLUGIN_COPY.digest, files: false },
    { digest: PLUGIN_COPY.digest, files: true },
  ])
  const integration = host.agentIntegration()
  assert.ok(integration)
  assert.equal(integration.agentStateSocketPath, STUB_HELPER_INFO.agentSocket)
  assert.equal(integration.commandRuntime.executable, STUB_HELPER_INFO.nodePath)
  assert.equal(
    integration.commandRuntime.toCommandPath?.('\\\\wsl.localhost\\Debian\\home\\dev\\repo\\x.mjs'),
    '/home/dev/repo/x.mjs',
  )
  assert.deepEqual(integration.pluginDirs, PLUGIN_COPY.pluginDirs)
  // Hooks and the gateway run the distribution's own launcher, never the
  // pinned Node or this version's payload folder, which an update prunes.
  assert.deepEqual(integration.commandRuntime.launcher, {
    path: '/home/dev/.sprintengine/bin/studio-run',
    shell: 'posix',
  })
  assert.deepEqual(integration.studioMcpEntry, {
    command: '/bin/sh',
    args: ['/home/dev/.sprintengine/bin/studio-run', 'mcp'],
    env: { SPRINTENGINE_USER_DATA_DIR: STUB_HELPER_INFO.userDataDir },
    envVarNames: ['SPRINTENGINE_MCP_CHANNEL_TOKEN'],
  })
  assert.equal(JSON.stringify(integration.studioMcpEntry).includes(STUB_HELPER_INFO.appDir), false)
  assert.deepEqual(integration.home, {
    host: '/home/dev',
    native: '\\\\wsl.localhost\\Debian\\home\\dev',
    env: { CLAUDE_CONFIG_DIR: '\\\\wsl.localhost\\Debian\\home\\dev\\.claude-work' },
  })
  const target = host.launchTarget()
  assert.equal(target.kind === 'wsl' && target.integration?.agentStateSocketPath, STUB_HELPER_INFO.agentSocket)
  assert.equal(target.kind === 'wsl' && target.sessionDir, STUB_HELPER_INFO.sessionDir)
  assert.equal(target.kind === 'wsl' && target.pidDir, STUB_HELPER_INFO.pidDir)

  // A second prepare against the same helper does nothing again.
  current = true
  await host.prepare()
  assert.equal(trees.length, 2)
})

test('a launcher that could not be written leaves hooks and the gateway naming the pinned Node', async () => {
  const { host } = hostWith(
    { home: () => ({ home: '/home/dev' }), 'files.ensureTree': () => ({ current: true }) },
    { launcher: 'failed' },
  )
  await host.prepare()
  const integration = host.agentIntegration()
  assert.ok(integration)
  assert.equal(integration.commandRuntime.launcher, undefined, 'no command may name a launcher that is not there')
  assert.equal(integration.studioMcpEntry.command, STUB_HELPER_INFO.nodePath)
})

test('a helper that cannot start fails prepare with its reason, and one without the copy still launches', async () => {
  const { helper, host } = hostWith({}, { plugin: null })
  helper.failWith = new WslSetupError("Couldn't set up WSL: WSL is not installed on this PC.", {
    fatal: true,
    code: 'wsl-missing',
  })
  await assert.rejects(host.prepare(), /WSL is not installed on this PC/u)
  assert.equal(host.agentIntegration(), null)

  const ok = hostWith({ home: () => ({ home: '/home/dev' }) }, { plugin: null })
  await ok.host.prepare()
  assert.deepEqual(
    ok.host.agentIntegration()?.pluginDirs,
    [],
    'no copy, no --plugin-dir: the workspace install carries it',
  )
})

test('prepare does not finish on a preparation for a helper that restarted under it', async () => {
  // The helper restarts while `home` is being read: the first preparation is
  // for a helper that is gone, and a launch must not go ahead without hooks,
  // socket or gateway because of it.
  const first = { ...STUB_HELPER_INFO }
  const second = { ...STUB_HELPER_INFO, agentSocket: '/run/user/1000/sprintengine/abc123def456/agent-2.sock' }
  let current = first
  let homes = 0
  const helper = stubWslHelper('Debian', {
    home: () => {
      homes += 1
      if (homes === 1) current = second
      return { home: '/home/dev' }
    },
    'files.ensureTree': () => ({ current: true }),
  })
  helper.info = () => current
  helper.start = async () => current
  const host = createWslHost('Debian', {
    readSettings: () => undefined,
    listed: () => undefined,
    helper,
    buildPluginCopy: async () => PLUGIN_COPY,
    survivorDelayMs: 0,
  })
  await host.prepare()
  assert.equal(homes, 2, 'prepared again for the helper that is running now')
  assert.equal(host.agentIntegration()?.agentStateSocketPath, second.agentSocket)

  // One that keeps restarting fails with a reason rather than looping.
  let flips = 0
  const flapping = stubWslHelper('Debian', {
    home: () => {
      flips += 1
      current = { ...STUB_HELPER_INFO, agentSocket: `/run/flip-${flips}.sock` }
      return { home: '/home/dev' }
    },
    'files.ensureTree': () => ({ current: true }),
  })
  flapping.info = () => current
  flapping.start = async () => current
  const unstable = createWslHost('Debian', {
    readSettings: () => undefined,
    listed: () => undefined,
    helper: flapping,
    buildPluginCopy: async () => PLUGIN_COPY,
  })
  await assert.rejects(unstable.prepare(), /kept restarting/u)
})

test("a launch's files are written into the helper's directory by relative name, and nowhere else", async () => {
  const { helper, host } = hostWith({ 'session.write': () => ({ paths: [] }), 'session.remove': () => ({}) })
  await helper.start()
  const dir = STUB_HELPER_INFO.sessionDir
  await host.writeLaunchFiles?.([
    { path: `${dir}/sid-1-17.sh`, content: "export A='1'\n" },
    { path: `${dir}/host-context-sid-1/rules/host-context.mdc`, content: 'é' },
  ])
  const write = helper.requests.find((request) => request.method === 'session.write')
  assert.deepEqual(write?.params, {
    files: [
      { path: 'sid-1-17.sh', b64: Buffer.from("export A='1'\n").toString('base64') },
      { path: 'host-context-sid-1/rules/host-context.mdc', b64: Buffer.from('é').toString('base64') },
    ],
  })
  await assert.rejects(
    host.writeLaunchFiles?.([{ path: '/home/dev/.bashrc', content: 'x' }]) ?? Promise.reject(new Error('none')),
    /not inside the WSL helper's launch directory/u,
  )
  host.discardLaunchFiles?.([`${dir}/sid-1-17.sh`, `${dir}/host-context-sid-1`, '/etc/passwd', undefined])
  await new Promise((resolve) => setTimeout(resolve, 0))
  const remove = helper.requests.find((request) => request.method === 'session.remove')
  assert.deepEqual(remove?.params, { names: ['sid-1-17.sh', 'host-context-sid-1'] })
  // A stopped helper is not started to tidy.
  await helper.shutdown()
  const before = helper.starts
  host.discardLaunchFiles?.([`${dir}/sid-2-18.sh`])
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.equal(helper.starts, before)
})

test('at quit the survivor kill gives no grace and starts nothing', async () => {
  const { helper, host } = hostWith({ 'proc.killSession': () => ({ killed: [7] }) })
  assert.deepEqual(
    await host.killSessionSurvivors('', { startupScriptPath: '/x/sessions/k-1.sh', quitting: true }),
    [],
    'no helper running: nothing is started for it',
  )
  assert.equal(helper.starts, 0)
  await helper.start()
  const started = Date.now()
  assert.deepEqual(
    await host.killSessionSurvivors('', { startupScriptPath: '/x/sessions/k-1.sh', quitting: true }),
    [7],
  )
  assert.ok(Date.now() - started < 1_000)
})

test("a WSL host's MCP channel tokens and directory watches are its helper's", () => {
  const { helper, host } = hostWith({})
  const token = host.issueChannelToken?.() ?? ''
  assert.ok(helper.tokens.has(token))
  host.revokeChannelToken?.(token)
  assert.equal(helper.tokens.size, 0)
  const heard: Array<string | null> = []
  const watcher = host.watchDir?.('\\\\wsl.localhost\\Debian\\home\\dev\\repo\\.git', true, (name) => heard.push(name))
  assert.ok(watcher)
  const errors: Error[] = []
  watcher.on('error', (error) => errors.push(error))
  assert.equal(helper.watches[0].path, '/home/dev/repo/.git', 'watched as Linux names it')
  assert.equal(helper.watches[0].recursive, true)
  helper.watches[0].listener('HEAD')
  assert.deepEqual(heard, ['HEAD'])
  helper.watches[0].onError()
  assert.equal(errors.length, 1)
  watcher.close()
  assert.equal(helper.watches[0].closed, true)
})

test('a session holds the helper and lets it go', () => {
  const { helper, host } = hostWith({})
  host.retainSession('sid#1')
  assert.deepEqual([...helper.retained], ['sid#1'])
  host.releaseSession('sid#1')
  assert.equal(helper.retained.size, 0)
})

test("a WSL host's CLI runtime is its own command, tagged with the machine", () => {
  const host = createWslHost('Ubuntu', {
    readSettings: () => ({ enabled: true, cliCommands: { codex: ' /home/dev/.local/bin/codex ' }, env: {} }),
    listed: () => undefined,
    helper: stubWslHelper('Ubuntu'),
  })
  assert.deepEqual(host.cliRuntime('codex', { command: 'C:\\tools\\codex.cmd' }), {
    command: '/home/dev/.local/bin/codex',
    hostId: 'wsl:Ubuntu',
  })
  assert.deepEqual(host.cliRuntime('claude-code', undefined), { command: '', hostId: 'wsl:Ubuntu' })
})
