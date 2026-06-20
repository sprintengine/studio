import assert from 'node:assert/strict'

import type { AgentCliAvailabilityMap } from '../../../../shared/electron-api'
import {
  createCliAvailabilitySlice,
  type CliAvailabilitySliceState,
} from './cliAvailabilitySlice'

function availability(map: Record<string, boolean>): AgentCliAvailabilityMap {
  const out: AgentCliAvailabilityMap = {}
  for (const [cli, installed] of Object.entries(map)) {
    out[cli] = {
      cli,
      installed,
      resolvedPath: installed ? `/usr/bin/${cli}` : null,
      version: installed ? '1.0.0' : null,
    }
  }
  return out
}

const carrier: CliAvailabilitySliceState = {
  cliAvailability: {},
  cliAvailabilityStatus: 'loading',
  cliAvailabilityError: null,
}

async function main(): Promise<void> {
  // --- ok path -------------------------------------------------------------
  const okApi = {
    pluginsDetectAvailability: async () => ({
      ok: true as const,
      availability: availability({ codex: true, 'claude-code': false }),
    }),
  }
  const slice = createCliAvailabilitySlice((mutator) => mutator(carrier), { getApi: () => okApi })
  await slice.refreshCliAvailability()
  assert.equal(carrier.cliAvailabilityStatus, 'ready')
  assert.equal(carrier.cliAvailability.codex.installed, true)
  assert.equal(carrier.cliAvailability['claude-code'].installed, false)

  // --- foreground error path -----------------------------------------------
  const failed = createCliAvailabilitySlice((mutator) => mutator(carrier), {
    getApi: () => ({
      pluginsDetectAvailability: async () => ({ ok: false as const, message: 'probe failed' }),
    }),
  })
  await failed.refreshCliAvailability()
  assert.equal(carrier.cliAvailabilityStatus, 'error')
  assert.equal(carrier.cliAvailabilityError, 'probe failed')
  assert.deepEqual(carrier.cliAvailability, {})

  // --- missing api ---------------------------------------------------------
  const missing = createCliAvailabilitySlice((mutator) => mutator(carrier), { getApi: () => null })
  await missing.refreshCliAvailability()
  assert.equal(carrier.cliAvailabilityStatus, 'error')
  assert.equal(carrier.cliAvailabilityError, 'CLI availability API is unavailable.')

  // --- background failure keeps last-known-good ----------------------------
  const bgCarrier: CliAvailabilitySliceState = {
    cliAvailability: availability({ codex: true }),
    cliAvailabilityStatus: 'ready',
    cliAvailabilityError: null,
  }
  const failingBackground = createCliAvailabilitySlice((mutator) => mutator(bgCarrier), {
    getApi: () => ({
      pluginsDetectAvailability: async () => ({ ok: false as const, message: 'transient' }),
    }),
  })
  await failingBackground.refreshCliAvailability({ background: true })
  assert.equal(bgCarrier.cliAvailabilityStatus, 'ready', 'background failure keeps status ready')
  assert.equal(bgCarrier.cliAvailabilityError, null)
  assert.equal(bgCarrier.cliAvailability.codex.installed, true, 'background failure preserves map')

  // --- force + cliRuntimes are forwarded to the api ------------------------
  let lastInput: unknown = undefined
  const capturing = createCliAvailabilitySlice((mutator) => mutator(bgCarrier), {
    getApi: () => ({
      pluginsDetectAvailability: async (input) => {
        lastInput = input
        return { ok: true as const, availability: availability({ codex: true }) }
      },
    }),
  })
  await capturing.refreshCliAvailability({ force: true, cliRuntimes: { codex: { command: '/x/codex' } } })
  assert.deepEqual(lastInput, { force: true, cliRuntimes: { codex: { command: '/x/codex' } } })

  // --- concurrent-refresh dedup --------------------------------------------
  let calls = 0
  let resolveDetect: (v: { ok: true; availability: AgentCliAvailabilityMap }) => void = () => {}
  const slowCarrier: CliAvailabilitySliceState = {
    cliAvailability: {},
    cliAvailabilityStatus: 'loading',
    cliAvailabilityError: null,
  }
  const slow = createCliAvailabilitySlice((mutator) => mutator(slowCarrier), {
    getApi: () => ({
      pluginsDetectAvailability: () => {
        calls += 1
        return new Promise<{ ok: true; availability: AgentCliAvailabilityMap }>((resolve) => {
          resolveDetect = resolve
        })
      },
    }),
  })
  const a = slow.refreshCliAvailability()
  const b = slow.refreshCliAvailability()
  assert.equal(a, b, 'concurrent refreshes share one in-flight promise')
  assert.equal(calls, 1, 'concurrent refreshes make a single detect call')
  resolveDetect({ ok: true, availability: {} })
  await a

  console.log('cliAvailabilitySlice.test.ts: ok')
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
