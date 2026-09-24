// The idle reaper's live-work probe for sessions on Windows: native sessions
// read through one PowerShell (CIM), WSL sessions through one `sh` per
// distribution. Neither can run here, so the runners are stubbed with output
// captured in the shape each read prints, and the scripts that are plain POSIX
// are run through a real `sh` where that proves something.

import assert from 'node:assert/strict'
import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { test } from 'vitest'

import type { RunOutcome } from './process-run'
import {
  buildWindowsSurvivorQueryScript,
  buildWslSubtreeProbeScript,
  buildWslSurvivorKillScript,
  killCliSessionSurvivors,
  parseCimProcessJson,
  parseKilledPids,
  parseSsListening,
  parseWslSubtreeProbeOutput,
  probeSessionSubtrees,
  type SessionProbeTarget,
  type SubtreeProbeDeps,
} from './terminal-subtree-probe'

const STARTUP = 'C:\\Users\\dev\\AppData\\Roaming\\SprintEngine Studio\\terminal-startup'

function ok(stdout: string): RunOutcome {
  return { code: 0, stdout, stderr: '', timedOut: false }
}

// ── WSL ──────────────────────────────────────────────────────────────────────

test('ss and lsof both give the listening pids', () => {
  const ss = [
    'LISTEN 0      511        127.0.0.1:5173      0.0.0.0:*    users:(("node",pid=4242,fd=20))',
    'LISTEN 0      4096       [::]:8080           [::]:*       users:(("python3",pid=77,fd=3),("python3",pid=78,fd=3))',
    'LISTEN 0      4096       127.0.0.53%lo:53    0.0.0.0:*',
  ].join('\n')
  assert.deepEqual(
    [...parseSsListening(ss)].sort((a, b) => a - b),
    [77, 78, 4242],
  )
  assert.deepEqual(
    [...parseSsListening('4242\n77\n\n')].sort((a, b) => a - b),
    [77, 4242],
  )
})

// What one sweep's script printed in a distribution holding two sessions: one
// whose Claude has started a dev server, one at rest, and a third whose pid
// file is missing.
function wslFixture(options: { psFailed?: boolean; listenFailed?: boolean; truncated?: boolean } = {}): string {
  const lines = [
    '@@SPRINTENGINE_PIDS',
    'sess-busy-1 100',
    'sess-idle-2 200',
    'sess-gone-3 ',
    '@@SPRINTENGINE_PS',
    ...(options.psFailed
      ? ['@@SPRINTENGINE_FAILED']
      : [
          '    1     0  0.0 /init',
          '  100     1  0.0 bash -li /mnt/c/Users/dev/AppData/Roaming/SprintEngine Studio/terminal-startup/sess-busy-1.sh',
          '  101   100  1.2 claude --session-id 11111111-2222',
          '  102   101  0.3 node /home/dev/app/node_modules/.bin/vite',
          '  200     1  0.0 bash -li /mnt/c/Users/dev/AppData/Roaming/SprintEngine Studio/terminal-startup/sess-idle-2.sh',
          '  201   200  0.4 claude --session-id 33333333-4444',
          '  202   201  0.0 node /home/dev/.npm/_npx/mcp-server/index.js',
        ]),
    '@@SPRINTENGINE_LISTEN',
    options.listenFailed
      ? '@@SPRINTENGINE_FAILED'
      : 'LISTEN 0 511 127.0.0.1:5173 0.0.0.0:* users:(("node",pid=102,fd=20))',
    ...(options.truncated ? [] : ['@@SPRINTENGINE_END']),
  ]
  return lines.join('\r\n')
}

test('the WSL read gives each session its root and every process', () => {
  const snapshot = parseWslSubtreeProbeOutput(wslFixture())
  assert.ok(snapshot)
  assert.equal(snapshot.rootPids.get('sess-busy-1'), 100)
  assert.equal(snapshot.rootPids.get('sess-idle-2'), 200)
  assert.equal(snapshot.rootPids.get('sess-gone-3'), null)
  assert.equal(snapshot.procs.length, 7)
  assert.deepEqual([...snapshot.listening], [102])
})

