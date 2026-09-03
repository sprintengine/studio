import assert from 'node:assert/strict'
import { test } from 'node:test'

import type {
  SprintEngineRoleCliDefaults,
  SprintEngineRoleModelOverrides,
  SprintEngineRoleReasoningOverrides,
} from '../types/workspace'
import {
  buildPlanSourcedSprintEngineWorkspaceContext,
  buildSprintEngineRoleRuntimes,
  startTrackerIssueSprint,
} from './sprintengineWorkspaceCreation'

// Regression coverage for the Sprint Engine workspace-creation seam (MC-1712 /
// post-merge hardening), which shipped without a test of its own. The two pure
// functions here decide the per-role execution runtimes recorded into run.yaml
// and the run's directory/state layout — both feed every creation path.

// --- buildSprintEngineRoleRuntimes ------------------------------------------
// The MC-1712 fix: a recorded role must never ship without a CLI. A model-only
// pick (a registry role absent from the CLI-defaults baseline) previously persisted
// as `{model, cli:null}`, which hard-failed spawnAutoRunCandidate and stalled the
// roster runner. Assert the runtime map defaults the CLI whenever it records a
// role, unions both input maps, and drops a role that carries neither signal.

const models = (entries: Record<string, string | null>): SprintEngineRoleModelOverrides =>
  entries as SprintEngineRoleModelOverrides
const clis = (entries: Record<string, string>): SprintEngineRoleCliDefaults =>
  entries as SprintEngineRoleCliDefaults

test('a model-only role is recorded with the defaulted claude-code CLI (MC-1712)', () => {
  const runtimes = buildSprintEngineRoleRuntimes(models({ nuclear_reviewer: 'opus' }), clis({}))
  // The bug: without the default this shipped `{model:'opus', cli:null}` and
  // stalled the runner. The fix stamps a runnable CLI.
  assert.deepEqual(runtimes, { nuclear_reviewer: { model: 'opus', cli: 'claude-code' } })
})

test('a cli-only role passes its CLI through with a null model', () => {
  const runtimes = buildSprintEngineRoleRuntimes(models({}), clis({ developer: 'codex' }))
  assert.deepEqual(runtimes, { developer: { model: null, cli: 'codex' } })
})

test('a role present in both maps keeps its explicit model and CLI', () => {
  const runtimes = buildSprintEngineRoleRuntimes(
    models({ architect: 'sonnet' }),
    clis({ architect: 'cursor' }),
  )
  assert.deepEqual(runtimes, { architect: { model: 'sonnet', cli: 'cursor' } })
})

test('roles are unioned across both maps', () => {
  const runtimes = buildSprintEngineRoleRuntimes(
    models({ architect: 'sonnet' }),
    clis({ developer: 'codex' }),
  )
  assert.deepEqual(runtimes, {
    architect: { model: 'sonnet', cli: 'claude-code' },
    developer: { model: null, cli: 'codex' },
  })
})

test('a role with neither a model nor a CLI is dropped, not recorded with nulls', () => {
  // An explicit null-model entry with no CLI carries no runnable signal — it must
  // not persist into run.yaml as `{model:null, cli:null}`.
  const runtimes = buildSprintEngineRoleRuntimes(models({ tester: null }), clis({}))
  assert.deepEqual(runtimes, {})
})

test('empty and nullish inputs yield an empty runtime map', () => {
  assert.deepEqual(buildSprintEngineRoleRuntimes({}, {}), {})
  assert.deepEqual(buildSprintEngineRoleRuntimes(null, null), {})
  assert.deepEqual(buildSprintEngineRoleRuntimes(undefined, undefined), {})
})

// --- the seat reasoning-effort level (MC-1885) ------------------------------
// The level rides the same `roleRuntimes` entry as the CLI/model pick, so it
// reaches every spawn of the role through the one map the projection carries.

const efforts = (entries: Record<string, string | null>): SprintEngineRoleReasoningOverrides =>
  entries as SprintEngineRoleReasoningOverrides

test('a role effort level rides its runtime entry', () => {
  const runtimes = buildSprintEngineRoleRuntimes(
    models({ developer: 'claude-opus-5' }),
    clis({ developer: 'claude-code' }),
    efforts({ developer: 'high' }),
  )
  assert.deepEqual(runtimes, {
    developer: { model: 'claude-opus-5', cli: 'claude-code', reasoning: 'high' },
  })
})

test('a role with no level records no reasoning key at all', () => {
  const runtimes = buildSprintEngineRoleRuntimes(
    models({ developer: 'claude-opus-5' }),
    clis({ developer: 'claude-code' }),
    efforts({ developer: null, tester: 'max' }),
  )
  // `tester` has neither a model nor a CLI: a level alone has nothing to launch,
  // so it must not mint an entry the runner would then fail to spawn.
  assert.deepEqual(runtimes, { developer: { model: 'claude-opus-5', cli: 'claude-code' } })
})

test('omitting the effort map leaves every entry byte-identical to before', () => {
  assert.deepEqual(
    buildSprintEngineRoleRuntimes(models({ architect: 'sonnet' }), clis({ developer: 'codex' })),
    buildSprintEngineRoleRuntimes(models({ architect: 'sonnet' }), clis({ developer: 'codex' }), null),
  )
})

