import assert from 'node:assert/strict'
import { test } from 'vitest'

import { decodeWslOutput } from './hosts/wsl-distro'
import { runSpawnDescriptor } from './process-run'

// `wsl.exe` prints its own errors as UTF-16LE. A process standing in for it
// writes such a message to stderr; decoded as UTF-8 it arrives with a NUL
// between every letter, which no reader of the message can match.
const WSL_ERROR = 'There is no distribution with the supplied name.\r\nError code: Wsl/WSL_E_DISTRO_NOT_FOUND\r\n'
const standIn = {
  file: process.execPath,
  args: ['-e', `process.stderr.write(Buffer.from(${JSON.stringify(WSL_ERROR)}, 'utf16le')); process.exit(1)`],
}

test("stderr is decoded as the caller says, so wsl.exe's own UTF-16 errors read as words", async () => {
  const plain = await runSpawnDescriptor(standIn)
  assert.ok(plain.stderr.includes('\0'), 'undecoded, the letters are NUL-separated')
  const decoded = await runSpawnDescriptor(standIn, { decodeStderr: decodeWslOutput })
  assert.equal(decoded.code, 1)
  assert.equal(decoded.stderr, WSL_ERROR)
})

test('stderr split across chunks mid-character is still decoded whole', async () => {
  const text = 'ü'.repeat(70_000)
  const outcome = await runSpawnDescriptor({
    file: process.execPath,
    args: ['-e', `process.stderr.write(${JSON.stringify(text)})`],
  })
  assert.equal(outcome.stderr, text)
})
