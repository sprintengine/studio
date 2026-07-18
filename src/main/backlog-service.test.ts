import assert from 'node:assert/strict'
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { parseBacklogFrontmatter } from '../shared/backlog/frontmatter'
import {
  addOrUpdateBacklogLink,
  createBacklogEpic,
  listBacklogItems,
  moveBacklogObjectSource,
  readBacklogItem,
  planBacklogStoreMigration,
  readBacklogObjectStore,
  removeBacklogLink,
  updateBacklogDependencies,
  updateBacklogEpic,
  updateBacklogEpicColor,
  updateBacklogHighlight,
  updateBacklogModuleMetadata,
  updateBacklogStatus,
  updateBacklogTriage,
  updateBacklogType,
} from './backlog-service'

async function main(): Promise<void> {
  const tempRoot = await mkdtemp(join(tmpdir(), 'multicode-backlog-service-'))
  const itemPath = join(tempRoot, 'backlog', 'checkout.md')
  const storePath = join(tempRoot, '.multi-code', 'backlog', 'items.json')

  // The exact body the lifecycle/triage writes must preserve byte-for-byte.
  const body = '# Checkout\n\nSpeed up the checkout flow.\n\n- step one\n- step two\n'

  const readItem = async (): Promise<ReturnType<typeof parseBacklogFrontmatter>> =>
    parseBacklogFrontmatter(await readFile(itemPath, 'utf-8'))

  try {
    const missing = await readBacklogObjectStore(tempRoot)
    assert.equal(missing.ok, true)
    assert.deepEqual(missing.ok ? missing.store : null, { schemaVersion: 1, items: [] })

    await mkdir(join(tempRoot, 'backlog'), { recursive: true })
    await writeFile(itemPath, body, 'utf-8')

    // Lifecycle status now writes the markdown frontmatter, not items.json.
    const statusUpdated = await updateBacklogStatus({
      workspaceRoot: tempRoot,
      relativePath: 'backlog/checkout.md',
      status: 'in_progress',
    })
    assert.equal(statusUpdated.ok, true)
    const afterStatus = await readItem()
    assert.equal(afterStatus.fields.status, 'in_progress')
    assert.equal(afterStatus.body, body, 'status write must preserve the document body byte-for-byte')
    // Writing frontmatter must not create or touch the sidecar object store.
    await assert.rejects(() => stat(storePath), /ENOENT/, 'frontmatter writes must not create items.json')

    // An agent blocked on a human decision parks the item as needs_input — the
    // lifecycle signal the Backlog panel surfaces with the warn glyph.
    const awaitingInput = await updateBacklogStatus({
      workspaceRoot: tempRoot,
      relativePath: 'backlog/checkout.md',
      status: 'needs_input',
    })
    assert.equal(awaitingInput.ok, true)
    assert.equal((await readItem()).fields.status, 'needs_input')

    const resumed = await updateBacklogStatus({
      workspaceRoot: tempRoot,
      relativePath: 'backlog/checkout.md',
      status: 'in_progress',
    })
    assert.equal(resumed.ok, true)
    assert.equal((await readItem()).fields.status, 'in_progress')

    // Type is frontmatter-sourced too; null clears the key and preserves order.
    const typed = await updateBacklogType({
      workspaceRoot: tempRoot,
      relativePath: 'backlog/checkout.md',
      type: 'bug',
    })
    assert.equal(typed.ok, true)
    const afterType = await readItem()
    assert.equal(afterType.fields.type, 'bug')
    assert.equal(afterType.fields.status, 'in_progress', 'type write must leave status untouched')
    assert.equal(afterType.body, body)

    const clearedType = await updateBacklogType({
      workspaceRoot: tempRoot,
      relativePath: 'backlog/checkout.md',
      type: null,
    })
    assert.equal(clearedType.ok, true)
    assert.equal('type' in (await readItem()).fields, false, 'clearing type must remove the frontmatter line')

    // `epic` is a valid type (an item declared as an epic container) and writes
    // to frontmatter like any other type, body preserved.
    const epicTyped = await updateBacklogType({
      workspaceRoot: tempRoot,
      relativePath: 'backlog/checkout.md',
      type: 'epic',
    })
    assert.equal(epicTyped.ok, true)
    const afterEpic = await readItem()
    assert.equal(afterEpic.fields.type, 'epic')
    assert.equal(afterEpic.body, body, 'epic type write must preserve the document body byte-for-byte')
    // Clear it again so the triage assertions below start from a no-type state.
    await updateBacklogType({ workspaceRoot: tempRoot, relativePath: 'backlog/checkout.md', type: null })

    // Triage writes the three effort/impact/risk axes to frontmatter together.
    const triaged = await updateBacklogTriage({
      workspaceRoot: tempRoot,
      relativePath: 'backlog/checkout.md',
      difficulty: 'm',
      criticality: 'high',
      risk: 'normal',
    })
    assert.equal(triaged.ok, true)
    const afterTriage = await readItem()
    assert.equal(afterTriage.fields.difficulty, 'm')
    assert.equal(afterTriage.fields.criticality, 'high')
    assert.equal(afterTriage.fields.risk, 'normal')
    assert.equal(afterTriage.body, body, 'triage write must preserve the document body byte-for-byte')

    // A null axis clears only that key; omitted axes are left exactly as written.
    const clearedDifficulty = await updateBacklogTriage({
      workspaceRoot: tempRoot,
      relativePath: 'backlog/checkout.md',
      difficulty: null,
    })
    assert.equal(clearedDifficulty.ok, true)
    const afterClear = await readItem()
    assert.equal('difficulty' in afterClear.fields, false, 'clearing difficulty must remove its line')
    assert.equal(afterClear.fields.criticality, 'high', 'omitted criticality must survive a difficulty clear')
    assert.equal(afterClear.fields.risk, 'normal', 'omitted risk must survive a difficulty clear')

    // Invalid axis values are rejected explicitly and never mutate the file.
    const beforeInvalid = await readFile(itemPath, 'utf-8')
    const rejectedRisk = await updateBacklogTriage({
      workspaceRoot: tempRoot,
      relativePath: 'backlog/checkout.md',
      risk: 'extreme' as unknown as 'high',
    })
    assert.equal(rejectedRisk.ok, false)
    assert.match(rejectedRisk.ok ? '' : rejectedRisk.message, /risk/)
    const rejectedDifficulty = await updateBacklogTriage({
      workspaceRoot: tempRoot,
      relativePath: 'backlog/checkout.md',
      difficulty: 'xxl' as unknown as 'l',
    })
    assert.equal(rejectedDifficulty.ok, false)
    assert.match(rejectedDifficulty.ok ? '' : rejectedDifficulty.message, /difficulty/)
    const rejectedStatus = await updateBacklogStatus({
      workspaceRoot: tempRoot,
      relativePath: 'backlog/checkout.md',
      status: 'shipping' as unknown as 'completed',
    })
    assert.equal(rejectedStatus.ok, false)
    assert.match(rejectedStatus.ok ? '' : rejectedStatus.message, /status/)
    const rejectedType = await updateBacklogType({
      workspaceRoot: tempRoot,
      relativePath: 'backlog/checkout.md',
      type: 'chore' as unknown as 'bug',
    })
    assert.equal(rejectedType.ok, false)
    assert.match(rejectedType.ok ? '' : rejectedType.message, /type/)
    assert.equal(await readFile(itemPath, 'utf-8'), beforeInvalid, 'rejected values must not mutate the item file')

    // Epic membership is the child-side write: the `epic:` frontmatter slug, set
    // and cleared via the shared helper, body preserved, sidecar untouched.
    const epicAssigned = await updateBacklogEpic({
      workspaceRoot: tempRoot,
      relativePath: 'backlog/checkout.md',
      epic: 'auth-revamp',
    })
    assert.equal(epicAssigned.ok, true)
    const afterEpicAssign = await readItem()
    assert.equal(afterEpicAssign.fields.epic, 'auth-revamp')
    assert.equal(afterEpicAssign.body, body, 'epic assign must preserve the document body byte-for-byte')

    const epicCleared = await updateBacklogEpic({
      workspaceRoot: tempRoot,
      relativePath: 'backlog/checkout.md',
      epic: null,
    })
    assert.equal(epicCleared.ok, true)
    assert.equal('epic' in (await readItem()).fields, false, 'clearing epic must remove the frontmatter line')

    // An invalid epic slug (whitespace/separators) is rejected and mutates nothing.
    const beforeBadEpic = await readFile(itemPath, 'utf-8')
    const rejectedEpic = await updateBacklogEpic({
      workspaceRoot: tempRoot,
      relativePath: 'backlog/checkout.md',
      epic: 'has spaces' as string,
    })
    assert.equal(rejectedEpic.ok, false)
    assert.match(rejectedEpic.ok ? '' : rejectedEpic.message, /epic slug/)
    assert.equal(await readFile(itemPath, 'utf-8'), beforeBadEpic, 'a rejected epic slug must not mutate the item file')

    // Epic assignment against a path outside backlog/ is rejected explicitly.
    const rejectedEpicPath = await updateBacklogEpic({
      workspaceRoot: tempRoot,
      relativePath: 'notes/checkout.md',
      epic: 'auth-revamp',
    })
    assert.equal(rejectedEpicPath.ok, false)
    assert.match(rejectedEpicPath.ok ? '' : rejectedEpicPath.message, /under backlog/)

    // Epic identity colour: the epic file's `color:` frontmatter, set and cleared
    // through the same shared helper (body preserved), validated against the
    // colour vocabulary so a bad payload can't land an unknown hue.
    const colorSet = await updateBacklogEpicColor({
      workspaceRoot: tempRoot,
      relativePath: 'backlog/checkout.md',
      color: 'blue',
    })
    assert.equal(colorSet.ok, true)
    assert.equal((await readItem()).fields.color, 'blue')
    assert.equal((await readItem()).body, body, 'epic colour write must preserve the body byte-for-byte')

    const colorCleared = await updateBacklogEpicColor({
      workspaceRoot: tempRoot,
      relativePath: 'backlog/checkout.md',
      color: null,
    })
    assert.equal(colorCleared.ok, true)
    assert.equal('color' in (await readItem()).fields, false, 'clearing the epic colour must remove the frontmatter line')

    const beforeBadColor = await readFile(itemPath, 'utf-8')
    const rejectedEpicColor = await updateBacklogEpicColor({
      workspaceRoot: tempRoot,
      relativePath: 'backlog/checkout.md',
      color: 'magenta' as unknown as 'red',
    })
    assert.equal(rejectedEpicColor.ok, false)
    assert.match(rejectedEpicColor.ok ? '' : rejectedEpicColor.message, /colour/)
    assert.equal(await readFile(itemPath, 'utf-8'), beforeBadColor, 'a rejected epic colour must not mutate the item file')

    // Prerequisites are the dependent-side write: the single comma-separated
    // `dependsOn:` frontmatter line, set/cleared via the shared CSV + slug
    // helpers, body + unrelated keys preserved, sidecar untouched. A dedicated
    // file with an unknown key proves the round-trip independent of the churn above.
    const depsPath = join(tempRoot, 'backlog', 'deps.md')
    const depsBody = '# Deps\n\nBody stays put.\n'
    const depsOriginal = `---\nstatus: idea\ncustom: keep-me\n---\n${depsBody}`
    await writeFile(depsPath, depsOriginal, 'utf-8')
    const readDeps = async (): Promise<ReturnType<typeof parseBacklogFrontmatter>> =>
      parseBacklogFrontmatter(await readFile(depsPath, 'utf-8'))

    // Set a list: surrounding whitespace is trimmed and duplicates dropped,
    // first-seen order kept, so the stored line matches what the reader parses.
    const depsSet = await updateBacklogDependencies({
      workspaceRoot: tempRoot,
      relativePath: 'backlog/deps.md',
      dependsOn: ['alpha', ' beta ', 'alpha'],
    })
    assert.equal(depsSet.ok, true)
    const afterDepsSet = await readDeps()
    assert.equal(afterDepsSet.fields.dependson, 'alpha, beta')
    assert.equal(afterDepsSet.fields.custom, 'keep-me', 'an unrelated frontmatter key must be preserved')
    assert.equal(afterDepsSet.body, depsBody, 'dependsOn write must preserve the document body byte-for-byte')

    // An invalid slug rejects the whole write and mutates nothing.
    const beforeBadDeps = await readFile(depsPath, 'utf-8')
    const rejectedDeps = await updateBacklogDependencies({
      workspaceRoot: tempRoot,
      relativePath: 'backlog/deps.md',
      dependsOn: ['ok', 'has spaces'],
    })
    assert.equal(rejectedDeps.ok, false)
    assert.match(rejectedDeps.ok ? '' : rejectedDeps.message, /prerequisite/)
    assert.equal(await readFile(depsPath, 'utf-8'), beforeBadDeps, 'a rejected slug must not mutate the item file')

    // Clearing with an empty list removes the line and round-trips to the original bytes.
    const depsCleared = await updateBacklogDependencies({
      workspaceRoot: tempRoot,
      relativePath: 'backlog/deps.md',
      dependsOn: [],
    })
    assert.equal(depsCleared.ok, true)
    assert.equal('dependson' in (await readDeps()).fields, false, 'clearing dependsOn must remove the frontmatter line')
    assert.equal(await readFile(depsPath, 'utf-8'), depsOriginal, 'set then clear is a byte-for-byte round-trip')

    // null clears too (the serializer treats an empty string as a set, so the
    // service must pass null, not '').
    await updateBacklogDependencies({ workspaceRoot: tempRoot, relativePath: 'backlog/deps.md', dependsOn: ['gamma'] })
    const nullCleared = await updateBacklogDependencies({
      workspaceRoot: tempRoot,
      relativePath: 'backlog/deps.md',
      dependsOn: null,
    })
    assert.equal(nullCleared.ok, true)
    assert.equal(await readFile(depsPath, 'utf-8'), depsOriginal, 'null clears the line, restoring the original bytes')

    await rm(depsPath)

    // All lifecycle/type/triage/epic/dependsOn work so far must have stayed off the sidecar.
    await assert.rejects(() => stat(storePath), /ENOENT/, 'frontmatter mutations must never create items.json')

    // Module metadata is app-owned churn and still writes the sidecar store.
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
    const beforeInvalidColor = await readFile(storePath, 'utf-8')
    const rejectedColor = await updateBacklogHighlight({
      workspaceRoot: tempRoot,
      relativePath: 'backlog/checkout.md',
      starred: true,
      color: 'magenta' as unknown as 'red',
    })
    assert.equal(rejectedColor.ok, false)
    assert.match(rejectedColor.ok ? '' : rejectedColor.message, /highlight color/)
    assert.equal(
      await readFile(storePath, 'utf-8'),
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
    const persistedCleared = JSON.parse(await readFile(storePath, 'utf-8')) as {
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
    assert.equal(linked.ok ? linked.store.items[0]?.status : null, undefined, 'link lifecycle must not leak into items.json')
    assert.equal((await readItem()).fields.status, 'in_progress', 'link lifecycle writes the frontmatter source of truth')

    // Manual lifecycle control clears stale v1/link-written sidecar status so a
    // subsequent migration cannot restore completed over the user's Ready.
    const withStaleStatus = JSON.parse(await readFile(storePath, 'utf-8')) as {
      schemaVersion: 1
      items: Array<Record<string, unknown>>
    }
    withStaleStatus.items[0].status = 'completed'
    await writeFile(storePath, `${JSON.stringify(withStaleStatus, null, 2)}\n`, 'utf-8')
    const manuallyReady = await updateBacklogStatus({
      workspaceRoot: tempRoot,
      relativePath: 'backlog/checkout.md',
      status: 'ready',
    })
    assert.equal(manuallyReady.ok, true)
    assert.equal((await readItem()).fields.status, 'ready')
    assert.equal(manuallyReady.ok ? manuallyReady.store.items[0]?.status : 'missing', undefined)

    const unlinked = await removeBacklogLink({
      workspaceRoot: tempRoot,
      relativePath: 'backlog/checkout.md',
      linkId: 'sprint-engine:checkout',
    })
    assert.equal(unlinked.ok, true)
    assert.deepEqual(unlinked.ok ? unlinked.store.items[0]?.links : null, [], 'unlink removes only the selected association')
    assert.equal((await readItem()).fields.status, 'ready', 'unlink leaves manually controlled lifecycle unchanged')

    const persisted = JSON.parse(await readFile(storePath, 'utf-8')) as {
      items: Array<{ source: { relativePath: string } }>
    }
    assert.equal(persisted.items[0]?.source.relativePath, 'backlog/checkout.md')

    // Create-epic writes a new concept file under backlog/epics/ with type: epic
    // and the title heading; it never adds an items.json membership record.
    const storeBeforeEpicCreate = await readFile(storePath, 'utf-8')
    const createdEpic = await createBacklogEpic({ workspaceRoot: tempRoot, title: 'Auth Revamp' })
    assert.equal(createdEpic.ok, true)
    assert.equal(createdEpic.ok ? createdEpic.slug : '', 'auth-revamp')
    assert.equal(createdEpic.ok ? createdEpic.relativePath : '', 'backlog/epics/auth-revamp.md')
    const epicFile = parseBacklogFrontmatter(await readFile(join(tempRoot, 'backlog', 'epics', 'auth-revamp.md'), 'utf-8'))
    assert.equal(epicFile.fields.type, 'epic')
    assert.match(epicFile.body, /^# Auth Revamp$/m)
    assert.equal(await readFile(storePath, 'utf-8'), storeBeforeEpicCreate, 'creating an epic must not touch items.json')

    // A second epic with the same title gets a collision-safe slug, not a clobber.
    const createdEpic2 = await createBacklogEpic({ workspaceRoot: tempRoot, title: 'Auth Revamp' })
    assert.equal(createdEpic2.ok, true)
    assert.equal(createdEpic2.ok ? createdEpic2.slug : '', 'auth-revamp-2')
    assert.equal(createdEpic2.ok ? createdEpic2.relativePath : '', 'backlog/epics/auth-revamp-2.md')

    // An empty title is rejected rather than producing an untitled epic file.
    const rejectedEpicTitle = await createBacklogEpic({ workspaceRoot: tempRoot, title: '   ' })
    assert.equal(rejectedEpicTitle.ok, false)
    assert.match(rejectedEpicTitle.ok ? '' : rejectedEpicTitle.message, /title/)

    // Path validation: absolute item paths are rejected and mutate nothing.
    const beforeAbsoluteFile = await readFile(itemPath, 'utf-8')
    const beforeAbsoluteStore = await readFile(storePath, 'utf-8')
    const rejectedAbsoluteItem = await updateBacklogStatus({
      workspaceRoot: tempRoot,
      relativePath: '/backlog/absolute.md',
      status: 'completed',
    })
    assert.equal(rejectedAbsoluteItem.ok, false)
    assert.match(rejectedAbsoluteItem.ok ? '' : rejectedAbsoluteItem.message, /relative paths under backlog/)
    assert.equal(await readFile(itemPath, 'utf-8'), beforeAbsoluteFile, 'absolute paths must not mutate an item file')
    assert.equal(await readFile(storePath, 'utf-8'), beforeAbsoluteStore, 'absolute paths must not mutate the sidecar')

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

    const beforeAbsoluteLink = await readFile(storePath, 'utf-8')
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
      await readFile(storePath, 'utf-8'),
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

    // A lifecycle write against a missing item file fails explicitly rather than
    // inventing a file or a success.
    const missingFile = await updateBacklogStatus({
      workspaceRoot: tempRoot,
      relativePath: 'backlog/ghost.md',
      status: 'completed',
    })
    assert.equal(missingFile.ok, false)
    assert.match(missingFile.ok ? '' : missingFile.message, /read Backlog item/)

    await writeFile(storePath, '{broken', 'utf-8')
    const corrupt = await readBacklogObjectStore(tempRoot)
    assert.equal(corrupt.ok, false)
    assert.match(corrupt.ok ? '' : corrupt.message, /parse Backlog metadata/)

    // A read-only item file surfaces a write failure instead of a silent success.
    const writeFailureRoot = await mkdtemp(join(tmpdir(), 'multicode-backlog-write-failure-'))
    const writeFailureItemPath = join(writeFailureRoot, 'backlog', 'write.md')
    try {
      await mkdir(join(writeFailureRoot, 'backlog'), { recursive: true })
      await writeFile(writeFailureItemPath, '---\nstatus: idea\n---\n# Write\n', 'utf-8')
      await chmod(writeFailureItemPath, 0o444)
      const writeFailure = await updateBacklogStatus({
        workspaceRoot: writeFailureRoot,
        relativePath: 'backlog/write.md',
        status: 'completed',
      })
      assert.equal(writeFailure.ok, false)
      assert.match(writeFailure.ok ? '' : writeFailure.message, /write Backlog item/)
    } finally {
      await chmod(writeFailureItemPath, 0o644).catch(() => {})
      await rm(writeFailureRoot, { force: true, recursive: true })
    }

  } finally {
    await rm(tempRoot, { force: true, recursive: true })
  }

  await assertLazyMigrationMatrix()
  await assertArchiveLeavesSidecarLifecycleFree()
}

// Archiving an item is a pure source-path move: it must never write a lifecycle
// field (status/type/difficulty/criticality/risk/epic) into the sidecar record.
// Archived-ness is path-derived by the reader (isArchivedBacklogPath), so a
// sidecar status would be orphaned data — and since status is migratable under
// sidecar-wins precedence, a later readBacklogObjectStore pass would clobber the
// archived file's true pre-archive frontmatter status with 'archived'. Regression
// guard for T23 (T21 live-verification F-1).
async function assertArchiveLeavesSidecarLifecycleFree(): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'multicode-backlog-archive-'))
  const storePath = join(root, '.multi-code', 'backlog', 'items.json')
  const lifecycleKeys = ['status', 'type', 'difficulty', 'criticality', 'risk', 'epic']
  try {
    // The file has already been moved on disk to its archived path, carrying its
    // true pre-archive frontmatter status: ready.
    const body = '# Checkout\n\nSpeed up checkout.\n'
    const archivedFile = '---\nstatus: ready\n---\n' + body
    await mkdir(join(root, 'backlog', 'archived'), { recursive: true })
    await writeFile(join(root, 'backlog', 'archived', 'checkout.md'), archivedFile, 'utf-8')

    // Re-point the sidecar source from the live path to the archived path.
    const moved = await moveBacklogObjectSource({
      workspaceRoot: root,
      relativePath: 'backlog/checkout.md',
      nextRelativePath: 'backlog/archived/checkout.md',
    })
    assert.equal(moved.ok, true)
    const movedRecord = moved.ok ? moved.store.items[0] : null
    assert.equal(movedRecord?.source.relativePath, 'backlog/archived/checkout.md', 'archive must rewrite the sidecar source path')
    // The normalized in-memory record carries lifecycle keys as `undefined`;
    // JSON.stringify drops them, so the value (not key presence) is the invariant.
    for (const key of lifecycleKeys) {
      assert.equal((movedRecord as Record<string, unknown>)[key], undefined, `archive must not write ${key} into the sidecar record`)
    }
    const persisted = JSON.parse(await readFile(storePath, 'utf-8')) as { items: Array<Record<string, unknown>> }
    for (const key of lifecycleKeys) {
      assert.equal(key in persisted.items[0], false, `persisted sidecar must not carry ${key} after archive`)
    }

    // A subsequent lazy-migration pass must inject nothing: with no lifecycle key
    // in the sidecar there is nothing to migrate, so the archived file's true
    // status survives instead of being overwritten with 'archived'.
    const fileBefore = await readFile(join(root, 'backlog', 'archived', 'checkout.md'), 'utf-8')
    const read = await readBacklogObjectStore(root)
    assert.equal(read.ok, true)
    const reloaded = read.ok ? read.store.items[0] : null
    assert.equal(reloaded?.status as unknown, undefined, 'migration must not synthesize a sidecar status for an archived record')
    const afterMigrate = parseBacklogFrontmatter(await readFile(join(root, 'backlog', 'archived', 'checkout.md'), 'utf-8'))
    assert.equal(afterMigrate.fields.status, 'ready', 'archive must not clobber the archived file frontmatter status')
    assert.equal(
      await readFile(join(root, 'backlog', 'archived', 'checkout.md'), 'utf-8'),
      fileBefore,
      'a migration pass over an archived record must not rewrite the item file',
    )
  } finally {
    await rm(root, { force: true, recursive: true })
  }
}

