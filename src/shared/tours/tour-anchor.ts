// Turning an agent's anchor into lines, and finding those lines again later.
//
// Pure text in, lines out: main reads the files and the `-U0` hunks, this file
// decides. Two rules carry the whole design.
//
//   1. **Every failure is reported, not the first one.** An agent writing a
//      twelve-step tour that is told about one bad anchor fixes it, resubmits,
//      and is told about the next. `resolveTourSteps` walks every step and
//      returns every problem, each naming the step and saying what would work.
//
//   2. **Lines are found again by content, never trusted by number.** A
//      working-tree tour is read against files the agent may keep editing. The
//      anchor keeps its lines, the fingerprint of the hunk they sat in, and the
//      first and last line's text; `relocateAnchor` tries them in that order and
//      only when all three fail calls the step moved. A moved step keeps the
//      text the agent wrote and the excerpt of what it pointed at — it is never
//      skipped.

import { hunkFingerprint, locateHunk, type DiffHunk } from '../git/hunks'
import type {
  TourAnchor,
  TourFileStatus,
  TourFileUnreadable,
  TourSide,
  TourStep,
  TourStepInput,
  TourStepLiveStatus,
} from './tour-types'

/** The ceiling on a step's stored excerpt. */
export const TOUR_EXCERPT_MAX_LINES = 80

/** One changed file, both sides, as main read it. */
export type TourFileSnapshot = {
  path: string
  oldPath?: string
  status: TourFileStatus
  unreadable: TourFileUnreadable
  /** Null where the side does not exist (an added file's old side). */
  oldText: string | null
  newText: string | null
  /** `-U0` hunks, old → new. */
  hunks: DiffHunk[]
}

/** The file's lines, without the phantom empty line after a final newline. */
export function splitLines(text: string | null): string[] {
  if (text === null || text === '') return []
  const lines = text.split('\n')
  if (lines[lines.length - 1] === '') lines.pop()
  return lines.map((line) => (line.endsWith('\r') ? line.slice(0, -1) : line))
}

function sideText(file: TourFileSnapshot, side: TourSide): string | null {
  return side === 'new' ? file.newText : file.oldText
}

/** A hunk's span on one side, or null when it has no lines there (a pure add or delete). */
export function hunkSpan(hunk: DiffHunk, side: TourSide): [number, number] | null {
  const start = side === 'new' ? hunk.newStart : hunk.oldStart
  const count = side === 'new' ? hunk.newLines : hunk.oldLines
  return count > 0 ? [start, start + count - 1] : null
}

function overlappingHunk(
  hunks: DiffHunk[],
  side: TourSide,
  start: number,
  end: number,
): { hunk: DiffHunk; index: number } | null {
  for (let index = 0; index < hunks.length; index += 1) {
    const span = hunkSpan(hunks[index], side)
    if (span && span[0] <= end && span[1] >= start) return { hunk: hunks[index], index }
  }
  return null
}

function changedLineSet(hunks: DiffHunk[], side: TourSide): Set<number> {
  const set = new Set<number>()
  for (const hunk of hunks) {
    const span = hunkSpan(hunk, side)
    if (!span) continue
    for (let line = span[0]; line <= span[1]; line += 1) set.add(line)
  }
  return set
}

/**
 * The lines a step points at, as a small unified excerpt: `+` / `-` for a line
 * the change touched on that side, a space for one it did not. A file-level
 * step keeps the file's first hunks instead.
 */
export function excerptFor(file: TourFileSnapshot, side: TourSide, start: number | null, end: number | null): string[] {
  if (start === null || end === null) {
    const out: string[] = []
    for (const hunk of file.hunks) {
      for (const line of hunk.lines) {
        if (out.length >= TOUR_EXCERPT_MAX_LINES) return out
        out.push(line.endsWith('\r') ? line.slice(0, -1) : line)
      }
    }
    return out
  }
  const lines = splitLines(sideText(file, side))
  const changed = changedLineSet(file.hunks, side)
  const marker = side === 'new' ? '+' : '-'
  const out: string[] = []
  for (let line = start; line <= end && out.length < TOUR_EXCERPT_MAX_LINES; line += 1) {
    out.push(`${changed.has(line) ? marker : ' '}${lines[line - 1] ?? ''}`)
  }
  return out
}

