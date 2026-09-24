// The WSL helper's pure pieces, run as plain Node on macOS and Linux: the
// frame codec, the /proc readers against a fixture tree, the environment kept
// from a login shell, the file tree writer, and the argv runner.

import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, test } from 'vitest'

import {
  loadHelperModule,
  type CliDetectModule,
  type FilesModule,
  type FramesModule,
  type LoginEnvModule,
  type ProcModule,
  type RunModule,
  type SocketsModule,
} from '../../../../tests/wsl-helper-modules'
import { WSL_HELPER_PROTOCOL } from '../wsl-helper-client'

let temp = ''
let frames: FramesModule
let proc: ProcModule
let loginEnv: LoginEnvModule
let files: FilesModule
let run: RunModule
let sockets: SocketsModule
let detect: CliDetectModule

beforeAll(async () => {
  temp = mkdtempSync(join(tmpdir(), 'se-wsl-helper-core-'))
  frames = await loadHelperModule<FramesModule>('lib/frames.mjs')
  proc = await loadHelperModule<ProcModule>('lib/proc.mjs')
  loginEnv = await loadHelperModule<LoginEnvModule>('lib/login-env.mjs')
  files = await loadHelperModule<FilesModule>('lib/files.mjs')
  run = await loadHelperModule<RunModule>('lib/run.mjs')
  sockets = await loadHelperModule<SocketsModule>('lib/sockets.mjs')
  detect = await loadHelperModule<CliDetectModule>('lib/cli-detect.mjs')
})

afterAll(() => rmSync(temp, { recursive: true, force: true }))

test('both ends speak the same protocol integer', () => {
  assert.equal(frames.PROTOCOL_VERSION, WSL_HELPER_PROTOCOL)
})

test('the line decoder splits frames across chunk boundaries and drops blank lines', () => {
  const lines: string[] = []
  const decoder = frames.createLineDecoder({ maxLineBytes: 1024, onLine: (line) => lines.push(line) })
  decoder.push('{"a":1}\n{"b"')
  decoder.push(':2}\r\n\n  \n{"c":')
  assert.deepEqual(lines, ['{"a":1}', '{"b":2}'])
  assert.equal(decoder.pendingBytes(), 5)
  decoder.push(Buffer.from('3}\n'))
  assert.deepEqual(lines, ['{"a":1}', '{"b":2}', '{"c":3}'])
  assert.equal(frames.encodeFrame({ t: 'boot' }), '{"t":"boot"}\n')
  assert.deepEqual(frames.decodeFrame('{"t":"x"}'), { t: 'x' })
  assert.equal(frames.decodeFrame('[1]'), null, 'only objects are frames')
  assert.equal(frames.decodeFrame('nope'), null)
})

test('a line past the cap ends the decoder, with or without its newline', () => {
  for (const input of ['x'.repeat(40), `${'y'.repeat(40)}\n{"ok":1}\n`]) {
    let overflowed = 0
    const lines: string[] = []
    const decoder = frames.createLineDecoder({
      maxLineBytes: 32,
      onLine: (line) => lines.push(line),
      onOverflow: () => (overflowed += 1),
    })
    decoder.push(input)
    decoder.push('{"later":1}\n')
    assert.equal(overflowed, 1)
    assert.deepEqual(lines, [], 'nothing after an overflow is read')
  }
})

// ── /proc ────────────────────────────────────────────────────────────────────

test('stat fields are read after the last parenthesis, whatever the command name holds', () => {
  const line = '4242 (node (worker) x) S 4200 4242 4242 0 -1 4194560 100 0 0 0 250 50 0 0 20 0 11 0 777 0 0'
  assert.deepEqual(proc.parseProcStat(line), { pid: 4242, ppid: 4200, ticks: 300 })
  assert.equal(proc.parseProcStat('garbage'), null)
})

test('listening sockets are the LISTEN rows of tcp and tcp6, by inode', () => {
  const tcp = [
    '  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode',
    '   0: 0100007F:1435 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 51234 1 0000000000000000 100 0 0 10 0',
    '   1: 0100007F:A1B2 0100007F:1435 01 00000000:00000000 00:00000000 00000000  1000        0 51299 1 0000000000000000 20 4 30 10 -1',
  ].join('\n')
  assert.deepEqual([...proc.parseListeningInodes(tcp)], ['51234'])
  assert.equal(proc.socketInode('socket:[51234]'), '51234')
  assert.equal(proc.socketInode('pipe:[1]'), null)
})

