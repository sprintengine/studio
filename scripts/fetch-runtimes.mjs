#!/usr/bin/env node
// Vendors the self-contained runtime the studio ships so its own features work
// with no user-installed Node:
//
//   resources/runtime/npm — npm's pure-JS CLI, run via Electron's embedded Node
//                           (ELECTRON_RUN_AS_NODE) for `npm install -g` of agent
//                           CLIs such as Codex.
//
// Run before packaging (wired into the `dist:*` scripts). npm is pure JS, so
// the payload is the same on every target; --platform/--arch are accepted so
// CI cross-builds can keep passing the target they build for.
//
//   node scripts/fetch-runtimes.mjs [--platform <p>] [--arch <a>] [--force]
//
// This script is deliberately self-contained (no new npm deps): it downloads
// over https and extracts via the system `tar`, which is present on macOS,
// Linux, and modern Windows.

import { spawnSync } from 'node:child_process'
import { cpSync, createWriteStream, existsSync, mkdirSync, rmSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const RUNTIME_DIR = join(REPO_ROOT, 'resources', 'runtime')

// --- pinned versions -------------------------------------------------------
// npm is pure JS and runs on any Node, including Electron's embedded one.
const NPM_VERSION = '10.9.0'

function parseArgs(argv) {
  const opts = { platform: process.platform, arch: process.arch, force: false }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--platform') opts.platform = argv[(i += 1)]
    else if (arg === '--arch') opts.arch = argv[(i += 1)]
    else if (arg === '--force') opts.force = true
    else throw new Error(`Unknown argument: ${arg}`)
  }
  return opts
}

function log(msg) {
  console.log(`[fetch-runtimes] ${msg}`)
}

async function download(url, destFile) {
  log(`downloading ${url}`)
  const response = await fetch(url, { redirect: 'follow' })
  if (!response.ok || !response.body) {
    throw new Error(`download failed (${response.status} ${response.statusText}): ${url}`)
  }
  await pipeline(Readable.fromWeb(response.body), createWriteStream(destFile))
}

function extractTarGz(archive, destDir) {
  mkdirSync(destDir, { recursive: true })
  const result = spawnSync('tar', ['-xzf', archive, '-C', destDir], { stdio: 'inherit' })
  if (result.status !== 0) {
    throw new Error(`tar extraction failed for ${archive} (exit ${result.status ?? 'signal'})`)
  }
}

async function fetchNpm(tmp) {
  const url = `https://registry.npmjs.org/npm/-/npm-${NPM_VERSION}.tgz`
  const archive = join(tmp, `npm-${NPM_VERSION}.tgz`)
  await download(url, archive)
  // The tarball extracts to `package/`; relocate it to resources/runtime/npm.
  // Use fs.cpSync rather than shelling out to cp/move so it works the same on
  // every OS and across volumes (the OS tempdir is frequently on a different
  // volume than the checkout, where a Windows directory `move` would fail).
  const stage = join(tmp, 'npm-stage')
  extractTarGz(archive, stage)
  const npmDest = join(RUNTIME_DIR, 'npm')
  rmSync(npmDest, { recursive: true, force: true })
  mkdirSync(dirname(npmDest), { recursive: true })
  cpSync(join(stage, 'package'), npmDest, { recursive: true })
  const cli = join(npmDest, 'bin', 'npm-cli.js')
  if (!existsSync(cli)) throw new Error(`npm-cli.js not found after extraction: ${cli}`)
}

async function main() {
  const opts = parseArgs(process.argv.slice(2))
  log(`target ${opts.platform}-${opts.arch} (npm ${NPM_VERSION})`)

  const npmReady = existsSync(join(RUNTIME_DIR, 'npm', 'bin', 'npm-cli.js'))
  if (npmReady && !opts.force) {
    log('runtime already present (use --force to refetch); nothing to do')
    return
  }

  mkdirSync(RUNTIME_DIR, { recursive: true })
  const tmp = await mkdtemp(join(tmpdir(), 'sprintengine-runtimes-'))
  try {
    await fetchNpm(tmp)
    log('done')
  } finally {
    await rm(tmp, { recursive: true, force: true }).catch(() => {})
  }
}

main().catch((error) => {
  console.error(`[fetch-runtimes] FAILED: ${error?.message ?? error}`)
  process.exitCode = 1
})