function describeLineRange(start: number, end: number): string {
  return start === end ? `line ${start}` : `lines ${start}–${end}`
}

/** A short, bounded list of candidates for an error message. */
function listSome(values: readonly string[], max = 12): string {
  if (values.length === 0) return '(none)'
  const shown = values.slice(0, max).join(', ')
  return values.length > max ? `${shown}, and ${values.length - max} more` : shown
}

export type ResolveStepsResult = { ok: true; steps: TourStep[] } | { ok: false; errors: string[] }

/**
 * Resolve every step, or say everything that is wrong with them.
 *
 * `files` is every file in the tour's changes. A step naming a file outside
 * them is an error rather than a silent file-level step: the tour is a walk
 * through THESE changes, and a path that is not one of them is almost always a
 * typo or a file the agent meant to change and did not.
 */
export function resolveTourSteps(inputs: TourStepInput[], files: TourFileSnapshot[]): ResolveStepsResult {
  const errors: string[] = []
  const steps: TourStep[] = []
  const byPath = new Map(files.map((file) => [file.path, file]))
  const changedPaths = files.map((file) => file.path)

  inputs.forEach((input) => {
    // By id, not position: the shape pass may already have dropped an earlier
    // malformed step, so a number here could name the wrong one.
    const label = `Step "${input.id}"`
    const file = byPath.get(input.path)
    if (!file) {
      const renamedFrom = files.find((candidate) => candidate.oldPath === input.path)
      errors.push(
        renamedFrom
          ? `${label}: ${input.path} was renamed to ${renamedFrom.path}; use path "${renamedFrom.path}" with oldPath "${input.path}".`
          : `${label}: ${input.path} is not in this tour's changes. Changed files: ${listSome(changedPaths)}.`,
      )
      return
    }
    const resolved = resolveOne(input, file, label)
    if ('error' in resolved) {
      errors.push(resolved.error)
      return
    }
    steps.push(resolved.step)
  })

  return errors.length > 0 ? { ok: false, errors } : { ok: true, steps }
}

