// The one normalization rule every provider MUST route through (plan §3.1):
// an issue's open/closed category is derived from the tracker's STRUCTURAL
// category, NEVER from a display name. A team that renames "Done" to "Shipped"
// must not break the mapping, and a custom in-progress status named "Done-ish"
// must not read as closed. Providers (T3/T4/T5) call these helpers instead of
// each inventing their own name matching.

import type { NormalizedIssue } from './types'

export type IssueStateCategory = NormalizedIssue['state']['category']

// Jira: the issue's status carries a `statusCategory.key` that is one of
// `new` | `indeterminate` | `done` (the only closed one). Everything that is not
// structurally `done` is open, including custom statuses.
export function mapJiraStatusCategory(statusCategoryKey: string): IssueStateCategory {
  return statusCategoryKey.trim().toLowerCase() === 'done' ? 'closed' : 'open'
}

// Linear: workflow states have a structural `type`. `completed` and `canceled`
// are terminal (closed); `backlog` | `unstarted` | `started` are open.
export function mapLinearStateType(stateType: string): IssueStateCategory {
  const normalized = stateType.trim().toLowerCase()
  return normalized === 'completed' || normalized === 'canceled' ? 'closed' : 'open'
}

// GitHub: issues expose a structural `state` of `open` | `closed`.
export function mapGitHubIssueState(state: string): IssueStateCategory {
  return state.trim().toLowerCase() === 'closed' ? 'closed' : 'open'
}

// Structural inputs, one per provider — the exact field a provider reads before
// calling the matching mapper above. Kept as a discriminated union so a new
// provider can't be added without deciding which structural field it maps.
export type ProviderStateInput =
  | { provider: 'jira'; statusCategoryKey: string; nativeName: string }
  | { provider: 'linear'; stateType: string; nativeName: string }
  | { provider: 'github'; state: string; nativeName: string }

// Single entry point providers use to build a NormalizedIssue's `state`. The
// `nativeName` is preserved verbatim for display; only the category is derived.
export function normalizeIssueState(input: ProviderStateInput): NormalizedIssue['state'] {
  switch (input.provider) {
    case 'jira':
      return { category: mapJiraStatusCategory(input.statusCategoryKey), nativeName: input.nativeName }
    case 'linear':
      return { category: mapLinearStateType(input.stateType), nativeName: input.nativeName }
    case 'github':
      return { category: mapGitHubIssueState(input.state), nativeName: input.nativeName }
  }
}
