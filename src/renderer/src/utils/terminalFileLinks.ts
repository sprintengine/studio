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

/**
 * Why a path the pattern DID match never became a link.
 *
 * Both are invisible by construction — the text just stays un-underlined — so
 * they are reported to the host, which counts them in terminal diagnostics.
 * That is the only way a pane that quietly linkifies nothing can be told apart
 * from a pane whose output happens to contain no paths.
 *
 * - `no-root`: a relative path arrived with neither an execution root nor a
 *   workspace root to resolve it against. This is the one that actually
 *   happens, and the one the counter exists for.
 * - `no-range`: the reference resolved but its offsets did not land inside the
 *   buffer segments the logical line was read from. Through
 *   `createTerminalFileLinkProvider` this should be UNREACHABLE — the
 *   references are matched against the very text those segments tile, so every
 *   offset maps — which is exactly why it is worth counting: a non-zero
 *   `no-range` means the segment tiling and the match offsets have come apart,
 *   and every link on that line is silently gone.
 */
export type TerminalFileLinkDropReason = 'no-root' | 'no-range'

export type TerminalFileLinkDrop = {
  reason: TerminalFileLinkDropReason
  /** The matched text, for a diagnostic log line — never shown to the user. */
  text: string
}

/**
 * A root the provider resolves relative paths against, or a thunk read afresh
 * on every `provideLinks` call.
 *
 * The thunk exists because a pane's real root is not known when the provider is
 * registered. Registration is synchronous, immediately after `term.open`; the
 * spawn cwd is settled later behind an async `pathExists` (a worktree redirect),
 * and a shell's cwd changes for the rest of the session every time the user
 * types `cd` (OSC 7). A value baked in at registration is therefore a guess that
 * silently ages, and the failure mode is the worst kind: the same relative path
 * exists in the stale tree too, so the link opens the WRONG COPY rather than
 * failing. Reading it late costs nothing — `provideLinks` runs on hover.
 */
export type TerminalFileLinkRoot = string | null | (() => string | null)

function readTerminalFileLinkRoot(root: TerminalFileLinkRoot | undefined): string | null {
  return typeof root === 'function' ? root() : root ?? null
}

export type TerminalFileLinkProviderOptions = {
  terminal: Terminal
  workspaceRoot?: TerminalFileLinkRoot
  executionRoot?: TerminalFileLinkRoot
  inspectPath: (path: string) => Promise<TerminalFileLinkPathInfo>
  /** Hands the verified click up to the host (MC-1899): the provider no longer
   *  decides what a click DOES, it only resolves what was clicked. */
  onActivate: (input: TerminalFileLinkActivateInput, anchor: { x: number; y: number }) => Promise<void> | void
  /** Reports a failed open, anchored to the click that triggered it so the UI
   *  can surface the error next to the pointer. */
  onOpenError?: (message: string, anchor: { x: number; y: number }) => void
  /** Reports a match that was discarded before it could become a link. */
  onDrop?: (drop: TerminalFileLinkDrop) => void
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

/**
 * Decision of record (2026-09-08, item `terminal-relative-links-dropped`):
 * with neither root known we leave a relative path UNLINKED rather than guess
 * a base for it. A guessed root produces links that open the wrong file — or,
 * worse, a same-named file in an unrelated tree — and a terminal pane is the
 * one place where "that is not the file I clicked" is unrecoverable.
 *
 * The roots are both null exactly when the workspace has no configured folder:
 * `TerminalView` derives them from `folderReadyPath`/`savedFolderPath`, and its
 * terminal effect deliberately runs for a folder-less workspace. Such an agent
 * runs in the app's default path, which only main knows — the renderer has
 * nothing to resolve against. Reading the agent's real cwd off the wire is
 * [[terminal-osc7-cwd]]'s job, not a guess this function should make.
 *
 * Until then the drop is at least COUNTED: callers pass `onDrop` and the count
 * reaches terminal diagnostics.
 */
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
  roots: { executionRoot?: string | null; workspaceRoot?: string | null },
  onDrop?: (drop: TerminalFileLinkDrop) => void
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
    // A URL or a `~/…` path is a deliberate NON-match, not a drop: counting it
    // would fire the diagnostic on every `https://…` an agent prints. Screened
    // on `text` above and re-screened here on the suffix-stripped path, so the
    // reason recorded below stays a fact about this branch rather than an
    // argument about which prefixes `parseLineSuffix` can and cannot remove.
    if (isRemoteOrShellReference(parsed.path)) continue

    const resolvedPath = resolveTerminalFileReferencePath(parsed.path, roots)
    if (!resolvedPath) {
      // Only one way left to get here: a relative path with no root to hang it
      // on. See the decision of record on `resolveTerminalFileReferencePath`.
      onDrop?.({ reason: 'no-root', text })
      continue
    }

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
  onDrop,
}: TerminalFileLinkProviderOptions): ILinkProvider {
  return {
    provideLinks(bufferLineNumber, callback) {
      const logicalLine = readWrappedLogicalLine(terminal, bufferLineNumber)
      if (!logicalLine) {
        callback(undefined)
        return
      }

      // Read on every call, not captured at registration: see
      // `TerminalFileLinkRoot`. For a plain root this is the same value it
      // always was.
      const references = findTerminalFileReferences(
        logicalLine.text,
        {
          executionRoot: readTerminalFileLinkRoot(executionRoot),
          workspaceRoot: readTerminalFileLinkRoot(workspaceRoot),
        },
        onDrop
      )
      if (references.length === 0) {
        callback(undefined)
        return
      }

      const links: ILink[] = references.flatMap((reference) => {
        const range = rangeForTerminalFileReference(reference, logicalLine.segments)
        if (!range) {
          // Invariant tripwire, not an expected branch: `reference` was matched
          // against `logicalLine.text`, which `logicalLine.segments` tile
          // exactly, so every offset must map to a cell. Counted rather than
          // ignored because the failure mode is a line that silently stops
          // linkifying.
          onDrop?.({ reason: 'no-range', text: reference.text })
          return []
        }

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
