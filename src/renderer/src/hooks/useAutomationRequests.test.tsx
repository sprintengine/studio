import assert from 'node:assert/strict'

import { JSDOM } from 'jsdom'

// useAutomationRequests — the RENDERER half of MCP `sprint.create` (MC-2139).
//
// The main-process half is covered by automation.test.ts (delegation,
// confirmation, sourceRefs validation, the refusal matrix). Everything below
// the delegation boundary — roster resolution, plan-sourced vs goal-sourced
// routing, the selection scan, the anchor/child link writes, intake threading —
// lived here with no test at all, and every defect the 2026-08-05 integration
// review found was in exactly that half. This suite pins the four behaviors:
//
// 1. A single-epic launch writes the anchor link (no item status for an epic)
//    plus one pending link per OPEN child; closed children get none.
// 2. A multi-ref selection writes the same shapes, and a singleton ref list
//    collapses to the single-source path byte-identically.
// 3. `intake` threading: an epic source with no intake runs direct (no
//    coordinator handoff prompt); a requested `direct` on a non-epic source is
//    forwarded verbatim but STILL gets the prompt, mirroring the engine's
//    warn-not-block downgrade.
// 4. Ref validation and scan failures fail loudly with their own codes.
//
// The requests are driven through the real registered handler (the hook's own
// `window.api.onAutomationRequest` callback), and asserted against the store and
// the IPC stubs — never against re-derived link literals: every expected link is
// `buildSprintEngineRunLink`'s own output.

const dom = new JSDOM('<!doctype html><html><body></body></html>', {
  url: 'http://localhost',
  pretendToBeVisual: true,
})

const anyGlobal = globalThis as unknown as Record<string, unknown>
anyGlobal.window = dom.window
anyGlobal.document = dom.window.document
anyGlobal.navigator = dom.window.navigator
anyGlobal.HTMLElement = dom.window.HTMLElement
anyGlobal.Node = dom.window.Node
anyGlobal.IS_REACT_ACT_ENVIRONMENT = true
class ResizeObserverStub {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
anyGlobal.ResizeObserver = ResizeObserverStub
;(dom.window as unknown as Record<string, unknown>).ResizeObserver = ResizeObserverStub
dom.window.matchMedia = ((query: string) => ({
  matches: false,
  media: query,
  addEventListener: () => {},
  removeEventListener: () => {},
})) as unknown as typeof dom.window.matchMedia

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

function itemFile(frontmatter: string[], heading: string): string {
  return ['---', ...frontmatter, '---', '', `# ${heading}`, ''].join('\n')
}

const FILES: Record<string, string> = {
  [`${ROOT}/${EPIC_REF}`]: itemFile(['type: epic', 'id: 900'], 'Demo epic title'),
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
  ],
  [`${ROOT}/backlog/epics`]: [{ name: 'demo-epic.md', isDir: false }],
}

type LinkCall = {
  workspaceRoot: string
  relativePath: string
  link: unknown
  status?: string
}
type InitCall = Record<string, unknown> & { statePath: string }

const initCalls: InitCall[] = []
const linkCalls: LinkCall[] = []
// Flipped by the scan-failure check so the backlog walk throws the way an
// unreadable project directory does.
let backlogReadFails = false

let automationHandler: ((requestId: string, request: unknown) => void) | null = null
const pendingResponses = new Map<string, (response: unknown) => void>()

;(dom.window as unknown as { api: Record<string, unknown> }).api = {
  platform: 'darwin',
  pathExists: async (path: string) => path in FILES || path in DIRS,
  readdir: async (path: string) => {
    if (backlogReadFails) throw new Error('backlog directory is unreadable')
    return DIRS[path] ?? []
  },
  readfile: async (path: string) => {
    const content = FILES[path]
    if (content === undefined) throw new Error(`no such file: ${path}`)
    return content
  },
  statPath: async (path: string) => ({
    isFile: path in FILES,
    isDirectory: path in DIRS,
    sizeBytes: (FILES[path] ?? '').length,
    modifiedAt: '2026-08-05T00:00:00.000Z',
    modifiedAtMs: 1786060800000,
  }),
  readBacklogObjectStore: async () => ({ ok: false, message: 'not in this test' }),
  initializeSprintEngineState: async (input: InitCall) => {
    initCalls.push(input)
    return { ok: true }
  },
  addOrUpdateBacklogLink: async (input: LinkCall) => {
    linkCalls.push(input)
    return { ok: true }
  },
  onAutomationRequest: (cb: (requestId: string, request: unknown) => void) => {
    automationHandler = cb
    return () => {
      automationHandler = null
    }
  },
  automationRespond: async (requestId: string, response: unknown) => {
    pendingResponses.get(requestId)?.(response)
    pendingResponses.delete(requestId)
  },
  terminalKill: async () => {},
}

