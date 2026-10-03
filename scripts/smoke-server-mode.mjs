#!/usr/bin/env node
// Smoke-test the Studio server out of process against the built app (phase 6
// spec, 16.3). A sibling of measure-startup.mjs: it launches `out/` with
// SPRINTENGINE_SERVER_MODE=out-of-process and a temp profile, then
//
//   1. waits for the server's ready and for the window's port, and lists the
//      gateway's tools: the shell's toolsets are there;
//   2. SIGKILLs the server and waits for the restart and a fresh port, and
//      lists again: the shell offered its toolsets to the new server, and a
//      call reaches the shell's terminal toolset;
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
import { createConnection } from 'node:net'
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

// One tool from each toolset the shell offers out of process (phase 6, 6.3).
const SHELL_TOOLS = ['browser.open', 'canvas.list', 'editor.open', 'tour.status', 'terminal.list', 'agent.launch']

/**
 * One MCP session with the gateway, as an agent's bridge opens it: the names
 * it lists, and the answer to `call` when one is given.
 */
function gatewaySession(profileDir, call = null) {
  const { socketPath } = JSON.parse(readFileSync(join(profileDir, 'sprintengine-studio-mcp-info.json'), 'utf8'))
  return new Promise((resolve, reject) => {
    const socket = createConnection(socketPath)
    const timer = setTimeout(() => {
      socket.destroy()
      reject(new Error('the gateway did not answer tools/list'))
    }, STEP_TIMEOUT_MS)
    let buffered = ''
    const send = (message) => socket.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`)
    socket.on('connect', () => {
      send({ method: 'sprintengine.studio/connect', params: {} })
      send({ id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {} } })
    })
    socket.on('data', (chunk) => {
      buffered += chunk.toString()
      let newline
      while ((newline = buffered.indexOf('\n')) !== -1) {
        const line = buffered.slice(0, newline)
        buffered = buffered.slice(newline + 1)
        if (!line.trim()) continue
        const message = JSON.parse(line)
        if (message.id === 1) {
          send({ method: 'notifications/initialized' })
          send({ id: 2, method: 'tools/list', params: {} })
        } else if (message.id === 2) {
          const names = (message.result?.tools ?? []).map((tool) => tool.name)
          if (!call) {
            clearTimeout(timer)
            socket.end()
            resolve({ names })
          } else send({ id: 3, method: 'tools/call', params: { name: call.name, arguments: call.arguments } })
        } else if (message.id === 3) {
          clearTimeout(timer)
          socket.end()
          resolve({ names: [], result: message.result, error: message.error })
        }
      }
    })
    socket.on('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
  })
}

/** The shell's tools the gateway does not list yet, waiting for its offer. */
async function missingShellTools(profileDir) {
  let missing = SHELL_TOOLS
  const deadline = Date.now() + STEP_TIMEOUT_MS
  while (Date.now() < deadline) {
    try {
      const listed = new Set((await gatewaySession(profileDir)).names)
      missing = SHELL_TOOLS.filter((name) => !listed.has(name))
      if (missing.length === 0) return []
    } catch {
      // The gateway is still binding its socket.
    }
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  return missing
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
  const missingFirst = await missingShellTools(profile)
  if (missingFirst.length > 0) fail(`the gateway does not list the shell's ${missingFirst.join(', ')}`)
  else say("the gateway lists the shell's toolsets")

  const restarted = app.expect(/\[shell\] server ready \(pid (\d+)\)/, 'the server to come back')
  const rebrokered = app.expect(/\[shell\] brokered (window-\d+-\d+)/, 'a fresh window port')
  process.kill(serverPid, 'SIGKILL')
  const nextPid = Number((await restarted)[1])
  const nextClient = (await rebrokered)[1]
  if (nextPid === serverPid) fail('the restarted server has the old pid')
  if (nextClient === firstClient) fail('the window kept its old port')
  say(`killed ${serverPid}; server ${nextPid} ready; window port ${nextClient}`)
  const missingAfter = await missingShellTools(profile)
  if (missingAfter.length > 0) fail(`after the restart the gateway does not list ${missingAfter.join(', ')}`)
  else say('the shell offered its toolsets to the restarted server')
  // A call the server routes to the shell's terminal toolset, and its answer back.
  const called = await gatewaySession(profile, { name: 'terminal.list', arguments: {} })
  if (called.error || called.result?.isError)
    fail(`terminal.list through the shell failed: ${JSON.stringify(called.error ?? called.result)}`)
  else say('terminal.list answered through the shell')

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
