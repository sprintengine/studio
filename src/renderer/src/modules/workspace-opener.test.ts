import assert from 'node:assert/strict'
import { createRendererHost, type RegisteredWorkspaceTypeDefinition } from './renderer-host'
import { createWorkspaceOpener, firstWorkspaceOpenedKey } from './workspace-opener'

function fixture(ready = Promise.resolve()) {
  const types: RegisteredWorkspaceTypeDefinition[] = [{
    id: 'game', moduleId: 'game-module', label: 'Game', description: 'A game', icon: () => null,
    openOnFirstLoad: true,
    createTemplate: () => ({
      id: 'game', name: 'Game', description: 'Game', previewSlots: [],
      layout: { global: {}, borders: [], layout: { type: 'row', children: [] } },
    }),
  }]
  const workspaces = new Map<string, string>()
  const markers = new Set<string>()
  const focus: string[] = []
  const errors: unknown[] = []
  let created = 0
  let enabled = true
  let primary = true
  const opener = createWorkspaceOpener({
    ready, types: () => types, enabled: () => enabled, isPrimaryWindow: () => primary,
    findWorkspace: (typeId) => workspaces.get(typeId),
    createWorkspace: (type) => {
      type.createTemplate()
      const id = `workspace-${++created}`
      workspaces.set(type.id, id)
      return id
    },
    focusWorkspace: (id) => { focus.push(id) },
    wasOpened: (moduleId, key) => markers.has(`${moduleId}/${key}`),
    markOpened: (moduleId, key) => { markers.add(`${moduleId}/${key}`) },
    onError: (_typeId, error) => { errors.push(error) },
  })
  return { opener, types, workspaces, markers, focus, errors,
    created: () => created, enable: (value: boolean) => { enabled = value },
    primary: (value: boolean) => { primary = value } }
}

async function main() {
  const first = fixture()
  await Promise.all([first.opener.openFirstLoads(), first.opener.openFirstLoads()])
  assert.equal(first.created(), 1, 'concurrent first-load callbacks create one workspace')
  assert.deepEqual(first.focus, ['workspace-1'])
  assert.ok(first.markers.has(`game-module/${firstWorkspaceOpenedKey('game')}`))
  first.workspaces.clear()
  await first.opener.openFirstLoads()
  assert.equal(first.created(), 1, 'closing a workspace does not automatically recreate it')
  await first.opener.open('game')
  assert.equal(first.created(), 2, 'an explicit command can reopen a closed workspace')
  await Promise.all([first.opener.open('game'), first.opener.open('game')])
  assert.equal(first.created(), 2, 'explicit opens reuse an existing workspace')

  const restarted = fixture()
  first.markers.forEach((key) => restarted.markers.add(key))
  await restarted.opener.openFirstLoads()
  assert.equal(restarted.created(), 0, 'persisted marker suppresses creation after restart, even if closed')
  assert.deepEqual(restarted.focus, [], 'restart does not steal focus')

  const disabled = fixture()
  disabled.enable(false)
  await disabled.opener.openFirstLoads()
  assert.equal(disabled.created(), 0)
  await assert.rejects(disabled.opener.open('game'), /unavailable or disabled/)
  disabled.enable(true)
  await disabled.opener.openFirstLoads()
  assert.equal(disabled.created(), 1, 'first enablement still opens a never-opened type')

  const detached = fixture()
  detached.primary(false)
  await detached.opener.openFirstLoads()
  assert.equal(detached.created(), 0, 'detached windows never auto-create')
  await detached.opener.open('game')
  assert.equal(detached.created(), 1, 'explicit commands still work in detached windows')

  let finishHydration!: () => void
  const delayed = fixture(new Promise<void>((resolve) => { finishHydration = resolve }))
  const delayedOpen = delayed.opener.openFirstLoads()
  assert.equal(delayed.created(), 0, 'wait for saved registry before creating')
  delayed.workspaces.set('game', 'saved-workspace')
  finishHydration()
  await delayedOpen
  assert.equal(delayed.created(), 0)
  assert.deepEqual(delayed.focus, ['saved-workspace'], 'reuse restored workspace')

  const broken = fixture()
  broken.types[0]!.createTemplate = () => { throw new Error('bad layout') }
  await broken.opener.openFirstLoads()
  assert.equal(broken.markers.size, 0, 'failed creation is not persisted as success')
  assert.equal(broken.errors.length, 1)
  await broken.opener.openFirstLoads()
  assert.equal(broken.errors.length, 1, 'broken plugin cannot loop on store changes')

  const configured = fixture()
  configured.types[0]!.createWorkspace = async () => undefined
  await assert.rejects(configured.opener.open('game'), /requires setup/)
  assert.equal(configured.created(), 0, 'never bypass a type creation hook')
  await assert.rejects(configured.opener.open('unknown'), /unavailable/)

  const kernel = createRendererHost()
  const moduleHost = kernel.hostFor('game-module')
  moduleHost.registerWorkspaceType(fixture().types[0]!)
  kernel.setWorkspaceOpener(async () => 'opened')
  assert.equal(await moduleHost.openWorkspace('game'), 'opened')
  await assert.rejects(kernel.hostFor('other').openWorkspace('game'), /not registered by module/)
  kernel.setModuleEnablementResolver(() => false)
  await assert.rejects(moduleHost.openWorkspace('game'), /disabled/)
  console.log('workspace opener tests passed')
}

void main().catch((error) => { console.error(error); process.exitCode = 1 })
