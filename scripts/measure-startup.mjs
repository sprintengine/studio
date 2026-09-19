#!/usr/bin/env node
// Startup measurement harness. Launches the built app N times with the
// boot timeline switched on, parses the read-out each launch prints, and reports
// the median per phase — so the bundle-size ceiling in
// `scripts/check-bundle-budget.mjs` can be argued from wall-clock numbers rather
// than from a round number nobody measured.
//
//   node scripts/measure-startup.mjs                     # 5 runs, fresh profile each
//   node scripts/measure-startup.mjs --runs 3 --profile reuse
//   node scripts/measure-startup.mjs --json reports/startup.json
//   node scripts/measure-startup.mjs --compile-cache      # V8 code-cache verdict
//
// Requires a build (`npx electron-vite build`): this measures the shipped
// bundle, not the dev server.
//
// Profiles: `fresh` gives every run its own empty userData directory (the
// first-launch path); `reuse` shares one across runs (the returning-user path).
// Neither can purge the OS page cache, so run 1 of a `fresh` series after a
// build is the closest thing to a cold start this harness can produce — the
// numbers say which is which rather than pretending.

import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

const require = createRequire(import.meta.url)
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const RUN_TIMEOUT_MS = 60_000

const args = parseArgs(process.argv.slice(2))

function parseArgs(argv) {
  const parsed = { runs: 5, profile: 'fresh', json: null, compileCache: false }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--compile-cache') parsed.compileCache = true
    else if (arg === '--runs') parsed.runs = Number(argv[++i])
    else if (arg === '--profile') parsed.profile = argv[++i]
    else if (arg === '--json') parsed.json = argv[++i]
    else fail(`unknown argument: ${arg}`)
  }
  if (!Number.isInteger(parsed.runs) || parsed.runs < 1) fail('--runs must be a positive integer')
  if (parsed.profile !== 'fresh' && parsed.profile !== 'reuse') fail('--profile must be fresh or reuse')
  return parsed
}

function fail(message) {
  console.error(`[measure-startup] ${message}`)
  process.exit(1)
}

// The eager entry chunk, the thing the ceiling is about: largest index-*.js.
/**
 * The renderer's entry chunk, read out of `out/renderer/index.html` rather than
 * guessed from a filename.
 *
 * This used to take "the largest `index-*.js`", which was true while the shell
 * was the only HTML entry. The canvas worker made it a third one, and with it
 * came LAZY chunks that are also called `index-*.js` — the Mermaid importer is
 * ~1 MB of one — so the old rule was one growth spurt away from reporting a
 * chunk the shell never loads. `scripts/check-bundle-budget.mjs` reads the same
 * document for the same reason; the note at the top of that file has the
 * details. `eagerTotalKb` is the whole boot graph (this chunk plus every
 * modulepreload beside it), which is what the ceiling there is measured
 * against; the compile timing below stays on the entry alone, because that is
 * the one file it makes sense to compile in isolation.
 */
