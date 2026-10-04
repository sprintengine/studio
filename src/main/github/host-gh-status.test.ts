import assert from 'node:assert/strict'
import { test } from 'vitest'

import type { RunOutcome } from '../process-run'
import { ghInstallHint, ghSignInCommands, parseGhVersion } from '../../shared/host-gh'
import { probeHostGh } from './host-gh-status'

function host(answers: Array<Partial<RunOutcome>>) {
  const asked: string[][] = []
  return {
    asked,
    async runCommand(argv: readonly string[]): Promise<RunOutcome> {
      asked.push([...argv])
      return { code: 0, stdout: '', stderr: '', timedOut: false, ...answers[asked.length - 1] }
    },
  }
}

test('an installed, signed-in gh is read with two read-only commands, and the token never comes back', async () => {
  const machine = host([
    { stdout: 'gh version 2.62.0 (2024-11-14)\nhttps://github.com/cli/cli/releases/tag/v2.62.0\n' },
    {},
  ])
  assert.deepEqual(await probeHostGh(machine), { installed: true, version: '2.62.0', signedIn: true })
  assert.deepEqual(machine.asked[0], ['gh', '--version'])
  assert.equal(machine.asked[1]![0], 'sh')
  assert.match(machine.asked[1]![2]!, /gh auth token >\/dev\/null 2>&1$/u)
  assert.ok(!machine.asked.flat().some((arg) => /\blogin\b/u.test(arg)), 'nobody is signed in')
})

test('a gh with no token reads as not signed in; one whose check did not finish, as unknown', async () => {
  assert.equal((await probeHostGh(host([{ stdout: 'gh version 2.40.1' }, { code: 1 }])))?.signedIn, false)
  assert.equal(
    (await probeHostGh(host([{ stdout: 'gh version 2.40.1' }, { timedOut: true, code: 124 }])))?.signedIn,
    null,
  )
})

test('no gh on the machine is missing; a machine that does not answer is not a verdict', async () => {
  const missing = host([{ code: 127 }])
  assert.deepEqual(await probeHostGh(missing), { installed: false, version: null, signedIn: null })
  assert.equal(missing.asked.length, 1, 'no sign-in check for a gh that is not there')
  assert.equal(await probeHostGh(host([{ timedOut: true, code: 124 }])), null)
  assert.equal(await probeHostGh(host([{ spawnFailed: true, code: -1 }])), null)
})

test('the hints: Homebrew only on a Mac, the Windows sign-in reused only inside WSL', () => {
  assert.equal(parseGhVersion('gh version 2.62.0 (2024-11-14)'), '2.62.0')
  assert.equal(parseGhVersion('bash: gh: command not found'), null)
  assert.equal(ghInstallHint({ kind: 'ssh', os: 'Darwin' }).command, 'brew install gh')
  assert.equal(ghInstallHint({ kind: 'ssh', os: 'Linux' }).command, null)
  assert.equal(ghInstallHint({ kind: 'wsl' }).command, null)
  assert.deepEqual(ghSignInCommands({ kind: 'wsl' }), [
    'gh auth login',
    'gh.exe auth token | gh auth login --with-token',
  ])
  assert.deepEqual(ghSignInCommands({ kind: 'ssh', os: 'Linux' }), ['gh auth login'])
})
