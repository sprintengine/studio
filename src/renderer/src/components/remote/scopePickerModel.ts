import { TAILNET_SCOPES, type TailnetScope } from '../../../../shared/tailnet'

// The permission vocabulary a person actually chooses from, DOM-free
// (remote-settings-rebuild).
//
// One list, in `TAILNET_SCOPES` order, with a title in the reader's language, the
// identifier in the system's, and one line of consequence. It lives apart from
// the component because THREE surfaces ask the same question — the Pair a device
// modal, the inbound pair-request card, and the machine row's Grant — and a
// second spelling of "what does Standard mean" is how the terminal tier went
// missing from every pairing path in the first place.
//
// The rows are per-SCOPE and not per-family. The old four-row shape
// ("Workspaces — read & operate") bundled `operate` with `read`, so a person
// who wanted a machine to WATCH their work had to also let it act on it,
// and the one row that mattered — the terminal tier, which is what makes a
// cross-machine conversation visible at all — was called "Terminals — control"
// and read as being about shells rather than about chats.

export type ScopeRow = {
  scope: TailnetScope
  /** The name in the reader's language. */
  title: string
  /** The same fact in the system's vocabulary, shown beside the title. */
  code: TailnetScope
  /** ONE line: what holding it lets the other machine do. */
  description: string
}

/**
 * Every scope, in the vocabulary's own order, with its copy.
 *
 * Order is `TAILNET_SCOPES` and not a curated one: the same order the pairing
 * request, the audit line and the scope pills use, so a person comparing the
 * rows here with the pills on the code card is comparing two renderings of one
 * list rather than two lists.
 */
export const SCOPE_ROWS: readonly ScopeRow[] = [
  {
    scope: 'workspace:read',
    title: 'View workspaces',
    code: 'workspace:read',
    description: 'Chats, agents, branches and files.',
  },
  {
    scope: 'workspace:operate',
    title: 'Operate workspaces',
    code: 'workspace:operate',
    description: 'Launch agents and open workspaces.',
  },
  { scope: 'backlog:read', title: 'View backlog', code: 'backlog:read', description: 'Items, epics and triage.' },
  {
    scope: 'backlog:operate',
    title: 'Operate backlog',
    code: 'backlog:operate',
    description: 'Edit, assign and set status.',
  },
  {
    scope: 'terminal:observe',
    title: 'Watch chats & terminals',
    code: 'terminal:observe',
    description: 'Read live conversations and shell output.',
  },
  {
    scope: 'terminal:control',
    title: 'Drive chats & terminals',
    code: 'terminal:control',
    description: 'Type into conversations and shells. Arbitrary shell on this machine.',
  },
]

export type ScopePreset = 'read-only' | 'standard'

/**
 * Read only: every `:read` plus `terminal:observe`.
 *
 * `terminal:observe` is in the READING set because that is what it is — it
 * reads live conversations and shell output. Left out of it, "Read only" would
 * be a preset that hides the one thing a person opens a remote machine to look
 * at, which is the bug this rebuild exists to fix.
 */
export const READ_ONLY_SCOPES: readonly TailnetScope[] = TAILNET_SCOPES.filter(
  (scope) => scope.endsWith(':read') || scope === 'terminal:observe'
)

/**
 * Standard: all six, `terminal:control` INCLUDED.
 *
 * Owner ruling 2026-09-10, overriding the earlier "arbitrary shell is never
 * pre-ticked" rule. The rule was written for a surface that granted scopes
 * without showing them; this one shows all six rows with the words "Arbitrary
 * shell on this machine" against the last of them, and the person un-ticks what
 * they do not want. A default that silently excluded the terminal tier is what
 * left every paired machine unable to see the other's chats.
 */
export const STANDARD_SCOPES: readonly TailnetScope[] = TAILNET_SCOPES

const PRESET_SCOPES: Record<ScopePreset, readonly TailnetScope[]> = {
  'read-only': READ_ONLY_SCOPES,
  standard: STANDARD_SCOPES,
}

/** The set a preset stands for, as a fresh array the caller may own. */
export function scopesForPreset(preset: ScopePreset): TailnetScope[] {
  return [...PRESET_SCOPES[preset]]
}

/**
 * Which preset a set of scopes IS, or null when it is neither.
 *
 * Set equality, not order or identity: a chosen set arrives in whatever order
 * the rows were ticked, a stored one in vocabulary order, and a preset that
 * only re-lit for one of those spellings would look broken half the time.
 * Null is the honest answer for a hand-picked set — the segmented control then
 * shows neither segment as chosen, which is what "you have made your own
 * choice" looks like.
 */
export function presetFor(scopes: readonly TailnetScope[]): ScopePreset | null {
  const chosen = new Set(scopes)
  for (const preset of ['read-only', 'standard'] as const) {
    const want = PRESET_SCOPES[preset]
    if (want.length === chosen.size && want.every((scope) => chosen.has(scope))) return preset
  }
  return null
}

/**
 * Add or remove one scope, keeping the result in vocabulary order.
 *
 * Ordering here rather than at each caller is what makes `presetFor` and the
 * scope pills agree with the stored device: a set is a set, but the pills are
 * drawn in array order and a person who ticked the last row first should not see
 * their scopes listed backwards.
 */
export function toggleScope(
  scopes: readonly TailnetScope[],
  scope: TailnetScope,
  next: boolean
): TailnetScope[] {
  const chosen = new Set(scopes)
  if (next) chosen.add(scope)
  else chosen.delete(scope)
  return TAILNET_SCOPES.filter((candidate) => chosen.has(candidate))
}

/**
 * The scopes NOT in a set, in vocabulary order — what the machine row's popover
 * lists under "Not granted".
 */
export function missingScopes(scopes: readonly TailnetScope[]): TailnetScope[] {
  const held = new Set(scopes)
  return TAILNET_SCOPES.filter((scope) => !held.has(scope))
}

/**
 * The consequence line for a grant missing either terminal scope, or null.
 *
 * It is the sentence the whole rebuild is for: a machine paired without the
 * terminal tier shows no chats and no shell output over there, and until this
 * line existed that read as the feature being broken rather than as a scope
 * nobody granted.
 */
export function terminalGapNote(scopes: readonly TailnetScope[]): string | null {
  const held = new Set(scopes)
  if (held.has('terminal:observe') && held.has('terminal:control')) return null
  return "It can't see chats or terminals here."
}
