import assert from 'node:assert/strict'
import {
  parsePsThreadCounts,
  parseProcStatusThreads,
  sampleThreadCounts,
} from './thread-counts'

function run(name: string, body: () => void): void {
  try {
    body()
    console.log(`ok - ${name}`)
  } catch (error) {
    console.error(`not ok - ${name}`)
    throw error
  }
}

async function runAsync(name: string, body: () => Promise<void>): Promise<void> {
  try {
    await body()
    console.log(`ok - ${name}`)
  } catch (error) {
    console.error(`not ok - ${name}`)
    throw error
  }
}

// Real `ps -M -p <pids>` shape: header, then one line per thread. Each process's
// first thread line carries USER + PID; continuation threads blank the USER
// column but keep the PID as the first integer token. pid 82135 → 3 threads,
// pid 83900 → 1 thread.
const PS_M_OUTPUT = [
  'USER           PID   TT   %CPU STAT PRI     STIME     UTIME COMMAND',
  'dev 82135 s281    0.0 S    31T   0:00.05   0:00.25 node /path/playwright-mcp',
  '             82135         0.0 S    31T   0:00.00   0:00.00 ',
  '             82135         0.0 S    31T   0:00.00   0:00.01 ',
  'dev 83900 s000    0.0 S    31T   0:00.01   0:00.02 -zsh',
  '',
].join('\n')

run('parsePsThreadCounts groups thread lines by pid and skips the header', () => {
  const counts = parsePsThreadCounts(PS_M_OUTPUT, new Set([82135, 83900]))
  assert.equal(counts.get(82135), 3)
  assert.equal(counts.get(83900), 1)
  assert.equal(counts.size, 2)
})

run('parsePsThreadCounts ignores pids that were not requested', () => {
  const counts = parsePsThreadCounts(PS_M_OUTPUT, new Set([82135]))
  assert.equal(counts.get(82135), 3)
  assert.equal(counts.has(83900), false)
})

run('parseProcStatusThreads extracts the Threads line', () => {
  const status = ['Name:\tnode', 'State:\tS (sleeping)', 'Tgid:\t4242', 'Threads:\t17', 'VmRSS:\t1234 kB'].join('\n')
  assert.equal(parseProcStatusThreads(status), 17)
  assert.equal(parseProcStatusThreads('Name:\tnode\nState:\tS'), null)
})

void (async () => {
  await runAsync('sampleThreadCounts (darwin) parses injected ps output', async () => {
    const counts = await sampleThreadCounts([82135, 83900], {
      platform: 'darwin',
      runPs: async () => PS_M_OUTPUT,
    })
    assert.equal(counts.get(82135), 3)
    assert.equal(counts.get(83900), 1)
  })

  await runAsync('sampleThreadCounts (darwin) degrades to empty map when ps throws', async () => {
    const counts = await sampleThreadCounts([1, 2], {
      platform: 'darwin',
      runPs: async () => {
        throw new Error('spawn failed')
      },
    })
    assert.equal(counts.size, 0)
  })

  await runAsync('sampleThreadCounts (linux) reads /proc status per pid', async () => {
    const counts = await sampleThreadCounts([10, 20], {
      platform: 'linux',
      readProcStatus: async (pid) => `Name:\tx\nThreads:\t${pid === 10 ? 5 : 9}\n`,
    })
    assert.equal(counts.get(10), 5)
    assert.equal(counts.get(20), 9)
  })

  await runAsync('sampleThreadCounts (linux) skips a pid whose status read fails', async () => {
    const counts = await sampleThreadCounts([10, 20], {
      platform: 'linux',
      readProcStatus: async (pid) => {
        if (pid === 20) throw new Error('no such process')
        return 'Threads:\t4\n'
      },
    })
    assert.equal(counts.get(10), 4)
    assert.equal(counts.has(20), false)
  })

  await runAsync('sampleThreadCounts returns empty on unsupported platform and empty pids', async () => {
    assert.equal((await sampleThreadCounts([1, 2], { platform: 'win32' })).size, 0)
    assert.equal((await sampleThreadCounts([], { platform: 'darwin' })).size, 0)
  })

  console.log('thread-counts tests passed')
})()
