import { Terminal } from '@xterm/xterm'
import type { IDisposable, ILinkHandler } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebLinksAddon } from '@xterm/addon-web-links'
import '@xterm/xterm/css/xterm.css'

import { TERMINAL_RECENT_SCROLLBACK_LINES } from '../../../shared/terminal-history'
import { TERMINAL_CELL_GEOMETRY_OPTIONS } from '../../../shared/terminal-options'
import { MONO_FONT_STACK } from './fonts'
import { bindTerminalTheme, getTerminalTheme } from './terminalTheme'

/**
 * One place constructs a terminal.
 *
 * Every item in the terminal-emulation-parity epic is an option, an addon or an
 * OSC handler, so each one either lands in all the panes at once or silently
 * diverges between them. Before this, four sites each held their own copy of
 * the same option literal.
 *
 * What this owns: the option block, the theme (and its live re-tint binding),
 * the font, the scrollback, the fit addon, the web-links addon, the
 * `linkHandler` slot that OSC 8 hyperlinks will fill, and OSC handler
 * registration.
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
 * An OSC handler, keyed by its identifier (7 = cwd, 52 = clipboard, 133 = shell
 * integration). Returning true marks the sequence handled, exactly as
 * `IParser.registerOscHandler` expects. Registered and disposed by the factory
 * so no pane has to remember to tear one down.
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

  const unbindTerminalTheme = bindTerminalTheme(terminal)

  const fitAddon = new FitAddon()
  terminal.loadAddon(fitAddon)

  const oscDisposables: IDisposable[] = []
  for (const [identifier, handler] of Object.entries(oscHandlers ?? {})) {
    oscDisposables.push(terminal.parser.registerOscHandler(Number(identifier), handler))
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
    dispose: () => {
      webLinksAddon?.dispose()
      for (const disposable of oscDisposables) disposable.dispose()
      unbindTerminalTheme()
      terminal.dispose()
    },
  }
}
