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

  await api.ensureBacklogObjectRecords('/repo', [{ relativePath: 'backlog/plan.md', status: 'idea' }])
  await api.ensureBacklogItemIds({
    workspaceRoot: '/repo',
    items: [{ relativePath: 'backlog/plan.md', numericId: null }],
  })
  await api.updateBacklogStatus({ workspaceRoot: '/repo', relativePath: 'backlog/plan.md', status: 'in_progress' })
  await api.addOrUpdateBacklogLink({
    workspaceRoot: '/repo',
    relativePath: 'backlog/plan.md',
    link: {
      id: 'backlog:pull-request',
      moduleId: 'backlog',
      type: 'external',
      label: 'Pull request',
      target: {
        kind: 'backlog.pullRequest',
        id: 'https://github.com/sprintengine/studio/pull/91',
        url: 'https://github.com/sprintengine/studio/pull/91',
      },
    },
  })
  await api.removeBacklogLink({
    workspaceRoot: '/repo',
    relativePath: 'backlog/plan.md',
    linkId: 'backlog:pull-request',
  })
  await api.updateBacklogModuleMetadata({
    workspaceRoot: '/repo',
    relativePath: 'backlog/plan.md',
    moduleId: 'weather-deck',
    value: { deck: 'compact' },
  })
  await api.updateBacklogEpic({ workspaceRoot: '/repo', relativePath: 'backlog/plan.md', epic: 'auth-revamp' })
  await api.updateBacklogMockups({
    workspaceRoot: '/repo',
    relativePath: 'backlog/plan.md',
    mockups: ['backlog/mockups/plan.html'],
  })
  await api.createBacklogEpic({ workspaceRoot: '/repo', title: 'Auth Revamp' })

  assert.deepEqual(
    calls.map((call) => call.channel),
    [
      'backlog:ensure-object-records',
      'backlog:ensure-item-ids',
      'backlog:update-status',
      'backlog:add-or-update-link',
      'backlog:remove-link',
      'backlog:update-module-metadata',
      'backlog:update-epic',
      'backlog:update-mockups',
      'backlog:create-epic',
    ],
  )
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
