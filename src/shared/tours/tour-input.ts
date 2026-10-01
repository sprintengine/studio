// Reading an agent's JSON into a tour request — shape only.
//
// Whether an anchor lands on real lines is `tour-anchor.ts`'s question and
// needs the files; this file answers everything that can be decided from the
// arguments alone, and, like the anchor pass, reports every problem at once.

import { isRecord } from '../records'
import type { TourChanges, TourSide, TourStepInput, TourStepKind } from './tour-types'

export const TOUR_MAX_STEPS = 60
export const TOUR_MAX_TITLE = 120
export const TOUR_MAX_BODY = 8_000
export const TOUR_MAX_OVERVIEW = 4_000
const STEP_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/
const KINDS: readonly TourStepKind[] = ['explain', 'context', 'caveat']

export type TourCreateInput = {
  title: string
  overview?: string
  changes: TourChanges
  steps: TourStepInput[]
}

type Parsed<T> = { ok: true; value: T } | { ok: false; errors: string[] }

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function isPositiveInt(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1
}

export function parseChanges(value: unknown, errors: string[]): TourChanges | null {
  if (!isRecord(value)) {
    errors.push('changes: required — {kind: "changelist"}, {kind: "worktree"} or {kind: "range", base, head}.')
    return null
  }
  if (value.kind === 'changelist' || value.kind === 'worktree') return { kind: value.kind }
  if (value.kind === 'range') {
    const base = text(value.base)
    const head = text(value.head)
    if (!base || !head) {
      errors.push('changes: a range needs both `base` and `head` (a commit, branch or tag each).')
      return null
    }
    return { kind: 'range', base, head }
  }
  errors.push(`changes.kind: must be "changelist", "worktree" or "range"; got ${JSON.stringify(value.kind)}.`)
  return null
}

/**
 * One step's shape. `position` is 1-based and only used to name the step in an
 * error when its id is itself the problem.
 */
export function parseStep(value: unknown, position: number, errors: string[]): TourStepInput | null {
  const where = `steps[${position - 1}]`
  if (!isRecord(value)) {
    errors.push(`${where}: must be an object.`)
    return null
  }
  const before = errors.length
  const id = text(value.id)
  const label = id ? `Step ${position} ("${id}")` : where
  if (!id) errors.push(`${where}: \`id\` is required (a short slug such as "retry-loop").`)
  else if (!STEP_ID.test(id)) errors.push(`${label}: id may use letters, digits, ".", "_" and "-" (max 64).`)
  const title = text(value.title)
  if (!title) errors.push(`${label}: \`title\` is required.`)
  else if (title.length > TOUR_MAX_TITLE) errors.push(`${label}: title is over ${TOUR_MAX_TITLE} characters.`)
  const body = typeof value.body === 'string' ? value.body.trim() : ''
  if (!body) errors.push(`${label}: \`body\` is required (markdown).`)
  else if (body.length > TOUR_MAX_BODY) errors.push(`${label}: body is over ${TOUR_MAX_BODY} characters.`)
  const path = text(value.path)
  if (!path) errors.push(`${label}: \`path\` is required (repository-relative).`)
  const normalizedPath = path ? normalizeTourPath(path) : null
  if (path && !normalizedPath) errors.push(`${label}: path "${path}" must be relative to the repository root.`)
  const side = value.side === undefined ? 'new' : value.side
  if (side !== 'new' && side !== 'old') errors.push(`${label}: side must be "new" or "old".`)
  const kind = value.kind === undefined ? undefined : value.kind
  if (kind !== undefined && !KINDS.includes(kind as TourStepKind)) {
    errors.push(`${label}: kind must be one of ${KINDS.join(', ')}.`)
  }

  const anchors = ['lines', 'hunk', 'match', 'fileOnly'].filter(
    (key) => value[key] !== undefined && value[key] !== false,
  )
  if (anchors.length !== 1) {
    errors.push(
      anchors.length === 0
        ? `${label}: give exactly one anchor — match, hunk, lines or fileOnly: true.`
        : `${label}: give exactly one anchor; this step has ${anchors.join(' and ')}.`,
    )
  }
  let lines: [number, number] | undefined
  if (value.lines !== undefined) {
    const raw = value.lines
    if (!Array.isArray(raw) || raw.length !== 2 || !isPositiveInt(raw[0]) || !isPositiveInt(raw[1])) {
      errors.push(`${label}: lines must be [start, end], two positive integers.`)
    } else {
      lines = [raw[0], raw[1]]
    }
  }
  if (value.hunk !== undefined && !isPositiveInt(value.hunk)) {
    errors.push(`${label}: hunk must be a positive integer (1 is the file's first change).`)
  }
  if (value.match !== undefined && (typeof value.match !== 'string' || !value.match.trim())) {
    errors.push(`${label}: match must be non-empty text.`)
  }
  if (value.lineCount !== undefined) {
    if (!isPositiveInt(value.lineCount)) errors.push(`${label}: lineCount must be a positive integer.`)
    else if (value.match === undefined) errors.push(`${label}: lineCount only goes with match.`)
  }
  if (value.fileOnly !== undefined && value.fileOnly !== true && value.fileOnly !== false) {
    errors.push(`${label}: fileOnly must be true.`)
  }
  if (errors.length > before) return null

  const step: TourStepInput = {
    id: id!,
    title: title!,
    body,
    path: normalizedPath!,
    side: side as TourSide,
  }
  const hoverTip = text(value.hoverTip)
  if (hoverTip) step.hoverTip = hoverTip.slice(0, TOUR_MAX_TITLE)
  if (kind) step.kind = kind as TourStepKind
  const oldPath = text(value.oldPath)
  if (oldPath) step.oldPath = normalizeTourPath(oldPath) ?? oldPath
  if (lines) step.lines = lines
  if (typeof value.hunk === 'number') step.hunk = value.hunk
  if (typeof value.match === 'string') step.match = value.match
  if (typeof value.lineCount === 'number') step.lineCount = value.lineCount
  if (value.fileOnly === true) step.fileOnly = true
  return step
}

