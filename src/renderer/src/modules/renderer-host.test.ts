import assert from 'node:assert/strict'

import { createRendererHost, type WorkspaceTypeDefinition } from './renderer-host'
import type { NotificationActionContext } from './renderer-host'
import type { AppNotification, LayoutTemplate } from '../types/workspace'

const template: LayoutTemplate = {
  id: 'workspace-type-test',
  name: 'Workspace Type Test',
  description: 'Test template',
  previewSlots: [],
  layout: {
    global: { tabSetEnableDrop: true, tabEnableClose: false },
    borders: [],
    layout: {
      type: 'row',
      children: [],
    },
  },
}

function workspaceType(id: string, pickerOrder?: number): WorkspaceTypeDefinition {
  return {
    id,
    label: id,
    description: `${id} workspace`,
    icon() {
      throw new Error('icon component should not be evaluated during registration')
    },
    accentToken: `--tool-${id}`,
    searchTerms: [`${id}-term`],
    createTemplate() {
      return template
    },
    topBarViews: {
      label: id,
      views: [{ component: `${id}-view`, name: id }],
    },
    supervisors: [],
    creationStepsId: id,
    pickerOrder,
  }
}

const host = createRendererHost()
const sprintType = workspaceType('sprintengine', 20)
const switchboardType = workspaceType('switchboard', 10)
const multiloopType = workspaceType('multiloop', 10)

host.hostFor('sprint-engine').registerWorkspaceType(sprintType)
host.hostFor('switchboard').registerWorkspaceType(switchboardType)
host.hostFor('multiloop').registerWorkspaceType(multiloopType)

assert.throws(
  () => host.hostFor('other').registerWorkspaceType(workspaceType('sprintengine')),
  /Workspace type "sprintengine" is already registered/,
  'duplicate workspace type ids fail clearly',
)
assert.throws(
  () => host.hostFor('core').registerWorkspaceType(workspaceType('standard')),
  /shell-owned/,
  'standard stays owned by the workspace shell',
)
assert.throws(
  () => host.hostFor('blank').registerWorkspaceType(workspaceType('')),
  /non-empty string/,
  'blank workspace type ids are rejected before registration',
)
assert.throws(
  () => host.hostFor('blank').registerWorkspaceType(workspaceType('   ')),
  /non-empty string/,
  'whitespace-only workspace type ids are rejected before registration',
)

assert.equal(host.getWorkspaceType('sprintengine')?.moduleId, 'sprint-engine')
assert.equal(host.getWorkspaceType('sprintengine')?.createTemplate(), template)
assert.equal(host.getWorkspaceTypeModule('switchboard'), 'switchboard')
assert.equal(host.getWorkspaceType('missing'), undefined)
assert.equal(host.getWorkspaceTypeModule('missing'), undefined)

assert.deepEqual(
  host.getWorkspaceTypes().map((definition) => definition.id),
  ['multiloop', 'switchboard', 'sprintengine'],
  'workspace types sort by pickerOrder, then id',
)
assert.deepEqual(
  host.getWorkspaceTypes((moduleId) => moduleId !== 'switchboard').map((definition) => definition.id),
  ['multiloop', 'sprintengine'],
  'disabled modules are filtered from workspace type listings',
)

console.log('renderer host workspace type tests passed')

// --- Module command registry -------------------------------------------------

const commandHost = createRendererHost()
let helloRuns = 0
commandHost.hostFor('demo-module').registerCommand({
  id: 'hello',
  title: 'Say Hello',
  category: 'Demo Module',
  scopes: ['global'],
  defaultKeybindings: ['Primary+Alt+H', 'Primary+Alt+H'],
  run() {
    helloRuns += 1
  },
})
commandHost.hostFor('other-module').registerCommand({
  id: 'hello',
  title: 'Other Hello',
  category: 'Other Module',
  scopes: ['workspace'],
  run() {},
})

