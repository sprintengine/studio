import assert from 'node:assert/strict'

import { resolveNotificationActions } from './notificationActions'
import type { AppNotification } from '../types/workspace'
import type { NotificationActionContext, RegisteredNotificationActionProvider } from '../modules/renderer-host'

// Minimal notification fixture; only source + workspaceId drive the gating.
function notification(over: Partial<AppNotification>): AppNotification {
  return {
    id: 'n1',
    level: 'error',
    source: 'automations',
    title: 'T',
    message: 'M',
    timestamp: '2026-01-01T00:00:00.000Z',
    read: false,
    ...over,
  } as AppNotification
}

function provider(
  source: RegisteredNotificationActionProvider['source'],
  resolveActions: RegisteredNotificationActionProvider['resolveActions'],
): RegisteredNotificationActionProvider {
  return { source, moduleId: source, resolveActions }
}

// --- Regression: a provider deep-link is offered even with NO workspaceId. ----
// This is the bug the Automations-screen retirement exposed: a manual Run-now
// failure publishes a source-'automations' notification with a run deep-link but
// no workspaceId (the screen has no backing workspace). The provider action must
// still be returned — previously the shell dropped ALL actions when workspaceId
// was absent.
{
  let ran = false
  const providers = [
    provider('automations', () => [{ id: 'automations.open-run', label: 'Open', run: () => { ran = true } }]),
  ]
  const actions = resolveNotificationActions({
    notification: notification({ source: 'automations', workspaceId: undefined }),
    providers,
    revealWorkspace: () => assert.fail('must not use the workspace-reveal fallback when a provider action exists'),
  })
  assert.deepEqual(actions.map((a) => a.id), ['automations.open-run'], 'provider action survives a missing workspaceId')
  actions[0].run()
  assert.equal(ran, true, 'the provider action runs')
}

// --- No provider match + workspaceId present -> generic reveal fallback. ------
{
  let revealed: string | null = null
  const actions = resolveNotificationActions({
    notification: notification({ source: 'terminal', workspaceId: 'ws-1' }),
    providers: [],
    revealWorkspace: (id) => { revealed = id },
  })
  assert.deepEqual(actions.map((a) => a.id), ['reveal-workspace'], 'falls back to a generic Open')
  assert.equal(actions[0].label, 'Open')
  actions[0].run()
  assert.equal(revealed, 'ws-1', 'generic Open reveals the named workspace')
}

// --- No provider match + no workspaceId -> no actions. ------------------------
{
  const actions = resolveNotificationActions({
    notification: notification({ source: 'terminal', workspaceId: undefined }),
    providers: [],
    revealWorkspace: () => assert.fail('nothing to reveal'),
  })
  assert.deepEqual(actions, [], 'no provider and no workspace yields no actions')
}

// --- Provider actions present do NOT also add the generic fallback. -----------
{
  const providers = [
    provider('automations', () => [{ id: 'automations.open-run', label: 'Open', run: () => {} }]),
  ]
  const actions = resolveNotificationActions({
    notification: notification({ source: 'automations', workspaceId: 'ws-1' }),
    providers,
    revealWorkspace: () => assert.fail('provider action replaces the generic fallback'),
  })
  assert.deepEqual(actions.map((a) => a.id), ['automations.open-run'], 'provider actions replace the generic reveal')
}

// --- Only providers matching the notification source are consulted. -----------
{
  const providers = [
    provider('sprintengine', () => [{ id: 'se.open', label: 'Open task', run: () => {} }]),
    provider('automations', () => [{ id: 'automations.open-run', label: 'Open', run: () => {} }]),
  ]
  const actions = resolveNotificationActions({
    notification: notification({ source: 'automations', workspaceId: 'ws-1' }),
    providers,
    revealWorkspace: () => {},
  })
  assert.deepEqual(actions.map((a) => a.id), ['automations.open-run'], 'cross-source providers are ignored')
}

// --- isVisible:false actions are filtered out (and can fall through). ---------
{
  const providers = [
    provider('automations', (ctx: NotificationActionContext) => [
      { id: 'hidden', label: 'Hidden', isVisible: () => false, run: () => {} },
      { id: 'shown', label: 'Shown', isVisible: () => Boolean(ctx.notification), run: () => {} },
    ]),
  ]
  const actions = resolveNotificationActions({
    notification: notification({ source: 'automations', workspaceId: 'ws-1' }),
    providers,
    revealWorkspace: () => {},
  })
  assert.deepEqual(actions.map((a) => a.id), ['shown'], 'isVisible:false actions are dropped')
}

// --- All provider actions hidden + workspaceId -> generic reveal returns. -----
{
  let revealed: string | null = null
  const providers = [
    provider('automations', () => [{ id: 'hidden', label: 'Hidden', isVisible: () => false, run: () => {} }]),
  ]
  const actions = resolveNotificationActions({
    notification: notification({ source: 'automations', workspaceId: 'ws-1' }),
    providers,
    revealWorkspace: (id) => { revealed = id },
  })
  assert.deepEqual(actions.map((a) => a.id), ['reveal-workspace'], 'all-hidden provider actions fall back to reveal')
  actions[0].run()
  assert.equal(revealed, 'ws-1')
}

console.log('notificationActions.test.ts: ok')
