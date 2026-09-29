import assert from 'node:assert/strict'

import type {
  AutomationDefinition,
  AutomationsDefinitionsChangedEvent,
  AutomationsInstanceEntry,
  AutomationsInstanceListResult,
} from '../../../../shared/automations/contracts'
import type { DiagnosticLogInput } from '../../types/workspace'
import { approvalNotices, subscribeAutomationApprovalNotices } from './approvalNotices'
import { decodeAutomationTargetRef } from './runTarget'
import { test } from 'vitest'

function entry(id: string, over: Partial<AutomationsInstanceEntry> = {}): AutomationsInstanceEntry {
  return {
    workspaceRoot: '/Users/dev/acme-app',
    workspaceId: 'ws-1',
    definition: { id, name: `Automation ${id}` } as AutomationDefinition,
    lastRun: null,
    isRunningNow: false,
    approval: { state: 'needs-approval', fingerprint: `sha256:${id}`, reason: 'unreviewed' },
    ...over,
  }
}

test('one waiting automation raises one notice that opens it', () => {
  const [notice, ...rest] = approvalNotices([entry('a')], new Set())
  assert.equal(rest.length, 0)
  assert.equal(notice.level, 'warning')
  assert.equal(notice.source, 'automations')
  assert.equal(notice.title, 'Automation waiting for your OK: Automation a')
  assert.deepEqual(decodeAutomationTargetRef(notice.navigationTarget), {
    automationId: 'a',
    runId: '',
    folderPath: '/Users/dev/acme-app',
  })
})

test('several in one project are one notice, and each project gets its own', () => {
  const notices = approvalNotices(
    [entry('a'), entry('b'), entry('c', { workspaceRoot: '/Users/dev/other' })],
    new Set(),
  )
  assert.deepEqual(
    notices.map((notice) => notice.title),
    ['2 automations in acme-app are waiting for your OK', 'Automation waiting for your OK: Automation c'],
  )
})

test('an approved automation raises nothing, and a waiting one is announced once per fingerprint', () => {
  const announced = new Set<string>()
  const approved = entry('a', {
    approval: { state: 'approved', fingerprint: 'sha256:a', source: 'app', approvedAt: '2026-07-19T00:00:00Z' },
  })
  assert.deepEqual(approvalNotices([approved], announced), [])
  assert.equal(approvalNotices([entry('b')], announced).length, 1)
  assert.equal(approvalNotices([entry('b')], announced).length, 0)
  // Changed again after it was announced: announced again.
  const changed = entry('b', { approval: { state: 'needs-approval', fingerprint: 'sha256:b2', reason: 'changed' } })
  assert.equal(approvalNotices([changed], announced).length, 1)
})

test('the subscription checks on mount and again when definitions change', async () => {
  let listed: AutomationsInstanceEntry[] = [entry('a')]
  let changed: ((event: AutomationsDefinitionsChangedEvent) => void) | null = null
  const published: DiagnosticLogInput[] = []
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0))
  const unsubscribe = subscribeAutomationApprovalNotices(
    {
      listInstanceAutomations: async (): Promise<AutomationsInstanceListResult> => ({
        ok: true,
        value: { entries: listed, problems: [] },
      }),
      onAutomationsDefinitionsChanged: (cb) => {
        changed = cb
        return () => {
          changed = null
        }
      },
    },
    (notice) => published.push(notice),
  )
  await settle()
  assert.equal(published.length, 1)

  listed = [entry('a'), entry('b')]
  changed!({ workspaceRoot: '/Users/dev/acme-app' })
  await settle()
  assert.deepEqual(
    published.map((notice) => notice.title),
    ['Automation waiting for your OK: Automation a', 'Automation waiting for your OK: Automation b'],
  )

  unsubscribe()
  assert.equal(changed, null)
})
