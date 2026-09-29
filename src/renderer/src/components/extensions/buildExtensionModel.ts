// What the build flow writes and says, as pure functions over what the person
// chose — so the brief, the chat's first message and the Create gate are
// tested without a window.

import {
  EXTENSION_BUILDER_SKILL_ID,
  extensionCheckBlocks,
  extensionIdProblem,
  type ExtensionScaffoldCheck,
  type ExtensionTemplateSummary,
} from '../../../../shared/extension-scaffold'

/** The longest idea the chat's first message quotes; the whole of it is in IDEA.md. */
const PROMPT_IDEA_MAX = 160

// A name lands inside the prompt's quotes and a Markdown heading; the
// characters that would break either are dropped, as the scaffolder drops them
// from the files it fills (`sanitizeDisplayText`).
function cleanName(name: string): string {
  return name
    .replace(/\s+/g, ' ')
    .replace(/["`\\{}<>$]/g, '')
    .trim()
}

/** The idea in one line, for a sentence: the person's own words, else the template's. */
export function ideaLine(idea: string, template: Pick<ExtensionTemplateSummary, 'summary'>): string {
  const own = idea.replace(/\s+/g, ' ').trim()
  const line = own || template.summary.trim().replace(/\.$/, '')
  if (line.length <= PROMPT_IDEA_MAX) return line
  return `${line.slice(0, PROMPT_IDEA_MAX - 1).trimEnd()}…`
}

/**
 * The project's IDEA.md: the template's own brief shape (templates/_shared),
 * with the person's idea where the template leaves a blank. The agent reads it
 * first, so it names what the template already asks for and leaves the rest
 * as the questions the agent is told to ask.
 */
export function buildExtensionIdeaMarkdown(input: {
  name: string
  idea: string
  template: Pick<ExtensionTemplateSummary, 'title' | 'summary' | 'permissions'>
}): string {
  const name = cleanName(input.name)
  const idea = input.idea.trim()
  const permissions = input.template.permissions.length
    ? input.template.permissions.map((permission) => `\`${permission}\``).join(', ')
    : 'no permissions'
  return [
    `# ${name}`,
    '',
    `Started from the **${input.template.title}** template: ${input.template.summary.trim()}`,
    '',
    '## What it does',
    '',
    idea || '-',
    '',
    '## What it needs from Studio',
    '',
    `- The template starts with ${permissions}. Keep only what the idea needs.`,
    '- Which surface: a panel, a door in the Extensions drawer, a top-bar control, a',
    '  command, a Backlog or Files action, an MCP tool, an automation trigger, a chat',
    '  it starts?',
    '- Which permissions, and why each one (they are shown to whoever installs it).',
    '',
    '## Out of scope',
    '',
    '-',
    '',
  ].join('\n')
}

/**
 * The chat's first message. It never starts with `-`: a prompt that did would
 * read as a flag to a CLI that takes its first message on the command line.
 */
export function buildExtensionPrompt(input: {
  name: string
  idea: string
  template: Pick<ExtensionTemplateSummary, 'summary'>
}): string {
  return (
    `Use the ${EXTENSION_BUILDER_SKILL_ID} skill. We're building "${cleanName(input.name)}" ` +
    `(${ideaLine(input.idea, input.template)}); the brief is in IDEA.md. ` +
    'First run npm install and npm run check, then ask me up to three questions about what I want ' +
    'before changing code. Keep permissions minimal, build, and side-load it with npm run dev:install ' +
    'so I can try it.'
  )
}

/** Why Create cannot be pressed yet, in the order the form asks; null when it can. */
export function buildExtensionBlocker(input: {
  name: string
  id: string
  folderChosen: boolean
  agentChosen: boolean
  checks: readonly ExtensionScaffoldCheck[] | null
}): string | null {
  if (cleanName(input.name) === '') return 'Name the extension.'
  const idProblem = extensionIdProblem(input.id)
  if (idProblem) return idProblem
  if (!input.folderChosen) return 'Choose where the project goes.'
  if (!input.agentChosen) return 'Choose the agent that builds it with you.'
  if (input.checks === null) return 'Checking this machine…'
  const blocking = input.checks.find(extensionCheckBlocks)
  if (blocking) return `${blocking.label}: ${blocking.detail}`
  return null
}
