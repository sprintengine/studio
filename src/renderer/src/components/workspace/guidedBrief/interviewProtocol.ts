import { stripAnsiAndOverwrites } from './parseStream'

// Structured interview protocol for guided-brief specialists. The prompt
// already forces one question at a time with 2-4 labeled options; this module
// parses the machine-readable mirror of that interview from raw PTY output so
// the UI can render native question cards instead of asking the user to read
// and type into the terminal. The PTY stays the only transport: questions are
// fenced stdout blocks, answers are written to stdin, and resolved decisions
// are echoed as single marker lines.
//
// Truthfulness contract: a malformed block is dropped and counted — never
// partially rendered. When the agent stops emitting structured questions the
// state simply has no current question and the UI falls back to the raw
// terminal; there is no fabricated card state.

const GUIDED_QUESTION_BEGIN = 'GUIDED_QUESTION_BEGIN'
const GUIDED_QUESTION_END = 'GUIDED_QUESTION_END'
const GUIDED_DECISION_PREFIX = 'GUIDED_DECISION:'

type GuidedInterviewOption = {
  /** Exactly what would be typed into the terminal to choose this option. */
  key: string
  label: string
  detail?: string
  recommended?: boolean
}

export type GuidedInterviewQuestion = {
  id: string
  question: string
  options: GuidedInterviewOption[]
  allowOther?: boolean
}

export type GuidedInterviewDecision = {
  id: string
  question?: string
  label: string
}

export type GuidedInterviewState = {
  /** The latest unanswered structured question, if any. */
  currentQuestion: GuidedInterviewQuestion | null
  /** Resolved decisions in emission order, deduped by id (last wins). */
  decisions: GuidedInterviewDecision[]
  /** Fenced blocks or decision lines that failed to parse. */
  malformedCount: number
}

export const EMPTY_GUIDED_INTERVIEW_STATE: GuidedInterviewState = {
  currentQuestion: null,
  decisions: [],
  malformedCount: 0,
}

// Same prompt-chrome allowlist the readiness marker uses: CLIs like Codex wrap
// output lines in box-drawing (`│ … │`) and Claude Code prefixes glyphs (`⏺`).
// design-tokens-allow: matches chrome a CLI printed, not a glyph the product draws
const PROMPT_CHROME = /^[\s>│●⏺•*»]+|[\s>│●⏺•*»]+$/gu

function stripChrome(line: string): string {
  return line.replace(PROMPT_CHROME, '')
}

function parseOption(raw: unknown): GuidedInterviewOption | null {
  if (typeof raw !== 'object' || raw === null) return null
  const candidate = raw as Record<string, unknown>
  const key = typeof candidate.key === 'string' ? candidate.key.trim() : ''
  const label = typeof candidate.label === 'string' ? candidate.label.trim() : ''
  if (!key || !label) return null
  return {
    key,
    label,
    ...(typeof candidate.detail === 'string' && candidate.detail.trim()
      ? { detail: candidate.detail.trim() }
      : {}),
    ...(candidate.recommended === true ? { recommended: true } : {}),
  }
}

function parseQuestionJson(text: string): GuidedInterviewQuestion | null {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return null
  }
  if (typeof raw !== 'object' || raw === null) return null
  const candidate = raw as Record<string, unknown>
  const id = typeof candidate.id === 'string' ? candidate.id.trim() : ''
  const question = typeof candidate.question === 'string' ? candidate.question.trim() : ''
  if (!id || !question) return null
  if (!Array.isArray(candidate.options)) return null
  const options = candidate.options
    .map(parseOption)
    .filter((option): option is GuidedInterviewOption => option !== null)
  if (options.length < 1 || options.length > 6) return null
  return {
    id,
    question,
    options,
    ...(candidate.allowOther === true ? { allowOther: true } : {}),
  }
}

