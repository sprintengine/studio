import assert from 'node:assert/strict'
import { mkdtemp, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { AutomationDefinition, AutomationRun } from '../../shared/automations/contracts'
import { WEBHOOK_TRIGGER_KIND } from '../../shared/automations/contracts'
import { AutomationsStore, automationsStoreDirectory } from './store'
import { buildAutomationsInstanceIndex } from './instance-index'
import { test } from 'vitest'

test('instance-index', async () => {
  const suiteRun = main().catch((error) => {
    console.error(error)
    process.exit(1)
  })

  async function main(): Promise<void> {
    await assertEnumeratesEveryRoot()
    await assertLastRunAndRunningNow()
    await assertMalformedRootIsReportedNotFatal()
    await assertWebhookSecretRedactionApplies()
  }

  async function createRoot(label: string): Promise<string> {
    return mkdtemp(join(tmpdir(), `multicode-automations-instance-${label}-`))
  }

  function definition(id: string, overrides: Partial<AutomationDefinition> = {}): AutomationDefinition {
    return {
      id,
      name: `Automation ${id}`,
      status: 'enabled',
      trigger: {
        kind: 'schedule',
        config: { kind: 'schedule', cadence: { type: 'daily', timeLocal: '02:00' }, timezone: 'UTC' },
      },
      action: { kind: 'spawn-agent', config: { prompt: 'Do the thing.' } },
      nextRunAt: '2026-06-18T02:00:00.000Z',
      lastRunAt: null,
      lastRunId: null,
      createdAt: '2026-06-17T12:00:00.000Z',
      updatedAt: '2026-06-17T12:00:00.000Z',
      ...overrides,
    }
  }

  function run(automationId: string, id: string, overrides: Partial<AutomationRun> = {}): AutomationRun {
    return {
      id,
      automationId,
      status: 'completed',
      dueAt: '2026-06-17T02:00:00.000Z',
      startedAt: '2026-06-17T02:00:01.000Z',
      completedAt: '2026-06-17T02:00:02.000Z',
      ...overrides,
    }
  }

  // Every automation across every root is enumerated, roots in the given order and
  // definitions sorted by id within a root, so the surface render is deterministic.
  async function assertEnumeratesEveryRoot(): Promise<void> {
    const rootA = await createRoot('a')
    const rootB = await createRoot('b')
    const storeA = new AutomationsStore(rootA)
    const storeB = new AutomationsStore(rootB)
    await storeA.createDefinition(definition('beta'))
    await storeA.createDefinition(definition('alpha'))
    await storeB.createDefinition(definition('gamma'))

    const index = await buildAutomationsInstanceIndex({
      projectFolders: [
        { workspaceId: 'ws-a', folderPath: rootA },
        { workspaceId: 'ws-b', folderPath: rootB },
      ],
      createStore: (workspaceRoot) => new AutomationsStore(workspaceRoot),
    })

    assert.deepEqual(
      index.entries.map((entry) => `${entry.workspaceId}:${entry.definition.id}`),
      ['ws-a:alpha', 'ws-a:beta', 'ws-b:gamma'],
      'expected all roots enumerated, definitions id-sorted within a root',
    )
    assert.equal(index.problems.length, 0)
    assert.equal(index.entries[0].workspaceRoot, rootA)
    assert.equal(index.entries[2].workspaceRoot, rootB)
  }

  // lastRun is the newest run; a run left in the running state (agent-backed runs
  // stay running until finalize) flips isRunningNow. A never-run automation has a
  // null lastRun and is not running.
  async function assertLastRunAndRunningNow(): Promise<void> {
    const root = await createRoot('runs')
    const store = new AutomationsStore(root)
    await store.createDefinition(definition('idle'))
    await store.createDefinition(definition('live'))
    // An older completed run, then a newer still-running run for 'live'.
    await store.recordRun(
      run('live', 'run-001', {
        status: 'completed',
        startedAt: '2026-06-17T01:00:00.000Z',
        completedAt: '2026-06-17T01:00:05.000Z',
      }),
    )
    await store.recordRun(
      run('live', 'run-002', {
        status: 'running',
        startedAt: '2026-06-17T03:00:00.000Z',
        completedAt: null,
      }),
    )

    const index = await buildAutomationsInstanceIndex({
      projectFolders: [{ workspaceId: 'ws', folderPath: root }],
      createStore: (workspaceRoot) => new AutomationsStore(workspaceRoot),
    })

    const idle = index.entries.find((entry) => entry.definition.id === 'idle')
    const live = index.entries.find((entry) => entry.definition.id === 'live')
    assert.ok(idle && live)
    assert.equal(idle.lastRun, null)
    assert.equal(idle.isRunningNow, false)
    assert.equal(live.lastRun?.id, 'run-002', 'lastRun is the newest run')
    assert.equal(live.isRunningNow, true, 'a running run flips isRunningNow')
  }

  // A root whose definitions dir holds a malformed file is reported and skipped,
  // never masking the healthy roots.
  async function assertMalformedRootIsReportedNotFatal(): Promise<void> {
    const badRoot = await createRoot('bad')
    const goodRoot = await createRoot('good')
    const definitionsDir = join(badRoot, automationsStoreDirectory(badRoot), 'definitions')
    await mkdir(definitionsDir, { recursive: true })
    await writeFile(join(definitionsDir, 'broken.json'), '{ not valid json', 'utf8')
    await new AutomationsStore(goodRoot).createDefinition(definition('healthy'))

    const index = await buildAutomationsInstanceIndex({
      projectFolders: [
        { workspaceId: 'ws-bad', folderPath: badRoot },
        { workspaceId: 'ws-good', folderPath: goodRoot },
      ],
      createStore: (workspaceRoot) => new AutomationsStore(workspaceRoot),
    })

    assert.equal(index.entries.length, 1, 'healthy root still enumerated')
    assert.equal(index.entries[0].definition.id, 'healthy')
    assert.equal(index.problems.length, 1, 'malformed root recorded as a problem')
    assert.equal(index.problems[0].workspaceRoot, badRoot)
  }

  // mapDefinition (the IPC handler's webhook-secret redaction) is applied to every
  // enumerated definition.
  async function assertWebhookSecretRedactionApplies(): Promise<void> {
    const root = await createRoot('hook')
    const store = new AutomationsStore(root)
    await store.createDefinition(
      definition('hooked', {
        trigger: {
          kind: WEBHOOK_TRIGGER_KIND,
          config: { kind: WEBHOOK_TRIGGER_KIND, path: 'incoming', secret: 'super-secret-value-1234' },
        },
      }),
    )

    const index = await buildAutomationsInstanceIndex({
      projectFolders: [{ workspaceId: 'ws', folderPath: root }],
      createStore: (workspaceRoot) => new AutomationsStore(workspaceRoot),
      mapDefinition: (def) => {
        const config = def.trigger.config as Record<string, unknown>
        if (def.trigger.kind !== WEBHOOK_TRIGGER_KIND) return def
        const { secret, ...rest } = config
        return { ...def, trigger: { ...def.trigger, config: { ...rest, hasSecret: typeof secret === 'string' } } }
      },
    })

    const config = index.entries[0].definition.trigger.config as Record<string, unknown>
    assert.equal('secret' in config, false, 'secret is redacted')
    assert.equal(config.hasSecret, true, 'hasSecret marker set')
  }

  console.log('ok - automations instance-index')

  await suiteRun
})