function eagerChunk() {
  let html
  try {
    html = readFileSync(join(ROOT, 'out/renderer/index.html'), 'utf8')
  } catch {
    fail('out/renderer/index.html not found — run `npx electron-vite build` first.')
  }
  const refs = []
  for (const tag of html.match(/<script\b[^>]*>/gi) ?? []) {
    if (!/\btype\s*=\s*["']module["']/i.test(tag)) continue
    const src = tag.match(/\bsrc\s*=\s*["']([^"']+)["']/i)
    if (src) refs.push({ ref: src[1], entry: true })
  }
  for (const tag of html.match(/<link\b[^>]*>/gi) ?? []) {
    if (!/\brel\s*=\s*["']modulepreload["']/i.test(tag)) continue
    const href = tag.match(/\bhref\s*=\s*["']([^"']+)["']/i)
    if (href) refs.push({ ref: href[1], entry: false })
  }
  if (refs.length === 0) fail('out/renderer/index.html loads no module script.')

  let total = 0
  let entry = null
  for (const { ref, entry: isEntry } of refs) {
    const path = join(ROOT, 'out/renderer', ref.replace(/^\.?\//, '').split('?')[0])
    let size
    try {
      size = statSync(path).size
    } catch {
      fail(`${ref} is loaded by index.html but is not in the build output.`)
    }
    total += size
    if (isEntry && !entry) entry = { file: ref.replace(/^.*\//, ''), path, size }
  }
  if (!entry) fail('out/renderer/index.html names no entry script.')
  return { ...entry, eagerTotalKb: Math.round(total / 1024) }
}

async function reportStartup() {
  const chunk = eagerChunk()
  console.log(
    `[measure-startup] ${args.runs} run(s), ${args.profile} profile — eager chunk ${chunk.file} ` +
      `(${Math.round(chunk.size / 1024)} KB of a ${chunk.eagerTotalKb} KB boot graph)`,
  )

  const sharedProfile = args.profile === 'reuse' ? mkdtempSync(join(tmpdir(), 'sprintengine-startup-')) : null
  const runs = []
  try {
    for (let index = 0; index < args.runs; index += 1) {
      const profileDir = sharedProfile ?? mkdtempSync(join(tmpdir(), 'sprintengine-startup-'))
      try {
        const report = await launchOnce(profileDir)
        runs.push(report)
        const revealMs = span(report, 'time-to-app')
        console.log(
          `  run ${index + 1}: ${revealMs === null ? '—' : `${revealMs} ms`} to app on screen` +
            `${report.complete ? '' : ` (incomplete: ${report.missing.join(', ')})`}`,
        )
      } finally {
        if (!sharedProfile) rmSync(profileDir, { recursive: true, force: true })
      }
    }
  } finally {
    if (sharedProfile) rmSync(sharedProfile, { recursive: true, force: true })
  }

  const summary = summarize(runs, chunk)
  printSummary(summary)
  if (args.json) {
    // `resolve`, not `join`: an absolute --json path must land where it says.
    const target = resolve(ROOT, args.json)
    writeFileSync(target, `${JSON.stringify({ summary, runs }, null, 2)}\n`)
    console.log(`[measure-startup] wrote ${target}`)
  }
}

// A launch is measured under an ALLOWLISTED environment, not this process's.
// The harness is usually run from an agent terminal inside a running studio
// dev host, whose environment carries `ELECTRON_RENDERER_URL`,
// `NODE_ENV=development` and friends — inherit those and the app under
// measurement quietly loads the host's vite dev server instead of the build you
// asked it to measure, and reports numbers for somebody else's renderer. Only
// the OS-level variables Electron and the shell need are passed through.
const PASSTHROUGH_ENV_KEYS = [
  'PATH',
  'HOME',
  'SHELL',
  'USER',
  'LOGNAME',
  'LANG',
  'LC_ALL',
  'TMPDIR',
  'TERM',
  'DISPLAY',
  'XDG_RUNTIME_DIR',
  'XDG_CONFIG_HOME',
  'APPDATA',
  'LOCALAPPDATA',
  'USERPROFILE',
  'ProgramData',
  'ProgramFiles',
  'SystemRoot',
  'windir',
  'COMSPEC',
  'PATHEXT',
  'TEMP',
  'TMP',
  'NUMBER_OF_PROCESSORS',
]

function launchEnv(profileDir) {
  const env = {}
  for (const key of PASSTHROUGH_ENV_KEYS) {
    if (process.env[key] !== undefined) env[key] = process.env[key]
  }
  env.SPRINTENGINE_STARTUP_TIMELINE = '1'
  env.SPRINTENGINE_USER_DATA_DIR = profileDir
  env.SPRINTENGINE_ALLOW_MULTI_INSTANCE = '1'
  return env
}

function launchOnce(profileDir) {
  const electron = require('electron')

  return new Promise((resolve, reject) => {
    const child = spawn(electron, [ROOT], {
      env: launchEnv(profileDir),
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let settled = false
    let closed = false
    let buffer = ''
    child.on('close', () => {
      closed = true
    })

    const finish = (error, report) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (closed) {
        if (error) reject(error)
        else resolve(report)
        return
      }
      // The measured boot is over; the app has nothing else to tell us. SIGTERM
      // lets `before-quit` drain, SIGKILL is the backstop for a wedged shutdown.
      // Resolve only once the process is gone: the profile directory is deleted
      // next, and a still-running app writes into it.
      child.kill('SIGTERM')
      const killTimer = setTimeout(() => child.kill('SIGKILL'), 5_000)
      child.on('close', () => {
        clearTimeout(killTimer)
        if (error) reject(error)
        else resolve(report)
      })
    }

    const timer = setTimeout(
      () => finish(new Error(`no timeline within ${RUN_TIMEOUT_MS} ms — is this build instrumented?`)),
      RUN_TIMEOUT_MS,
    )

    const onChunk = (data) => {
      buffer += data.toString()
      const match = buffer.match(/\[startup-timeline-json\] (\{.*\})/)
      if (!match) return
      try {
        finish(null, JSON.parse(match[1]))
      } catch (error) {
        finish(error)
      }
    }
    child.stdout.on('data', onChunk)
    child.stderr.on('data', onChunk)
    child.on('error', (error) => finish(error))
    child.on('exit', (code) => {
      if (!settled) finish(new Error(`app exited (code ${code}) before reporting a timeline`))
    })
  })
}

function span(report, id) {
  return report.spans.find((entry) => entry.id === id)?.ms ?? null
}

function median(values) {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  const value = sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle]
  return Math.round(value * 10) / 10
}

function summarize(runs, chunk) {
  const rowIds = [...new Set(runs.flatMap((run) => run.rows.map((row) => row.id)))]
  const spanIds = [...new Set(runs.flatMap((run) => run.spans.map((entry) => entry.id)))]
  const label = (id) => runs.flatMap((run) => [...run.rows, ...run.spans]).find((entry) => entry.id === id)?.label ?? id
  const pick = (id, key, source) =>
    runs.map((run) => run[source].find((entry) => entry.id === id)?.[key]).filter((value) => typeof value === 'number')

  return {
    runs: runs.length,
    profile: args.profile,
    // Carried into the summary (and the --json file) rather than left on the
    // per-run lines: a median over runs that never finished a phase must not
    // read as a clean series to someone skimming the table.
    incompleteRuns: runs.filter((run) => !run.complete).length,
    missingMarks: [...new Set(runs.flatMap((run) => run.missing))],
    eagerChunk: { file: chunk.file, kb: Math.round(chunk.size / 1024), eagerTotalKb: chunk.eagerTotalKb },
    marks: rowIds.map((id) => {
      const offsets = pick(id, 'offsetMs', 'rows')
      return {
        id,
        label: label(id),
        medianMs: median(offsets),
        minMs: Math.min(...offsets),
        maxMs: Math.max(...offsets),
      }
    }),
    spans: spanIds.map((id) => {
      const values = pick(id, 'ms', 'spans')
      return { id, label: label(id), medianMs: median(values), minMs: Math.min(...values), maxMs: Math.max(...values) }
    }),
  }
}

function printSummary(summary) {
  const width = (rows) => rows.reduce((max, row) => Math.max(max, `${row.medianMs}`.length), 0)
  console.log(`\n  phase offsets from process start (median of ${summary.runs}, min–max)`)
  const markWidth = width(summary.marks)
  for (const mark of summary.marks) {
    console.log(`  ${`${mark.medianMs}`.padStart(markWidth)} ms  ${mark.label}  [${mark.minMs}–${mark.maxMs}]`)
  }
  console.log('\n  spans')
  const spanWidth = width(summary.spans)
  for (const entry of summary.spans) {
    console.log(`  ${`${entry.medianMs}`.padStart(spanWidth)} ms  ${entry.label}  [${entry.minMs}–${entry.maxMs}]`)
  }
  if (summary.incompleteRuns > 0) {
    console.log(
      `\n  WARNING: ${summary.incompleteRuns} of ${summary.runs} run(s) never reported ` +
        `${summary.missingMarks.join(', ')} — the medians above are over partial data.`,
    )
  }
}

// --- V8 code cache -----------------------------------------------------------
// What a code cache buys is COMPILE time, not fetch and not execution. This
// compiles the real eager chunk twice — cold, then with V8's cached data — so
// the "should we adopt a V8 code cache" question has a number attached.
//
// The chunk is an ES module (it carries `import.meta`), so it is compiled
// through `vm.SourceTextModule`, which needs a flag. Run it under Electron's own
// V8, which is the engine that will actually pay this cost:
//
//   ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron --experimental-vm-modules \
//     scripts/measure-startup.mjs --compile-cache
function reportCompileCache() {
  if (typeof vm.SourceTextModule !== 'function') {
    fail(
      'vm.SourceTextModule is unavailable — re-run with --experimental-vm-modules, e.g.\n' +
        '  ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron --experimental-vm-modules ' +
        'scripts/measure-startup.mjs --compile-cache',
    )
  }
  const chunk = eagerChunk()
  const code = readFileSync(chunk.path, 'utf8')
  const iterations = 5

  const cachedData = new vm.SourceTextModule(code).createCachedData()
  if (!cachedData || cachedData.length === 0) fail('V8 produced no cached data for the eager chunk.')

  const cold = []
  const warm = []
  for (let index = 0; index < iterations; index += 1) {
    let started = process.hrtime.bigint()
    new vm.SourceTextModule(code)
    cold.push(Number(process.hrtime.bigint() - started) / 1e6)

    started = process.hrtime.bigint()
    const cached = new vm.SourceTextModule(code, { cachedData })
    warm.push(Number(process.hrtime.bigint() - started) / 1e6)
    if (cached.cachedDataRejected) fail('V8 rejected the cached data — the measurement would be a lie.')
  }

  const coldMs = median(cold)
  const warmMs = median(warm)
  console.log(
    `[measure-startup] eager chunk ${chunk.file} (${Math.round(chunk.size / 1024)} KB), ${iterations} iterations`,
  )
  console.log(`  ${coldMs} ms  compile, no code cache`)
  console.log(`  ${warmMs} ms  compile, with V8 cached data (${Math.round(cachedData.length / 1024)} KB of cache)`)
  console.log(`  ${Math.round((coldMs - warmMs) * 10) / 10} ms  is the most a renderer code cache could remove`)
  console.log(
    '  (compile only — V8 still lazily compiles function bodies on first call, which a\n' +
      '   real Chromium code cache also covers; compare against the measured\n' +
      '   "document start → entry script running" span for the whole fetch+compile+eval.)',
  )
}

// Dispatch last: everything above is a declaration, so the entry point cannot
// run before the constants it reads exist.
if (args.compileCache) {
  reportCompileCache()
} else {
  await reportStartup()
}
