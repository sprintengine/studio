// The Studio launcher: what every hook and MCP entry written outside the app's
// data runs. Each case runs the real POSIX script, under every `sh` this
// machine has, in a temporary home — never this machine's own.

import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { test } from 'vitest'

import {
  buildLauncherCommand,
  buildLauncherMcpServer,
  ensureStudioLauncher,
  isLauncherMcpServer,
  launcherCommandPattern,
  launcherRefForHome,
  LAUNCHER_POINTER_NAME,
  parseLauncherPointer,
  renderLauncherPointer,
  renderWindowsEmptyMcp,
  renderWindowsLauncher,
  type LauncherPointer,
} from './launcher'

const POSIX = process.platform !== 'win32'
const SHELLS = ['/bin/sh', '/bin/dash', '/bin/bash'].filter((shell) => existsSync(shell))

async function home(label: string): Promise<string> {
  return mkdtemp(join(tmpdir(), `sprintengine-launcher-${label}-`))
}

function run(
  shell: string,
  args: string[],
  input: string,
  options: { env?: NodeJS.ProcessEnv; closeStdin?: boolean } = {},
): Promise<{ code: number | null; stdout: string }> {
  return new Promise((resolveRun, reject) => {
    const child = spawn(shell, args, {
      env: { PATH: process.env.PATH, ...options.env },
      stdio: ['pipe', 'pipe', 'ignore'],
    })
    let stdout = ''
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk
    })
    child.on('error', reject)
    child.on('close', (code) => resolveRun({ code, stdout }))
    child.stdin.end(input)
  })
}

const PAYLOAD = resolve(process.cwd(), 'resources')

function pointer(overrides: Partial<LauncherPointer> = {}): LauncherPointer {
  return { node: process.execPath, runAsNode: false, payload: PAYLOAD, packaged: false, ...overrides }
}

test('the pointer round-trips and refuses a path with a line break in it', () => {
  const value = pointer({ node: '/Applications/Studio Two.app/Contents/MacOS/Studio', runAsNode: true, packaged: true })
  assert.deepEqual(parseLauncherPointer(renderLauncherPointer(value)), value)
  assert.equal(parseLauncherPointer('node=\n'), null)
  assert.throws(() => renderLauncherPointer(pointer({ payload: '/a\nnode=/evil' })))
})

test('commands name the launcher, quote for the shell that runs them, and are recognised as ours', () => {
  const posix = launcherRefForHome('/Users/dev', 'posix')
  assert.equal(posix.path, '/Users/dev/.sprintengine/bin/studio-run')
  const hook = buildLauncherCommand(posix, 'agent-state', ['--socket', "/tmp/it's here.sock"])
  assert.equal(hook, `/bin/sh '/Users/dev/.sprintengine/bin/studio-run' agent-state --socket '/tmp/it'"'"'s here.sock'`)
  assert.ok(launcherCommandPattern('agent-state').test(hook))
  assert.ok(!launcherCommandPattern('status-line').test(hook))

  const windows = launcherRefForHome('C:\\Users\\dev', 'windows')
  assert.equal(windows.path, 'C:/Users/dev/.sprintengine/bin/studio-run.cmd')
  const pipe = '\\\\.\\pipe\\sprintengine-agent-state-abc'
  const windowsHook = buildLauncherCommand(windows, 'agent-state', ['--socket', pipe])
  // Unquoted: a line that starts with a quote is one `cmd /c` strips and PowerShell reads as a string.
  assert.equal(windowsHook, `C:/Users/dev/.sprintengine/bin/studio-run.cmd agent-state --socket "${pipe}"`)
  assert.ok(launcherCommandPattern('agent-state').test(windowsHook))
  const spaced = buildLauncherCommand(launcherRefForHome('C:\\Users\\Dev User', 'windows'), 'agent-state', [
    '--socket',
    pipe,
  ])
  assert.ok(spaced.startsWith('"C:/Users/Dev User/.sprintengine/bin/studio-run.cmd" agent-state'), spaced)
  assert.ok(launcherCommandPattern('agent-state').test(spaced))

  const env = buildLauncherCommand(posix, 'agent-state', ['--socket', '/s'], { WSLENV: 'X' })
  assert.ok(env.startsWith("env WSLENV='X' /bin/sh "), env)

  assert.deepEqual(buildLauncherMcpServer(posix), { command: '/bin/sh', args: [posix.path, 'mcp'] })
  assert.deepEqual(buildLauncherMcpServer(windows), {
    command: 'cmd',
    args: ['/d', '/c', 'C:\\Users\\dev\\.sprintengine\\bin\\studio-run.cmd', 'mcp'],
  })
  assert.ok(isLauncherMcpServer(buildLauncherMcpServer(posix)))
  assert.ok(isLauncherMcpServer(buildLauncherMcpServer(windows)))
  assert.ok(isLauncherMcpServer({ command: ['/bin/sh', posix.path, 'mcp'] }), 'OpenCode spells it as one array')
  assert.ok(!isLauncherMcpServer({ command: '/bin/sh', args: [posix.path, 'agent-state'] }))
  assert.ok(!isLauncherMcpServer({ command: 'node', args: ['/x/studio-run', 'mcp'] }), 'only our directory counts')
})