type SprintCreateRequest = {
  kind: 'sprint.create'
  folderPath: string
  goal: string
  name?: string
  sourceRelativePath?: string
  sourceRelativePaths?: string[]
  intake?: 'direct' | 'planned'
}
type AutomationResponse = { ok: boolean; code?: string; message?: string; workspaceId?: string }

async function main(): Promise<void> {
  const React = (await import('react')).default
  const { act } = await import('react')
  const { createRoot } = await import('react-dom/client')
  const { useAutomationRequests } = await import('./useAutomationRequests')
  const { useWorkspaceStore } = await import('../store/workspaceStore')
  const { registerModel } = await import('../utils/modelRegistry')
  const { buildSprintEngineRunLink, teamSlugFromStatePath } = await import(
    '../../../shared/backlog/sprintengine-links'
  )
  const { workspaceRelativePath } = await import('../components/workspace/newWorkspace/helpers')

  let failures = 0
  const check = async (name: string, fn: () => Promise<void>): Promise<void> => {
    initCalls.length = 0
    linkCalls.length = 0
    backlogReadFails = false
    try {
      await fn()
      console.log(`ok - ${name}`)
    } catch (error) {
      failures += 1
      console.error(`not ok - ${name}`)
      console.error(error)
    }
  }

  // `waitForLayoutModel` polls the ephemeral flexlayout registry and fails the
  // request after 5s if the board never mounts. Nothing renders a board here, so
  // stand in a model for each workspace the moment the store gains it — the
  // subscription fires synchronously inside addWorkspace, before the first poll.
  const registered = new Set<string>()
  const registerModels = (): void => {
    for (const workspace of useWorkspaceStore.getState().workspaces) {
      if (registered.has(workspace.id)) continue
      registered.add(workspace.id)
      registerModel(workspace.id, {} as unknown as Parameters<typeof registerModel>[1])
    }
  }
  useWorkspaceStore.subscribe(registerModels)
  registerModels()

  function Harness(): null {
    useAutomationRequests('primary')
    return null
  }

  const container = dom.window.document.createElement('div')
  dom.window.document.body.appendChild(container)
  const root = createRoot(container)
  await act(async () => {
    root.render(<Harness />)
  })
  assert.ok(automationHandler, 'the hook registers a renderer automation handler')

  let requestSeq = 0
  // Drive the REAL registered callback and read the response off the same
  // `automationRespond` channel main would — never by calling an internal.
  const send = async (request: SprintCreateRequest): Promise<AutomationResponse> => {
    requestSeq += 1
    const requestId = `req-${requestSeq}`
    const settled = new Promise<AutomationResponse>((resolve) => {
      pendingResponses.set(requestId, (response) => resolve(response as AutomationResponse))
    })
    automationHandler?.(requestId, request)
    return settled
  }

  const startedRun = (): { teamSlug: string; runRelativePath: string } => {
    assert.equal(initCalls.length, 1, 'exactly one run was initialized')
    const statePath = initCalls[0].statePath
    const runRelativePath = workspaceRelativePath(ROOT, statePath)
    const teamSlug = teamSlugFromStatePath(statePath)
    assert.ok(runRelativePath, 'the run state path resolves project-relative')
    assert.ok(teamSlug, 'the run state path names a team slug')
    return { teamSlug, runRelativePath }
  }

  const workspaceById = (workspaceId: string | undefined) => {
    assert.ok(workspaceId, 'the response carries the created workspace id')
    const workspace = useWorkspaceStore
      .getState()
      .workspaces.find((candidate) => candidate.id === workspaceId)
    assert.ok(workspace, `workspace ${workspaceId} exists in the store`)
    return workspace!
  }

  // The coordinator handoff prompt is the observable half of "does this run
  // plan?": a direct run gets none, because there is no planning pass to start.
  const hasHandoffPrompt = (workspaceId: string | undefined): boolean =>
    Object.values(workspaceById(workspaceId).agents ?? {}).some((agent) =>
      Boolean(agent.cliStartupPrompt),
    )

  const bundleRefs = (): string[] =>
    ((initCalls[0].sourceBundle ?? []) as Array<{ path: string }>).map((entry) => entry.path)

  await check('a single-epic launch links the anchor and every OPEN child only', async () => {
    const response = await send({ kind: 'sprint.create', folderPath: ROOT, goal: '', sourceRelativePath: EPIC_REF })
    assert.equal(response.ok, true, response.message)

    const { teamSlug, runRelativePath } = startedRun()
    assert.equal(initCalls[0].source && (initCalls[0].source as { planKind: string }).planKind, 'epic')
    // The archived child never reaches the bundle; the closed-but-not-archived
    // ones do — they are the run's context, they just get no link.
    assert.deepEqual(
      bundleRefs().sort(),
      [DONE_CHILD_REF, IDEA_CHILD_REF, OPEN_CHILD_REF].sort(),
      'the bundle carries every non-archived child',
    )

    assert.equal(linkCalls.length, 2, 'one anchor link plus one open-child link — nothing else')
    assert.equal(linkCalls[0].relativePath, EPIC_REF)
    assert.deepEqual(linkCalls[0].link, buildSprintEngineRunLink({ teamSlug, runRelativePath }))
    assert.equal(
      'status' in linkCalls[0],
      false,
      'an epic derives its status from its children and is never given one',
    )
    assert.equal(linkCalls[1].relativePath, OPEN_CHILD_REF)
    assert.deepEqual(
      linkCalls[1].link,
      buildSprintEngineRunLink({ teamSlug, runRelativePath, status: 'pending', priorStatus: 'ready' }),
    )
    assert.equal('status' in linkCalls[1], false, 'a pending child link never moves the child itself')
    assert.equal(
      linkCalls.some((call) => call.relativePath === DONE_CHILD_REF || call.relativePath === IDEA_CHILD_REF),
      false,
      'closed children get no link — the engine skips them at import, so it would sit pending forever',
    )
  })

  await check('a singleton ref list collapses to the single-source path', async () => {
    const response = await send({
      kind: 'sprint.create',
      folderPath: ROOT,
      goal: '',
      sourceRelativePaths: [EPIC_REF],
    })
    assert.equal(response.ok, true, response.message)

    const { teamSlug, runRelativePath } = startedRun()
    assert.equal(
      initCalls[0].source && (initCalls[0].source as { planKind: string }).planKind,
      'epic',
      'a one-entry list is the singular contract, not a selection',
    )
    assert.deepEqual(
      linkCalls.map((call) => call.relativePath),
      [EPIC_REF, OPEN_CHILD_REF],
    )
    assert.deepEqual(linkCalls[0].link, buildSprintEngineRunLink({ teamSlug, runRelativePath }))
    assert.deepEqual(
      linkCalls[1].link,
      buildSprintEngineRunLink({ teamSlug, runRelativePath, status: 'pending', priorStatus: 'ready' }),
    )
  })

  await check('a singleton ref list of a plain item launches, as the singular path', async () => {
    // The discriminator between the two routes: the selection builder returns
    // null for a lone plain item (it is deliberately today's single-item flow,
    // byte-identical), so a one-entry list that took the selection path would
    // fail `sprint_invalid_source` instead of launching.
    const response = await send({
      kind: 'sprint.create',
      folderPath: ROOT,
      goal: '',
      sourceRelativePaths: [LOOSE_REF],
    })
    assert.equal(response.ok, true, response.message)
    const { teamSlug, runRelativePath } = startedRun()
    assert.deepEqual(
      linkCalls.map((call) => call.relativePath),
      [LOOSE_REF],
    )
    assert.deepEqual(linkCalls[0].link, buildSprintEngineRunLink({ teamSlug, runRelativePath }))
    assert.equal(linkCalls[0].status, 'in_progress')
  })

  await check('a multi-ref selection writes the same anchor and child shapes', async () => {
    const response = await send({
      kind: 'sprint.create',
      folderPath: ROOT,
      goal: '',
      sourceRelativePaths: [EPIC_REF, LOOSE_REF],
    })
    assert.equal(response.ok, true, response.message)

    const { teamSlug, runRelativePath } = startedRun()
    assert.equal(
      initCalls[0].source && (initCalls[0].source as { planKind: string }).planKind,
      'selection',
      'two refs are a selection',
    )
    assert.deepEqual(
      bundleRefs().sort(),
      [DONE_CHILD_REF, EPIC_REF, IDEA_CHILD_REF, LOOSE_REF, OPEN_CHILD_REF].sort(),
      'the selection bundle carries the epic, its non-archived children, and the loose item',
    )
    // Identical fan-out to the single-epic path: the anchor epic's link, plus
    // one pending link per open epic child. The directly-selected loose item is
    // not an epic child, so it carries no child link (MC-2077 parity).
    assert.deepEqual(
      linkCalls.map((call) => call.relativePath),
      [EPIC_REF, OPEN_CHILD_REF],
    )
    assert.deepEqual(linkCalls[0].link, buildSprintEngineRunLink({ teamSlug, runRelativePath }))
    assert.equal('status' in linkCalls[0], false, 'the anchor epic still gets no item status')
    assert.deepEqual(
      linkCalls[1].link,
      buildSprintEngineRunLink({ teamSlug, runRelativePath, status: 'pending', priorStatus: 'ready' }),
    )
  })

  await check('a non-epic anchor is moved to in_progress by its own link', async () => {
    const response = await send({ kind: 'sprint.create', folderPath: ROOT, goal: '', sourceRelativePath: LOOSE_REF })
    assert.equal(response.ok, true, response.message)

    const { teamSlug, runRelativePath } = startedRun()
    assert.equal(linkCalls.length, 1, 'a loose item has no children to fan out to')
    assert.equal(linkCalls[0].relativePath, LOOSE_REF)
    assert.deepEqual(linkCalls[0].link, buildSprintEngineRunLink({ teamSlug, runRelativePath }))
    assert.equal(linkCalls[0].status, 'in_progress')
  })

  await check('an epic source with no intake runs direct: no intake sent, no planning prompt', async () => {
    const response = await send({ kind: 'sprint.create', folderPath: ROOT, goal: '', sourceRelativePath: EPIC_REF })
    assert.equal(response.ok, true, response.message)
    assert.equal(
      'intake' in initCalls[0],
      false,
      'absent leaves the per-source default with the engine rather than restating it',
    )
    assert.equal(
      hasHandoffPrompt(response.workspaceId),
      false,
      'a direct run has no planning pass to start, so the coordinator gets no handoff prompt',
    )
  })

  await check('an explicit planned intake on an epic source restores the planning prompt', async () => {
    const response = await send({
      kind: 'sprint.create',
      folderPath: ROOT,
      goal: '',
      sourceRelativePath: EPIC_REF,
      intake: 'planned',
    })
    assert.equal(response.ok, true, response.message)
    assert.equal(initCalls[0].intake, 'planned')
    assert.equal(hasHandoffPrompt(response.workspaceId), true, 'a planned run must have somebody prompted to plan it')
  })

  await check('a requested direct on a non-epic source is forwarded but still gets the prompt', async () => {
    const response = await send({
      kind: 'sprint.create',
      folderPath: ROOT,
      goal: '',
      sourceRelativePath: LOOSE_REF,
      intake: 'direct',
    })
    assert.equal(response.ok, true, response.message)
    assert.equal(initCalls[0].intake, 'direct', 'the request is forwarded verbatim — the engine warns, it does not block')
    assert.equal(
      hasHandoffPrompt(response.workspaceId),
      true,
      'the engine downgrades an unsupported direct to planned, so the renderer must mirror it or the plan gate sits with nobody prompted',
    )
  })

  await check('a traversing or absolute ref fails as an invalid source', async () => {
    for (const ref of ['backlog/../../etc/passwd.md', '/etc/passwd.md', 'C:/Windows/system.md']) {
      const response = await send({ kind: 'sprint.create', folderPath: ROOT, goal: '', sourceRelativePath: ref })
      assert.equal(response.ok, false, `${ref} must not launch`)
      assert.equal(response.code, 'sprint_invalid_source', ref)
    }
    // The same guard covers every entry of a multi-ref list, not just the anchor.
    const response = await send({
      kind: 'sprint.create',
      folderPath: ROOT,
      goal: '',
      sourceRelativePaths: [LOOSE_REF, 'backlog/../secrets.md'],
    })
    assert.equal(response.code, 'sprint_invalid_source')
    assert.equal(initCalls.length, 0, 'nothing was initialized')
    assert.equal(linkCalls.length, 0, 'nothing was linked')
  })

  await check('an unknown source fails as a missing source, from either entry point', async () => {
    const single = await send({
      kind: 'sprint.create',
      folderPath: ROOT,
      goal: '',
      sourceRelativePath: 'backlog/not-a-real-item.md',
    })
    assert.equal(single.ok, false)
    assert.equal(single.code, 'sprint_source_missing')

    const selection = await send({
      kind: 'sprint.create',
      folderPath: ROOT,
      goal: '',
      sourceRelativePaths: [LOOSE_REF, 'backlog/not-a-real-item.md'],
    })
    assert.equal(selection.ok, false, 'a selection never silently drops a ref the caller asked for')
    assert.equal(selection.code, 'sprint_source_missing')
    assert.equal(initCalls.length, 0, 'nothing was initialized')
  })

  await check('an unreadable backlog fails the selection as unavailable', async () => {
    backlogReadFails = true
    const response = await send({
      kind: 'sprint.create',
      folderPath: ROOT,
      goal: '',
      sourceRelativePaths: [EPIC_REF, LOOSE_REF],
    })
    assert.equal(response.ok, false)
    assert.equal(response.code, 'sprint_backlog_unavailable')
    assert.equal(initCalls.length, 0, 'a scan that cannot resolve the selection never launches a run')
  })

  await act(async () => {
    root.unmount()
  })

  if (failures > 0) {
    console.error(`\n${failures} useAutomationRequests checks failed`)
    process.exit(1)
  }
  console.log('useAutomationRequests.test.tsx: ok')
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
