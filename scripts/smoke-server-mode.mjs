#!/usr/bin/env node
// Smoke-test the Studio server out of process against the built app (phase 6
// spec, 16.3). A sibling of measure-startup.mjs: it launches `out/` with
// SPRINTENGINE_SERVER_MODE=out-of-process and a temp profile, then
//
//   1. waits for the server's ready and for the window's port;
//   2. SIGKILLs the server and waits for the restart and a fresh port;
//   3. quits, and checks the app and its server are both gone in time;
//   4. relaunches in process on the same profile (the rollback), and checks it
//      reads the same data directory: the same environment id.
//
// Run `npx electron-vite build` first. On macOS the app is started with
// Chromium's mock keychain, so a run never waits on a keychain prompt.
//
//   node scripts/smoke-server-mode.mjs [--keep-profile]

import { execFileSync, spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const STEP_TIMEOUT_MS = 45_000
const QUIT_BUDGET_MS = 15_000
const keepProfile = process.argv.includes('--keep-profile')

function fail(message) {
  console.error(`[smoke-server-mode] FAILED: ${message}`)
  process.exitCode = 1
}

function say(message) {
  console.log(`[smoke-server-mode] ${message}`)
}

if (!existsSync(join(ROOT, 'out', 'main', 'studio-server.js'))) {
  console.error('[smoke-server-mode] out/main/studio-server.js not found: run `npx electron-vite build` first.')
  process.exit(1)
}

function launch(profileDir, mode) {
  const env = {}
  for (const key of ['PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'TMPDIR', 'LANG', 'DISPLAY', 'XDG_RUNTIME_DIR']) {
    if (process.env[key] !== undefined) env[key] = process.env[key]
  }
  env.SPRINTENGINE_USER_DATA_DIR = profileDir
  env.SPRINTENGINE_ALLOW_MULTI_INSTANCE = '1'
  env.SPRINTENGINE_SERVER_MODE = mode
  const args = process.platform === 'darwin' ? ['--use-mock-keychain', ROOT] : [ROOT]
  const child = spawn(require('electron'), args, { env, stdio: ['ignore', 'pipe', 'pipe'] })
  let output = ''
  const waiters = []
  const onData = (chunk) => {
    output += chunk.toString()
    for (const waiter of [...waiters]) {
      const match = waiter.pattern.exec(output.slice(waiter.from))
      if (!match) continue
      waiters.splice(waiters.indexOf(waiter), 1)
      waiter.resolve(match)
    }
  }
  child.stdout.on('data', onData)
  child.stderr.on('data', onData)
  const exited = new Promise((resolve) => child.on('exit', (code, signal) => resolve({ code, signal })))
  return {
    child,
    exited,
    output: () => output,
    /** The next match of `pattern` in what the app says from now on. */
    expect(pattern, what) {
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`timed out waiting for ${what}`)), STEP_TIMEOUT_MS)
        waiters.push({
          pattern,
          from: output.length,
          resolve: (match) => {
            clearTimeout(timer)
            resolve(match)
          },
        })
      })
    },
  }
}

function serverPids(appPid) {
  try {
    const listing = execFileSync('ps', ['-axo', 'pid=,ppid=,command='], { encoding: 'utf8' })
    return listing
      .split('\n')
      .map((line) => line.trim().split(/\s+/))
      .filter(([, ppid, ...command]) => Number(ppid) === appPid && command.join(' ').includes('node.mojom.NodeService'))
      .map(([pid]) => Number(pid))
  } catch {
    return []
  }
}

async function waitUntil(condition, what) {
  const deadline = Date.now() + STEP_TIMEOUT_MS
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
}

async function quit(app) {
  const started = Date.now()
  app.child.kill('SIGTERM')
  const killer = setTimeout(() => app.child.kill('SIGKILL'), QUIT_BUDGET_MS)
  const exit = await app.exited
  clearTimeout(killer)
  return { ...exit, ms: Date.now() - started }
}

const profile = mkdtempSync(join(tmpdir(), 'studio-server-smoke-'))
try {
  say(`profile ${profile}`)
  const app = launch(profile, 'out-of-process')
  const ready = app.expect(/\[shell\] server ready \(pid (\d+)\)/, 'the server to be ready')
  const brokered = app.expect(/\[shell\] brokered (window-\d+-\d+)/, "the window's port")
  const serverPid = Number((await ready)[1])
  const firstClient = (await brokered)[1]
  say(`server ${serverPid} ready; window port ${firstClient}`)

  const restarted = app.expect(/\[shell\] server ready \(pid (\d+)\)/, 'the server to come back')
  const rebrokered = app.expect(/\[shell\] brokered (window-\d+-\d+)/, 'a fresh window port')
  process.kill(serverPid, 'SIGKILL')
  const nextPid = Number((await restarted)[1])
  const nextClient = (await rebrokered)[1]
  if (nextPid === serverPid) fail('the restarted server has the old pid')
  if (nextClient === firstClient) fail('the window kept its old port')
  say(`killed ${serverPid}; server ${nextPid} ready; window port ${nextClient}`)

  const appPid = app.child.pid
  const exit = await quit(app)
  if (exit.signal === 'SIGKILL') fail(`the app did not quit within ${QUIT_BUDGET_MS} ms`)
  if (!/\[shell\] server stopped/.test(app.output())) fail('the server did not report a clean stop')
  const left = serverPids(appPid)
  if (left.length > 0) fail(`server process(es) still running after quit: ${left.join(', ')}`)
  say(`quit in ${exit.ms} ms; nothing left running`)

  const environment = JSON.parse(readFileSync(join(profile, 'studio-environment.json'), 'utf8')).id
  const rollback = launch(profile, 'in-process')
  // In process, main's own gateway writes its discovery file with main's pid.
  await waitUntil(() => {
    try {
      return (
        JSON.parse(readFileSync(join(profile, 'sprintengine-studio-mcp-info.json'), 'utf8')).pid === rollback.child.pid
      )
    } catch {
      return false
    }
  }, 'the in-process gateway')
  const rollbackExit = await quit(rollback)
  const after = JSON.parse(readFileSync(join(profile, 'studio-environment.json'), 'utf8')).id
  if (after !== environment) fail('the in-process launch saw another data directory')
  if (/\[shell\] forked/.test(rollback.output())) fail('the in-process launch forked a server')
  say(`rollback: in process on the same profile (environment ${after}), quit in ${rollbackExit.ms} ms`)
} catch (error) {
  fail(error instanceof Error ? error.message : String(error))
} finally {
  if (keepProfile) say(`kept ${profile}`)
  else rmSync(profile, { recursive: true, force: true })
}
if (!process.exitCode) say('passed')
