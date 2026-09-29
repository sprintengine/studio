#!/usr/bin/env node
// Side-load the built module into SprintEngine Studio on this machine.
//
//   node scripts/dev-install.mjs [--project <dir>] [--key <private-key.pem>] [--no-sign]
//
// Run it after `npm run build` (`npm run dev:install` does both). It:
//
// 1. validates module/manifest.json with the SDK's validator and host API check;
// 2. writes the manifest's `files` map — the sha256 of every file in module/,
//    manifest.json aside. The app holds an installed module to exactly those
//    bytes and will not load one without them;
// 3. signs the manifest when a key is at hand (--key, $SPRINTENGINE_SIGNING_KEY,
//    or ~/.sprintengine/keys/<id>.key), so what you try is what you would ship.
//    With no key the module installs unsigned and Studio asks you to trust it;
// 4. copies module/ into $SPRINTENGINE_USER_MODULE_ROOT (default
//    ~/.sprintengine/modules)/<id>, swapping the old copy out in one step.
//
// Every rebuild changes the digests, and trust is granted to exact contents,
// so Studio asks again after each install — see the skill's pitfalls.md.
//
// Step 2 stands in for the SDK CLI's own digest writing: once the installed
// SDK's `sprintengine-module sign` records `files` itself (and exports
// computeModuleFileDigestsSync), signing rewrites the same map and this script
// defers to it.

import { spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, join, relative } from 'node:path'

import {
  computeFileDigests,
  digestDrift,
  fail,
  flagValue,
  isPackExcludedPath,
  loadSdk,
  moduleDirOf,
  projectDirFrom,
  readJson,
} from './module-tools.mjs'

const argv = process.argv.slice(2)
const projectDir = projectDirFrom(argv)
const moduleDir = moduleDirOf(projectDir)
const manifestPath = join(moduleDir, 'manifest.json')
const { sdk, signing, cliPath } = await loadSdk(projectDir)

if (!existsSync(manifestPath)) fail(`No module manifest at ${relative(projectDir, manifestPath)}.`)

// ── 1. Validate ──────────────────────────────────────────────────────────────

let raw = readJson(manifestPath)
const validated = sdk.validateThirdPartyModuleManifest(raw)
if (!validated.ok) fail(`${relative(projectDir, manifestPath)} is not a valid module manifest:`, validated.issues)
const { id } = validated.manifest
const hostApi = sdk.checkHostApiCompatibility({ ...raw, source: 'third-party' })
if (!hostApi.ok) fail(hostApi.message)
for (const [key, path] of Object.entries(validated.manifest.entry ?? {})) {
  if (!existsSync(join(moduleDir, path))) fail(`entry.${key} (${path}) does not exist. Run \`npm run build\` first.`)
}

// ── 2. Record the file digests ───────────────────────────────────────────────

const files = computeFileDigests(moduleDir, signing)
const digestsChanged = digestDrift(raw.files ?? {}, files).length > 0 || raw.files === undefined

// ── 3. Sign, when there is a key ─────────────────────────────────────────────

const defaultKey = join(homedir(), '.sprintengine', 'keys', `${id}.key`)
const keyPath = argv.includes('--no-sign')
  ? undefined
  : (flagValue(argv, '--key') ??
    process.env.SPRINTENGINE_SIGNING_KEY ??
    (existsSync(defaultKey) ? defaultKey : undefined))

const writeManifest = (value) => writeFileSync(manifestPath, `${JSON.stringify(value, null, 2)}\n`)

if (keyPath === undefined && raw.signature && digestsChanged) {
  // A signature over the old files would read as tampered, which the app
  // refuses outright; an unsigned module can at least be trusted by hand.
  console.warn(
    'warning: the module changed since it was signed and there is no key to sign it again; installing it unsigned.',
  )
  const { signature: _stale, ...unsigned } = raw
  raw = unsigned
}
writeManifest({ ...raw, files })

if (keyPath !== undefined) {
  if (!existsSync(keyPath)) fail(`Signing key not found: ${keyPath}`)
  const signed = spawnSync(process.execPath, [cliPath, 'sign', moduleDir, '--key', keyPath], { stdio: 'inherit' })
  if (signed.status !== 0) fail('Signing failed (see above).')
  const after = readJson(manifestPath)
  if (after.files === undefined) {
    // An SDK whose sign normalizes `files` away predates code digests; the app
    // will not trust what it signed. Say so rather than install it quietly.
    fail(
      'This @sprintengine/module-sdk signs without file digests, and the app will not trust a module signed that way. ' +
        'Update the SDK (`npm install @sprintengine/module-sdk@latest`), or install unsigned with --no-sign.',
    )
  }
  if (after.engines?.hostApi === undefined && raw.engines?.hostApi !== undefined) {
    fail(
      'This @sprintengine/module-sdk signs without "engines.hostApi", and the app refuses a module without it. Update the SDK.',
    )
  }
}

// ── 4. Install ───────────────────────────────────────────────────────────────

const modulesRoot = process.env.SPRINTENGINE_USER_MODULE_ROOT ?? join(homedir(), '.sprintengine', 'modules')
const dest = join(modulesRoot, id)
const staging = join(modulesRoot, `.${id}.installing-${process.pid}`)
mkdirSync(modulesRoot, { recursive: true })
rmSync(staging, { recursive: true, force: true })
cpSync(moduleDir, staging, {
  recursive: true,
  filter: (source) => !isPackExcludedPath(relative(moduleDir, source).split('\\').join('/')),
})

// What landed must be exactly what the manifest lists, or the app refuses it.
const installed = readJson(join(staging, 'manifest.json'))
const drift = digestDrift(installed.files ?? {}, computeFileDigests(staging, signing))
if (drift.length > 0) {
  rmSync(staging, { recursive: true, force: true })
  fail(
    `The installed copy does not match its "files" digests (did something write to module/ meanwhile?):\n  ${drift.join('\n  ')}`,
  )
}

rmSync(dest, { recursive: true, force: true })
renameSync(staging, dest)

const signedNote = installed.signature ? 'signed' : 'unsigned'
console.log(
  `Installed ${id} v${installed.version} (${signedNote}, ${Object.keys(installed.files).length} file(s)) at ${dest}`,
)
console.log('')
console.log(
  `Next, in SprintEngine Studio: Settings → Modules → ${basename(dest)} → trust it (it asks again after every rebuild).`,
)
if (installed.entry?.main) {
  console.log('This module has an entry.main: restart Studio to load the new build.')
} else {
  console.log(
    'Renderer-only: a first install starts as soon as you trust it; restart to pick up a rebuild of code already loaded.',
  )
}
