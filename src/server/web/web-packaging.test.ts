import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from 'vitest'

// The web client's bundle is the server's to serve; the desktop installer
// does not carry it, as it does not carry the standalone server.
test('the desktop package leaves the web bundle and the server bundle out', () => {
  const manifest = JSON.parse(readFileSync(join(__dirname, '..', '..', '..', 'package.json'), 'utf8')) as {
    build: { files: string[] }
    scripts: Record<string, string>
  }
  expect(manifest.build.files).toContain('!out/web/**')
  expect(manifest.build.files).toContain('!out/server/**')
  expect(manifest.scripts['build:web']).toContain('vite.web.config.ts')
})
