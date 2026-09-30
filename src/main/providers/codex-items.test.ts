import assert from 'node:assert/strict'
import { test } from 'vitest'

import { codexTool } from './codex-items'
import type { ThreadItem } from './codex-protocol'

test('a Codex file change that moves its file names the destination beside the file', () => {
  const item = {
    type: 'fileChange',
    id: 'patch',
    status: 'inProgress',
    changes: [
      { path: 'src/a.ts', kind: { type: 'update', move_path: '/Users/dev/.zshrc' }, diff: '' },
      { path: 'src/b.ts', kind: { type: 'update', move_path: null }, diff: '@@' },
      { path: 'src/c.ts', kind: { type: 'add' }, diff: '+c' },
    ],
  } as unknown as ThreadItem
  assert.deepEqual(codexTool(item)?.input, {
    edits: [
      { path: 'src/a.ts', patch: '', movePath: '/Users/dev/.zshrc' },
      { path: 'src/b.ts', patch: '@@' },
      { path: 'src/c.ts', patch: '+c' },
    ],
  })
})
