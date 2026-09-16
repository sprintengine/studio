// What the Extensions home's tiles SAY (Extensions drawer ruling, 2026-09-05,
// Stage 3) — the one-line summary under each name, and the rule each live count
// line follows.
//
// A leaf: no React, no store, no IPC. The page reads the numbers (from the
// stores and readers that already hold them) and these turn them into the line
// a person reads, so the wording is testable without mounting anything.
//
// Two rules run through every line below, and they are why this is not a
// template string at the call site:
//
//   A count that is not known yet is ABSENT, never zero. `null` means "no line"
//   — a tile whose read is still in flight, or failed, or is switched off shows
//   its name and summary and nothing else. Rendering `0 installed` while a scan
//   is running states a fact the app does not have (principles, "Design the
//   states, not the happy path": a failed dependency must never render
//   identically to an empty list).
//
//   A real zero is WORDS. "None in the library" and "None installed" read as
//   answers; "0 installed" reads as a counter that has not started. The app
//   already says it this way ("No findings" in the review aside), and a fresh
//   profile sees these lines before it sees any other.

/**
 * The tile ids, which are the drawer rows' own ids — a view's id where the row
 * is one of a surface's views, the surface's id otherwise. Keyed that way so a
 * row's copy cannot drift onto the wrong row: the same string routes the click.
 */


/**
 * The one-line summary under each tile's name. Not in the registry: a module
 * declares what its surface is CALLED, and this is what it is FOR, which is
 * the home page's own copy about the product's own parts.
 *
 * A row with no entry here still renders — name, glyph, chevron — so a row a
 * module adds to the drawer appears on the home rather than silently vanishing.
 */
export const EXTENSIONS_HOME_TILE_SUMMARIES: Readonly<Record<string, string>> = {
  design: 'Design systems, rendered from disk',
  plugins: 'MCP servers your agents can call',
  skills: 'Reusable instructions agents pick up',
  'agent-clis': 'Claude Code, Codex, OpenCode',
}

/**
 * Design: how many design systems the library holds. Deliberately the library
 * and not the bundle attached to the open project — the home is instance-wide
 * and does not know which project you are looking at, and the Design surface
 * keeps those two as separate groups for the same reason.
 */
export function designLibraryCountLine(input: { ready: boolean; count: number }): string | null {
  if (!input.ready) return null
  if (input.count === 0) return 'None in the library'
  return `${input.count} in the library`
}

/**
 * Plugins: the MCP servers configured and switched on for this machine. The
 * same number the Plugins surface's Installed row states ("N active MCP
 * servers"), read from the same settings, so the two can never disagree.
 */
export function mcpServerCountLine(count: number): string {
  if (count === 0) return 'None on this machine'
  return `${count} on this machine`
}

/**
 * Skills: how many skills the app's sources hold in total.
 *
 * Not "installed": installing a skill puts it in a PROJECT, and this page is
 * instance-wide, so there is no one number of installed skills to state. This
 * is the total the Skills surface itself reports, and it stays absent until
 * every source has been scanned — a partial sum presented as the total would
 * be a lie, which is the rule that surface already follows.
 */
export function skillsCountLine(input: {
  ready: boolean
  sourceCount: number
  skillCount: number
}): string | null {
  if (!input.ready) return null
  if (input.sourceCount === 0) return 'No sources'
  if (input.skillCount === 0) return 'No skills'
  return `${input.skillCount} ${input.skillCount === 1 ? 'skill' : 'skills'}`
}

/**
 * Agent CLIs: how many are on this machine, and how many of those have a newer
 * release waiting.
 *
 * The update half is dropped rather than shown as zero when nothing is behind:
 * "· 0 updates" is a reassurance nobody asked for on a line that exists to
 * carry news. It is dropped for a different reason when version checking is
 * off — the app has not looked, so it must not report "none".
 */
export function agentCliCountLine(input: {
  ready: boolean
  installed: number
  updates: number
}): string | null {
  if (!input.ready) return null
  if (input.installed === 0) return 'None installed'
  const installed = `${input.installed} installed`
  if (input.updates === 0) return installed
  return `${installed} · ${input.updates} update${input.updates === 1 ? '' : 's'}`
}
