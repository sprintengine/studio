// The runner, driven for real.
//
// `usePaletteProviders` makes four promises that only a clock and a render loop
// can check: warm once per palette, ask again when a warm settles, supersede
// (and cancel) a run whose query has moved on, and never write state into an
// unmounted palette. Each of those is a timing bug, and a timing bug cannot be
// asserted against a pure function — so this stands up a DOM and a root, the
// way useReviewSession.test.tsx does for the same reason.

import assert from 'node:assert/strict'

import { JSDOM } from 'jsdom'
import { test } from 'vitest'

test('paletteProvider', async () => {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', {
    url: 'http://localhost',
    pretendToBeVisual: true,
  })

  const anyGlobal = globalThis as unknown as Record<string, unknown>
  anyGlobal.document = dom.window.document
  anyGlobal.navigator = dom.window.navigator
  anyGlobal.HTMLElement = dom.window.HTMLElement
  anyGlobal.Node = dom.window.Node
  anyGlobal.getComputedStyle = dom.window.getComputedStyle
  anyGlobal.IS_REACT_ACT_ENVIRONMENT = true
  // The runner schedules debounces with `window.setTimeout` and clears them with
  // `window.clearTimeout`, so the window it reaches for has to be the real one.
  anyGlobal.window = dom.window

  let failures = 0
  const queue: (() => Promise<void>)[] = []
  function run(name: string, body: () => Promise<void>): void {
    queue.push(async () => {
      try {
        await body()
        console.log(`ok - ${name}`)
      } catch (error) {
        failures += 1
        console.error(`not ok - ${name}`)
        console.error(error)
      }
    })
  }

  async function main(): Promise<void> {
    const React = await import('react')
    const { act } = React
    const { createRoot } = await import('react-dom/client')
    const { usePaletteProviders } = await import('./paletteProvider')
    type PaletteCommand = import('./paletteProvider').PaletteCommand
    type PaletteProviderContext = import('./paletteProvider').PaletteProviderContext
    type PaletteProviderResults = import('./paletteProvider').PaletteProviderResults
    type PaletteResultProvider = import('./paletteProvider').PaletteResultProvider

    const row = (id: string): PaletteCommand => ({
      id,
      label: id,
      group: 'skills',
      run: () => {},
    })

    const context = (): PaletteProviderContext => ({
      workspaceRoot: '/repo',
      workspaceId: 'ws-1',
      scope: 'all',
      // A NEW function every call, deliberately: the runner reads the context
      // through a ref precisely so this identity cannot restart a search.
      close: () => {},
    })

    /** A mounted palette whose query and provider set the test can move. */
    function harness(providers: readonly PaletteResultProvider[]) {
      const container = dom.window.document.createElement('div')
      dom.window.document.body.appendChild(container)
      const root = createRoot(container)
      let latest: PaletteProviderResults = { commands: [], loading: false, error: null }
      let renders = 0
      let setQuery: (next: string) => void = () => {}

      function Probe({ set }: { set: (fn: (next: string) => void) => void }): null {
        const [query, update] = React.useState('')
        set(update)
        renders += 1
        latest = usePaletteProviders(providers, query, context())
        return null
      }

      return {
        async mount(): Promise<void> {
          await act(async () => {
            root.render(
              React.createElement(Probe, {
                set: (fn) => {
                  setQuery = fn
                },
              }),
            )
          })
        },
        async type(next: string): Promise<void> {
          await act(async () => {
            setQuery(next)
          })
        },
        /** Let timers and microtasks settle the way a real pause would. */
        async settle(ms = 0): Promise<void> {
          await act(async () => {
            await new Promise((resolve) => dom.window.setTimeout(resolve, ms))
          })
        },
        async unmount(): Promise<void> {
          await act(async () => {
            root.unmount()
          })
        },
        get results(): PaletteProviderResults {
          return latest
        },
        get renders(): number {
          return renders
        },
      }
    }

    // ── Warming ────────────────────────────────────────────────────────────────

    run('a provider warms once per palette, however much is typed into it', async () => {
      let warms = 0
      const provider: PaletteResultProvider = {
        id: 'ext',
        group: 'extensions',
        respondsToEmptyQuery: true,
        warm: async () => {
          warms += 1
        },
        load: () => [row('a')],
      }
      const palette = harness([provider])
      await palette.mount()
      await palette.type('re')
      await palette.type('rev')
      await palette.type('')
      await palette.settle()
      assert.equal(warms, 1, "reading every source's cached scan must not repeat per keystroke")
      await palette.unmount()
    })

    run('rows that land after the first keystroke are asked for again, not held back', async () => {
      let ready = false
      let release: () => void = () => {}
      const provider: PaletteResultProvider = {
        id: 'ext',
        group: 'extensions',
        respondsToEmptyQuery: true,
        warm: () =>
          new Promise<void>((resolve) => {
            release = () => {
              ready = true
              resolve()
            }
          }),
        // Exactly the shape the extensions provider has: nothing until the warm
        // has landed, rather than a stale guess.
        load: () => (ready ? [row('review')] : []),
      }
      const palette = harness([provider])
      await palette.mount()
      await palette.type('rev')
      assert.deepEqual(palette.results.commands, [] as PaletteCommand[], 'still warming')
      await act(async () => {
        release()
      })
      await palette.settle()
      assert.deepEqual(
        palette.results.commands.map((command) => command.id),
        ['review'],
        'the palette had the answer and would not show it — the warmTick is what fixes that',
      )
      await palette.unmount()
    })

    run('a warm that asks to be re-run mid-flight shows its fast leg before its slow one', async () => {
      // The extensions provider's two legs: cached scans, then a registry fetch
      // that may be waiting on a network that is not there.
      let rows: PaletteCommand[] = []
      let finishRegistry: () => void = () => {}
      const provider: PaletteResultProvider = {
        id: 'ext',
        group: 'extensions',
        respondsToEmptyQuery: true,
        warm: async (_ctx, refresh) => {
          rows = [row('from-a-source')]
          refresh()
          await new Promise<void>((resolve) => {
            finishRegistry = resolve
          })
          rows = [row('from-a-source'), row('from-the-registry')]
        },
        load: () => rows,
      }
      const palette = harness([provider])
      await palette.mount()
      await palette.settle()
      assert.deepEqual(
        palette.results.commands.map((command) => command.id),
        ['from-a-source'],
        'the sources are on screen while the registry is still out',
      )
      await act(async () => {
        finishRegistry()
      })
      await palette.settle()
      assert.deepEqual(
        palette.results.commands.map((command) => command.id),
        ['from-a-source', 'from-the-registry'],
      )
      await palette.unmount()
    })

    run('a provider that throws on warm lists nothing rather than taking the palette down', async () => {
      const provider: PaletteResultProvider = {
        id: 'ext',
        group: 'extensions',
        respondsToEmptyQuery: true,
        warm: () => {
          throw new Error('the store would not read')
        },
        load: () => [row('still-here')],
      }
      const palette = harness([provider])
      await palette.mount()
      await palette.settle()
      assert.deepEqual(
        palette.results.commands.map((command) => command.id),
        ['still-here'],
      )
      assert.equal(palette.results.error, null)
      await palette.unmount()
    })

    // ── Superseding ────────────────────────────────────────────────────────────

    run('a superseded run is cancelled, and its late answer cannot overwrite a fresh one', async () => {
      const cancelled: string[] = []
      const pending: { query: string; resolve: (rows: PaletteCommand[]) => void }[] = []
      const provider: PaletteResultProvider = {
        id: 'disk',
        group: 'files',
        minQueryLength: 1,
        cancel: () => cancelled.push('cancel'),
        load: (query) =>
          new Promise<PaletteCommand[]>((resolve) => {
            pending.push({ query, resolve })
          }),
      }
      const palette = harness([provider])
      await palette.mount()
      await palette.type('sl')
      await palette.type('slow')
      assert.ok(cancelled.length >= 1, 'the run the query moved past must be stopped, not left to finish')
      // The stale run answers last, which is exactly the race the sequence guard
      // exists for.
      await act(async () => {
        pending[1].resolve([row('fresh')])
        pending[0].resolve([row('stale')])
      })
      await palette.settle()
      assert.deepEqual(
        palette.results.commands.map((command) => command.id),
        ['fresh'],
        "a dead run's rows must never reach the list",
      )
      await palette.unmount()
    })

    run('a provider is not asked at all below its floor, or for a query it has nothing to say about', async () => {
      const asked: string[] = []
      const provider: PaletteResultProvider = {
        id: 'content',
        group: 'content',
        minQueryLength: 2,
        load: (query) => {
          asked.push(query)
          return []
        },
      }
      const palette = harness([provider])
      await palette.mount()
      await palette.settle()
      assert.deepEqual(asked, [], 'an empty query is not a search, and this provider says so')
      await palette.type('a')
      assert.deepEqual(asked, [], 'one character is below the floor')
      await palette.type('ab')
      assert.deepEqual(asked, ['ab'])
      await palette.unmount()
    })

    run('a synchronous filter never flashes "Searching…"', async () => {
      const instant: PaletteResultProvider = {
        id: 'installed',
        group: 'skills',
        respondsToEmptyQuery: true,
        load: () => [row('review')],
      }
      const palette = harness([instant])
      await palette.mount()
      assert.equal(palette.results.loading, false)
      await palette.type('rev')
      assert.equal(palette.results.loading, false, 'only a provider still in flight says it is working')
      await palette.unmount()
    })

    run('a debounced provider waits for the pause, and keeps its last rows while it does', async () => {
      let calls = 0
      const provider: PaletteResultProvider = {
        id: 'disk',
        group: 'files',
        minQueryLength: 1,
        debounceMs: 40,
        load: (query) => {
          calls += 1
          return [row(`hit-${query}`)]
        },
      }
      const palette = harness([provider])
      await palette.mount()
      await palette.type('a')
      await palette.settle(60)
      assert.equal(calls, 1)
      assert.deepEqual(
        palette.results.commands.map((command) => command.id),
        ['hit-a'],
      )
      // A burst of typing collapses into one run, and the previous rows stay up
      // rather than the list blanking between every two keystrokes.
      await palette.type('ab')
      await palette.type('abc')
      assert.deepEqual(
        palette.results.commands.map((command) => command.id),
        ['hit-a'],
        'the list must not blank while the pause is waited out',
      )
      await palette.settle(60)
      assert.equal(calls, 2, 'the burst was one run, not three')
      assert.deepEqual(
        palette.results.commands.map((command) => command.id),
        ['hit-abc'],
      )
      await palette.unmount()
    })

    run('a failure is shown instead of "No results"; a sibling provider still lists', async () => {
      const failing: PaletteResultProvider = {
        id: 'disk',
        group: 'files',
        minQueryLength: 1,
        load: async () => {
          throw new Error('ripgrep is not installed')
        },
      }
      const fine: PaletteResultProvider = {
        id: 'installed',
        group: 'skills',
        respondsToEmptyQuery: true,
        load: () => [row('review')],
      }
      const palette = harness([failing, fine])
      await palette.mount()
      await palette.type('rev')
      await palette.settle()
      assert.equal(palette.results.error, 'ripgrep is not installed')
      assert.deepEqual(
        palette.results.commands.map((command) => command.id),
        ['review'],
      )
      await palette.unmount()
    })

    // ── Closing ────────────────────────────────────────────────────────────────

    run('closing the palette stops the work and takes no answer afterwards', async () => {
      let cancels = 0
      let resolveLate: (rows: PaletteCommand[]) => void = () => {}
      const provider: PaletteResultProvider = {
        id: 'disk',
        group: 'files',
        minQueryLength: 1,
        cancel: () => {
          cancels += 1
        },
        load: () =>
          new Promise<PaletteCommand[]>((resolve) => {
            resolveLate = resolve
          }),
      }
      const palette = harness([provider])
      await palette.mount()
      await palette.type('q')
      await palette.unmount()
      assert.equal(cancels, 1, 'a subprocess must not outlive the overlay that started it')
      // React logs a warning (and older builds threw) if this reaches setState.
      const errors: unknown[] = []
      const original = console.error
      console.error = (...args: unknown[]) => errors.push(args)
      try {
        await act(async () => {
          resolveLate([row('too-late')])
        })
        await new Promise((resolve) => dom.window.setTimeout(resolve, 10))
      } finally {
        console.error = original
      }
      assert.deepEqual(errors, [], 'an answer arriving after the close must be dropped silently')
    })

    run('a warm that settles after the close does not write into an unmounted palette', async () => {
      let release: () => void = () => {}
      const provider: PaletteResultProvider = {
        id: 'ext',
        group: 'extensions',
        respondsToEmptyQuery: true,
        warm: () =>
          new Promise<void>((resolve) => {
            release = resolve
          }),
        load: () => [],
      }
      const palette = harness([provider])
      await palette.mount()
      await palette.unmount()
      const errors: unknown[] = []
      const original = console.error
      console.error = (...args: unknown[]) => errors.push(args)
      try {
        await act(async () => {
          release()
        })
        await new Promise((resolve) => dom.window.setTimeout(resolve, 10))
      } finally {
        console.error = original
      }
      assert.deepEqual(errors, [], 'the mounted guard is what makes the late warmTick safe')
    })

    // ── The context ────────────────────────────────────────────────────────────

    run('a re-created context does not restart a search', async () => {
      let calls = 0
      const provider: PaletteResultProvider = {
        id: 'disk',
        group: 'files',
        minQueryLength: 1,
        load: () => {
          calls += 1
          return []
        },
      }
      const palette = harness([provider])
      await palette.mount()
      await palette.type('q')
      assert.equal(calls, 1)
      // The same query typed again is the same query: `close` is a new function
      // on every render, and the runner reads the context through a ref so that
      // identity cannot count as a change.
      await palette.type('q')
      await palette.settle()
      assert.equal(calls, 1, "a callback's identity is not a reason to run ripgrep again")
      await palette.unmount()
    })

    run('the query is trimmed once, for every provider', async () => {
      const asked: string[] = []
      const provider: PaletteResultProvider = {
        id: 'installed',
        group: 'skills',
        respondsToEmptyQuery: true,
        load: (query) => {
          asked.push(query)
          return []
        },
      }
      const palette = harness([provider])
      await palette.mount()
      await palette.type('  review  ')
      await palette.settle()
      assert.ok(asked.includes('review'), 'providers never see the raw input')
      assert.ok(!asked.includes('  review  '))
      await palette.unmount()
    })

    for (const test of queue) await test()

    if (failures > 0) {
      console.error(`paletteProvider: ${failures} assertion group(s) failed`)
      process.exitCode = 1
    } else {
      console.log('paletteProvider: all assertions passed')
    }
  }

  const suiteRun = main()

  await suiteRun
})
