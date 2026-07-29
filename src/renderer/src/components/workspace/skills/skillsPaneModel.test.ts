import assert from 'node:assert/strict'

import {
  buildSkillsPaneView,
  firstSentence,
  readsSkills,
  type CapabilitySnapshot,
  type SkillsPaneInput,
} from './skillsPaneModel'
import type { AgentSkill, AgentMcpServer, CapabilityDiagnostic } from '../../../../../shared/skills'
import type { BuiltinSkill } from '../../../../../shared/electron-api'

function skill(overrides: Partial<AgentSkill> & Pick<AgentSkill, 'id'>): AgentSkill {
  return {
    name: overrides.id,
    description: '',
    invocation: `/${overrides.id}`,
    source: 'builtin',
    pluginIds: ['claude-code'],
    ...overrides,
  }
}

function server(overrides: Partial<AgentMcpServer> & Pick<AgentMcpServer, 'id'>): AgentMcpServer {
  return {
    transport: 'stdio',
    scope: 'workspace',
    configPath: '.mcp.json',
    ...overrides,
  }
}

function snapshot(overrides: Partial<CapabilitySnapshot> = {}): CapabilitySnapshot {
  return {
    support: 'native',
    harnessId: 'claude',
    skills: [],
    servers: [],
    diagnostics: [],
    ...overrides,
  }
}

function input(overrides: Partial<SkillsPaneInput> = {}): SkillsPaneInput {
  return {
    snapshot: snapshot(),
    loading: false,
    unavailableMessage: null,
    agentLabel: 'Claude Code',
    query: '',
    catalogue: [],
    restartPending: [],
    writeReport: null,
    useError: null,
    ...overrides,
  }
}

const builtin = (id: string, description = ''): BuiltinSkill => ({
  id,
  name: id,
  version: '1.0.0',
  description,
})

// --- the supporting clause is one real sentence, never invented copy ---------
assert.equal(firstSentence('Do a thing. Then another thing.'), 'Do a thing.')
assert.equal(firstSentence('No terminator here'), 'No terminator here')
assert.equal(firstSentence('  '), '')

// --- populated ---------------------------------------------------------------
{
  const view = buildSkillsPaneView(
    input({
      snapshot: snapshot({
        skills: [skill({ id: 'backlog', description: 'Work Backlog items. Long tail.' })],
        servers: [server({ id: 'github', toolCount: 12 })],
      }),
    }),
  )
  assert.equal(view.body.kind, 'sections')
  assert.equal(view.notices.length, 0)
  if (view.body.kind !== 'sections') throw new Error('unreachable')
  assert.equal(view.body.skills[0].supporting, 'Work Backlog items.')
  assert.equal(view.body.skills[0].description, 'Work Backlog items. Long tail.')
  assert.equal(view.body.servers[0].toolCount, 12)
}

// --- no tool count is rendered when the resolver returned none ---------------
{
  const view = buildSkillsPaneView(
    input({ snapshot: snapshot({ servers: [server({ id: 'local' })] }) }),
  )
  if (view.body.kind !== 'sections') throw new Error('expected sections')
  assert.equal(view.body.servers[0].toolCount, null, 'an unstated tool count stays absent, never 0')
}

// --- empty: both halves empty, native, no faults -----------------------------
{
  const view = buildSkillsPaneView(input())
  assert.equal(view.body.kind, 'empty')
  assert.equal(view.notices.length, 0)
}

// --- loading -----------------------------------------------------------------
{
  const view = buildSkillsPaneView(input({ snapshot: null, loading: true }))
  assert.equal(view.body.kind, 'loading')
}

// --- unsupported: named, and the list is not blamed --------------------------
{
  const view = buildSkillsPaneView(
    input({ snapshot: snapshot({ support: 'unsupported', harnessId: '' }) }),
  )
  assert.equal(view.notices.length, 1)
  assert.equal(view.notices[0].kind, 'unsupported')
  assert.equal(readsSkills('unsupported'), false)
  assert.equal(readsSkills('prompt-shim'), true, 'prompt-shim reads skills by another route')
}

// --- failed: an unreadable path NEVER renders as an empty list ---------------
for (const reason of ['unreadable', 'malformed'] as const) {
  const diagnostic: CapabilityDiagnostic = {
    capability: reason === 'malformed' ? 'servers' : 'skills',
    reason,
    path: '.claude/skills',
    message: 'EACCES',
  }
  const view = buildSkillsPaneView(input({ snapshot: snapshot({ diagnostics: [diagnostic] }) }))
  assert.notEqual(view.body.kind, 'empty', `${reason} must not read as an empty workspace`)
  assert.equal(view.body.kind, 'fault')
  assert.equal(view.notices[0].kind, 'unreadable')
  assert.equal(view.notices[0].kind === 'unreadable' && view.notices[0].path, '.claude/skills')
}

// --- a fault in one half never blanks the other ------------------------------
{
  const view = buildSkillsPaneView(
    input({
      snapshot: snapshot({
        skills: [skill({ id: 'backlog' })],
        diagnostics: [
          { capability: 'servers', reason: 'malformed', path: '.mcp.json', message: 'bad json' },
        ],
      }),
    }),
  )
  assert.equal(view.body.kind, 'sections')
  if (view.body.kind !== 'sections') throw new Error('unreachable')
  assert.equal(view.body.skills.length, 1, 'an unparseable MCP config still lists the skills')
  assert.equal(view.notices[0].kind, 'unreadable')
}

// --- stale: correct, and possibly out of date --------------------------------
{
  const view = buildSkillsPaneView(
    input({
      snapshot: snapshot({
        skills: [skill({ id: 'backlog' })],
        diagnostics: [
          {
            capability: 'freshness',
            reason: 'watch_unavailable',
            path: '.claude/skills',
            message: 'Watching is unavailable on this mount.',
          },
        ],
      }),
    }),
  )
  assert.equal(view.notices[0].kind, 'stale')
  assert.equal(view.body.kind, 'sections', 'stale is not a failure — the list still renders')
}

