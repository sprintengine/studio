// "Build an extension" (the New chat door's extension mode): the wire shapes
// between the door and main, which scaffolds the project from the SDK's own
// templates (packages/module-sdk/src/scaffold.ts). Renderer-safe: types and
// pure helpers only.

import { BUNDLED_MODULE_IDS } from './modules/manifest'

/** The skill every scaffolded project carries, and the one its chat opens with. */
export const EXTENSION_BUILDER_SKILL_ID = 'sprintengine-extension-builder'

/**
 * The template every project starts from. The person describes the extension
 * in their own words, and the skill has the agent add the surfaces that needs
 * (its "Which surface" table), so the start is the smallest project that runs.
 */
export const EXTENSION_START_TEMPLATE_ID = 'blank'

/**
 * What is at `<parentDir>/<id>` right now, asked while the name is typed:
 * `free` (nothing there, or an empty folder), `extension` (a project with a
 * module manifest, which the chat opens and carries on), `taken` (anything
 * else, which is never written over), or `no_parent` (the project folder is
 * gone or not a folder).
 */
export type ExtensionScaffoldTargetState = 'free' | 'extension' | 'taken' | 'no_parent'

export type ExtensionScaffoldTargetInput = {
  /** The project the door is on; the extension's own folder is made inside it. */
  parentDir: string
  /** The extension's name as the chip holds it: the folder name and the module id. */
  id: string
}

export type ExtensionScaffoldTarget = { state: ExtensionScaffoldTargetState; folder: string }

export type ExtensionScaffoldCreateInput = ExtensionScaffoldTargetInput & {
  /** Written as the project's IDEA.md in place of the template's placeholder. */
  ideaMarkdown?: string
}

export type ExtensionScaffoldCreateResult =
  /** `existing`: the folder already held an extension, and nothing was written. */
  | { ok: true; folder: string; existing: boolean }
  | {
      ok: false
      code: 'invalid_input' | 'invalid_id' | 'no_parent' | 'dir_not_empty' | 'unknown_template' | 'io_error'
      message: string
    }

/**
 * A module id from a name as a person types it: lowercase letters, digits and
 * single hyphens, at most 63 characters — the rule the manifest validator
 * applies. Empty when nothing usable is left.
 *
 * `typing` keeps one trailing hyphen, so "pr " can become "pr-radar" one key
 * at a time rather than having its separator taken away under the caret.
 */
export function extensionIdFromName(name: string, options: { typing?: boolean } = {}): string {
  const id = name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+/g, '')
    .slice(0, 63)
  return options.typing ? id : id.replace(/-+$/g, '')
}

/**
 * Why an id cannot be used, or null when it can: the rule the SDK's
 * scaffolder and manifest validator hold an id to, said before the press
 * rather than after it.
 */
export function extensionIdProblem(id: string): string | null {
  if (id === '') return 'Name the extension.'
  if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(id) || id.endsWith('-')) {
    return 'Use lowercase letters, digits and hyphens, starting with a letter or digit.'
  }
  if (BUNDLED_MODULE_IDS.includes(id)) return `"${id}" belongs to a part of the studio; choose another name.`
  return null
}

/** The name a person reads, from the id: "pr-radar" is "Pr radar". The agent can change it in the manifest. */
export function extensionDisplayName(id: string): string {
  const words = id.split('-').filter(Boolean).join(' ')
  return words.charAt(0).toUpperCase() + words.slice(1)
}

/**
 * The project's IDEA.md, from the message the chat opens with: the person's
 * words as they sent them, and the questions the template's own brief leaves
 * open (templates/_shared/IDEA.md). The agent reads it first, and a later
 * session in the same project has the brief without the chat.
 */
export function extensionBriefMarkdown(id: string, request: string): string {
  const quoted = request
    .trim()
    .split(/\r?\n/)
    .map((line) => (line.trim() ? `> ${line}` : '>'))
    .join('\n')
  return [
    `# ${extensionDisplayName(id)}`,
    '',
    'What the person asked for, in their words:',
    '',
    quoted || '> -',
    '',
    '## What it needs from Studio',
    '',
    '- Which surface: a panel, a door in the Extensions drawer, a top-bar control, a',
    '  command, a Backlog or Files action, an MCP tool, a scheduled agent, a chat it',
    '  starts?',
    '- Which permissions, and why each one (they are shown to whoever installs it).',
    '',
    '## Out of scope',
    '',
    '-',
    '',
  ].join('\n')
}
