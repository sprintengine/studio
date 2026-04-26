export type GitStatusAppearance = {
  badge: string | null
  textClass: string
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
