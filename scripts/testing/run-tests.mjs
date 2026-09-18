#!/usr/bin/env node
// Bundle-and-run the repo's unit tests.
//
//   node scripts/testing/run-tests.mjs              every test
//   node scripts/testing/run-tests.mjs backlog      only paths matching "backlog"
//   node scripts/testing/run-tests.mjs --list       print what would run, run nothing
//   node scripts/testing/run-tests.mjs --jobs 4     cap concurrency (default: cpu count)
//   node scripts/testing/run-tests.mjs --bail       stop at the first failure
//   node scripts/testing/run-tests.mjs --all        include the held-back tests too
//
// A test here is a plain Node script: it asserts with `node:assert`, prints its
// own `ok -` lines and throws on failure, so "did it pass" is just the exit
// code. Each one is bundled by esbuild first because the sources are TypeScript
// and reach across the main/preload/renderer split.
//
// Which flags a given test bundles with lives in test-profiles.json, not here.
// That file was generated from the 547 one-off npm scripts this runner
// replaced, so every test still builds with the exact flags it always did. A
// test file inherits the nearest enclosing directory default; `overrides` names
// the exceptions. A new test file needs no registration — it is discovered, and
// it inherits its neighbours' profile.

import { createRequire } from 'node:module'
import { execFile } from 'node:child_process'
import { readFile, mkdir, readdir } from 'node:fs/promises'
import { availableParallelism } from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const here = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(here, '..', '..')
const cacheDir = path.join(repoRoot, 'node_modules', '.cache', 'multicode')

// Where test files live. Anything matching *.test.ts / *.test.tsx under these
// roots runs; node_modules and build output never do.
const ROOTS = ['src', 'packages', 'resources/marketplace']
const SKIP_DIRS = new Set(['node_modules', 'dist', 'out', 'build', '__fixtures__'])

function parseArgs(argv) {
  const opts = { filters: [], list: false, bail: false, all: false, jobs: availableParallelism() }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--list') opts.list = true
    else if (arg === '--all') opts.all = true
    else if (arg === '--bail') opts.bail = true
    else if (arg === '--jobs') {
      const value = Number(argv[(i += 1)])
      if (!Number.isInteger(value) || value < 1) throw new Error(`--jobs needs a positive integer, got ${argv[i]}`)
      opts.jobs = value
    } else if (arg.startsWith('-')) throw new Error(`unknown flag ${arg}`)
    else opts.filters.push(arg)
  }
  return opts
}

async function discover(dir, found) {
  let entries
  try {
    entries = await readdir(path.join(repoRoot, dir), { withFileTypes: true })
  } catch (error) {
    if (error.code === 'ENOENT') return found
    throw error
  }
  for (const entry of entries) {
    const rel = `${dir}/${entry.name}`
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) await discover(rel, found)
    } else if (/\.test\.tsx?$/.test(entry.name)) {
      found.push(rel)
    }
  }
  return found
}

// Nearest enclosing directory wins, so a test inherits its neighbours.
function resolveProfile(testPath, manifest) {
  const named = manifest.overrides[testPath]
  if (named) return named
  let dir = path.posix.dirname(testPath)
  for (;;) {
    const candidate = manifest.directoryDefaults[dir]
    if (candidate) return candidate
    if (!dir.includes('/')) return null
    dir = path.posix.dirname(dir)
  }
}

// One esbuild call per test, but in-process: the CLI's ~50ms of startup, paid
// 555 times, was most of what the old npm-script chain spent.
async function bundle(esbuild, testPath, profile, outFile) {
  const flags = profile.esbuild
  const options = {
    entryPoints: [path.join(repoRoot, testPath)],
    outfile: outFile,
    bundle: true,
    platform: 'node',
    absWorkingDir: repoRoot,
    logLevel: 'silent',
    define: {},
    alias: {},
    loader: {},
    external: [],
  }
  for (const flag of flags) {
    if (flag === '--bundle' || flag.startsWith('--platform=')) continue
    else if (flag.startsWith('--format=')) options.format = flag.slice(9)
    else if (flag === '--jsx=automatic') options.jsx = 'automatic'
    else if (flag === '--packages=external') options.packages = 'external'
    else if (flag === '--packages=bundle') options.packages = 'bundle'
    else if (flag.startsWith('--external:')) options.external.push(flag.slice(11))
    else if (flag.startsWith('--define:')) {
      const [key, ...rest] = flag.slice(9).split('=')
      options.define[key] = rest.join('=')
    } else if (flag.startsWith('--alias:')) {
      const [key, ...rest] = flag.slice(8).split('=')
      options.alias[key] = rest.join('=')
    } else if (flag.startsWith('--loader:')) {
      const [ext, name] = flag.slice(9).split('=')
      options.loader[ext] = name
    } else throw new Error(`${testPath}: test-profiles.json has a flag this runner does not translate: ${flag}`)
  }
  await esbuild.build(options)
}

// Per-file wall clock. A hung file used to stall the whole suite until a
// lander's outer cap (20 minutes); this fails that file and lets the rest
// finish. The slowest honest file is terminal-runtime.test.ts (~41s isolated,
// serial, lots of short scheduler delays); 120s is 3x that and still
// fail-fast against a leaked timer holding the event loop open.
const FILE_TIMEOUT_MS = 120_000

