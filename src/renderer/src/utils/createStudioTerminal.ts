import { Terminal } from '@xterm/xterm'
import type { IDisposable, ILinkHandler } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { SearchAddon } from '@xterm/addon-search'
import { WebLinksAddon } from '@xterm/addon-web-links'
import { Unicode11Addon } from '@xterm/addon-unicode11'
import { WebglAddon } from '@xterm/addon-webgl'
import '@xterm/xterm/css/xterm.css'

import { TERMINAL_RECENT_SCROLLBACK_LINES } from '../../../shared/terminal-history'
import {
  TERMINAL_CELL_GEOMETRY_OPTIONS,
  TERMINAL_UNICODE_VERSION,
} from '../../../shared/terminal-options'
import { MONO_FONT_STACK } from './fonts'
import { logPerfEvent } from './perfDiagnostics'
import { attachTerminalOsc52Clipboard } from './terminalOsc52Clipboard'
import { createTerminalSearchHandle, type TerminalSearchHandle } from './terminalSearch'
import { bindTerminalTheme, getTerminalTheme } from './terminalTheme'
import {
  attachWebglRenderer,
  type WebglRendererHandle,
  type WebglRendererState,
} from './terminalWebglRenderer'

/**
 * One place constructs a terminal.
 *
 * Every item in the terminal-emulation-parity epic is an option, an addon or an
 * OSC handler, so each one either lands in all the panes at once or silently
 * diverges between them. Before this, four sites each held their own copy of
 * the same option literal.
 *
 * What this owns: the option block, the Unicode width table, the theme (and
 * its live re-tint binding), the font, the scrollback, the fit addon, the
 * web-links addon, the write-only OSC 52 clipboard, the search addon, the WebGL
 * renderer and its context-loss fallback, the `linkHandler` slot that OSC 8
 * hyperlinks will fill, and OSC handler registration.
 *
 * What it deliberately does NOT own: `term.open()`, keyboard handlers, and the
 * file-link provider. Those are per-pane and, in the link provider's case,
 * ORDER-SENSITIVE — see `loadWebLinks` below.
 */

/**
 * Which pane this is, and therefore what it is allowed to resolve.
 *
 * The fleet case carries no roots and this is load-bearing, not an omission: a
 * fleet pane is attached to a terminal on ANOTHER machine, so a path printed in
 * it names a file in that machine's filesystem. Resolving it here would open
 * whatever local file happens to sit at the same path — the same words, a
 * different file, with no way for the user to tell. Making the roots absent
 * from the type is how that stays true when someone later adds link handling
 * without reading this comment.
 */
export type TerminalSurface =
  | { kind: 'agent'; workspaceRoot: string | null; executionRoot: string | null }
  | { kind: 'shell'; workspaceRoot: string | null }
  | { kind: 'fleet' }

/** The roots a relative path printed in a pane may be resolved against. */
export type TerminalLinkRoots = {
  workspaceRoot: string | null
  /** Where the process in this pane is actually running; wins over the workspace root. */
  executionRoot: string | null
}

/**
 * The roots for a surface, or `null` when the surface must never resolve a
 * local path at all. `null` is not "no roots known" — a pane with no roots
 * known is `{ workspaceRoot: null, executionRoot: null }`, which reports a
 * counted drop (see `terminalFileLinks.ts`). `null` means "do not ask".
 */
export function terminalSurfaceLinkRoots(surface: TerminalSurface): TerminalLinkRoots | null {
  switch (surface.kind) {
    case 'agent':
      return { workspaceRoot: surface.workspaceRoot, executionRoot: surface.executionRoot }
    case 'shell':
      return { workspaceRoot: surface.workspaceRoot, executionRoot: null }
    case 'fleet':
      return null
  }
}

/** Handles a click on a URL the web-links addon matched. */
export type TerminalWebLinkHandler = (event: MouseEvent, uri: string) => void

