import assert from 'node:assert/strict'
import { test } from 'node:test'

import { FILE_TYPE_LABEL, fileTypeKind, isTestBasename, isTestPath, type FileTypeKind } from './FileTypeGlyph'

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
    ['App.test.tsx', 'react-test'],
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
    'typescript',
    'typescript-test',
    'javascript',
    'javascript-test',
    'react',
    'react-test',
    'json',
    'markdown',
    'yaml',
    'html',
    'css',
    'shell',
    'python',
    'python-test',
    'rust',
    'rust-test',
    'go',
    'go-test',
    'java',
    'image',
    'lock',
    'config',
    'text',
    'generic',
  ]
  for (const kind of kinds) assert.ok(FILE_TYPE_LABEL[kind].length > 0, kind)
})

// --- Test detection --------------------------------------------------------
// Each language family names its tests differently, and the forms collide: a
// bare "ends in test" rule swallows `latest.ts`, and a bare "starts with test"
// rule swallows `testing-utils.py`. The gate is the extension.

test('each language family is read by its own test convention', () => {
  // JS/TS: the .test. / .spec. infix, and nothing else.
  assert.equal(isTestBasename('engine.test.ts'), true)
  assert.equal(isTestBasename('engine.spec.tsx'), true)
  assert.equal(isTestBasename('engine_test.ts'), false)
  assert.equal(isTestBasename('TestEngine.ts'), false)

  // Python: the infix, plus pytest's test_ prefix and _test suffix.
  assert.equal(isTestBasename('test_engine.py'), true)
  assert.equal(isTestBasename('engine_test.py'), true)
  assert.equal(isTestBasename('engine.test.py'), true)

  // Go and Rust: the _test suffix only.
  assert.equal(isTestBasename('engine_test.go'), true)
  assert.equal(isTestBasename('engine_test.rs'), true)
  assert.equal(isTestBasename('test_engine.go'), false)

  // JUnit: the Test / Tests / IT suffix, on the ORIGINAL case.
  assert.equal(isTestBasename('EngineTest.java'), true)
  assert.equal(isTestBasename('EngineTests.kt'), true)
  assert.equal(isTestBasename('EngineIT.java'), true)
})

test('a name that merely ends in the letters "test" is not a test', () => {
  // The bug this rules out: lowercase the stem to match `FooTest` and every one
  // of these wears the tick.
  assert.equal(isTestBasename('latest.ts'), false)
  assert.equal(isTestBasename('latest.java'), false)
  assert.equal(isTestBasename('manifest.java'), false)
  assert.equal(isTestBasename('fastest.py'), false)
  assert.equal(isTestBasename('protest.go'), false)
  // …and the mirror on the prefix side.
  assert.equal(isTestBasename('testing-utils.py'), false)
  assert.equal(isTestBasename('testament.py'), false)
})

test('a file with no test-ish name is a test when it sits in a tests folder', () => {
  assert.equal(isTestPath('tests/conftest.py'), true)
  assert.equal(isTestPath('src/__tests__/helpers.ts'), true)
  assert.equal(isTestPath('spec/support/env.rb'), true)
  assert.equal(isTestPath('src/utils/engine.ts'), false)
  // The name still answers on its own, wherever it sits.
  assert.equal(isTestPath('src/utils/engine.test.ts'), true)
})

test('the notched kinds cover every language whose tile can carry the tick', () => {
  assert.equal(fileTypeKind('test_runner.py'), 'python-test')
  assert.equal(fileTypeKind('runner_test.go'), 'go-test')
  assert.equal(fileTypeKind('runner_test.rs'), 'rust-test')
  assert.equal(fileTypeKind('App.spec.jsx'), 'react-test')
  // Java draws no tile, so it keeps the plain mark and lets the row wash say it.
  assert.equal(fileTypeKind('EngineTest.java'), 'java')
})
