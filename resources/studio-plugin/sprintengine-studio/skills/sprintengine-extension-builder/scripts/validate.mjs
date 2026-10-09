#!/usr/bin/env node
// Check an extension project the way SprintEngine Studio will check it.
//
//   node scripts/validate.mjs [--project <dir>]
//
// - module/manifest.json through the SDK's own validator, plus the host API
//   check (`engines.hostApi`), reserved ids, unknown permissions and missing
//   entry files;
// - plugin.json (the bundle a GitHub or marketplace install reads) through the
//   SDK's plugin validator, and against the module manifest: same id, same
//   version, the same permissions — the installer refuses a module that
//   declares more than its bundle disclosed;
// - the manifest's `files` digests against the module folder, when it has them
//   (stale digests are an error on a signed manifest, a warning otherwise:
//   dev:install rewrites them on every install);
// - no key material anywhere in the project;
// - the extension-builder skill kept once: `.claude/skills/<id>/SKILL.md`
//   points at `.agents/skills/<id>/` with the same name and description (or,
//   in a project from before the pointer, the two full copies are identical);
// - and, when either manifest is signed, `sprintengine-module verify` /
//   `plugin verify`, the exact checks the app runs.
//
// Exit 1 on anything the app would refuse; warnings alone exit 0.

import { spawnSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'

import {
  computeFileDigests,
  digestDrift,
  loadSdk,
  moduleDirOf,
  printIssues,
  projectDirFrom,
  readJson,
} from './module-tools.mjs'

const projectDir = projectDirFrom(process.argv.slice(2))
const moduleDir = moduleDirOf(projectDir)
const manifestPath = join(moduleDir, 'manifest.json')
const pluginPath = join(projectDir, 'plugin.json')
const { sdk, signing, cliPath } = await loadSdk(projectDir)

const errors = []
const warnings = []

// ── Module manifest ──────────────────────────────────────────────────────────

if (!existsSync(manifestPath)) {
  console.error(`No module manifest at ${relative(projectDir, manifestPath)}.`)
  process.exit(1)
}
const rawManifest = readJson(manifestPath)
const validated = sdk.validateThirdPartyModuleManifest(rawManifest)
if (!validated.ok) {
  console.error(`${relative(projectDir, manifestPath)} is not a valid module manifest:`)
  printIssues(validated.issues)
  process.exit(1)
}
const manifest = validated.manifest

const hostApi = sdk.checkHostApiCompatibility({ ...rawManifest, source: 'third-party' })
if (!hostApi.ok) errors.push(`engines.hostApi: ${hostApi.message}`)
if (sdk.BUNDLED_MODULE_IDS.includes(manifest.id)) {
  errors.push(`id "${manifest.id}" is reserved for a module that ships with SprintEngine Studio; choose another.`)
}
for (const permission of manifest.permissions ?? []) {
  if (!sdk.KNOWN_CAPABILITY_PERMISSIONS.includes(permission)) {
    warnings.push(
      `permission "${permission}" is not one this SDK knows; the consent prompt will show it as unrecognized.`,
    )
  }
}
if (!manifest.entry?.main && !manifest.entry?.renderer) {
  warnings.push('the manifest declares no entry.main or entry.renderer, so the module runs no code.')
}
for (const [key, path] of Object.entries(manifest.entry ?? {})) {
  if (!existsSync(join(moduleDir, path)))
    errors.push(`entry.${key}: ${path} does not exist yet. Run \`npm run build\`.`)
}

// The digest map is what lets the app load the module at all: it holds the
// folder to exactly these bytes. `npm run dev:install` (or `sprintengine-module
// sign`) writes it; until then, say so without failing a fresh project.
if (rawManifest.files === undefined) {
  warnings.push(
    'the manifest has no "files" digests yet; `npm run dev:install` (or `sprintengine-module sign`) writes them.',
  )
} else {
  const drift = digestDrift(rawManifest.files, computeFileDigests(moduleDir, signing))
  if (drift.length > 0 && rawManifest.signature) {
    errors.push(
      `module/ changed after it was signed, so the app would refuse it as tampered; sign it again ` +
        `(\`npm run dev:install\` with your key, or \`sprintengine-module sign\`):\n      ${drift.join('\n      ')}`,
    )
  } else if (drift.length > 0) {
    // Normal between rebuilds: dev:install rewrites the map. It matters when
    // the repository is what gets installed, so say that.
    warnings.push(
      `module/ changed since its "files" digests were written; \`npm run dev:install\` rewrites them. ` +
        `Commit the rewritten manifest before you publish, or an install from GitHub refuses the module as tampered:` +
        `\n      ${drift.join('\n      ')}`,
    )
  }
}

// ── Plugin bundle ────────────────────────────────────────────────────────────

if (!existsSync(pluginPath)) {
  warnings.push(
    'no plugin.json at the project root, so the project cannot be installed from GitHub or the marketplace.',
  )
} else {
  const plugin = sdk.validateMarketplacePluginAuthoringManifest(readJson(pluginPath))
  if (!plugin.ok) {
    console.error('plugin.json is not a valid plugin bundle manifest:')
    printIssues(plugin.issues)
    process.exit(1)
  }
  const bundle = plugin.manifest
  if (bundle.id !== manifest.id) errors.push(`plugin.json id "${bundle.id}" must equal the module id "${manifest.id}".`)
  if (bundle.version !== manifest.version) {
    errors.push(`plugin.json version ${bundle.version} must equal the module version ${manifest.version}.`)
  }
  const disclosed = new Set(bundle.permissions)
  const undisclosed = (manifest.permissions ?? []).filter((permission) => !disclosed.has(permission))
  if (undisclosed.length > 0) {
    errors.push(`plugin.json must disclose every permission the module declares; missing: ${undisclosed.join(', ')}.`)
  }
  if (!bundle.components.module) errors.push('plugin.json must declare a "module" component.')
}

// ── Key material ─────────────────────────────────────────────────────────────

const keyFiles = []
const findKeys = (dir) => {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '.git') continue
    const path = join(dir, entry.name)
    if (entry.isDirectory()) findKeys(path)
    else if (entry.name.endsWith('.key') || entry.name.endsWith('.pem')) keyFiles.push(relative(projectDir, path))
  }
}
findKeys(projectDir)
if (keyFiles.length > 0) {
  errors.push(
    `key material in the project (${keyFiles.join(', ')}). Keep signing keys in ~/.sprintengine/keys, never in a repository.`,
  )
}

