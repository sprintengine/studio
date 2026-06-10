import assert from 'node:assert/strict'
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  addOrUpdateBacklogLink,
  readBacklogObjectStore,
  updateBacklogModuleMetadata,
  updateBacklogStatus,
} from './backlog-service'

async function main(): Promise<void> {
  const tempRoot = await mkdtemp(join(tmpdir(), 'multicode-backlog-service-'))

  try {
    const missing = await readBacklogObjectStore(tempRoot)
    assert.equal(missing.ok, true)
    assert.deepEqual(missing.ok ? missing.store : null, { schemaVersion: 1, items: [] })

    const statusUpdated = await updateBacklogStatus({
      workspaceRoot: tempRoot,
      relativePath: 'backlog/checkout.md',
      status: 'in_progress',
    })
    assert.equal(statusUpdated.ok, true)
    assert.equal(statusUpdated.ok ? statusUpdated.store.items[0]?.status : null, 'in_progress')

    // An agent blocked on a human decision parks the item as needs_input — the
    // lifecycle signal the Backlog panel surfaces with the warn glyph.
    const awaitingInput = await updateBacklogStatus({
      workspaceRoot: tempRoot,
      relativePath: 'backlog/checkout.md',
      status: 'needs_input',
    })
    assert.equal(awaitingInput.ok, true)
    assert.equal(awaitingInput.ok ? awaitingInput.store.items[0]?.status : null, 'needs_input')

    const resumed = await updateBacklogStatus({
      workspaceRoot: tempRoot,
      relativePath: 'backlog/checkout.md',
      status: 'in_progress',
    })
    assert.equal(resumed.ok, true)

    const metadataUpdated = await updateBacklogModuleMetadata({
      workspaceRoot: tempRoot,
      relativePath: 'backlog/checkout.md',
      moduleId: 'sprint-engine',
      value: { lastRunId: 'checkout' },
    })
    assert.equal(metadataUpdated.ok, true)
    assert.deepEqual(
      metadataUpdated.ok ? metadataUpdated.store.items[0]?.metadata?.['sprint-engine'] : null,
      { lastRunId: 'checkout' },
    )

    const linked = await addOrUpdateBacklogLink({
      workspaceRoot: tempRoot,
      relativePath: 'backlog/checkout.md',
      status: 'in_progress',
      link: {
        id: 'sprint-engine:checkout',
        moduleId: 'sprint-engine',
        type: 'execution',
        label: 'Sprint Engine run',
        target: { kind: 'sprintengine.run', id: 'checkout', path: '.multi-code/sprintengine/checkout/run.yaml' },
        status: 'active',
      },
    })
    assert.equal(linked.ok, true)
    assert.equal(linked.ok ? linked.store.items[0]?.links?.[0]?.target.path : null, '.multi-code/sprintengine/checkout/run.yaml')
    assert.equal(linked.ok ? linked.store.items[0]?.status : null, 'in_progress')

    const persisted = JSON.parse(await readFile(join(tempRoot, '.multi-code', 'backlog', 'items.json'), 'utf-8')) as {
      items: Array<{ source: { relativePath: string } }>
    }
    assert.equal(persisted.items[0]?.source.relativePath, 'backlog/checkout.md')

    const beforeAbsoluteItem = await readFile(join(tempRoot, '.multi-code', 'backlog', 'items.json'), 'utf-8')
    const rejectedAbsoluteItem = await updateBacklogStatus({
      workspaceRoot: tempRoot,
      relativePath: '/backlog/absolute.md',
      status: 'completed',
    })
    assert.equal(rejectedAbsoluteItem.ok, false)
    assert.match(rejectedAbsoluteItem.ok ? '' : rejectedAbsoluteItem.message, /relative paths under backlog/)
    assert.equal(
      await readFile(join(tempRoot, '.multi-code', 'backlog', 'items.json'), 'utf-8'),
      beforeAbsoluteItem,
      'absolute backlog item paths must not mutate an existing sidecar',
    )

    const absoluteFreshRoot = await mkdtemp(join(tmpdir(), 'multicode-backlog-absolute-'))
    try {
      const rejectedFreshAbsoluteItem = await updateBacklogStatus({
        workspaceRoot: absoluteFreshRoot,
        relativePath: '/backlog/fresh.md',
        status: 'completed',
      })
      assert.equal(rejectedFreshAbsoluteItem.ok, false)
      await assert.rejects(
        () => stat(join(absoluteFreshRoot, '.multi-code', 'backlog', 'items.json')),
        /ENOENT/,
        'absolute backlog item paths must not create a missing sidecar',
      )
    } finally {
      await rm(absoluteFreshRoot, { force: true, recursive: true })
    }

    const beforeAbsoluteLink = await readFile(join(tempRoot, '.multi-code', 'backlog', 'items.json'), 'utf-8')
    const rejectedAbsoluteLink = await addOrUpdateBacklogLink({
      workspaceRoot: tempRoot,
      relativePath: 'backlog/checkout.md',
      link: {
        id: 'absolute-target',
        moduleId: 'test',
        type: 'external',
        label: 'Absolute target',
        target: { kind: 'file', id: 'absolute-target', path: '/tmp/outside' },
      },
    })
    assert.equal(rejectedAbsoluteLink.ok, false)
    assert.match(rejectedAbsoluteLink.ok ? '' : rejectedAbsoluteLink.message, /project-relative/)
    assert.equal(
      await readFile(join(tempRoot, '.multi-code', 'backlog', 'items.json'), 'utf-8'),
      beforeAbsoluteLink,
      'absolute link target paths must not mutate the sidecar',
    )

    const rejectedTraversal = await updateBacklogStatus({
      workspaceRoot: tempRoot,
      relativePath: 'backlog/../outside.md',
      status: 'completed',
    })
    assert.equal(rejectedTraversal.ok, false)
    assert.match(rejectedTraversal.ok ? '' : rejectedTraversal.message, /under backlog/)

    const rejectedOutsideBacklog = await updateBacklogStatus({
      workspaceRoot: tempRoot,
      relativePath: 'notes/checkout.md',
      status: 'completed',
    })
    assert.equal(rejectedOutsideBacklog.ok, false)
    assert.match(rejectedOutsideBacklog.ok ? '' : rejectedOutsideBacklog.message, /under backlog/)

    const rejectedRelativeRoot = await updateBacklogStatus({
      workspaceRoot: 'relative/root',
      relativePath: 'backlog/checkout.md',
      status: 'completed',
    })
    assert.equal(rejectedRelativeRoot.ok, false)
    assert.match(rejectedRelativeRoot.ok ? '' : rejectedRelativeRoot.message, /absolute path/)

    await writeFile(join(tempRoot, '.multi-code', 'backlog', 'items.json'), '{broken', 'utf-8')
    const corrupt = await readBacklogObjectStore(tempRoot)
    assert.equal(corrupt.ok, false)
    assert.match(corrupt.ok ? '' : corrupt.message, /parse Backlog metadata/)

    const writeFailureRoot = await mkdtemp(join(tmpdir(), 'multicode-backlog-write-failure-'))
    const writeFailureStorePath = join(writeFailureRoot, '.multi-code', 'backlog', 'items.json')
    try {
      await mkdir(join(writeFailureRoot, '.multi-code', 'backlog'), { recursive: true })
      await writeFile(writeFailureStorePath, '{"schemaVersion":1,"items":[]}', 'utf-8')
      await chmod(writeFailureStorePath, 0o444)
      const writeFailure = await updateBacklogStatus({
        workspaceRoot: writeFailureRoot,
        relativePath: 'backlog/write.md',
        status: 'completed',
      })
      assert.equal(writeFailure.ok, false)
      assert.match(writeFailure.ok ? '' : writeFailure.message, /write Backlog metadata/)
    } finally {
      await chmod(writeFailureStorePath, 0o644).catch(() => {})
      await rm(writeFailureRoot, { force: true, recursive: true })
    }

  } finally {
    await rm(tempRoot, { force: true, recursive: true })
  }
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
