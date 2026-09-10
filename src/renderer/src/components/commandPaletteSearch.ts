import { getRendererHost } from '../modules'
import type { Workspace } from '../types/workspace'

// Pure search logic for the global-search palette (CommandPalette.tsx), split
// out so the query matching and workspace-keyword derivation can be unit-tested
// without rendering the palette. Keeping these here is also what preserves the
// mode-label/searchTerms matching the retired sidebar "Search workspaces" box
// used to own (see workspaceSearchKeywords below).

/** The fields a palette command exposes to the query filter. `keywords` is
 *  searched but never displayed — it carries a workspace's type label and
 *  curated search terms so those match without crowding the visible row. */
export interface CommandSearchFields {
  label: string
  /**
   * The row's own name, when the visible label wraps it in one of the palette's
   * own verbs — "Switch to: <workspace>", "Spawn: <specialist>", "Toggle <panel>".
   *
   * Scored at the LABEL bands alongside `label`, best tier wins. Without it
   * those rows can never reach exact or prefix: the verb sits in front of the
   * name, so the obvious query — the workspace's own name — is a word start
   * (600) and loses to any file whose name merely begins with the same letters
   * (800). Group order used to hide that, because group order came first;
   * ranking by score exposed it (skills-everywhere review, 2026-09-10).
   *
   * Both are scored rather than one replacing the other, so "switch" still
   * finds the switch rows.
   */
  searchLabel?: string
  description?: string
  keywords?: string
}

/** True when the (case-insensitive, trimmed) query appears in the command's
 *  label, description, or hidden keyword text. An empty query matches every
 *  command, which is how the palette shows its no-query preview.
 *
 *  It is now the scorer's own predicate rather than a second implementation of
 *  it: "does it match" and "how well" must never be able to disagree. */
export function commandMatchesQuery(command: CommandSearchFields, query: string): boolean {
  return scoreCommandMatch(command, query) > 0
}

/** The source groups the palette organizes results into. The two disk-backed
 *  ones — `files` (name matches) and `content` (text matches) — are what make
 *  the palette a project search rather than only a launcher; `extensions` is
 *  every plugin in every configured source, which is what makes it a search
 *  for things you have not installed yet. */
export type PaletteCommandGroup =
  | 'agents'
  | 'skills'
  | 'extensions'
  | 'commands'
  | 'actions'
  | 'files'
  | 'content'

/**
 * The vertical order of the groups, and therefore the tie-break when two rows
 * score the same. It lives here rather than beside the palette's group LABELS
 * because the scorer needs it and the scorer is the pure part.
 */
export const PALETTE_GROUP_ORDER: readonly PaletteCommandGroup[] = [
  'agents',
  'skills',
  'extensions',
  'commands',
  'actions',
  'files',
  'content',
]

/** A group's rank in the canonical order; an unknown group sorts last. */
export function paletteGroupRank(group: PaletteCommandGroup): number {
  const index = PALETTE_GROUP_ORDER.indexOf(group)
  return index === -1 ? PALETTE_GROUP_ORDER.length : index
}

/** Which groups the palette is filtered to. `all` is the global launcher (⌘K
 *  and Shift Shift); `files` is Find-in-Path (⌘⇧F) — the same overlay with the
 *  non-file groups hidden, so a snippet of code is not ranked against command
 *  rows; `extensions` is the terminal star — skills and plugins only, because
 *  that trigger asks one question and it is not "which workspace". */
export type PaletteScope = 'all' | 'files' | 'extensions'

const SCOPE_GROUPS: Record<Exclude<PaletteScope, 'all'>, ReadonlySet<PaletteCommandGroup>> = {
  files: new Set<PaletteCommandGroup>(['files', 'content']),
  extensions: new Set<PaletteCommandGroup>(['skills', 'extensions']),
}

/** True when a group is visible under the given scope. The scope is a filter
 *  over one list, not a second component: `all` admits everything, so widening
 *  back from `files` is a state change rather than a reopen. */
export function groupInScope(group: PaletteCommandGroup, scope: PaletteScope): boolean {
  return scope === 'all' || SCOPE_GROUPS[scope].has(group)
}

// ── Ranking ──────────────────────────────────────────────────────────────────
//
// The palette used to order by group alone, so typing an exact skill name put
// it wherever its group happened to fall and left a workspace whose folder path
// merely CONTAINED the letters above it. The scorer is the fix, and it is here
// rather than in the component for the same reason the matcher is: it is the
// part worth asserting on.
//
// Two tiers, because where a word matched says more than that it matched: the
// visible name outranks every hidden field, and inside each field an exact
// answer outranks a prefix, a prefix a word start, and a word start a match
// buried mid-word ("git" in "digit").

/** The score bands, exported so a test names them rather than magic numbers. */
export const PALETTE_SCORE = {
  /** Every row, when there is no query to rank by. */
  empty: 1,
  labelExact: 1000,
  labelPrefix: 800,
  labelWord: 600,
  labelSubstring: 400,
  detailExact: 300,
  detailPrefix: 250,
  detailWord: 200,
  detailSubstring: 100,
  none: 0,
} as const

type MatchTier = 'exact' | 'prefix' | 'word' | 'substring'