test('a WSL read with any part failed or cut short clears nothing', () => {
  assert.equal(parseWslSubtreeProbeOutput(wslFixture({ psFailed: true })), null)
  assert.equal(parseWslSubtreeProbeOutput(wslFixture({ listenFailed: true })), null)
  assert.equal(parseWslSubtreeProbeOutput(wslFixture({ truncated: true })), null)
  assert.equal(parseWslSubtreeProbeOutput('wsl: The distribution was not found.\r\n'), null)
})

function wslTarget(sessionId: string, key: string, cwd = 'C:\\Users\\dev\\repo'): SessionProbeTarget {
  return { sessionId, rootPid: 9_000, pathStyle: 'wsl', cwd, startupScriptPath: `${STARTUP}\\${key}.sh` }
}

test('a WSL session with a listening child is held, an idle one is cleared, one without a pid file is held', async () => {
  const runs: Array<{ distro: string | null; script: string }> = []
  const deps: SubtreeProbeDeps = {
    platform: 'win32',
    resolveWslDistro: async () => 'Ubuntu',
    runWslScript: async (distro, script) => {
      runs.push({ distro, script })
      return ok(wslFixture())
    },
  }
  const verdicts = await probeSessionSubtrees(
    [
      wslTarget('busy', 'sess-busy-1'),
      wslTarget('idle', 'sess-idle-2'),
      wslTarget('gone', 'sess-gone-3'),
      { sessionId: 'no-script', rootPid: 9_001, pathStyle: 'wsl' },
    ],
    deps,
  )
  assert.equal(verdicts.get('busy'), 'listening_port')
  assert.equal(verdicts.get('idle'), null, 'probed clean: reapable')
  assert.equal(verdicts.has('gone'), false, 'no pid file: undetermined, so held')
  assert.equal(verdicts.has('no-script'), false, 'no startup script to key a pid file: held')
  assert.equal(runs.length, 1, 'one read for the whole distribution')
  assert.equal(runs[0].distro, 'Ubuntu')
  assert.match(runs[0].script, /'sess-busy-1' 'sess-idle-2' 'sess-gone-3'/u)
})

test('a failed WSL read holds every session in that distribution', async () => {
  for (const outcome of [
    { code: 1, stdout: '', stderr: 'wsl: error', timedOut: false },
    { code: 3, stdout: '', stderr: '', timedOut: true },
    ok(wslFixture({ listenFailed: true })),
  ] satisfies RunOutcome[]) {
    const verdicts = await probeSessionSubtrees([wslTarget('busy', 'sess-busy-1'), wslTarget('idle', 'sess-idle-2')], {
      platform: 'win32',
      resolveWslDistro: async () => 'Ubuntu',
      runWslScript: async () => outcome,
    })
    assert.equal(verdicts.size, 0, JSON.stringify(outcome))
  }
  const thrown = await probeSessionSubtrees([wslTarget('idle', 'sess-idle-2')], {
    platform: 'win32',
    resolveWslDistro: async () => 'Ubuntu',
    runWslScript: async () => {
      throw new Error('spawn wsl.exe ENOENT')
    },
  })
  assert.equal(thrown.size, 0)
})

test('sessions in two distributions are read once each, in their own distribution', async () => {
  const distros: Array<string | null> = []
  await probeSessionSubtrees(
    [
      wslTarget('a', 'sess-a', '\\\\wsl.localhost\\Debian\\home\\dev\\a'),
      wslTarget('b', 'sess-b', 'C:\\Users\\dev\\b'),
      wslTarget('c', 'sess-c', 'C:\\Users\\dev\\c'),
    ],
    {
      platform: 'win32',
      resolveWslDistro: async (cwd) => (cwd?.includes('Debian') ? 'Debian' : 'Ubuntu'),
      runWslScript: async (distro) => {
        distros.push(distro)
        return ok(wslFixture())
      },
    },
  )
  assert.deepEqual(distros.sort(), ['Debian', 'Ubuntu'])
})

