import assert from 'node:assert/strict'
import { test } from 'vitest'

import { CLI_UPDATE_PROGRESS_MAX_CHARS, createCliOutputLatestLineReader, withLastOutputLine } from './cliUpdateProgress'

test('the newest finished line is what the toast says', () => {
  const reader = createCliOutputLatestLineReader()
  assert.equal(reader.push('$ npm install -g @openai/codex@latest\n'), '$ npm install -g @openai/codex@latest')
  assert.equal(reader.push('added 1 package in 3s\n'), 'added 1 package in 3s')
  assert.equal(reader.latest(), 'added 1 package in 3s')
})

test('colour, cursor and hyperlink escapes are taken out', () => {
  const reader = createCliOutputLatestLineReader()
  const link = '\x1b]8;;https://example.com/changelog\x07changelog\x1b]8;;\x07'
  assert.equal(
    reader.push(`\x1b[32m✔\x1b[0m \x1b[1mInstalled\x1b[22m — see ${link}\x1b[K\n`),
    '✔ Installed — see changelog',
  )
})

test('a progress bar redrawn with carriage returns reads as its latest frame', () => {
  const reader = createCliOutputLatestLineReader()
  assert.equal(reader.push('Downloading  10%'), 'Downloading 10%')
  assert.equal(reader.push('\rDownloading  55%'), 'Downloading 55%')
  assert.equal(reader.push('\rDownloading 100%\r'), 'Downloading 100%', 'a trailing return redraws nothing yet')
  assert.equal(reader.push('\x1b[2K\r\n'), 'Downloading 100%', 'a bar that clears itself leaves its last word')
  assert.equal(reader.push('Done\r\n'), 'Done', 'a CRLF line ends like any other')
})

test('a chunk may split a line, or an escape inside one, anywhere', () => {
  const reader = createCliOutputLatestLineReader()
  reader.push('first line\n')
  assert.equal(reader.push('chang'), 'chang', 'an unfinished line is still the newest thing said')
  assert.equal(reader.push('ed 2 packages \x1b[3'), 'changed 2 packages', 'half an escape prints nothing')
  assert.equal(reader.push('3mok\x1b[0m\n'), 'changed 2 packages ok')
})

test('blank lines and whitespace runs do not replace what was said', () => {
  const reader = createCliOutputLatestLineReader()
  reader.push('resolving   dependencies\t…\n')
  assert.equal(reader.push('\n   \n\x1b[0m\n'), 'resolving dependencies …')
})

test('a long line is cut to the toast, with an ellipsis', () => {
  const reader = createCliOutputLatestLineReader()
  const line = reader.push(`${'x'.repeat(500)}\n`)
  assert.equal(line.length, CLI_UPDATE_PROGRESS_MAX_CHARS)
  assert.ok(line.endsWith('…'))
})

test('a failure gains the last line once, and never the command banner', () => {
  assert.equal(
    withLastOutputLine('The update did not finish', 'npm ERR! code EACCES'),
    'The update did not finish. Last output: npm ERR! code EACCES',
  )
  assert.equal(
    withLastOutputLine('Update command exited with code 243: npm ERR! code EACCES', 'npm ERR! code EACCES'),
    'Update command exited with code 243: npm ERR! code EACCES',
    'main already quoted it',
  )
  assert.equal(withLastOutputLine('Network error.', '$ npm install -g @openai/codex@latest'), 'Network error.')
  assert.equal(withLastOutputLine('Network error.', ''), 'Network error.')
})