// A fixture /proc: two WSL session shells (pid files keyed by their startup
// scripts). The first's Claude runs a dev server holding a port; the second's
// has only an MCP helper under it; a third key's shell was replaced by an
// unrelated process with the same pid.
function fixtureProc(): { procRoot: string; pidDir: string } {
  const root = join(temp, `proc-${Math.random().toString(16).slice(2)}`)
  const procRoot = join(root, 'proc')
  const pidDir = join(root, 'pids', 'sessions')
  mkdirSync(pidDir, { recursive: true })
  const add = (pid: number, ppid: number, ticks: number, argv: string[], fds: string[] = []) => {
    const dir = join(procRoot, String(pid))
    mkdirSync(join(dir, 'fd'), { recursive: true })
    writeFileSync(join(dir, 'stat'), `${pid} (${argv[0]}) S ${ppid} 1 1 0 -1 0 0 0 0 0 ${ticks} 0 0 0 20 0 1 0 1 0 0`)
    writeFileSync(join(dir, 'cmdline'), `${argv.join('\0')}\0`)
    fds.forEach((link, index) => symlinkSync(link, join(dir, 'fd', String(index))))
  }
  add(1, 0, 0, ['/init'])
  add(100, 1, 0, ['bash', '-li', '/mnt/c/Users/dev/AppData/Roaming/app/terminal-startup/sid-a-1.sh'])
  add(101, 100, 3, ['claude', '--session-id', 'aaaa'])
  add(102, 101, 1, ['node', 'vite'], ['socket:[51234]', 'pipe:[9]'])
  add(200, 1, 0, ['bash', '-li', '/mnt/c/Users/dev/AppData/Roaming/app/terminal-startup/sid-b-2.sh'])
  add(201, 200, 1, ['claude', '--session-id', 'bbbb'])
  add(202, 201, 0, ['node', 'mcp-server.js'])
  add(300, 1, 0, ['sleep', '1000'])
  mkdirSync(join(procRoot, 'net'), { recursive: true })
  writeFileSync(
    join(procRoot, 'net', 'tcp'),
    'header\n   0: 0100007F:1435 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 51234 1\n',
  )
  writeFileSync(join(procRoot, 'net', 'tcp6'), 'header\n')
  writeFileSync(join(pidDir, 'sid-a-1.pid'), '100\n')
  writeFileSync(join(pidDir, 'sid-b-2.pid'), '200\n')
  writeFileSync(join(pidDir, 'sid-c-3.pid'), '300\n')
  return { procRoot, pidDir }
}

test('a snapshot holds the session with a listening child, clears the quiet one, and leaves the rest undetermined', async () => {
  const { procRoot, pidDir } = fixtureProc()
  const verdicts = await proc.snapshot({
    procRoot,
    pidDir,
    keys: ['sid-a-1', 'sid-b-2', 'sid-c-3', 'sid-missing', '../escape'],
    sampleMs: 10,
    uid: process.getuid?.(),
  })
  assert.deepEqual(verdicts, { 'sid-a-1': 'listening_port', 'sid-b-2': null })
})

test('a snapshot of a pid directory someone else owns, or a /proc that is not there, says nothing', async () => {
  const { procRoot, pidDir } = fixtureProc()
  assert.deepEqual(
    await proc.snapshot({ procRoot, pidDir, keys: ['sid-a-1'], sampleMs: 1, uid: 12345 }),
    {},
    'a directory another user created is never read',
  )
  assert.deepEqual(await proc.snapshot({ procRoot: join(temp, 'no-proc'), pidDir, keys: ['sid-a-1'] }), {})
})

test('the live-work rule matches the reaper on this machine: port, then CPU, then a tool shell', () => {
  const rows = [
    { pid: 10, ppid: 1, ticks: 0, command: 'bash' },
    { pid: 11, ppid: 10, ticks: 0, command: 'claude' },
    { pid: 12, ppid: 11, ticks: 0, command: 'bash -c source /home/dev/.claude/shell-snapshots/s.sh && sleep 60' },
  ]
  assert.equal(proc.subtreeLiveReason(10, rows, new Set(), new Map()), 'tool_shell')
  assert.equal(proc.subtreeLiveReason(10, rows, new Set(), new Map([[11, 40]])), 'busy_cpu')
  assert.equal(proc.subtreeLiveReason(10, rows, new Set([12]), new Map()), 'listening_port')
  assert.equal(
    proc.subtreeLiveReason(11, rows.slice(0, 2), new Set([10]), new Map()),
    null,
    'the root itself does not count',
  )
})

