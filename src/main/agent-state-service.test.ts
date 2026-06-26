import assert from 'node:assert/strict'
import { connect } from 'node:net'
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

  let resolveCalls = 0
  const installSvc = createAgentStateService({
    resolveUserDataDir: () => userDataDir,
    resolveReporterScriptPath: () => {
      resolveCalls += 1
      return reporterSrc
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
  assert.ok(settings.hooks?.PostToolUse, 'reporter hook not installed for tool events')

  // Codex in the SAME workspace is a distinct install (different file + key),
  // so it runs once more and writes the TOML target, not the JSON one.
  await installSvc.installForWorkspace(workspaceRoot, 'codex')
  assert.equal(resolveCalls, 2)
  const codexConfig = await readFile(join(workspaceRoot, '.codex', 'config.toml'), 'utf8')
  assert.ok(codexConfig.includes('[[hooks.SessionStart]]'), 'codex reporter hook not installed')
  // …and is itself install-once.
  await installSvc.installForWorkspace(workspaceRoot, 'codex')
  assert.equal(resolveCalls, 2)

  // --- missing reporter script: safe no-op, never throws -----------------
  const noScriptWs = await mkdtemp(join(tmpdir(), 'multicode-agent-state-noscript-'))
  const noScriptSvc = createAgentStateService({
    resolveUserDataDir: () => userDataDir,
    resolveReporterScriptPath: () => null,
    onFrame: () => {},
  })
  await noScriptSvc.installForWorkspace(noScriptWs, 'claude-code') // must not throw

  console.log('agent-state-service.test.ts: all assertions passed')
}

run()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error)
    process.exit(1)
  })