// Lazy v1 -> v2 migration: the pure planner plus the on-disk migration that
// readBacklogObjectStore performs (sidecar wins, body preserved, orphan GC,
// unknown values tolerated, idempotent re-run).
async function assertLazyMigrationMatrix(): Promise<void> {
  // --- Pure planner ---------------------------------------------------------
  const plan = planBacklogStoreMigration({
    schemaVersion: 1,
    items: [
      { id: 'a', source: { type: 'file', relativePath: 'backlog/a.md' }, status: 'ready', type: 'saga', metadata: { x: 1 } },
      { id: 'b', source: { type: 'file', relativePath: 'backlog/b.md' }, difficulty: 7, links: [] },
      { id: 'c', source: { type: 'file', relativePath: 'backlog/c.md' }, metadata: {} },
    ],
  })
  assert.equal(plan.changed, true)
  // 'a' migrates status + an unknown type string; both are preserved, not dropped.
  const aMig = plan.migrations.find((m) => m.relativePath === 'backlog/a.md')
  assert.deepEqual(aMig?.updates, { status: 'ready', type: 'saga' })
  // 'b' carried only a non-string difficulty: stripped, but nothing to migrate.
  assert.equal(plan.migrations.some((m) => m.relativePath === 'backlog/b.md'), false)
  // 'c' had no migratable fields and produces no migration.
  assert.equal(plan.migrations.some((m) => m.relativePath === 'backlog/c.md'), false)
  // Every record is slimmed of the lightweight fields.
  assert.ok(plan.slimRecords.every((r) => !('status' in r) && !('type' in r) && !('difficulty' in r)))
  assert.deepEqual((plan.slimRecords[0] as { metadata?: unknown }).metadata, { x: 1 })
  // An already-migrated store is a no-op.
  assert.equal(planBacklogStoreMigration({ schemaVersion: 1, items: [{ id: 'a', source: { type: 'file', relativePath: 'backlog/a.md' } }] }).changed, false)
  // sec F1: a crafted multi-line items.json scalar is flattened before it can
  // reach the frontmatter writer, so it cannot inject extra keys.
  const injected = planBacklogStoreMigration({
    schemaVersion: 1,
    items: [{ id: 'x', source: { type: 'file', relativePath: 'backlog/x.md' }, status: 'idea\ntype: epic\norder: -999' }],
  }).migrations.find((m) => m.relativePath === 'backlog/x.md')
  assert.deepEqual(injected?.updates, { status: 'idea type: epic order: -999' })

  // --- On-disk migration via readBacklogObjectStore -------------------------
  const root = await mkdtemp(join(tmpdir(), 'multicode-backlog-migrate-'))
  const storePath = join(root, '.multi-code', 'backlog', 'items.json')
  try {
    const body = '# Checkout\n\nSpeed up checkout.\n'
    await mkdir(join(root, 'backlog'), { recursive: true })
    // The file already carries a status; the sidecar must WIN over it on migrate.
    await writeFile(join(root, 'backlog', 'a.md'), `---\nstatus: idea\n---\n${body}`, 'utf-8')
    await mkdir(join(root, '.multi-code', 'backlog'), { recursive: true })
    await writeFile(storePath, `${JSON.stringify({
      schemaVersion: 1,
      items: [
        { id: 'a', source: { type: 'file', relativePath: 'backlog/a.md' }, status: 'ready', type: 'saga', difficulty: 'm', criticality: 'high', risk: 'low', metadata: { jira: 'P-1' }, links: [] },
        // Orphan: no file on disk -> must be pruned.
        { id: 'ghost', source: { type: 'file', relativePath: 'backlog/ghost.md' }, status: 'in_progress' },
      ],
    }, null, 2)}\n`, 'utf-8')

    const read = await readBacklogObjectStore(root)
    assert.equal(read.ok, true)
    const records = read.ok ? read.store.items : []
    // Orphan pruned; only the real item's record survives, slimmed of triage but
    // keeping its app-owned churn.
    assert.deepEqual(records.map((r) => r.source.relativePath), ['backlog/a.md'])
    assert.equal(records[0]?.status, undefined)
    assert.equal(records[0]?.type, undefined)
    assert.equal(records[0]?.risk as unknown, undefined)
    assert.deepEqual(records[0]?.metadata, { jira: 'P-1' })

    // Frontmatter now holds the sidecar-won values; an unknown type is preserved;
    // the body is byte-identical.
    const migrated = parseBacklogFrontmatter(await readFile(join(root, 'backlog', 'a.md'), 'utf-8'))
    assert.equal(migrated.fields.status, 'ready', 'sidecar status wins over the file value')
    assert.equal(migrated.fields.type, 'saga', 'unknown type preserved, not dropped')
    assert.equal(migrated.fields.difficulty, 'm')
    assert.equal(migrated.fields.criticality, 'high')
    assert.equal(migrated.fields.risk, 'low')
    assert.equal(migrated.body, body, 'migration preserves the document body byte-for-byte')

    // The persisted sidecar is slim (fields stripped, churn kept).
    const persisted = JSON.parse(await readFile(storePath, 'utf-8')) as { items: Array<Record<string, unknown>> }
    assert.equal(persisted.items.length, 1)
    assert.equal('status' in persisted.items[0], false)
    assert.equal('type' in persisted.items[0], false)

    // Idempotent: a second read moves nothing and rewrites neither file.
    const fileBefore = await readFile(join(root, 'backlog', 'a.md'), 'utf-8')
    const storeBefore = await readFile(storePath, 'utf-8')
    const reread = await readBacklogObjectStore(root)
    assert.equal(reread.ok, true)
    assert.equal(await readFile(join(root, 'backlog', 'a.md'), 'utf-8'), fileBefore, 're-run must not rewrite the item')
    assert.equal(await readFile(storePath, 'utf-8'), storeBefore, 're-run must not rewrite the sidecar')
  } finally {
    await rm(root, { force: true, recursive: true })
  }

  // A not-yet-migrated workspace with no sidecar at all reads cleanly and leaves
  // its item files untouched (nothing to migrate).
  const freshRoot = await mkdtemp(join(tmpdir(), 'multicode-backlog-migrate-fresh-'))
  try {
    await mkdir(join(freshRoot, 'backlog'), { recursive: true })
    const fresh = '---\nstatus: ready\n---\n# Fresh\n'
    await writeFile(join(freshRoot, 'backlog', 'fresh.md'), fresh, 'utf-8')
    const read = await readBacklogObjectStore(freshRoot)
    assert.equal(read.ok, true)
    assert.deepEqual(read.ok ? read.store.items : null, [])
    assert.equal(await readFile(join(freshRoot, 'backlog', 'fresh.md'), 'utf-8'), fresh, 'no sidecar -> no migration, file untouched')
  } finally {
    await rm(freshRoot, { force: true, recursive: true })
  }
}

