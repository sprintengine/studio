/**
 * Which pane a terminal is, and therefore what it is allowed to resolve.
 *
 * A leaf module on purpose. `createStudioTerminal.ts` owns the xterm instance
 * and imports `@xterm/xterm` (and its stylesheet) as VALUES, which a plain Node
 * test cannot load; the surface rule has to be reachable from
 * `terminalOscLinks.ts` — the gate every printed URI goes through — and from
 * that gate's tests. So the type and the one function that reads it live here,
 * and `createStudioTerminal` re-exports them for the panes that already import
 * them from there.
 */

/**
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
