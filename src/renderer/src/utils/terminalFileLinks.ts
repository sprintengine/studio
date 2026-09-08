import type { IBufferLine, ILink, ILinkProvider, Terminal } from '@xterm/xterm'
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
  startColumn: number
  text: string
}

type TerminalFileLinkActivateInput = {
  resolvedPath: string
  name: string
  isDirectory: boolean
  line?: number
  column?: number
}

/** What the clicked path turned out to be on disk. A path that cannot be read
 *  is reported as missing, which routes to `onOpenError` rather than a menu. */
type TerminalFileLinkPathInfo = { exists: boolean; isDirectory: boolean }

export type TerminalFileLinkProviderOptions = {
  terminal: Terminal
  workspaceRoot?: string | null
  executionRoot?: string | null
  inspectPath: (path: string) => Promise<TerminalFileLinkPathInfo>
  /** Hands the verified click up to the host (MC-1899): the provider no longer
   *  decides what a click DOES, it only resolves what was clicked. */
  onActivate: (input: TerminalFileLinkActivateInput, anchor: { x: number; y: number }) => Promise<void> | void
  /** Reports a failed open, anchored to the click that triggered it so the UI
   *  can surface the error next to the pointer. */
  onOpenError?: (message: string, anchor: { x: number; y: number }) => void
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
        x: offset - segment.startIndex + segment.startColumn,
        y: segment.y,
      }
    }
  }
  return null
}

const HANGING_CONTINUATION_PATTERN = /^(\s+)(\S+)/u
const PATH_SEPARATOR_PATTERN = /[\\/]/u

function lineReachesRightEdge(line: IBufferLine, cols: number): boolean {
  const cell = line.getCell(cols - 1)
  if (!cell) return false
  return cell.getChars().trim() !== ''
}

function trailingTokenHasSeparator(lineText: string): boolean {
  const trailingToken = lineText.trimEnd().split(/\s+/u).at(-1) ?? ''
  return PATH_SEPARATOR_PATTERN.test(trailingToken)
}

export function readWrappedLogicalLine(
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
      startColumn: 1,
      text: segmentText,
    })
    text += segmentText
  }

  for (const continuation of readHangingWrapContinuations(terminal, endY, segments.at(-1)?.text ?? '')) {
    segments.push({ ...continuation, startIndex: text.length })
    text += continuation.text
  }

  return { text, segments }
}

// Programs that render their own layout (agent CLIs, markdown formatters) will
// word-wrap a long path token onto an indented continuation line and emit a
// hard newline — so the rows are separate, non-wrapped buffer lines that the
// soft-wrap reader above never joins. Yield the continuation tokens only when
// the bottom line fills the terminal width and ends in a path-like token, then
// follow each hanging-indent continuation. Gating on the right edge keeps
// wrapped prose and unrelated indented lines from being merged into one link.
function readHangingWrapContinuations(
  terminal: Terminal,
  endY: number,
  bottomText: string
): Array<Omit<TerminalFileLinkSegment, 'startIndex'>> {
  const buffer = terminal.buffer.active
  const cols = terminal.cols
  let bottomLine = buffer.getLine(endY - 1)
  if (!bottomLine || !lineReachesRightEdge(bottomLine, cols) || !trailingTokenHasSeparator(bottomText)) {
    return []
  }

  const continuations: Array<Omit<TerminalFileLinkSegment, 'startIndex'>> = []
  let bottomY = endY
  while (bottomLine && lineReachesRightEdge(bottomLine, cols)) {
    const nextLine = buffer.getLine(bottomY)
    if (!nextLine || nextLine.isWrapped) break
    const nextText = nextLine.translateToString(true)
    const continuation = HANGING_CONTINUATION_PATTERN.exec(nextText)
    if (!continuation) break

    const indent = continuation[1] ?? ''
    const token = continuation[2] ?? ''
    continuations.push({ y: bottomY + 1, startColumn: indent.length + 1, text: token })
    bottomY += 1
    bottomLine = nextLine

    // Stop chaining once the path token completes before the line's edge: if
    // anything follows it, this line filled the width with trailing prose, not
    // with a token that wrapped again.
    if (nextText.slice(indent.length + token.length).trim() !== '') break
  }

  return continuations
}

export function createTerminalFileLinkProvider({
  terminal,
  workspaceRoot,
  executionRoot,
  inspectPath,
  onActivate,
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
          activate: (event) => {
            const anchor = { x: event.clientX, y: event.clientY }
            void (async () => {
              try {
                const info = await inspectPath(reference.resolvedPath)
                if (!info.exists) {
                  onOpenError?.(`File does not exist: ${reference.resolvedPath}`, anchor)
                  return
                }
                await onActivate({
                  resolvedPath: reference.resolvedPath,
                  name: basename(reference.resolvedPath),
                  isDirectory: info.isDirectory,
                  line: reference.line,
                  column: reference.column,
                }, anchor)
              } catch (error) {
                onOpenError?.(
                  error instanceof Error ? error.message : 'Could not open terminal file link.',
                  anchor,
                )
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
