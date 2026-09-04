// Loose semver for CLI version strings, node-free. `codex --version` prints
// "codex-cli 0.153.2", `claude --version` prints "2.1.261 (Claude Code)", npm's
// `latest` is "0.153.3": take the first dotted number run, compare
// numerically, and treat a `-pre` suffix as below the same numbers without one.
// Build metadata (`+abc`) is ignored. Anything without a number run is
// unparsable and compares as unknown (`null`), never as older or newer.
export type ParsedSemver = {
  numbers: number[]
  prerelease: string | null
}

const VERSION_RUN = /v?(\d+(?:\.\d+)*)(?:-([0-9A-Za-z.-]+))?/

export function parseSemver(value: string | null | undefined): ParsedSemver | null {
  if (typeof value !== 'string') return null
  const match = VERSION_RUN.exec(value.trim())
  if (!match) return null
  return {
    numbers: match[1].split('.').map((part) => Number.parseInt(part, 10)),
    prerelease: match[2] ?? null,
  }
}

// Negative when `a` is older than `b`, positive when newer, 0 when equal, and
// null when either side has no version in it.
export function compareSemver(a: string | null | undefined, b: string | null | undefined): number | null {
  const left = parseSemver(a)
  const right = parseSemver(b)
  if (!left || !right) return null
  const width = Math.max(left.numbers.length, right.numbers.length)
  for (let index = 0; index < width; index += 1) {
    const l = left.numbers[index] ?? 0
    const r = right.numbers[index] ?? 0
    if (l !== r) return l < r ? -1 : 1
  }
  if (left.prerelease === right.prerelease) return 0
  if (left.prerelease === null) return 1
  if (right.prerelease === null) return -1
  return left.prerelease < right.prerelease ? -1 : 1
}
