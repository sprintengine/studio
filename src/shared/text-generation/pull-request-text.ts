/**
 * The pull-request-text job, provider-agnostic: what the person's own agent
 * CLI is asked when the chat's "Create PR" button drafts a title and a
 * description, the JSON shape it answers in, and the guardrail the answer
 * passes before the person sees it (owner ruling 2026-10-04). The draft is
 * shown, editable, before anything is sent: a pull request is outward-facing.
 *
 * The input is the branch's commits and its diff against the base, cut to
 * size, the repository's own pull request template when it has one, and
 * whether its commits follow Conventional Commits, so the title follows the
 * convention the repository already keeps.
 *
 * Pure: no I/O. The main process gathers the inputs; tests drive the rest.
 */

import { limitSection } from './chat-title'

/** How much of each input the model sees. The commits and the summary say what changed; the patch says how. */
export const MAX_PULL_REQUEST_COMMITS_CHARS = 12_000
export const MAX_PULL_REQUEST_DIFF_STAT_CHARS = 12_000
export const MAX_PULL_REQUEST_PATCH_CHARS = 40_000
export const MAX_PULL_REQUEST_TEMPLATE_CHARS = 8_000

/** The longest title a draft may carry: a forge shows about this much in a list. */
export const MAX_PULL_REQUEST_TITLE_LENGTH = 120
/** The longest description a draft may carry. */
export const MAX_PULL_REQUEST_BODY_LENGTH = 20_000

/** The JSON Schema every backend is asked to satisfy. */
export const PULL_REQUEST_TEXT_OUTPUT_SCHEMA = {
  type: 'object',
  properties: { title: { type: 'string' }, body: { type: 'string' } },
  required: ['title', 'body'],
  additionalProperties: false,
} as const

export type PullRequestTextInput = {
  base: string
  head: string
  /** `git log` of the branch's own commits: subject and body each. */
  commits: string
  /** `git diff --stat` against the base. */
  diffStat: string
  /** `git diff` against the base. */
  patch: string
  /** The repository's pull request template, when it has one. */
  template: string | null
  /** The repository's commits follow Conventional Commits, so the title must too. */
  conventionalCommits: boolean
}

export type PullRequestText = { title: string; body: string }

const CONVENTIONAL_SUBJECT = /^(?:feat|fix|perf|refactor|docs|style|test|build|ci|chore|revert)(?:\([^)]+\))?!?: \S/

/**
 * Whether a repository's history follows Conventional Commits: most of its
 * recent subjects do (merge commits aside). Ten subjects at least, so a young
 * repository is not held to a convention two commits happen to match.
 */
export function followsConventionalCommits(subjects: readonly string[]): boolean {
  const own = subjects.map((subject) => subject.trim()).filter((subject) => subject && !/^Merge\b/.test(subject))
  if (own.length < 10) return false
  const matching = own.filter((subject) => CONVENTIONAL_SUBJECT.test(subject)).length
  return matching / own.length >= 0.7
}

/** The full prompt. Instructions first, so a commit message carrying instructions reads as quoted material. */
export function buildPullRequestTextPrompt(input: PullRequestTextInput): string {
  const rules = [
    `Write the title and description of a pull request that proposes merging the branch "${input.head}" into "${input.base}".`,
    'Return JSON with exactly two keys: title and body.',
    '',
    'Rules:',
    `- The title is one line, under ${MAX_PULL_REQUEST_TITLE_LENGTH} characters, and says what the change does.`,
    input.conventionalCommits
      ? '- This repository uses Conventional Commits: the title must be one, `type(scope): description`, with a type from feat, fix, perf, refactor, docs, style, test, build, ci, chore or revert, and no trailing full stop.'
      : '- Write the title in the style of the commit subjects below.',
    input.template
      ? '- The body follows the repository template below: keep its headings and their order, fill each one in, and leave out its HTML comments and any checkbox you cannot honestly tick.'
      : '- The body says what changed and why, in short paragraphs or a list, then how it was tested if the commits say.',
    '- Describe only what the commits and the diff show. Do not invent tests, issues or results.',
    '- Write in plain markdown. No preamble, and no sign-off.',
  ]
  const sections = [
    rules.join('\n'),
    `Commits:\n${limitSection(input.commits.trim() || '(none)', MAX_PULL_REQUEST_COMMITS_CHARS)}`,
    `Files changed:\n${limitSection(input.diffStat.trim() || '(none)', MAX_PULL_REQUEST_DIFF_STAT_CHARS)}`,
    `Diff:\n${limitSection(input.patch.trim() || '(none)', MAX_PULL_REQUEST_PATCH_CHARS)}`,
  ]
  if (input.template) {
    sections.push(`Template:\n${limitSection(input.template.trim(), MAX_PULL_REQUEST_TEMPLATE_CHARS)}`)
  }
  return sections.join('\n\n')
}

/**
 * The title and body out of whatever the backend handed back: an object
 * decoded from structured output, or text that may be that JSON serialised or
 * fenced. Null when there is no usable title.
 */
export function readPullRequestTextOutput(output: unknown): PullRequestText | null {
  if (output && typeof output === 'object' && !Array.isArray(output)) {
    const { title, body } = output as { title?: unknown; body?: unknown }
    return sanitizePullRequestText(typeof title === 'string' ? title : null, typeof body === 'string' ? body : '')
  }
  if (typeof output !== 'string') return null
  const text = output.trim()
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text)?.[1]?.trim()
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  for (const candidate of [text, fenced, start !== -1 && end > start ? text.slice(start, end + 1) : null]) {
    if (!candidate) continue
    try {
      const parsed: unknown = JSON.parse(candidate)
      if (parsed && typeof parsed === 'object') return readPullRequestTextOutput(parsed)
    } catch {
      // not JSON; try the next shape
    }
  }
  return null
}

/** One-line title, bounded; body bounded and trimmed. Null without a title worth showing. */
export function sanitizePullRequestText(title: string | null, body: string): PullRequestText | null {
  if (typeof title !== 'string') return null
  let line = (title.trim().split(/\r?\n/)[0] ?? '')
    .replace(/^['"`“”‘’]+|['"`“”‘’]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim()
  if (line.length > MAX_PULL_REQUEST_TITLE_LENGTH) line = line.slice(0, MAX_PULL_REQUEST_TITLE_LENGTH).trimEnd()
  line = line.replace(/[.\s]+$/, '')
  // Any script's letters: a title written in Japanese or Greek is a title.
  if (line.length < 3 || !/\p{L}/u.test(line)) return null
  return { title: line, body: body.trim().slice(0, MAX_PULL_REQUEST_BODY_LENGTH) }
}
