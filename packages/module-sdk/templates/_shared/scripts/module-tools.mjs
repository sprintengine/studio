// Helpers the extension dev-loop scripts share (validate.mjs, dev-install.mjs).
//
// The same file ships in a scaffolded project's scripts/ and in the
// sprintengine-extension-builder skill's scripts/, so the skill's copies work
// on any project and the project's own copies work without the skill.
//
// Everything here reads the project's OWN installed @sprintengine/module-sdk,
// never a copy of its rules: the validator, the host API check and the signing
// CLI are the code the app itself runs, so a project these scripts accept is
// one the app accepts.

import { createHash } from 'node:crypto'
import { existsSync, lstatSync, readdirSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const SDK_PACKAGE = '@sprintengine/module-sdk'

/** `--project <dir>` (default: the current folder, which is what `npm run` uses). */
export function projectDirFrom(argv) {
  const index = argv.indexOf('--project')
  return resolve(index === -1 ? process.cwd() : (argv[index + 1] ?? '.'))
}

export function flagValue(argv, name) {
  const index = argv.indexOf(name)
  return index === -1 ? undefined : argv[index + 1]
}

export function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'))
}

/**
 * Where the installable module lives: the folder plugin.json's module
 * component names (`module` in every template). Everything in it is what gets
 * installed, digested and signed; everything outside it is source.
 */
export function moduleDirOf(projectDir) {
  const pluginPath = join(projectDir, 'plugin.json')
  if (existsSync(pluginPath)) {
    const path = readJson(pluginPath)?.components?.module?.path
    if (typeof path === 'string' && path.length > 0) return join(projectDir, path)
  }
  return join(projectDir, 'module')
}

/** The project's installed SDK: its root entry, its signing entry, and its CLI. */
export async function loadSdk(projectDir) {
  const require = createRequire(join(projectDir, 'package.json'))
  let indexPath
  try {
    indexPath = require.resolve(SDK_PACKAGE)
  } catch {
    fail(`${SDK_PACKAGE} is not installed in ${projectDir}. Run \`npm install\` first.`)
  }
  const sdk = await import(pathToFileURL(indexPath).href)
  const signing = await import(pathToFileURL(require.resolve(`${SDK_PACKAGE}/signing`)).href)
  return { sdk, signing, cliPath: join(dirname(indexPath), 'cli.js') }
}

// Paths pack never ships and an installed module may never hold: dependency
// trees, version control, key material.
export function isPackExcludedPath(path) {
  const segments = path.split('/')
  const name = segments[segments.length - 1] ?? ''
  return (
    segments.includes('node_modules') || segments.includes('.git') || name.endsWith('.key') || name.endsWith('.pem')
  )
}

/**
 * sha256 of every file the module ships, keyed by POSIX path relative to the
 * module folder, manifest.json aside (it carries the map). This is the
 * manifest's `files` map: the app will not load a module whose folder does
 * not match it exactly.
 *
 * Uses the SDK's own walk when the installed SDK has one, so this and
 * `sprintengine-module sign` can never disagree. The fallback below is the
 * same rule for an SDK that predates it, and goes away with it.
 */
export function computeFileDigests(moduleDir, signing) {
  if (typeof signing.computeModuleFileDigestsSync === 'function') {
    const result = signing.computeModuleFileDigestsSync(moduleDir, { walk: 'pack' })
    if (!result.ok) fail(`Some files in ${moduleDir} cannot be part of a module:`, result.issues)
    return result.files
  }
  const files = {}
  const issues = []
  const visit = (dir, prefix) => {
    for (const name of readdirSync(dir).sort()) {
      const relativePath = prefix ? `${prefix}/${name}` : name
      if (relativePath === 'manifest.json' || isPackExcludedPath(relativePath)) continue
      const absolutePath = join(dir, name)
      const entry = lstatSync(absolutePath)
      if (entry.isSymbolicLink())
        issues.push({ path: relativePath, message: 'is a symbolic link; a module ships regular files only.' })
      else if (entry.isDirectory()) visit(absolutePath, relativePath)
      else if (entry.isFile())
        files[relativePath] = createHash('sha256').update(readFileSync(absolutePath)).digest('hex')
      else issues.push({ path: relativePath, message: 'is not a regular file.' })
    }
  }
  visit(moduleDir, '')
  if (issues.length > 0) fail(`Some files in ${moduleDir} cannot be part of a module:`, issues)
  return Object.fromEntries(Object.entries(files).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
}

/** Files that differ between two digest maps, as readable lines. */
export function digestDrift(expected, actual) {
  const lines = []
  for (const path of Object.keys(expected)) {
    if (actual[path] === undefined) lines.push(`${path}: listed but missing`)
    else if (actual[path] !== expected[path]) lines.push(`${path}: changed`)
  }
  for (const path of Object.keys(actual)) {
    if (expected[path] === undefined) lines.push(`${path}: not listed`)
  }
  return lines
}

export function printIssues(issues) {
  for (const issue of issues ?? []) {
    console.error(`  - ${issue.path === '' ? 'manifest' : issue.path}: ${issue.message}`)
  }
}

export function fail(message, issues) {
  console.error(message)
  printIssues(issues)
  process.exit(1)
}