/**
 * An OSC handler, keyed by its identifier (7 = cwd, 133 = shell integration).
 * Returning true marks the sequence handled, exactly as
 * `IParser.registerOscHandler` expects. Registered and disposed by the factory
 * so no pane has to remember to tear one down.
 *
 * OSC 52 is NOT in here: the clipboard is the same on every surface, so the
 * factory owns it outright rather than trusting each pane to pass a write-only
 * one (a pane that forgot would answer clipboard READ requests).
 */
export type TerminalOscHandlers = Readonly<Record<number, (data: string) => boolean | Promise<boolean>>>

export type CreateStudioTerminalInput = {
  surface: TerminalSurface
  /**
   * Closed until the far end says this socket may type (FleetTerminalPanel).
   * Named explicitly rather than exposed as a general option bag: a pane that
   * needs to differ from the others should have to say which way, here.
   */
  disableStdin?: boolean
  /**
   * xterm's OSC 8 hyperlink handler. `OscLinkProvider` reads
   * `options.linkHandler` and does nothing while it is null, which is half of
   * why a `file://` hyperlink from an agent CLI is inert today. The slot is
   * wired through so [[terminal-osc8-hyperlinks]] only has to fill it.
   */
  linkHandler?: ILinkHandler
  oscHandlers?: TerminalOscHandlers
  /** When given, `loadWebLinks()` becomes live; otherwise it is a no-op. */
  onWebLink?: TerminalWebLinkHandler
}

export type StudioTerminal = {
  terminal: Terminal
  fitAddon: FitAddon
  /** `terminalSurfaceLinkRoots(surface)`, resolved once so panes agree with the factory. */
  linkRoots: TerminalLinkRoots | null
  /**
   * Loads the web-links addon, if an `onWebLink` handler was given.
   *
   * Split out rather than done at construction because xterm resolves link
   * providers in REGISTRATION ORDER and a lower-indexed provider's links
   * suppress a higher-indexed provider's on the same row (`Linkifier`'s
   * `hasLinkBefore`). A pane that also registers a file-link provider must
   * register that one first, so the moment this addon loads belongs to the
   * pane, not to the factory. Idempotent: a second call does nothing.
   */
  loadWebLinks: () => void
  /**
   * Loads the search addon and returns the pane's find handle.
   *
   * Lazy and idempotent: a pane that is never searched never pays for the
   * addon, its decoration bookkeeping or its line cache, and the panes that
   * matter most here are the ones a user leaves open all day. Repeated calls
   * hand back a handle onto the same addon — the highlights of an open find
   * must not be split across two of them.
   */
  loadSearch: () => TerminalSearchHandle
  /**
   * Loads the WebGL renderer, and arms the fallback that keeps a lost GPU
   * context from blanking the pane.
   *
   * **Call it immediately after `term.open()`.** Split out for the same reason
   * the addon itself checks `terminal.element`: loaded against an unopened
   * terminal the addon defers into xterm's internal `onWillOpen`, and a
   * context failure then throws out of `term.open()` rather than out of here.
   * See `terminalWebglRenderer.ts`. Idempotent: a second call does nothing.
   */
  loadWebglRenderer: () => void
  /** Which renderer is painting this pane. `'webgl'` only while WebGL holds. */
  webglRendererState: () => WebglRendererState
  /**
   * Tears down everything the factory created, terminal included. Call it last
   * in a pane's cleanup — anything reading `terminal` must run before it.
   */
  dispose: () => void
}

