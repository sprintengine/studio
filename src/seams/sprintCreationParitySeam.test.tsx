import assert from 'node:assert/strict'

import { JSDOM } from 'jsdom'

import type { AutomationRendererRequest, AutomationRendererResponse } from '../shared/automation'

// Sprint creation parity — the MCP gateway vs the New Sprint dialog.
//
// T3 widened `sprint.create` with `runtime`/`roleClis`/`roleModels`/`roleEfforts`/
// `maxConcurrentAgents`; T7 gave the dialog its Connectors row and its advanced-
// setup seam. Both suites pin their OWN path against literals. Neither compares
// them, so the two could drift apart — the gateway's documented contract saying
// one thing while a person clicking Start gets another — and every test would
// still be green. This suite is the comparison: one configuration, both paths,
// the SAME assertion object.
//
// What it compares is `initializeSprintEngineState`'s payload, because that is
// what becomes run.yaml: `roleRuntimes` is read by every spawn and every
// claim-time model stamp, and `enabledRoles` is the run's legal role set.
//
// Two carve-outs, both deliberate and both stated rather than skipped:
//
//   * **Reasoning effort** is session-local in the wizard by ruling (see the
//     `NO reasoning member` note on `SprintEngineSavedRoster`), so a saved
//     roster cannot carry one and the dialog cannot be configured to a known
//     effort without driving its pickers — `test:seams:roster-effort` owns that.
//     Parity here is asserted on the slot: both paths must leave `reasoning`
//     off when nothing asked for one, and the gateway's `roleEfforts` writes the
//     same `roleReasoningOverrides` the picker does (test:renderer:sprint-create-automation).
//   * **The agent ceiling's DEFAULT differs by design** — the dialog seeds 2 for
//     a no-roles run and 3 for a staffed one (MC-1585), the gateway always 3.
//     "The same configuration" therefore means an explicit ceiling, which is
//     what the gateway contract tells a caller to send; the defaults are checked
//     below and recorded, not asserted equal.

const dom = new JSDOM('<!doctype html><html><body></body></html>', {
  url: 'http://localhost',
  pretendToBeVisual: true,
})

