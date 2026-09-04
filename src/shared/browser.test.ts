import assert from 'node:assert/strict'

import { browserTabLabel, isLoopbackUrl, normalizeBrowserUrlInput } from './browser'

function run(name: string, body: () => void): void {
  try {
    body()
    console.log(`ok - ${name}`)
  } catch (error) {
    console.error(`not ok - ${name}`)
    throw error
  }
}

run('a host and port is a host and port, not a scheme', () => {
  assert.equal(normalizeBrowserUrlInput('localhost:5173'), 'http://localhost:5173/')
  assert.equal(normalizeBrowserUrlInput('127.0.0.1:8765/index.html'), 'http://127.0.0.1:8765/index.html')
  assert.equal(normalizeBrowserUrlInput('  example.com  '), 'http://example.com/')
})

run('real schemes are kept, non-web ones refused', () => {
  assert.equal(normalizeBrowserUrlInput('https://example.com/a?b=1'), 'https://example.com/a?b=1')
  assert.equal(normalizeBrowserUrlInput('about:blank'), 'about:blank')
  assert.equal(normalizeBrowserUrlInput('file:///etc/passwd'), null)
  assert.equal(normalizeBrowserUrlInput('javascript:alert(1)'), null)
  assert.equal(normalizeBrowserUrlInput('vscode://open'), null)
  assert.equal(normalizeBrowserUrlInput(''), null)
  assert.equal(normalizeBrowserUrlInput('x'.repeat(3000)), null)
})

run('loopback detection covers the dev-server hosts and nothing else', () => {
  assert.equal(isLoopbackUrl('http://localhost:3000/'), true)
  assert.equal(isLoopbackUrl('http://127.0.0.1:5173'), true)
  assert.equal(isLoopbackUrl('http://[::1]:8080/'), true)
  assert.equal(isLoopbackUrl('https://example.com/'), false)
  assert.equal(isLoopbackUrl('file:///tmp/x.html'), false)
  assert.equal(isLoopbackUrl('nonsense'), false)
})

run('the strip label prefers the title, then the host, then the kind', () => {
  assert.equal(browserTabLabel('http://localhost:5173/chat', 'Chat — App'), 'Chat — App')
  assert.equal(browserTabLabel('http://localhost:5173/chat', ''), 'localhost:5173')
  assert.equal(browserTabLabel('about:blank', undefined), 'Browser')
  assert.equal(browserTabLabel(undefined, undefined), 'Browser')
})

console.log('browser shared tests passed')
