#!/usr/bin/env node
// Vendors the self-contained runtimes Multicode ships so its own features work
// with no user-installed Python or Node:
//
//   resources/runtime/python  — CPython from astral-sh/python-build-standalone,
//                               with our requirements.txt installed into it.
//   resources/runtime/npm      — npm's pure-JS CLI, run via Electron's embedded
//                               Node (ELECTRON_RUN_AS_NODE) for `npm install -g`
//                               of agent CLIs such as Codex.
//
// Run before packaging (wired into the `dist:*` scripts). Defaults to the host
// platform/arch; CI cross-builds pass --platform/--arch to match the target.
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
// python-build-standalone publishes "install_only" archives that extract to a
// `python/` directory containing bin/python3 (POSIX) or python.exe (Windows).
// Bump deliberately: the tag and the CPython version must come from the same
// release (https://github.com/astral-sh/python-build-standalone/releases).
const PBS_RELEASE = '20241016'
const PYTHON_VERSION = '3.12.7'
// npm is pure JS and runs on any Node, including Electron's embedded one.
const NPM_VERSION = '10.9.0'

// host platform/arch -> python-build-standalone target triple
const PBS_TRIPLES = {
  'linux-x64': 'x86_64-unknown-linux-gnu',
  'linux-arm64': 'aarch64-unknown-linux-gnu',
  'darwin-x64': 'x86_64-apple-darwin',
  'darwin-arm64': 'aarch64-apple-darwin',
  'win32-x64': 'x86_64-pc-windows-msvc',
  'win32-arm64': 'aarch64-pc-windows-msvc',
}

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

function bundledPythonExe(platform) {
  return platform === 'win32'
    ? join(RUNTIME_DIR, 'python', 'python.exe')
    : join(RUNTIME_DIR, 'python', 'bin', 'python3')
}

async function fetchPython(opts, tmp) {
  const key = `${opts.platform}-${opts.arch}`
  const triple = PBS_TRIPLES[key]
  if (!triple) {
    throw new Error(`No python-build-standalone target for ${key}. Known: ${Object.keys(PBS_TRIPLES).join(', ')}`)
  }
  const asset = `cpython-${PYTHON_VERSION}+${PBS_RELEASE}-${triple}-install_only.tar.gz`
  const url = `https://github.com/astral-sh/python-build-standalone/releases/download/${PBS_RELEASE}/${asset}`
  const archive = join(tmp, asset)
  await download(url, archive)
  // Archive top-level dir is `python/`, so extracting into RUNTIME_DIR yields
  // resources/runtime/python — exactly what managed-runtime.ts expects.
  rmSync(join(RUNTIME_DIR, 'python'), { recursive: true, force: true })
  extractTarGz(archive, RUNTIME_DIR)

  const python = bundledPythonExe(opts.platform)
  if (!existsSync(python)) {
    throw new Error(`expected interpreter not found after extraction: ${python}`)
  }
  return python
}

function installPythonDeps(pythonExe, opts) {
  // Install our runtime requirements into the bundled interpreter so features
  // like sprintengine_core (which hard-requires PyYAML) work out of the box.
  // Cross-platform note: pip cannot install a foreign platform's wheels, so dep
  // installation only runs when building for the host platform. CI must run
  // this script natively on each target OS/arch.
  const isHost = opts.platform === process.platform && opts.arch === process.arch
  if (!isHost) {
    log(`skipping pip install: target ${opts.platform}-${opts.arch} != host ${process.platform}-${process.arch}`)
    log('  -> run fetch-runtimes natively on the target platform so wheels match')
    return
  }
  log('installing requirements.txt into bundled CPython')
  const result = spawnSync(
    pythonExe,
    ['-m', 'pip', 'install', '--no-warn-script-location', '-r', join(REPO_ROOT, 'requirements.txt')],
    { stdio: 'inherit' },
  )
  if (result.status !== 0) {
    throw new Error(`pip install failed (exit ${result.status ?? 'signal'})`)
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
  log(`target ${opts.platform}-${opts.arch} (python ${PYTHON_VERSION}, npm ${NPM_VERSION})`)

  const pythonReady = existsSync(bundledPythonExe(opts.platform))
  const npmReady = existsSync(join(RUNTIME_DIR, 'npm', 'bin', 'npm-cli.js'))
  if (pythonReady && npmReady && !opts.force) {
    log('runtimes already present (use --force to refetch); nothing to do')
    return
  }

  mkdirSync(RUNTIME_DIR, { recursive: true })
  const tmp = await mkdtemp(join(tmpdir(), 'multicode-runtimes-'))
  try {
    const pythonExe = await fetchPython(opts, tmp)
    installPythonDeps(pythonExe, opts)
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
