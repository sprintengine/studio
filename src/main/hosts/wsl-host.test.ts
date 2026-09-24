import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'vitest'

import type { RunOutcome } from '../process-run'
import { buildWslGitScript, createWslHost, nativeGitOutput, wslGitArg, wslHostState } from './wsl-host'

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

test('the git script exports git environment and bounds a read with timeout', () => {
  const script = buildWslGitScript({
    cwd: '\\\\wsl.localhost\\Ubuntu\\home\\dev\\repo',
    args: ['status', '--porcelain=v2'],
    env: { LC_ALL: 'C', GIT_TERMINAL_PROMPT: '0', 'bad-name': 'x' },
    timeoutMs: 15_000,
  })
  assert.match(script, /^export LC_ALL='C'$/mu)
  assert.match(script, /^export GIT_TERMINAL_PROMPT='0'$/mu)
  assert.doesNotMatch(script, /bad-name/u)
  assert.match(
    script,
    /exec timeout -k 2 15 'git' '-C' '\/home\/dev\/repo' 'status' '--porcelain=v2'; else exec 'git' '-C'/u,
  )
  const write = buildWslGitScript({ cwd: 'C:\\repo', args: ['commit', '-m', "it's done"], env: {}, timeoutMs: null })
  assert.equal(write, `exec 'git' '-C' '/mnt/c/repo' 'commit' '-m' 'it'\\''s done'`, 'a write has no deadline')
})

test('the git script runs as sh reads it: quotes, dollars and spaces arrive intact', () => {
  const dir = mkdtempSync(join(tmpdir(), 'se-wsl-git-'))
  try {
    // Stand in for git with a script that prints what it was given.
    const bin = join(dir, 'bin')
    execFileSync('mkdir', ['-p', bin])
    writeFileSync(join(bin, 'git'), '#!/bin/sh\nprintf "%s\\n" "$LC_ALL" "$@"\n', 'utf8')
    chmodSync(join(bin, 'git'), 0o755)
    const script = buildWslGitScript({
      cwd: '/home/dev/my repo',
      args: ['log', '--format=%H $x "q"'],
      env: { LC_ALL: 'C' },
      timeoutMs: null,
    })
    const out = execFileSync('/bin/sh', ['-s'], {
      input: script,
      env: { PATH: `${bin}:${process.env.PATH}` },
      encoding: 'utf8',
    })
    assert.deepEqual(out.trimEnd().split('\n'), ['C', '-C', '/home/dev/my repo', 'log', '--format=%H $x "q"'])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
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

test('a distribution row reads as a host state', () => {
  assert.equal(wslHostState({ name: 'Ubuntu', isDefault: true, state: 'Running', version: 2 }).state, 'ready')
  assert.equal(wslHostState({ name: 'Ubuntu', isDefault: true, state: 'Stopped', version: 2 }).state, 'stopped')
  assert.equal(wslHostState({ name: 'Ubuntu', isDefault: true, state: 'Converting', version: 2 }).state, 'starting')
  assert.equal(wslHostState(undefined).state, 'unavailable')
})

function recorder(outcome: Partial<RunOutcome> = {}) {
  const calls: Array<{ distro: string | null; script: string; timeoutMs: number | null }> = []
  const run = async (distro: string | null, script: string, options: { timeoutMs: number | null }) => {
    calls.push({ distro, script, timeoutMs: options.timeoutMs })
    return { code: 0, stdout: '', stderr: '', timedOut: false, ...outcome }
  }
  return { calls, run }
}

test('a WSL host runs git and commands in its own distribution, through the stub runner', async () => {
  const { calls, run } = recorder({ stdout: '/home/dev/repo\n' })
  const host = createWslHost('Debian', { readSettings: () => undefined, listed: () => undefined, runScript: run })
  const git = await host.runGit('\\\\wsl.localhost\\Debian\\home\\dev\\repo', ['rev-parse', '--show-toplevel'], {
    timeoutMs: 15_000,
    env: { LC_ALL: 'C' },
  })
  assert.equal(git.stdout, '//wsl.localhost/Debian/home/dev/repo\n')
  assert.equal(calls[0].distro, 'Debian')
  assert.equal(calls[0].timeoutMs, 15_000)
  await host.runGit('C:\\repo', ['commit', '-m', 'x'], { timeoutMs: null, env: {} })
  assert.equal(calls[1].timeoutMs, null, 'a write keeps no deadline')

  await host.runCommand(['git', '--version'], { timeoutMs: 5_000, cwd: 'C:\\repo' })
  assert.match(calls[2].script, /^exec bash -l <</u, 'run in a login shell, for the PATH the person set up')
  assert.match(calls[2].script, /cd '\/mnt\/c\/repo' \|\| exit 1\nexec 'git' '--version' <\/dev\/null/u)
})

test("a WSL host's CLI runtime is its own command, tagged with the machine", () => {
  const host = createWslHost('Ubuntu', {
    readSettings: () => ({ enabled: true, cliCommands: { codex: ' /home/dev/.local/bin/codex ' }, env: {} }),
    listed: () => undefined,
  })
  assert.deepEqual(host.cliRuntime('codex', { command: 'C:\\tools\\codex.cmd' }), {
    command: '/home/dev/.local/bin/codex',
    hostId: 'wsl:Ubuntu',
  })
  assert.deepEqual(host.cliRuntime('claude-code', undefined), { command: '', hostId: 'wsl:Ubuntu' })
})
