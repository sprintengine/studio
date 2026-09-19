import assert from 'node:assert/strict'
import { test } from 'vitest'

import {
  FOLDER_ROLE_LABEL,
  FOLDER_ROLE_ORDER,
  folderRoleInk,
  folderRoleWash,
  resolveFolderRole,
  resolveRowWash,
  rowWashClass,
  type FolderRoleMap,
} from './folderRoles'

const ROOT = '/repo'

test('a role declared on a folder governs everything beneath it', () => {
  const roles: FolderRoleMap = { '/repo/out': 'generated' }

  assert.equal(resolveFolderRole(roles, '/repo/out', ROOT), 'generated')
  assert.equal(resolveFolderRole(roles, '/repo/out/renderer', ROOT), 'generated')
  assert.equal(resolveFolderRole(roles, '/repo/out/renderer/assets/app.js', ROOT), 'generated')
  assert.equal(resolveFolderRole(roles, '/repo/src/main.ts', ROOT), null)
})

test('the nearest declared ancestor wins over a further one', () => {
  const roles: FolderRoleMap = {
    '/repo/src': 'sources',
    '/repo/src/generated': 'generated',
  }

  assert.equal(resolveFolderRole(roles, '/repo/src/app.ts', ROOT), 'sources')
  assert.equal(resolveFolderRole(roles, '/repo/src/generated/api.ts', ROOT), 'generated')
})

test('the walk stops at the root, so a mark cannot leak between checkouts', () => {
  // Both checkouts live under /repo-parent. A role marked in one must not
  // resolve for a file in its sibling.
  const roles: FolderRoleMap = { '/repo-parent': 'excluded' }

  assert.equal(resolveFolderRole(roles, '/repo-parent/a/src/main.ts', '/repo-parent/a'), null)
})

test('trailing slashes and backslashes resolve the same folder', () => {
  const roles: FolderRoleMap = { '/repo/out': 'generated' }

  assert.equal(resolveFolderRole(roles, '/repo/out/', ROOT), 'generated')
  assert.equal(resolveFolderRole({ 'C:/repo/out': 'generated' }, 'C:\\repo\\out\\app.js', 'C:/repo'), 'generated')
})

test('an empty map is answered without walking', () => {
  assert.equal(resolveFolderRole({}, '/repo/src/deep/nested/file.ts', ROOT), null)
})

test('only two of the six roles paint a wash', () => {
  assert.equal(folderRoleWash('test-sources'), 'test')
  assert.equal(folderRoleWash('test-resources'), 'test')
  assert.equal(folderRoleWash('generated'), 'generated')
  assert.equal(folderRoleWash('excluded'), 'generated')
  // Marking the source root would otherwise tint most of the tree.
  assert.equal(folderRoleWash('sources'), null)
  assert.equal(folderRoleWash('resources'), null)
})

test('a washing role overrides the file name', () => {
  // A test file inside an excluded tree reads as excluded, not as a test.
  assert.equal(resolveRowWash('excluded', true), 'generated')
  assert.equal(resolveRowWash('generated', true), 'generated')
})

test('a role with no wash lets the file name answer', () => {
  // The regression this pins: marking src/ as the sources root must not stop
  // src/engine.test.ts from reading as a test.
  assert.equal(resolveRowWash('sources', true), 'test')
  assert.equal(resolveRowWash('resources', true), 'test')
  assert.equal(resolveRowWash('sources', false), null)
  assert.equal(resolveRowWash(null, true), 'test')
  assert.equal(resolveRowWash(null, false), null)
})

test('every role has a label, an ink decision, and a place in the menu', () => {
  for (const role of FOLDER_ROLE_ORDER) {
    assert.ok(FOLDER_ROLE_LABEL[role].length > 0, `${role} has a label`)
    // null is a decision (keep the row's ink), so only undefined is a miss.
    assert.notEqual(folderRoleInk(role), undefined, `${role} has an ink decision`)
  }
  assert.equal(FOLDER_ROLE_ORDER.length, 6)
  assert.equal(new Set(FOLDER_ROLE_ORDER).size, 6, 'no role is listed twice')
})

test('a wash maps to its class, and no wash maps to none', () => {
  assert.equal(rowWashClass('test'), 'file-row-wash-test')
  assert.equal(rowWashClass('generated'), 'file-row-wash-generated')
  assert.equal(rowWashClass(null), '')
})
