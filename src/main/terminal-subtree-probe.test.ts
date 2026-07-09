import assert from 'node:assert/strict'
import {
  CLAUDE_TOOL_SHELL_SIGNATURE,
  parseListeningPids,
  parsePsTree,
  probeSubtreesForLiveProcesses,
  probeSubtreesForLiveWork,
  subtreeHasLiveProcess,
  subtreeLiveReason,
  type ProcRow,
} from './terminal-subtree-probe'

function run(name: string, body: () => void | Promise<void>): Promise<void> | void {
  const finish = () => console.log(`ok - ${name}`)
  try {
    const out = body()
    if (out instanceof Promise) return out.then(finish, (error) => { console.error(`not ok - ${name}`); throw error })
    finish()
  } catch (error) {
    console.error(`not ok - ${name}`)
    throw error
  }
}

// Tree: shell(100) -> agent claude(101) -> mcp(102, stdio, idle), devserver(103, listening)
//       shell(200) -> agent(201) -> mcp(202, idle)
//       shell(300) -> agent(301) -> build(302, busy 80% cpu)
//       shell(400) -> agent(401) -> bg tool shell(402, idle wrapper) -> sleep(403)
const TOOL_SHELL_COMMAND = `/bin/zsh -c source /Users/dev/${CLAUDE_TOOL_SHELL_SIGNATURE}snapshot-zsh-123.sh && eval 'sleep 300'`
const PROCS: ProcRow[] = [
  { pid: 100, ppid: 1, cpuPercent: 0, command: '/bin/zsh -l startup.sh' },
  { pid: 101, ppid: 100, cpuPercent: 0, command: 'claude --session-id abc' },
  { pid: 102, ppid: 101, cpuPercent: 0.2, command: 'node playwright-mcp' },
  { pid: 103, ppid: 101, cpuPercent: 0.1, command: 'node vite dev' },
  { pid: 200, ppid: 1, cpuPercent: 0, command: '/bin/zsh -l startup.sh' },
  { pid: 201, ppid: 200, cpuPercent: 0, command: 'claude --session-id def' },
  { pid: 202, ppid: 201, cpuPercent: 0.3, command: 'node playwright-mcp' },
  { pid: 300, ppid: 1, cpuPercent: 0, command: '/bin/zsh -l startup.sh' },
  { pid: 301, ppid: 300, cpuPercent: 0, command: 'claude --session-id ghi' },
  { pid: 302, ppid: 301, cpuPercent: 80, command: 'node build.js' },
  { pid: 400, ppid: 1, cpuPercent: 0, command: '/bin/zsh -l startup.sh' },
  { pid: 401, ppid: 400, cpuPercent: 0, command: 'claude --session-id jkl' },
  { pid: 402, ppid: 401, cpuPercent: 0, command: TOOL_SHELL_COMMAND },
  { pid: 403, ppid: 402, cpuPercent: 0, command: 'sleep 300' },
]

async function main(): Promise<void> {
  await run('parsePsTree parses pid/ppid/cpu/command rows', () => {
    const rows = parsePsTree(' 100   1   0.0 /bin/zsh -l\n 101 100  12.5 claude --resume abc\n\n garbage line \n')
    assert.deepEqual(rows, [
      { pid: 100, ppid: 1, cpuPercent: 0, command: '/bin/zsh -l' },
      { pid: 101, ppid: 100, cpuPercent: 12.5, command: 'claude --resume abc' },
    ])
  })

  await run('parseListeningPids dedups and ignores non-numeric lines', () => {
    const pids = parseListeningPids('103\n103\n\nfoo\n205\n')
    assert.deepEqual([...pids].sort((a, b) => a - b), [103, 205])
  })

  await run('a listening descendant marks the subtree live', () => {
    assert.equal(subtreeHasLiveProcess(100, PROCS, new Set([103])), true)
    assert.equal(subtreeLiveReason(100, PROCS, new Set([103])), 'listening_port')
  })

  await run('a busy descendant (build) marks the subtree live', () => {
    assert.equal(subtreeHasLiveProcess(300, PROCS, new Set()), true)
    assert.equal(subtreeLiveReason(300, PROCS, new Set()), 'busy_cpu')
  })

  await run('an idle background tool shell (0% cpu, no port) marks the subtree live', () => {
    // The quiet waiter the port/CPU signals cannot see: a run_in_background
    // shell sleeping toward a result. Killing the CLI kills it.
    assert.equal(subtreeLiveReason(400, PROCS, new Set()), 'tool_shell')
  })

  await run('only idle stdio helpers → subtree is NOT live (MCP must not block reaping)', () => {
    assert.equal(subtreeHasLiveProcess(200, PROCS, new Set()), false)
    assert.equal(subtreeLiveReason(200, PROCS, new Set()), null)
  })

  await run('the root shell itself is not counted as a live child', () => {
    // root 100 listening but no live descendants would still be false; here 100
    // has a listening descendant (103) so it's true — prove the root-exclusion
    // with a lone shell holding a port and no children.
    assert.equal(
      subtreeHasLiveProcess(999, [{ pid: 999, ppid: 1, cpuPercent: 0, command: '/bin/zsh -l' }], new Set([999])),
      false
    )
  })

  const psText = PROCS.map((p) => `${p.pid} ${p.ppid} ${p.cpuPercent} ${p.command}`).join('\n')

  await run('probeSubtreesForLiveWork maps each root to its live reason using injected ps/lsof', async () => {
    const map = await probeSubtreesForLiveWork([100, 200, 300, 400], {
      platform: 'darwin',
      runPs: async () => psText,
      runLsofListening: async () => '103\n',
    })
    assert.equal(map.get(100), 'listening_port') // listening devserver
    assert.equal(map.get(200), null) // idle mcp only → probed clean
    assert.equal(map.get(300), 'busy_cpu') // busy build
    assert.equal(map.get(400), 'tool_shell') // backgrounded tool shell
  })

  await run('probeSubtreesForLiveProcesses keeps the boolean projection', async () => {
    const map = await probeSubtreesForLiveProcesses([100, 200], {
      platform: 'darwin',
      runPs: async () => psText,
      runLsofListening: async () => '103\n',
    })
    assert.equal(map.get(100), true)
    assert.equal(map.get(200), false)
  })

  await run('probe returns empty (undetermined → keep-alive) when ps yields nothing', async () => {
    const map = await probeSubtreesForLiveWork([100], {
      platform: 'darwin',
      runPs: async () => '',
      runLsofListening: async () => '103',
    })
    assert.equal(map.size, 0)
  })

  await run('lsof failure is fail-safe: every root undetermined → keep-alive', async () => {
    const map = await probeSubtreesForLiveWork([100, 200], {
      platform: 'darwin',
      runPs: async () => psText,
      runLsofListening: async () => null, // lsof missing / errored
    })
    assert.equal(map.size, 0)
  })

  await run('ps failure is fail-safe: every root undetermined → keep-alive', async () => {
    const map = await probeSubtreesForLiveWork([100], {
      platform: 'darwin',
      runPs: async () => null,
      runLsofListening: async () => '103',
    })
    assert.equal(map.size, 0)
  })

  await run('probe is a no-op on unsupported platforms', async () => {
    const map = await probeSubtreesForLiveWork([100], { platform: 'win32' })
    assert.equal(map.size, 0)
  })

  console.log('terminal-subtree-probe tests passed')
}

void main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
