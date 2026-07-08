import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { connect, createServer, type Server } from 'node:net'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { AgentStateFrame } from './agent-state'
import { createAgentStateService, resolveAgentStateSocketPath } from './agent-state-service'

function writeLine(socketPath: string, line: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const socket = connect(socketPath)
    socket.on('error', reject)
    socket.on('connect', () => {
      socket.write(line, () => socket.end())
    })
    socket.on('close', () => resolve())
  })
}

async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now()
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timed out')
    await new Promise((r) => setTimeout(r, 10))
  }
}

async function run(): Promise<void> {
  // --- socket path resolution --------------------------------------------
  if (process.platform !== 'win32') {
    assert.equal(resolveAgentStateSocketPath('/short/dir'), '/short/dir/agent-state.sock')
    // A long userData dir falls back to the temp dir (POSIX sun_path limit).
    const long = '/' + 'x'.repeat(120)
    assert.match(resolveAgentStateSocketPath(long), /agent-state-[0-9a-f]{12}\.sock$/)
  }

  // --- socket round-trip: valid frame in, malformed dropped --------------
  const userDataDir = await mkdtemp(join(tmpdir(), 'multicode-agent-state-svc-'))
  const received: AgentStateFrame[] = []
  const service = createAgentStateService({
    resolveUserDataDir: () => userDataDir,
    resolveReporterScriptPath: () => null,
    resolveOpencodeReporterScriptPath: () => null,
    onFrame: (frame) => received.push(frame),
    now: () => 4242,
  })
  await service.initialize()
  assert.equal(service.isRunning(), true)

  const socketPath = service.getSocketPath()
  // Malformed line is dropped silently; a valid frame is parsed and delivered.
  await writeLine(socketPath, 'not json\n')
  await writeLine(
    socketPath,
    JSON.stringify({ type: 'agent_state', agentId: 'a1', workspaceId: 'w1', phase: 'tool_use', event: 'PreToolUse' }) + '\n'
  )
  await waitFor(() => received.length >= 1)
  assert.equal(received.length, 1)
  assert.equal(received[0].agentId, 'a1')
  assert.equal(received[0].phase, 'tool_use')
  // ts defaulted via the injected clock since the frame omitted it.
  assert.equal(received[0].ts, 4242)

  // A frame with an invalid phase is rejected by validation, not delivered.
  await writeLine(socketPath, JSON.stringify({ type: 'agent_state', agentId: 'a1', phase: 'bogus' }) + '\n')
  await new Promise((r) => setTimeout(r, 50))
  assert.equal(received.length, 1)

  await service.shutdown()
  assert.equal(service.isRunning(), false)

  // --- install: serialized + run once per workspace ----------------------
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'multicode-agent-state-ws-'))
  const reporterSrc = join(workspaceRoot, 'reporter-src.mjs')
  await writeFile(reporterSrc, '// reporter\n', 'utf8')

  const opencodeReporterSrc = join(workspaceRoot, 'opencode-reporter-src.mjs')
  await writeFile(opencodeReporterSrc, "const BAKED = '__MULTICODE_AGENT_STATE_SOCKET__'\n", 'utf8')

  let resolveCalls = 0
  let opencodeResolveCalls = 0
  const installSvc = createAgentStateService({
    resolveUserDataDir: () => userDataDir,
    resolveReporterScriptPath: () => {
      resolveCalls += 1
      return reporterSrc
    },
    resolveOpencodeReporterScriptPath: () => {
      opencodeResolveCalls += 1
      return opencodeReporterSrc
    },
    onFrame: () => {},
  })

  // Two concurrent claude-code installs for the same workspace must collapse to
  // a single real install (serialized chain + install-once guard).
  await Promise.all([
    installSvc.installForWorkspace(workspaceRoot, 'claude-code'),
    installSvc.installForWorkspace(workspaceRoot, 'claude-code'),
  ])
  assert.equal(resolveCalls, 1)
  // A later claude-code install is a no-op too.
  await installSvc.installForWorkspace(workspaceRoot, 'claude-code')
  assert.equal(resolveCalls, 1)

  const settings = JSON.parse(await readFile(join(workspaceRoot, '.claude', 'settings.local.json'), 'utf8')) as {
    hooks?: Record<string, unknown>
  }
  assert.ok(settings.hooks?.SessionStart, 'reporter hook not installed')
  assert.ok(settings.hooks?.PostToolUse, 'PostToolUse hook (awaiting-input clearer) not installed')
  assert.ok(!settings.hooks?.PreToolUse, 'PreToolUse must not be installed (trimmed)')

  // Codex in the SAME workspace is a distinct install (different file + key),
  // so it runs once more and writes the TOML target, not the JSON one.
  await installSvc.installForWorkspace(workspaceRoot, 'codex')
  assert.equal(resolveCalls, 2)
  const codexConfig = await readFile(join(workspaceRoot, '.codex', 'config.toml'), 'utf8')
  assert.ok(codexConfig.includes('[[hooks.SessionStart]]'), 'codex reporter hook not installed')
  // …and is itself install-once.
  await installSvc.installForWorkspace(workspaceRoot, 'codex')
  assert.equal(resolveCalls, 2)

  // OpenCode in the SAME workspace uses the separate opencode reporter resolver
  // and writes an in-process plugin (.js) with the live socket baked in — not the
  // claude/codex stdin reporter.
  await installSvc.installForWorkspace(workspaceRoot, 'opencode')
  assert.equal(opencodeResolveCalls, 1)
  assert.equal(resolveCalls, 2, 'opencode must not consume the claude/codex reporter resolver')
  const opencodePlugin = await readFile(join(workspaceRoot, '.opencode', 'plugin', 'multicode-agent-state.js'), 'utf8')
  assert.ok(opencodePlugin.includes(JSON.stringify(installSvc.getSocketPath())), 'opencode plugin missing baked socket path')
  assert.ok(!opencodePlugin.includes("'__MULTICODE_AGENT_STATE_SOCKET__'"), 'opencode socket token left unsubstituted')
  // …and is install-once.
  await installSvc.installForWorkspace(workspaceRoot, 'opencode')
  assert.equal(opencodeResolveCalls, 1)

  // --- missing reporter script: safe no-op, never throws -----------------
  const noScriptWs = await mkdtemp(join(tmpdir(), 'multicode-agent-state-noscript-'))
  const noScriptSvc = createAgentStateService({
    resolveUserDataDir: () => userDataDir,
    resolveReporterScriptPath: () => null,
    resolveOpencodeReporterScriptPath: () => null,
    onFrame: () => {},
  })
  await noScriptSvc.installForWorkspace(noScriptWs, 'claude-code') // must not throw
  await noScriptSvc.installForWorkspace(noScriptWs, 'opencode') // must not throw

  // --- reporter socket precedence: launch env wins over the baked arg ----
  // Executes the REAL bundled reporter script. The env address is injected
  // per-process by the launching instance; the --socket arg is baked into the
  // repo-shared settings.local.json, which another app instance may have
  // rewritten (last-writer-wins) — so env must win, arg is the fallback for
  // sessions launched outside the app.
  if (process.platform !== 'win32') {
    const reporterScript = join(process.cwd(), 'resources', 'hooks', 'multicode-agent-state.mjs')
    const sockDir = await mkdtemp(join(tmpdir(), 'multicode-agent-state-prec-'))

    const listenLines = async (socketPath: string, sink: string[]): Promise<Server> => {
      const server = createServer((socket) => {
        socket.setEncoding('utf8')
        socket.on('data', (chunk: string) => sink.push(...chunk.split('\n').filter(Boolean)))
      })
      await new Promise<void>((resolve, reject) => {
        server.on('error', reject)
        server.listen(socketPath, resolve)
      })
      return server
    }

    const runReporter = (envSocket: string | undefined, argSocket: string): Promise<void> =>
      new Promise((resolve, reject) => {
        const child = spawn(process.execPath, [reporterScript, '--socket', argSocket], {
          env: {
            ...process.env,
            MULTICODE_AGENT_ID: 'prec-agent',
            MULTICODE_WORKSPACE_ID: 'prec-ws',
            // Always override: when this test itself runs inside a Multicode
            // agent session, the launch env carries the LIVE app's socket —
            // inheriting it would silently redirect the "fallback" run to the
            // real app. Empty string is falsy, so the reporter falls to --socket.
            MULTICODE_AGENT_STATE_SOCKET: envSocket ?? '',
          },
          stdio: ['pipe', 'ignore', 'ignore'],
        })
        child.on('error', reject)
        child.on('exit', () => resolve())
        child.stdin.end(JSON.stringify({ hook_event_name: 'Stop', session_id: 'prec-session' }))
      })

    const envSockPath = join(sockDir, 'env-instance.sock')
    const argSockPath = join(sockDir, 'arg-instance.sock')
    const envFrames: string[] = []
    const argFrames: string[] = []
    const envServer = await listenLines(envSockPath, envFrames)
    const argServer = await listenLines(argSockPath, argFrames)

    await runReporter(envSockPath, argSockPath)
    await waitFor(() => envFrames.length >= 1)
    assert.equal(argFrames.length, 0, 'env address set: baked --socket must receive nothing')
    const envFrame = JSON.parse(envFrames[0]) as { phase?: string; agentId?: string }
    assert.equal(envFrame.phase, 'idle', 'Stop maps to idle')
    assert.equal(envFrame.agentId, 'prec-agent')

    await runReporter(undefined, argSockPath)
    await waitFor(() => argFrames.length >= 1)
    assert.equal(envFrames.length, 1, 'no env address: frame falls back to the baked --socket')

    envServer.close()
    argServer.close()

    // --- reporter bounded retry -------------------------------------------
    // First attempt fails (no listener yet: ENOENT fast-fail), the listener
    // appears during the ~200ms backoff, and the retry delivers the frame.
    const lateSockPath = join(sockDir, 'late-instance.sock')
    const lateFrames: string[] = []
    const reporterRun = runReporter(lateSockPath, join(sockDir, 'never-exists.sock'))
    await new Promise((r) => setTimeout(r, 80))
    const lateServer = await listenLines(lateSockPath, lateFrames)
    await reporterRun
    await waitFor(() => lateFrames.length >= 1)
    const lateFrame = JSON.parse(lateFrames[0]) as { phase?: string }
    assert.equal(lateFrame.phase, 'idle', 'retry delivered the Stop frame once the listener appeared')
    lateServer.close()

    // Permanently dead socket: still exits 0 (never throws into the CLI) and
    // stays well inside the bounded deadline (fast connect failures + backoff,
    // not the full per-attempt timeout).
    const deadStart = Date.now()
    await runReporter(join(sockDir, 'gone-a.sock'), join(sockDir, 'gone-b.sock'))
    assert.ok(Date.now() - deadStart < 3000, 'dead-socket reporter run must stay inside the retry deadline')
  }

  console.log('agent-state-service.test.ts: all assertions passed')
}

run()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error)
    process.exit(1)
  })