function parseDecisionJson(text: string): GuidedInterviewDecision | null {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return null
  }
  if (typeof raw !== 'object' || raw === null) return null
  const candidate = raw as Record<string, unknown>
  const id = typeof candidate.id === 'string' ? candidate.id.trim() : ''
  const label = typeof candidate.label === 'string' ? candidate.label.trim() : ''
  if (!id || !label) return null
  return {
    id,
    label,
    ...(typeof candidate.question === 'string' && candidate.question.trim()
      ? { question: candidate.question.trim() }
      : {}),
  }
}

/**
 * Parse the full (cumulative) stripped output for interview structure. The
 * scan is order-aware: a question is current only while no later decision
 * resolves it and no later question supersedes it. TUI redraws repeat the
 * same block; identical re-parses are harmless.
 */
export function parseGuidedInterviewOutput(output: string): GuidedInterviewState {
  const lines = stripAnsiAndOverwrites(output).split(/\r?\n/)
  const decisionsById = new Map<string, GuidedInterviewDecision>()
  const decisionOrder: string[] = []
  let malformedCount = 0
  let latestQuestion: GuidedInterviewQuestion | null = null
  let latestQuestionLine = -1
  const latestDecisionLineById = new Map<string, number>()

  let blockLines: string[] | null = null
  for (let index = 0; index < lines.length; index += 1) {
    const stripped = stripChrome(lines[index])
    if (stripped === GUIDED_QUESTION_BEGIN) {
      // A new BEGIN abandons any unterminated block (a torn redraw).
      blockLines = []
      continue
    }
    if (stripped === GUIDED_QUESTION_END) {
      if (blockLines === null) continue
      const question = parseQuestionJson(blockLines.join('\n').trim())
      if (question) {
        latestQuestion = question
        latestQuestionLine = index
      } else {
        malformedCount += 1
      }
      blockLines = null
      continue
    }
    if (blockLines !== null) {
      blockLines.push(stripped)
      continue
    }
    if (stripped.startsWith(GUIDED_DECISION_PREFIX)) {
      const decision = parseDecisionJson(stripped.slice(GUIDED_DECISION_PREFIX.length).trim())
      if (!decision) {
        malformedCount += 1
        continue
      }
      if (!decisionsById.has(decision.id)) decisionOrder.push(decision.id)
      decisionsById.set(decision.id, decision)
      latestDecisionLineById.set(decision.id, index)
    }
  }

  const decisions = decisionOrder
    .map((id) => decisionsById.get(id))
    .filter((decision): decision is GuidedInterviewDecision => decision !== undefined)

  // The latest question is only "current" while unanswered: a decision for
  // its id that appears after the block clears it.
  let currentQuestion = latestQuestion
  if (currentQuestion) {
    const answeredAt = latestDecisionLineById.get(currentQuestion.id)
    if (answeredAt !== undefined && answeredAt > latestQuestionLine) {
      currentQuestion = null
    }
  }

  return { currentQuestion, decisions, malformedCount }
}

const MAX_BUFFER_CHARS = 64 * 1024
const TRIM_TO_CHARS = 48 * 1024

/**
 * Stateful wrapper over the cumulative parser: feeds raw PTY chunks (replay
 * and live), keeps a bounded buffer, and reports the parsed state after each
 * push. Trimming cuts at a line boundary so a retained fence stays intact;
 * interview traffic is tiny relative to the buffer so a torn fence at the
 * trim edge only ever drops already-superseded history.
 */
export function createGuidedInterviewParser(): {
  push: (chunk: string) => GuidedInterviewState
  state: () => GuidedInterviewState
} {
  let buffer = ''
  let current: GuidedInterviewState = EMPTY_GUIDED_INTERVIEW_STATE

  const push = (chunk: string): GuidedInterviewState => {
    buffer = `${buffer}${chunk}`
    if (buffer.length > MAX_BUFFER_CHARS) {
      const cut = buffer.length - TRIM_TO_CHARS
      const newline = buffer.indexOf('\n', cut)
      buffer = newline >= 0 ? buffer.slice(newline + 1) : buffer.slice(cut)
    }
    current = parseGuidedInterviewOutput(buffer)
    return current
  }

  return { push, state: () => current }
}
