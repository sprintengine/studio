import assert from 'node:assert/strict'
import { join } from 'node:path'

import type {
  DiagnosticLogInput,
  SprintEngineStateInitializeInput,
  TerminalSessionSnapshot,
  TerminalSpawnResult,
} from '../shared/electron-api'
import type { SprintCreateRequest } from '../shared/sprint-create'
import type { SprintEngineAutomationIntentRecord } from '../shared/sprintengine/automation-intent'
import type { SprintEngineAutomationMode } from '../shared/sprintengine/automation-types'
import type { SprintEngineLaunchSettings } from '../shared/sprintengine/launch-settings'
import type { SprintRuntimeRunRegistration } from '../shared/sprintengine/runtime-bridge'
import type { Workspace } from '../renderer/src/types/workspace'
import { emptySprintEngineLaunchSettings } from '../shared/sprintengine/launch-settings'
import { buildSprintEngineRunLink, teamSlugFromStatePath } from '../shared/backlog/sprintengine-links'
import { workspaceRelativePath } from '../shared/source-paths'
import { createSprintCreateService, type SprintCreateServiceDeps } from './sprint-create-service'
import { createSprintRuntime, type SprintRuntimeDeps } from './sprint-runtime'
import { createPluginRegistry } from './plugin-registry'
import {
  __resetPluginRegistryForTest,
  __setPluginRegistryForTest,
} from './plugin-registry-instance'

// SprintCreateService — sprint creation composed in MAIN (MC-2160).
//
// Every check below runs with NO window and NO renderer store anywhere in the
// harness, which is the point of the item: the composition below the request
// boundary — roster resolution, plan-sourced vs goal-sourced routing, the
// selection scan, the anchor/child link writes, intake threading, the runtime
// pins — used to live in a React hook and is asserted here instead. The suite is
// the port of the renderer hook's own test, which covered the same behaviour
// against the renderer half, plus the checks the ownership move adds:
//
// - the run is registered with the scheduler and its intent sidecar written, so
//   the coordinator seat is spawned by the run-start bootstrap;
// - the adopted workspace record carries NO board-mount spawn intent, which is
//   what guarantees exactly one coordinator spawn when a window IS open;
// - a real `SprintRuntime` driven over a created run actually spawns it, proven
//   through the terminal session list.
//
// Expected links are never re-derived literals: each is `buildSprintEngineRunLink`'s
// own output.

// --- a tiny in-memory project the real scanBacklog walks --------------------
//
// One epic with four children spanning the whole status vocabulary the link
// fan-out cares about: `ready` (open — gets a link), `completed` and `idea`
// (closed by CLOSED_EPIC_CHILD_STATUSES — in the bundle, no link), `archived`
// (dropped from the bundle entirely). Plus one loose item for the non-epic and
// multi-selection paths.
const ROOT = '/proj'
const EPIC_REF = 'backlog/epics/demo-epic.md'
const OPEN_CHILD_REF = 'backlog/open-child.md'
const DONE_CHILD_REF = 'backlog/done-child.md'
const IDEA_CHILD_REF = 'backlog/idea-child.md'
const ARCHIVED_CHILD_REF = 'backlog/archived-child.md'
const LOOSE_REF = 'backlog/loose-item.md'
const UNPLANNED_EPIC_REF = 'backlog/epics/unplanned-epic.md'
const UNPLANNED_CHILD_REF = 'backlog/unplanned-child.md'

function itemFile(frontmatter: string[], heading: string): string {
  return ['---', ...frontmatter, '---', '', `# ${heading}`, ''].join('\n')
}

const FILES: Record<string, string> = {
  // Ordering declared finished (MC-2137) — the mark that keeps an epic source
  // on the direct intake. Its unmarked twin below covers the other default.
  [`${ROOT}/${EPIC_REF}`]: itemFile(
    ['type: epic', 'dependenciesPlanned: true', 'id: 900'],
    'Demo epic title',
  ),
  [`${ROOT}/${UNPLANNED_EPIC_REF}`]: itemFile(['type: epic', 'id: 906'], 'Unplanned epic title'),
  [`${ROOT}/${UNPLANNED_CHILD_REF}`]: itemFile(
    ['type: feature', 'status: ready', 'epic: unplanned-epic', 'id: 907'],
    'Unplanned child title',
  ),
  [`${ROOT}/${OPEN_CHILD_REF}`]: itemFile(
    ['type: feature', 'status: ready', 'epic: demo-epic', 'id: 901'],
    'Open child title',
  ),
  [`${ROOT}/${DONE_CHILD_REF}`]: itemFile(
    ['type: feature', 'status: completed', 'epic: demo-epic', 'id: 902'],
    'Done child title',
  ),
  [`${ROOT}/${IDEA_CHILD_REF}`]: itemFile(
    ['type: feature', 'status: idea', 'epic: demo-epic', 'id: 903'],
    'Idea child title',
  ),
  [`${ROOT}/${ARCHIVED_CHILD_REF}`]: itemFile(
    ['type: feature', 'status: archived', 'epic: demo-epic', 'id: 904'],
    'Archived child title',
  ),
  [`${ROOT}/${LOOSE_REF}`]: itemFile(['type: feature', 'status: ready', 'id: 905'], 'Loose item title'),
}
const DIRS: Record<string, Array<{ name: string; isDir: boolean }>> = {
  [`${ROOT}/backlog`]: [
    { name: 'epics', isDir: true },
    { name: 'archived-child.md', isDir: false },
    { name: 'done-child.md', isDir: false },
    { name: 'idea-child.md', isDir: false },
    { name: 'loose-item.md', isDir: false },
    { name: 'open-child.md', isDir: false },
    { name: 'unplanned-child.md', isDir: false },
  ],
  [`${ROOT}/backlog/epics`]: [
    { name: 'demo-epic.md', isDir: false },
    { name: 'unplanned-epic.md', isDir: false },
  ],
}

