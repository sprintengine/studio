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

function diffLineOps(baseLines: string[], currentLines: string[]): DiffOp[] {
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

export function getGitLineChanges(baseContent: string, currentContent: string): GitLineChange[] {
  if (baseContent === currentContent) return []

  const baseLines = splitLines(baseContent)
  const currentLines = splitLines(currentContent)
  if (baseLines.length * currentLines.length > 2_000_000) {
    return buildFallbackChange(baseLines, currentLines)
  }

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
