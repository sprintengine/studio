import assert from 'node:assert/strict'
import { test } from 'vitest'

import { scheduledAgentTitle, validateScheduledAgentDraft } from './scheduled-agents'

const NOW = Date.UTC(2026, 8, 30, 12, 10)

const valid = {
  prompt: '  Triage the new issues.\nThen post a summary.  ',
  schedule: { cron: ' 0 9 * * 1-5 ', timezone: 'Europe/Dublin' },
  folderPath: '/Users/dev/acme',
  hostId: null,
  cli: 'claude-code',
  cliModel: '',
  permissionPreset: 'bypass',
  skills: [{ id: 'triage', name: 'Triage' }, { id: 'triage' }, { name: 'no id' }],
  mcpServers: [{ id: 'github' }],
  worktree: { name: ' triage ' },
}

test('a scheduled agent is titled by its prompt’s first line', () => {
  assert.equal(scheduledAgentTitle('\n  Triage the new issues.\nThen post.'), 'Triage the new issues.')
  assert.equal(scheduledAgentTitle('   '), 'Scheduled agent')
  assert.equal(scheduledAgentTitle('x'.repeat(100)).length, 80)
})

test('a draft is trimmed and its attachments deduplicated', () => {
  const validated = validateScheduledAgentDraft(valid, NOW)
  assert.deepEqual(validated, {
    ok: true,
    draft: {
      prompt: 'Triage the new issues.\nThen post a summary.',
      schedule: { cron: '0 9 * * 1-5', timezone: 'Europe/Dublin' },
      folderPath: '/Users/dev/acme',
      hostId: null,
      cli: 'claude-code',
      cliModel: null,
      permissionPreset: 'bypass',
      skills: [{ id: 'triage', name: 'Triage' }],
      mcpServers: [{ id: 'github', name: 'github' }],
      worktree: { name: 'triage' },
    },
  })
})

test('a draft that cannot run is refused with the reason', () => {
  const refused = (overrides: Record<string, unknown>) => {
    const result = validateScheduledAgentDraft({ ...valid, ...overrides }, NOW)
    return result.ok ? null : result.message
  }
  assert.equal(refused({ prompt: ' ' }), 'A scheduled agent needs a prompt.')
  assert.equal(refused({ folderPath: '' }), 'A scheduled agent needs a project folder to run in.')
  assert.equal(refused({ schedule: { cron: '0 9 * *', timezone: 'UTC' } })?.includes('five parts'), true)
  assert.equal(
    refused({ schedule: { cron: '0 9 * * *', timezone: 'Mars/Olympus' } }),
    '"Mars/Olympus" is not a timezone this computer knows.',
  )
  assert.equal(
    refused({ schedule: { cron: '0 0 30 2 *', timezone: 'UTC' } }),
    'That schedule never comes round — no calendar has that day.',
  )
  assert.equal(
    refused({ hostId: 'build-box' }),
    'A scheduled agent runs on this machine or one of its WSL distributions.',
  )
  assert.equal(refused({ permissionPreset: 'sometimes' }), '"sometimes" is not a permission preset.')
})

test('a WSL distribution is a machine a scheduled agent can run on', () => {
  const result = validateScheduledAgentDraft({ ...valid, hostId: 'wsl:Ubuntu' }, NOW)
  assert.equal(result.ok && result.draft.hostId, 'wsl:Ubuntu')
})