export function createStudioTerminal({
  surface,
  disableStdin,
  linkHandler,
  oscHandlers,
  onWebLink,
}: CreateStudioTerminalInput): StudioTerminal {
  const terminal = new Terminal({
    ...TERMINAL_CELL_GEOMETRY_OPTIONS,
    theme: getTerminalTheme(),
    fontFamily: MONO_FONT_STACK,
    // Kept in step with the size `waitForMonoFontReady` preloads: a terminal
    // that fits itself against a fallback face reflows once the real one lands.
    fontSize: 13,
    cursorBlink: true,
    scrollback: TERMINAL_RECENT_SCROLLBACK_LINES,
    ...(disableStdin === undefined ? {} : { disableStdin }),
    ...(linkHandler === undefined ? {} : { linkHandler }),
  })

  // Before anything is written: the width table decides where every row wraps,
  // and rows already in the buffer are not re-measured when it changes. Loaded
  // here rather than by each pane because the MAIN process's headless replay
  // terminal applies the same two lines (`terminal-replay-snapshot.ts`) — if
  // one side registers version 11 and the other stays on xterm's default 6, an
  // emoji is two columns on one side and one on the other, and a replayed
  // screen reflows away from the screen the user was looking at.
  terminal.loadAddon(new Unicode11Addon())
  terminal.unicode.activeVersion = TERMINAL_UNICODE_VERSION

  const unbindTerminalTheme = bindTerminalTheme(terminal)

  const fitAddon = new FitAddon()
  terminal.loadAddon(fitAddon)

  const oscDisposables: IDisposable[] = []
  for (const [identifier, handler] of Object.entries(oscHandlers ?? {})) {
    oscDisposables.push(terminal.parser.registerOscHandler(Number(identifier), handler))
  }

  // OSC 52 — a program asking the terminal to touch the system clipboard.
  //
  // Every surface gets it, agent and fleet included: copying is what the
  // sequence is FOR, and a pane attached to another machine is the canonical
  // case (it is how `ssh` + tmux put a remote buffer on your local clipboard).
  // The fleet rule the epic sets is about resolving local PATHS, which this
  // does not do.
  //
  // Registered LAST so its read guard sits in front of every other OSC 52
  // handler — xterm runs them in reverse registration order. Write only; see
  // `terminalOsc52Clipboard.ts` for why read is refused and how, twice.
  oscDisposables.push(attachTerminalOsc52Clipboard({ terminal }))

  let webglRenderer: WebglRendererHandle | null = null
  const loadWebglRenderer = (): void => {
    if (webglRenderer) return
    webglRenderer = attachWebglRenderer({
      terminal,
      createAddon: () => new WebglAddon(),
      // Which renderer a pane ended up on decides how to read every terminal
      // timing number, so it is recorded rather than silently absorbed — a
      // machine that always falls back is a machine whose profiles mean
      // something different.
      onStateChange: (state, error) => {
        logPerfEvent('terminal', 'terminal-renderer', {
          surface: surface.kind,
          state,
          ...(error === undefined ? {} : { error: String(error) }),
        })
      },
    })
  }

  let searchAddon: SearchAddon | null = null
  let searchHandle: TerminalSearchHandle | null = null
  const loadSearch = (): TerminalSearchHandle => {
    if (!searchHandle) {
      searchAddon = new SearchAddon()
      terminal.loadAddon(searchAddon)
      searchHandle = createTerminalSearchHandle(searchAddon)
    }
    return searchHandle
  }

  let webLinksAddon: WebLinksAddon | null = null
  const loadWebLinks = (): void => {
    if (!onWebLink || webLinksAddon) return
    webLinksAddon = new WebLinksAddon(onWebLink)
    terminal.loadAddon(webLinksAddon)
  }

  return {
    terminal,
    fitAddon,
    linkRoots: terminalSurfaceLinkRoots(surface),
    loadWebLinks,
    loadSearch,
    loadWebglRenderer,
    webglRendererState: () => webglRenderer?.state() ?? 'not-loaded',
    dispose: () => {
      // Before the terminal: the addon's disposal reaches back into the
      // terminal's render service to put the DOM renderer back.
      webglRenderer?.dispose()
      webLinksAddon?.dispose()
      searchAddon?.dispose()
      for (const disposable of oscDisposables) disposable.dispose()
      unbindTerminalTheme()
      terminal.dispose()
    },
  }
}
