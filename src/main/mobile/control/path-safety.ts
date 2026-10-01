// Local-path safety for anything that leaves this desktop: a snapshot or a
// command result bound for a paired phone, and telemetry. An absolute path names
// the owner's machine layout (their username, their volumes) and is of no use on
// another device, so these helpers find and redact one wherever it sits in a
// payload. Leaf module (no imports from snapshot or command) to stay cycle-free.

const localPathPatterns = [
  /\/(?:Users|home|private|var\/folders|Volumes|Applications|Library|opt|srv|mnt|tmp)\/[^\s"'=:()]*/gu,
  /[A-Za-z]:\\[^\s"'=:()]*/gu,
  /\\\\[^\\\s"'=:()]+\\[^\s"'=:()]*/gu,
]

function redactLocalPaths(value: string): string {
  return localPathPatterns.reduce((acc, pattern) => acc.replace(pattern, '[redacted-path]'), value)
}

export function containsLocalPath(value: string): boolean {
  return localPathPatterns.some((pattern) => {
    pattern.lastIndex = 0
    return pattern.test(value)
  })
}

export function deepRedactLocalPaths<T>(value: T): T {
  if (typeof value === 'string') {
    return redactLocalPaths(value) as unknown as T
  }
  if (Array.isArray(value)) {
    return value.map((item) => deepRedactLocalPaths(item)) as unknown as T
  }
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      out[key] = deepRedactLocalPaths(item)
    }
    return out as unknown as T
  }
  return value
}
