// @vitest-environment jsdom
import { expect, test } from 'vitest'

import { webBuildIdOf, WEB_BUILD_META } from '../../../shared/web-client'
import { createWebBuildSkewCheck, ownWebBuildId, servedWebBuildId } from './webBuildWatch'

test('a page reads its own build id from the meta the web build writes', () => {
  document.head.innerHTML = `<meta name="${WEB_BUILD_META}" content="abc123def456.0a1b2c3d4e5f">`
  expect(ownWebBuildId()).toBe('abc123def456.0a1b2c3d4e5f')
  expect(webBuildIdOf(document.head.innerHTML)).toBe('abc123def456.0a1b2c3d4e5f')
  expect(webBuildIdOf('<html><head></head></html>')).toBeNull()
})

test('a reload is offered once per newer bundle, never for the same one or an unknown one', () => {
  const offer = createWebBuildSkewCheck('build-a')
  expect(offer('build-a')).toBe(false)
  expect(offer(null)).toBe(false)
  expect(offer('build-b')).toBe(true)
  expect(offer('build-b')).toBe(false)
  expect(offer('build-c')).toBe(true)
  // A page without an id (a build before ids) compares nothing.
  expect(createWebBuildSkewCheck(null)('build-b')).toBe(false)
})

test('the served id comes from the session answer, and a failure is no answer', async () => {
  const answer = (body: unknown, ok = true) => (async () => ({ ok, json: async () => body })) as unknown as typeof fetch
  expect(await servedWebBuildId(answer({ ok: true, build: 'build-b' }))).toBe('build-b')
  expect(await servedWebBuildId(answer({ ok: true, build: null }))).toBeNull()
  expect(await servedWebBuildId(answer({}, false))).toBeNull()
  expect(
    await servedWebBuildId((async () => {
      throw new Error('offline')
    }) as unknown as typeof fetch),
  ).toBeNull()
})
