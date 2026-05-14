function pathSeparator(rootPath: string): '/' | '\\' {
  return rootPath.includes('\\') && !rootPath.includes('/') ? '\\' : '/'
}

export function joinWorkspacePath(rootPath: string, ...parts: string[]): string {
  const separator = pathSeparator(rootPath)
  const normalizedRoot = rootPath.replace(/[\\/]+$/, '')
  const normalizedParts = parts
    .flatMap((part) => part.split(/[\\/]+/))
    .filter(Boolean)
  return [normalizedRoot, ...normalizedParts].join(separator)
}

export function basename(rootPath: string): string {
  const parts = rootPath.split(/[\\/]+/).filter(Boolean)
  return parts[parts.length - 1] ?? ''
}
