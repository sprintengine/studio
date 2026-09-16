/**
 * The xterm options that decide how a byte stream lands in CELLS.
 *
 * Read by the renderer's terminal factory (`createStudioTerminal.ts`) and by
 * the MAIN process's headless replay renderer (`terminal-replay-snapshot.ts`),
 * which is the whole reason this lives in `shared/` and imports nothing: main
 * pulls `@xterm/headless`, the renderer pulls `@xterm/xterm`, and neither may
 * drag the other's package across the process boundary.
 *
 * Why they must agree: a suspended terminal is repainted from a screen that the
 * headless terminal rendered off the retained PTY stream. If the two disagree
 * about where a tab lands, where a newline starts a row, or how many columns an
 * emoji occupies, the replayed screen reflows differently from the one the user
 * was looking at when it froze — the failure is silent and looks like
 * corruption, not like a config difference.
 *
 * `tabStopWidth` and `convertEol` are xterm's own defaults, pinned deliberately
 * rather than inherited: the point of the block is that the two processes state
 * the same thing out loud, so a future change to either one cannot be made in
 * only one place. `allowProposedApi` is not a default — see below.
 */
export const TERMINAL_CELL_GEOMETRY_OPTIONS = {
  /** Columns a `\t` advances by. Changes wrap positions for any output with tabs. */
  tabStopWidth: 8,
  /** When true a bare `\n` also returns the carriage, moving where every row starts. */
  convertEol: false,
  /**
   * Required, not preference: `Terminal.unicode` is marked EXPERIMENTAL in
   * xterm's typings and every access throws while this is false. Setting
   * `TERMINAL_UNICODE_VERSION` — and `Unicode11Addon.activate`, which calls
   * `terminal.unicode.register` — therefore both depend on it.
   *
   * This is the resolution of the note this block used to carry, which said
   * `allowProposedApi` was deliberately absent (headless set it, the live panes
   * did not) and would "become this block's business when
   * [[terminal-unicode11-widths]] needs it, since that item is where a proposed
   * API starts deciding cell widths". That is now literally the case: the
   * proposed API IS the width table. Leaving it split would mean the headless
   * side could switch unicode version and the live side could not — the exact
   * divergence this file exists to prevent.
   */
  allowProposedApi: true,
} as const

/**
 * The Unicode version whose character-width table decides how wide a cell is.
 *
 * A SIBLING of the option block rather than a key in it, because xterm does not
 * accept it as a construction option: the version lives on
 * `terminal.unicode.activeVersion`, is set after `new Terminal(...)`, and is
 * only settable once `Unicode11Addon` has registered a provider for it. Putting
 * it inside `TERMINAL_CELL_GEOMETRY_OPTIONS` would spread an unknown key into
 * every `new Terminal()` call and, worse, read as though construction applied
 * it — when in fact a terminal that never loads the addon silently keeps
 * version 6 and its narrower table.
 *
 * So the contract is two lines, both required, on both sides of the process
 * boundary:
 *
 *     terminal.loadAddon(new Unicode11Addon())
 *     terminal.unicode.activeVersion = TERMINAL_UNICODE_VERSION
 *
 * Why it matters more than the other two options here: under xterm's default
 * version 6 table an emoji is ONE column wide; under 11 it is two. Claude
 * Code's TUI is emoji and box-drawing throughout, so the version is what
 * decides where nearly every agent frame wraps. `readWrappedLogicalLine` in
 * `terminalFileLinks.ts` walks those wrap boundaries to rebuild a logical line,
 * and the pty is sized from the same column count — a width disagreement is a
 * wrong link range and a mis-sized terminal, not only a cosmetic one.
 */
export const TERMINAL_UNICODE_VERSION = '11'

/**
 * The same two facts, said out loud to a REMOTE renderer.
 *
 * The two processes above share this module, so they cannot disagree. A phone
 * attached over the tailnet cannot: it ships its own xterm, on its own release
 * cadence, and it paints the same PTY bytes into its own buffer. Before this
 * existed the only thing keeping it in step was that somebody remembered to
 * mirror a constant — and when the live panes moved to Unicode 11 nobody did,
 * so every emoji-bearing agent frame wrapped one way here and another way on
 * the phone, which then reported the resulting column count back to size the
 * pty.
 *
 * So the stream states it. `tailnet-terminal-stream.ts` puts this on the
 * `attached` frame and the client adopts it; every value is settable on a live
 * `Terminal`, which is what lets a client follow rather than refuse. A client
 * too old to read it ignores an unknown key, which is the same outcome as
 * before and no worse.
 *
 * This is deliberately NOT the whole of `TERMINAL_CELL_GEOMETRY_OPTIONS`:
 * `allowProposedApi` is a local construction concern (it decides whether
 * `terminal.unicode` may be touched at all), not something a remote renderer
 * adopts — it either has the proposed API or it cannot honour the version
 * either way.
 */
export type TerminalRenderContract = {
  unicodeVersion: string
  tabStopWidth: number
  convertEol: boolean
  /** Diagnostics only. A client must never gate behaviour on it. */
  xtermVersion?: string
}

export function terminalRenderContract(xtermVersion?: string): TerminalRenderContract {
  return {
    unicodeVersion: TERMINAL_UNICODE_VERSION,
    tabStopWidth: TERMINAL_CELL_GEOMETRY_OPTIONS.tabStopWidth,
    convertEol: TERMINAL_CELL_GEOMETRY_OPTIONS.convertEol,
    ...(xtermVersion ? { xtermVersion } : {}),
  }
}
