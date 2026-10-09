import assert from 'node:assert/strict'
import { afterEach, test } from 'vitest'

import type { CapabilityManifest } from '../../../shared/modules/manifest'
import { getSurfaceView, publishSurfaceView } from '../components/workspace/surfaceView'
import { createRendererHost, type ModuleToastSink } from './renderer-host'

// The renderer host's shell-facing members: who a module is, what it may tell
// the person (toast), where it may send them (openExternal, its own door from
// a bell row), and what it may know about the window (the active workspace,
// the surface view it publishes).

const Component = () => null
const Icon = () => null

function manifest(id: string, over: Partial<CapabilityManifest> = {}): CapabilityManifest {
  return { id, displayName: 'Task Board', version: 1, defaultEnabled: true, source: 'third-party', ...over }
}

afterEach(() => {
  publishSurfaceView('acme.board', null)
})

test('a host knows its module id', () => {
  const kernel = createRendererHost()
  assert.equal(kernel.hostFor('acme.board').moduleId, 'acme.board')
  assert.equal(kernel.hostFor('acme.radar', manifest('acme.radar')).moduleId, 'acme.radar')
})

test('supports() answers the window-wired capabilities live', () => {
  const kernel = createRendererHost()
  const host = kernel.hostFor('acme.board')
  for (const capability of ['notifications', 'toast', 'open-external']) {
    assert.equal(host.supports(capability), false, `${capability} is false until the window wires it`)
  }
  for (const capability of ['module-id', 'command-context', 'active-workspace', 'surface-view', 'door-badges']) {
    assert.equal(host.supports(capability), true, `${capability} is real in this build`)
  }
  kernel.setModuleNotificationsWired(true)
  kernel.setToastSink(() => () => undefined)
  kernel.setExternalLinkOpener(async () => ({ ok: true }))
  assert.equal(host.supports('notifications'), true)
  assert.equal(host.supports('toast'), true)
  assert.equal(host.supports('open-external'), true)
  kernel.setToastSink(null)
  assert.equal(host.supports('toast'), false, 'a toast region that unmounted takes the answer with it')
})

test('a toast is validated, stamped with the module name, and gated on enablement', () => {
  const kernel = createRendererHost()
  const host = kernel.hostFor('acme.board', manifest('acme.board'))
  const shown: Parameters<ModuleToastSink>[0][] = []
  let dismissed = 0

  assert.doesNotThrow(() => host.toast({ tone: 'good', message: 'Saved' })(), 'unwired: shows nothing, no throw')

  kernel.setToastSink((input) => {
    shown.push(input)
    return () => {
      dismissed += 1
    }
  })
  assert.throws(() => host.toast({ tone: 'loud' as never, message: 'x' }), /tone/)
  assert.throws(() => host.toast({ tone: 'good', message: '   ' }), /non-empty message/)
  assert.throws(() => host.toast({ tone: 'good', message: 'x', action: { label: '', run: () => {} } }), /action/)
  assert.equal(shown.length, 0, 'an invalid toast never reaches the region')

  let ran = 0
  const dismiss = host.toast({
    tone: 'good',
    message: `  ${'Skill installed '.repeat(20)}  `,
    detail: ' in acme/app ',
    action: {
      label: ' Open ',
      run: () => {
        ran += 1
        throw new Error('the module bug stays the module bug')
      },
    },
  })
  assert.equal(shown.length, 1)
  assert.equal(shown[0]?.moduleName, 'Task Board', 'the name is the manifest display name, stamped by the host')
  assert.equal(shown[0]?.moduleId, 'acme.board')
  assert.equal(shown[0]?.message.length, 200, 'the message is clipped')
  assert.equal(shown[0]?.detail, 'in acme/app')
  assert.equal(shown[0]?.action?.label, 'Open')
  assert.doesNotThrow(() => shown[0]?.action?.run(), 'a throwing action is contained')
  assert.equal(ran, 1)
  dismiss()
  assert.equal(dismissed, 1)

  kernel.setModuleEnablementResolver(() => false)
  host.toast({ tone: 'neutral', message: 'Off' })
  assert.equal(shown.length, 1, 'a disabled module shows nothing')
})

test('the active workspace reads and watches the wired source, deduped', () => {
  const kernel = createRendererHost()
  const host = kernel.hostFor('acme.board')
  const unwired: Array<string | null> = []
  host.watchActiveWorkspace((id) => unwired.push(id))
  assert.deepEqual(unwired, [null], 'unwired, a watch still fires once')
  assert.equal(host.getActiveWorkspaceId(), null)

  let current: string | null = 'ws-1'
  const listeners = new Set<() => void>()
  kernel.setActiveWorkspaceSource({
    get: () => current,
    subscribe: (onChange) => {
      listeners.add(onChange)
      return () => listeners.delete(onChange)
    },
  })
  const seen: Array<string | null> = []
  const stop = host.watchActiveWorkspace((id) => seen.push(id))
  const fire = () => {
    for (const listener of [...listeners]) listener()
  }
  fire()
  current = 'ws-2'
  fire()
  current = null
  fire()
  stop()
  current = 'ws-3'
  fire()
  assert.deepEqual(seen, ['ws-1', 'ws-2', null], 'once now, then each change, until unsubscribed')
  assert.equal(host.getActiveWorkspaceId(), 'ws-3')
})

