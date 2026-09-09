import assert from 'node:assert/strict'

import {
  buildShellGhDescriptor,
  createDefaultGhRunner,
  sharedGhRunner,
  type GhSpawn,
} from './gh'
import { createGhCommandRunner } from '../automations/pull-request'
import { createDefaultGhRunner as createFromReviewProvider } from '../review/providers/github-pr-provider'

// Nothing here spawns a real `gh`: every case injects the spawn seam, so the
// tests describe the runner's decisions rather than the machine they run on.

type Call = { file: string; args: string[]; cwd?: string }

function spawnStub(
  respond: (call: Call) => Promise<{ stdout: string; stderr: string }>,
): { spawn: GhSpawn; calls: Call[] } {
  const calls: Call[] = []
  const spawn: GhSpawn = (file, args, options) => {
    const call: Call = { file, args, ...(options.cwd ? { cwd: options.cwd } : {}) }
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
  // ONE runner (epic decision 11): the review provider re-exports this module's
  // factory rather than owning a second one, and the automations path — the copy
  // that used to lack the fallback entirely — reaches the same shell retry.
  // ---------------------------------------------------------------------------
  {
    assert.equal(
      createFromReviewProvider,
      createDefaultGhRunner,
      'the review provider re-exports the shared factory, it does not define its own',
    )
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
}

main().then(
  () => console.log('github/gh: all assertions passed'),
  (error) => {
    console.error(error)
    process.exitCode = 1
  },
)
