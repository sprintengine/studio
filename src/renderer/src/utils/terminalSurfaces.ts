/**
 * Which pane a terminal is, and therefore which roots a path printed in it is
 * resolved against.
 *
 * A leaf module on purpose. `createStudioTerminal.ts` owns the xterm instance
 * and imports `@xterm/xterm` (and its stylesheet) as VALUES, which a plain Node
 * test cannot load, so the type and the one function that reads it live here,
 * and `createStudioTerminal` re-exports them for the panes that already import
 * them from there.
 */

/**
 * Every pane is a terminal on THIS machine. A terminal on another machine used
 * to be a third surface with no roots at all, so that a path printed there was
 * never opened as a local file of the same name; terminals stopped crossing the
 * tailnet on 2026-09-29, and a surface for one should come back with that rule.
 */
export type TerminalSurface =
  | { kind: 'agent'; workspaceRoot: string | null; executionRoot: string | null }
  | { kind: 'shell'; workspaceRoot: string | null }

/** The roots a relative path printed in a pane may be resolved against. */
export type TerminalLinkRoots = {
  workspaceRoot: string | null
  /** Where the process in this pane is actually running; wins over the workspace root. */
  executionRoot: string | null
}

/**
 * The roots for a surface. A pane with no roots known is
 * `{ workspaceRoot: null, executionRoot: null }`, which reports a counted drop
 * (see `terminalFileLinks.ts`).
 */
export function terminalSurfaceLinkRoots(surface: TerminalSurface): TerminalLinkRoots {
  switch (surface.kind) {
    case 'agent':
      return { workspaceRoot: surface.workspaceRoot, executionRoot: surface.executionRoot }
    case 'shell':
      return { workspaceRoot: surface.workspaceRoot, executionRoot: null }
  }
}
