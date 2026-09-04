import assert from 'node:assert/strict'

import type { CliVersionAdvisoriesResult } from '../../../../shared/electron-api'
import {
  createCliVersionAdvisorySlice,
  subscribeCliVersionAdvisoryChanges,
  type CliVersionAdvisorySliceState,
} from './cliVersionAdvisorySlice'

const behind: CliVersionAdvisoriesResult = {
  ok: true,
  checkedAt: '2026-09-04T12:00:00Z',
  advisories: {
    codex: { cli: 'codex', status: 'behind_latest', currentVersion: '0.153.2', latestVersion: '0.153.3', updateCommand: { kind: 'brew', command: 'brew upgrade codex' }, checkedAt: '2026-09-04T12:00:00Z' },
  },
}

async function main(): Promise<void> {
  const carrier: CliVersionAdvisorySliceState = { cliVersionAdvisories: {}, cliVersionAdvisoriesCheckedAt: null, cliVersionAdvisoriesError: null }
  const inputs: unknown[] = []
  const slice = createCliVersionAdvisorySlice((mutator) => mutator(carrier), {
    getApi: () => ({
      cliVersionAdvisories: async (input) => {
        inputs.push(input)
        return behind
      },
    }),
  })
  const result = await slice.refreshCliVersionAdvisories({ force: true, cliRuntimes: { codex: { command: '/opt/homebrew/bin/codex' } } })
  assert.equal(result?.ok, true)
  assert.deepEqual(inputs, [{ force: true, cliRuntimes: { codex: { command: '/opt/homebrew/bin/codex' } } }])
  assert.equal(carrier.cliVersionAdvisories.codex?.status, 'behind_latest')
  assert.equal(carrier.cliVersionAdvisoriesCheckedAt, '2026-09-04T12:00:00Z')

  // A failure keeps the last advisories and records the message.
  slice.applyCliVersionAdvisories({ ok: false, message: 'npm did not answer' })
  assert.equal(carrier.cliVersionAdvisories.codex?.status, 'behind_latest')
  assert.equal(carrier.cliVersionAdvisoriesError, 'npm did not answer')

  // A later good answer clears the error.
  slice.applyCliVersionAdvisories({ ok: true, checkedAt: '2026-09-04T13:00:00Z', advisories: {} })
  assert.deepEqual(carrier.cliVersionAdvisories, {})
  assert.equal(carrier.cliVersionAdvisoriesError, null)

  // Push subscription.
  let pushed: ((result: CliVersionAdvisoriesResult) => void) | null = null
  const unsubscribe = subscribeCliVersionAdvisoryChanges(slice.applyCliVersionAdvisories, {
    onCliVersionAdvisoriesChanged: (cb) => {
      pushed = cb
      return () => {
        pushed = null
      }
    },
  })
  pushed!(behind)
  assert.equal(carrier.cliVersionAdvisories.codex?.latestVersion, '0.153.3')
  unsubscribe()
  assert.equal(pushed, null)

  const bare = createCliVersionAdvisorySlice((mutator) => mutator(carrier), { getApi: () => null })
  assert.equal(await bare.refreshCliVersionAdvisories(), null)

  console.log('cliVersionAdvisorySlice: ok')
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
