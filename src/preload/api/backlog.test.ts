import assert from 'node:assert/strict'

import { createBacklogApi } from './backlog'

async function main(): Promise<void> {
  const calls: Array<{ channel: string; args: unknown[] }> = []
  const api = createBacklogApi({
    async invoke(channel, ...args) {
      calls.push({ channel, args })
      return { ok: true, store: { schemaVersion: 1, items: [] } }
    },
  })

  await api.readBacklogObjectStore('/repo')
  await api.ensureBacklogObjectRecords('/repo', [{ relativePath: 'backlog/plan.md', status: 'idea' }])
  await api.updateBacklogStatus({ workspaceRoot: '/repo', relativePath: 'backlog/plan.md', status: 'in_progress' })
  await api.addOrUpdateBacklogLink({
    workspaceRoot: '/repo',
    relativePath: 'backlog/plan.md',
    link: {
      id: 'sprint-engine:plan',
      moduleId: 'sprint-engine',
      type: 'execution',
      label: 'Sprint Engine run',
      target: { kind: 'sprintengine.run', id: 'plan', path: '.multi-code/sprintengine/plan/run.yaml' },
    },
  })
  await api.updateBacklogModuleMetadata({
    workspaceRoot: '/repo',
    relativePath: 'backlog/plan.md',
    moduleId: 'sprint-engine',
    value: { runId: 'plan' },
  })

  assert.deepEqual(calls.map((call) => call.channel), [
    'backlog:read-object-store',
    'backlog:ensure-object-records',
    'backlog:update-status',
    'backlog:add-or-update-link',
    'backlog:update-module-metadata',
  ])
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
