import assert from 'node:assert/strict'
import { parseDarwinVmStat, parseLinuxMemInfo, sampleSystemMemory } from './system-memory'

async function run(name: string, body: () => void | Promise<void>): Promise<void> {
  try {
    await body()
    console.log(`ok - ${name}`)
  } catch (error) {
    console.error(`not ok - ${name}`)
    throw error
  }
}

// 16 GiB, 16384-byte pages (Apple silicon).
const TOTAL = 16 * 1024 ** 3
const VM_STAT = `Mach Virtual Memory Statistics: (page size of 16384 bytes)
Pages free:                               6400.
Pages active:                           200000.
Pages inactive:                         100000.
Pages speculative:                        3600.
Pages purgeable:                          1000.
Pages wired down:                       240000.
Pages occupied by compressor:           320000.
`
const SWAP = 'total = 3072.00M  used = 1357.62M  free = 1714.38M  (encrypted)'

async function main(): Promise<void> {
  await run('parseDarwinVmStat computes available/used/compressed/swap', () => {
    const s = parseDarwinVmStat(VM_STAT, SWAP, TOTAL)
    assert.ok(s, 'expected a sample')
    const pageSize = 16384
    const expectedAvailable = (6400 + 3600 + 100000 + 1000) * pageSize
    assert.equal(s!.source, 'vm_stat')
    assert.equal(s!.totalBytes, TOTAL)
    assert.equal(s!.availableBytes, expectedAvailable)
    assert.equal(s!.usedBytes, TOTAL - expectedAvailable)
    assert.equal(s!.compressedBytes, 320000 * pageSize)
    assert.equal(s!.swapUsedBytes, Math.round(1357.62 * 1024 ** 2))
    assert.ok(s!.utilizationRatio > 0 && s!.utilizationRatio < 1)
  })

  await run('parseDarwinVmStat returns null on unparseable output', () => {
    assert.equal(parseDarwinVmStat('garbage', '', TOTAL), null)
  })

  await run('parseDarwinVmStat clamps available to total', () => {
    const huge = `Mach Virtual Memory Statistics: (page size of 16384 bytes)
Pages free:                          999999999.
Pages inactive:                           1.
Pages occupied by compressor:             1.
`
    const s = parseDarwinVmStat(huge, '', TOTAL)
    assert.ok(s)
    assert.equal(s!.availableBytes, TOTAL)
    assert.equal(s!.usedBytes, 0)
    assert.equal(s!.utilizationRatio, 0)
  })

  await run('parseLinuxMemInfo prefers MemAvailable and reads swap', () => {
    const memInfo = `MemTotal:       16384000 kB
MemFree:         500000 kB
MemAvailable:   4000000 kB
SwapTotal:       2000000 kB
SwapFree:        1500000 kB
`
    const s = parseLinuxMemInfo(memInfo, TOTAL)
    assert.ok(s)
    assert.equal(s!.source, 'proc')
    assert.equal(s!.availableBytes, 4000000 * 1024)
    assert.equal(s!.swapUsedBytes, 500000 * 1024)
  })

  await run('parseLinuxMemInfo falls back to MemFree without MemAvailable', () => {
    const s = parseLinuxMemInfo('MemFree: 800000 kB\n', TOTAL)
    assert.ok(s)
    assert.equal(s!.availableBytes, 800000 * 1024)
  })

  await run('sampleSystemMemory uses injected darwin output', async () => {
    const s = await sampleSystemMemory({
      platform: 'darwin',
      totalBytes: TOTAL,
      runVmStat: async () => VM_STAT,
      runSwapUsage: async () => SWAP,
    })
    assert.equal(s.source, 'vm_stat')
    assert.equal(s.totalBytes, TOTAL)
  })

  await run('sampleSystemMemory falls back to os reading when parsing fails', async () => {
    const s = await sampleSystemMemory({
      platform: 'darwin',
      totalBytes: TOTAL,
      runVmStat: async () => 'garbage',
      runSwapUsage: async () => '',
    })
    assert.equal(s.source, 'os')
    assert.equal(s.totalBytes, TOTAL)
  })

  console.log('system-memory tests passed')
}

void main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
