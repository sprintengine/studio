import assert from 'node:assert/strict'
import { test } from 'vitest'
import { detectLanguage } from './files'

test('detectLanguage selects the patch grammar for unified-diff files', () => {
  assert.equal(detectLanguage('change.patch'), 'patch')
  assert.equal(detectLanguage('/repo/CHANGE.PATCH'), 'patch')
  assert.equal(detectLanguage('review.diff'), 'patch')
})

test('detectLanguage keeps the plain-text fallback for unknown files', () => {
  assert.equal(detectLanguage('notes.unknown'), 'plaintext')
})
