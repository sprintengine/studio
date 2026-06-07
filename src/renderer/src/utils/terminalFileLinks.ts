import type { ILink, ILinkProvider, Terminal } from '@xterm/xterm'
import { basename, isAbsoluteFilePath, joinFilePath, pathSeparatorFor } from './paths'

export type TerminalFileReference = {
  text: string
  path: string
  resolvedPath: string
  line?: number
  column?: number
  startIndex: number
  endIndex: number
}

export type TerminalFileLinkSegment = {
  y: number
  startIndex: number
  text: string
}

export type TerminalFileLinkOpenInput = {
  resolvedPath: string
  name: string
  line?: number
  column?: number
}

export type TerminalFileLinkProviderOptions = {
  terminal: Terminal
  workspaceRoot?: string | null
  executionRoot?: string | null
  pathExists: (path: string) => Promise<boolean>
  openFile: (input: TerminalFileLinkOpenInput) => Promise<void> | void
  onOpenError?: (message: string) => void
}

const FILE_REFERENCE_PATTERN =
  /(^|[\s"'(<{\[])([A-Za-z]:[\\/][^\s"'<>`)\]}]+|\/[^\s"'<>`)\]}]+|\.{1,2}[\\/][^\s"'<>`)\]}]+|(?:[\w@.+-]+[\\/])+[\w@.+-][^\s"'<>`]*)/gu

const TRAILING_PUNCTUATION_PATTERN = /[.,;!?]+$/u

function stripTrailingPunctuation(value: string): string {
  let next = value.replace(TRAILING_PUNCTUATION_PATTERN, '')
  while (next.endsWith(')') || next.endsWith(']') || next.endsWith('}')) {
    const open = next.endsWith(')') ? '(' : next.endsWith(']') ? '[' : '{'
    const close = next.at(-1)
    const openCount = [...next].filter((char) => char === open).length
    const closeCount = [...next].filter((char) => char === close).length
    if (closeCount <= openCount) break
    next = next.slice(0, -1)
  }
  return next
}

function parseLineSuffix(value: string): { path: string; line?: number; column?: number } {
  const match = /^(.*?)(?::(\d{1,7})(?::(\d{1,7}))?)$/u.exec(value)
  if (!match) return { path: value }

  const path = match[1] ?? ''
  if (!path || /^[A-Za-z]$/u.test(path)) return { path: value }

  const line = Number(match[2])
  const column = match[3] ? Number(match[3]) : undefined
  if (!Number.isSafeInteger(line) || line <= 0) return { path: value }
  if (column !== undefined && (!Number.isSafeInteger(column) || column <= 0)) return { path: value }
  return { path, line, column }
}

function isRemoteOrShellReference(value: string): boolean {
  if (/^[a-z][a-z0-9+.-]*:\/\//iu.test(value)) return true
  if (value.startsWith('~/')) return true
  if (value.startsWith('~\\')) return true
  return false
}

function normalizePath(pathValue: string): string {
  const separator = pathSeparatorFor(pathValue)
  const normalized = pathValue.replace(/[\\/]+/gu, separator)
  const drive = /^[A-Za-z]:[\\/]/u.exec(normalized)?.[0]?.slice(0, 2) ?? ''
  const absoluteRoot = !drive && normalized.startsWith(separator) ? separator : ''
  const root = drive ? `${drive}${separator}` : absoluteRoot
  const rest = root ? normalized.slice(root.length) : normalized
  const segments: string[] = []

  for (const segment of rest.split(separator)) {
    if (!segment || segment === '.') continue
    if (segment === '..') {
      if (segments.length > 0 && segments.at(-1) !== '..') {
        segments.pop()
      } else if (!root) {
        segments.push(segment)
      }
      continue
    }
    segments.push(segment)
  }

  return `${root}${segments.join(separator)}` || root || '.'
}

export function resolveTerminalFileReferencePath(
  filePath: string,
  roots: { executionRoot?: string | null; workspaceRoot?: string | null }
): string | null {
  if (isRemoteOrShellReference(filePath)) return null
  if (isAbsoluteFilePath(filePath)) return normalizePath(filePath)

  const base = roots.executionRoot || roots.workspaceRoot
  if (!base) return null
  return normalizePath(joinFilePath(base, filePath))
}

export function findTerminalFileReferences(
  lineText: string,
  roots: { executionRoot?: string | null; workspaceRoot?: string | null }
): TerminalFileReference[] {
  const references: TerminalFileReference[] = []

  for (const match of lineText.matchAll(FILE_REFERENCE_PATTERN)) {
    const prefix = match[1] ?? ''
    const rawCandidate = match[2] ?? ''
    const matchIndex = match.index ?? 0
    const startIndex = matchIndex + prefix.length
    const text = stripTrailingPunctuation(rawCandidate)
    if (!text || isRemoteOrShellReference(text)) continue

    const parsed = parseLineSuffix(text)
    const resolvedPath = resolveTerminalFileReferencePath(parsed.path, roots)
    if (!resolvedPath) continue

    references.push({
      text,
      path: parsed.path,
      resolvedPath,
      line: parsed.line,
      column: parsed.column,
      startIndex,
      endIndex: startIndex + text.length,
    })
  }

  return references
}

export function rangeForTerminalFileReference(
  reference: Pick<TerminalFileReference, 'startIndex' | 'endIndex'>,
  segments: TerminalFileLinkSegment[]
): ILink['range'] | null {
  if (segments.length === 0 || reference.endIndex <= reference.startIndex) return null

  const start = positionForOffset(reference.startIndex, segments)
  const end = positionForOffset(reference.endIndex - 1, segments)
  if (!start || !end) return null

  return { start, end }
}

function positionForOffset(
  offset: number,
  segments: TerminalFileLinkSegment[]
): ILink['range']['start'] | null {
  for (const segment of segments) {
    const segmentEnd = segment.startIndex + segment.text.length
    if (offset >= segment.startIndex && offset < segmentEnd) {
      return {
        x: offset - segment.startIndex + 1,
        y: segment.y,
      }
    }
  }
  return null
}

function readWrappedLogicalLine(
  terminal: Terminal,
  bufferLineNumber: number
): { text: string; segments: TerminalFileLinkSegment[] } | null {
  const buffer = terminal.buffer.active
  const currentLine = buffer.getLine(bufferLineNumber - 1)
  if (!currentLine) return null

  let startY = bufferLineNumber
  while (startY > 1 && buffer.getLine(startY - 1)?.isWrapped) {
    startY -= 1
  }

  let endY = bufferLineNumber
  while (buffer.getLine(endY)?.isWrapped) {
    endY += 1
  }

  const segments: TerminalFileLinkSegment[] = []
  let text = ''
  for (let y = startY; y <= endY; y += 1) {
    const line = buffer.getLine(y - 1)
    if (!line) break
    const isLast = y === endY
    const segmentText = isLast
      ? line.translateToString(true)
      : line.translateToString(false, 0, terminal.cols)
    segments.push({
      y,
      startIndex: text.length,
      text: segmentText,
    })
    text += segmentText
  }

  return { text, segments }
}

export function createTerminalFileLinkProvider({
  terminal,
  workspaceRoot,
  executionRoot,
  pathExists,
  openFile,
  onOpenError,
}: TerminalFileLinkProviderOptions): ILinkProvider {
  return {
    provideLinks(bufferLineNumber, callback) {
      const logicalLine = readWrappedLogicalLine(terminal, bufferLineNumber)
      if (!logicalLine) {
        callback(undefined)
        return
      }

      const references = findTerminalFileReferences(logicalLine.text, { executionRoot, workspaceRoot })
      if (references.length === 0) {
        callback(undefined)
        return
      }

      const links: ILink[] = references.flatMap((reference) => {
        const range = rangeForTerminalFileReference(reference, logicalLine.segments)
        if (!range) return []

        return [{
          text: reference.text,
          range,
          decorations: {
            pointerCursor: true,
            underline: true,
          },
          activate: () => {
            void (async () => {
              try {
                const exists = await pathExists(reference.resolvedPath)
                if (!exists) {
                  onOpenError?.(`File does not exist: ${reference.resolvedPath}`)
                  return
                }
                await openFile({
                  resolvedPath: reference.resolvedPath,
                  name: basename(reference.resolvedPath),
                  line: reference.line,
                  column: reference.column,
                })
              } catch (error) {
                onOpenError?.(error instanceof Error ? error.message : 'Could not open terminal file link.')
              }
            })()
          },
        },
        ]
      })

      callback(links.length > 0 ? links : undefined)
    },
  }
}
