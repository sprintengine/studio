const LIMIT = 1000
const visits = new Map<string, number>()

function normalized(path: string): string {
  return path.replaceAll('\\', '/').replace(/\/$/u, '')
}

/** A bounded session history shared by file opening and mention ranking. */
export function rememberFileVisit(path: string, openedAt = Date.now()): void {
  const key = normalized(path)
  visits.delete(key)
  visits.set(key, openedAt)
  if (visits.size > LIMIT) visits.delete(visits.keys().next().value!)
}

export function recentFileVisit(path: string): number | undefined {
  return visits.get(normalized(path))
}

export function workspaceFileVisits(root: string): Record<string, number> {
  const prefix = normalized(root) + '/'
  return Object.fromEntries(
    [...visits].filter(([path]) => path.startsWith(prefix)).map(([path, stamp]) => [path.slice(prefix.length), stamp]),
  )
}
