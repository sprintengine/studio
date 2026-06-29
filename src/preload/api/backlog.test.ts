import assert from 'node:assert/strict'

import { createBacklogApi } from './backlog'

async function main(): Promise<void> {
  const calls: Array<{ channel: string; args: unknown[] }> = []
  const api = createBacklogApi({
    // The stub backs an overloaded `invoke` whose channels return different
    // result shapes, so the recorder returns `any` rather than one fixed shape.
    async invoke(channel: string, ...args: unknown[]): Promise<any> {
      calls.push({ channel, args })
      return { ok: true as const, store: { schemaVersion: 1 as const, items: [] } }
    },
  })

  await api.readBacklogObjectStore('/repo')
  await api.ensureBacklogObjectRecords('/repo', [{ relativePath: 'backlog/plan.md', status: 'idea' }])
  await api.ensureBacklogItemIds({ workspaceRoot: '/repo', items: [{ relativePath: 'backlog/plan.md', numericId: null }] })
  await api.readBacklogWorkspaceKey('/repo')
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
  await api.updateBacklogEpic({ workspaceRoot: '/repo', relativePath: 'backlog/plan.md', epic: 'auth-revamp' })
  await api.createBacklogEpic({ workspaceRoot: '/repo', title: 'Auth Revamp' })

  assert.deepEqual(calls.map((call) => call.channel), [
    'backlog:read-object-store',
    'backlog:ensure-object-records',
    'backlog:ensure-item-ids',
    'backlog:read-workspace-key',
    'backlog:update-status',
    'backlog:add-or-update-link',
    'backlog:update-module-metadata',
    'backlog:update-epic',
    'backlog:create-epic',
  ])
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
