import assert from 'node:assert/strict'

import { safeExternalUrl } from './external-url'

function main(): void {
  // Accepts http and https.
  assert.deepEqual(safeExternalUrl('https://example.com/path?q=1'), {
    ok: true,
    url: 'https://example.com/path?q=1',
  })
  assert.deepEqual(safeExternalUrl('http://localhost:3000'), {
    ok: true,
    url: 'http://localhost:3000',
  })

  // Rejects dangerous schemes that terminal output could smuggle in.
  for (const dangerous of [
    'file:///etc/passwd',
    'vscode://file/etc/passwd',
    'javascript:alert(1)',
    'mailto:a@b.com',
    'ftp://host/x',
  ]) {
    const result = safeExternalUrl(dangerous)
    assert.equal(result.ok, false, `expected ${dangerous} to be rejected`)
  }

  // Rejects empty and non-string input.
  assert.equal(safeExternalUrl('').ok, false)
  assert.equal(safeExternalUrl('   ').ok, false)
  assert.equal(safeExternalUrl(undefined).ok, false)
  assert.equal(safeExternalUrl(42).ok, false)

  // Rejects unparsable links.
  assert.equal(safeExternalUrl('not a url').ok, false)

  console.log('external-url tests passed')
}

main()