test("setSurfaceView publishes one of the module's own views only", () => {
  const kernel = createRendererHost()
  const board = kernel.hostFor('acme.board')
  board.registerGlobalSurface({
    id: 'acme.board',
    label: 'Board',
    Icon,
    views: [
      { id: 'lanes', label: 'Lanes', Icon, open: () => {} },
      { id: 'archive', label: 'Archive', Icon, open: () => {} },
    ],
    Component,
  })
  kernel.hostFor('acme.other').registerGlobalSurface({ id: 'acme.other', Component })

  assert.equal(board.setSurfaceView('acme.board', 'archive'), true)
  assert.equal(getSurfaceView('acme.board'), 'archive')
  assert.equal(board.setSurfaceView('acme.board', 'nope'), false, 'an undeclared view is refused')
  assert.equal(getSurfaceView('acme.board'), 'archive')
  assert.equal(board.setSurfaceView('acme.other', null), false, "another module's surface is refused")
  assert.equal(board.setSurfaceView('acme.board', null), true)
  assert.equal(getSurfaceView('acme.board'), null)
  kernel.setModuleEnablementResolver(() => false)
  assert.equal(board.setSurfaceView('acme.board', 'lanes'), false, 'a disabled module publishes nothing')
})

test('openExternal takes http(s) only, through the wired opener', async () => {
  const kernel = createRendererHost()
  const host = kernel.hostFor('acme.radar')
  assert.deepEqual(await host.openExternal('https://github.com/acme/app/pull/12'), {
    ok: false,
    code: 'unavailable',
    message: 'This window cannot open links yet.',
  })
  const opened: string[] = []
  kernel.setExternalLinkOpener(async (url) => {
    opened.push(url)
    return url.includes('refuse') ? { ok: false, message: 'No handler.' } : { ok: true }
  })
  for (const bad of [
    'javascript:alert(1)',
    'file:///etc/passwd',
    'mailto:dev@example.com',
    '/relative',
    '',
    'https://user:pw@example.com/',
  ]) {
    const result = await host.openExternal(bad)
    assert.equal(result.ok ? 'ok' : result.code, 'invalid_url', bad)
  }
  assert.deepEqual(await host.openExternal('https://github.com/acme/app/pull/12'), { ok: true })
  assert.deepEqual(await host.openExternal('https://example.com/refuse'), {
    ok: false,
    code: 'failed',
    message: 'No handler.',
  })
  assert.deepEqual(opened, ['https://github.com/acme/app/pull/12', 'https://example.com/refuse'])
})

test('an installed module may claim only its own notification source', () => {
  const kernel = createRendererHost()
  const thirdParty = kernel.hostFor('acme.radar', manifest('acme.radar'))
  assert.throws(
    () => thirdParty.registerNotificationActionProvider({ source: 'cli', resolveActions: () => [] }),
    /only register a notification action provider for its own rows/,
  )
  assert.doesNotThrow(() =>
    thirdParty.registerNotificationActionProvider({ source: 'acme.radar', resolveActions: () => [] }),
  )
  // A bundled module still owns the core sources it always did.
  const bundled = kernel.hostFor('agent-runtime', manifest('agent-runtime', { source: 'bundled' }))
  assert.doesNotThrow(() => bundled.registerNotificationActionProvider({ source: 'cli', resolveActions: () => [] }))
})

test("a bell row's Open lands on its own module's door, and never another's", () => {
  const kernel = createRendererHost()
  const events: string[] = []
  kernel.hostFor('acme.insights').registerGlobalSurface({
    id: 'acme.insights',
    label: 'Insights',
    Icon,
    onOpen: () => events.push('plain-open'),
    views: [{ id: 'standup', label: 'Standup', Icon, open: () => events.push('latch:standup') }],
    Component,
  })
  kernel.hostFor('acme.other').registerGlobalSurface({ id: 'acme.other', Component })

  assert.equal(
    kernel.moduleSurfaceTargetOpener('acme.insights', { surfaceId: 'acme.insights' }),
    null,
    'nothing opens before the shell wires its opener',
  )
  kernel.setSurfaceOpener({ openGlobalSurface: (id) => events.push(`open:${id}`), openModalSurface: () => {} })

  kernel.moduleSurfaceTargetOpener('acme.insights', { surfaceId: 'acme.insights', viewId: 'standup' })?.()
  kernel.moduleSurfaceTargetOpener('acme.insights', { surfaceId: 'acme.insights' })?.()
  kernel.moduleSurfaceTargetOpener('acme.insights', { surfaceId: 'acme.insights', viewId: 'gone' })?.()
  assert.deepEqual(events, [
    'latch:standup',
    'open:acme.insights',
    'plain-open',
    'open:acme.insights',
    'plain-open',
    'open:acme.insights',
  ])
  assert.equal(kernel.moduleSurfaceTargetOpener('acme.insights', { surfaceId: 'acme.other' }), null)
  assert.equal(kernel.moduleSurfaceTargetOpener('acme.insights', { surfaceId: 'missing' }), null)
  kernel.setModuleEnablementResolver((id) => id !== 'acme.insights')
  assert.equal(kernel.moduleSurfaceTargetOpener('acme.insights', { surfaceId: 'acme.insights' }), null)
})

test('a module command runs with the context it was offered under', () => {
  const kernel = createRendererHost()
  const heard: unknown[] = []
  kernel.hostFor('acme.log').registerCommand({
    id: 'record',
    title: 'Record a decision',
    category: 'Decision Log',
    scopes: ['global'],
    run: (context) => {
      heard.push(context)
    },
  })
  kernel.hostFor('acme.log').registerCommand({
    id: 'legacy',
    title: 'Old handler',
    category: 'Decision Log',
    scopes: ['global'],
    run: () => {
      heard.push('zero-arg')
    },
  })
  const context = { activeWorkspaceId: 'ws-1', activeWorkspaceMode: 'standard' }
  void kernel.getModuleCommand('acme.log.record')?.run(context)
  void kernel.getModuleCommand('acme.log.legacy')?.run(context)
  assert.deepEqual(heard, [context, 'zero-arg'], 'a zero-argument handler is still a valid one')
})
