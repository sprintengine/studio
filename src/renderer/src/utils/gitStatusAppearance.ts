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

export function getGitStatusAppearance(status: GitFileStatus | null): GitStatusAppearance {
  switch (status) {
    case 'new':
      return { badge: 'A', textClass: 'text-[#43d17a] group-hover:text-[#6ee79a]' }
    case 'modified':
      return { badge: 'M', textClass: 'text-[#f2a84b] group-hover:text-[#ffc46f]' }
    case 'renamed':
      return { badge: 'R', textClass: 'text-[#f2a84b] group-hover:text-[#ffc46f]' }
    case 'deleted':
      return { badge: 'D', textClass: 'text-[#ff5a5f] line-through decoration-[#ff5a5f]/80 group-hover:text-[#ff787c]' }
    case 'conflicted':
      return { badge: '!', textClass: 'text-[#ff5a5f] group-hover:text-[#ff787c]' }
    default:
      return { badge: null, textClass: '' }
  }
}

export function getGitScopeStatusAppearance(scope: GitScopeStatusInput): GitScopeStatusAppearance {
  if (!scope) return { dotClass: 'bg-[#6f7480]', label: 'Unknown' }
  if (scope.missing) return { dotClass: 'bg-[#ff5a5f]', label: 'Missing' }
  if (scope.prunable) return { dotClass: 'bg-[#ff5a5f]', label: 'Prunable' }
  if (scope.locked) return { dotClass: 'bg-[#f2a84b]', label: 'Locked' }
  return { dotClass: 'bg-[#30d158]', label: 'Ready' }
}