// --- search spans both halves, and counts reflect what is SHOWN --------------
{
  const view = buildSkillsPaneView(
    input({
      snapshot: snapshot({
        skills: [skill({ id: 'backlog' }), skill({ id: 'review-guide' })],
        servers: [server({ id: 'backlog-mcp' }), server({ id: 'github' })],
      }),
      query: 'backlog',
    }),
  )
  if (view.body.kind !== 'sections') throw new Error('expected sections')
  assert.equal(view.body.skills.length, 1)
  assert.equal(view.body.servers.length, 1)
}

// --- a search matching nothing is its own empty ------------------------------
{
  const view = buildSkillsPaneView(
    input({ snapshot: snapshot({ skills: [skill({ id: 'backlog' })] }), query: 'zzz' }),
  )
  assert.equal(view.body.kind, 'no-matches')
  assert.equal(view.body.kind === 'no-matches' && view.body.query, 'zzz')
}

// --- the catalogue is search-only, and never mixed into the reachable list ---
{
  const catalogue = [builtin('review-guide', 'Build a review walkthrough.'), builtin('backlog')]
  const atRest = buildSkillsPaneView(
    input({ snapshot: snapshot({ skills: [skill({ id: 'backlog' })] }), catalogue }),
  )
  if (atRest.body.kind !== 'sections') throw new Error('expected sections')
  assert.equal(atRest.body.available.length, 0, 'at rest the pane answers what the agent reaches')
  assert.equal(atRest.body.catalogueRemaining, 1, 'only the one not already reachable')

  const searched = buildSkillsPaneView(
    input({
      snapshot: snapshot({ skills: [skill({ id: 'backlog' })] }),
      catalogue,
      query: 'review',
    }),
  )
  if (searched.body.kind !== 'sections') throw new Error('expected sections')
  assert.equal(searched.body.available.length, 1)
  assert.equal(searched.body.available[0].installed, false)
  assert.equal(searched.body.skills.length, 0)
}

// --- a partial write reads as partial, never as a bare failure ---------------
{
  const view = buildSkillsPaneView(
    input({
      snapshot: snapshot({ skills: [skill({ id: 'backlog' })] }),
      writeReport: {
        verb: 'add',
        skillId: 'backlog',
        message: null,
        targets: [
          { harnessId: 'claude', pluginIds: ['claude-code'], path: '.claude/skills/backlog', restartRequired: true, status: 'written' },
          { harnessId: 'codex', pluginIds: ['codex'], path: '.codex/skills/backlog', restartRequired: true, status: 'failed', message: 'EACCES' },
        ],
      },
    }),
  )
  const partial = view.notices.find((notice) => notice.kind === 'write-partial')
  assert.ok(partial, 'a partial failure is stated as such')
  assert.equal(partial.kind === 'write-partial' && partial.written.length, 1)
  assert.equal(partial.kind === 'write-partial' && partial.failed[0].path, '.codex/skills/backlog')
}

// --- an all-successful write says nothing at all -----------------------------
{
  const view = buildSkillsPaneView(
    input({
      snapshot: snapshot({ skills: [skill({ id: 'backlog' })] }),
      writeReport: {
        verb: 'add',
        skillId: 'backlog',
        message: null,
        targets: [
          { harnessId: 'claude', pluginIds: ['claude-code'], path: '.claude/skills/backlog', restartRequired: false, status: 'written' },
        ],
      },
    }),
  )
  assert.equal(view.notices.length, 0)
}

// --- a write that could not be attempted at all ------------------------------
{
  const view = buildSkillsPaneView(
    input({
      writeReport: { verb: 'add', skillId: 'nope', message: 'Nothing to attach', targets: [] },
    }),
  )
  assert.equal(view.notices[0].kind, 'write-failed')
}

// --- a Use that never reached the prompt is said, not swallowed -------------
{
  const view = buildSkillsPaneView(
    input({
      snapshot: snapshot({ skills: [skill({ id: 'backlog' })] }),
      useError: { skillId: 'backlog', message: 'Terminal session is no longer running.' },
    }),
  )
  const notice = view.notices.find((candidate) => candidate.kind === 'use-failed')
  assert.deepEqual(notice, {
    kind: 'use-failed',
    agentLabel: 'Claude Code',
    skillId: 'backlog',
    message: 'Terminal session is no longer running.',
  })
  // The list is untouched by it: the skill is still there, it just did not go.
  assert.equal(view.body.kind, 'sections')
}

// --- the restart banner is one per tab, and only where skills are read -------
{
  const supported = buildSkillsPaneView(
    input({ snapshot: snapshot({ skills: [skill({ id: 'backlog' })] }), restartPending: ['backlog'] }),
  )
  assert.equal(supported.notices.filter((notice) => notice.kind === 'restart').length, 1)

  const unsupported = buildSkillsPaneView(
    input({ snapshot: snapshot({ support: 'unsupported' }), restartPending: ['backlog'] }),
  )
  assert.equal(
    unsupported.notices.filter((notice) => notice.kind === 'restart').length,
    0,
    'a CLI that reads no skills has nothing to restart for',
  )
}

// --- no agent focused, and no workspace open ---------------------------------
{
  assert.equal(buildSkillsPaneView(input({ agentLabel: null })).body.kind, 'no-agent')
  const noWorkspace = buildSkillsPaneView(
    input({ snapshot: null, unavailableMessage: 'Open a project folder.' }),
  )
  assert.equal(noWorkspace.body.kind, 'unavailable')
}

console.log('skillsPaneModel: ok')
