import assert from 'node:assert/strict'

import type { GhResult, GhRunner, GhRunOptions } from './gh'
import { createGhHostTokenResolver } from './host-token'
import { test } from 'vitest'

test('gh host token', async () => {
  function runner(
    answer: (args: string[]) => GhResult,
  ): GhRunner & { calls: string[][]; options: Array<GhRunOptions | undefined> } {
    const calls: string[][] = []
    const options: Array<GhRunOptions | undefined> = []
    return {
      calls,
      options,
      available: async () => true,
      run: async (args, opts) => {
        calls.push(args)
        options.push(opts)
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
    // Only a sign-in stored for the host: an exported token gh would hand to
    // any host at all is kept from it.
    for (const name of ['GH_ENTERPRISE_TOKEN', 'GITHUB_ENTERPRISE_TOKEN', 'GH_TOKEN', 'GITHUB_TOKEN']) {
      assert.ok(gh.options[0]?.unsetEnv?.includes(name), `${name} is unset for the call`)
    }
    clock = 999
    await resolve('ghe.example.com')
    assert.equal(gh.calls.length, 1, 'remembered inside the window')
    clock = 1000
    await resolve('ghe.example.com')
    assert.equal(gh.calls.length, 2, 'and asked again after it')
  }

  // "No sign-in" is remembered only briefly, so signing in and trying again works.
  {
    let signedIn = false
    const gh = runner(() =>
      signedIn
        ? { found: true, code: 0, stdout: 'gho_fresh\n', stderr: '' }
        : { found: true, code: 1, stdout: '', stderr: 'not logged in' },
    )
    let clock = 0
    const resolve = createGhHostTokenResolver(gh, { ttlMs: 60_000, emptyTtlMs: 100, now: () => clock })
    assert.equal(await resolve('ghe.example.com'), '')
    signedIn = true
    clock = 50
    assert.equal(await resolve('ghe.example.com'), '', 'inside the short window')
    clock = 100
    assert.equal(await resolve('ghe.example.com'), 'gho_fresh', 'and read again after it')
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
