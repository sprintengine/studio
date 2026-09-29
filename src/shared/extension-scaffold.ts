// "Build your own extension": the wire shapes between the Extensions home's
// build flow and main, which scaffolds the project from the SDK's own
// templates (packages/module-sdk/src/scaffold.ts) and checks the machine can
// build it. Renderer-safe: types and pure helpers only.

import { BUNDLED_MODULE_IDS } from './modules/manifest'

/** The skill every scaffolded project carries, and the one its chat opens with. */
export const EXTENSION_BUILDER_SKILL_ID = 'sprintengine-extension-builder'

/**
 * The Node.js a scaffolded project's scripts need: the templates' smoke test
 * loads the built bundles through `module.registerHooks`, which arrived in
 * 22.15 (the templates' own `engines.node`).
 */
export const EXTENSION_MIN_NODE_VERSION: readonly [number, number] = [22, 15]

/** A template, as the build flow's idea picker lists it. */
export type ExtensionTemplateSummary = {
  id: string
  title: string
  summary: string
  /** The permissions its manifest declares, as the install prompt will show them. */
  permissions: string[]
  /** What it contributes or relies on ('panel', 'conversations', …). */
  capabilities: string[]
}

/**
 * A folder the person picked in a dialog main showed. The token is what makes
 * the path usable by `create`: a renderer cannot name a folder the person did
 * not choose.
 */
export type ExtensionScaffoldFolderPick = { path: string; token: string }

export type ExtensionScaffoldCheckId = 'node' | 'npm' | 'git' | 'agent'

/**
 * One thing the machine needs. `required` checks that come back `missing` or
 * `outdated` hold the Create button; `unknown` never does, because a probe that
 * could not answer is not a verdict.
 */
export type ExtensionScaffoldCheck = {
  id: ExtensionScaffoldCheckId
  label: string
  status: 'ok' | 'missing' | 'outdated' | 'unknown'
  required: boolean
  /** The version found, or what to do about it, in a sentence. */
  detail: string
}

export type ExtensionScaffoldCheckInput = {
  /** The agent CLI the chat will run on. Absent: no agent check. */
  cli?: string
}

export type ExtensionScaffoldCreateInput = {
  templateId: string
  /** The module id, and the project folder's name under `parentDir`. */
  id: string
  displayName: string
  /** A folder from `extensions:scaffold:pick-folder`, with the token it came with. */
  parentDir: string
  parentDirToken: string
  /** Written as the project's IDEA.md in place of the template's placeholder. */
  ideaMarkdown?: string
}

export type ExtensionScaffoldCreateResult =
  | { ok: true; folder: string; files: string[] }
  | {
      ok: false
      code: 'invalid_input' | 'folder_not_picked' | 'unknown_template' | 'invalid_id' | 'dir_not_empty' | 'io_error'
      message: string
    }

/** Whether a failed required check holds the build back. */
export function extensionCheckBlocks(check: ExtensionScaffoldCheck): boolean {
  return check.required && (check.status === 'missing' || check.status === 'outdated')
}

/**
 * A module id from a name as a person types it: lowercase letters, digits and
 * single hyphens, at most 63 characters — the rule the manifest validator
 * applies. Empty when nothing usable is left.
 */
export function extensionIdFromName(name: string): string {
  return name
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 63)
    .replace(/-+$/g, '')
}

/**
 * Why an id cannot be used, or null when it can: the rule the SDK's
 * scaffolder and manifest validator hold an id to, said before the press
 * rather than after it.
 */
export function extensionIdProblem(id: string): string | null {
  if (id === '') return 'Give the extension an id.'
  if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(id)) {
    return 'Use lowercase letters, digits and hyphens, starting with a letter or digit.'
  }
  if (BUNDLED_MODULE_IDS.includes(id)) return `"${id}" belongs to a part of the studio; choose another id.`
  return null
}
