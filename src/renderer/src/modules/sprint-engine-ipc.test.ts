import assert from 'node:assert/strict'

import {
  SPRINT_ENGINE_MODULE_DISABLED_CODE,
  SPRINT_ENGINE_MODULE_DISABLED_MESSAGE,
} from '../../../shared/sprintengine/ipc-types'
import {
  bindSprintEngineIpc,
  createHostBackedSprintEngineIpc,
  sprintEngineIpc,
} from './sprint-engine-ipc'

function testUnboundClientRejectsWithNamedCause(): void {
  bindSprintEngineIpc(null)
  assert.throws(
    () => {
      void sprintEngineIpc.listSprintRuns([])
    },
    (error: unknown) =>
      error instanceof Error
      && error.message === SPRINT_ENGINE_MODULE_DISABLED_MESSAGE
      && (error as { code?: string }).code === SPRINT_ENGINE_MODULE_DISABLED_CODE,
  )
}

async function testUnknownChannelMapsToNamedCause(): Promise<void> {
  bindSprintEngineIpc(createHostBackedSprintEngineIpc({
    invoke: async () => {
      throw Object.assign(new Error('No module has registered the IPC channel "sprint-engine:runs:list".'), {
        code: 'unknown_channel',
      })
    },
    subscribe: () => () => undefined,
  }))
  await assert.rejects(
    () => sprintEngineIpc.listSprintRuns(['/Users/dev/project']),
    (error: unknown) =>
      error instanceof Error
      && (error as { code?: string }).code === SPRINT_ENGINE_MODULE_DISABLED_CODE,
  )
}

async function main(): Promise<void> {
  testUnboundClientRejectsWithNamedCause()
  await testUnknownChannelMapsToNamedCause()
  bindSprintEngineIpc(null)
  console.log('sprint-engine-ipc tests passed')
}

void main()
