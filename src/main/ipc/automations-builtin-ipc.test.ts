import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { WorkspaceSyncSnapshot } from '../../shared/workspace-sync'
import type { AutomationsBuiltinInstallResult, AutomationsBuiltinListResult } from '../../shared/automations/contracts'
import {
  AUTOMATIONS_BUILTIN_INSTALL_CHANNEL,
  AUTOMATIONS_BUILTIN_LIST_CHANNEL,
} from '../../shared/automations/contracts'
import { BUILTIN_AUTOMATIONS } from '../../shared/automations/builtin'
import { createAutomationsEngine } from '../automations/engine'
import { createBuiltInAutomationProviderRegistry } from '../automations/provider-registry'
import { AutomationsStore } from '../automations/store'
import type { IpcInvokeHandler } from '../module-host/main-host'
import { registerAutomationsIpc } from './automations-ipc'
import { test } from 'vitest'

test('automations-builtin-ipc', async () => {
  // A file of its own rather than another case in automations-ipc.test.ts: that
  // suite is one `main()` that stops at the first throw, and it currently throws
  // in `testProviderList` on a permission-preset enum that drifted before this
  // change (it fails on main too). Appending here would have meant a new test that
  // silently never ran.

  type HandlerMap = Map<string, IpcInvokeHandler>

  const NOW = Date.parse('2026-09-05T00:00:00.000Z')

  function workspaceSnapshot(workspaceRoots: string[]): WorkspaceSyncSnapshot {
    return {
      sequence: 1,
      state: {
        activeWorkspaceId: workspaceRoots[0] ? 'ws-1' : null,
        primaryWorkspaceWindowId: 'primary',
        workspaceWindows: [],
        workspaces: workspaceRoots.map((folderPath, index) => ({ id: `ws-${index + 1}`, folderPath })),
      },
    } as unknown as WorkspaceSyncSnapshot
  }

  // The real provider registry and the real store: the point of this test is that
  // a built-in add lands through the same validation every other write gets, so
  // nothing in the write path is stubbed out.
  function createFakeHost({ workspaceRoots }: { workspaceRoots: string[] }): HandlerMap {
    const handlers: HandlerMap = new Map()
    const providerRegistry = createBuiltInAutomationProviderRegistry()
    registerAutomationsIpc(
      {
        registerIpc(channel, handler) {
          handlers.set(channel, handler)
        },
      },
      {
        engine: createAutomationsEngine({
          createStore: (workspaceRoot) => new AutomationsStore(workspaceRoot),
          getProjectFolders: () =>
            workspaceRoots.map((folderPath, index) => ({ workspaceId: `ws-${index + 1}`, folderPath })),
          runAutomation: async () => ({ status: 'completed', summary: 'ran' }),
          now: () => NOW,
          createRunId: ({ automationId, dueAt }) => `${automationId}-${Date.parse(dueAt)}`,
        }),
        triggerProviders: providerRegistry.listTriggerProviders(),
        actionProviders: providerRegistry.listActionProviders(),
        getWorkspaceSyncSnapshot: () => workspaceSnapshot(workspaceRoots),
        now: () => NOW,
      },
    )
    return handlers
  }

  async function invoke<T>(handlers: HandlerMap, channel: string, input?: unknown): Promise<T> {
    const handler = handlers.get(channel)
    assert.ok(handler, `expected handler for ${channel}`)
    return (await handler({} as never, input)) as T
  }

  async function withWorkspaceRoot(): Promise<string> {
    return mkdtemp(join(tmpdir(), 'multicode-automations-builtin-'))
  }

  // The five automations that ship inside the app (Extensions drawer ruling,
  // 2026-09-05, frame 4). The renderer reads what ships rather than importing it,
  // and adds one by NAMING it — so main both answers the list and owns the write.
  // What matters here is that the write is the same catalogue install a shelf Get
  // performed: keyed on the built-in's stable id, refusing a project the app does
  // not have open, and idempotent, because "Add" is offered against a project that
  // may already hold the copy.
  async function testBuiltinListAndAddGoThroughTheCatalogueWrite(): Promise<void> {
    const knownRoot = await withWorkspaceRoot()
    const outsideRoot = await mkdtemp(join(tmpdir(), 'multicode-automations-ipc-builtin-'))
    const handlers = createFakeHost({ workspaceRoots: [knownRoot] })

    const listed = await invoke<AutomationsBuiltinListResult>(handlers, AUTOMATIONS_BUILTIN_LIST_CHANNEL)
    assert.equal(listed.ok, true)
    if (!listed.ok) return
    assert.equal(listed.value.length, 5, 'five ship')
    assert.deepEqual(
      listed.value.map((entry) => entry.id),
      BUILTIN_AUTOMATIONS.map((entry) => entry.id),
      'and they are the shipped records, in the shipped order',
    )
    for (const entry of listed.value) {
      assert.equal(entry.builtin, true, `${entry.name} is marked built in over the wire`)
    }

    const unknown = await invoke<AutomationsBuiltinInstallResult>(handlers, AUTOMATIONS_BUILTIN_INSTALL_CHANNEL, {
      workspaceRoot: knownRoot,
      builtinId: 'not-a-thing',
    })
    assert.equal(unknown.ok, false)
    if (!unknown.ok)
      assert.equal(unknown.code, 'not_found', 'an id this build does not ship is refused, not improvised')

    const wrongProject = await invoke<AutomationsBuiltinInstallResult>(handlers, AUTOMATIONS_BUILTIN_INSTALL_CHANNEL, {
      workspaceRoot: outsideRoot,
      builtinId: 'dead-code-sweep-automation',
    })
    assert.equal(wrongProject.ok, false)
    if (!wrongProject.ok) assert.equal(wrongProject.code, 'workspace_root_untrusted')
    const outsideDefinitions = await new AutomationsStore(outsideRoot).listDefinitions()
    assert.equal(
      outsideDefinitions.ok && outsideDefinitions.values.length,
      0,
      'a project the app does not have open is never written to',
    )

    const added = await invoke<AutomationsBuiltinInstallResult>(handlers, AUTOMATIONS_BUILTIN_INSTALL_CHANNEL, {
      workspaceRoot: knownRoot,
      builtinId: 'dead-code-sweep-automation',
    })
    assert.equal(added.ok, true, added.ok ? '' : added.message)
    if (!added.ok) return
    assert.equal(added.value.alreadyAdded, false)
    assert.equal(added.value.workspaceRoot, knownRoot)
    assert.equal(added.value.definition.name, 'Dead code sweep')
    assert.equal(added.value.definition.status, 'enabled', 'it arrives armed')
    // The provenance pair is what makes the surface's "Added" answerable, and the
    // id it records is the built-in's own — never a name.
    assert.equal(added.value.definition.sourceCatalogueId, 'dead-code-sweep-automation')
    assert.equal(added.value.definition.sourcePublisher, 'Multicode Labs')
    assert.notEqual(added.value.definition.id, 'dead-code-sweep-automation', 'the store issues the record id')
    // The catalogue write resolves the authored zone into the host's, so the
    // wall-clock the rail promised ("Nightly 02:00") is 02:00 where it now runs.
    const installedTrigger = added.value.definition.trigger.config as {
      timezone: string
      cadence: { timeLocal: string }
    }
    assert.equal(installedTrigger.cadence.timeLocal, '02:00')
    assert.equal(installedTrigger.timezone, Intl.DateTimeFormat().resolvedOptions().timeZone)

    const again = await invoke<AutomationsBuiltinInstallResult>(handlers, AUTOMATIONS_BUILTIN_INSTALL_CHANNEL, {
      workspaceRoot: knownRoot,
      builtinId: 'dead-code-sweep-automation',
    })
    assert.equal(again.ok, true)
    if (!again.ok) return
    assert.equal(again.value.alreadyAdded, true, 'adding one the project has is a no-op that reports the copy it has')
    assert.equal(again.value.definition.id, added.value.definition.id)
    const stored = await new AutomationsStore(knownRoot).listDefinitions()
    assert.equal(stored.ok && stored.values.length, 1, 'and writes no duplicate')
  }

  async function main(): Promise<void> {
    await testBuiltinListAndAddGoThroughTheCatalogueWrite()
    console.log('automations built-in ipc tests passed')
  }

  const suiteRun = main()

  await suiteRun
})
