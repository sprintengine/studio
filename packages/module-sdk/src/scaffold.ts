// Scaffold a new extension project from one of the templates this package
// ships (`templates/<id>/`), with the extension-builder skill vendored into it.
//
// Subpath export `@sprintengine/module-sdk/scaffold`. Node-only (it reads and
// writes the file system), so it is kept out of the root index, which must
// stay loadable in a renderer. The `sprintengine-module init` command and the
// app's "Build your own extension" flow both call it, so a project made from
// the command line and one made from the app are the same project.
//
// A template is a folder holding `template.json` (what the picker shows) and
// the project files. `templates/_shared/` holds the files every project gets —
// the dev-loop scripts, the smoke test, the agent instructions — and a
// template's own file of the same path wins over the shared one. Text files
// carry `{{placeholder}}` tokens (see `placeholderValues`), and a file named
// `gitignore` is written as `.gitignore`: npm drops dot-gitignore files from a
// published tarball, so the template cannot ship one under its real name.

import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { BUNDLED_MODULE_IDS } from './index.js'

export type ModuleTemplateInfo = {
  id: string
  title: string
  summary: string
  /** The permissions the template's manifest declares, as the consent prompt will show them. */
  permissions: string[]
  /** What the template contributes or relies on (e.g. 'panel', 'conversations'), for a picker's tags. */
  capabilities: string[]
}

export type ScaffoldModuleOptions = {
  /** The project folder. Created when missing; must be empty unless `force`. */
  dir: string
  templateId: string
  /** The module id: lowercase letters, digits and hyphens, and not a reserved bundled id. */
  id: string
  /**
   * The name people see. Quotes, backslashes, braces, angle brackets, `$` and
   * backticks are dropped and an apostrophe becomes a typographic one (see
   * `sanitizeDisplayText`); an empty result falls back to the id, title-cased.
   */
  displayName: string
  publisher?: string
  /** The SDK version the project depends on, as `^<sdkVersion>`. */
  sdkVersion: string
  /** A local SDK tarball to depend on instead of the npm release; copied into the project's `vendor/`. */
  sdkTarballPath?: string
  /** Defaults to the `templates/` folder beside this package's `dist/`. */
  templatesRoot?: string
  /** Defaults to the `skills/` folder beside this package's `dist/`. */
  skillsRoot?: string
  /** Written as the project's IDEA.md in place of the template's placeholder brief. */
  ideaMarkdown?: string
  /** Scaffold into a folder that already has files in it, overwriting the ones the template writes. */
  force?: boolean
}

export type ScaffoldModuleResult =
  | { ok: true; files: string[] }
  | { ok: false; code: 'unknown_template' | 'invalid_id' | 'dir_not_empty' | 'io_error'; message: string }

/** The skill every scaffolded project carries, for whichever agent works on it. */
export const EXTENSION_BUILDER_SKILL_ID = 'sprintengine-extension-builder'

/** Where a project gets the skill: one copy per agent family's skill directory. */
export const EXTENSION_BUILDER_SKILL_DIRS: readonly string[] = [
  `.claude/skills/${EXTENSION_BUILDER_SKILL_ID}`,
  `.agents/skills/${EXTENSION_BUILDER_SKILL_ID}`,
]

const SHARED_TEMPLATE_DIR = '_shared'
const TEMPLATE_MANIFEST = 'template.json'
const SDK_PACKAGE = '@sprintengine/module-sdk'
const DEFAULT_PUBLISHER = 'Local developer'

// The same id rule the manifest validator applies, so a scaffolded project's
// manifest validates the moment it is written.
const MODULE_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}$/

// The picker order: the empty starting point first, then the surfaces a person
// is most likely to be asking for. A template missing here sorts after these.
const TEMPLATE_ORDER = [
  'blank',
  'panel',
  'global-surface',
  'chat-companion',
  'workspace-type',
  'top-bar-item',
  'settings-section',
  'backlog-action',
  'file-action',
  'mcp-tools',
  'automation-trigger',
]

// dist/scaffold.js (published) and src/scaffold.ts (in the repository) both sit
// one level below the package root, so one relative step finds the folders.
const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

export function defaultTemplatesRoot(): string {
  return join(PACKAGE_ROOT, 'templates')
}

export function defaultSkillsRoot(): string {
  return join(PACKAGE_ROOT, 'skills')
}

