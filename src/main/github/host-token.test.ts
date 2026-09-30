import assert from 'node:assert/strict'

import type { GhResult, GhRunner } from './gh'
import { createGhHostTokenResolver } from './host-token'
import { test } from 'vitest'

test('gh host token', async () => {
  function runner(answer: (args: string[]) => GhResult): GhRunner & { calls: string[][] } {
    const calls: string[][] = []
    return {
      calls,
      available: async () => true,
      run: async (args) => {
        calls.push(args)
        return answer(args)
      },
    }
  }

  // The host's own sign-in, asked for by host, and asked once for a burst of reads.
  {
    const gh = runner(() => ({ found: true, code: 0, stdout: 'gho_companyToken\n', stderr: '' }))
    let clock = 0
    const resolve = createGhHostTokenResolver(gh, { ttlMs: 1000, now: () => clock })
    const burst = await Promise.all([
      resolve('GHE.example.com'),
      resolve('ghe.example.com'),
      resolve('ghe.example.com'),
    ])
    assert.deepEqual(burst, ['gho_companyToken', 'gho_companyToken', 'gho_companyToken'])
    assert.deepEqual(gh.calls, [['auth', 'token', '--hostname', 'ghe.example.com']])
    clock = 999
    await resolve('ghe.example.com')
    assert.equal(gh.calls.length, 1, 'remembered inside the window')
    clock = 1000
    await resolve('ghe.example.com')
    assert.equal(gh.calls.length, 2, 'and asked again after it')
  }

  // No sign-in, no gh, a timeout, or a failed spawn: '' — never a guess.
  for (const answer of [
    { found: true, code: 1, stdout: '', stderr: 'no oauth token found for ghe.example.com' },
    { found: false, code: -1, stdout: '', stderr: '' },
    { found: true, code: 0, stdout: 'gho_partial', stderr: '', timedOut: true },
    { found: true, code: 0, stdout: 'two words\n', stderr: '' },
  ] satisfies GhResult[]) {
    const resolve = createGhHostTokenResolver(runner(() => answer))
    assert.equal(await resolve('ghe.example.com'), '', JSON.stringify(answer))
  }
  {
    const gh: GhRunner = {
      available: async () => true,
      run: async () => {
        throw new Error('spawn failed')
      },
    }
    assert.equal(await createGhHostTokenResolver(gh)('ghe.example.com'), '')
  }
})
