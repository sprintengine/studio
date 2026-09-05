import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { connect, createServer, type Server } from 'node:net'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { PluginAgentStateSpec } from '../shared/plugin-manifest'
import type { AgentStateFrame } from './agent-state'
import { createAgentStateService, resolveAgentStateSocketPath } from './agent-state-service'

// The service resolves a CLI's spec from its plugin manifest; the tests feed it
// the REAL bundled manifest data so the install targets under test are the
// shipped ones.
const bundledSpecs = new Map<string, PluginAgentStateSpec>()

async function loadBundledSpecs(): Promise<void> {
  for (const id of ['claude-code', 'codex', 'grok', 'opencode', 'kimi-code']) {
    const manifestPath = join(process.cwd(), 'resources', 'plugins', id, 'plugin.json')
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as { agentStateSpec?: PluginAgentStateSpec }
    assert.ok(manifest.agentStateSpec, `${id} manifest must declare agentStateSpec`)
    bundledSpecs.set(id, manifest.agentStateSpec)
  }
}

const resolveSpec = (cli: string): PluginAgentStateSpec | null => bundledSpecs.get(cli) ?? null

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
  await loadBundledSpecs()

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
    resolveAgentStateSpec: resolveSpec,
    resolveReporterScriptPath: () => null,
    resolveReporterTemplatePath: () => null,
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
  let templateResolveCalls = 0
  let lastTemplateName: string | null = null
  const installSvc = createAgentStateService({
    resolveUserDataDir: () => userDataDir,
    resolveAgentStateSpec: resolveSpec,
    resolveReporterScriptPath: () => {
      resolveCalls += 1
      return reporterSrc
    },
    resolveReporterTemplatePath: (template) => {
      templateResolveCalls += 1
      lastTemplateName = template
      return opencodeReporterSrc
    },
    onFrame: () => {},
  })

  // A CLI with no agentStateSpec installs nothing — it cannot report state.
  await installSvc.installForWorkspace(workspaceRoot, 'muse')
  await installSvc.installForWorkspace(workspaceRoot, 'generic-shell')
  assert.equal(resolveCalls, 0, 'a spec-less CLI must not resolve a reporter')
  assert.equal(templateResolveCalls, 0)

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

  // Grok in the SAME workspace shares the claude/codex stdin reporter but
  // writes a standalone JSON config into .grok/hooks/, not the claude JSON or
  // codex TOML targets.
  await installSvc.installForWorkspace(workspaceRoot, 'grok')
  assert.equal(resolveCalls, 3)
  const grokHooksConfig = JSON.parse(
    await readFile(join(workspaceRoot, '.grok', 'hooks', 'multicode-agent-state.json'), 'utf8')
  ) as { hooks?: Record<string, unknown> }
  assert.ok(grokHooksConfig.hooks?.SessionStart, 'grok reporter hook not installed')
  assert.ok(!grokHooksConfig.hooks?.PreToolUse, 'PreToolUse must not be installed for grok (trimmed)')
  // …and is itself install-once.
  await installSvc.installForWorkspace(workspaceRoot, 'grok')
  assert.equal(resolveCalls, 3)

  // OpenCode in the SAME workspace resolves the plugin-file TEMPLATE its
  // manifest names and writes an in-process plugin (.js) with the live socket
  // baked in — not the shared stdin reporter.
  await installSvc.installForWorkspace(workspaceRoot, 'opencode')
  assert.equal(templateResolveCalls, 1)
  assert.equal(lastTemplateName, 'opencode-agent-state.mjs', 'template name comes from the manifest registration')
  assert.equal(resolveCalls, 3, 'opencode must not consume the shared stdin reporter resolver')
  const opencodePlugin = await readFile(join(workspaceRoot, '.opencode', 'plugin', 'multicode-agent-state.js'), 'utf8')
  assert.ok(opencodePlugin.includes(JSON.stringify(installSvc.getSocketPath())), 'opencode plugin missing baked socket path')
  assert.ok(!opencodePlugin.includes("'__MULTICODE_AGENT_STATE_SOCKET__'"), 'opencode socket token left unsubstituted')
  // …and is install-once.
  await installSvc.installForWorkspace(workspaceRoot, 'opencode')
  assert.equal(templateResolveCalls, 1)

  // --- user-scoped registration: per-CLI install-once, injected home -------
  // Kimi's config is user-global, so the install key is `${cli}::user`: the
  // first workspace's launch writes it, a second workspace's launch is a
  // no-op (the content is workspace-independent), and nothing touches the
  // real home because the test injects resolveHomeDir.
  const userScopeHome = await mkdtemp(join(tmpdir(), 'multicode-agent-state-home-'))
  const wsA = await mkdtemp(join(tmpdir(), 'multicode-agent-state-wsA-'))
  const wsB = await mkdtemp(join(tmpdir(), 'multicode-agent-state-wsB-'))
  let userScopeResolves = 0
  const userScopeSvc = createAgentStateService({
    resolveUserDataDir: () => userDataDir,
    resolveAgentStateSpec: resolveSpec,
    resolveReporterScriptPath: () => {
      userScopeResolves += 1
      return reporterSrc
    },
    resolveReporterTemplatePath: () => null,
    resolveHomeDir: () => userScopeHome,
    onFrame: () => {},
  })
  await userScopeSvc.installForWorkspace(wsA, 'kimi-code')
  assert.equal(userScopeResolves, 1)
  const kimiConfigOnDisk = await readFile(join(userScopeHome, '.kimi-code', 'config.toml'), 'utf8')
  assert.ok(kimiConfigOnDisk.includes('event = "Stop"'), 'kimi hooks block not installed under injected home')
  await userScopeSvc.installForWorkspace(wsB, 'kimi-code')
  assert.equal(userScopeResolves, 1, 'user-scoped install must be once per CLI, not per workspace')

  // --- missing reporter script: safe no-op, never throws -----------------
  const noScriptWs = await mkdtemp(join(tmpdir(), 'multicode-agent-state-noscript-'))
  const noScriptSvc = createAgentStateService({
    resolveUserDataDir: () => userDataDir,
    resolveAgentStateSpec: resolveSpec,
    resolveReporterScriptPath: () => null,
    resolveReporterTemplatePath: () => null,
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

    const runReporter = (
      envSocket: string | undefined,
      argSocket: string,
      payload: Record<string, unknown> = { hook_event_name: 'Stop', session_id: 'prec-session' }
    ): Promise<void> =>
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
        child.stdin.end(JSON.stringify(payload))
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
    const envFrame = JSON.parse(envFrames[0]) as { phase?: string; event?: string; agentId?: string }
    assert.equal(envFrame.phase, undefined, 'the reporter must not assert a phase (main maps via the manifest)')
    assert.equal(envFrame.event, 'Stop')
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
    const lateFrame = JSON.parse(lateFrames[0]) as { event?: string }
    assert.equal(lateFrame.event, 'Stop', 'retry delivered the Stop frame once the listener appeared')
    lateServer.close()

    // Permanently dead socket: still exits 0 (never throws into the CLI) and
    // stays well inside the bounded deadline (fast connect failures + backoff,
    // not the full per-attempt timeout).
    const deadStart = Date.now()
    await runReporter(join(sockDir, 'gone-a.sock'), join(sockDir, 'gone-b.sock'))
    assert.ok(Date.now() - deadStart < 3000, 'dead-socket reporter run must stay inside the retry deadline')

    // --- reporter camelCase payload (Grok Build) ---------------------------
    // Grok Build ships the same hook contract as Claude Code but names the
    // stdin fields camelCase (hookEventName / sessionId). The one shared
    // reporter must map those to the same frame.
    const grokSockPath = join(sockDir, 'grok-instance.sock')
    const grokFrames: string[] = []
    const grokServer = await listenLines(grokSockPath, grokFrames)
    await runReporter(grokSockPath, join(sockDir, 'unused.sock'), {
      hookEventName: 'UserPromptSubmit',
      sessionId: 'grok-session',
      cwd: '/tmp',
    })
    await waitFor(() => grokFrames.length >= 1)
    const grokFrame = JSON.parse(grokFrames[0]) as { sessionId?: string; event?: string; cwd?: string }
    assert.equal(grokFrame.event, 'UserPromptSubmit', 'camelCase hookEventName carried as the raw event')
    assert.equal(grokFrame.sessionId, 'grok-session', 'camelCase sessionId carried into the frame')
    assert.equal(grokFrame.cwd, '/tmp', 'the payload cwd rides every frame (MC-2440)')
    grokServer.close()

    // --- reporter observed cwd (MC-2440) -----------------------------------
    // Claude's CwdChanged names the destination `new_cwd`; it wins over a
    // stale `cwd` on the same payload. A payload with no cwd yields no field.
    const cwdSockPath = join(sockDir, 'cwd-instance.sock')
    const cwdFrames: string[] = []
    const cwdServer = await listenLines(cwdSockPath, cwdFrames)
    await runReporter(cwdSockPath, join(sockDir, 'unused.sock'), {
      hook_event_name: 'CwdChanged',
      session_id: 'cwd-session',
      old_cwd: '/repo',
      new_cwd: '/repo/.claude/worktrees/feature ',
    })
    await waitFor(() => cwdFrames.length >= 1)
    const cwdFrame = JSON.parse(cwdFrames[0]) as { event?: string; cwd?: string; phase?: string }
    assert.equal(cwdFrame.event, 'CwdChanged')
    assert.equal(cwdFrame.cwd, '/repo/.claude/worktrees/feature', 'new_cwd forwarded, trimmed')
    assert.equal(cwdFrame.phase, undefined, 'the reporter asserts no phase for an observation event')
    await runReporter(cwdSockPath, join(sockDir, 'unused.sock'), {
      hook_event_name: 'PostToolUse',
      session_id: 'cwd-session',
      tool_name: 'Bash',
    })
    await waitFor(() => cwdFrames.length >= 2)
    const noCwdFrame = JSON.parse(cwdFrames[1]) as { cwd?: string }
    assert.equal(noCwdFrame.cwd, undefined, 'a payload without a cwd carries no cwd field')
    // A subagent's hook (Claude stamps agent_id; a worktree-isolated subagent
    // has a cwd of its own) forwards its event but never its cwd.
    await runReporter(cwdSockPath, join(sockDir, 'unused.sock'), {
      hook_event_name: 'PostToolUse',
      session_id: 'cwd-session',
      tool_name: 'Bash',
      cwd: '/repo/.claude/worktrees/subagent-scratch',
      agent_id: 'agent-7f3a',
      agent_type: 'general-purpose',
    })
    await waitFor(() => cwdFrames.length >= 3)
    const subagentFrame = JSON.parse(cwdFrames[2]) as { event?: string; cwd?: string }
    assert.equal(subagentFrame.event, 'PostToolUse', 'the subagent event still reaches main')
    assert.equal(subagentFrame.cwd, undefined, 'a subagent cwd is never forwarded as the session cwd')
    // Cursor: the launch root wins over the Shell tool's per-command cwd.
    await runReporter(cwdSockPath, join(sockDir, 'unused.sock'), {
      hook_event_name: 'postToolUse',
      conversation_id: 'cursor-chat',
      workspace_roots: ['/Users/me/proj'],
      tool_name: 'Shell',
      cwd: '/tmp',
    })
    await waitFor(() => cwdFrames.length >= 4)
    const cursorFrame = JSON.parse(cwdFrames[3]) as { cwd?: string; sessionId?: string }
    assert.equal(cursorFrame.cwd, '/Users/me/proj', 'Cursor reports its launch root, not a command\'s working directory')
    assert.equal(cursorFrame.sessionId, 'cursor-chat')
    cwdServer.close()
  }

  console.log('agent-state-service.test.ts: all assertions passed')
}

run()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error)
    process.exit(1)
  })