// The app exports its own SPRINTENGINE_* / MULTICODE_* variables into every
// terminal it opens, and this repository is developed in the app — so a suite
// started from a Studio terminal inherited a user-data dir, an agent id and a
// state socket that a CI shell never has, and a test that boots the main
// process took the dev-profile branch and failed. A test that needs one of
// these sets it itself; none may depend on which shell ran the suite.
const APP_ENV_PREFIXES = ['SPRINTENGINE_', 'MULTICODE_']
const testEnv = Object.fromEntries(
  Object.entries(process.env).filter(([name]) => !APP_ENV_PREFIXES.some((prefix) => name.startsWith(prefix))),
)

function runNode(outFile, nodeFlags) {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [...nodeFlags, outFile],
      {
        cwd: repoRoot,
        env: testEnv,
        maxBuffer: 32 * 1024 * 1024,
        timeout: FILE_TIMEOUT_MS,
        killSignal: 'SIGKILL',
      },
      (error, stdout, stderr) => {
        const hung = Boolean(error && error.killed && error.signal === 'SIGKILL')
        resolve({ ok: !error, hung, stdout, stderr })
      },
    )
  })
}

async function main() {
  const opts = parseArgs(process.argv.slice(2))
  const manifest = JSON.parse(await readFile(path.join(here, 'test-profiles.json'), 'utf8'))

  const all = []
  for (const root of ROOTS) await discover(root, all)
  all.sort()

  const matched = opts.filters.length ? all.filter((p) => opts.filters.some((f) => p.includes(f))) : all
  // Held-back tests are named on every run rather than silently dropped, so a
  // skip has to keep justifying itself.
  const skip = manifest.skip ?? {}
  const skipped = opts.all ? [] : matched.filter((p) => p in skip)
  const selected = matched.filter((p) => !skipped.includes(p))

  if (!selected.length) {
    console.error(opts.filters.length ? `No test files match: ${opts.filters.join(', ')}` : 'No test files found.')
    process.exitCode = 1
    return
  }

  if (opts.list) {
    for (const testPath of selected) console.log(`${resolveProfile(testPath, manifest) ?? '(no profile)'}\t${testPath}`)
    console.log(`\n${selected.length} test files`)
    return
  }

  const esbuild = require('esbuild')
  await mkdir(cacheDir, { recursive: true })

  const started = Date.now()
  const failures = []
  let done = 0
  let stopped = false

  // A handful of tests assert on scheduler timing, so they flake when they
  // share a CPU with 500 siblings. They go last, alone.
  const serial = new Set(manifest.serial ?? [])
  const parallelQueue = selected.filter((p) => !serial.has(p))
  const serialQueue = selected.filter((p) => serial.has(p))

  // Only redraw in place for a human at a terminal; piped output gets one line
  // per failure instead of 580 progress updates.
  const interactive = process.stdout.isTTY
  const progress = (text) => {
    if (interactive) process.stdout.write(`\r${text}`)
  }

  async function worker(queue) {
    for (;;) {
      if (stopped) return
      const testPath = queue.shift()
      if (!testPath) return
      const profileName = resolveProfile(testPath, manifest)
      const profile = profileName && manifest.profiles[profileName]
      if (!profile) {
        failures.push({ testPath, detail: `no profile resolved for ${testPath}` })
        done += 1
        continue
      }
      // Flat cache dir, so the name has to carry the path to stay unique.
      const outFile = path.join(cacheDir, `${testPath.replace(/[/\\]/g, '__').replace(/\.tsx?$/, '')}.${profile.ext}`)
      let result
      try {
        await bundle(esbuild, testPath, profile, outFile)
        result = await runNode(outFile, profile.node ?? [])
      } catch (error) {
        result = { ok: false, hung: false, stdout: '', stderr: `bundle failed: ${error.message}` }
      }
      done += 1
      if (result.ok) {
        progress(`  ${done}/${selected.length} passing…`)
      } else {
        const detail = result.hung
          ? `hung: ${testPath}`
          : `${result.stdout}\n${result.stderr}`.trim()
        failures.push({ testPath, detail })
        progress(''.padEnd(60))
        console.log(`  FAIL ${testPath}`)
        if (opts.bail) stopped = true
      }
    }
  }

  await Promise.all(
    Array.from({ length: Math.max(1, Math.min(opts.jobs, parallelQueue.length)) }, () => worker(parallelQueue)),
  )
  await worker(serialQueue)

  const seconds = ((Date.now() - started) / 1000).toFixed(1)
  progress(''.padEnd(60) + '\r')
  for (const testPath of skipped) {
    console.log(`  SKIP ${testPath}\n       ${skip[testPath]}`)
  }
  if (failures.length) {
    console.log(`\n${failures.length} of ${selected.length} test files failed:\n`)
    for (const failure of failures) {
      console.log(`─── ${failure.testPath}`)
      console.log(failure.detail.split('\n').slice(-40).join('\n'))
      console.log()
    }
    const skipTail = skipped.length ? `, ${skipped.length} skipped` : ''
    console.log(`${selected.length - failures.length} passed, ${failures.length} failed in ${seconds}s${skipTail}`)
    process.exitCode = 1
    return
  }
  const skipNote = skipped.length ? `, ${skipped.length} skipped` : ''
  console.log(`${selected.length} test files passed in ${seconds}s${skipNote}`)
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