// ── The extension-builder skill ──────────────────────────────────────────────

// The project keeps the skill once, in .agents/skills/<id>/, which every agent
// CLI can read; .claude/skills/<id>/SKILL.md is a pointer to it carrying the
// same name and description, so Claude Code finds it by the same trigger.
const SKILL_ID = 'sprintengine-extension-builder'
// The line `sprintengine-module init` writes into the pointer.
const SKILL_POINTER_MARK = '<!-- sprintengine-module: skill pointer -->'
const skillCopy = join(projectDir, '.agents', 'skills', SKILL_ID)
const skillPointer = join(projectDir, '.claude', 'skills', SKILL_ID)
const frontMatter = (path) => {
  const match = /^---\n([\s\S]*?)\n---/.exec(readFileSync(path, 'utf8').replace(/\r\n/g, '\n'))
  const field = (name) => new RegExp(`^${name}:\\s*(.*)$`, 'm').exec(match?.[1] ?? '')?.[1]?.trim()
  return { name: field('name'), description: field('description') }
}
const listFiles = (dir, prefix = '') =>
  readdirSync(join(dir, prefix), { withFileTypes: true }).flatMap((entry) => {
    const path = prefix ? `${prefix}/${entry.name}` : entry.name
    return entry.isDirectory() ? listFiles(dir, path) : [path]
  })
if (existsSync(join(skillCopy, 'SKILL.md')) && existsSync(join(skillPointer, 'SKILL.md'))) {
  const pointerText = readFileSync(join(skillPointer, 'SKILL.md'), 'utf8')
  if (pointerText.includes(SKILL_POINTER_MARK)) {
    const canonical = frontMatter(join(skillCopy, 'SKILL.md'))
    const pointer = frontMatter(join(skillPointer, 'SKILL.md'))
    if (canonical.name !== pointer.name || canonical.description !== pointer.description) {
      errors.push(
        `.claude/skills/${SKILL_ID}/SKILL.md must carry the name and description of .agents/skills/${SKILL_ID}/SKILL.md, ` +
          'so both agent CLIs pick the skill up for the same requests; copy the front matter over.',
      )
    }
  } else {
    // Two full copies (a project scaffolded before the pointer): they must not drift.
    const differing = [...new Set([...listFiles(skillCopy), ...listFiles(skillPointer)])].filter((path) => {
      const a = join(skillCopy, path)
      const b = join(skillPointer, path)
      return !existsSync(a) || !existsSync(b) || readFileSync(a, 'utf8') !== readFileSync(b, 'utf8')
    })
    if (differing.length > 0) {
      errors.push(
        `the two copies of the ${SKILL_ID} skill have drifted (${differing.join(', ')}). Keep .agents/skills/${SKILL_ID} ` +
          `and replace .claude/skills/${SKILL_ID} with a pointer to it (\`sprintengine-module init\` writes one).`,
      )
    }
  }
}

// ── Signatures: the app's own checks, through the SDK CLI ────────────────────

const runCli = (args) =>
  spawnSync(process.execPath, [cliPath, ...args], { cwd: projectDir, stdio: 'inherit' }).status === 0
if (rawManifest.signature && errors.length === 0 && !runCli(['verify', relative(projectDir, moduleDir) || '.'])) {
  errors.push('`sprintengine-module verify` refused the module (see above).')
}
if (
  existsSync(pluginPath) &&
  readJson(pluginPath).signature &&
  errors.length === 0 &&
  !runCli(['plugin', 'verify', '.'])
) {
  errors.push('`sprintengine-module plugin verify` refused plugin.json (see above).')
}

for (const warning of warnings) console.warn(`warning: ${warning}`)
if (errors.length > 0) {
  for (const error of errors) console.error(`error: ${error}`)
  process.exit(1)
}
console.log(
  `${manifest.id}: valid (host API ${rawManifest.engines?.hostApi}, ${manifest.permissions?.length ?? 0} permission(s)` +
    `${rawManifest.signature ? ', signed' : ', unsigned'}).`,
)
