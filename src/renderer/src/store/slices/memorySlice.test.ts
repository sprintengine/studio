import assert from 'node:assert/strict'

import type { AppSettings, Workspace } from '../../types/workspace'
import { defaultAppSettings } from './settingsSlice'
import {
  createMemorySlice,
  defaultWorkspaceMemoryConfig,
  isAbsolutePath,
  normalizeMemoryRelativeRoot,
  normalizeProjectKnowledgeRoots,
  normalizeWorkspaceMemoryConfig,
} from './memorySlice'

assert.equal(normalizeMemoryRelativeRoot(' knowledge '), 'knowledge')
assert.equal(normalizeMemoryRelativeRoot('docs/'), 'docs')
assert.equal(normalizeMemoryRelativeRoot('docs\\sub'), 'docs/sub')
assert.equal(normalizeMemoryRelativeRoot('.'), null)
assert.equal(normalizeMemoryRelativeRoot(''), null)
assert.equal(normalizeMemoryRelativeRoot('/absolute'), null)
assert.equal(normalizeMemoryRelativeRoot('C:\\Users'), null)
assert.equal(normalizeMemoryRelativeRoot(null), null)

assert.equal(isAbsolutePath('/etc'), true)
assert.equal(isAbsolutePath('C:/Users'), true)
assert.equal(isAbsolutePath('\\\\server\\share'), true)
assert.equal(isAbsolutePath('relative/path'), false)

const defaults = defaultWorkspaceMemoryConfig()
assert.equal(defaults.relativeRoot, null)
assert.ok(defaults.graphSettings)

const normalizedMemory = normalizeWorkspaceMemoryConfig({ relativeRoot: ' docs ' })
assert.equal(normalizedMemory.relativeRoot, 'docs')

const populatedWorkspace = {
  folderPath: '/Users/example/project',
  memory: { relativeRoot: 'knowledge' },
} as Workspace

const roots = normalizeProjectKnowledgeRoots(
  {
    '/Users/example/project/': ' docs/knowledge ',
    '/Users/example/bad': '/absolute',
    '': 'should-skip',
  },
  [populatedWorkspace],
)
assert.deepEqual(roots, { '/Users/example/project': 'docs/knowledge' })

const fallbackRoots = normalizeProjectKnowledgeRoots(undefined, [populatedWorkspace])
assert.deepEqual(fallbackRoots, { '/Users/example/project': 'knowledge' })

type Carrier = { workspaces: Workspace[]; appSettings: AppSettings }
const carrier: Carrier = {
  workspaces: [
    {
      id: 'ws-1',
      folderPath: '/Users/example/project',
      memory: { relativeRoot: 'knowledge', graphSettings: defaults.graphSettings },
    } as unknown as Workspace,
    {
      id: 'ws-2',
      folderPath: '/Users/example/other',
      memory: { relativeRoot: 'docs', graphSettings: defaults.graphSettings },
    } as unknown as Workspace,
  ],
  appSettings: defaultAppSettings(),
}
const memorySlice = createMemorySlice((mutator) => mutator(carrier))

memorySlice.setProjectKnowledgeRoot('/Users/example/project/', ' docs ')
assert.deepEqual(carrier.appSettings.projectKnowledgeRoots, {
  '/Users/example/project': 'docs',
  '/Users/example/other': 'docs',
})
assert.equal(carrier.workspaces[0].memory?.relativeRoot, null)
assert.equal(carrier.workspaces[1].memory?.relativeRoot, 'docs')

memorySlice.setProjectKnowledgeRoot('/Users/example/project', null)
assert.equal(
  Object.prototype.hasOwnProperty.call(
    carrier.appSettings.projectKnowledgeRoots,
    '/Users/example/project',
  ),
  false,
)

memorySlice.setWorkspaceMemoryRelativeRoot('ws-2', ' notes/sub ')
assert.equal(carrier.workspaces[1].memory?.relativeRoot, 'notes/sub')

memorySlice.updateMemoryGraphSettings('ws-2', (current) => ({ ...current, sidebarOpen: !current.sidebarOpen }))
assert.ok(carrier.workspaces[1].memory?.graphSettings)

console.log('memorySlice.test.ts: ok')
