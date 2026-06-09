import assert from 'node:assert/strict'

import { backlogApi } from './backlog'

async function main(): Promise<void> {
  assert.equal(typeof backlogApi.readBacklogObjectStore, 'function')
  assert.equal(typeof backlogApi.ensureBacklogObjectRecords, 'function')
  assert.equal(typeof backlogApi.updateBacklogStatus, 'function')
  assert.equal(typeof backlogApi.addOrUpdateBacklogLink, 'function')
  assert.equal(typeof backlogApi.updateBacklogModuleMetadata, 'function')
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