/** This package's own version: what a project scaffolded by its CLI depends on. */
export function sdkPackageVersion(): string {
  const pkg = JSON.parse(readFileSync(join(PACKAGE_ROOT, 'package.json'), 'utf8')) as { version?: unknown }
  if (typeof pkg.version !== 'string' || pkg.version === '') {
    throw new Error(`${join(PACKAGE_ROOT, 'package.json')} carries no version.`)
  }
  return pkg.version
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string' && entry.length > 0)
}

function readTemplateInfo(templateDir: string): ModuleTemplateInfo {
  const path = join(templateDir, TEMPLATE_MANIFEST)
  const raw: unknown = JSON.parse(readFileSync(path, 'utf8'))
  const value = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>
  const { id, title, summary, permissions, capabilities } = value
  if (
    typeof id !== 'string' ||
    id !== basename(templateDir) ||
    typeof title !== 'string' ||
    typeof summary !== 'string' ||
    !isStringArray(permissions) ||
    !isStringArray(capabilities)
  ) {
    // A template ships inside this package; a malformed one is a packaging bug,
    // so it fails loudly rather than disappearing from the picker.
    throw new Error(
      `${path} must be { id (the folder name), title, summary, permissions: string[], capabilities: string[] }.`,
    )
  }
  return { id, title, summary, permissions: [...permissions], capabilities: [...capabilities] }
}

function templateDirs(templatesRoot: string): string[] {
  return readdirSync(templatesRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith('_') && !entry.name.startsWith('.'))
    .map((entry) => join(templatesRoot, entry.name))
    .filter((dir) => existsSync(join(dir, TEMPLATE_MANIFEST)))
}

function templateRank(id: string): number {
  const index = TEMPLATE_ORDER.indexOf(id)
  return index === -1 ? TEMPLATE_ORDER.length : index
}

/** Every template under `templatesRoot`, in picker order. */
export function listModuleTemplates(templatesRoot: string = defaultTemplatesRoot()): ModuleTemplateInfo[] {
  return templateDirs(templatesRoot)
    .map(readTemplateInfo)
    .sort((a, b) => templateRank(a.id) - templateRank(b.id) || a.id.localeCompare(b.id))
}

/** Every file under `dir`, as POSIX paths relative to it. */
function walkFiles(dir: string, prefix = ''): string[] {
  const files: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name
    if (entry.isDirectory()) files.push(...walkFiles(join(dir, entry.name), relativePath))
    else if (entry.isFile()) files.push(relativePath)
  }
  return files
}

/** The name a template file is written under in the project. */
function projectPath(templatePath: string): string {
  const segments = templatePath.split('/')
  if (segments[segments.length - 1] === 'gitignore') segments[segments.length - 1] = '.gitignore'
  return segments.join('/')
}

function displayNameFromId(id: string): string {
  return id
    .split('-')
    .filter(Boolean)
    .map((part) => part[0]!.toUpperCase() + part.slice(1))
    .join(' ')
}

