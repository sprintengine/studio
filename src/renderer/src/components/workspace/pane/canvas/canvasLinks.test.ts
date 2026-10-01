import assert from 'node:assert/strict'
import { test } from 'vitest'

import { canvasLinkAction } from './canvasLinks'

const noElementLinks = () => false

test('a web link goes to the system browser, even when it names the window origin in its text', () => {
  assert.deepEqual(canvasLinkAction('https://example.com/spec?file://', noElementLinks), {
    kind: 'external',
    url: 'https://example.com/spec?file://',
  })
  assert.deepEqual(canvasLinkAction('http://localhost:3000/', noElementLinks), {
    kind: 'external',
    url: 'http://localhost:3000/',
  })
})

test('a link to a shape on the board scrolls to it', () => {
  assert.deepEqual(
    canvasLinkAction('file:///app/index.html?element=abc', () => true),
    { kind: 'element' },
  )
})

test('a file link, a mail link, a custom scheme, or something that is not a link is refused', () => {
  for (const link of [
    'file:///Users/dev/repo/tool.app',
    'smb://example.com/share',
    'vscode://file/Users/dev/x',
    'mailto:dev@example.com',
    '/relative/path',
    'not a link',
  ]) {
    assert.deepEqual(canvasLinkAction(link, noElementLinks), { kind: 'refused' }, link)
  }
})
