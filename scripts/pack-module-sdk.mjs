#!/usr/bin/env node
// Packs @sprintengine/module-sdk into resources/module-sdk/ for the app to ship
// (package.json `build.extraResources` copies it to `module-sdk`). "Build your
// own extension" copies the tarball into the new project's vendor/ and depends
// on it by `file:`, so the project installs with no registry: the SDK is not on
// npm yet, a registry behind a company proxy may never carry it, and a project
// should build against the SDK of the app that made it.
//
// Run before packaging (wired into the `dist:*` scripts and the release
// workflows). electron-builder does not fail on a missing extraResources
// source, so this fails loudly rather than leave the app nothing to ship.
// In a source checkout, run it once (`npm run sdk:bundle`) for the door to
// scaffold against this checkout's SDK; without it the door falls back to the
// npm release.
//
//   node scripts/pack-module-sdk.mjs

import { execSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const SDK_DIR = join(REPO_ROOT, 'packages', 'module-sdk')
const OUT_DIR = join(REPO_ROOT, 'resources', 'module-sdk')

const { version } = JSON.parse(readFileSync(join(SDK_DIR, 'package.json'), 'utf8'))
// npm's name for a scoped package's tarball; the app looks for exactly this.
const expected = `sprintengine-module-sdk-${version}.tgz`

// One tarball, this version's: a stale one from an earlier version would ship
// beside it and never be read.
rmSync(OUT_DIR, { recursive: true, force: true })
mkdirSync(OUT_DIR, { recursive: true })

// `prepack` builds the package (and clears dist first), so the tarball always
// carries this checkout's code.
console.log(`$ npm pack --pack-destination ${OUT_DIR}`)
execSync(`npm pack --pack-destination "${OUT_DIR}"`, { cwd: SDK_DIR, stdio: ['ignore', 'pipe', 'inherit'] })

const packed = readdirSync(OUT_DIR)
if (packed.length !== 1 || packed[0] !== expected || !existsSync(join(OUT_DIR, expected))) {
  console.error(`Expected resources/module-sdk/${expected} alone; found: ${packed.join(', ') || 'nothing'}.`)
  process.exit(1)
}
console.log(`packed resources/module-sdk/${expected}`)
