export type GitStatusAppearance = {
  badge: string | null
  textClass: string
}

type GitScopeStatusInput = {
  missing?: boolean
  prunable?: boolean
  locked?: boolean
} | null

export type GitScopeStatusAppearance = {
  dotClass: string
  label: string
}

// Status colour reads from the theme tone tokens via the portable `chip-text-*`
// recipe (30% ink mixed into the tone) so the filename stays legible on every
// surface — the light themes (Light, Vellum) tune the tones dark-on-light, the
// dark catalogue keeps them luminous-on-dark. The earlier fixed hexes were
// dark-tuned and washed out on the light themes.
export function getGitStatusAppearance(status: GitFileStatus | null): GitStatusAppearance {
  switch (status) {
    case 'new':
      return { badge: 'A', textClass: 'chip-text-good' }
    case 'modified':
      return { badge: 'M', textClass: 'chip-text-warn' }
    case 'renamed':
      return { badge: 'R', textClass: 'chip-text-warn' }
    case 'deleted':
      return { badge: 'D', textClass: 'chip-text-error line-through decoration-[color:var(--tone-error)]' }
    case 'conflicted':
      return { badge: '!', textClass: 'chip-text-error' }
    default:
      return { badge: null, textClass: '' }
  }
}

export function getGitScopeStatusAppearance(scope: GitScopeStatusInput): GitScopeStatusAppearance {
  if (!scope) return { dotClass: 'bg-[color:var(--text-muted)]', label: 'Unknown' }
  if (scope.missing) return { dotClass: 'bg-[color:var(--tone-error)]', label: 'Missing' }
  if (scope.prunable) return { dotClass: 'bg-[color:var(--tone-error)]', label: 'Prunable' }
  if (scope.locked) return { dotClass: 'bg-[color:var(--tone-warn)]', label: 'Locked' }
  return { dotClass: 'bg-[color:var(--tone-good)]', label: 'Ready' }
}
