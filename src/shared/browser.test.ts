import assert from 'node:assert/strict'

import { browserTabLabel, isLoopbackUrl, normalizeBrowserUrlInput } from './browser'
import {
  fitViewportScale,
  nextZoomLevel,
  normalizeBrowserViewport,
  presetViewport,
  rotateViewport,
} from './browser-devices'

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

run('viewports: presets resolve, rotation becomes freeform, junk is refused, sizes clamp', () => {
  assert.deepEqual(presetViewport('iphone-12-pro'), { mode: 'preset', presetId: 'iphone-12-pro', width: 390, height: 844 })
  assert.deepEqual(rotateViewport(presetViewport('iphone-12-pro')), { mode: 'freeform', width: 844, height: 390 })
  assert.deepEqual(rotateViewport({ mode: 'fill' }), { mode: 'fill' })
  assert.deepEqual(normalizeBrowserViewport({ mode: 'preset', presetId: 'nope' }), undefined)
  assert.deepEqual(normalizeBrowserViewport({ mode: 'freeform', width: 10, height: 99999 }), {
    mode: 'freeform',
    width: 240,
    height: 3840,
  })
  assert.equal(normalizeBrowserViewport('fill'), undefined)
})

run('fit scale never enlarges and respects both axes', () => {
  assert.equal(fitViewportScale({ width: 390, height: 844 }, { width: 400, height: 900 }), 1)
  assert.equal(fitViewportScale({ width: 390, height: 844 }, { width: 195, height: 900 }), 0.5)
  assert.equal(fitViewportScale({ width: 390, height: 844 }, { width: 900, height: 422 }), 0.5)
  assert.equal(fitViewportScale({ width: 390, height: 844 }, { width: 0, height: 0 }), 1)
})

run('the zoom ladder steps through Chromium levels and clamps at the ends', () => {
  assert.equal(nextZoomLevel(1, 1), 1.1)
  assert.equal(nextZoomLevel(1, -1), 0.9)
  assert.equal(nextZoomLevel(5, 1), 5)
  assert.equal(nextZoomLevel(0.25, -1), 0.25)
  assert.equal(nextZoomLevel(1.05, 1), 1.1, 'an off-ladder value steps to the next rung')
})

console.log('browser shared tests passed')