const registeredHello = commandHost.getModuleCommand('demo-module.hello')
assert.ok(registeredHello, 'module command registers under its namespaced id')
assert.equal(registeredHello.moduleId, 'demo-module', 'owning module is recorded for enablement gating')
assert.deepEqual(
  registeredHello.defaultKeybindings,
  ['primary+alt+h'],
  'default keybindings are normalized and de-duplicated like the shell registry',
)
registeredHello.run()
assert.equal(helloRuns, 1, 'the registered handler is the module-provided callback')

assert.equal(
  commandHost.getModuleCommand('other-module.hello')?.title,
  'Other Hello',
  'the same bare id under another module is a distinct command',
)

assert.throws(
  () => commandHost.hostFor('demo-module').registerCommand({
    id: 'hello',
    title: 'Say Hello Again',
    category: 'Demo Module',
    scopes: ['global'],
    run() {},
  }),
  /Module command "demo-module\.hello" is already registered/,
  'duplicate command-id registration is an explicit error',
)
assert.throws(
  () => commandHost.hostFor('workspace').registerCommand({
    id: 'new',
    title: 'Shadow New Workspace',
    category: 'Shadow',
    scopes: ['global'],
    run() {},
  }),
  /already registered by the application command registry/,
  'a module cannot take over a shell command id',
)
assert.throws(
  () => commandHost.hostFor('demo-module').registerCommand({
    id: '   ',
    title: 'Blank',
    category: 'Demo Module',
    scopes: ['global'],
    run() {},
  }),
  /non-empty string/,
  'blank command ids are rejected',
)
assert.throws(
  () => commandHost.hostFor('demo-module').registerCommand({
    id: 'untitled',
    title: '  ',
    category: 'Demo Module',
    scopes: ['global'],
    run() {},
  }),
  /non-empty title/,
  'blank titles are rejected',
)
assert.throws(
  () => commandHost.hostFor('demo-module').registerCommand({
    id: 'scopeless',
    title: 'No Scope',
    category: 'Demo Module',
    scopes: [],
    run() {},
  }),
  /at least one scope/,
  'commands must declare a scope so dispatch and the palette can gate them',
)

assert.deepEqual(
  commandHost.getModuleCommands().map((command) => command.id),
  ['demo-module.hello', 'other-module.hello'],
  'module command listing is deterministic',
)
assert.deepEqual(
  commandHost.getModuleCommands((moduleId) => moduleId !== 'demo-module').map((command) => command.id),
  ['other-module.hello'],
  'disabled modules are filtered from module command listings',
)

const merged = commandHost.getCommandContributions()
assert.equal(merged[0]?.id, 'app.settings.open', 'merge point keeps shell commands first (dispatch priority)')
assert.ok(
  merged.some((command) => command.id === 'demo-module.hello'),
  'merge point includes enabled module commands',
)
const mergedWithoutDemo = commandHost.getCommandContributions((moduleId) => moduleId !== 'demo-module')
assert.equal(
  mergedWithoutDemo.some((command) => command.id === 'demo-module.hello'),
  false,
  'merge point drops commands of disabled modules',
)
assert.ok(
  mergedWithoutDemo.some((command) => command.id === 'other-module.hello'),
  'other modules stay merged when one module is disabled',
)
// Re-enabling restores the contribution from the same registration — nothing
// is torn down on disable, so user keybinding overrides stored by command id
// re-attach without a reload.
assert.ok(
  commandHost.getCommandContributions(() => true).some((command) => command.id === 'demo-module.hello'),
  're-enabling restores the registered command',
)

console.log('renderer host module command tests passed')

// --- Settings section registry -----------------------------------------------

const sectionHost = createRendererHost()
const sectionIcon = () => {
  throw new Error('icon component should not be evaluated during registration')
}
const sectionComponent = () => {
  throw new Error('section component should not be evaluated during registration')
}
sectionHost.hostFor('demo-module').registerSettingsSection({
  id: 'demo-general',
  label: 'Demo Module',
  icon: sectionIcon,
  Component: sectionComponent,
  order: 20,
})
sectionHost.hostFor('other-module').registerSettingsSection({
  id: 'other-general',
  label: 'Other Module',
  description: 'Other module preferences',
  icon: sectionIcon,
  Component: sectionComponent,
  order: 10,
})