// --- buildPlanSourcedSprintEngineWorkspaceContext ---------------------------
// Derives the run's team name, slug, directory, and state-file path from the
// project root and team name. The state file must live inside the team directory
// under `.multi-code/sprintengine`, and inputs are trimmed before derivation.

test('the context places run.yaml inside the team directory under .multi-code/sprintengine', () => {
  const context = buildPlanSourcedSprintEngineWorkspaceContext('/repo', 'Login Redirect Fix')

  assert.equal(context.teamName, 'Login Redirect Fix')
  assert.ok(context.teamSlug.length > 0, 'slug is derived and non-empty')
  assert.ok(
    context.teamDirectoryPath.includes('.multi-code/sprintengine'),
    `team dir under the sprintengine run root: ${context.teamDirectoryPath}`,
  )
  assert.ok(
    context.teamDirectoryPath.includes(context.teamSlug),
    'team directory carries the slug',
  )
  // The state file is the run.yaml inside that team directory.
  assert.ok(context.statePath.startsWith(context.teamDirectoryPath))
  assert.ok(context.statePath.endsWith('run.yaml'))
})

test('the context trims the team name and root before deriving paths, and is deterministic', () => {
  const padded = buildPlanSourcedSprintEngineWorkspaceContext('  /repo  ', '  Team Alpha  ')
  const clean = buildPlanSourcedSprintEngineWorkspaceContext('/repo', 'Team Alpha')

  // Whitespace around the name is stripped before it becomes the display name.
  assert.equal(padded.teamName, 'Team Alpha')
  // Same logical inputs derive the same layout — no hidden state.
  assert.deepEqual(padded, clean)
})

// --- startTrackerIssueSprint (MC-2358) ---------------------------------------
// The point of the change: a sprint started from a tracker issue must not write
// anything into the repository. The issue markdown and the run's issue reference
// both land in the run's own directory under `.multi-code/sprintengine/`, which
// is gitignored, and the run is created in COPY mode so no agent is ever told to
// edit a canonical file that does not exist.

test('a tracker-issue sprint writes its source into the run directory, never backlog/', async () => {
  const writes: Array<{ path: string; content: string }> = []
  const ensured: string[] = []
  let startupPrompt = ''

  const result = await startTrackerIssueSprint({
    rootPath: '/repo',
    baseTeamName: 'eng-423',
    goal: 'ENG-423 — Session token refresh races',
    sourceContent: '# Session token refresh races\n\nbody\n',
    issue: {
      provider: 'linear',
      connectionId: 'conn-1',
      externalId: 'issue-uuid',
      nativeKey: 'ENG-423',
      url: 'https://linear.app/acme/issue/ENG-423',
      capturedAt: '2026-09-03T00:00:00.000Z',
    },
    sourcePlanKind: 'unknown',
    roleCounts: {},
    roleCliDefaults: {},
    roleModelOverrides: null,
    initialSpawnRoles: null,
    sprintEngineAutoState: {},
    workspaceWindowId: null,
    pathExists: () => false,
    ensureDirectory: async (path: string) => {
      ensured.push(path)
    },
    writeFile: async (path, content) => {
      writes.push({ path, content })
    },
    initializeSprintEngineState: async () => ({ ok: true }) as never,
    workspace: {
      addWorkspace: () => 'ws-1' as never,
      setStartupPrompt: ({ startupPrompt: prompt }: { startupPrompt: string }) => {
        startupPrompt = prompt
      },
    } as never,
  } as never)

  assert.equal(result.ok, true)

  // Both writes land inside the run's own gitignored directory. Nothing reaches
  // the repository — this is the whole point of the change.
  assert.equal(writes.length, 2)
  for (const write of writes) {
    assert.match(write.path, /\.multi-code\/sprintengine\/eng-423\//)
    assert.doesNotMatch(write.path, /(^|\/)backlog\//)
  }
  assert.ok(writes.some((w) => w.path.endsWith('handover.md')))
  // The run directory is created first — it does not exist until creation runs,
  // so writing straight into it would fail with ENOENT.
  assert.deepEqual(ensured, ['/repo/.multi-code/sprintengine/eng-423'])

  // The run records which issue it came from, so write-back can resolve it with
  // no proxy backlog item in existence.
  const sidecar = writes.find((w) => w.path.endsWith('tracker-source.json'))
  assert.ok(sidecar, 'the run records which issue it came from')
  assert.equal(JSON.parse(sidecar.content).nativeKey, 'ENG-423')

  // COPY mode, not reference: the architect must never be told to edit a
  // canonical file in place, because for a tracker issue there is not one.
  // Assert the prompt exists first — a doesNotMatch against '' passes vacuously.
  assert.ok(startupPrompt.length > 0, 'the coordinator seat was handed a startup prompt')
  assert.doesNotMatch(startupPrompt, /read and update (it|those files) in place/)
  // And it does point at the run's own snapshot.
  assert.match(startupPrompt, /handover\.md/)
})
