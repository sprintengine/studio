import assert from 'node:assert/strict'

import { resolveDefaultParentPath, suggestedWorkspaceFolderName } from './folderCreation'

// --- suggestedWorkspaceFolderName -------------------------------------------
assert.equal(suggestedWorkspaceFolderName('My Workspace'), 'my-workspace', 'spaces become hyphens, lowercased')
assert.equal(suggestedWorkspaceFolderName('  Foo__Bar  '), 'foo-bar', 'underscores collapse, trimmed')
assert.equal(suggestedWorkspaceFolderName('Hello! World?'), 'hello-world', 'punctuation becomes a single hyphen')
assert.equal(suggestedWorkspaceFolderName('---'), 'new-workspace', 'empty slug falls back to default')
assert.equal(suggestedWorkspaceFolderName(''), 'new-workspace', 'blank name falls back to default')
assert.equal(suggestedWorkspaceFolderName('keep.dots-1'), 'keep.dots-1', 'dots and digits are preserved')

// --- resolveDefaultParentPath -----------------------------------------------
assert.equal(
  resolveDefaultParentPath({ folderPath: '/Users/me/code/project', recentFolders: [] }),
  '/Users/me/code',
  'prefers the parent (sibling location) of the selected folder',
)
assert.equal(
  resolveDefaultParentPath({ folderPath: null, recentFolders: ['/Users/me/work/app', '/other'] }),
  '/Users/me/work',
  'falls back to the parent of the most-recent folder',
)
assert.equal(
  resolveDefaultParentPath({ folderPath: '   ', recentFolders: ['', '/Users/me/work/app'] }),
  '/Users/me/work',
  'blank selection and blank recents are skipped',
)
assert.equal(
  resolveDefaultParentPath({ folderPath: null, recentFolders: [] }),
  null,
  'no signal yields null (Browse required)',
)
assert.equal(
  resolveDefaultParentPath({ folderPath: null, recentFolders: [], fallbackParent: '/Users/me/Documents' }),
  '/Users/me/Documents',
  'cold start uses the fallback parent when no selection or recents',
)
assert.equal(
  resolveDefaultParentPath({
    folderPath: null,
    recentFolders: ['/Users/me/work/app'],
    fallbackParent: '/Users/me/Documents',
  }),
  '/Users/me/work',
  'recents take priority over the cold-start fallback',
)
assert.equal(
  resolveDefaultParentPath({ folderPath: null, recentFolders: [], fallbackParent: '   ' }),
  null,
  'blank fallback is ignored',
)

console.log('folderCreation.test.ts: all assertions passed')