type LinkCall = {
  workspaceRoot: string
  relativePath: string
  link: unknown
  status?: string
}
type InitCall = SprintEngineStateInitializeInput & Record<string, unknown>

type Harness = ReturnType<typeof harness>

function harness(overrides: Partial<SprintCreateServiceDeps> = {}) {
  const initCalls: InitCall[] = []
  const linkCalls: LinkCall[] = []
  const registrations: SprintRuntimeRunRegistration[] = []
  const hydrated: Array<{ statePath: string; mode: SprintEngineAutomationMode }> = []
  const presets: Array<{ statePath: string; preset: string }> = []
  const workspaces = new Map<string, Workspace>()
  const adoptedInWindow: string[] = []
  // Flipped by the scan-failure check so the backlog walk throws the way an
  // unreadable project directory does.
  const state = { backlogReadFails: false }
  let workspaceSeq = 0

  const deps: SprintCreateServiceDeps = {
    getLaunchSettings: () => emptySprintEngineLaunchSettings(),
    listLaunchableClis: () => ['claude-code', 'codex'],
    initializeSprintEngineState: async (input) => {
      initCalls.push(input as InitCall)
      // The GOAL-only path re-reads the projection the engine just wrote and
      // fails `invalid-projection` without one; the plan-sourced path does not
      // read it at all. Answer it only for that shape, so every plan-sourced
      // check keeps exercising the bare `{ok:true}` it always did.
      if ((input as { source?: unknown }).source === undefined) {
        return {
          ok: true,
          data: {
            projectionContent: JSON.stringify({
              name: input.name,
              goal: input.goal,
              agents: [],
              tasks: [],
              events: [],
              artifacts: [],
            }),
          },
        }
      }
      return { ok: true, data: {} }
    },
    fs: {
      pathExists: async (path) => path in FILES || path in DIRS,
      readdir: async (path) => {
        if (state.backlogReadFails) throw new Error('backlog directory is unreadable')
        return DIRS[path] ?? []
      },
      readfile: async (path) => {
        const content = FILES[path]
        if (content === undefined) throw new Error(`no such file: ${path}`)
        return content
      },
      readFile: async (path) => {
        const content = FILES[path]
        if (content === undefined) throw new Error(`no such file: ${path}`)
        return content
      },
      statPath: async (path) => ({
        isFile: path in FILES,
        isDirectory: path in DIRS,
        sizeBytes: (FILES[path] ?? '').length,
        modifiedAt: '2026-08-05T00:00:00.000Z',
        modifiedAtMs: 1786060800000,
      }),
    },
    newWorkspaceId: () => `ws-${++workspaceSeq}`,
    adoptWorkspace: (workspace, windowId) => {
      workspaces.set(workspace.id, workspace)
      adoptedInWindow.push(windowId)
      return { ok: true }
    },
    primaryWorkspaceWindowId: () => 'primary',
    updateWorkspaceAgent: (workspaceId, agentId, patch) => {
      const workspace = workspaces.get(workspaceId)
      if (!workspace) return
      workspace.agents = {
        ...workspace.agents,
        [agentId]: { ...workspace.agents[agentId], ...patch },
      }
    },
    hydrateAutomationMode: async ({ statePath, mode }) => {
      hydrated.push({ statePath, mode })
      return { ok: true }
    },
    setCliPermissionPreset: async ({ statePath, preset }) => {
      presets.push({ statePath, preset })
      return { ok: true }
    },
    registerSprintRun: (registration) => registrations.push(registration),
    addBacklogLink: async (input) => {
      linkCalls.push(input as LinkCall)
      return { ok: true }
    },
    ...overrides,
  }

  return {
    service: createSprintCreateService(deps),
    deps,
    initCalls,
    linkCalls,
    registrations,
    hydrated,
    presets,
    workspaces,
    adoptedInWindow,
    state,
    reset(): void {
      initCalls.length = 0
      linkCalls.length = 0
      registrations.length = 0
      hydrated.length = 0
      presets.length = 0
      adoptedInWindow.length = 0
      state.backlogReadFails = false
    },
  }
}

function startedRun(h: Harness): { teamSlug: string; runRelativePath: string } {
  assert.equal(h.initCalls.length, 1, 'exactly one run was initialized')
  const statePath = h.initCalls[0].statePath
  const runRelativePath = workspaceRelativePath(ROOT, statePath)
  const teamSlug = teamSlugFromStatePath(statePath)
  assert.ok(runRelativePath, 'the run state path resolves project-relative')
  assert.ok(teamSlug, 'the run state path names a team slug')
  return { teamSlug: teamSlug!, runRelativePath: runRelativePath! }
}

function workspaceById(h: Harness, workspaceId: string | undefined): Workspace {
  assert.ok(workspaceId, 'the result carries the created workspace id')
  const workspace = h.workspaces.get(workspaceId!)
  assert.ok(workspace, `workspace ${workspaceId} was adopted into the registry`)
  return workspace!
}

// The coordinator handoff prompt is the observable half of "does this run
// plan?": a direct run gets none, because there is no planning pass to start.
function hasHandoffPrompt(h: Harness, workspaceId: string | undefined): boolean {
  return Object.values(workspaceById(h, workspaceId).agents ?? {}).some((agent) =>
    Boolean(agent.cliStartupPrompt))
}

