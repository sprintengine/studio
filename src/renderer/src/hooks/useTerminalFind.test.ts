import assert from 'node:assert/strict'

import { JSDOM } from 'jsdom'
import { test } from 'vitest'

test('useTerminalFind', async () => {
  // The find bar's result counter used to go stale, and only after the pane
  // rebuilt its terminal — which happens on plenty of ordinary changes (a
  // workspace folder resolving, a session reattaching), so it was invisible in
  // any test that mounted once. `handle.onResults(setResults)` was subscribed in
  // an effect keyed on `[open, search]`, and `search` is a `useCallback` over a
  // REF whose identity never changes: the effect did not re-run, and the
  // subscription stayed bound to the DISPOSED terminal's addon. `findNext` kept
  // working, because it resolves the handle through `search()`, which DOES notice
  // the new owner — so matches highlighted while `results.count` sat at whatever
  // the dead terminal last said, both step buttons stayed `disabled`, and the
  // status read "No results" over visible highlights.
  //
  // A real DOM and a real render, because the bug IS the hook's effect wiring:
  // nothing about it is visible from a pure function.

  const dom = new JSDOM('<!doctype html><html><body></body></html>', {
    url: 'http://localhost',
    pretendToBeVisual: true,
  })

  const anyGlobal = globalThis as unknown as Record<string, unknown>
  anyGlobal.window = dom.window
  anyGlobal.document = dom.window.document
  anyGlobal.navigator = dom.window.navigator
  anyGlobal.HTMLElement = dom.window.HTMLElement
  anyGlobal.Node = dom.window.Node
  anyGlobal.getComputedStyle = dom.window.getComputedStyle
  anyGlobal.requestAnimationFrame = (callback: FrameRequestCallback) => dom.window.setTimeout(() => callback(0), 0)
  anyGlobal.IS_REACT_ACT_ENVIRONMENT = true

  type SearchHandle = import('../utils/terminalSearch').TerminalSearchHandle
  type SearchResults = import('../utils/terminalSearch').TerminalSearchResults
  type StudioTerminal = import('../utils/createStudioTerminal').StudioTerminal
  type TerminalFind = import('./useTerminalFind').TerminalFind

  /**
   * One pane's terminal, with only the parts the find hook touches. `emit` is the
   * addon's own decoration pass reporting "3 of 12" after a find has run — the
   * thing the counter reads, and the thing the stale subscription never heard.
   */
  function fakeTerminal(): StudioTerminal & {
    emit: (results: SearchResults) => void
    listenerCount: () => number
    searched: string[]
    loadCount: () => number
  } {
    const listeners = new Set<(results: SearchResults) => void>()
    const searched: string[] = []
    let loads = 0
    const handle: SearchHandle = {
      findNext: (query) => {
        searched.push(query)
        return true
      },
      findPrevious: (query) => {
        searched.push(query)
        return true
      },
      clear: () => {},
      clearActive: () => {},
      onResults: (listener) => {
        listeners.add(listener)
        return { dispose: () => listeners.delete(listener) }
      },
    }
    return {
      terminal: { focus: () => {} },
      loadSearch: () => {
        loads += 1
        return handle
      },
      emit: (results: SearchResults) => {
        for (const listener of [...listeners]) listener(results)
      },
      listenerCount: () => listeners.size,
      searched,
      loadCount: () => loads,
    } as unknown as StudioTerminal & {
      emit: (results: SearchResults) => void
      listenerCount: () => number
      searched: string[]
      loadCount: () => number
    }
  }

  async function main(): Promise<void> {
    const React = await import('react')
    const { act } = React
    const { createRoot } = await import('react-dom/client')
    const { useTerminalFind } = await import('./useTerminalFind')
    const { resetMountedTerminalFinds, respondToTerminalFind } = await import('../utils/terminalFind')

    const first = fakeTerminal()
    const second = fakeTerminal()

    const terminalRef: { current: StudioTerminal | null } = { current: first }
    const containerRef: { current: HTMLElement | null } = { current: document.createElement('div') }
    // A holder rather than a `let`: the hook's value is assigned inside the
    // component, which the compiler cannot see, so a plain local stays narrowed
    // to `null` and every `bar.current?.` below reads as `never`. A property is
    // re-widened by the `act` calls between the reads, which is what the test
    // actually relies on.
    const bar: { current: TerminalFind | null } = { current: null }

    function Harness(): null {
      bar.current = useTerminalFind({
        workspaceId: 'w1',
        containerRef: containerRef as React.RefObject<HTMLElement | null>,
        terminalRef: terminalRef as React.RefObject<StudioTerminal | null>,
      })
      return null
    }

    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)
    await act(async () => {
      root.render(React.createElement(Harness))
    })

    // The bar is OPEN for the whole scenario. That is the reported case, and it
    // is the one the old wiring got half right: opening subscribed correctly, and
    // nothing re-subscribed afterwards.
    await act(async () => {
      respondToTerminalFind('w1')
    })
    assert.equal(bar.current?.open, true, 'the bar is open')
    assert.equal(first.listenerCount(), 1, 'opening subscribes to the mounted terminal')

    // A find in the terminal the pane mounted with.
    await act(async () => {
      bar.current?.setQuery('needle')
    })
    assert.deepEqual(first.searched, ['needle'], 'the find ran against the mounted terminal')
    await act(async () => {
      first.emit({ index: 0, count: 12 })
    })
    assert.deepEqual(bar.current?.results, { index: 0, count: 12 }, 'and its counts reached the bar')

    // The pane's mount effect re-runs and builds a NEW terminal, exactly as it
    // does when a workspace folder resolves or a session reattaches. The find bar
    // is still open and the query is still in it.
    terminalRef.current = second

    await act(async () => {
      bar.current?.findNext()
    })
    assert.deepEqual(second.searched, ['needle'], 'the find follows the live terminal')
    assert.equal(first.listenerCount(), 0, 'the disposed terminal keeps no listener of ours')
    assert.equal(second.listenerCount(), 1, 'and the live one has exactly one')

    await act(async () => {
      second.emit({ index: 1, count: 4 })
    })
    assert.deepEqual(
      bar.current?.results,
      { index: 1, count: 4 },
      'the counter reads the LIVE terminal — it used to stay frozen on the dead one',
    )

    // The dead terminal cannot speak for the bar any more.
    await act(async () => {
      first.emit({ index: 9, count: 99 })
    })
    assert.deepEqual(bar.current?.results, { index: 1, count: 4 }, 'a disposed addon no longer moves the counter')

    // One addon per terminal: the handle is still cached per instance, so a
    // second find does not load a second search addon.
    await act(async () => {
      bar.current?.findPrevious()
    })
    assert.equal(second.loadCount(), 1, 'the handle is still cached per terminal, not re-loaded per find')

    await act(async () => {
      root.unmount()
    })
    assert.equal(second.listenerCount(), 0, 'unmounting releases the last subscription')

    resetMountedTerminalFinds()
    console.log('ok - useTerminalFind')
  }

  const suiteRun = main().catch((error) => {
    console.error(error)
    process.exitCode = 1
  })

  await suiteRun
})
