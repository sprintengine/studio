import assert from 'node:assert/strict'

import {
  buildShellGhDescriptor,
  createDefaultGhRunner,
  sharedGhRunner,
  type GhSpawn,
} from './gh'
import { createGhCommandRunner } from '../automations/pull-request'

// Nothing here spawns a real `gh`: every case injects the spawn seam, so the
// tests describe the runner's decisions rather than the machine they run on.

type Call = {
  file: string
  args: string[]
  cwd?: string
  timeout?: number
  killSignal?: NodeJS.Signals
}

function spawnStub(
  respond: (call: Call) => Promise<{ stdout: string; stderr: string }>,
): { spawn: GhSpawn; calls: Call[] } {
  const calls: Call[] = []
  const spawn: GhSpawn = (file, args, options) => {
    const call: Call = {
      file,
      args,
      ...(options.cwd ? { cwd: options.cwd } : {}),
      ...(options.timeout === undefined ? {} : { timeout: options.timeout }),
      ...(options.killSignal === undefined ? {} : { killSignal: options.killSignal }),
    }
    calls.push(call)
    return respond(call)
  }
  return { spawn, calls }
}

function enoent(): Promise<never> {
  return Promise.reject(Object.assign(new Error('spawn gh ENOENT'), { code: 'ENOENT' }))
}