assert.equal(
  sectionHost.getSettingsSections().find((section) => section.id === 'demo-general')?.moduleId,
  'demo-module',
  'settings sections record their owning module for enablement gating',
)
assert.throws(
  () => sectionHost.hostFor('third-module').registerSettingsSection({
    id: 'demo-general',
    label: 'Impostor',
    icon: sectionIcon,
    Component: sectionComponent,
  }),
  /Settings section "demo-general" is already registered by module "demo-module"/,
  'duplicate section ids fail with an explicit error naming the owner',
)
assert.throws(
  () => sectionHost.hostFor('demo-module').registerSettingsSection({
    id: '   ',
    label: 'Blank',
    icon: sectionIcon,
    Component: sectionComponent,
  }),
  /non-empty string/,
  'blank section ids are rejected',
)
assert.deepEqual(
  sectionHost.getSettingsSections().map((section) => section.id),
  ['other-general', 'demo-general'],
  'sections sort by order hint then id — stable across reloads',
)
assert.deepEqual(
  sectionHost.getSettingsSections((moduleId) => moduleId !== 'demo-module').map((section) => section.id),
  ['other-general'],
  'a disabled module\'s section is filtered out reactively',
)
assert.deepEqual(
  sectionHost.getSettingsSections(() => true).map((section) => section.id),
  ['other-general', 'demo-general'],
  're-enabling restores the registered section without re-registration',
)

console.log('renderer host settings section tests passed')

// --- Notification action providers ---

function notification(overrides: Partial<AppNotification> = {}): AppNotification {
  return {
    id: 'n1',
    timestamp: '2026-06-16T00:00:00.000Z',
    level: 'warning',
    source: 'sprintengine',
    title: 'Needs input',
    message: 'A task is waiting.',
    read: false,
    workspaceId: 'ws-1',
    ...overrides,
  }
}

const notificationHost = createRendererHost()
let revealed: string | null = null
const context: NotificationActionContext = {
  notification: notification({ navigationTarget: { kind: 'task', ref: 'T-7' } }),
  revealWorkspace: (id) => {
    revealed = id
  },
}

notificationHost.hostFor('sprint-engine').registerNotificationActionProvider({
  source: 'sprintengine',
  resolveActions: ({ notification: entry, revealWorkspace }) => {
    const target = entry.navigationTarget
    if (!entry.workspaceId || target?.kind !== 'task' || !target.ref) return []
    return [
      {
        id: 'open-task',
        label: 'Open',
        run: () => revealWorkspace(entry.workspaceId as string),
      },
    ]
  },
})

assert.throws(
  () =>
    notificationHost.hostFor('other').registerNotificationActionProvider({
      source: 'sprintengine',
      resolveActions: () => [],
    }),
  /Notification action provider for source "sprintengine" is already registered by module "sprint-engine"/,
  'one provider per source — a duplicate source registration fails clearly',
)

const providers = notificationHost.getNotificationActionProviders()
assert.equal(providers.length, 1, 'the registered provider is returned')
assert.equal(providers[0]?.moduleId, 'sprint-engine', 'the provider records its owning module')

const actions = providers[0]!.resolveActions(context)
assert.deepEqual(
  actions.map((action) => action.id),
  ['open-task'],
  'resolveActions surfaces the deep-link action for a task-targeted notification',
)
actions[0]!.run(context)
assert.equal(revealed, 'ws-1', 'running the action composes the shell revealWorkspace capability')

assert.deepEqual(
  providers[0]!.resolveActions({
    notification: notification({ navigationTarget: undefined }),
    revealWorkspace: () => {},
  }),
  [],
  'a notification with no task target yields no provider action (shell reveal fallback covers it)',
)

assert.deepEqual(
  notificationHost.getNotificationActionProviders((moduleId) => moduleId !== 'sprint-engine'),
  [],
  'a disabled module\'s provider is filtered out reactively',
)

console.log('renderer host notification action provider tests passed')
