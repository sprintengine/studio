import assert from 'node:assert/strict'
import { commandMatchesQuery, workspaceKeywordsFromDefinition } from './commandPaletteSearch'

function run(name: string, body: () => void): void {
  try {
    body()
    console.log(`ok - ${name}`)
  } catch (error) {
    console.error(`not ok - ${name}`)
    throw error
  }
}

run('workspaceKeywordsFromDefinition joins label + curated search terms', () => {
  assert.equal(
    workspaceKeywordsFromDefinition({ label: 'Sprint Engine', searchTerms: ['roster', 'kanban'] }, 'sprintengine'),
    'Sprint Engine roster kanban',
  )
})

run('workspaceKeywordsFromDefinition tolerates a definition with no search terms', () => {
  assert.equal(workspaceKeywordsFromDefinition({ label: 'Standard' }, 'standard'), 'Standard')
})

run('workspaceKeywordsFromDefinition falls back to the raw mode id when unregistered', () => {
  assert.equal(workspaceKeywordsFromDefinition(null, 'future-plugin-mode'), 'future-plugin-mode')
  assert.equal(workspaceKeywordsFromDefinition(undefined, 'shell-mode'), 'shell-mode')
})

// The switch row's keyword field is where a workspace's mode terms live, so
// these assert the C2/C3 regression fix: typing a mode term surfaces the row
// even though neither the name (label) nor folder path (description) contains it.
const kanbanRow = {
  label: 'Switch to: API cleanup',
  description: '/Users/dev/work/acme-platform',
  keywords: workspaceKeywordsFromDefinition({ label: 'Sprint Engine', searchTerms: ['roster', 'kanban', 'watchtower'] }, 'sprintengine'),
}

run('commandMatchesQuery matches a mode search term carried in keywords', () => {
  assert.equal(commandMatchesQuery(kanbanRow, 'kanban'), true)
  assert.equal(commandMatchesQuery(kanbanRow, 'watchtower'), true)
  assert.equal(commandMatchesQuery(kanbanRow, 'sprint engine'), true)
})

run('commandMatchesQuery matches on the visible name and folder path too', () => {
  assert.equal(commandMatchesQuery(kanbanRow, 'api cleanup'), true)
  assert.equal(commandMatchesQuery(kanbanRow, 'acme-platform'), true)
})

run('commandMatchesQuery is case-insensitive and trims the query', () => {
  assert.equal(commandMatchesQuery(kanbanRow, '  KANBAN  '), true)
})

run('commandMatchesQuery returns false when nothing matches', () => {
  assert.equal(commandMatchesQuery(kanbanRow, 'nonexistent-term'), false)
})

run('commandMatchesQuery treats an empty query as matching every command', () => {
  assert.equal(commandMatchesQuery({ label: 'anything' }, ''), true)
  assert.equal(commandMatchesQuery({ label: 'anything' }, '   '), true)
})

run('commandMatchesQuery tolerates a command with no description or keywords', () => {
  assert.equal(commandMatchesQuery({ label: 'New Chat' }, 'chat'), true)
  assert.equal(commandMatchesQuery({ label: 'New Chat' }, 'kanban'), false)
})

console.log('commandPaletteSearch: all assertions passed')