test('the Windows launcher passes the arguments after the target on, and falls back to the empty server', () => {
  const script = renderWindowsLauncher()
  assert.ok(script.includes('\r\n'), 'cmd.exe reads CRLF')
  assert.ok(script.includes('"%SE_NODE%" "%SE_PAYLOAD%\\%SE_SCRIPT%" %2 %3 %4 %5 %6 %7 %8 %9'))
  assert.ok(script.includes('if /i "%SE_TARGET%"=="mcp" powershell.exe'))
  assert.ok(script.includes('findstr "^" >nul 2>&1'), 'a hook drains its input before it exits')
  assert.ok(script.includes('chcp 65001'), 'the UTF-8 pointer is read as UTF-8')
  const ps = renderWindowsEmptyMcp()
  const switchBody = (ps.split('switch (')[1] ?? '').split('if ($null -eq $result)')[0]
  assert.ok(
    switchBody && !/\bcontinue\b/u.test(switchBody),
    'no `continue` inside the switch: it only leaves the switch',
  )
  assert.ok(ps.includes('$result = $null'), 'each message starts without the last one’s reply')
  assert.ok(script.includes('if /i "%SE_TARGET%"=="agent-state" set "SE_SCRIPT=hooks\\sprintengine-agent-state.mjs"'))
})

test('writing the launcher is idempotent, and a development build leaves a live packaged pointer alone', async () => {
  const dir = await home('ensure')
  const packaged = pointer({ packaged: true })
  const first = await ensureStudioLauncher({ nativeHome: dir, shell: 'posix', pointer: packaged })
  assert.ok(first.wrote.length >= 2)
  if (POSIX) assert.equal((await stat(join(first.dir, 'studio-run'))).mode & 0o111, 0o111)
  const again = await ensureStudioLauncher({ nativeHome: dir, shell: 'posix', pointer: packaged })
  assert.deepEqual(again.wrote, [], 'nothing changed, nothing written')

  await ensureStudioLauncher({ nativeHome: dir, shell: 'posix', pointer: pointer({ node: '/dev/build/electron' }) })
  assert.deepEqual(parseLauncherPointer(await readFile(join(first.dir, LAUNCHER_POINTER_NAME), 'utf8')), packaged)

  // …until the packaged build's Node is gone.
  await ensureStudioLauncher({
    nativeHome: dir,
    shell: 'posix',
    pointer: pointer({ node: '/dev/build/electron' }),
    pointerTargetExists: () => false,
  })
  assert.equal(
    parseLauncherPointer(await readFile(join(first.dir, LAUNCHER_POINTER_NAME), 'utf8'))?.node,
    '/dev/build/electron',
  )

  const windows = await ensureStudioLauncher({ nativeHome: await home('ensure-win'), shell: 'windows' })
  assert.ok(existsSync(join(windows.dir, 'studio-run.cmd')))
  assert.ok(existsSync(join(windows.dir, 'studio-run-empty-mcp.ps1')))
})