/** `./src/x.ts`, `src\x.ts` → `src/x.ts`. Null for anything that leaves the repository. */
export function normalizeTourPath(path: string): string | null {
  const slashed = path.replace(/\\/g, '/').replace(/^\.\/+/, '')
  if (slashed.startsWith('/') || /^[A-Za-z]:\//.test(slashed)) return null
  const parts = slashed.split('/').filter((part) => part !== '' && part !== '.')
  if (parts.some((part) => part === '..') || parts.length === 0) return null
  return parts.join('/')
}

export function parseSteps(value: unknown, errors: string[], options: { allowEmpty?: boolean } = {}): TourStepInput[] {
  if (!Array.isArray(value) || (!options.allowEmpty && value.length === 0)) {
    errors.push('steps: required — a non-empty array of steps.')
    return []
  }
  if (value.length > TOUR_MAX_STEPS) {
    errors.push(`steps: at most ${TOUR_MAX_STEPS} per tour; split a longer walk into two tours.`)
    return []
  }
  const steps: TourStepInput[] = []
  value.forEach((raw, index) => {
    const step = parseStep(raw, index + 1, errors)
    if (step) steps.push(step)
  })
  return steps
}

/** Duplicate ids across `existing` and `incoming`, as errors. */
export function duplicateIdErrors(ids: readonly string[]): string[] {
  const seen = new Set<string>()
  const dupes = new Set<string>()
  for (const id of ids) {
    if (seen.has(id)) dupes.add(id)
    seen.add(id)
  }
  return [...dupes].map((id) => `Step id "${id}" is used more than once; ids must be unique within a tour.`)
}

/**
 * `partial` is what survived the shape check — the request with only its
 * well-formed steps — so the anchors of those steps can still be resolved and
 * their problems reported in the SAME answer as the shape problems.
 */
export function parseTourCreate(
  args: Record<string, unknown>,
): { ok: true; value: TourCreateInput } | { ok: false; errors: string[]; partial: TourCreateInput | null } {
  const errors: string[] = []
  const title = text(args.title)
  if (!title) errors.push('title: required.')
  else if (title.length > TOUR_MAX_TITLE) errors.push(`title: at most ${TOUR_MAX_TITLE} characters.`)
  const overview = typeof args.overview === 'string' ? args.overview.trim() : undefined
  if (overview && overview.length > TOUR_MAX_OVERVIEW) errors.push(`overview: at most ${TOUR_MAX_OVERVIEW} characters.`)
  const changes = parseChanges(args.changes, errors)
  const steps = parseSteps(args.steps, errors)
  errors.push(...duplicateIdErrors(steps.map((step) => step.id)))
  if (errors.length > 0 || !changes || !title) {
    const partial = changes ? { title: title ?? '', ...(overview ? { overview } : {}), changes, steps } : null
    return { ok: false, errors, partial }
  }
  return { ok: true, value: { title, ...(overview ? { overview } : {}), changes, steps } }
}

/** `insertAfter.after` omitted: append. Not a legal step id (ids start alphanumeric). */
export const TOUR_APPEND = '__end__'

export type TourUpdateInput = {
  tourId: string
  insertAfter?: { after: string | null; steps: TourStepInput[] }
  replace?: TourStepInput[]
  remove?: string[]
  title?: string
  overview?: string
}

/**
 * `tour.update`: one of three edits, or a combination of them, applied in the
 * order remove → replace → insert.
 *
 * `insertAfter` is `{after, steps}` where `after` is a step id, or null for
 * the front of the tour; omitted `after` appends. That is how an agent streams
 * a long tour in batches (append), or answers a question with a detour step
 * placed right after the one being asked about.
 */
export function parseTourUpdate(args: Record<string, unknown>): Parsed<TourUpdateInput> {
  const errors: string[] = []
  const tourId = text(args.tourId)
  if (!tourId) errors.push('tourId: required.')
  const out: TourUpdateInput = { tourId: tourId ?? '' }
  if (args.insertAfter !== undefined) {
    if (!isRecord(args.insertAfter)) {
      errors.push('insertAfter: must be {after?: stepId | null, steps: [...]}.')
    } else {
      const after =
        args.insertAfter.after === undefined
          ? undefined
          : args.insertAfter.after === null
            ? null
            : text(args.insertAfter.after)
      const steps = parseSteps(args.insertAfter.steps, errors)
      out.insertAfter = { after: after === undefined ? TOUR_APPEND : after, steps }
    }
  }
  if (args.replace !== undefined) out.replace = parseSteps(args.replace, errors)
  if (args.remove !== undefined) {
    if (!Array.isArray(args.remove) || !args.remove.every((id) => typeof id === 'string')) {
      errors.push('remove: must be an array of step ids.')
    } else {
      out.remove = args.remove as string[]
    }
  }
  const title = text(args.title)
  if (title) out.title = title.slice(0, TOUR_MAX_TITLE)
  if (typeof args.overview === 'string') out.overview = args.overview.trim().slice(0, TOUR_MAX_OVERVIEW)
  if (!out.insertAfter && !out.replace && !out.remove && !out.title && out.overview === undefined) {
    errors.push('Nothing to update: give insertAfter, replace, remove, title or overview.')
  }
  return errors.length > 0 ? { ok: false, errors } : { ok: true, value: out }
}
