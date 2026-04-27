export type GitLineChange = {
  kind: 'added' | 'modified' | 'deleted'
  startLine: number
  endLine: number
  deletedCount?: number
}

type DiffOp =
  | { kind: 'equal'; text: string }
  | { kind: 'insert'; text: string }
  | { kind: 'delete'; text: string }

const MAX_LCS_CELLS = 2_000_000

function splitLines(content: string): string[] {
  const lines = content.replace(/\r\n/g, '\n').split('\n')
  if (lines.at(-1) === '') lines.pop()
  return lines
}

function buildFallbackChange(baseLines: string[], currentLines: string[]): GitLineChange[] {
  if (!baseLines.length && currentLines.length) {
    return [{ kind: 'added', startLine: 1, endLine: currentLines.length }]
  }

  if (baseLines.length && !currentLines.length) {
    return [{ kind: 'deleted', startLine: 1, endLine: 1, deletedCount: baseLines.length }]
  }

  if (!baseLines.length && !currentLines.length) return []

  return [{ kind: 'modified', startLine: 1, endLine: Math.max(currentLines.length, 1) }]
}

function diffLineOpsLcs(baseLines: string[], currentLines: string[]): DiffOp[] {
  const rowCount = baseLines.length + 1
  const columnCount = currentLines.length + 1
  const table = Array.from({ length: rowCount }, () => new Uint32Array(columnCount))

  for (let baseIndex = baseLines.length - 1; baseIndex >= 0; baseIndex -= 1) {
    for (let currentIndex = currentLines.length - 1; currentIndex >= 0; currentIndex -= 1) {
      table[baseIndex][currentIndex] = baseLines[baseIndex] === currentLines[currentIndex]
        ? table[baseIndex + 1][currentIndex + 1] + 1
        : Math.max(table[baseIndex + 1][currentIndex], table[baseIndex][currentIndex + 1])
    }
  }

  const ops: DiffOp[] = []
  let baseIndex = 0
  let currentIndex = 0

  while (baseIndex < baseLines.length && currentIndex < currentLines.length) {
    if (baseLines[baseIndex] === currentLines[currentIndex]) {
      ops.push({ kind: 'equal', text: currentLines[currentIndex] })
      baseIndex += 1
      currentIndex += 1
    } else if (table[baseIndex + 1][currentIndex] >= table[baseIndex][currentIndex + 1]) {
      ops.push({ kind: 'delete', text: baseLines[baseIndex] })
      baseIndex += 1
    } else {
      ops.push({ kind: 'insert', text: currentLines[currentIndex] })
      currentIndex += 1
    }
  }

  while (baseIndex < baseLines.length) {
    ops.push({ kind: 'delete', text: baseLines[baseIndex] })
    baseIndex += 1
  }

  while (currentIndex < currentLines.length) {
    ops.push({ kind: 'insert', text: currentLines[currentIndex] })
    currentIndex += 1
  }

  return ops
}

function findUniqueCommonAnchor(
  baseLines: string[],
  currentLines: string[],
  baseStart: number,
  baseEnd: number,
  currentStart: number,
  currentEnd: number
): { baseIndex: number; currentIndex: number } | null {
  const basePositions = new Map<string, number>()

  for (let index = baseStart; index < baseEnd; index += 1) {
    const line = baseLines[index]
    const existing = basePositions.get(line)
    basePositions.set(line, existing === undefined ? index : -1)
  }

  const currentPositions = new Map<string, number>()

  for (let index = currentStart; index < currentEnd; index += 1) {
    const line = currentLines[index]
    const baseIndex = basePositions.get(line)
    if (baseIndex === undefined || baseIndex < 0) continue

    const existing = currentPositions.get(line)
    currentPositions.set(line, existing === undefined ? index : -1)
  }

  const baseMidpoint = (baseStart + baseEnd) / 2
  const currentMidpoint = (currentStart + currentEnd) / 2
  let bestAnchor: { baseIndex: number; currentIndex: number; score: number } | null = null

  for (const [line, baseIndex] of basePositions.entries()) {
    if (baseIndex < 0) continue

    const currentIndex = currentPositions.get(line)
    if (currentIndex === undefined || currentIndex < 0) continue

    const score = Math.abs(baseIndex - baseMidpoint) + Math.abs(currentIndex - currentMidpoint)
    if (!bestAnchor || score < bestAnchor.score) {
      bestAnchor = { baseIndex, currentIndex, score }
    }
  }

  return bestAnchor ? { baseIndex: bestAnchor.baseIndex, currentIndex: bestAnchor.currentIndex } : null
}

