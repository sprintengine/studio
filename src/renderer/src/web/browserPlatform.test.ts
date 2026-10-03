import { expect, test } from 'vitest'

import { browserPlatform } from './browserPlatform'

// The browser's OS decides the Primary modifier, whatever the server runs on.
test('the platform is the browser’s own, from client hints first, then the user agent', () => {
  expect(browserPlatform({ userAgent: '', userAgentData: { platform: 'Windows' } })).toBe('win32')
  expect(browserPlatform({ userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 15_0)' })).toBe('darwin')
  expect(browserPlatform({ userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' })).toBe('win32')
  expect(browserPlatform({ userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)' })).toBe('ios')
  expect(browserPlatform({ userAgent: 'Mozilla/5.0 (X11; Linux x86_64)' })).toBe('linux')
})
