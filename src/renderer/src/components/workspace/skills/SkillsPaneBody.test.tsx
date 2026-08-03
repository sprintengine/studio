import assert from 'node:assert/strict'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

import { SkillsPaneBody } from './SkillsPaneBody'
import { buildSkillsPaneView, type CapabilitySnapshot, type SkillsPaneInput } from './skillsPaneModel'
import type { AgentSkill, AgentMcpServer } from '../../../../../shared/skills'

// Every state the pane can be in, rendered. The point of the suite is that the
// six states are DISTINGUISHABLE in the output a person actually sees — a
// failed read that renders the same markup as an empty workspace is the defect
// this file exists to catch.

function snapshot(overrides: Partial<CapabilitySnapshot> = {}): CapabilitySnapshot {
  return { support: 'native', harnessId: 'claude', skills: [], servers: [], diagnostics: [], ...overrides }
}

const SKILL: AgentSkill = {
  id: 'backlog',
  name: 'backlog',
  description: 'Work Backlog items and epics. Use when the user asks to triage.',
  invocation: '/backlog',
  source: 'builtin',
  pluginIds: ['claude-code', 'zai'],
}

const SERVER: AgentMcpServer = {
  id: 'github',
  transport: 'stdio',
  scope: 'workspace',
  configPath: '.mcp.json',
}

function render(overrides: Partial<SkillsPaneInput> = {}, props: Partial<Parameters<typeof SkillsPaneBody>[0]> = {}): string {
  const view = buildSkillsPaneView({
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
  })
  return renderToStaticMarkup(
    <SkillsPaneBody
      view={view}
      expandedKey={null}
      pendingSkillId={null}
      canWrite
      canUse
      agentLabel="Claude Code"
      implicitInvocation={false}
      onExpand={() => {}}
      onAdd={() => {}}
      onRemove={() => {}}
      onUse={() => {}}
      onDragStart={() => {}}
      onRetry={() => {}}
      onOpenExtensions={() => {}}
      onDismissWriteReport={() => {}}
      onDismissUseError={() => {}}
      {...props}
    />,
  )
}

// --- 1. populated ------------------------------------------------------------
const populated = render({ snapshot: snapshot({ skills: [SKILL], servers: [SERVER] }) })
assert.match(populated, /Skills/, 'populated: skills section head')
assert.match(populated, /MCP servers/, 'populated: servers section head')
assert.match(populated, /backlog/, 'populated: the skill id is the row title')
assert.match(populated, /Work Backlog items and epics\./, 'populated: the real description, not invented copy')
assert.doesNotMatch(
  populated,
  /Use when the user asks to triage/,
  'populated: the supporting clause is ONE sentence — the rest lives in the tooltip and the disclosure',
)
assert.doesNotMatch(populated, /No skills or MCP servers/, 'populated: not the empty line')

// --- 2. empty ----------------------------------------------------------------
const empty = render()
assert.match(empty, /No skills or MCP servers for this agent\./)
assert.doesNotMatch(empty, /Could not read/, 'empty: no failure language')

// --- 3. loading --------------------------------------------------------------
const loading = render({ snapshot: null, loading: true })
assert.match(loading, /Reading this agent’s skills…/)
// One animation at a time: a single spinner, never a spinner over a skeleton field.
assert.equal((loading.match(/skeleton-shimmer/g) ?? []).length, 0, 'loading: no skeletons beside the spinner')

// --- 4. unsupported ----------------------------------------------------------
const unsupported = render({ snapshot: snapshot({ support: 'unsupported', harnessId: '' }) })
assert.match(unsupported, /Claude Code does not read skills\./)
assert.match(unsupported, /Your other agents keep every skill below\./)

// --- 5. failed — and never as an empty list ----------------------------------
for (const reason of ['unreadable', 'malformed'] as const) {
  const failed = render({
    snapshot: snapshot({
      diagnostics: [{ capability: 'skills', reason, path: '.claude/skills', message: 'EACCES' }],
    }),
  })
  assert.match(failed, /Could not read this agent’s skills\./, `${reason}: names the failure`)
  assert.match(failed, /\.claude\/skills/, `${reason}: names the path`)
  assert.match(failed, /Try again/, `${reason}: offers the retry`)
  assert.doesNotMatch(
    failed,
    /No skills or MCP servers for this agent\./,
    `${reason}: a broken dependency must never render as an empty list`,
  )
}

// --- 6. stale ----------------------------------------------------------------
const stale = render({
  snapshot: snapshot({
    skills: [SKILL],
    diagnostics: [
      { capability: 'freshness', reason: 'watch_unavailable', path: '.claude/skills', message: 'Watching is unavailable here.' },
    ],
  }),
})
assert.match(stale, /This list may be out of date\./)
assert.match(stale, /backlog/, 'stale: the list is still shown, because it is still correct')

