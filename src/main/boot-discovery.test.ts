import assert from 'node:assert/strict'

import type { SplashProgress } from '../shared/electron-api'
import { runBootDiscovery } from './boot-discovery'
import { test } from 'vitest'

test('boot-discovery', async () => {
  type Deferred = { promise: Promise<void>; resolve: () => void; reject: (error: unknown) => void }

  function deferred(): Deferred {
    let resolve!: () => void
    let reject!: (error: unknown) => void
    const promise = new Promise<void>((res, rej) => {
      resolve = res
      reject = rej
    })
    return { promise, resolve, reject }
  }

  async function main(): Promise<void> {
    // Legs resolve OUT OF ORDER — that is the normal case, since they run
    // concurrently and the CLI probe dominates. The status line must always name a
    // leg that is genuinely still in flight, and the hairline must count only
    // finished work.
    {
      const cli = deferred()
      const editors = deferred()
      const updates = deferred()
      const seen: SplashProgress[] = []

      const done = runBootDiscovery({
        detectClis: () => cli.promise,
        detectEditors: () => editors.promise,
        checkUpdates: () => updates.promise,
        onProgress: (update) => seen.push({ ...update }),
      })

      assert.deepEqual(
        seen[0],
        { status: 'Finding your agents…', progress: 0 },
        'the first push names the slow leg, at an empty hairline',
      )

      // Editors finishes first (it is a synchronous existsSync sweep), but the CLI
      // leg is still running, so the line must NOT advance to a resolved leg.
      editors.resolve()
      await editors.promise
      assert.deepEqual(
        seen[seen.length - 1],
        { status: 'Finding your agents…', progress: 1 / 3 },
        'a leg resolving out of order advances the hairline but not past an in-flight leg',
      )

      cli.resolve()
      await cli.promise
      assert.deepEqual(
        seen[seen.length - 1],
        { status: 'Checking for updates…', progress: 2 / 3 },
        'the line advances to the next leg that is actually still running',
      )

      updates.resolve()
      await done
      assert.deepEqual(
        seen[seen.length - 1],
        { status: '', progress: 1 },
        'the hairline reaches full and the line clears rather than holding a stale leg',
      )

      // Never a percentage: the copy is what the user reads, and the legs cannot
      // honestly promise one.
      for (const update of seen) {
        assert.ok(!/\d/.test(update.status), `status copy must carry no number: ${update.status}`)
      }
    }

    // A failing leg is reported and still counts as resolved. Nothing downstream
    // consumes these results — the renderer re-probes authoritatively — so a
    // failure must cost a warmed cache, never the reveal.
    {
      const errors: { leg: string; error: unknown }[] = []
      const seen: SplashProgress[] = []

      await runBootDiscovery({
        detectClis: async () => {
          throw new Error('probe exploded')
        },
        detectEditors: async () => undefined,
        checkUpdates: async () => undefined,
        onProgress: (update) => seen.push({ ...update }),
        onLegError: (leg, error) => errors.push({ leg, error }),
      })

      assert.equal(errors.length, 1, 'the failure is reported, not swallowed')
      assert.equal(errors[0]?.leg, 'cli')
      assert.deepEqual(seen[seen.length - 1], { status: '', progress: 1 }, 'a failed leg still lets the pass complete')
    }

    // The update leg defaults to a no-op: boot-discovery must not need to know
    // whether this build can update itself. The lifecycle owns that guard.
    {
      const seen: SplashProgress[] = []
      await runBootDiscovery({
        detectClis: async () => undefined,
        detectEditors: async () => undefined,
        onProgress: (update) => seen.push({ ...update }),
      })
      assert.deepEqual(seen[seen.length - 1], { status: '', progress: 1 })
    }

    console.log('boot-discovery tests passed')
  }

  const suiteRun = main()

  await suiteRun
})