test('survivors are the session id carriers and, while it runs its script, the shell subtree', () => {
  const { procRoot, pidDir } = fixtureProc()
  const uid = process.getuid?.()
  assert.deepEqual(
    proc
      .survivorPids({ procRoot, pidDir, cliSessionId: 'aaaa', key: 'sid-a-1', uid, selfPid: 999 })
      .sort((a, b) => a - b),
    [100, 101, 102],
  )
  assert.deepEqual(proc.survivorPids({ procRoot, pidDir, cliSessionId: 'bbbb', key: '', uid, selfPid: 999 }), [201])
  assert.deepEqual(
    proc.survivorPids({ procRoot, pidDir, cliSessionId: '', key: 'sid-c-3', uid, selfPid: 999 }),
    [],
    'a pid file whose pid now runs something else names nothing',
  )
  assert.deepEqual(
    proc.survivorPids({ procRoot, pidDir, cliSessionId: '', key: 'sid-a-1', uid, selfPid: 100 }).sort((a, b) => a - b),
    [101, 102],
    'the helper never lists itself',
  )
})

// ── The login environment ────────────────────────────────────────────────────

test('only the listed variables are kept from the login shell, and only after the sentinel', () => {
  const dump = Buffer.from(
    [
      'Welcome banner from .bashrc',
      '\0__SPRINTENGINE_ENV__\0',
      'PATH=/home/dev/.local/bin:/usr/bin\0',
      'SSH_AUTH_SOCK=/tmp/ssh-x/agent.1\0',
      'GIT_AUTHOR_NAME=Dev\0',
      'GH_TOKEN=secret\0',
      'LC_ALL=C.UTF-8\0',
      'AWS_SECRET_ACCESS_KEY=nope\0',
      'PS1=$ \0',
    ].join(''),
  )
  assert.deepEqual(loginEnv.parseEnvDump(dump), {
    PATH: '/home/dev/.local/bin:/usr/bin',
    SSH_AUTH_SOCK: '/tmp/ssh-x/agent.1',
    GIT_AUTHOR_NAME: 'Dev',
    GH_TOKEN: 'secret',
    LC_ALL: 'C.UTF-8',
  })
  assert.equal(loginEnv.parseEnvDump('no sentinel'), null)
  assert.equal(loginEnv.keepVariable('GIT_SSH_COMMAND'), true)
  assert.equal(loginEnv.keepVariable('OPENAI_API_KEY'), false)
})

test("the login shell is the person's from the password database, bash when it cannot be read", () => {
  const passwd = () => 'root:x:0:0:root:/root:/bin/bash\ndev:x:1000:1000:Dev:/home/dev:/usr/bin/zsh\n'
  assert.equal(loginEnv.loginShell(1000, passwd), '/usr/bin/zsh')
  assert.equal(loginEnv.loginShell(4242, passwd), '/bin/bash')
})

// ── Trees, argv runs, sockets, detection ─────────────────────────────────────

test('a tree lands whole with its marker, is skipped when current, and refuses a path that leaves it', () => {
  const appDir = join(temp, 'app')
  mkdirSync(appDir, { recursive: true })
  const digest = 'a'.repeat(64)
  const tree = [
    { path: 'sprintengine-studio/hooks/hooks.json', b64: Buffer.from('{"hooks":{}}').toString('base64') },
    { path: 'studio-skills/skills/x/SKILL.md', b64: Buffer.from('# x').toString('base64') },
  ]
  assert.deepEqual(files.ensureTree({ appDir, name: 'plugin', digest }), {
    root: join(appDir, 'plugin'),
    current: false,
  })
  assert.equal(files.ensureTree({ appDir, name: 'plugin', digest, files: tree }).current, true)
  assert.equal(readFileSync(join(appDir, 'plugin', 'studio-skills/skills/x/SKILL.md'), 'utf8'), '# x')
  assert.equal(readFileSync(join(appDir, 'plugin', '.ready'), 'utf8'), digest)
  assert.equal(statSync(join(appDir, 'plugin', 'sprintengine-studio/hooks/hooks.json')).mode & 0o077, 0)
  assert.equal(files.ensureTree({ appDir, name: 'plugin', digest }).current, true)
  // A new digest replaces the tree wholesale.
  files.ensureTree({ appDir, name: 'plugin', digest: 'b'.repeat(64), files: [tree[0]] })
  assert.throws(() => statSync(join(appDir, 'plugin', 'studio-skills')))
  for (const bad of ['../x', '/etc/passwd', 'a/../../x', 'a\\b', '', 'a//b']) {
    assert.equal(files.checkTreePath(bad), false, bad)
    assert.throws(() =>
      files.ensureTree({ appDir, name: 'plugin', digest: 'c'.repeat(64), files: [{ path: bad, b64: '' }] }),
    )
  }
  assert.throws(() => files.ensureTree({ appDir, name: '../up', digest }), /plain token/u)
})