/** Where (and how cleanly) the query sits inside one field; null when absent. */
function matchTier(text: string | undefined, normalizedQuery: string): MatchTier | null {
  if (!text) return null
  const haystack = text.toLowerCase()
  if (haystack === normalizedQuery) return 'exact'
  const at = haystack.indexOf(normalizedQuery)
  if (at === -1) return null
  if (at === 0) return 'prefix'
  // A word start is a match preceded by anything that is not a letter or digit
  // — a space, a dash, a slash, a dot. "cleanup" in "API cleanup" is one;
  // "git" in "digit" is not.
  return /[^a-z0-9]/u.test(haystack.charAt(at - 1)) ? 'word' : 'substring'
}

/** The cleaner of two tiers on the same field band; null when neither matched. */
function bestTier(a: MatchTier | null, b: MatchTier | null): MatchTier | null {
  if (!a) return b
  if (!b) return a
  return TIER_RANK[a] <= TIER_RANK[b] ? a : b
}

const TIER_RANK: Record<MatchTier, number> = { exact: 0, prefix: 1, word: 2, substring: 3 }

const LABEL_SCORE: Record<MatchTier, number> = {
  exact: PALETTE_SCORE.labelExact,
  prefix: PALETTE_SCORE.labelPrefix,
  word: PALETTE_SCORE.labelWord,
  substring: PALETTE_SCORE.labelSubstring,
}

const DETAIL_SCORE: Record<MatchTier, number> = {
  exact: PALETTE_SCORE.detailExact,
  prefix: PALETTE_SCORE.detailPrefix,
  word: PALETTE_SCORE.detailWord,
  substring: PALETTE_SCORE.detailSubstring,
}

/**
 * How well a command answers the query. 0 is "not a match at all", and is the
 * only value `commandMatchesQuery` reads; an empty query scores every row the
 * same, which is what keeps the no-query preview in group order.
 */
export function scoreCommandMatch(command: CommandSearchFields, query: string): number {
  const normalized = query.trim().toLowerCase()
  if (!normalized) return PALETTE_SCORE.empty
  const label = bestTier(matchTier(command.label, normalized), matchTier(command.searchLabel, normalized))
  if (label) return LABEL_SCORE[label]
  const description = matchTier(command.description, normalized)
  const keywords = matchTier(command.keywords, normalized)
  return Math.max(
    description ? DETAIL_SCORE[description] : PALETTE_SCORE.none,
    keywords ? DETAIL_SCORE[keywords] : PALETTE_SCORE.none,
  )
}

/**
 * A row the palette can rank: the searched fields, its group, and — for the
 * rows that know — whether the thing is already in the workspace.
 *
 * `installed` is deliberately tri-state, and the comparison only runs when BOTH
 * rows declare it. "What you have beats what you would have to install" is a
 * statement about two skills; a command, a file and a plugin have no such
 * notion, and letting them count as installed would push every available skill
 * below every row in the palette rather than below the installed skills.
 */
export type PaletteRankable = CommandSearchFields & {
  group: PaletteCommandGroup
  installed?: boolean
}

/** Score first, then what you already have, then the canonical group order. */
export function comparePaletteMatches(
  a: PaletteRankable,
  b: PaletteRankable,
  query: string,
): number {
  const scoreDelta = scoreCommandMatch(b, query) - scoreCommandMatch(a, query)
  if (scoreDelta !== 0) return scoreDelta
  if (a.installed !== undefined && b.installed !== undefined) {
    const installedDelta = Number(b.installed) - Number(a.installed)
    if (installedDelta !== 0) return installedDelta
  }
  return paletteGroupRank(a.group) - paletteGroupRank(b.group)
}

/**
 * The ranked list, in the order the palette renders and the arrow keys
 * traverse. Stable, so rows that tie keep the order their providers produced
 * them in — which is how a source's own ordering survives.
 *
 * Each row is scored once, not once per comparison: with every source's skills
 * and plugins in the list this sorts a few thousand rows per keystroke, and
 * scoring inside the comparator lower-cased three fields of two rows some
 * n·log(n) times over. Same order as `comparePaletteMatches`, by construction —
 * that function stays the statement of the rule and the thing the tests read.
 */
export function orderPaletteCommands<T extends PaletteRankable>(
  commands: readonly T[],
  query: string,
): T[] {
  return commands
    .map((command, index) => ({ command, index, score: scoreCommandMatch(command, query) }))
    .sort((a, b) => {
      if (a.score !== b.score) return b.score - a.score
      if (a.command.installed !== undefined && b.command.installed !== undefined) {
        const installedDelta = Number(b.command.installed) - Number(a.command.installed)
        if (installedDelta !== 0) return installedDelta
      }
      const groupDelta = paletteGroupRank(a.command.group) - paletteGroupRank(b.command.group)
      if (groupDelta !== 0) return groupDelta
      return a.index - b.index
    })
    .map((entry) => entry.command)
}

/** A workspace type's label + curated search terms joined into one match
 *  string. Pure over the definition so it is directly testable; an
 *  unregistered/shell mode falls back to the raw mode id. */
export function workspaceKeywordsFromDefinition(
  definition: { label: string; searchTerms?: readonly string[] } | null | undefined,
  fallbackId: string,
): string {
  if (!definition) return fallbackId
  return [definition.label, ...(definition.searchTerms ?? [])].join(' ')
}

/** The keyword match string for a workspace's mode, resolved against the live
 *  workspace-type registry — mirrors the matching the deleted workspaceSearch
 *  util provided so typing a mode name ("sprint engine", "roster", "cron")
 *  still surfaces its workspaces in the palette. */
export function workspaceSearchKeywords(mode: Workspace['mode']): string {
  return workspaceKeywordsFromDefinition(getRendererHost().getWorkspaceType(mode), mode)
}
