import assert from 'node:assert/strict'
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  addOrUpdateBacklogLink,
  readBacklogObjectStore,
  updateBacklogHighlight,
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

    const beforeHighlightUpdatedAt = metadataUpdated.ok ? metadataUpdated.store.items[0]?.updatedAt : undefined
    const highlighted = await updateBacklogHighlight({
      workspaceRoot: tempRoot,
      relativePath: 'backlog/checkout.md',
      starred: true,
      color: 'amber',
    })
    assert.equal(highlighted.ok, true)
    assert.deepEqual(highlighted.ok ? highlighted.store.items[0]?.highlight : null, { starred: true, color: 'amber' })
    const highlightedUpdatedAt = highlighted.ok ? highlighted.store.items[0]?.updatedAt : undefined
    assert.ok(
      highlightedUpdatedAt && beforeHighlightUpdatedAt
        && Date.parse(highlightedUpdatedAt) >= Date.parse(beforeHighlightUpdatedAt),
      'highlight mutation must bump updatedAt',
    )

    // Unknown color names are rejected explicitly, never coerced or persisted.
    const beforeInvalidColor = await readFile(join(tempRoot, '.multi-code', 'backlog', 'items.json'), 'utf-8')
    const rejectedColor = await updateBacklogHighlight({
      workspaceRoot: tempRoot,
      relativePath: 'backlog/checkout.md',
      starred: true,
      color: 'magenta' as unknown as 'red',
    })
    assert.equal(rejectedColor.ok, false)
    assert.match(rejectedColor.ok ? '' : rejectedColor.message, /highlight color/)
    assert.equal(
      await readFile(join(tempRoot, '.multi-code', 'backlog', 'items.json'), 'utf-8'),
      beforeInvalidColor,
      'rejected highlight colors must not mutate the sidecar',
    )

    const rejectedStarred = await updateBacklogHighlight({
      workspaceRoot: tempRoot,
      relativePath: 'backlog/checkout.md',
      starred: 1 as unknown as boolean,
      color: null,
    })
    assert.equal(rejectedStarred.ok, false)
    assert.match(rejectedStarred.ok ? '' : rejectedStarred.message, /highlight star/)

    // Starred with no color is a valid state.
    const starredOnly = await updateBacklogHighlight({
      workspaceRoot: tempRoot,
      relativePath: 'backlog/checkout.md',
      starred: true,
      color: null,
    })
    assert.equal(starredOnly.ok, true)
    assert.deepEqual(starredOnly.ok ? starredOnly.store.items[0]?.highlight : null, { starred: true, color: null })

    // The persisted highlight survives a reload (normalization carries it).
    const reloadedHighlight = await readBacklogObjectStore(tempRoot)
    assert.equal(reloadedHighlight.ok, true)
    assert.deepEqual(reloadedHighlight.ok ? reloadedHighlight.store.items[0]?.highlight : null, { starred: true, color: null })

    // Clearing both star and color removes the field, keeping un-highlighted
    // records in their original schema-v1 shape (no migration, no empty object).
    const clearedHighlight = await updateBacklogHighlight({
      workspaceRoot: tempRoot,
      relativePath: 'backlog/checkout.md',
      starred: false,
      color: null,
    })
    assert.equal(clearedHighlight.ok, true)
    assert.equal(clearedHighlight.ok ? clearedHighlight.store.items[0]?.highlight : 'missing', undefined)
    const persistedCleared = JSON.parse(await readFile(join(tempRoot, '.multi-code', 'backlog', 'items.json'), 'utf-8')) as {
      items: Array<Record<string, unknown>>
    }
    assert.ok(!('highlight' in persistedCleared.items[0]), 'cleared highlight must not persist a field')

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
