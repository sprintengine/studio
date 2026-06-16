import assert from 'node:assert/strict'
import {
  parseListeningPids,
  parsePsTree,
  probeSubtreesForLiveProcesses,
  subtreeHasLiveProcess,
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
const PROCS: ProcRow[] = [
  { pid: 100, ppid: 1, cpuPercent: 0 },
  { pid: 101, ppid: 100, cpuPercent: 0 },
  { pid: 102, ppid: 101, cpuPercent: 0.2 },
  { pid: 103, ppid: 101, cpuPercent: 0.1 },
  { pid: 200, ppid: 1, cpuPercent: 0 },
  { pid: 201, ppid: 200, cpuPercent: 0 },
  { pid: 202, ppid: 201, cpuPercent: 0.3 },
  { pid: 300, ppid: 1, cpuPercent: 0 },
  { pid: 301, ppid: 300, cpuPercent: 0 },
  { pid: 302, ppid: 301, cpuPercent: 80 },
]

async function main(): Promise<void> {
  await run('parsePsTree parses pid/ppid/cpu rows', () => {
    const rows = parsePsTree(' 100   1   0.0\n 101 100  12.5\n\n garbage line \n')
    assert.deepEqual(rows, [
      { pid: 100, ppid: 1, cpuPercent: 0 },
      { pid: 101, ppid: 100, cpuPercent: 12.5 },
    ])
  })

  await run('parseListeningPids dedups and ignores non-numeric lines', () => {
    const pids = parseListeningPids('103\n103\n\nfoo\n205\n')
    assert.deepEqual([...pids].sort((a, b) => a - b), [103, 205])
  })

  await run('a listening descendant marks the subtree live', () => {
    assert.equal(subtreeHasLiveProcess(100, PROCS, new Set([103])), true)
  })

  await run('a busy descendant (build) marks the subtree live', () => {
    assert.equal(subtreeHasLiveProcess(300, PROCS, new Set()), true)
  })

  await run('only idle stdio helpers → subtree is NOT live (MCP must not block reaping)', () => {
    assert.equal(subtreeHasLiveProcess(200, PROCS, new Set()), false)
  })

  await run('the root shell itself is not counted as a live child', () => {
    // root 100 listening but no live descendants would still be false; here 100
    // has a listening descendant (103) so it's true — prove the root-exclusion
    // with a lone shell holding a port and no children.
    assert.equal(subtreeHasLiveProcess(999, [{ pid: 999, ppid: 1, cpuPercent: 0 }], new Set([999])), false)
  })

  await run('probeSubtreesForLiveProcesses maps each root using injected ps/lsof', async () => {
    const map = await probeSubtreesForLiveProcesses([100, 200, 300], {
      platform: 'darwin',
      runPs: async () => PROCS.map((p) => `${p.pid} ${p.ppid} ${p.cpuPercent}`).join('\n'),
      runLsofListening: async () => '103\n',
    })
    assert.equal(map.get(100), true) // listening devserver
    assert.equal(map.get(200), false) // idle mcp only
    assert.equal(map.get(300), true) // busy build
  })

  await run('probe returns empty (undetermined → keep-alive) when ps yields nothing', async () => {
    const map = await probeSubtreesForLiveProcesses([100], {
      platform: 'darwin',
      runPs: async () => '',
      runLsofListening: async () => '103',
    })
    assert.equal(map.size, 0)
  })

  await run('lsof failure is fail-safe: every root undetermined → keep-alive', async () => {
    const map = await probeSubtreesForLiveProcesses([100, 200], {
      platform: 'darwin',
      runPs: async () => PROCS.map((p) => `${p.pid} ${p.ppid} ${p.cpuPercent}`).join('\n'),
      runLsofListening: async () => null, // lsof missing / errored
    })
    assert.equal(map.size, 0)
  })

  await run('ps failure is fail-safe: every root undetermined → keep-alive', async () => {
    const map = await probeSubtreesForLiveProcesses([100], {
      platform: 'darwin',
      runPs: async () => null,
      runLsofListening: async () => '103',
    })
    assert.equal(map.size, 0)
  })

  await run('probe is a no-op on unsupported platforms', async () => {
    const map = await probeSubtreesForLiveProcesses([100], { platform: 'win32' })
    assert.equal(map.size, 0)
  })

  console.log('terminal-subtree-probe tests passed')
}

void main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
