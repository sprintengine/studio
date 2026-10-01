import assert from 'node:assert/strict'
import { test } from 'vitest'

import {
  appDocumentUrl,
  externalLinkForWindowOpen,
  guardPrivilegedWindow,
  isAppDocument,
  type GuardedContents,
} from './privileged-window-navigation'

const packaged = appDocumentUrl(
  undefined,
  '/Applications/Studio.app/Contents/Resources/app.asar/out/renderer/index.html',
)
const development = appDocumentUrl('http://localhost:5173/', '/unused')

function fakeContents() {
  let openHandler: ((details: { url: string }) => { action: 'deny' }) | null = null
  let navigate: ((event: { preventDefault(): void }, url: string) => void) | null = null
  const contents: GuardedContents = {
    setWindowOpenHandler: (handler) => {
      openHandler = handler
    },
    on: (_event, listener) => {
      navigate = listener
    },
  }
  return {
    contents,
    open: (url: string) => openHandler!({ url }),
    navigate: (url: string) => {
      let prevented = false
      navigate!({ preventDefault: () => (prevented = true) }, url)
      return prevented ? 'blocked' : 'allowed'
    },
  }
}

test("a packaged window may reload its own document but never navigate to a page that contains the text 'file://'", () => {
  const { contents, navigate } = fakeContents()
  guardPrivilegedWindow(contents, packaged, () => undefined)
  assert.equal(navigate(`${packaged.href}?windowId=w1`), 'allowed')
  assert.equal(navigate('https://example.com/p?file://'), 'blocked')
  assert.equal(navigate('file:///Users/dev/repo/evil.html'), 'blocked')
})

test('a development window may move within the dev server and nowhere else', () => {
  assert.equal(isAppDocument('http://localhost:5173/?view=diagnostics', development), true)
  assert.equal(isAppDocument('http://localhost:5174/', development), false)
  assert.equal(isAppDocument('https://example.com/', development), false)
})

test('window.open hands only web and mail links to the OS, and never opens a window', () => {
  const opened: string[] = []
  const { contents, open } = fakeContents()
  guardPrivilegedWindow(contents, packaged, (url) => {
    opened.push(url)
  })
  for (const url of [
    'https://example.com/',
    'mailto:dev@example.com',
    'file:///Users/dev/repo/tool.app',
    'smb://example.com/share',
    'vscode://file/x',
  ]) {
    assert.deepEqual(open(url), { action: 'deny' }, url)
  }
  assert.deepEqual(opened, ['https://example.com/', 'mailto:dev@example.com'])
})

test('a link that is not a URL is dropped', () => {
  assert.equal(externalLinkForWindowOpen('not a link'), null)
})
