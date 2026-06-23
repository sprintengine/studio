import assert from 'node:assert/strict'

import {
  analyzeWorkspaceTargetPath,
  defaultWorkspaceFolderPath,
  resolveDefaultParentPath,
  suggestedWorkspaceFolderName,
  validateWorkspaceFolderName,
} from './folderCreation'

// --- suggestedWorkspaceFolderName -------------------------------------------
assert.equal(suggestedWorkspaceFolderName('My Workspace'), 'my-workspace', 'spaces become hyphens, lowercased')
assert.equal(suggestedWorkspaceFolderName('  Foo__Bar  '), 'foo-bar', 'underscores collapse, trimmed')
assert.equal(suggestedWorkspaceFolderName('Hello! World?'), 'hello-world', 'punctuation becomes a single hyphen')
assert.equal(suggestedWorkspaceFolderName('---'), 'new-workspace', 'empty slug falls back to default')
assert.equal(suggestedWorkspaceFolderName(''), 'new-workspace', 'blank name falls back to default')
assert.equal(suggestedWorkspaceFolderName('keep.dots-1'), 'keep.dots-1', 'dots and digits are preserved')

// --- validateWorkspaceFolderName --------------------------------------------
assert.equal(validateWorkspaceFolderName('my-folder'), null, 'a clean name is valid')
assert.equal(validateWorkspaceFolderName('  spaced  '), null, 'surrounding whitespace is trimmed before validation')
assert.equal(validateWorkspaceFolderName(''), 'Enter a valid folder name.', 'empty is rejected')
assert.equal(validateWorkspaceFolderName('.'), 'Enter a valid folder name.', 'dot is rejected')
assert.equal(validateWorkspaceFolderName('..'), 'Enter a valid folder name.', 'dotdot is rejected')
assert.equal(validateWorkspaceFolderName('a/b'), 'Enter a valid folder name.', 'forward slash is rejected')
assert.equal(validateWorkspaceFolderName('a\\b'), 'Enter a valid folder name.', 'backslash is rejected')
assert.equal(
  validateWorkspaceFolderName('a<b'),
  'Folder names cannot contain control characters or <>:"|?*.',
  'illegal printable char is rejected',
)
assert.equal(
  validateWorkspaceFolderName(`tab${String.fromCharCode(9)}name`),
  'Folder names cannot contain control characters or <>:"|?*.',
  'control char (tab) is rejected',
)
assert.equal(
  validateWorkspaceFolderName('trailing.'),
  'Folder names cannot end with a period or space.',
  'trailing period is rejected',
)
assert.equal(
  validateWorkspaceFolderName('AUX'),
  'That folder name is reserved by Windows.',
  'reserved Windows device name is rejected',
)

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

// --- defaultWorkspaceFolderPath ---------------------------------------------
assert.equal(
  defaultWorkspaceFolderPath('/Users/me/Documents', 'My App'),
  '/Users/me/Documents/my-app',
  'joins parent with the slugged workspace name',
)
assert.equal(
  defaultWorkspaceFolderPath('/Users/me/Documents', ''),
  '/Users/me/Documents/new-workspace',
  'empty name falls back to the default leaf',
)
assert.equal(defaultWorkspaceFolderPath(null, 'My App'), null, 'no parent yields null')

// --- analyzeWorkspaceTargetPath ---------------------------------------------
{
  const ok = analyzeWorkspaceTargetPath('/Users/me/Documents/my-app')
  assert.equal(ok.ok, true, 'absolute path with a valid leaf is ok')
  assert.equal(ok.parent, '/Users/me/Documents', 'parent decomposed')
  assert.equal(ok.leaf, 'my-app', 'leaf decomposed')
}
assert.equal(
  analyzeWorkspaceTargetPath('').error,
  'Choose a folder for the workspace.',
  'empty path is rejected',
)
assert.equal(
  analyzeWorkspaceTargetPath('relative/path').error,
  'Enter an absolute folder path.',
  'relative path is rejected',
)
assert.equal(
  analyzeWorkspaceTargetPath('/Users/me/Documents/bad:name').ok,
  false,
  'illegal leaf char is rejected for the create case',
)
{
  const win = analyzeWorkspaceTargetPath('C:\\Users\\me\\projects\\app')
  assert.equal(win.ok, true, 'windows absolute path is accepted')
  assert.equal(win.leaf, 'app', 'windows leaf decomposed')
}

console.log('folderCreation.test.ts: all assertions passed')
