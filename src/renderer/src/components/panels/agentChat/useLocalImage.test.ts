import assert from 'node:assert/strict'
import { test } from 'vitest'

import type { ConversationToolImageResult, ConversationTransport } from './conversationTransport'
import { fetchToolImage } from './useLocalImage'

// A remote chat's pictures are kept per conversation so a row that scrolls
// back does not ask the other machine again, within a bound on how much of
// the window's memory they take.

test('a remote picture is fetched once, and the kept ones are bounded by their size', async () => {
  const transport = {} as ConversationTransport
  const asked: string[] = []
  // Each picture is a quarter of the size bound, so four fit and a fifth
  // pushes the oldest out.
  const picture = (id: string): ConversationToolImageResult => ({
    ok: true,
    src: `data:image/png;base64,${id}${'A'.repeat(6 * 1024 * 1024 - id.length)}`,
  })
  const toolImage = async ({ toolUseId }: { toolUseId: string }) => {
    asked.push(toolUseId)
    return picture(toolUseId)
  }
  for (const id of ['a', 'b', 'c']) await fetchToolImage(transport, toolImage, id)
  await fetchToolImage(transport, toolImage, 'a')
  assert.deepEqual(asked, ['a', 'b', 'c'], 'a picture already kept is not asked for again')

  await fetchToolImage(transport, toolImage, 'd')
  await Promise.resolve()
  await fetchToolImage(transport, toolImage, 'b')
  assert.deepEqual(asked, ['a', 'b', 'c', 'd', 'b'], 'the least recently shown went first once the bound was reached')
  await fetchToolImage(transport, toolImage, 'a')
  assert.equal(asked.length, 5, 'the most recently shown stayed')
})

test('a failed remote picture is asked for again on the next look', async () => {
  const transport = {} as ConversationTransport
  let calls = 0
  const toolImage = async (): Promise<ConversationToolImageResult> => {
    calls++
    return { ok: false, unsupported: false, message: 'mac-mini did not answer.' }
  }
  await fetchToolImage(transport, toolImage, 'x')
  await Promise.resolve()
  await fetchToolImage(transport, toolImage, 'x')
  assert.equal(calls, 2)
})
