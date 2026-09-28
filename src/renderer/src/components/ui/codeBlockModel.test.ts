import { expect, test } from 'vitest'

import {
  codeBlockTitle,
  countLines,
  filenameFromFenceMeta,
  pastableShellCommand,
  stripShellPrompts,
} from './codeBlockModel'

test('a fence tag reads as the language a person would name', () => {
  expect(codeBlockTitle('ts', undefined)).toMatchObject({ label: 'TypeScript', kind: 'typescript' })
  expect(codeBlockTitle('bash', undefined)).toMatchObject({ label: 'Bash', kind: 'shell' })
  expect(codeBlockTitle('SH', undefined).label).toBe('Shell')
  expect(codeBlockTitle('yml', undefined)).toMatchObject({ label: 'YAML', kind: 'yaml' })
  expect(codeBlockTitle('json', undefined)).toMatchObject({ label: 'JSON', kind: 'json' })
  expect(codeBlockTitle('diff', undefined)).toMatchObject({ label: 'Diff', kind: undefined })
})

test('no tag is plain text, and a tag nobody maps is shown as the author wrote it', () => {
  expect(codeBlockTitle(undefined, undefined)).toMatchObject({ label: 'Plain text', highlightLanguage: '' })
  expect(codeBlockTitle('text', undefined)).toMatchObject({ label: 'Plain text', highlightLanguage: '' })
  expect(codeBlockTitle('elixir', undefined)).toMatchObject({ label: 'elixir', kind: undefined, languageTag: 'elixir' })
})

test('a known filename replaces the language in the label and picks the glyph', () => {
  expect(codeBlockTitle('ts', 'src/app.test.ts')).toMatchObject({
    label: 'src/app.test.ts',
    filename: 'src/app.test.ts',
    languageName: 'TypeScript',
    kind: 'typescript-test',
  })
})

test('a filename with no language gives the block its language from the extension', () => {
  expect(codeBlockTitle(undefined, 'scripts/build.mjs')).toMatchObject({
    languageName: 'JavaScript',
    highlightLanguage: 'javascript',
  })
})

test('a fence tag that is itself a path is read as the filename', () => {
  expect(codeBlockTitle('src/main.ts', undefined)).toMatchObject({
    label: 'src/main.ts',
    filename: 'src/main.ts',
    languageName: 'TypeScript',
    highlightLanguage: 'ts',
  })
})

test('the fence info names a file by title, by key, or as a bare path', () => {
  expect(filenameFromFenceMeta('title="src/app.ts"')).toBe('src/app.ts')
  expect(filenameFromFenceMeta("title='app.ts' {1-3}")).toBe('app.ts')
  expect(filenameFromFenceMeta('file=src/app.ts')).toBe('src/app.ts')
  expect(filenameFromFenceMeta('filename="package.json"')).toBe('package.json')
  expect(filenameFromFenceMeta('src/renderer/app.tsx')).toBe('src/renderer/app.tsx')
  expect(filenameFromFenceMeta('{1,3-4} showLineNumbers')).toBeUndefined()
  expect(filenameFromFenceMeta(undefined)).toBeUndefined()
})

test('prompts come off each command, and output lines under them are dropped', () => {
  expect(stripShellPrompts('$ npm install\nadded 12 packages\n$ npm test')).toBe('npm install\nnpm test')
  expect(stripShellPrompts('% git status')).toBe('git status')
  // A continuation carries no prompt of its own and is still the command.
  expect(stripShellPrompts('$ npm test -- \\\n    --run\nok')).toBe('npm test -- \\\n    --run')
})

test('a block with no prompts is taken as written, comments included', () => {
  expect(stripShellPrompts('# install\nnpm install')).toBe('# install\nnpm install')
})

test('only a settled shell block offers a command to paste', () => {
  expect(pastableShellCommand('$ npm test\n', 'bash')).toBe('npm test')
  expect(pastableShellCommand('$ npm test\nok', 'console')).toBe('npm test')
  expect(pastableShellCommand('  npm test\n', 'SH')).toBe('npm test')
  expect(pastableShellCommand('npm test', 'bash', true)).toBeNull()
  expect(pastableShellCommand('npm test', 'ts')).toBeNull()
  expect(pastableShellCommand('npm test', undefined)).toBeNull()
})

test('a command that would not paste as it reads is not offered', () => {
  expect(pastableShellCommand('npm run \\', 'bash')).toBeNull()
  expect(pastableShellCommand('echo ‮gnp.exe', 'bash')).toBeNull()
  expect(pastableShellCommand('printf "\x1b[31m"', 'bash')).toBeNull()
  expect(pastableShellCommand('   ', 'zsh')).toBeNull()
  // An escape written as text is the command's business, and tabs and newlines are ordinary.
  expect(pastableShellCommand('printf "\\e[31m"\n\techo done', 'bash')).toBe('printf "\\e[31m"\n\techo done')
})

test('a session block offers a paste only when its prompts say which lines are commands', () => {
  // Taken whole, `> app@1.0.0 test` would paste as a redirection.
  expect(pastableShellCommand('> app@1.0.0 test\n> vitest run\n\n ✓ 12 passed', 'console')).toBeNull()
  expect(pastableShellCommand('npm test\n> app@1.0.0 test', 'shell-session')).toBeNull()
  expect(pastableShellCommand('$ npm test\n> app@1.0.0 test', 'shell-session')).toBe('npm test')
  // A plain shell block has no output in it, so it is still taken as written.
  expect(pastableShellCommand('npm install\nnpm test', 'bash')).toBe('npm install\nnpm test')
})

test('an indented $ or % is output, not a prompt', () => {
  const curl = '$ curl -O https://example.com/a.tgz\n  % Total    % Received % Xferd\n100  12k  100  12k'
  expect(stripShellPrompts(curl)).toBe('curl -O https://example.com/a.tgz')
  expect(pastableShellCommand(curl, 'console')).toBe('curl -O https://example.com/a.tgz')
  expect(stripShellPrompts('  $ not a prompt\nplain')).toBe('  $ not a prompt\nplain')
})

test('a here-document a prompted command opens keeps its body through the terminator', () => {
  expect(pastableShellCommand('$ cat <<EOF > notes.txt\nhello\nEOF\nwritten', 'bash')).toBe(
    'cat <<EOF > notes.txt\nhello\nEOF',
  )
  expect(stripShellPrompts("$ cat <<-'END'\n\tindented\n\tEND\n$ ls")).toBe("cat <<-'END'\n\tindented\n\tEND\nls")
  // A here-string is one line and opens nothing.
  expect(stripShellPrompts('$ cat <<< "hi"\noutput\n$ ls')).toBe('cat <<< "hi"\nls')
})

test('lines are counted from newlines', () => {
  expect(countLines('')).toBe(1)
  expect(countLines('a\nb\nc')).toBe(3)
})