// A name lands in JSON strings, TS string and template literals, JSX text and
// attributes, CSS comments and Markdown. Rather than escape it five ways, keep
// it to characters that are literal in all of them: an apostrophe becomes a
// typographic one, and quotes, backslashes, braces, angle brackets, `$`,
// backticks and control characters are dropped.
export function sanitizeDisplayText(value: string): string {
  return value
    .replace(/\s+/g, ' ')
    .replace(/'/g, '\u2019')
    .replace(/["`\\{}<>$\u0000-\u001f\u007f]/g, '')
    .trim()
}

function placeholderValues(options: ScaffoldModuleOptions, template: ModuleTemplateInfo): Record<string, string> {
  return {
    id: options.id,
    displayName: sanitizeDisplayText(options.displayName) || displayNameFromId(options.id),
    publisher: sanitizeDisplayText(options.publisher ?? '') || DEFAULT_PUBLISHER,
    sdkVersion: options.sdkVersion,
    templateId: template.id,
    templateTitle: sanitizeDisplayText(template.title),
  }
}

function fillPlaceholders(text: string, values: Record<string, string>): string {
  return text.replace(/\{\{(\w+)\}\}/g, (token, name: string) => values[name] ?? token)
}

function isEmptyDir(dir: string): boolean {
  return readdirSync(dir).length === 0
}

/**
 * Create an extension project in `options.dir` from a template: the template's
 * files with the module id, name and SDK version filled in, the shared dev-loop
 * files, and the extension-builder skill in `.claude/skills` and
 * `.agents/skills`. Expected failures come back as a result, never a throw.
 */
export async function scaffoldModuleProject(options: ScaffoldModuleOptions): Promise<ScaffoldModuleResult> {
  if (!MODULE_ID_PATTERN.test(options.id)) {
    return {
      ok: false,
      code: 'invalid_id',
      message: `"${options.id}" is not a module id: use lowercase letters, digits and hyphens (1–63 characters), starting with a letter or digit.`,
    }
  }
  if (BUNDLED_MODULE_IDS.includes(options.id)) {
    return {
      ok: false,
      code: 'invalid_id',
      message: `"${options.id}" is reserved for a module that ships with SprintEngine Studio; choose another id.`,
    }
  }

  const templatesRoot = resolve(options.templatesRoot ?? defaultTemplatesRoot())
  const skillsRoot = resolve(options.skillsRoot ?? defaultSkillsRoot())
  const templateDir = join(templatesRoot, options.templateId)
  if (
    options.templateId.startsWith('_') ||
    options.templateId.includes('/') ||
    !existsSync(join(templateDir, TEMPLATE_MANIFEST))
  ) {
    let known: string[] = []
    try {
      known = listModuleTemplates(templatesRoot).map((template) => template.id)
    } catch {
      // The listing is only for the message; the unknown id is the failure.
    }
    return {
      ok: false,
      code: 'unknown_template',
      message: `There is no "${options.templateId}" template${known.length > 0 ? `; the templates are ${known.join(', ')}` : ''}.`,
    }
  }

  const dir = resolve(options.dir)
  try {
    if (existsSync(dir)) {
      if (!statSync(dir).isDirectory()) {
        return { ok: false, code: 'dir_not_empty', message: `${dir} exists and is not a folder.` }
      }
      if (!options.force && !isEmptyDir(dir)) {
        return {
          ok: false,
          code: 'dir_not_empty',
          message: `${dir} already has files in it. Choose an empty folder, or scaffold with force to write over them.`,
        }
      }
    }

    const template = readTemplateInfo(templateDir)
    const values = placeholderValues(options, template)
    const skillDir = join(skillsRoot, EXTENSION_BUILDER_SKILL_ID)
    if (!existsSync(join(skillDir, 'SKILL.md'))) {
      return {
        ok: false,
        code: 'io_error',
        message: `The ${EXTENSION_BUILDER_SKILL_ID} skill is missing from ${skillsRoot}.`,
      }
    }

    // Shared first, template second: a template's file of the same path wins.
    const sources = new Map<string, string>()
    const sharedDir = join(templatesRoot, SHARED_TEMPLATE_DIR)
    if (existsSync(sharedDir)) {
      for (const path of walkFiles(sharedDir)) sources.set(projectPath(path), join(sharedDir, path))
    }
    for (const path of walkFiles(templateDir)) {
      if (path === TEMPLATE_MANIFEST) continue
      sources.set(projectPath(path), join(templateDir, path))
    }

    const written: string[] = []
    const write = (relativePath: string, content: string | Buffer): void => {
      const target = join(dir, relativePath)
      mkdirSync(dirname(target), { recursive: true })
      writeFileSync(target, content)
      written.push(relativePath)
    }

    for (const [relativePath, source] of sources) {
      if (relativePath === 'IDEA.md' && options.ideaMarkdown !== undefined) {
        write(relativePath, options.ideaMarkdown.endsWith('\n') ? options.ideaMarkdown : `${options.ideaMarkdown}\n`)
        continue
      }
      let text = fillPlaceholders(readFileSync(source, 'utf8'), values)
      if (relativePath === 'package.json' && options.sdkTarballPath) {
        text = dependOnTarball(text, `file:vendor/${basename(options.sdkTarballPath)}`)
      }
      write(relativePath, text)
    }

    if (options.sdkTarballPath) {
      const tarball = resolve(options.sdkTarballPath)
      const target = `vendor/${basename(tarball)}`
      mkdirSync(join(dir, 'vendor'), { recursive: true })
      copyFileSync(tarball, join(dir, target))
      written.push(target)
    }

    for (const skillTarget of EXTENSION_BUILDER_SKILL_DIRS) {
      for (const path of walkFiles(skillDir)) {
        write(`${skillTarget}/${path}`, readFileSync(join(skillDir, path)))
      }
    }

    return { ok: true, files: written.sort() }
  } catch (error) {
    return {
      ok: false,
      code: 'io_error',
      message: `Could not scaffold into ${dir}: ${error instanceof Error ? error.message : String(error)}`,
    }
  }
}

function dependOnTarball(packageJson: string, spec: string): string {
  const pkg = JSON.parse(packageJson) as { devDependencies?: Record<string, string> }
  pkg.devDependencies = { ...pkg.devDependencies, [SDK_PACKAGE]: spec }
  return `${JSON.stringify(pkg, null, 2)}\n`
}
