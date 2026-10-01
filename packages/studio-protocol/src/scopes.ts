// What a client may do. A grant is a set of these, read live on every request
// a client makes, so narrowing one or revoking the client applies to the next
// frame and not the next connection.
//
// The names are the tailnet lane's conversation scopes plus `create`, which
// that lane never had: a phone follows and drives chats a person started, and
// a local app may also start them. Each scope is its own grant except that
// `conversation:operate` implies `conversation:read`, as on the tailnet: a
// client that can drive a chat can see what it is driving.

/** Every scope this version of the protocol defines, narrowest first. */
export const STUDIO_SCOPES = ['conversation:read', 'conversation:operate', 'conversation:create'] as const

export type StudioScope = (typeof STUDIO_SCOPES)[number]

/** Whether a value names a scope this version of the protocol defines. */
export function isStudioScope(value: unknown): value is StudioScope {
  return (STUDIO_SCOPES as readonly unknown[]).includes(value)
}

/**
 * A grant as stored or received: unknown names dropped, each scope once, in
 * the order `STUDIO_SCOPES` lists them, so two grants holding the same scopes
 * compare equal.
 */
export function normalizeStudioScopes(value: unknown): StudioScope[] {
  if (!Array.isArray(value)) return []
  const held = new Set(value.filter(isStudioScope))
  return STUDIO_SCOPES.filter((scope) => held.has(scope))
}

/** Whether a grant covers `needed`. `conversation:operate` covers `conversation:read`. */
export function studioScopesGrant(scopes: readonly string[], needed: StudioScope): boolean {
  if (scopes.includes(needed)) return true
  return needed === 'conversation:read' && scopes.includes('conversation:operate')
}