const anyGlobal = globalThis as unknown as Record<string, unknown>
anyGlobal.window = dom.window
anyGlobal.document = dom.window.document
anyGlobal.navigator = dom.window.navigator
anyGlobal.HTMLElement = dom.window.HTMLElement
anyGlobal.HTMLInputElement = dom.window.HTMLInputElement
anyGlobal.HTMLTextAreaElement = dom.window.HTMLTextAreaElement
anyGlobal.Node = dom.window.Node
anyGlobal.MouseEvent = dom.window.MouseEvent
anyGlobal.KeyboardEvent = dom.window.KeyboardEvent
anyGlobal.getComputedStyle = dom.window.getComputedStyle
anyGlobal.IS_REACT_ACT_ENVIRONMENT = true
class ResizeObserverStub {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
anyGlobal.ResizeObserver = ResizeObserverStub
;(dom.window as unknown as Record<string, unknown>).ResizeObserver = ResizeObserverStub
dom.window.HTMLElement.prototype.scrollIntoView = function scrollIntoView(): void {}
dom.window.matchMedia = ((query: string) => ({
  matches: false,
  media: query,
  addEventListener: () => {},
  removeEventListener: () => {},
})) as unknown as typeof dom.window.matchMedia

const ROOT = '/proj'
const LOOSE_REF = 'backlog/loose-item.md'
const EPIC_REF = 'backlog/epics/demo-epic.md'
function itemFile(frontmatter: string[], heading: string): string {
  return ['---', ...frontmatter, '---', '', `# ${heading}`, ''].join('\n')
}
const FILES: Record<string, string> = {
  [`${ROOT}/${LOOSE_REF}`]: itemFile(['type: feature', 'status: ready', 'id: 902'], 'Loose item title'),
  [`${ROOT}/${EPIC_REF}`]: itemFile(['type: epic', 'dependenciesPlanned: true', 'id: 900'], 'Demo epic title'),
  [`${ROOT}/backlog/child-item.md`]: itemFile(
    ['type: feature', 'status: ready', 'epic: demo-epic', 'id: 901'],
    'Child item title',
  ),
}
const DIRS: Record<string, Array<{ name: string; isDir: boolean }>> = {
  [`${ROOT}/backlog`]: [
    { name: 'epics', isDir: true },
    { name: 'child-item.md', isDir: false },
    { name: 'loose-item.md', isDir: false },
  ],
  [`${ROOT}/backlog/epics`]: [{ name: 'demo-epic.md', isDir: false }],
}

type InitCall = Record<string, unknown>
const initCalls: InitCall[] = []

;(dom.window as unknown as { api: Record<string, unknown> }).api = {
  platform: 'darwin',
  pathExists: async (path: string) => path in FILES || path in DIRS,
  readdir: async (path: string) => DIRS[path] ?? [],
  readfile: async (path: string) => {
    const content = FILES[path]
    if (content === undefined) throw new Error(`no such file: ${path}`)
    return content
  },
  statPath: async (path: string) => ({
    isFile: path in FILES,
    isDirectory: path in DIRS,
    sizeBytes: (FILES[path] ?? '').length,
    modifiedAt: '2026-08-06T00:00:00.000Z',
    modifiedAtMs: 1785974400000,
  }),
  readBacklogObjectStore: async () => ({ ok: false, message: 'not in this test' }),
  openFile: async () => null,
  addOrUpdateBacklogLink: async () => ({ ok: true }),
  onAutomationRequest: (cb: (requestId: string, request: AutomationRendererRequest) => void) => {
    automationHandler = cb
    return () => {
      automationHandler = null
    }
  },
  automationRespond: async (requestId: string, response: AutomationRendererResponse) => {
    pendingResponses.get(requestId)?.(response)
    pendingResponses.delete(requestId)
  },
  initializeSprintEngineState: async (input: InitCall) => {
    initCalls.push(input)
    return { ok: true, data: {} }
  },
  // Every enabled connector reaches the project through this one write on both
  // paths' behalf; captured so the MCP set can be compared rather than assumed.
  mcpSync: async (input: { workspaceRoot: string; settings: { servers: Record<string, { id: string; enabled: boolean }> } }) => {
    mcpSyncCalls.push({
      workspaceRoot: input.workspaceRoot,
      enabledIds: Object.values(input.settings.servers).filter((server) => server.enabled).map((server) => server.id),
    })
    return { ok: true, targets: [], issues: [] }
  },
}
const mcpSyncCalls: Array<{ workspaceRoot: string; enabledIds: string[] }> = []
let automationHandler: ((requestId: string, request: AutomationRendererRequest) => void) | null = null
const pendingResponses = new Map<string, (response: AutomationRendererResponse) => void>()

// The run-shaping fields both paths must agree on. Deliberately NOT the whole
// payload: `statePath`, `teamSlug` and the source seed differ by run name and
// capture time, which is expected and says nothing about parity.
type RunShape = {
  roleRuntimes: unknown
  enabledRoles: unknown
  goal: unknown
}
function runShape(init: InitCall): RunShape {
  return {
    roleRuntimes: init.roleRuntimes,
    enabledRoles: init.enabledRoles,
    goal: init.goal,
  }
}

async function main(): Promise<void> {
  const React = (await import('react')).default
  const { act } = await import('react')
  const { createRoot } = await import('react-dom/client')
  const NewSprintDialog = (await import('../renderer/src/components/workspace/newSprint/NewSprintDialog')).default
  const { useAutomationRequests } = await import('../renderer/src/hooks/useAutomationRequests')
  const { useWorkspaceStore } = await import('../renderer/src/store/workspaceStore')
  const { buildBacklogSelectionSourcePlan } = await import(
    '../renderer/src/components/backlog/backlogSelectionSourcePlan'
  )
  const { scanBacklog } = await import('../renderer/src/utils/backlog')

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
  const flush = async (): Promise<void> => {
    await act(async () => {
      for (let i = 0; i < 20; i += 1) await Promise.resolve()
    })
  }

  // --- the one configuration, expressed once -------------------------------
  //
  // A staffed roster with a per-role CLI and a per-role model on each seat: the
  // shape that actually exercises the three maps `buildSprintEngineRoleRuntimes`
  // unions. The dialog reads it by having the roster SELECTED; the gateway reads
  // the same stored roster by name.
  const ROSTER_NAME = 'Parity crew'
  const ROLE_CLIS = { architect: 'codex', developer: 'claude-code' }
  const ROLE_MODELS = { architect: 'claude-opus-5', developer: 'claude-sonnet-5' }
  const CEILING = 4

  let rosterId: string | null = null
  await act(async () => {
    rosterId = useWorkspaceStore.getState().saveSprintEngineRoster({
      name: ROSTER_NAME,
      roleCounts: { architect: 1, developer: 1 },
      roleCliDefaults: ROLE_CLIS,
      roleModelOverrides: ROLE_MODELS,
    })
    useWorkspaceStore.getState().setSprintEngineLastSelectedRoster(rosterId)
  })
  assert.ok(rosterId, 'the shared roster fixture saves')

  const scanned = await scanBacklog(ROOT, {
    pathExists: (dom.window as unknown as { api: { pathExists: (p: string) => Promise<boolean> } }).api.pathExists,
    readdir: (dom.window as unknown as { api: { readdir: (p: string) => Promise<Array<{ name: string; isDir: boolean }>> } }).api.readdir,
    readfile: (dom.window as unknown as { api: { readfile: (p: string) => Promise<string> } }).api.readfile,
    statPath: (dom.window as unknown as { api: { statPath: (p: string) => Promise<unknown> } }).api.statPath as never,
  })
  assert.equal(scanned.state, 'ready', 'the fixture project scans')
  const loose = scanned.items.find((item) => item.relativePath === LOOSE_REF)
  const epic = scanned.items.find((item) => item.relativePath === EPIC_REF)
  assert.ok(loose && epic, 'the fixture project has the items both paths start from')
  const source = buildBacklogSelectionSourcePlan({
    workspaceRoot: ROOT,
    items: [epic, loose],
    projectItems: scanned.items,
  })
  assert.ok(source, 'the selection builds one source plan')

  // --- path A: a person clicking Start sprint ------------------------------
  async function createThroughTheDialog(): Promise<InitCall> {
    initCalls.length = 0
    const container = dom.window.document.createElement('div')
    dom.window.document.body.appendChild(container)
    const root = createRoot(container)
    await act(async () => {
      root.render(
        <NewSprintDialog
          initialFolderPath={ROOT}
          initialSource={source}
          projectOptions={[{ path: ROOT, label: 'proj' }]}
          workspaceWindowId="test-window"
          onClose={() => {}}
        />,
      )
    })
    await flush()
    const start = Array.from(container.querySelectorAll('button')).find((element) =>
      element.textContent?.includes('Start sprint'),
    )
    assert.ok(start, 'the dialog offers Start sprint')
    await act(async () => {
      start!.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true }))
    })
    await flush()
    root.unmount()
    container.remove()
    assert.equal(initCalls.length, 1, `the dialog initialized exactly one run (got ${initCalls.length})`)
    return initCalls[0]
  }

  // --- path B: an MCP caller issuing sprint.create -------------------------
  //
  // Driven through the REAL registered callback and read off the same
  // `automationRespond` channel main uses — never by reaching into an internal.
  const { registerModel } = await import('../renderer/src/utils/modelRegistry')
  // `waitForLayoutModel` polls the flexlayout registry and fails the request
  // after 5s if no board mounts. Nothing renders one here, so stand a model in
  // the moment the store gains a workspace.
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

  function AutomationHost(): null {
    useAutomationRequests('primary')
    return null
  }
  const hostContainer = dom.window.document.createElement('div')
  dom.window.document.body.appendChild(hostContainer)
  const hostRoot = createRoot(hostContainer)
  await act(async () => {
    hostRoot.render(<AutomationHost />)
  })
  await flush()
  assert.ok(automationHandler, 'the automation hook registered its handler')

  let requestSeq = 0
  type GatewayRun = { init: InitCall; workspaceId: string }
  async function createThroughTheGateway(request: Record<string, unknown>): Promise<GatewayRun> {
    initCalls.length = 0
    requestSeq += 1
    const requestId = `parity-${requestSeq}`
    const settled = new Promise<AutomationRendererResponse>((resolve) => {
      pendingResponses.set(requestId, resolve)
    })
    let timer: ReturnType<typeof setTimeout> | undefined
    const timedOut = new Promise<AutomationRendererResponse>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error(`request ${requestId} never answered`)), 15_000)
    })
    let response: AutomationRendererResponse
    await act(async () => {
      automationHandler!(requestId, {
        kind: 'sprint.create',
        folderPath: ROOT,
        goal: '',
        // The SAME selection the dialog was preloaded with, in the same order —
        // a different source would make the comparison meaningless.
        sourceRelativePaths: [EPIC_REF, LOOSE_REF],
        ...request,
      } as AutomationRendererRequest)
      response = await Promise.race([settled, timedOut])
    })
    if (timer) clearTimeout(timer)
    assert.equal(response!.ok, true, `sprint.create failed: ${JSON.stringify(response!)}`)
    assert.equal(initCalls.length, 1, `the gateway initialized exactly one run (got ${initCalls.length})`)
    // The workspace id rides back with the payload: the store accumulates a
    // workspace per check, so a later assertion that goes looking for "the
    // sprint workspace" would find the FIRST one and pass on the wrong run.
    const workspaceId = (response! as { workspaceId?: string }).workspaceId
    assert.ok(workspaceId, 'the response names the workspace it created')
    return { init: initCalls[0], workspaceId: workspaceId! }
  }

  // ── the parity assertion ──────────────────────────────────────────────────

  await check('the same roster produces the same run through the dialog and through sprint.create', async () => {
    const viaDialog = await createThroughTheDialog()
    const viaGateway = (await createThroughTheGateway({ rosterName: ROSTER_NAME, maxConcurrentAgents: CEILING })).init

    // The headline: the run each path asks the engine to create is the same run.
    assert.deepEqual(
      runShape(viaGateway),
      runShape(viaDialog),
      'the gateway contract and the dialog disagree about what a run carries',
    )

    // Named explicitly too, so a future failure says WHICH half drifted rather
    // than dumping two objects.
    const runtimes = viaDialog.roleRuntimes as Record<string, { cli: string; model: string | null; reasoning?: string }>
    assert.deepEqual(runtimes.architect, { model: ROLE_MODELS.architect, cli: ROLE_CLIS.architect })
    assert.deepEqual(runtimes.developer, { model: ROLE_MODELS.developer, cli: ROLE_CLIS.developer })
    assert.deepEqual(
      (viaDialog.enabledRoles as string[]).slice().sort(),
      ['architect', 'developer'],
      'both paths staff the roster the fixture saved',
    )
    // The effort carve-out, asserted rather than assumed: neither path invents a
    // level nobody chose, so `reasoning` is absent on both sides.
    assert.equal('reasoning' in runtimes.architect, false, 'no effort flag unless one was picked')
  })

  await check('the ceiling the caller sends is the ceiling the dialog would have set', async () => {
    // Read off the run each path ACTUALLY created, by id. The store keeps every
    // workspace an earlier check made, so "find the sprint workspace" would
    // answer with the first one and prove nothing about this call.
    const dialogBefore = new Set(useWorkspaceStore.getState().workspaces.map((workspace) => workspace.id))
    await createThroughTheDialog()
    const dialogWorkspace = useWorkspaceStore
      .getState()
      .workspaces.find((workspace) => !dialogBefore.has(workspace.id))
    assert.ok(dialogWorkspace, 'the dialog created a workspace of its own')
    const dialogCeiling = dialogWorkspace!.sprintEngineAutoState?.maxConcurrentAgents
    assert.equal(dialogCeiling, 3, 'the dialog pre-fills a staffed roster at 3 (MC-1585)')

    // Sending that same number reproduces that same run — the ceiling is not
    // re-defaulted, floored, or dropped on the way through the gateway.
    const gateway = await createThroughTheGateway({ rosterName: ROSTER_NAME, maxConcurrentAgents: dialogCeiling })
    const gatewayWorkspace = useWorkspaceStore
      .getState()
      .workspaces.find((workspace) => workspace.id === gateway.workspaceId)
    assert.ok(gatewayWorkspace, 'the gateway workspace is the one its response named')
    assert.equal(
      gatewayWorkspace!.sprintEngineAutoState?.maxConcurrentAgents,
      dialogCeiling,
      'the caller\'s ceiling reaches the run rather than being re-defaulted',
    )
    // And a ceiling the dialog cannot express is clamped, not honoured raw.
    const overshoot = await createThroughTheGateway({ rosterName: ROSTER_NAME, maxConcurrentAgents: 99 })
    assert.equal(
      useWorkspaceStore.getState().workspaces.find((workspace) => workspace.id === overshoot.workspaceId)
        ?.sprintEngineAutoState?.maxConcurrentAgents,
      10,
      'an out-of-range ceiling is clamped to the run maximum, never written through raw',
    )
  })

  await check('neither path gives a run its own MCP server set — both take the app-level one', async () => {
    // The ruling T7 recorded (`sprintConnectors.ts` header): `appSettings.mcp` is
    // the ONE selection, and agents receive it at spawn through
    // `mcpSettingsForManagedSprintEngineLaunch`. That only stays true while
    // neither creation path writes a run-scoped server set into run.yaml — if
    // one ever did, the gateway and the dialog would produce runs with different
    // tools from identical settings, silently.
    for (const [label, init] of [
      ['dialog', await createThroughTheDialog()],
      ['gateway', (await createThroughTheGateway({ rosterName: ROSTER_NAME, maxConcurrentAgents: CEILING })).init],
    ] as const) {
      // Walked in full, not just the top level: a run-scoped server set would
      // most naturally arrive nested (under a settings or runtime member), and
      // a shallow key scan would wave it straight through.
      const found: string[] = []
      const walk = (value: unknown, path: string, depth: number): void => {
        if (depth > 6 || value === null || typeof value !== 'object') return
        for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
          const here = path ? `${path}.${key}` : key
          if (/mcp|connector|(^|\.)servers?$/i.test(here)) found.push(here)
          walk(child, here, depth + 1)
        }
      }
      walk(init, '', 0)
      assert.deepEqual(found, [], `the ${label} path recorded a run-scoped MCP set at: ${found.join(', ')}`)
    }
  })

  await check('the dialog writes the enabled connectors before creating; the gateway inherits them at spawn', async () => {
    // The one real asymmetry, pinned so it stays a known shape rather than
    // becoming a surprise: the dialog runs the advanced-setup preflight (it has
    // a person to fail in front of), the gateway does not. Both runs still get
    // the same servers, because the write that reaches an agent happens at
    // SPAWN, from the same app-level settings.
    await act(async () => {
      useWorkspaceStore.setState((state) => ({
        appSettings: {
          ...state.appSettings,
          mcp: {
            syncEnabled: true,
            servers: {
              github: { id: 'github', name: 'GitHub', enabled: true, transport: 'stdio', command: 'gh' },
              linear: { id: 'linear', name: 'Linear', enabled: false, transport: 'stdio', command: 'linear' },
            },
          },
        },
      }))
    })
    try {
      mcpSyncCalls.length = 0
      await createThroughTheDialog()
      assert.deepEqual(
        mcpSyncCalls,
        [{ workspaceRoot: ROOT, enabledIds: ['github'] }],
        'the dialog preflights the enabled selection into the project',
      )

      mcpSyncCalls.length = 0
      await createThroughTheGateway({ rosterName: ROSTER_NAME, maxConcurrentAgents: CEILING })
      assert.deepEqual(mcpSyncCalls, [], 'the gateway does not preflight — it has no person to fail in front of')
    } finally {
      await act(async () => {
        useWorkspaceStore.setState((state) => ({
          appSettings: { ...state.appSettings, mcp: { syncEnabled: false, servers: {} } },
        }))
      })
    }
  })

  hostRoot.unmount()
  hostContainer.remove()

  if (failures > 0) {
    console.error(`\n${failures} check(s) failed`)
    process.exit(1)
  }
  console.log('sprint creation parity seam: ok')
}

void main()