// An unreadable path is normally unwatchable too. The danger banner already
// names that path and offers the retry, so the quieter stale banner must not
// repeat the same failure — with the watcher's raw error string attached.
const failedAndUnwatchable = render({
  snapshot: snapshot({
    diagnostics: [
      { capability: 'skills', reason: 'unreadable', path: '.claude/skills', message: 'EACCES' },
      {
        capability: 'freshness',
        reason: 'watch_unavailable',
        path: '.claude/skills',
        message: 'EACCES: permission denied, watch \'.claude/skills\'. Picked up on focus.',
      },
    ],
  }),
})
assert.match(failedAndUnwatchable, /Could not read this agent’s skills\./)
assert.doesNotMatch(
  failedAndUnwatchable,
  /This list may be out of date\./,
  'one failed path is one banner, not two',
)

// A watch that fails on a path that still reads is its own state, and keeps its
// banner.
const staleOnly = render({
  snapshot: snapshot({
    skills: [SKILL],
    diagnostics: [
      {
        capability: 'freshness',
        reason: 'watch_unavailable',
        path: '.claude/skills',
        message: 'Watching is unavailable here.',
      },
    ],
  }),
})
assert.match(staleOnly, /This list may be out of date\./, 'a lone watch failure still says so')

// A watch failure filed against a non-freshness capability must not suppress
// itself: the path has no danger banner, so dropping the notice would leave the
// failure unnamed anywhere on the surface.
const oddlyFiledWatchFailure = render({
  snapshot: snapshot({
    skills: [SKILL],
    diagnostics: [
      {
        capability: 'skills',
        reason: 'watch_unavailable',
        path: '.claude/skills',
        message: 'Watching is unavailable here.',
      },
    ],
  }),
})
assert.match(
  oddlyFiledWatchFailure,
  /This list may be out of date\./,
  'a watch failure never suppresses itself',
)

// --- search with no matches is its own empty, and offers Extensions ----------
const noMatches = render({ snapshot: snapshot({ skills: [SKILL] }), query: 'zzz' })
assert.match(noMatches, /No skill or server matches “zzz”\./)
assert.match(noMatches, /Search your sources/)
assert.doesNotMatch(noMatches, /No skills or MCP servers for this agent\./, 'search-empty ≠ pane-empty')

// --- counts reflect what is shown, not what exists ---------------------------
const filtered = render({
  snapshot: snapshot({
    skills: [SKILL, { ...SKILL, id: 'review-guide', description: 'Build a reviewer walkthrough.' }],
    servers: [SERVER],
  }),
  query: 'backlog',
})
assert.match(filtered, /Skills<\/span><span class="[^"]*tabular-nums[^"]*">1</, 'the shown count is 1, not 2')

// --- a server tool count appears only when the resolver returned one ---------
const noCount = render({ snapshot: snapshot({ servers: [SERVER] }) })
assert.doesNotMatch(noCount, /tabular-nums[^>]*>0</, 'an unstated tool count is absent, never 0')
const withCount = render({ snapshot: snapshot({ servers: [{ ...SERVER, toolCount: 12 }] }) })
assert.match(withCount, />12</)

// --- row actions are named, reachable, and their slot reserves its width -----
const rows = render({ snapshot: snapshot({ skills: [SKILL] }) })
assert.match(rows, /aria-label="Remove backlog"/, 'installed rows offer remove')
// Reveal is opacity-only and rides focus as well as hover, so the actions are
// reachable by keyboard and revealing one never reflows the row.
assert.match(rows, /opacity-0[^"]*group-hover\/row:opacity-100[^"]*group-focus-within\/row:opacity-100/)
assert.match(rows, /M3 3h10v10H3zM3 6h10M6 6v7/, 'skill rows reuse the Extensions glyph')
assert.match(
  rows,
  /group-hover\/row:opacity-0 group-focus-within\/row:opacity-0/,
  'the glyph yields its fixed slot to the disclosure chevron on hover or focus',
)

const serverRow = render({ snapshot: snapshot({ servers: [SERVER] }) })
assert.match(
  serverRow,
  /M5\.5 2v3M10\.5 2v3M4 5h8v3\.5a4 4 0 0 1-8 0zM8 12\.5V14/,
  'MCP rows reuse the Extensions glyph',
)

// `targetPolicy` is what makes this row offerable at all: the catalogue only
// shows built-ins an Add would land in the focused agent's own harness.
const catalogueRow = render({
  snapshot: snapshot({ skills: [] }),
  catalogue: [{
    id: 'review-guide',
    name: 'review-guide',
    version: '1',
    description: 'Build a walkthrough.',
    targetPolicy: 'all-native',
  }],
  query: 'review',
})
assert.match(catalogueRow, /Not installed/)
assert.match(catalogueRow, /aria-label="Add review-guide"/, 'not-installed rows offer add')