// Read-only listing/reading for the automation server's backlog tools: files +
// frontmatter are the whole read model, and neither call may create or touch
// .multi-code state (an external read tool must not mutate the app's stores).
async function testListAndReadBacklogItemsAreReadOnly(): Promise<void> {
  const tempRoot = await mkdtemp(join(tmpdir(), 'multicode-backlog-list-'))
  try {
    await mkdir(join(tempRoot, 'backlog', 'epics'), { recursive: true })
    await writeFile(
      join(tempRoot, 'backlog', '2026-07-08-ship-thing.md'),
      '---\ntype: feature\nstatus: ready\ndifficulty: m\ncriticality: high\nrisk: low\nepic: things\nid: 12\n---\n\n# Ship the thing\n\nBody text.\n',
      'utf-8'
    )
    await writeFile(join(tempRoot, 'backlog', 'no-frontmatter.md'), '# Bare capture\n', 'utf-8')
    await writeFile(join(tempRoot, 'backlog', 'old.md'), '---\nstatus: archived\n---\n# Old\n', 'utf-8')
    await writeFile(join(tempRoot, 'backlog', 'epics', 'things.md'), '---\ntype: epic\n---\n# Things\n', 'utf-8')
    // A roadmap (MC-1618) is discovered from backlog/roadmaps/ and tagged type: roadmap.
    await mkdir(join(tempRoot, 'backlog', 'roadmaps'), { recursive: true })
    await writeFile(
      join(tempRoot, 'backlog', 'roadmaps', 'payments.md'),
      '---\ntype: roadmap\nstatus: ready\n---\n# Payments roadmap\n\n## Backend\n- backlog/2026-07-08-ship-thing.md\n',
      'utf-8'
    )

    const listed = await listBacklogItems(tempRoot)
    assert.equal(listed.ok, true)
    if (!listed.ok) return
    assert.equal(listed.key, null, 'no config.json yet -> key is null')
    assert.deepEqual(listed.items, [
      {
        relativePath: 'backlog/2026-07-08-ship-thing.md',
        title: 'Ship the thing',
        id: 12,
        isEpic: false,
        status: 'ready',
        type: 'feature',
        difficulty: 'm',
        criticality: 'high',
        risk: 'low',
        epic: 'things',
      },
      { relativePath: 'backlog/epics/things.md', title: 'Things', isEpic: true, status: 'idea', type: 'epic' },
      { relativePath: 'backlog/no-frontmatter.md', title: 'Bare capture', isEpic: false, status: 'idea' },
      { relativePath: 'backlog/roadmaps/payments.md', title: 'Payments roadmap', isEpic: false, isRoadmap: true, status: 'ready' },
    ])
    // Read-only means read-only: listing registers nothing and persists no key.
    await assert.rejects(() => stat(join(tempRoot, '.multi-code')), /ENOENT/, 'listing must not create .multi-code')

    await mkdir(join(tempRoot, '.multi-code', 'backlog'), { recursive: true })
    await writeFile(join(tempRoot, '.multi-code', 'backlog', 'config.json'), '{"key":"MC"}\n', 'utf-8')
    const keyed = await listBacklogItems(tempRoot)
    assert.equal(keyed.ok && keyed.key, 'MC')

    const read = await readBacklogItem(tempRoot, 'backlog/2026-07-08-ship-thing.md')
    assert.equal(read.ok, true)
    if (read.ok) {
      assert.equal(read.item.title, 'Ship the thing')
      assert.equal(read.item.id, 12)
      assert.equal(read.item.status, 'ready')
      assert.match(read.body, /^# Ship the thing/m)
      assert.doesNotMatch(read.body, /^---/, 'body excludes the frontmatter block')
    }

    const missing = await readBacklogItem(tempRoot, 'backlog/gone.md')
    assert.equal(missing.ok, false)
    assert.match(missing.ok ? '' : missing.message, /does not exist/)

    for (const bad of ['backlog/../package.json', '/etc/passwd', 'src/main/index.ts']) {
      const denied = await readBacklogItem(tempRoot, bad)
      assert.equal(denied.ok, false, `path "${bad}" is rejected`)
    }
  } finally {
    await rm(tempRoot, { force: true, recursive: true })
  }
}

main()
  .then(() => testListAndReadBacklogItemsAreReadOnly())
  .catch((error) => {
    console.error(error)
    process.exit(1)
  })
