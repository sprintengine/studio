// JQL the Jira provider issues. Two shapes only (plan §3.1): assigned-to-me is a
// fixed structural query keyed off `currentUser()` and unresolved state; free
// text is a `text ~` fuzzy match. A caller's search string is treated as free
// text and quoted — never spliced raw into JQL — so a stray quote or backslash
// can't change the query's meaning.

// Unresolved issues assigned to the authenticated user, most-recent first. Uses
// `resolution = EMPTY` (structural) rather than a named "open" status so a custom
// workflow doesn't hide the user's work.
export function assignedToMeJql(): string {
  return 'assignee = currentUser() AND resolution = EMPTY ORDER BY updated DESC'
}

// A user's free-text search. An empty query lists the most recently updated
// issues the connection can see rather than erroring or matching nothing.
export function freeTextSearchJql(query: string): string {
  const trimmed = query.trim()
  if (!trimmed) return 'ORDER BY updated DESC'
  return `text ~ "${escapeJqlString(trimmed)}" ORDER BY updated DESC`
}

// Escapes a value for use inside a double-quoted JQL string literal: backslash
// first (so we don't double-escape our own escapes), then the quote.
function escapeJqlString(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
}
