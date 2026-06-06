import assert from 'node:assert/strict'

import { resolveCliIconKind } from './CliIcon'

assert.equal(resolveCliIconKind('codex'), 'codex')
assert.equal(resolveCliIconKind('claude'), 'claude')
assert.equal(resolveCliIconKind('claude-code'), 'claude')
assert.equal(resolveCliIconKind('generic-shell'), 'terminal')
assert.equal(resolveCliIconKind('opencode'), 'terminal')

console.log('CliIcon.test.ts: ok')