// --- exactly one selected row, and it is neutral — never the accent ----------
const expanded = render(
  { snapshot: snapshot({ skills: [SKILL, { ...SKILL, id: 'review-guide' }] }) },
  { expandedKey: 'skill:backlog' },
)
assert.equal(
  (expanded.match(/aria-current="true"/g) ?? []).length,
  1,
  'exactly one row carries the selection',
)
assert.match(expanded, /bg-\[color:var\(--bg-selected\)\]/, 'selection is the neutral selected fill')
assert.doesNotMatch(
  expanded,
  /accent-primary\)\][^"]*"[^>]*aria-current/,
  'selection never uses the accent fill',
)
assert.doesNotMatch(expanded, /border-l-2/, 'selection never uses a left bar')
assert.doesNotMatch(expanded, /Built in/, 'expanded skills omit provenance metadata')
assert.doesNotMatch(expanded, /Read by/, 'expanded skills omit runtime readership metadata')

const expandedImplicit = render(
  { snapshot: snapshot({ skills: [SKILL] }) },
  { expandedKey: 'skill:backlog', implicitInvocation: true },
)
assert.match(expandedImplicit, /Claude Code may also run it unprompted/)
assert.doesNotMatch(expandedImplicit, /Built in|Read by/)

// --- a partial write is visible as partial -----------------------------------
const partial = render({
  snapshot: snapshot({ skills: [SKILL] }),
  writeReport: {
    verb: 'add',
    skillId: 'backlog',
    message: null,
    targets: [
      { harnessId: 'claude', pluginIds: ['claude-code'], path: '.claude/skills/backlog', restartRequired: false, status: 'written' },
      { harnessId: 'codex', pluginIds: ['codex'], path: '.codex/skills/backlog', restartRequired: false, status: 'failed', message: 'EACCES' },
    ],
  },
})
assert.match(partial, /backlog reached 1 of 2 places\./)
assert.match(partial, /\.codex\/skills\/backlog/)

// --- the restart banner names what is waiting, once ---------------------------
const restart = render({ snapshot: snapshot({ skills: [SKILL] }), restartPending: ['backlog'] })
assert.match(restart, /Restart Claude Code/)
assert.equal((restart.match(/Restart Claude Code/g) ?? []).length, 1, 'one banner per tab, not one per row')

// --- use: one operation, offered to the mouse and to the keyboard ------------
// The row is the drag handle and the action beside it is the same thing for
// anyone not using a mouse — the drag is never the only way to reach it.
const usable = render({ snapshot: snapshot({ skills: [SKILL] }) })
assert.match(usable, /draggable="true"/, 'an installed skill can be dragged onto a terminal')
assert.match(usable, /aria-label="Send backlog to Claude Code"/, 'and clicked, for the keyboard')

// A CLI that reads no skills has no invocation to park: neither affordance.
const notUsable = render({ snapshot: snapshot({ skills: [SKILL] }) }, { canUse: false })
assert.doesNotMatch(notUsable, /draggable="true"/, 'unsupported: no drag handle')
assert.doesNotMatch(notUsable, /aria-label="Send backlog/, 'unsupported: no Send action')
assert.match(notUsable, /aria-label="Remove backlog"/, 'the row itself is unchanged')

// A skill the agent does not have yet is Add-only — Use would name something
// that is not there.
const notInstalled = render({
  snapshot: snapshot({ skills: [] }),
  catalogue: [{ id: 'review-guide', name: 'review-guide', version: '1', description: 'Build a walkthrough.' }],
  query: 'review',
})
assert.doesNotMatch(notInstalled, /draggable="true"/)
assert.doesNotMatch(notInstalled, /aria-label="Send review-guide/)

// The disclosure keeps exactly one accent fill, and for an installed skill it
// is Use — never a second Add beside it.
const expandedUsable = render(
  { snapshot: snapshot({ skills: [SKILL] }) },
  { expandedKey: 'skill:backlog' },
)
assert.match(expandedUsable, /Send to Claude Code/)
assert.doesNotMatch(expandedUsable, />Add</, 'an installed skill is never offered Add')

// --- a Send that did not land is reported, never silent ----------------------
const useFailed = render({
  snapshot: snapshot({ skills: [SKILL] }),
  useError: { skillId: 'backlog', message: 'Terminal session is no longer running.' },
})
assert.match(useFailed, /backlog was not sent to Claude Code\./)
assert.match(useFailed, /Terminal session is no longer running\./)
assert.match(useFailed, /backlog/, 'the list is still there — only the send failed')

// --- no agent focused ---------------------------------------------------------
assert.match(render({ agentLabel: null }), /No agent tab is focused\./)

console.log('SkillsPaneBody: ok')