const MCP_SESSION = [
  JSON.stringify({
    jsonrpc: '2.0',
    id: 0,
    method: 'initialize',
    params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'c', version: '1' } },
  }),
  JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
  JSON.stringify({ method: 'tools/list', params: {}, jsonrpc: '2.0', id: 'two' }),
  JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'prompts/list' }),
  JSON.stringify({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'x' } }),
].join('\n')

for (const shell of SHELLS) {
  test(`${shell}: with the app gone, a hook drains its input and exits 0, and the MCP target serves no tools`, async () => {
    const dir = await home('gone')
    const { dir: bin } = await ensureStudioLauncher({ nativeHome: dir, shell: 'posix' })
    const launcher = join(bin, 'studio-run')

    // No pointer at all.
    const hook = await run(shell, [launcher, 'agent-state', '--socket', '/nowhere.sock'], '{"hook_event_name":"Stop"}')
    assert.deepEqual(hook, { code: 0, stdout: '' })

    const mcp = await run(shell, [launcher, 'mcp'], `${MCP_SESSION}\n`)
    assert.equal(mcp.code, 0)
    const replies = mcp.stdout
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as Record<string, any>)
    assert.equal(replies.length, 4, 'every request answered, the notification not')
    assert.equal(replies[0].id, 0)
    assert.equal(replies[0].result.protocolVersion, '2025-03-26', 'the client’s version is echoed')
    assert.deepEqual(replies[0].result.capabilities, { tools: {} })
    assert.equal(replies[1].id, 'two')
    assert.deepEqual(replies[1].result, { tools: [] })
    assert.deepEqual(replies[2].result, { prompts: [] })
    assert.equal(replies[3].error.code, -32601)

    // A pointer naming a Node that is gone behaves the same.
    await writeFile(
      join(bin, LAUNCHER_POINTER_NAME),
      renderLauncherPointer(pointer({ node: join(dir, 'gone', 'node') })),
    )
    assert.deepEqual(await run(shell, [launcher, 'status-line', '--socket', '/s'], '{}'), { code: 0, stdout: '' })
    // An unknown target is a quiet no-op, never an error in a CLI's hook output.
    assert.deepEqual(await run(shell, [launcher, 'later-target'], ''), { code: 0, stdout: '' })
  })
}

test(
  'with the app present, the launcher runs the shipped script with every argument, as Electron-as-Node when told',
  { skip: !POSIX },
  async () => {
    const dir = await home('present')
    const payload = join(dir, 'payload')
    await mkdir(join(payload, 'hooks'), { recursive: true })
    await writeFile(
      join(payload, 'hooks', 'sprintengine-agent-state.mjs'),
      'process.stdout.write(JSON.stringify({ argv: process.argv.slice(2), electron: process.env.ELECTRON_RUN_AS_NODE ?? null }))\n',
    )
    const { dir: bin } = await ensureStudioLauncher({
      nativeHome: dir,
      shell: 'posix',
      pointer: pointer({ payload, runAsNode: true }),
    })
    const out = await run('/bin/sh', [join(bin, 'studio-run'), 'agent-state', '--socket', '/a b/c.sock'], '')
    assert.equal(out.code, 0)
    assert.deepEqual(JSON.parse(out.stdout), { argv: ['--socket', '/a b/c.sock'], electron: '1' })
  },
)

test('the MCP target runs the real bridge when the app is present', { skip: !POSIX }, async () => {
  const dir = await home('bridge')
  const { dir: bin } = await ensureStudioLauncher({ nativeHome: dir, shell: 'posix', pointer: pointer() })
  // The bridge with no app to reach still speaks MCP on stdio; what matters
  // here is that the launcher found and started it rather than the fallback.
  const out = await run('/bin/sh', [join(bin, 'studio-run'), 'mcp'], `${MCP_SESSION.split('\n')[0]}\n`, {
    env: { SPRINTENGINE_USER_DATA_DIR: join(dir, 'no-app') },
  })
  assert.ok(!out.stdout.includes('is not installed on this machine'), out.stdout)
})
