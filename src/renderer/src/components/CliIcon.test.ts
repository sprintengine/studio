import assert from 'node:assert/strict'

import { resolveCliIconKind } from './CliIcon'

assert.equal(resolveCliIconKind('codex'), 'codex')
assert.equal(resolveCliIconKind('claude'), 'terminal')
assert.equal(resolveCliIconKind('claude-code'), 'claude-code')
assert.equal(resolveCliIconKind('generic-shell'), 'terminal')
assert.equal(resolveCliIconKind('opencode'), 'opencode')
assert.equal(resolveCliIconKind('zai'), 'zai')
assert.equal(resolveCliIconKind('grok'), 'grok')
assert.equal(resolveCliIconKind('kimi-code'), 'kimi')
assert.equal(resolveCliIconKind('kimi-claude'), 'kimi')
assert.equal(resolveCliIconKind('cursor'), 'cursor')

console.log('CliIcon.test.ts: ok')
