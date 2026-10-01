import assert from 'node:assert/strict'
import { readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { test, vi } from 'vitest'

vi.mock('electron', () => ({ BrowserWindow: class {} }))

const { splashDevUrl, splashQuery } = await import('./splash-window')
const { channelForVersion } = await import('./update-channel-store')

test('a nightly build loads the splash with the nightly channel in its query', () => {
  const channel = channelForVersion('0.6.0-nightly.20260923.41')
  assert.deepEqual(splashQuery(channel), { channel: 'nightly' })
  assert.equal(splashDevUrl('http://localhost:5173/', channel), 'http://localhost:5173/splash.html?channel=nightly')
})

test('a stable build loads the splash exactly as before, with no query', () => {
  for (const version of ['0.5.2', '0.5.1-preview.20260923.7', '0.0.0']) {
    const channel = channelForVersion(version)
    assert.deepEqual(splashQuery(channel), {}, version)
    assert.equal(splashDevUrl('http://localhost:5173/', channel), 'http://localhost:5173/splash.html', version)
  }
})

// The document half of the contract. splash.html has no module graph to test
// through, so this reads it: the channel must be applied by a script that runs
// before <body> is parsed (so the first paint is already the right plate), the
// night plate must be a CSS background that only a nightly root selects (so a
// stable launch never fetches it), and the reveal must stand down under
// reduced motion.
test('splash.html picks its plate before the first paint', () => {
  const html = readFileSync(join(process.cwd(), 'src/renderer/splash.html'), 'utf8')
  const bodyAt = html.lastIndexOf('<body>')
  const channelScriptAt = html.indexOf("URLSearchParams(location.search).get('channel') === 'nightly'")
  assert.ok(channelScriptAt > 0 && channelScriptAt < bodyAt, 'the channel is read in <head>, ahead of the body')
  assert.match(html, /:root\[data-channel='nightly'\] \.plate--night\s*\{[^}]*display: block/)
  assert.match(html, /url\('\.\/src\/assets\/backdrops\/splash-night-sky\.png'\)/)
  assert.match(html, /@media \(prefers-reduced-motion: reduce\)/)
  // The stable plate is still the one <img>, untouched.
  assert.match(
    html,
    /<img class="plate" src="\.\/src\/assets\/backdrops\/backdrop-herbarium-dark-chat\.jpg" alt="" \/>/,
  )
})

test('the night plate stays inside its size budget', () => {
  const size = statSync(join(process.cwd(), 'src/renderer/src/assets/backdrops/splash-night-sky.png')).size
  assert.ok(size < 300 * 1024, `splash-night-sky.png is ${Math.round(size / 1024)} KB`)
})
