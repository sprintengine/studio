import assert from 'node:assert/strict'
import { test } from 'node:test'

import { FILE_TYPE_LABEL, fileTypeKind, type FileTypeKind } from './FileTypeGlyph'

// The mapping is the contract: a file kind that resolves differently in the
// File Explorer and the Git changes list would put two marks on one file.

test('source files resolve to their language tile, with tests notched', () => {
  const cases: Array<[string, FileTypeKind]> = [
    ['engine.ts', 'typescript'],
    ['engine.test.ts', 'typescript-test'],
    ['engine.spec.ts', 'typescript-test'],
    ['types.d.ts', 'typescript'],
    ['loader.mts', 'typescript'],
    ['agent-state.mjs', 'javascript'],
    ['runner.test.js', 'javascript-test'],
    ['index.cjs', 'javascript'],
    ['WorkspaceSidebar.tsx', 'react'],
    ['App.test.tsx', 'react'],
    ['Button.jsx', 'react'],
    ['main.py', 'python'],
    ['lib.rs', 'rust'],
    ['main.go', 'go'],
    ['Main.java', 'java'],
    ['App.kt', 'java'],
  ]
  for (const [name, kind] of cases) assert.equal(fileTypeKind(name), kind, name)
})

test('data, markup and shell files resolve by shape', () => {
  const cases: Array<[string, FileTypeKind]> = [
    ['items.json', 'json'],
    ['package.json', 'json'],
    ['tsconfig.jsonc', 'json'],
    ['notes.md', 'markdown'],
    ['guide.mdx', 'markdown'],
    ['ci.yml', 'yaml'],
    ['compose.yaml', 'yaml'],
    ['index.html', 'html'],
    ['App.vue', 'html'],
    ['index.css', 'css'],
    ['theme.scss', 'css'],
    ['build.sh', 'shell'],
    ['deploy.ps1', 'shell'],
    ['logo.png', 'image'],
    ['mark.svg', 'image'],
  ]
  for (const [name, kind] of cases) assert.equal(fileTypeKind(name), kind, name)
})

test('lockfiles, dotfiles and configuration read as lock and config', () => {
  const cases: Array<[string, FileTypeKind]> = [
    ['package-lock.json', 'lock'],
    ['yarn.lock', 'lock'],
    ['pnpm-lock.yaml', 'lock'],
    ['Cargo.lock', 'lock'],
    ['.gitignore', 'config'],
    ['.env', 'config'],
    ['.env.local', 'config'],
    ['.zshrc', 'config'],
    ['Dockerfile', 'config'],
    ['Cargo.toml', 'config'],
    ['settings.ini', 'config'],
  ]
  for (const [name, kind] of cases) assert.equal(fileTypeKind(name), kind, name)
})

test('prose without a language is text; anything unknown is the plain document', () => {
  assert.equal(fileTypeKind('LICENSE'), 'text')
  assert.equal(fileTypeKind('README'), 'text')
  assert.equal(fileTypeKind('README.md'), 'markdown')
  assert.equal(fileTypeKind('notes.txt'), 'text')
  assert.equal(fileTypeKind('report.csv'), 'text')
  assert.equal(fileTypeKind('Makefile'), 'config')
  assert.equal(fileTypeKind('binary.wasm'), 'generic')
  assert.equal(fileTypeKind('noext'), 'generic')
})

test('a path resolves by its last segment, case-insensitively', () => {
  assert.equal(fileTypeKind('src/renderer/src/utils/Engine.TS'), 'typescript')
  assert.equal(fileTypeKind('C:\\repo\\src\\index.JSX'), 'react')
  assert.equal(fileTypeKind('docs/guide/README.MD'), 'markdown')
})

test('every kind carries a label', () => {
  const kinds: FileTypeKind[] = [
    'typescript', 'typescript-test', 'javascript', 'javascript-test', 'react', 'json', 'markdown', 'yaml', 'html',
    'css', 'shell', 'python', 'rust', 'go', 'java', 'image', 'lock', 'config', 'text', 'generic',
  ]
  for (const kind of kinds) assert.ok(FILE_TYPE_LABEL[kind].length > 0, kind)
})
