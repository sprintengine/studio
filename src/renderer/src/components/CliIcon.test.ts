import assert from 'node:assert/strict'

import { resolveCliIconKind } from './CliIcon'

assert.equal(resolveCliIconKind('codex'), 'codex')
assert.equal(resolveCliIconKind('claude'), 'terminal')
assert.equal(resolveCliIconKind('claude-code'), 'claude-code')
assert.equal(resolveCliIconKind('generic-shell'), 'terminal')
assert.equal(resolveCliIconKind('opencode'), 'opencode')

console.log('CliIcon.test.ts: ok')
