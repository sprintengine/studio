import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const explorerSource = readFileSync(
  join(process.cwd(), 'src/renderer/src/components/panels/FileExplorer.tsx'),
  'utf8',
)
const moduleSource = readFileSync(
  join(process.cwd(), 'src/renderer/src/modules/sprint-engine-module.ts'),
  'utf8',
)
const actionSource = readFileSync(
  join(process.cwd(), 'src/renderer/src/modules/sprint-engine-file-actions.ts'),
  'utf8',
)

assert.equal(
  explorerSource.includes('Run a sprint from'),
  false,
  'the explorer does not hard-code the sprint flyout label',
)
assert.equal(
  explorerSource.includes('create-markdown-sprintengine'),
  false,
  'the explorer does not hard-code sprint command ids',
)
assert.equal(
  explorerSource.includes('create-source-bundle-sprintengine'),
  false,
  'the explorer does not hard-code the source-bundle command id',
)
assert.match(
  explorerSource,
  /groupFileExplorerModuleActions\(contextMenu\.fileActions\)/,
  'the explorer renders registered file actions under a module group',
)
assert.match(
  moduleSource,
  /registerSprintEngineFileActions\(host\)/,
  'the Sprint Engine module registers the file actions',
)
assert.match(
  actionSource,
  /id: 'sprint-engine\.run-from-product-plan'/,
  'Product plan is a registered file action',
)
assert.match(
  actionSource,
  /id: 'sprint-engine\.run-from-implementation-plan'/,
  'Implementation plan is a registered file action',
)
assert.match(
  actionSource,
  /id: 'sprint-engine\.run-from-generic-handoff'/,
  'Generic handoff is a registered file action',
)
assert.match(
  actionSource,
  /id: 'sprint-engine\.run-from-source-bundle'/,
  'the source-bundle item is a registered file action',
)

console.log('file explorer file-action source contract passed')