function resolveOne(
  input: TourStepInput,
  file: TourFileSnapshot,
  label: string,
): { step: TourStep } | { error: string } {
  const side = input.side
  if (side === 'new' && file.status === 'deleted') {
    return { error: `${label}: ${file.path} was deleted, so it has no new side. Use side "old".` }
  }
  if (side === 'old' && file.status === 'new') {
    return { error: `${label}: ${file.path} is a new file, so it has no old side. Use side "new".` }
  }
  if (file.unreadable && !input.fileOnly) {
    const why = file.unreadable === 'binary' ? 'is binary' : 'is too large to show as text'
    return { error: `${label}: ${file.path} ${why}; only a file-level step (fileOnly: true) can point at it.` }
  }

  const lines = splitLines(sideText(file, side))
  let start: number | null = null
  let end: number | null = null

  if (input.fileOnly) {
    // Nothing to resolve.
  } else if (input.lines) {
    const [a, b] = input.lines
    if (a < 1 || b < a) {
      return { error: `${label}: lines must be [start, end] with 1 ≤ start ≤ end; got [${a}, ${b}].` }
    }
    if (b > lines.length) {
      return {
        error: `${label}: ${file.path} has ${lines.length} lines on the ${side} side, so ${describeLineRange(a, b)} is past its end. Prefer a match or hunk anchor over counted lines.`,
      }
    }
    start = a
    end = b
  } else if (input.hunk !== undefined) {
    const hunk = file.hunks[input.hunk - 1]
    if (!hunk) {
      return {
        error: `${label}: ${file.path} has ${file.hunks.length} ${file.hunks.length === 1 ? 'hunk' : 'hunks'}; hunk ${input.hunk} does not exist (hunks are numbered from 1).`,
      }
    }
    const span = hunkSpan(hunk, side)
    if (!span) {
      const other: TourSide = side === 'new' ? 'old' : 'new'
      return {
        error: `${label}: hunk ${input.hunk} of ${file.path} only ${side === 'new' ? 'removes' : 'adds'} lines, so it has nothing on the ${side} side. Use side "${other}".`,
      }
    }
    start = span[0]
    end = span[1]
  } else if (input.match !== undefined) {
    const found = findMatch(lines, input.match)
    if (found.length === 0) {
      return { error: `${label}: "${clip(input.match)}" does not appear on the ${side} side of ${file.path}.` }
    }
    if (found.length > 1) {
      return {
        error: `${label}: "${clip(input.match)}" appears ${found.length} times on the ${side} side of ${file.path} (lines ${listSome(found.map(String), 6)}); make it unique, or use lines.`,
      }
    }
    const matchLines = input.match.replace(/\r/g, '').split('\n').length
    const span = input.lineCount ?? matchLines
    start = found[0]
    end = found[0] + span - 1
    if (end > lines.length) {
      return {
        error: `${label}: lineCount ${span} from line ${start} runs past the end of ${file.path} (${lines.length} lines).`,
      }
    }
  }

  const anchor: TourAnchor = {
    path: file.path,
    ...(file.oldPath ? { oldPath: file.oldPath } : input.oldPath ? { oldPath: input.oldPath } : {}),
    side,
    startLine: start,
    endLine: end,
  }
  if (start !== null && end !== null) {
    const hunk = overlappingHunk(file.hunks, side, start, end)
    if (hunk) anchor.hunk = { index: hunk.index, fingerprint: hunkFingerprint(hunk.hunk) }
    anchor.snippet = {
      first: (lines[start - 1] ?? '').trim(),
      last: (lines[end - 1] ?? '').trim(),
      body: rangeBody(lines, start, end),
    }
  }

  return {
    step: {
      id: input.id,
      title: input.title,
      body: input.body,
      ...(input.hoverTip ? { hoverTip: input.hoverTip } : {}),
      kind: input.kind ?? 'explain',
      anchor,
      fileStatus: file.status,
      unreadable: file.unreadable,
      excerpt: excerptFor(file, side, start, end),
    },
  }
}

function clip(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > 60 ? `${flat.slice(0, 60)}…` : flat
}

/**
 * The 1-based lines where `needle` starts. A multi-line needle matches a run
 * of consecutive lines; a single-line needle matches as a substring of one
 * line. Whitespace at the ends of each needle line is ignored, so an agent
 * quoting an indented line without its indent still finds it.
 */
export function findMatch(lines: string[], needle: string): number[] {
  const wanted = needle
    .replace(/\r/g, '')
    .split('\n')
    .map((line) => line.trim())
  while (wanted.length > 1 && wanted[wanted.length - 1] === '') wanted.pop()
  if (wanted.every((line) => line === '')) return []
  const hits: number[] = []
  for (let i = 0; i + wanted.length <= lines.length; i += 1) {
    if (wanted.length === 1) {
      if (lines[i].includes(wanted[0])) hits.push(i + 1)
      continue
    }
    // First and last needle lines may be partial; the ones between are whole.
    let ok = lines[i].includes(wanted[0])
    for (let k = 1; ok && k < wanted.length; k += 1) {
      const line = lines[i + k].trim()
      ok = k === wanted.length - 1 ? line.includes(wanted[k]) : line === wanted[k]
    }
    if (ok) hits.push(i + 1)
  }
  return hits
}

export type RelocatedAnchor = { status: TourStepLiveStatus; startLine: number | null; endLine: number | null }

/** The text of a range, compared line by line with the ends of each line ignored. */
function rangeBody(lines: string[], start: number, end: number): string {
  return lines
    .slice(start - 1, end)
    .map((line) => line.trim())
    .join('\n')
}

