import type { ISearchOptions, SearchAddon } from '@xterm/addon-search'
import type { IDisposable } from '@xterm/xterm'

import { isLightTerminalBackground } from './terminalTheme'

/**
 * Find in a pane: `@xterm/addon-search` behind a handle small enough that a
 * pane never touches the addon's API directly.
 *
 * The search runs over the pane's own scrollback and nothing else. That is what
 * separates it from "Search in Files" (the search palette's Text tab, ⌘⇧F),
 * which sweeps the workspace FOLDER with ripgrep and yields lines to open. A
 * pane's buffer has no path and is not on disk, so the two cannot be one
 * surface — but they are one idiom: the same command registry, the same
 * Shortcuts tab, and adjacent keys (⌘F this pane, ⌘⇧F the whole workspace).
 */

/**
 * Colours for the match highlights.
 *
 * xterm's decoration API takes literal `#RRGGBB` — it does not read CSS
 * variables — so, exactly as `LIGHT_TERMINAL_ANSI` in `terminalTheme.ts` does
 * for the palette, the pair is chosen by what the pane is painted on. A single
 * pair cannot work for both: a highlight legible behind light-on-dark output is
 * a blob behind dark-on-light output.
 *
 * The active match is the stronger of the pair and carries a border as well, so
 * "which one am I on" survives a screen where several matches are on adjacent
 * rows.
 */
const DARK_SURFACE_DECORATIONS = {
  matchBackground: '#4a3f18',
  matchBorder: '#6f5f28',
  matchOverviewRuler: '#4a3f18',
  activeMatchBackground: '#8a6d10',
  activeMatchBorder: '#f0d68a',
  activeMatchColorOverviewRuler: '#8a6d10',
} as const

const LIGHT_SURFACE_DECORATIONS = {
  matchBackground: '#ffe9a8',
  matchBorder: '#d9b64e',
  matchOverviewRuler: '#ffe9a8',
  activeMatchBackground: '#ffc93c',
  activeMatchBorder: '#7a5a00',
  activeMatchColorOverviewRuler: '#ffc93c',
} as const

/** The decoration set for the pane's current background. */
export function terminalSearchDecorations(): ISearchOptions['decorations'] {
  return isLightTerminalBackground() ? { ...LIGHT_SURFACE_DECORATIONS } : { ...DARK_SURFACE_DECORATIONS }
}

/**
 * How a find is run.
 *
 * Case-insensitive and literal. A terminal buffer is full of `[`, `(`, `.` and
 * `*` — a regex-by-default find would turn the commonest search a person types
 * (a path, a flag, an error string) into either a syntax error or a wrong
 * match, silently. Whole-word is off for the same reason: `--foo` and
 * `foo.bar` are the shapes people look for.
 */
export function terminalSearchOptions(): ISearchOptions {
  return {
    regex: false,
    wholeWord: false,
    caseSensitive: false,
    decorations: terminalSearchDecorations(),
  }
}

/** Where the current find stands: which match, out of how many. */
export type TerminalSearchResults = {
  /** 0-based index of the active match, or -1 when there is no active match. */
  index: number
  count: number
}

export type TerminalSearchHandle = {
  /** Advances to the next match; false when the term matches nothing. */
  findNext: (query: string) => boolean
  findPrevious: (query: string) => boolean
  /** Drops every highlight and the selection — what closing the find bar does. */
  clear: () => void
  /**
   * Drops only the ACTIVE match's decoration, leaving the rest highlighted.
   * The addon's own guidance is to call this when the search field loses
   * focus, so the selection underneath becomes visible again.
   */
  clearActive: () => void
  onResults: (listener: (results: TerminalSearchResults) => void) => IDisposable
}

/**
 * Wraps the addon so a pane deals in "next/previous/clear" rather than in
 * search options it would each have to spell the same way.
 *
 * Options are rebuilt per call rather than captured: the decoration colours
 * depend on the theme, and a pane whose theme changed mid-session must not keep
 * highlighting in the old one.
 */
export function createTerminalSearchHandle(addon: SearchAddon): TerminalSearchHandle {
  return {
    findNext: (query) => (query ? addon.findNext(query, terminalSearchOptions()) : false),
    findPrevious: (query) => (query ? addon.findPrevious(query, terminalSearchOptions()) : false),
    clear: () => addon.clearDecorations(),
    clearActive: () => addon.clearActiveDecoration(),
    onResults: (listener) => addon.onDidChangeResults(({ resultIndex, resultCount }) => {
      listener({ index: resultIndex, count: resultCount })
    }),
  }
}