function diffLineOps(baseLines: string[], currentLines: string[]): DiffOp[] {
  const ops: DiffOp[] = []

  const appendRange = (
    baseStart: number,
    baseEnd: number,
    currentStart: number,
    currentEnd: number
  ) => {
    let nextBaseStart = baseStart
    let nextCurrentStart = currentStart
    let nextBaseEnd = baseEnd
    let nextCurrentEnd = currentEnd

    while (
      nextBaseStart < nextBaseEnd
      && nextCurrentStart < nextCurrentEnd
      && baseLines[nextBaseStart] === currentLines[nextCurrentStart]
    ) {
      ops.push({ kind: 'equal', text: currentLines[nextCurrentStart] })
      nextBaseStart += 1
      nextCurrentStart += 1
    }

    let commonSuffixLength = 0
    while (
      nextBaseStart < nextBaseEnd
      && nextCurrentStart < nextCurrentEnd
      && baseLines[nextBaseEnd - 1] === currentLines[nextCurrentEnd - 1]
    ) {
      nextBaseEnd -= 1
      nextCurrentEnd -= 1
      commonSuffixLength += 1
    }

    const baseLength = nextBaseEnd - nextBaseStart
    const currentLength = nextCurrentEnd - nextCurrentStart

    if (baseLength === 0) {
      for (let index = nextCurrentStart; index < nextCurrentEnd; index += 1) {
        ops.push({ kind: 'insert', text: currentLines[index] })
      }
    } else if (currentLength === 0) {
      for (let index = nextBaseStart; index < nextBaseEnd; index += 1) {
        ops.push({ kind: 'delete', text: baseLines[index] })
      }
    } else if (baseLength * currentLength <= MAX_LCS_CELLS) {
      ops.push(
        ...diffLineOpsLcs(
          baseLines.slice(nextBaseStart, nextBaseEnd),
          currentLines.slice(nextCurrentStart, nextCurrentEnd)
        )
      )
    } else {
      const anchor = findUniqueCommonAnchor(
        baseLines,
        currentLines,
        nextBaseStart,
        nextBaseEnd,
        nextCurrentStart,
        nextCurrentEnd
      )

      if (anchor) {
        appendRange(nextBaseStart, anchor.baseIndex, nextCurrentStart, anchor.currentIndex)
        ops.push({ kind: 'equal', text: currentLines[anchor.currentIndex] })
        appendRange(anchor.baseIndex + 1, nextBaseEnd, anchor.currentIndex + 1, nextCurrentEnd)
      } else {
        for (let index = nextBaseStart; index < nextBaseEnd; index += 1) {
          ops.push({ kind: 'delete', text: baseLines[index] })
        }
        for (let index = nextCurrentStart; index < nextCurrentEnd; index += 1) {
          ops.push({ kind: 'insert', text: currentLines[index] })
        }
      }
    }

    for (let offset = 0; offset < commonSuffixLength; offset += 1) {
      ops.push({ kind: 'equal', text: currentLines[nextCurrentEnd + offset] })
    }
  }

  appendRange(0, baseLines.length, 0, currentLines.length)
  return ops
}

export function getGitLineChanges(baseContent: string, currentContent: string): GitLineChange[] {
  if (baseContent === currentContent) return []

  const baseLines = splitLines(baseContent)
  const currentLines = splitLines(currentContent)
  if (!baseLines.length || !currentLines.length) return buildFallbackChange(baseLines, currentLines)

  const ops = diffLineOps(baseLines, currentLines)
  const changes: GitLineChange[] = []
  let currentLine = 1
  let index = 0

  while (index < ops.length) {
    const op = ops[index]
    if (op.kind === 'equal') {
      currentLine += 1
      index += 1
      continue
    }

    const startLine = currentLine
    let inserted = 0
    let deleted = 0

    while (index < ops.length && ops[index].kind !== 'equal') {
      if (ops[index].kind === 'insert') {
        inserted += 1
        currentLine += 1
      } else {
        deleted += 1
      }
      index += 1
    }

    if (inserted && deleted) {
      changes.push({
        kind: 'modified',
        startLine,
        endLine: startLine + inserted - 1,
        deletedCount: deleted,
      })
    } else if (inserted) {
      changes.push({
        kind: 'added',
        startLine,
        endLine: startLine + inserted - 1,
      })
    } else if (deleted) {
      changes.push({
        kind: 'deleted',
        startLine: Math.max(1, startLine - 1),
        endLine: Math.max(1, startLine - 1),
        deletedCount: deleted,
      })
    }
  }

  return changes
}