/** Text with so little in it that it proves nothing where it is found: `}`, `});`, a blank line. */
function isLowContent(body: string): boolean {
  return body.replace(/[\s{}()[\];,]/g, '').length < 4
}

/**
 * Where a step's lines are now.
 *
 * `file` is the file's current snapshot, or null when it has left the diff —
 * the step is then `gone`, and keeps its text. A position counts as the same
 * lines only when the WHOLE range reads the same (or, for a tour stored before
 * the range was kept, its first and last line). The evidence, strongest first:
 *
 *   1. The hunk the lines sat in, found again by its fingerprint: the lines are
 *      looked for inside it, so a range that also appears elsewhere (a closing
 *      brace) is found at the right occurrence.
 *   2. The lines where they were.
 *   3. The nearest occurrence anywhere in the file — unless the text is too
 *      bare to prove anything and occurs more than once.
 *
 * Nothing found is `moved`: the lines are drawn where they were, clamped to the
 * file, and the viewer says the code changed after the tour was written.
 */
export function relocateAnchor(anchor: TourAnchor, file: TourFileSnapshot | null): RelocatedAnchor {
  if (!file) return { status: 'gone', startLine: anchor.startLine, endLine: anchor.endLine }
  if (anchor.startLine === null || anchor.endLine === null) return { status: 'ok', startLine: null, endLine: null }
  const lines = splitLines(sideText(file, anchor.side))
  const span = anchor.endLine - anchor.startLine
  const snippet = anchor.snippet

  if (!snippet) {
    return anchor.endLine <= lines.length
      ? { status: 'ok', startLine: anchor.startLine, endLine: anchor.endLine }
      : clampMoved(anchor, lines.length)
  }

  const readsTheSame = (start: number): boolean => {
    if (start < 1 || start + span > lines.length) return false
    if (snippet.body !== undefined) return rangeBody(lines, start, start + span) === snippet.body
    return (lines[start - 1] ?? '').trim() === snippet.first && (lines[start + span - 1] ?? '').trim() === snippet.last
  }
  const found = (start: number): RelocatedAnchor => ({ status: 'ok', startLine: start, endLine: start + span })
  const bare = isLowContent(snippet.body ?? `${snippet.first}\n${snippet.last}`)

  if (anchor.hunk) {
    const located = locateHunk(file.hunks, anchor.hunk.index, anchor.hunk.fingerprint)
    const hunkNow = located.ok ? hunkSpan(located.hunk, anchor.side) : null
    if (hunkNow) {
      // A range may start a little above the hunk it overlaps (a step that
      // takes in the line before a change), so the search starts that far up.
      for (let start = Math.max(1, hunkNow[0] - span); start <= hunkNow[1]; start += 1) {
        if (readsTheSame(start)) return found(start)
      }
      // The hunk is there and the lines are not in it: the code under the step
      // changed. Bare text found elsewhere would be a coincidence, not the step.
      if (bare) return clampMoved(anchor, lines.length)
    }
  }

  if (readsTheSame(anchor.startLine) && !bare) return found(anchor.startLine)

  const matches: number[] = []
  for (let start = 1; start + span <= lines.length; start += 1) {
    if (readsTheSame(start)) matches.push(start)
  }
  if (matches.length === 0 || (bare && matches.length > 1)) return clampMoved(anchor, lines.length)
  const nearest = matches.reduce((best, start) =>
    Math.abs(start - anchor.startLine!) < Math.abs(best - anchor.startLine!) ? start : best,
  )
  return found(nearest)
}

function clampMoved(anchor: TourAnchor, lineCount: number): RelocatedAnchor {
  const last = Math.max(1, lineCount)
  const start = Math.min(anchor.startLine ?? 1, last)
  const end = Math.min(Math.max(anchor.endLine ?? start, start), last)
  return { status: 'moved', startLine: start, endLine: end }
}