test('a run is an argv with a deadline that ends the whole process group', async () => {
  assert.match(run.checkRunRequest({ argv: 'ls -la', timeoutMs: 1 }) ?? '', /array/u)
  assert.match(run.checkRunRequest({ argv: ['ls'], timeoutMs: 1, cwd: 'relative' }) ?? '', /absolute/u)
  assert.match(run.checkRunRequest({ argv: ['ls'], timeoutMs: 1, env: { 'BAD-NAME': 'x' } }) ?? '', /BAD-NAME/u)
  assert.match(run.checkRunRequest({ argv: ['ls'], timeoutMs: 0 }) ?? '', /positive/u)
  assert.equal(
    run.checkRunRequest({ argv: ['git', 'commit'], timeoutMs: null }),
    null,
    'no deadline is allowed for a write',
  )
  const echoed = await run.runArgv({
    argv: ['sh', '-c', 'printf "%s|%s" "$1" "$X"', 'sh', "it's $HOME"],
    env: { X: 'y' },
    timeoutMs: 5_000,
  })
  assert.equal(echoed.stdout, "it's $HOME|y", 'arguments arrive as written, never through a shell')
  const started = Date.now()
  const slow = await run.runArgv({ argv: ['sh', '-c', 'sleep 30 & sleep 30'], timeoutMs: 300 })
  assert.equal(slow.timedOut, true)
  assert.ok(Date.now() - started < 10_000, 'the deadline ended the child and what it started')
})

test('the socket directory is private and owned, and one planted by someone else is refused', () => {
  const uid = process.getuid?.() ?? 0
  const base = join(temp, 'rt')
  const dir = sockets.ensureSocketDir({ env: {}, uid, profile: 'abc123def456', base })
  assert.equal(dir, join(base, 'abc123def456'))
  assert.equal(statSync(base).mode & 0o777, 0o700)
  assert.equal(statSync(dir).mode & 0o777, 0o700)
  assert.throws(() => sockets.ensureSocketDir({ env: {}, uid: uid + 1, profile: 'abc123def456', base }), /refusing/u)
  const open = join(temp, 'open-rt')
  mkdirSync(open, { mode: 0o777 })
  statSync(open)
  assert.throws(() => sockets.ensureSocketDir({ env: {}, uid, profile: 'p', base: open }), /refusing/u)
  assert.throws(() => sockets.ensureSocketDir({ env: {}, uid, profile: '../x', base }), /plain token/u)
  assert.equal(sockets.runtimeBase({ env: { XDG_RUNTIME_DIR: open }, uid }), `/tmp/sprintengine-${uid}`)
  assert.equal(sockets.runtimeBase({ env: { XDG_RUNTIME_DIR: base }, uid }), join(base, 'sprintengine'))
})

test('a binary is found on the PATH the way the shell would, Linux directories first', () => {
  const bin = join(temp, 'bin')
  const winBin = join(temp, 'mnt-bin')
  mkdirSync(bin, { recursive: true })
  mkdirSync(winBin, { recursive: true })
  writeFileSync(join(bin, 'claude'), '#!/bin/sh\n', { mode: 0o755 })
  writeFileSync(join(bin, 'not-executable'), '', { mode: 0o644 })
  assert.equal(detect.resolveBinary('claude', { PATH: `${winBin}:${bin}` })?.path, join(bin, 'claude'))
  assert.equal(detect.resolveBinary('not-executable', { PATH: bin }), null)
  assert.equal(detect.resolveBinary(join(bin, 'claude'), { PATH: '' })?.path, join(bin, 'claude'))
  assert.equal(detect.resolveBinary('relative/claude', { PATH: bin }), null)
})