function bundleRefs(h: Harness): string[] {
  return ((h.initCalls[0].sourceBundle ?? []) as Array<{ path: string }>).map((entry) => entry.path)
}

const request = (overrides: Partial<SprintCreateRequest>): SprintCreateRequest => ({
  folderPath: ROOT,
  goal: '',
  ...overrides,
})

async function main(): Promise<void> {
  let failures = 0
  const check = async (name: string, fn: () => Promise<void>): Promise<void> => {
    try {
      await fn()
      console.log(`ok - ${name}`)
    } catch (error) {
      failures += 1
      console.error(`not ok - ${name}`)
      console.error(error)
    }
  }

  await check('a single-epic launch links the anchor and every OPEN child only', async () => {
    const h = harness()
    const result = await h.service.createSprint(request({ sourceRelativePath: EPIC_REF }))
    assert.equal(result.ok, true, !result.ok ? result.message : '')

    const { teamSlug, runRelativePath } = startedRun(h)
    assert.equal(h.initCalls[0].source && (h.initCalls[0].source as { planKind: string }).planKind, 'epic')
    // The archived child never reaches the bundle; the closed-but-not-archived
    // ones do — they are the run's context, they just get no link.
    assert.deepEqual(
      bundleRefs(h).sort(),
      [DONE_CHILD_REF, IDEA_CHILD_REF, OPEN_CHILD_REF].sort(),
      'the bundle carries every non-archived child',
    )

    assert.equal(h.linkCalls.length, 2, 'one anchor link plus one open-child link — nothing else')
    assert.equal(h.linkCalls[0].relativePath, EPIC_REF)
    assert.deepEqual(h.linkCalls[0].link, buildSprintEngineRunLink({ teamSlug, runRelativePath }))
    assert.equal(
      'status' in h.linkCalls[0],
      false,
      'an epic derives its status from its children and is never given one',
    )
    assert.equal(h.linkCalls[1].relativePath, OPEN_CHILD_REF)
    assert.deepEqual(
      h.linkCalls[1].link,
      buildSprintEngineRunLink({ teamSlug, runRelativePath, status: 'pending', priorStatus: 'ready' }),
    )
    assert.equal('status' in h.linkCalls[1], false, 'a pending child link never moves the child itself')
    assert.equal(
      h.linkCalls.some((call) => call.relativePath === DONE_CHILD_REF || call.relativePath === IDEA_CHILD_REF),
      false,
      'closed children get no link — the engine skips them at import, so it would sit pending forever',
    )
  })

  await check('a singleton ref list collapses to the single-source path', async () => {
    const h = harness()
    const result = await h.service.createSprint(request({ sourceRelativePaths: [EPIC_REF] }))
    assert.equal(result.ok, true, !result.ok ? result.message : '')

    const { teamSlug, runRelativePath } = startedRun(h)
    assert.equal(
      h.initCalls[0].source && (h.initCalls[0].source as { planKind: string }).planKind,
      'epic',
      'a one-entry list is the singular contract, not a selection',
    )
    assert.deepEqual(h.linkCalls.map((call) => call.relativePath), [EPIC_REF, OPEN_CHILD_REF])
    assert.deepEqual(h.linkCalls[0].link, buildSprintEngineRunLink({ teamSlug, runRelativePath }))
    assert.deepEqual(
      h.linkCalls[1].link,
      buildSprintEngineRunLink({ teamSlug, runRelativePath, status: 'pending', priorStatus: 'ready' }),
    )
  })

  await check('a singleton ref list of a plain item launches, as the singular path', async () => {
    // The discriminator between the two routes: the selection builder returns
    // null for a lone plain item (it is deliberately today's single-item flow,
    // byte-identical), so a one-entry list that took the selection path would
    // fail `sprint_invalid_source` instead of launching.
    const h = harness()
    const result = await h.service.createSprint(request({ sourceRelativePaths: [LOOSE_REF] }))
    assert.equal(result.ok, true, !result.ok ? result.message : '')
    const { teamSlug, runRelativePath } = startedRun(h)
    assert.deepEqual(h.linkCalls.map((call) => call.relativePath), [LOOSE_REF])
    assert.deepEqual(h.linkCalls[0].link, buildSprintEngineRunLink({ teamSlug, runRelativePath }))
    assert.equal(h.linkCalls[0].status, 'in_progress')
  })

  await check('a multi-ref selection writes the same anchor and child shapes', async () => {
    const h = harness()
    const result = await h.service.createSprint(request({ sourceRelativePaths: [EPIC_REF, LOOSE_REF] }))
    assert.equal(result.ok, true, !result.ok ? result.message : '')

    const { teamSlug, runRelativePath } = startedRun(h)
    assert.equal(
      h.initCalls[0].source && (h.initCalls[0].source as { planKind: string }).planKind,
      'selection',
      'two refs are a selection',
    )
    assert.deepEqual(
      bundleRefs(h).sort(),
      [DONE_CHILD_REF, EPIC_REF, IDEA_CHILD_REF, LOOSE_REF, OPEN_CHILD_REF].sort(),
      'the selection bundle carries the epic, its non-archived children, and the loose item',
    )
    // Identical fan-out to the single-epic path: the anchor epic's link, plus
    // one pending link per open epic child. The directly-selected loose item is
    // not an epic child, so it carries no child link (MC-2077 parity).
    assert.deepEqual(h.linkCalls.map((call) => call.relativePath), [EPIC_REF, OPEN_CHILD_REF])
    assert.deepEqual(h.linkCalls[0].link, buildSprintEngineRunLink({ teamSlug, runRelativePath }))
    assert.equal('status' in h.linkCalls[0], false, 'the anchor epic still gets no item status')
    assert.deepEqual(
      h.linkCalls[1].link,
      buildSprintEngineRunLink({ teamSlug, runRelativePath, status: 'pending', priorStatus: 'ready' }),
    )
  })

  await check('a non-epic anchor is moved to in_progress by its own link', async () => {
    const h = harness()
    const result = await h.service.createSprint(request({ sourceRelativePath: LOOSE_REF }))
    assert.equal(result.ok, true, !result.ok ? result.message : '')

    const { teamSlug, runRelativePath } = startedRun(h)
    assert.equal(h.linkCalls.length, 1, 'a loose item has no children to fan out to')
    assert.equal(h.linkCalls[0].relativePath, LOOSE_REF)
    assert.deepEqual(h.linkCalls[0].link, buildSprintEngineRunLink({ teamSlug, runRelativePath }))
    assert.equal(h.linkCalls[0].status, 'in_progress')
  })

  await check('an epic source with no intake runs direct: no intake sent, no planning prompt', async () => {
    const h = harness()
    const result = await h.service.createSprint(request({ sourceRelativePath: EPIC_REF }))
    assert.equal(result.ok, true, !result.ok ? result.message : '')
    assert.equal(
      'intake' in h.initCalls[0],
      false,
      'absent leaves the per-source default with the engine rather than restating it',
    )
    assert.equal(
      hasHandoffPrompt(h, result.ok ? result.workspaceId : undefined),
      false,
      'a direct run has no planning pass to start, so the coordinator gets no handoff prompt',
    )
  })

  await check('an epic that never declared its ordering done plans, prompt and all (MC-2137)', async () => {
    // Horizon and automations omit `intake`, so this path resolves the engine's
    // default itself. Get it wrong and a planned run opens its plan gate with
    // nobody prompted to fill it.
    const h = harness()
    const result = await h.service.createSprint(request({ sourceRelativePath: UNPLANNED_EPIC_REF }))
    assert.equal(result.ok, true, !result.ok ? result.message : '')
    assert.equal(
      'intake' in h.initCalls[0],
      false,
      'the resolution stays the engine\'s: the caller still sends nothing',
    )
    assert.equal(
      hasHandoffPrompt(h, result.ok ? result.workspaceId : undefined),
      true,
      'an unmarked epic plans first, so somebody must be prompted to plan it',
    )
  })

  await check('an explicit planned intake on an epic source restores the planning prompt', async () => {
    const h = harness()
    const result = await h.service.createSprint(request({ sourceRelativePath: EPIC_REF, intake: 'planned' }))
    assert.equal(result.ok, true, !result.ok ? result.message : '')
    assert.equal(h.initCalls[0].intake, 'planned')
    assert.equal(
      hasHandoffPrompt(h, result.ok ? result.workspaceId : undefined),
      true,
      'a planned run must have somebody prompted to plan it',
    )
  })

  await check('a requested direct on a non-epic source is forwarded but still gets the prompt', async () => {
    const h = harness()
    const result = await h.service.createSprint(request({ sourceRelativePath: LOOSE_REF, intake: 'direct' }))
    assert.equal(result.ok, true, !result.ok ? result.message : '')
    assert.equal(
      h.initCalls[0].intake,
      'direct',
      'the request is forwarded verbatim — the engine warns, it does not block',
    )
    assert.equal(
      hasHandoffPrompt(h, result.ok ? result.workspaceId : undefined),
      true,
      'the engine downgrades an unsupported direct to planned, so creation must mirror it or the plan gate sits with nobody prompted',
    )
  })

  await check('an absent roster staffs no roles, and a named-but-missing one fails loudly', async () => {
    // MC-1876's default flip: absent no longer resolves through the wizard's
    // `lastSelectedRosterId`, so an externally-created run is deterministic and
    // independent of whoever last opened the dialog.
    const h = harness()
    const defaulted = await h.service.createSprint(request({ sourceRelativePath: LOOSE_REF }))
    assert.equal(defaulted.ok, true, !defaulted.ok ? defaulted.message : '')
    assert.deepEqual(h.initCalls[0].enabledRoles, [], 'absent means No roles, not the specialist defaults')

    h.reset()
    const named = await h.service.createSprint(
      request({ sourceRelativePath: LOOSE_REF, rosterName: 'no-such-saved-roster' }),
    )
    assert.equal(named.ok, false, 'silently falling back would staff a roster the caller never picked')
    assert.equal(!named.ok && named.code, 'sprint_unknown_roster')
    assert.equal(h.initCalls.length, 0, 'nothing was initialized')
    assert.equal(h.linkCalls.length, 0, 'nothing was linked')
  })

  // MC-2120 — the run's execution runtime. `roleRuntimes` is what init writes
  // into run.yaml and what every spawn and claim-time model stamp reads, so it
  // is the only honest assertion that a requested model actually reached the
  // run: a pinned run that records `{cli, model: null}` is the exact bug the
  // item reported.
  await check('a roleless run pins its pool seat through `runtime`', async () => {
    const h = harness()
    const result = await h.service.createSprint(request({
      sourceRelativePath: LOOSE_REF,
      runtime: { cli: 'claude-code', model: 'claude-opus-5', effort: 'high' },
      maxConcurrentAgents: 6,
    }))
    assert.equal(result.ok, true, !result.ok ? result.message : '')
    const roleRuntimes = h.initCalls[0].roleRuntimes as Record<string, Record<string, unknown>>
    assert.deepEqual(
      roleRuntimes['(roleless)'],
      { model: 'claude-opus-5', cli: 'claude-code', reasoning: 'high' },
      'the roleless seat is the ONLY seat a no-roles run has, and role-keyed maps cannot reach it',
    )
    assert.deepEqual(h.initCalls[0].enabledRoles, [], 'pinning a runtime never staffs a role')
    assert.equal(
      workspaceById(h, result.ok ? result.workspaceId : undefined).sprintEngineAutoState?.maxConcurrentAgents,
      6,
      'the caller\'s ceiling reaches the run, instead of silently inheriting the default',
    )
  })

  await check('a staffed roster takes per-role models and efforts, with `runtime` as the fallback', async () => {
    const h = harness()
    const result = await h.service.createSprint(request({
      sourceRelativePath: LOOSE_REF,
      roster: { architect: 1, developer: 1 },
      runtime: { model: 'claude-sonnet-5', effort: 'medium' },
      roleClis: { architect: 'codex' },
      roleModels: { architect: 'claude-opus-5' },
      roleEfforts: { architect: 'high' },
    }))
    assert.equal(result.ok, true, !result.ok ? result.message : '')
    const roleRuntimes = h.initCalls[0].roleRuntimes as Record<string, Record<string, unknown>>
    assert.deepEqual(roleRuntimes.architect, { model: 'claude-opus-5', cli: 'codex', reasoning: 'high' })
    assert.deepEqual(
      roleRuntimes.developer,
      { model: 'claude-sonnet-5', cli: 'claude-code', reasoning: 'medium' },
      'a role the maps do not name falls back to the run-level runtime',
    )
    assert.deepEqual(
      (h.initCalls[0].enabledRoles as string[]).sort(),
      ['architect', 'developer'],
      'the runtime rides the roster the caller staffed, and does not change it',
    )
  })

  await check('an unlaunchable CLI fails the start loudly', async () => {
    // MC-2145's trap: silently falling back would launch a horizon's every step
    // on an agent the author never picked, and never say so.
    const h = harness()
    const result = await h.service.createSprint(request({
      sourceRelativePath: LOOSE_REF,
      runtime: { cli: 'not-installed-cli' },
    }))
    assert.equal(result.ok, false)
    assert.equal(!result.ok && result.code, 'sprint_unknown_runtime')
    assert.equal(h.initCalls.length, 0, 'nothing was initialized')
  })

  await check('a saved roster pinned to an unlaunchable CLI fails the start loudly too', async () => {
    // The roster path seeds roleCliDefaults the request never typed, so it used
    // to bypass the requested-CLI check entirely and hard-fail at spawn. A
    // roster pinned to a CLI that is gone — or that cannot report agent status
    // under the hooks-only rule — must fail at create, with the roster named.
    const h = harness({
      getLaunchSettings: () => ({
        ...emptySprintEngineLaunchSettings(),
        sprintEngineRoleSettings: {
          enabled: {},
          savedRosters: [
            {
              id: 'roster-muse',
              name: 'muse-team',
              roleCounts: { architect: 1 },
              roleCliDefaults: { architect: 'muse' },
              createdAt: 1,
              updatedAt: 1,
            },
          ],
        },
      }),
    })
    const result = await h.service.createSprint(request({
      sourceRelativePath: LOOSE_REF,
      rosterName: 'muse-team',
    }))
    assert.equal(result.ok, false)
    assert.equal(!result.ok && result.code, 'sprint_unknown_runtime')
    assert.match(!result.ok ? result.message : '', /"muse"/)
    assert.match(!result.ok ? result.message : '', /roster/i, 'the failure must name the roster as the source')
    assert.equal(h.initCalls.length, 0, 'nothing was initialized')
  })

  // The item's headline acceptance, in one call: several sources into ONE run,
  // with every staffed role pinned. The two halves are independent code paths
  // (the selection scan, the runtime resolution) and this is the only check
  // that proves they compose.
  await check('one call starts a multi-source run with every staffed role pinned', async () => {
    const h = harness()
    const result = await h.service.createSprint(request({
      sourceRelativePaths: [EPIC_REF, UNPLANNED_EPIC_REF, LOOSE_REF],
      roster: { architect: 1, developer: 1 },
      roleModels: { architect: 'claude-opus-5', developer: 'claude-opus-5' },
      roleEfforts: { architect: 'high', developer: 'high' },
    }))
    assert.equal(result.ok, true, !result.ok ? result.message : '')
    assert.equal((h.initCalls[0].source as { planKind: string }).planKind, 'selection')
    assert.equal(
      bundleRefs(h).includes(LOOSE_REF) && bundleRefs(h).includes(OPEN_CHILD_REF),
      true,
      'the selection bundle carries the picked items and the epics\' children',
    )
    const roleRuntimes = h.initCalls[0].roleRuntimes as Record<string, Record<string, unknown>>
    for (const role of ['architect', 'developer']) {
      assert.deepEqual(
        roleRuntimes[role],
        { model: 'claude-opus-5', cli: 'claude-code', reasoning: 'high' },
        `${role} runs on the model and effort the one call asked for`,
      )
    }
  })

  await check('a role the run does not staff fails loudly instead of doing nothing', async () => {
    const h = harness()
    const unstaffed = await h.service.createSprint(request({
      sourceRelativePath: LOOSE_REF,
      roster: { architect: 1 },
      roleModels: { developr: 'claude-opus-5' },
    }))
    assert.equal(unstaffed.ok, false, 'a typo\'d role must not silently launch on models nobody chose')
    assert.equal(!unstaffed.ok && unstaffed.code, 'sprint_unknown_role')
    assert.match(
      (!unstaffed.ok && unstaffed.message) || '',
      /architect/,
      'the failure names what the run does staff',
    )
    assert.equal(h.initCalls.length, 0, 'nothing was initialized')

    // A roleless run has no role ids at all, so ANY role-keyed entry is wrong —
    // and the message must say where the pin actually belongs.
    const roleless = await h.service.createSprint(request({
      sourceRelativePath: LOOSE_REF,
      roleEfforts: { architect: 'high' },
    }))
    assert.equal(roleless.ok, false)
    assert.equal(!roleless.ok && roleless.code, 'sprint_unknown_role')
    assert.match((!roleless.ok && roleless.message) || '', /"runtime"/)
    assert.equal(h.initCalls.length, 0, 'nothing was initialized')
  })

  await check('an unset runtime leaves the run exactly as it was before MC-2120', async () => {
    const h = harness()
    const result = await h.service.createSprint(request({ sourceRelativePath: LOOSE_REF }))
    assert.equal(result.ok, true, !result.ok ? result.message : '')
    const roleRuntimes = h.initCalls[0].roleRuntimes as Record<string, Record<string, unknown>>
    assert.equal(roleRuntimes['(roleless)']?.model ?? null, null, 'no model flag unless one was asked for')
    assert.equal('reasoning' in (roleRuntimes['(roleless)'] ?? {}), false, 'no effort flag either')
    assert.equal(
      workspaceById(h, result.ok ? result.workspaceId : undefined).sprintEngineAutoState?.maxConcurrentAgents,
      3,
    )
  })

  // The goal-only run is the OTHER creation path (no source, no backlog link),
  // and it wires the runtime through a different composer — so the pins have to
  // be proven there too, not inferred from the plan-sourced path.
  await check('a goal-only run carries the same runtime', async () => {
    const h = harness()
    const result = await h.service.createSprint(request({
      goal: 'Ship checkout',
      runtime: { cli: 'claude-code', model: 'claude-opus-5', effort: 'high' },
      maxConcurrentAgents: 5,
    }))
    assert.equal(result.ok, true, !result.ok ? result.message : '')
    assert.equal(h.initCalls.length, 1, 'a goal-only request creates through the new-team path')
    assert.equal(h.initCalls[0].source, undefined, 'and records no source')
    const roleRuntimes = h.initCalls[0].roleRuntimes as Record<string, Record<string, unknown>>
    assert.deepEqual(roleRuntimes['(roleless)'], { model: 'claude-opus-5', cli: 'claude-code', reasoning: 'high' })
    assert.equal(
      workspaceById(h, result.ok ? result.workspaceId : undefined).sprintEngineAutoState?.maxConcurrentAgents,
      5,
    )
    assert.equal(h.linkCalls.length, 0, 'a goal-only run has no source to link')
  })

  await check('a goal-only run never self-escalates its CLI permissions', async () => {
    // MC-1900: an arbitrary caller with a bare goal and no human-authored source
    // has no consent to read, so `permissionPreset` is not honoured here.
    const h = harness()
    const result = await h.service.createSprint(request({
      goal: 'Ship checkout',
      permissionPreset: 'bypass_all',
    }))
    assert.equal(result.ok, true, !result.ok ? result.message : '')
    assert.equal(
      workspaceById(h, result.ok ? result.workspaceId : undefined).sprintEngineAutoState?.cliPermissionPreset,
      'default',
    )
    assert.deepEqual(h.presets, [{ statePath: h.initCalls[0].statePath, preset: 'default' }])
  })

  await check('a plan-sourced run spawns in bypass unless its caller says otherwise', async () => {
    // The other half of MC-1900: a horizon step or automation is unwatched by
    // construction, and its escalation comes from the owner's own file.
    const h = harness()
    const unstated = await h.service.createSprint(request({ sourceRelativePath: LOOSE_REF }))
    assert.equal(unstated.ok, true, !unstated.ok ? unstated.message : '')
    assert.equal(
      workspaceById(h, unstated.ok ? unstated.workspaceId : undefined).sprintEngineAutoState?.cliPermissionPreset,
      'bypass_all',
    )

    h.reset()
    const stated = await h.service.createSprint(request({
      sourceRelativePath: LOOSE_REF,
      permissionPreset: 'default',
    }))
    assert.equal(stated.ok, true, !stated.ok ? stated.message : '')
    assert.equal(
      workspaceById(h, stated.ok ? stated.workspaceId : undefined).sprintEngineAutoState?.cliPermissionPreset,
      'default',
    )
  })

  await check('an out-of-range agent ceiling is clamped, not written raw', async () => {
    // The MCP tool boundary refuses these, but a horizon step or automation
    // reaches this same request type without passing through it, and the
    // plan-sourced path writes the auto-state straight through.
    for (const [asked, expected] of [[99, 10], [0, 3], [2.7, 2]] as const) {
      const h = harness()
      const result = await h.service.createSprint(request({
        sourceRelativePath: LOOSE_REF,
        maxConcurrentAgents: asked,
      }))
      assert.equal(result.ok, true, !result.ok ? result.message : '')
      assert.equal(
        workspaceById(h, result.ok ? result.workspaceId : undefined).sprintEngineAutoState?.maxConcurrentAgents,
        expected,
        `${asked} clamps to ${expected}`,
      )
    }
  })

  await check('a traversing or absolute ref fails as an invalid source', async () => {
    const h = harness()
    for (const ref of ['backlog/../../etc/passwd.md', '/etc/passwd.md', 'C:/Windows/system.md']) {
      const result = await h.service.createSprint(request({ sourceRelativePath: ref }))
      assert.equal(result.ok, false, `${ref} must not launch`)
      assert.equal(!result.ok && result.code, 'sprint_invalid_source', ref)
    }
    // The same guard covers every entry of a multi-ref list, not just the anchor.
    const result = await h.service.createSprint(request({
      sourceRelativePaths: [LOOSE_REF, 'backlog/../secrets.md'],
    }))
    assert.equal(!result.ok && result.code, 'sprint_invalid_source')
    assert.equal(h.initCalls.length, 0, 'nothing was initialized')
    assert.equal(h.linkCalls.length, 0, 'nothing was linked')
  })

  await check('an unknown source fails as a missing source, from either entry point', async () => {
    const h = harness()
    const single = await h.service.createSprint(request({ sourceRelativePath: 'backlog/not-a-real-item.md' }))
    assert.equal(single.ok, false)
    assert.equal(!single.ok && single.code, 'sprint_source_missing')

    const selection = await h.service.createSprint(request({
      sourceRelativePaths: [LOOSE_REF, 'backlog/not-a-real-item.md'],
    }))
    assert.equal(selection.ok, false, 'a selection never silently drops a ref the caller asked for')
    assert.equal(!selection.ok && selection.code, 'sprint_source_missing')
    assert.equal(h.initCalls.length, 0, 'nothing was initialized')
  })

  await check('an unreadable backlog fails the selection as unavailable', async () => {
    const h = harness()
    h.state.backlogReadFails = true
    const result = await h.service.createSprint(request({ sourceRelativePaths: [EPIC_REF, LOOSE_REF] }))
    assert.equal(result.ok, false)
    assert.equal(!result.ok && result.code, 'sprint_backlog_unavailable')
    assert.equal(h.initCalls.length, 0, 'a scan that cannot resolve the selection never launches a run')
  })

  // -------------------------------------------------------------------------
  // The ownership move itself (MC-2160)
  // -------------------------------------------------------------------------

  await check('a started run is registered with the scheduler and its intent persisted', async () => {
    // This is what replaces "activate the workspace, wait for the FlexLayout
    // model, let the board mount spawn the architect". The sidecar is written
    // BEFORE registration so `registerRun`'s own read adopts the real mode
    // rather than depending on the hydration notification's ordering.
    for (const shape of [
      { label: 'goal-sourced', overrides: { goal: 'Ship checkout' } },
      { label: 'epic', overrides: { sourceRelativePath: EPIC_REF } },
      { label: 'selection', overrides: { sourceRelativePaths: [EPIC_REF, LOOSE_REF] } },
    ]) {
      const h = harness()
      const result = await h.service.createSprint(request({ ...shape.overrides, startRunner: true }))
      assert.equal(result.ok, true, !result.ok ? result.message : `${shape.label} failed`)
      const statePath = h.initCalls[0].statePath
      assert.deepEqual(
        h.hydrated,
        [{ statePath, mode: 'run_agents' }],
        `${shape.label}: the run's mode intent is persisted, which is what lifts it out of manual`,
      )
      assert.equal(h.registrations.length, 1, `${shape.label}: the run is handed to the scheduler exactly once`)
      const registration = h.registrations[0]
      assert.equal(registration.statePath, statePath)
      assert.equal(registration.workspaceId, result.ok ? result.workspaceId : '')
      assert.equal(registration.folderPath, ROOT)
      assert.equal(
        registration.runtimeState,
        'idle',
        `${shape.label}: a brand-new run carries no lifecycle — sidecar adoption lifts it to running`,
      )
      assert.ok(
        Object.keys(registration.agents).length > 0,
        `${shape.label}: the scheduler starts from the roster the record already carries`,
      )
    }
  })

  await check('autoApproveArtifacts rides the persisted mode, and a manual run is registered idle', async () => {
    const approving = harness()
    const approved = await approving.service.createSprint(request({
      goal: 'Ship checkout',
      startRunner: true,
      autoApproveArtifacts: true,
    }))
    assert.equal(approved.ok, true, !approved.ok ? approved.message : '')
    assert.equal(approving.hydrated[0].mode, 'run_agents_and_approve_artifacts')

    const manual = harness()
    const idle = await manual.service.createSprint(request({ goal: 'Ship checkout' }))
    assert.equal(idle.ok, true, !idle.ok ? idle.message : '')
    assert.equal(manual.hydrated[0].mode, 'manual', 'a manual run sits idle until a person opens it')
    assert.equal(
      manual.registrations.length,
      1,
      'it is still registered — the scheduler holds it, and a later mode change needs no window',
    )
  })

  await check('no run carries a board-mount spawn intent', async () => {
    // The no-double-spawn guarantee. The scheduler bootstraps the coordinator;
    // leaving `sprintEngineInitialSpawnAgentIds` on the adopted record would let
    // an OPEN board consume it and spawn a second one.
    for (const overrides of [
      { goal: 'Ship checkout', startRunner: true },
      { sourceRelativePath: EPIC_REF, startRunner: true },
      { sourceRelativePath: UNPLANNED_EPIC_REF, startRunner: true },
    ]) {
      const h = harness()
      const result = await h.service.createSprint(request(overrides))
      assert.equal(result.ok, true, !result.ok ? result.message : '')
      const workspace = workspaceById(h, result.ok ? result.workspaceId : undefined)
      assert.equal(
        workspace.sprintEngineInitialSpawnAgentIds,
        undefined,
        'the board has nothing to consume, so exactly one coordinator spawn happens either way',
      )
      assert.equal(workspace.mode, 'sprintengine')
      assert.equal(workspace.folderPath, ROOT)
    }
  })

  await check('the scheduler actually spawns the coordinator for a created run', async () => {
    // End-to-end over the REAL scheduler: create headlessly, register, tick, and
    // read the coordinator off the terminal session list. Nothing in this check
    // touches a window.
    const registry = createPluginRegistry({
      bundledRoot: join(process.cwd(), 'resources', 'plugins'),
      userRoot: join(process.cwd(), '.does-not-exist', 'multicode', 'plugins'),
    })
    __setPluginRegistryForTest(registry, registry.loadSync())
    try {
      const spawned: TerminalSessionSnapshot[] = []
      const projections = new Map<string, unknown>()
      const modes = new Map<string, SprintEngineAutomationIntentRecord | null>()
      const clock = { now: 0 }
      const diagnostics: DiagnosticLogInput[] = []
      const launchSettings: SprintEngineLaunchSettings = {
        ...emptySprintEngineLaunchSettings(),
        cliRuntimes: { 'claude-code': { command: 'claude', useWsl: false } },
      }

      const runtimeDeps: SprintRuntimeDeps = {
        terminal: {
          list: () => [...spawned],
          write: () => undefined,
          kill: () => undefined,
          status: async (sessionId) => ({
            processAlive: spawned.some((session) => session.sessionId === sessionId),
          }),
          spawn: async (args) => {
            const metadata = (args.metadata ?? {}) as Record<string, unknown>
            spawned.push({
              sessionId: args.sessionId,
              processAlive: true,
              kind: 'agent',
              workspaceId: metadata.workspaceId as string,
              agentId: metadata.agentId as string,
              sprintEngineStatePath: args.sprintEngineStatePath,
              cli: args.cli,
            } as unknown as TerminalSessionSnapshot)
            return { ok: true, sessionId: args.sessionId } as TerminalSpawnResult
          },
        },
        artifacts: {
          ensureTaskWorktree: async () => ({ ok: true, isolated: false, worktreePath: null }),
          readProjection: async ({ statePath }) => ({
            ok: true,
            data: projections.get(statePath) ?? null,
            token: `token-${clock.now}`,
          }),
          autoApproveArtifact: async () => ({ ok: true as const, data: {} }),
        },
        pathExists: async () => true,
        resolveMemoryRoot: async (_workspaceRoot, relativeRoot) => ({
          ok: false,
          status: 'inaccessible',
          relativeRoot,
          message: 'not used by the fixture',
        }),
        getPluginCatalogEntries: () => [],
        getLaunchSettings: () => launchSettings,
        readAutomationMode: async (statePath) => modes.get(statePath) ?? null,
        persistRuntimeResidue: () => undefined,
        powerManager: {
          markRunActive: () => undefined,
          markRunInactive: () => undefined,
          shutdown: () => undefined,
        },
        broadcastOp: () => undefined,
        logDiagnostic: (input) => {
          diagnostics.push(input)
        },
        now: () => clock.now,
        // Inert timers: every tick is driven explicitly below.
        timers: { setInterval: () => ({}), clearInterval: () => undefined },
      }
      const runtime = createSprintRuntime(runtimeDeps)

      const h = harness({
        registerSprintRun: (registration) => runtime.registerRun(registration),
        hydrateAutomationMode: async ({ statePath, mode }) => {
          const record: SprintEngineAutomationIntentRecord = {
            schemaVersion: 1,
            revision: 1,
            desiredMode: mode,
            changedAt: 0,
            lastWrite: { actor: 'system', deviceId: null, at: new Date(0).toISOString() },
          }
          modes.set(statePath, record)
          return { ok: true, record }
        },
      })

      const result = await h.service.createSprint(request({
        goal: 'Ship checkout',
        startRunner: true,
        roster: { architect: 1 },
      }))
      assert.equal(result.ok, true, !result.ok ? result.message : '')
      const statePath = h.initCalls[0].statePath
      // What the engine reports back for the run the service just created: an
      // architect seat, no tasks — the shape the bootstrap answers.
      projections.set(statePath, {
        run: {
          name: 'Ship checkout',
          goal: 'Ship checkout',
          rosterConfigured: true,
          roleRuntimes: { architect: { cli: 'claude-code' } },
        },
        roster: { 'architect-1': { role: 'architect', status: 'idle', currentTaskId: null } },
        tasks: [],
        artifacts: [],
        activity: [],
      })

      // The scheduler's first 10s reconcile-only window, then a spawning tick.
      await settle()
      clock.now += 20_000
      await runtime.tickNow()
      await settle()
      await runtime.tickNow()
      await settle()

      const coordinator = spawned.find((session) => session.kind === 'agent')
      assert.ok(
        coordinator,
        `the run-start bootstrap spawned no agent; diagnostics: ${JSON.stringify(diagnostics.map((entry) => entry.title))}`,
      )
      assert.equal(
        coordinator!.workspaceId,
        result.ok ? result.workspaceId : '',
        'the spawned session belongs to the workspace creation just adopted',
      )
      assert.equal(
        spawned.length,
        1,
        'exactly one coordinator spawn — the board-mount handshake is not a second path',
      )
      runtime.shutdown()
    } finally {
      __resetPluginRegistryForTest()
    }
  })

  if (failures > 0) {
    console.error(`\n${failures} sprint-create-service checks failed`)
    process.exit(1)
  }
  console.log('sprint-create-service.test.ts: ok')
}

async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0))
  await new Promise((resolve) => setTimeout(resolve, 0))
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