test('the WSL probe script is valid sh and reads pid files by key', () => {
  const script = buildWslSubtreeProbeScript(['sess-busy-1', "odd'key"])
  assert.equal(spawnSync('sh', ['-n'], { input: script }).status, 0, script)
  assert.match(script, /'odd'\\''key'/u)
})

// ── Native Windows ───────────────────────────────────────────────────────────

// What the PowerShell read printed (trimmed): a PowerShell session running
// Claude, whose Bash tool has a background shell going; a second at rest; and
// a third whose Claude has a dev server listening.
const CIM_JSON = JSON.stringify({
  listeningOk: true,
  listening: [4, 900, 7002],
  processes: [
    { pid: 4, ppid: 0, cpu: 0, cmd: '' },
    { pid: 5000, ppid: 1200, cpu: 0, cmd: 'powershell.exe -NoLogo -NoExit -File C:\\Users\\dev\\s1.ps1' },
    { pid: 5001, ppid: 5000, cpu: 2.5, cmd: '"C:\\Program Files\\nodejs\\node.exe" claude --session-id aaaa' },
    {
      pid: 5002,
      ppid: 5001,
      cpu: 0,
      cmd: 'C:\\Program Files\\Git\\bin\\bash.exe -c "source C:\\Users\\dev\\.claude\\shell-snapshots\\snapshot-bash-1.sh && sleep 300"',
    },
    { pid: 6000, ppid: 1200, cpu: 0, cmd: 'powershell.exe -NoLogo -NoExit -File C:\\Users\\dev\\s2.ps1' },
    { pid: 6001, ppid: 6000, cpu: 0.4, cmd: 'node.exe claude --session-id bbbb' },
    { pid: 7000, ppid: 1200, cpu: 0, cmd: 'powershell.exe -NoLogo -NoExit -File C:\\Users\\dev\\s3.ps1' },
    { pid: 7001, ppid: 7000, cpu: 0, cmd: 'node.exe claude --session-id cccc' },
    { pid: 7002, ppid: 7001, cpu: 0, cmd: 'node.exe node_modules\\vite\\bin\\vite.js' },
  ],
})

test('the CIM read gives rows with forward-slashed command lines', () => {
  const snapshot = parseCimProcessJson(`${CIM_JSON}\r\n`)
  assert.ok(snapshot)
  assert.equal(snapshot.procs.length, 9)
  assert.match(snapshot.procs[3].command, /\.claude\/shell-snapshots\//u)
  assert.deepEqual([...snapshot.listening], [4, 900, 7002])
  // PowerShell writes a one-element array as a bare value.
  const single = parseCimProcessJson(
    JSON.stringify({ listeningOk: true, listening: 7002, processes: { pid: 1, ppid: 0, cpu: 0, cmd: 'x' } }),
  )
  assert.deepEqual(single?.procs.length, 1)
  assert.deepEqual([...(single?.listening ?? [])], [7002])
})

test('a CIM read that could not list listeners, or is not JSON, clears nothing', () => {
  assert.equal(parseCimProcessJson(JSON.stringify({ listeningOk: false, listening: [], processes: [] })), null)
  assert.equal(parseCimProcessJson('Get-CimInstance : Access denied'), null)
  assert.equal(parseCimProcessJson(JSON.stringify({ listeningOk: true, listening: [], processes: [] })), null)
})

test('native Windows sessions are held for a tool shell or a port and cleared at rest', async () => {
  let runs = 0
  const verdicts = await probeSessionSubtrees(
    [
      { sessionId: 'tool', rootPid: 5000, pathStyle: 'windows' },
      { sessionId: 'rest', rootPid: 6000, pathStyle: 'windows' },
      { sessionId: 'server', rootPid: 7000, pathStyle: 'windows' },
      { sessionId: 'exited', rootPid: 8000, pathStyle: 'windows' },
    ],
    {
      platform: 'win32',
      runPowerShell: async () => {
        runs += 1
        return ok(CIM_JSON)
      },
    },
  )
  assert.equal(runs, 1, 'one PowerShell for every native session')
  assert.equal(verdicts.get('tool'), 'tool_shell')
  assert.equal(verdicts.get('rest'), null)
  assert.equal(verdicts.get('server'), 'listening_port')
  assert.equal(verdicts.has('exited'), false, 'a root that is not running is undetermined')
})

test('a failed PowerShell read holds every native session', async () => {
  const verdicts = await probeSessionSubtrees([{ sessionId: 'rest', rootPid: 6000, pathStyle: 'windows' }], {
    platform: 'win32',
    runPowerShell: async () => ({ code: 1, stdout: CIM_JSON, stderr: '', timedOut: false }),
  })
  assert.equal(verdicts.size, 0)
})

test('Windows and WSL sessions are only read on Windows', async () => {
  const verdicts = await probeSessionSubtrees(
    [{ sessionId: 'w', rootPid: 6000, pathStyle: 'windows' }, wslTarget('l', 'sess-idle-2')],
    {
      platform: 'darwin',
      runPowerShell: async () => ok(CIM_JSON),
      runWslScript: async () => ok(wslFixture()),
    },
  )
  assert.equal(verdicts.size, 0)
})

test('POSIX sessions still go through ps and lsof', async () => {
  const verdicts = await probeSessionSubtrees([{ sessionId: 'p', rootPid: 10, pathStyle: 'posix' }], {
    platform: 'linux',
    runPs: async () => '10 1 0.0 zsh\n11 10 0.0 claude',
    runLsofListening: async () => '',
  })
  assert.equal(verdicts.get('p'), null)
})

// ── Survivors ────────────────────────────────────────────────────────────────

test('a WSL survivor kill runs in the session distribution and reports what it killed', async () => {
  const runs: Array<{ distro: string | null; script: string }> = []
  const killed = await killCliSessionSurvivors('11111111-2222', {
    platform: 'win32',
    delayMs: 0,
    host: {
      pathStyle: 'wsl',
      cwd: '\\\\wsl.localhost\\Debian\\home\\dev\\repo',
      startupScriptPath: `${STARTUP}\\k-1.sh`,
    },
    resolveWslDistro: async () => 'Debian',
    runWslScript: async (distro, script) => {
      runs.push({ distro, script })
      return ok('@@SPRINTENGINE_KILLED 101 102\n')
    },
  })
  assert.deepEqual(killed, [101, 102])
  assert.equal(runs[0].distro, 'Debian')
  assert.match(runs[0].script, /pgrep -f -- '--session-id 11111111-2222'/u)
  assert.match(runs[0].script, /k-1\.pid/u)
})

test('a native Windows survivor kill ends each match with its tree, and nothing on a failed read', async () => {
  const trees: number[] = []
  const killed = await killCliSessionSurvivors('aaaa', {
    platform: 'win32',
    delayMs: 0,
    host: { pathStyle: 'windows' },
    runPowerShell: async (script) => {
      assert.match(script, /\$needle = '--session-id aaaa'/u)
      return ok('5001\r\n5003\r\n')
    },
    killTree: (pid) => trees.push(pid),
  })
  assert.deepEqual(killed, [5001, 5003])
  assert.deepEqual(trees, [5001, 5003])

  const none = await killCliSessionSurvivors('aaaa', {
    platform: 'win32',
    delayMs: 0,
    host: { pathStyle: 'windows' },
    runPowerShell: async () => ({ code: 1, stdout: '5001\n', stderr: 'denied', timedOut: false }),
    killTree: () => assert.fail('never kill on a failed read'),
  })
  assert.deepEqual(none, [])
})

test('the survivor query quotes the id for PowerShell', () => {
  assert.match(buildWindowsSurvivorQueryScript("it's"), /\$needle = '--session-id it''s'/u)
})

test('killed pids are read from the kill script', () => {
  assert.deepEqual(parseKilledPids('noise\n@@SPRINTENGINE_KILLED 12 34\n'), [12, 34])
  assert.deepEqual(parseKilledPids('@@SPRINTENGINE_KILLED\n'), [])
  assert.deepEqual(parseKilledPids(''), [])
})

const HAS_PGREP = spawnSync('sh', ['-c', 'command -v pgrep']).status === 0

test('the WSL survivor kill script is valid sh and matches the id literally', () => {
  const script = buildWslSurvivorKillScript('a.b(c)', 'k-1')
  assert.equal(spawnSync('sh', ['-n'], { input: script }).status, 0, script)
  assert.match(script, /--session-id a\\\.b\\\(c\\\)/u)
})

test.skipIf(!HAS_PGREP)('the WSL survivor kill script kills a process carrying the session id', async () => {
  const id = `probe-test-${process.pid}-${Date.now()}`
  const survivor = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)', '--', '--session-id', id], {
    stdio: 'ignore',
  })
  const exited = new Promise<void>((resolve) => survivor.on('exit', () => resolve()))
  try {
    await new Promise((resolve) => setTimeout(resolve, 200))
    const stdout = execFileSync('sh', ['-s'], { input: buildWslSurvivorKillScript(id, null), encoding: 'utf8' })
    assert.deepEqual(parseKilledPids(stdout), [survivor.pid])
    await exited
  } finally {
    survivor.kill('SIGKILL')
  }
})