// Wrapped in a main() because this suite bundles to CommonJS, where a
// top-level await is not available.
async function main(): Promise<void> {
  // ---------------------------------------------------------------------------
  // The PATH fallback: a GUI-launched app inherits no shell PATH, so a bare spawn
  // of a Homebrew `gh` fails with ENOENT and the runner retries through the login
  // shell that PTY terminals use.
  // ---------------------------------------------------------------------------
  {
    const { spawn, calls } = spawnStub((call) =>
      call.file === 'gh' ? enoent() : Promise.resolve({ stdout: 'gh version 2.55.0', stderr: '' }),
    )
    const gh = createDefaultGhRunner({ spawn, shell: '/bin/zsh', platform: 'darwin' })
    const result = await gh.run(['pr', 'list', '--head', "it's-a-branch"], { cwd: '/repo' })

    assert.equal(result.found, true, 'gh found through the login shell is found')
    assert.equal(result.code, 0)
    assert.equal(result.stdout, 'gh version 2.55.0')
    assert.deepEqual(calls.map((call) => call.file), ['gh', '/bin/zsh'], 'direct first, then the shell')
    assert.deepEqual(calls[1].args, ['-ilc', `'gh' 'pr' 'list' '--head' 'it'\\''s-a-branch'`])
    assert.deepEqual(calls.map((call) => call.cwd), ['/repo', '/repo'], 'the cwd reaches both attempts')
  }

  // A quote in an argument must not break out of the shell command line.
  {
    const descriptor = buildShellGhDescriptor(['pr', 'view', "a'; rm -rf /"], '/bin/bash', 'linux')
    assert.deepEqual(descriptor, {
      file: '/bin/bash',
      args: ['-ilc', `'gh' 'pr' 'view' 'a'\\''; rm -rf /'`],
    })
    assert.equal(buildShellGhDescriptor(['--version'], '/bin/zsh', 'win32'), null, 'no shell retry on Windows')
    assert.equal(buildShellGhDescriptor(['--version'], undefined, 'darwin'), null, 'no $SHELL, no retry')
    assert.equal(buildShellGhDescriptor(['--version'], '/usr/bin/fish', 'darwin'), null, 'only zsh/bash take -ilc')
  }

  // ---------------------------------------------------------------------------
  // `found: false` is reserved for a missing binary. Everything else is gh having
  // run and having an opinion — the distinction every caller that writes an answer
  // down depends on.
  // ---------------------------------------------------------------------------
  {
    const { spawn, calls } = spawnStub(() => enoent())
    const gh = createDefaultGhRunner({ spawn, shell: '/bin/zsh', platform: 'darwin' })
    const missing = await gh.run(['pr', 'list'])
    assert.equal(missing.found, false, 'ENOENT from both attempts means the binary is absent')
    assert.equal(calls.length, 2, 'the fallback was tried before giving up')
    assert.equal(await gh.available(), false)
  }
  {
    const { spawn } = spawnStub(() =>
      Promise.reject(Object.assign(new Error('exit 1'), { code: 1, stdout: '', stderr: 'no pull requests found' })),
    )
    const gh = createDefaultGhRunner({ spawn, shell: '/bin/zsh', platform: 'darwin' })
    const failed = await gh.run(['pr', 'list'])
    assert.equal(failed.found, true, 'gh ran; it just did not like the question')
    assert.equal(failed.code, 1)
    assert.equal(failed.stderr, 'no pull requests found')
    assert.equal(await gh.available(), false, 'a gh that is there but exits non-zero on --version is not usable')
  }

  // ---------------------------------------------------------------------------
  // ONE runner (epic decision 11): every caller — the version-control probe, the
  // review paths, and the automations path that used to lack the fallback
  // entirely — reaches this module's factory and its shell retry.
  // ---------------------------------------------------------------------------
  {
    assert.equal(sharedGhRunner(), sharedGhRunner(), 'one process-wide instance')
  }
  {
    const { spawn, calls } = spawnStub((call) =>
      call.file === 'gh' ? enoent() : Promise.resolve({ stdout: 'https://github.com/o/r/pull/7\n', stderr: '' }),
    )
    const runGh = createGhCommandRunner(createDefaultGhRunner({ spawn, shell: '/bin/zsh', platform: 'darwin' }))
    const result = await runGh('/worktree', ['pr', 'view', 'feature', '--json', 'url'])

    assert.deepEqual(result, { ok: true, stdout: 'https://github.com/o/r/pull/7\n', stderr: '' })
    assert.deepEqual(calls.map((call) => call.file), ['gh', '/bin/zsh'], 'the automations path gets the PATH fallback')
    assert.equal(calls[1].cwd, '/worktree', 'and still runs in the run worktree')
  }

  // The automations path keeps its Fallback Discipline wording: a missing gh is a
  // reason, never a faked pull request.
  {
    const missing = createGhCommandRunner({ available: async () => false, run: async () => ({ found: false, code: -1, stdout: '', stderr: '' }) })
    assert.deepEqual(await missing('/worktree', ['pr', 'create']), {
      ok: false,
      stdout: '',
      stderr: 'the GitHub CLI (gh) is not installed or not on PATH',
    })

    const failing = createGhCommandRunner({ available: async () => true, run: async () => ({ found: true, code: 1, stdout: '', stderr: '  ' }) })
    assert.deepEqual(await failing('/worktree', ['pr', 'create']), {
      ok: false,
      stdout: '',
      stderr: 'gh command failed',
    })
  }

  // ---------------------------------------------------------------------------
  // REVIEW FIX (finding 6). A read's bound has to KILL the child, not merely
  // stop waiting on it: a caller that races a timer leaves a `gh` — and on the
  // login-shell fallback a whole `$SHELL -ilc` — running behind every abandoned
  // probe, which on a hover-driven surface is one leaked process per probe.
  // ---------------------------------------------------------------------------
  {
    const { spawn, calls } = spawnStub(() => Promise.resolve({ stdout: '[]', stderr: '' }))
    const gh = createDefaultGhRunner({ spawn, shell: '/bin/zsh', platform: 'darwin' })
    await gh.run(['pr', 'list'], { cwd: '/repo', timeoutMs: 15_000 })
    assert.equal(calls[0].timeout, 15_000, 'the bound is the process table`s to enforce')
    assert.equal(calls[0].killSignal, 'SIGTERM')

    // No bound asked for, no kill terms invented.
    await gh.run(['pr', 'list'], { cwd: '/repo' })
    assert.equal(calls[1].timeout, undefined)
    assert.equal(calls[1].killSignal, undefined)

    // The fallback carries it too — that is the spawn that costs the most.
    const viaShell = spawnStub((call) =>
      call.file === 'gh' ? enoent() : Promise.resolve({ stdout: '[]', stderr: '' }),
    )
    const shellGh = createDefaultGhRunner({ spawn: viaShell.spawn, shell: '/bin/zsh', platform: 'darwin' })
    await shellGh.run(['pr', 'list'], { timeoutMs: 5_000 })
    assert.equal(viaShell.calls[1].timeout, 5_000, 'the login shell is killed on the same bound')
  }
  {
    // `execFile` reports its own timeout as a killed child: a signal, no exit
    // code. The binary was found and ran, so this is never `found: false` — it
    // is a read that did not happen, and the caller must not write anything down.
    const { spawn } = spawnStub(() =>
      Promise.reject(Object.assign(new Error('Command failed: gh pr list'), {
        killed: true,
        signal: 'SIGTERM',
        code: null,
        stdout: '',
        stderr: '',
      })),
    )
    const gh = createDefaultGhRunner({ spawn, shell: '/bin/zsh', platform: 'darwin' })
    const killed = await gh.run(['pr', 'list'], { timeoutMs: 1 })
    assert.equal(killed.found, true, 'the binary was there; it just did not finish')
    assert.equal(killed.timedOut, true, 'and the caller can tell that from an ordinary failure')
  }
}

main().then(
  () => console.log('github/gh: all assertions passed'),
  (error) => {
    console.error(error)
    process.exitCode = 1
  },
)
