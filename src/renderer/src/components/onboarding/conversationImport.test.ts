import assert from 'node:assert/strict'
import { test } from 'vitest'

import type { ConversationImportFolder, ConversationImportSession } from '../../../../shared/electron-api'
import {
  defaultImportSelection,
  describeFound,
  describeImportResult,
  folderCheckState,
  importableCount,
  sessionKey,
  withFolder,
} from './conversationImport'

const NOW = Date.parse('2026-09-30T12:00:00Z')
const DAY = 24 * 60 * 60 * 1000

function session(sessionId: string, overrides: Partial<ConversationImportSession> = {}): ConversationImportSession {
  return {
    source: 'claude-code',
    sessionId,
    title: sessionId,
    folderPath: '/Users/dev/acme-app',
    startedAt: NOW - DAY,
    updatedAt: NOW - DAY,
    imported: false,
    ...overrides,
  }
}

function folder(sessions: ConversationImportSession[]): ConversationImportFolder {
  return { folderPath: '/Users/dev/acme-app', name: 'acme-app', lastActiveAt: NOW, sessions }
}

test('the recent sessions that are not chats yet are ticked to begin with', () => {
  const folders = [
    folder([
      session('recent'),
      session('old', { updatedAt: NOW - 45 * DAY }),
      session('done', { imported: true }),
      session('codex', { source: 'codex' }),
    ]),
  ]
  assert.deepEqual([...defaultImportSelection(folders, NOW)].sort(), ['claude-code:recent', 'codex:codex'])
  assert.equal(importableCount(folders), 3)
})

test('a folder’s box is ticked, mixed or clear by the sessions it offers', () => {
  const only = folder([session('a'), session('b'), session('done', { imported: true })])
  assert.equal(folderCheckState(only, new Set()), false)
  assert.equal(folderCheckState(only, new Set([sessionKey(session('a'))])), 'mixed')
  const all = withFolder(new Set(), only, true)
  assert.deepEqual([...all].sort(), ['claude-code:a', 'claude-code:b'], 'an imported session is never ticked')
  assert.equal(folderCheckState(only, all), true)
  assert.equal(withFolder(all, only, false).size, 0)
})

test('the card says what it found from each CLI', () => {
  const folders = [folder([session('a'), session('b'), session('c', { source: 'codex' })])]
  assert.equal(describeFound(folders), '2 from Claude Code and 1 from Codex')
  assert.equal(describeFound([folder([session('a')])]), '1 from Claude Code')
})

test('the toast an import ends with says what it made and what it could not', () => {
  const made = { source: 'codex' as const, sessionId: 'a', workspaceId: 'w', agentId: 'g' }
  assert.deepEqual(describeImportResult({ ok: true, imported: [made, made], skipped: 0, failed: [] }), {
    tone: 'neutral',
    title: 'Imported 2 conversations.',
  })
  const failure = { source: 'codex' as const, sessionId: 'b', title: 'Add caching', message: 'Disk full.' }
  assert.deepEqual(describeImportResult({ ok: true, imported: [made], skipped: 0, failed: [failure] }), {
    tone: 'neutral',
    title: 'Imported 1 conversation.',
    description: '1 conversation could not be imported. Add caching: Disk full.',
  })
  assert.deepEqual(describeImportResult({ ok: true, imported: [], skipped: 0, failed: [failure] }), {
    tone: 'error',
    title: 'Could not import 1 conversation.',
    description: 'Add caching: Disk full.',
  })
  assert.equal(
    describeImportResult({ ok: true, imported: [], skipped: 3, failed: [] }).title,
    'Those conversations are already chats here.',
  )
  assert.equal(describeImportResult({ ok: false, message: 'No home.' }).tone, 'error')
})
