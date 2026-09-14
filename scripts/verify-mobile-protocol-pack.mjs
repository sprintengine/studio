#!/usr/bin/env node
// Acceptance check for @sprintengine/mobile-control-protocol.
//
// The package exists so the desktop and the phone stop keeping two copies of
// the wire schema. That only holds if the published tarball is loadable by
// both, and the two load it differently: the desktop bundles ESM, while the
// phone's regression suite compiles to CommonJS and `require`s it. Either half
// can break while the other stays green, so both are checked here against the
// actual tarball rather than against the source tree.
//
// 1. The package builds and `npm pack` produces a tarball.
// 2. The tarball ships every file its `exports` map names.
// 3. The published declarations contain no `any` outside comments.
// 4. The package major equals `mobileControlProtocolVersion` (docs/compatibility.md).
// 5. A consumer compiled with the phone's `Node16` settings type-checks against
//    the tarball, and both its CommonJS and its ESM entry point run.
// 6. Every runtime validator is present in both builds — types alone would
//    satisfy every step above while leaving the phone with no validation.

import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { existsSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const repoRoot = process.cwd()
const packageDir = join(repoRoot, 'packages', 'mobile-control-protocol')
const fixtureDir = join(packageDir, 'test-fixtures', 'consumer')

// Named individually rather than discovered, so deleting an export is a failure
// here instead of a silently shorter list. These are the functions a peer's
// payload is refused by; a build that ships the types without them compiles
// everywhere and validates nothing.
const RUNTIME_EXPORTS = [
  'isSupportedMobileControlProtocolVersion',
  'unsupportedMobileControlProtocolVersion',
  'validateMobileControlCommand',
  'validateMobileControlEvent',
  'validateMobileControlSnapshot',
  'validateMobileControlDevice',
  'validateMobileControlCapabilities',
  'validateMobileControlError',
  'mobileControlProtocolVersion',
  'mobileControlSupportedProtocolVersions',
  'mobileControlMinSupportedProtocolVersion',
]

const run = (command, args, cwd) => {
  console.log(`$ ${command} ${args.join(' ')}`)
  execFileSync(command, args, { cwd, stdio: 'inherit' })
}

run('node', ['build.mjs'], packageDir)

// Both are wiped, not refreshed. npm sees a same-version tarball as "up to
// date" and leaves the previous install in place, so every run after the first
// would check a build that is no longer the one on disk — a check that passes
// because it is looking at last week's tarball is worse than no check.
rmSync(join(fixtureDir, 'out'), { recursive: true, force: true })
rmSync(join(fixtureDir, 'node_modules'), { recursive: true, force: true })

const packOutput = execFileSync('npm', ['pack', '--pack-destination', 'test-fixtures'], { cwd: packageDir })
  .toString('utf8')
  .trim()
const tarball = packOutput.split('\n').at(-1)
if (!tarball?.endsWith('.tgz')) {
  throw new Error(`npm pack did not report a tarball (got "${tarball}").`)
}
console.log(`packed ${tarball}`)

run('npm', ['install', '--no-save', '--no-package-lock', '--no-audit', '--no-fund', `../${tarball}`], fixtureDir)

const installedDir = join(fixtureDir, 'node_modules', '@sprintengine', 'mobile-control-protocol')
const manifest = JSON.parse(readFileSync(join(installedDir, 'package.json'), 'utf8'))

// Walk the exports map as Node does, so a condition pointing at a file the
// tarball forgot to ship is caught here and not on the phone. Each condition
// must carry its own `types` as well as its `default`: the two builds are
// different module kinds, and one set of declarations serving both would be
// lying to whichever half it was not generated for.
for (const condition of ['import', 'require']) {
  const entry = manifest.exports['.'][condition]
  for (const key of ['types', 'default']) {
    const relative = entry?.[key]
    if (typeof relative !== 'string') {
      throw new Error(`exports["."].${condition} has no "${key}".`)
    }
    if (!existsSync(join(installedDir, relative))) {
      throw new Error(`exports["."].${condition}.${key} names ${relative}, which the tarball does not ship.`)
    }
  }
}
console.log('every file the exports map names is in the tarball')

for (const declarations of [manifest.exports['.'].import.types, manifest.exports['.'].require.types]) {
  const source = readFileSync(join(installedDir, declarations), 'utf8')
  // Comments in this schema discuss "any device on the tailnet" and the like, so
  // the scan has to run on code only or it fails on its own prose.
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')
  const anyUses = code.match(/\bany\b/g) ?? []
  if (anyUses.length > 0) {
    throw new Error(`${declarations} contains ${anyUses.length} use(s) of \`any\` outside comments.`)
  }
}
console.log('published declarations contain no `any`')

// Resolve from inside the fixture, so this reaches the INSTALLED tarball rather
// than anything the repository's own node_modules might happen to carry.
const require = createRequire(join(fixtureDir, 'package.json'))
const commonjs = require('@sprintengine/mobile-control-protocol')
const esm = await import(
  pathToFileURL(join(installedDir, manifest.exports['.'].import.default)).href
)
for (const [label, loaded] of [
  ['require', commonjs],
  ['import', esm],
]) {
  for (const name of RUNTIME_EXPORTS) {
    if (loaded[name] === undefined) {
      throw new Error(`the ${label} build of the package does not export ${name}.`)
    }
  }
}
console.log('both builds export every runtime validator')

// The wire version and the npm major move together, by policy. A published
// major that disagrees with the constant inside is the one mismatch nobody can
// diagnose from a dependency line.
const packageMajor = Number(manifest.version.split('.')[0])
if (packageMajor !== commonjs.mobileControlProtocolVersion) {
  throw new Error(
    `package version ${manifest.version} has major ${packageMajor}, but ` +
      `mobileControlProtocolVersion is ${commonjs.mobileControlProtocolVersion}. ` +
      'See docs/compatibility.md — the major tracks the wire version.'
  )
}
console.log(`package major ${packageMajor} matches mobileControlProtocolVersion`)

run('npx', ['tsc', '-p', 'tsconfig.json'], fixtureDir)
run('node', [join(fixtureDir, 'out', 'require-consumer.js')], fixtureDir)
run('node', [join(fixtureDir, 'out', 'import-consumer.mjs')], fixtureDir)

console.log('mobile-control-protocol pack verification passed')
