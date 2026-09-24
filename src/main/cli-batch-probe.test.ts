// On Windows, CLI detection asks about every CLI for one target in ONE
// process: a login shell in the WSL distribution, or one PowerShell. These
// cases pin the script, the parse of what it prints, and the process count.
// PowerShell cannot run here; the WSL script is POSIX, so it is run through a
// real `sh` the way `wsl.exe --exec sh -s` would run it.

import type { ExecutionHostId } from '../shared/execution-host'
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, beforeEach, test } from 'vitest'

import type { AgentCli, CliDetectResult, CliRuntimeSettings } from '../shared/electron-api'
import type { PluginRegistryListEntry } from '../shared/plugin-manifest'
import { clearCliAvailabilityCache, detectAgentCliAvailability } from './cli-availability'
import { buildBatchProbeDescriptor, detectCliBatch, parseBatchProbeOutput } from './cli-runtime-install'
import { createPluginRegistry } from './plugin-registry'
import { __resetPluginRegistryForTest, __setPluginRegistryForTest } from './plugin-registry-instance'
import type { RunOutcome, SpawnDescriptor } from './process-run'

let temp = ''

beforeAll(() => {
  temp = mkdtempSync(join(tmpdir(), 'se-cli-batch-'))
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

beforeEach(() => clearCliAvailabilityCache())

// What a WSL batch printed for four CLIs, captured with a login banner in
// front and Windows line endings: found with a version, not found, found but
// silent past its own deadline, and one the shell never reached.
const WSL_FIXTURE = [
  'Welcome to Ubuntu 24.04 LTS',
  '@@SPRINTENGINE_CLI 0',
  'SPRINTENGINE_PATH:/home/dev/.local/bin/claude',
  '2.1.4 (Claude Code)',
  '@@SPRINTENGINE_CLI 1',
  '@@SPRINTENGINE_NOT_FOUND',
  '@@SPRINTENGINE_CLI 2',
  'SPRINTENGINE_PATH:/usr/local/bin/codex',
  '@@SPRINTENGINE_TIMED_OUT',
  '@@SPRINTENGINE_CLI 9',
  'stray output from an index nobody asked for',
  '',
].join('\r\n')

test('a batch parse reads found, missing, silent and unanswered CLIs apart', () => {
  const answers = parseBatchProbeOutput(WSL_FIXTURE, 4)
  assert.deepEqual(answers[0], {
    installed: true,
    version: '2.1.4 (Claude Code)',
    resolvedPath: '/home/dev/.local/bin/claude',
  })
  assert.deepEqual(answers[1], { installed: false, version: null, resolvedPath: null })
  assert.deepEqual(answers[2], { installed: true, version: null, resolvedPath: '/usr/local/bin/codex' })
  assert.ok('error' in answers[3], 'no block is an error, never "not installed"')
})

test('a batch parse of garbage answers nothing', () => {
  const answers = parseBatchProbeOutput('wsl: Failed to start the distribution\r\n@@SPRINTENGINE_CLI x\r\n', 2)
  assert.equal(answers.length, 2)
  for (const answer of answers) assert.ok('error' in answer)
})

test('a PowerShell batch reads the same way', () => {
  const stdout = [
    '@@SPRINTENGINE_CLI 0',
    'SPRINTENGINE_PATH:C:\\Users\\dev\\AppData\\Roaming\\npm\\claude.ps1',
    '2.1.4 (Claude Code)',
    '',
    '@@SPRINTENGINE_CLI 1',
    '@@SPRINTENGINE_NOT_FOUND',
  ].join('\r\n')
  const [claude, codex] = parseBatchProbeOutput(stdout, 2)
  assert.deepEqual(claude, {
    installed: true,
    version: '2.1.4 (Claude Code)',
    resolvedPath: 'C:\\Users\\dev\\AppData\\Roaming\\npm\\claude.ps1',
  })
  assert.deepEqual(codex, { installed: false, version: null, resolvedPath: null })
})

test('the WSL batch names the distribution and sends its script on stdin', () => {
  const desc = buildBatchProbeDescriptor({
    requests: [{ binary: 'claude', versionArgs: ['--version'] }],
    target: 'wsl',
    distro: 'Ubuntu',
  })
  assert.equal(desc.file, 'wsl.exe')
  assert.deepEqual(desc.args, ['-d', 'Ubuntu', '--cd', '~', '--exec', 'sh', '-s'])
  assert.ok(!desc.args.some((arg) => arg.includes('claude')), 'nothing about the CLIs is on the command line')
  assert.match(desc.stdin ?? '', /probe 0 'claude' '--version' &/u)
})

test('the native batch is one encoded PowerShell command', () => {
  const desc = buildBatchProbeDescriptor({
    requests: [
      { binary: 'claude', versionArgs: ['--version'] },
      { binary: "it's", versionArgs: [] },
    ],
    target: 'win32',
  })
  assert.equal(desc.file, 'powershell.exe')
  const script = Buffer.from(desc.args.at(-1) ?? '', 'base64').toString('utf16le')
  assert.match(script, /@\{ b = 'claude'; a = @\('--version'\) \}/u)
  assert.match(script, /@\{ b = 'it''s'; a = @\(\) \}/u, 'single quotes are doubled for PowerShell')
})

function fakeCli(bin: string, name: string, body: string): void {
  const path = join(bin, name)
  writeFileSync(path, `#!/bin/sh\n${body}\n`, 'utf8')
  chmodSync(path, 0o755)
}

const HAS_BASH = spawnSync('bash', ['-c', 'true']).status === 0
const HAS_TIMEOUT = spawnSync('sh', ['-c', 'command -v timeout']).status === 0

test.skipIf(!HAS_BASH)('the WSL batch script runs every CLI in one shell and reports each', () => {
  const home = join(temp, 'home')
  const bin = join(home, 'bin')
  mkdirSync(bin, { recursive: true })
  // The login shell's profile is where a person's CLI directory joins PATH.
  writeFileSync(join(home, '.bash_profile'), 'export PATH="$HOME/bin:$PATH"\n', 'utf8')
  fakeCli(bin, 'alpha', 'echo "alpha 1.2.3"')
  // Arguments with quotes and `$` reach the CLI exactly as written.
  fakeCli(bin, 'echoer', 'printf "echoer 0.1 [%s]\\n" "$@"')
  // A CLI that reads stdin gets end-of-file, not the rest of the script.
  fakeCli(bin, 'reader', 'cat; echo "reader 9.9"')
  const desc = buildBatchProbeDescriptor({
    requests: [
      { binary: 'alpha', versionArgs: ['--version'] },
      { binary: 'missing-cli', versionArgs: ['--version'] },
      { binary: 'echoer', versionArgs: ["it's $HOME"] },
      { binary: 'reader', versionArgs: [] },
    ],
    target: 'wsl',
    distro: 'Ubuntu',
  })
  const stdout = execFileSync('sh', ['-s'], {
    input: desc.stdin,
    cwd: home,
    env: { HOME: home, PATH: '/usr/bin:/bin' },
    encoding: 'utf8',
    timeout: 20_000,
  })
  const [alpha, missing, echoer, reader] = parseBatchProbeOutput(stdout, 4)
  assert.deepEqual(alpha, { installed: true, version: 'alpha 1.2.3', resolvedPath: join(bin, 'alpha') })
  assert.deepEqual(missing, { installed: false, version: null, resolvedPath: null })
  assert.ok(!('error' in echoer) && echoer.version === "echoer 0.1 [it's $HOME]", JSON.stringify(echoer))
  assert.ok(!('error' in reader) && reader.version === 'reader 9.9', JSON.stringify(reader))
})

test.skipIf(!HAS_BASH || !HAS_TIMEOUT)('one hung CLI costs its own answer, not the batch', () => {
  const home = join(temp, 'home-slow')
  const bin = join(home, 'bin')
  mkdirSync(bin, { recursive: true })
  writeFileSync(join(home, '.bash_profile'), 'export PATH="$HOME/bin:$PATH"\n', 'utf8')
  fakeCli(bin, 'quick', 'echo "quick 1.0.0"')
  fakeCli(bin, 'hangs', 'sleep 30')
  const desc = buildBatchProbeDescriptor({
    requests: [
      { binary: 'hangs', versionArgs: [] },
      { binary: 'quick', versionArgs: [] },
    ],
    target: 'wsl',
    perCliTimeoutMs: 1_000,
  })
  const started = Date.now()
  const stdout = execFileSync('sh', ['-s'], {
    input: desc.stdin,
    cwd: home,
    env: { HOME: home, PATH: '/usr/bin:/bin' },
    encoding: 'utf8',
    timeout: 20_000,
  })
  assert.ok(Date.now() - started < 10_000, 'the hung CLI was cut off at its own deadline')
  const [hangs, quick] = parseBatchProbeOutput(stdout, 2)
  assert.deepEqual(hangs, { installed: true, version: null, resolvedPath: join(bin, 'hangs') })
  assert.ok(!('error' in quick) && quick.version === 'quick 1.0.0')
})

function outcome(stdout: string, code = 0): RunOutcome {
  return { code, stdout, stderr: '', timedOut: false }
}

test('detectCliBatch starts one process per machine, whatever the CLI count', async () => {
  const runs: SpawnDescriptor[] = []
  const results = await detectCliBatch(
    [
      { cli: 'claude-code', runtime: { hostId: 'wsl:Debian' } },
      { cli: 'codex', runtime: { hostId: 'wsl:Debian' } },
      { cli: 'opencode', runtime: { hostId: 'wsl:Debian' } },
      { cli: 'cursor', runtime: {} },
    ],
    {
      platform: 'win32',
      env: {},
      resolveDistro: async () => 'Ubuntu',
      run: async (desc) => {
        runs.push(desc)
        return desc.file === 'wsl.exe'
          ? outcome(
              [
                '@@SPRINTENGINE_CLI 0',
                'SPRINTENGINE_PATH:/home/dev/.local/bin/claude',
                '2.1.4',
                '@@SPRINTENGINE_CLI 1',
                '@@SPRINTENGINE_NOT_FOUND',
              ].join('\n'),
            )
          : outcome('@@SPRINTENGINE_CLI 0\n@@SPRINTENGINE_NOT_FOUND\n')
      },
    },
  )
  assert.equal(runs.length, 2, 'one wsl.exe for three WSL CLIs, one PowerShell for the native one')
  assert.deepEqual(
    runs.find((run) => run.file === 'wsl.exe')?.args.slice(0, 2),
    ['-d', 'Debian'],
    'the machine names its distribution; the default is not asked',
  )
  assert.deepEqual(
    results.map((result) => result.hostId),
    ['wsl:Debian', 'wsl:Debian', 'wsl:Debian', 'local'],
  )
  assert.deepEqual(
    results.map((result) => [result.cli, result.installed, result.error === null]),
    [
      ['claude-code', true, true],
      ['codex', false, true],
      // The batch printed nothing for it: unknown, not absent.
      ['opencode', false, false],
      ['cursor', false, true],
    ],
  )
})

test('two WSL machines are two probes, each in its own distribution', async () => {
  const runs: SpawnDescriptor[] = []
  await detectCliBatch(
    [
      { cli: 'claude-code', runtime: { hostId: 'wsl:Ubuntu' } },
      { cli: 'codex', runtime: { hostId: 'wsl:Debian' } },
      { cli: 'opencode', runtime: { hostId: 'wsl:Ubuntu' } },
    ],
    {
      platform: 'win32',
      env: {},
      run: async (desc) => {
        runs.push(desc)
        return outcome(
          '@@SPRINTENGINE_CLI 0\n@@SPRINTENGINE_NOT_FOUND\n@@SPRINTENGINE_CLI 1\n@@SPRINTENGINE_NOT_FOUND\n',
        )
      },
    },
  )
  assert.deepEqual(runs.map((run) => run.args.slice(0, 2)).sort(), [
    ['-d', 'Debian'],
    ['-d', 'Ubuntu'],
  ])
})

test('a batch whose wsl.exe failed reports every CLI as unanswered', async () => {
  const results = await detectCliBatch(
    [
      { cli: 'claude-code', runtime: { hostId: 'wsl:Ubuntu' } },
      { cli: 'codex', runtime: { hostId: 'wsl:Ubuntu' } },
    ],
    {
      platform: 'win32',
      env: {},
      resolveDistro: async () => null,
      run: async () => ({ code: 4294967295, stdout: '', stderr: 'There is no distribution.', timedOut: false }),
    },
  )
  for (const result of results) assert.match(result.error ?? '', /There is no distribution/u)
})

function entry(id: string): PluginRegistryListEntry {
  return {
    id,
    displayName: id,
    source: 'bundled',
    version: 1,
    binary: id,
    resumeSession: false,
    sessionIdFromCaller: false,
    agentStateCapable: true,
  }
}

function found(cli: AgentCli, hostId: ExecutionHostId): CliDetectResult {
  return {
    cli,
    binary: cli,
    installed: true,
    version: '1.0.0',
    resolvedPath: `/usr/bin/${cli}`,
    hostId,
    error: null,
  }
}

test('availability on Windows batches the cache misses and shares the batch with callers who arrive during it', async () => {
  const batches: Array<Array<{ cli: AgentCli; runtime?: Partial<CliRuntimeSettings> }>> = []
  let release: () => void = () => {}
  const gate = new Promise<void>((resolve) => (release = resolve))
  const deps = {
    platform: 'win32' as const,
    listEntries: () => ['claude-code', 'codex', 'cursor'].map(entry),
    detect: async () => {
      throw new Error('the per-CLI probe must not run on Windows')
    },
    detectBatch: async (requests: Array<{ cli: AgentCli; runtime?: Partial<CliRuntimeSettings> }>) => {
      batches.push(requests)
      await gate
      return requests.map((request) => found(request.cli, request.runtime?.hostId ?? 'local'))
    },
  }
  const input = {
    cliRuntimes: { 'claude-code': { hostId: 'wsl:Ubuntu' as const }, codex: { hostId: 'wsl:Ubuntu' as const } },
  }
  const first = detectAgentCliAvailability(input, deps)
  const second = detectAgentCliAvailability(input, deps)
  await Promise.resolve()
  release()
  const [a, b] = await Promise.all([first, second])
  assert.equal(batches.length, 2, 'one batch for the WSL CLIs and one for the native one, shared by both callers')
  assert.deepEqual(batches.map((batch) => batch.map((request) => request.cli).sort()).sort(), [
    ['claude-code', 'codex'],
    ['cursor'],
  ])
  assert.deepEqual(Object.keys(a).sort(), ['claude-code', 'codex', 'cursor'])
  assert.deepEqual(b, a)

  // Cached now: a third caller starts nothing.
  await detectAgentCliAvailability(input, deps)
  assert.equal(batches.length, 2)
})
