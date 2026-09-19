import assert from 'node:assert/strict'
import type { IDisposable, ITerminalAddon } from '@xterm/xterm'
import { attachWebglRenderer, type WebglRendererAddon, type WebglRendererState } from './terminalWebglRenderer'
import { test } from 'vitest'

test('terminalWebglRenderer', async () => {
  // The point of these tests is the FALLBACK, not the fast path. A WebGL pane
  // that loses its context and keeps a dead addon loaded paints nothing at all —
  // the user sees a blank rectangle where their agent was. xterm's own recovery
  // is `addon.dispose()`, whose disposal hook puts the DOM renderer back, so
  // "did we dispose the addon, exactly once, on every failure route" IS the
  // question. A real GPU is not available here and is not needed to ask it.

  type FakeAddon = WebglRendererAddon & {
    disposeCount: number
    loseContext: () => void
    contextLossListeners: number
  }

  function createFakeAddon(options: { throwOnDispose?: boolean } = {}): FakeAddon {
    const listeners = new Set<(event: unknown) => void>()
    const addon: FakeAddon = {
      disposeCount: 0,
      get contextLossListeners() {
        return listeners.size
      },
      activate: () => {},
      dispose: () => {
        addon.disposeCount += 1
        if (options.throwOnDispose) throw new Error('renderer teardown failed')
      },
      onContextLoss: (listener): IDisposable => {
        listeners.add(listener)
        return { dispose: () => listeners.delete(listener) }
      },
      loseContext: () => {
        for (const listener of [...listeners]) listener({})
      },
    }
    return addon
  }

  function createFakeTerminal(options: { opened?: boolean; throwOnLoad?: boolean } = {}) {
    const loaded: ITerminalAddon[] = []
    return {
      loaded,
      element: options.opened === false ? undefined : ({} as HTMLElement),
      loadAddon: (addon: ITerminalAddon) => {
        // The real `WebglAddon.activate` constructs its renderer here, and that
        // constructor throws when no WebGL2 context can be made.
        if (options.throwOnLoad) throw new Error('WebGL2 context unavailable')
        loaded.push(addon)
        addon.activate({} as never)
      },
    }
  }

  function run(name: string, body: () => void): void {
    try {
      body()
      console.log(`ok - ${name}`)
    } catch (error) {
      console.error(`not ok - ${name}`)
      throw error
    }
  }

  run('attaches the WebGL renderer to an opened terminal', () => {
    const terminal = createFakeTerminal()
    const addon = createFakeAddon()
    const states: WebglRendererState[] = []

    const handle = attachWebglRenderer({
      terminal,
      createAddon: () => addon,
      onStateChange: (state) => states.push(state),
    })

    assert.equal(terminal.loaded.length, 1)
    assert.equal(handle.state(), 'webgl')
    assert.equal(handle.isActive(), true)
    assert.deepEqual(states, ['webgl'])
    assert.equal(addon.contextLossListeners, 1, 'context loss must be armed at attach time')
  })

  run('a lost context disposes the addon, which is how the DOM renderer comes back', () => {
    const terminal = createFakeTerminal()
    const addon = createFakeAddon()
    const states: WebglRendererState[] = []

    const handle = attachWebglRenderer({
      terminal,
      createAddon: () => addon,
      onStateChange: (state) => states.push(state),
    })
    addon.loseContext()

    // Disposing the addon is not cleanup here, it is the repaint: xterm's
    // WebglAddon disposal calls `renderService.setRenderer(core._createRenderer())`
    // and resizes it. Leaving the addon loaded is what blanks the pane.
    assert.equal(addon.disposeCount, 1, 'the addon must be disposed on context loss')
    assert.equal(handle.state(), 'context-lost')
    assert.equal(handle.isActive(), false)
    assert.deepEqual(states, ['webgl', 'context-lost'])
    assert.equal(addon.contextLossListeners, 0, 'the loss listener must not outlive the addon')
  })

  run('a second context loss does not dispose the addon twice', () => {
    const terminal = createFakeTerminal()
    const addon = createFakeAddon()

    attachWebglRenderer({ terminal, createAddon: () => addon })
    addon.loseContext()
    addon.loseContext()

    assert.equal(addon.disposeCount, 1)
  })

  run('pane teardown after a context loss does not dispose the addon again', () => {
    const terminal = createFakeTerminal()
    const addon = createFakeAddon()

    const handle = attachWebglRenderer({ terminal, createAddon: () => addon })
    addon.loseContext()
    handle.dispose()
    handle.dispose()

    assert.equal(addon.disposeCount, 1)
    assert.equal(handle.state(), 'disposed')
  })

  run('teardown without a context loss disposes the addon once', () => {
    const terminal = createFakeTerminal()
    const addon = createFakeAddon()

    const handle = attachWebglRenderer({ terminal, createAddon: () => addon })
    handle.dispose()

    assert.equal(addon.disposeCount, 1)
    assert.equal(handle.state(), 'disposed')
    assert.equal(handle.isActive(), false)
  })

  run('an addon that throws while disposing does not take the pane down with it', () => {
    const terminal = createFakeTerminal()
    const addon = createFakeAddon({ throwOnDispose: true })

    const handle = attachWebglRenderer({ terminal, createAddon: () => addon })
    assert.doesNotThrow(() => addon.loseContext())
    assert.equal(handle.state(), 'context-lost')
  })

  run('no WebGL2 context leaves the terminal on the DOM renderer without throwing', () => {
    const terminal = createFakeTerminal({ throwOnLoad: true })
    const addon = createFakeAddon()
    const states: WebglRendererState[] = []

    const handle = attachWebglRenderer({
      terminal,
      createAddon: () => addon,
      onStateChange: (state) => states.push(state),
    })

    assert.equal(handle.state(), 'unavailable')
    assert.equal(handle.isActive(), false)
    assert.deepEqual(states, ['unavailable'])
    // Created but never activated — still released, so nothing holds a half-built
    // renderer alive.
    assert.equal(addon.disposeCount, 1)
    assert.equal(terminal.loaded.length, 0)
  })

  run('an addon constructor that throws is caught too', () => {
    const terminal = createFakeTerminal()
    // Held on a property, not a `let`: the assignment happens inside the callback
    // `doesNotThrow` runs, which the compiler cannot see, so a local would stay
    // narrowed to `null` and `handle?.state()` would read as `never`.
    const attached: { handle: ReturnType<typeof attachWebglRenderer> | null } = { handle: null }

    assert.doesNotThrow(() => {
      attached.handle = attachWebglRenderer({
        terminal,
        createAddon: () => {
          throw new Error('no WebGL2')
        },
      })
    })
    assert.equal(attached.handle?.state(), 'unavailable')
  })

  run('refuses to load against a terminal that has not been opened', () => {
    // The trap this avoids: `WebglAddon.activate` with no `terminal.element`
    // defers itself onto xterm's internal `onWillOpen`, so the context failure
    // would surface out of `term.open()` — outside every catch a pane has.
    const terminal = createFakeTerminal({ opened: false })
    const addon = createFakeAddon()

    const handle = attachWebglRenderer({ terminal, createAddon: () => addon })

    assert.equal(handle.state(), 'not-opened')
    assert.equal(handle.isActive(), false)
    assert.equal(terminal.loaded.length, 0)
    assert.equal(addon.disposeCount, 0, 'nothing was constructed, so nothing to dispose')
  })

  run('the state a pane reports after teardown is disposed, not stale', () => {
    const terminal = createFakeTerminal({ opened: false })
    const handle = attachWebglRenderer({ terminal, createAddon: createFakeAddon })
    handle.dispose()
    assert.equal(handle.state(), 'disposed')
  })
})
