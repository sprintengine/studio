import type { IDisposable, ITerminalAddon } from '@xterm/xterm'

/**
 * Attaching xterm's WebGL renderer, and surviving its loss.
 *
 * The addon is not a "load it and forget it" addon. Three things can go wrong
 * and all three end with a BLANK pane if nobody handles them:
 *
 * 1. **No WebGL2 context.** `WebglAddon.activate` constructs `WebglRenderer`
 *    eagerly and that constructor throws when the context cannot be created —
 *    a headless/software GL stack, a blocklisted driver, too many live
 *    contexts (we can have three panes plus a browser pane in one window).
 *    The throw comes out of `loadAddon`, so it is caught here.
 * 2. **Loaded before `open()`.** `activate` reads `terminal.element`; when it
 *    is not there yet the addon quietly defers itself to xterm's internal
 *    `onWillOpen`, which means a later context failure throws out of
 *    `term.open()` instead — past every catch a pane has. So this refuses to
 *    load against an unopened terminal rather than arming that trap.
 * 3. **Context loss at runtime.** A GPU reset, driver update or a tab the OS
 *    evicted takes the context away while the pane is live. xterm does not
 *    recover on its own: the documented handling is to dispose the addon,
 *    whose own disposal hook calls `renderService.setRenderer(core
 *    ._createRenderer())` — i.e. puts the DOM renderer back and resizes it.
 *    Disposal IS the fallback. Not disposing is what leaves a blank pane.
 *
 * Everything is injected so the fallback path is testable without a GPU:
 * `terminalWebglRenderer.test.ts` drives a fake addon that throws on
 * construction, throws on load, and fires context loss.
 */

/** The slice of `WebglAddon` this module drives. */
export type WebglRendererAddon = ITerminalAddon & {
  onContextLoss: (listener: (event: unknown) => void) => IDisposable
}

/** The slice of `Terminal` this module needs. */
export type WebglRendererTarget = {
  /** Set by `term.open()`. Absent means the addon would defer — see above. */
  element?: HTMLElement | undefined
  loadAddon: (addon: ITerminalAddon) => void
}

/**
 * Where a pane's painting actually ended up.
 *
 * Every value other than `webgl` means the DOM renderer is painting, which is
 * correct-but-slower — never blank.
 */
export type WebglRendererState =
  | 'webgl'
  /** `attachWebglRenderer` was never called for this terminal. */
  | 'not-loaded'
  /** `loadWebglRenderer()` was called before `term.open()`; a pane-ordering bug. */
  | 'not-opened'
  /** No WebGL2 context, or the addon refused to activate. */
  | 'unavailable'
  /** Had a context, lost it, fell back. */
  | 'context-lost'
  /** The pane tore the terminal down. */
  | 'disposed'

export type WebglRendererHandle = {
  /** True only while WebGL is the renderer in use. */
  isActive: () => boolean
  state: () => WebglRendererState
  /** Idempotent, and safe after a context loss has already disposed the addon. */
  dispose: () => void
}

export type AttachWebglRendererInput = {
  terminal: WebglRendererTarget
  /** Deferred so a construction throw is caught here rather than at the call site. */
  createAddon: () => WebglRendererAddon
  /** Told every time the pane changes which renderer is painting it. */
  onStateChange?: (state: WebglRendererState, error?: unknown) => void
}

export function attachWebglRenderer({
  terminal,
  createAddon,
  onStateChange,
}: AttachWebglRendererInput): WebglRendererHandle {
  let state: WebglRendererState = 'unavailable'
  let addon: WebglRendererAddon | null = null
  let contextLossDisposable: IDisposable | null = null

  const setState = (next: WebglRendererState, error?: unknown): void => {
    state = next
    onStateChange?.(next, error)
  }

  // Disposing the addon is what restores the DOM renderer, so it must happen
  // exactly once and must not be skipped just because we are already unwinding.
  const releaseAddon = (): void => {
    try {
      contextLossDisposable?.dispose()
    } catch {
      // A listener already torn down by the addon's own disposal. Not fatal.
    }
    contextLossDisposable = null
    try {
      addon?.dispose()
    } catch {
      // The addon can throw while disposing a renderer whose context is gone.
      // xterm has still swapped the DOM renderer back in by then; swallowing
      // keeps a GPU reset from taking the pane's whole cleanup path with it.
    }
    addon = null
  }

  if (!terminal.element) {
    setState('not-opened')
    return {
      isActive: () => false,
      state: () => state,
      dispose: () => {
        if (state !== 'disposed') setState('disposed')
      },
    }
  }

  try {
    const created = createAddon()
    addon = created
    terminal.loadAddon(created)
    // Registered only after a successful load: an addon that threw during
    // activate has no renderer to lose a context from.
    contextLossDisposable = created.onContextLoss(() => {
      // `addon`, not `state`, is the "still on WebGL" test: it is nulled by the
      // first release, so a driver that fires loss twice — or fires it during
      // registration, before the `webgl` state below is set — falls back once.
      if (!addon) return
      releaseAddon()
      setState('context-lost')
    })
    if (addon) setState('webgl')
  } catch (error) {
    releaseAddon()
    setState('unavailable', error)
  }

  return {
    isActive: () => state === 'webgl',
    state: () => state,
    dispose: () => {
      if (state === 'disposed') return
      releaseAddon()
      setState('disposed')
    },
  }
}
