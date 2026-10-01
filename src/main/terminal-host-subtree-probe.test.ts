// The idle reaper's live-work probe for native Windows sessions: one
// PowerShell (CIM) read per sweep. It cannot run here, so the runner is
// stubbed with output captured in the shape the read prints. WSL sessions are
// read by their distribution's helper instead (see
// `hosts/wsl-helper/proc.test.ts`).

import assert from 'node:assert/strict'
import { test } from 'vitest'

import { createWindowsHost } from './hosts/windows-host'
import type { RunOutcome } from './process-run'
import {
  buildWindowsSurvivorQueryScript,
  killCliSessionSurvivors,
  parseCimProcessJson,
  type SubtreeProbeDeps,
} from './terminal-subtree-probe'

function ok(stdout: string): RunOutcome {
  return { code: 0, stdout, stderr: '', timedOut: false }
}

// Native sessions are read through their host, the way the reaper reads them.
function probeWindows(refs: Array<{ sessionId: string; rootPid: number }>, deps: SubtreeProbeDeps) {
  return createWindowsHost().probeSubtrees(refs, deps)
}

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
  const verdicts = await probeWindows(
    [
      { sessionId: 'tool', rootPid: 5000 },
      { sessionId: 'rest', rootPid: 6000 },
      { sessionId: 'server', rootPid: 7000 },
      { sessionId: 'exited', rootPid: 8000 },
    ],
    {
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
  const verdicts = await probeWindows([{ sessionId: 'rest', rootPid: 6000 }], {
    runPowerShell: async () => ({ code: 1, stdout: CIM_JSON, stderr: '', timedOut: false }),
  })
  assert.equal(verdicts.size, 0)
})

// ── Survivors ────────────────────────────────────────────────────────────────

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
