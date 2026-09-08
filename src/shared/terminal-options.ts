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
 * about where a tab lands or where a newline starts a row, the replayed screen
 * reflows differently from the one the user was looking at when it froze — the
 * failure is silent and looks like corruption, not like a config difference.
 *
 * Both values below are xterm's own defaults, pinned deliberately rather than
 * inherited: the point of the block is that the two processes state the same
 * thing out loud, so a future change to either one cannot be made in only one
 * place. Every option in the terminal-emulation-parity epic that affects cell
 * width or wrap position lands here — the unicode version above all, which is
 * the first one that will actually differ from a default.
 *
 * `allowProposedApi` is deliberately NOT here. Today the headless renderer sets
 * it and the live panes do not, and it gates API surface rather than layout, so
 * unifying it changes behaviour on one side or the other for no present gain.
 * It becomes this block's business when [[terminal-unicode11-widths]] needs it,
 * since that item is where a proposed API starts deciding cell widths.
 */
export const TERMINAL_CELL_GEOMETRY_OPTIONS = {
  /** Columns a `\t` advances by. Changes wrap positions for any output with tabs. */
  tabStopWidth: 8,
  /** When true a bare `\n` also returns the carriage, moving where every row starts. */
  convertEol: false,
} as const

export type TerminalCellGeometryOptions = typeof TERMINAL_CELL_GEOMETRY_OPTIONS
