import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { installJsdomEnvironment, withInertPreloadFallback } from './jsdomEnvironment'
import type { SprintEngineLaunchSettingsWriteResult } from '../main/sprintengine-launch-settings-mirror'
import { emptySprintEngineLaunchSettings } from '../shared/sprintengine/launch-settings'

// ── Seam: the Sprints door's run configuration (T1 → T2 → T3, items 1799/1800) ─
//
// The door mounts the run board with NO resident workspace, so every
// workspace-keyed store action silently no-ops against the `''` sentinel. T1
// gave the CLI permission preset a statePath-keyed home in main, T2 routed the
// board's engine-level controls to it, and T3 did the same for the roster
// actions. Each task's own suite proves its half against a stubbed counterpart:
// the board's suite stubs `window.api`, and the service's suite calls the
// service directly. Neither can catch the seam failing — a channel name the
// preload spells one way and main registers another, a payload shape that
// survives a hand-written stub, an intent record whose preset the service never
// actually persists.
//
// So this suite wires the real halves together and asserts on the FILE:
//
//   the mounted board  →  the real preload passthrough (src/preload/api)
//                      →  the real main IPC handlers (src/main/ipc)
//                      →  the real automation service (src/main)
//                      →  automation.json beside run.yaml, on disk
//
// Only the Python engine is out of reach (`sprintengine:roster:enable` shells
// out to it), so that one handler records what it was asked to do; everything
// between the click and the engine's front door is the product's own code.

const dom = installJsdomEnvironment()
const domWindow = dom.window as unknown as Record<string, unknown>

type RunSummary = Record<string, unknown>

// The launch-settings store's write acknowledgement, stubbed: this seam proves
// the Sprints door, which never reads or writes launch settings.
function stubLaunchSettingsWrite(): SprintEngineLaunchSettingsWriteResult {
  return {
    record: {
      schemaVersion: 1,
      revision: 1,
      settings: emptySprintEngineLaunchSettings(),
      changedAt: 0,
      lastWrite: { actor: 'system', at: '' },
    },
    changed: false,
    persisted: Promise.resolve(),
  }
}

async function main(): Promise<void> {
  const projectRoot = mkdtempSync(join(tmpdir(), 'multicode-seam-sprints-door-'))
  try {
    await run(projectRoot)
  } finally {
    rmSync(projectRoot, { recursive: true, force: true })
  }
}

async function run(projectRoot: string): Promise<void> {
  const { ipcMain } = await import('electron')
  const { createSprintEngineAutomationService } = await import('../main/sprintengine-automation-service')
  const { registerSprintEngineAutomationIpc } = await import('../main/ipc/sprintengine-automation-ipc')
  const { registerSprintEngineIpc } = await import('../main/ipc/sprintengine-ipc')
  const {
    SPRINT_ENGINE_AUTOMATION_INTENT_FILE,
    parseSprintEngineAutomationIntentRecord,
  } = await import('../shared/sprintengine/automation-intent')
  const { sprintEngineApi } = await import('../preload/api/sprintengine')

  const teamSlug = 'seam-run'
  const teamDirectory = join(projectRoot, '.multi-code', 'sprintengine', teamSlug)
  mkdirSync(teamDirectory, { recursive: true })
  const statePath = join(teamDirectory, 'run.yaml')
  writeFileSync(statePath, 'sprintengine: {}\n', 'utf8')
  const intentPath = join(teamDirectory, SPRINT_ENGINE_AUTOMATION_INTENT_FILE)

  // ── Main: the real service, wired exactly as app-services wires it ─────────
  const bridged: Array<{ statePath: string; cliWatchPolling: string }> = []
  const broadcasts: Array<Record<string, unknown>> = []
  const automationService = createSprintEngineAutomationService({
    setRunnerCliWatchPolling: async (input) => {
      bridged.push(input)
      return { ok: true }
    },
    logDiagnostic: () => {},
    broadcast: (event) => {
      broadcasts.push(event as unknown as Record<string, unknown>)
    },
  })

  // Every write the renderer sends, as main received it — the `''` sentinel
  // assertion below reads these rather than the renderer's own intent.
  const modeWrites: Array<Record<string, unknown>> = []
  const presetWrites: Array<Record<string, unknown>> = []
  registerSprintEngineAutomationIpc(ipcMain, {
    automation: {
      readAutomationMode: (input) => automationService.readAutomationMode(input),
      hydrateAutomationMode: (input) => automationService.hydrateAutomationMode(input),
      setAutomationMode: (input) => {
        modeWrites.push(input as unknown as Record<string, unknown>)
        return automationService.setAutomationMode(input)
      },
      setCliPermissionPreset: (input) => {
        presetWrites.push(input as unknown as Record<string, unknown>)
        return automationService.setCliPermissionPreset(input)
      },
    },
    // The door never touches launch settings; the store is stubbed to the
    // acknowledgement shape its IPC handlers return.
    launchSettings: { set: stubLaunchSettingsWrite, hydrate: stubLaunchSettingsWrite },
  })

  // The run's projected state, as `sprintengine:projection:read` hands it back.
  let configuredRoles = ['developer']
  const enableRoleCalls: Array<Record<string, unknown>> = []
  const projection = (): Record<string, unknown> => ({
    run: {
      name: teamSlug,
      goal: 'Prove the seams hold',
      rosterConfigured: true,
      configuredRoles: [...configuredRoles],
      vcs: {
        mode: 'run_worktree',
        worktreePath: '.multi-code/worktree',
        branchName: `sprintengine/${teamSlug}`,
        baseRef: 'main',
        repos: [
          {
            id: 'primary',
            root: '.',
            worktreePath: '.multi-code/worktree/primary',
            branchName: `sprintengine/${teamSlug}`,
            baseRef: 'main',
            lastCommitSha: 'c0ffee',
            pullRequestUrl: null,
            pullRequestState: null,
          },
        ],
        declaredRepoCount: 1,
      },
    },
    roster: { 'developer-1': { role: 'developer', status: 'idle', currentTaskId: null } },
    tasks: [{ id: 'T1', title: 'Task T1', role: 'developer', status: 'in_progress', repo: 'primary', dependsOn: [] }],
  })

  const summaries: RunSummary[] = [
    {
      statePath,
      teamName: teamSlug,
      projectRoot,
      projectName: projectRoot.slice(projectRoot.lastIndexOf('/') + 1),
      runtimeState: 'running',
      taskCounts: { total: 1, done: 0, inProgress: 1, waiting: 0 },
      repoRollup: { declared: 1, merged: 0, open: 0 },
      needsInputCount: 0,
      branchName: null,
      worktreePath: null,
      startedAt: null,
      updatedAt: null,
      finishedAt: null,
      sourceLabel: null,
    },
  ]

  // The rest of the sprintengine channel surface. Only the four this seam
  // crosses answer for real; the others refuse rather than fake a result, which
  // is why they are spelled out instead of proxied.
  const refuse = async (): Promise<{ ok: false; message: string }> => ({
    ok: false,
    message: 'This channel is not part of the run-configuration seam.',
  })
  registerSprintEngineIpc(ipcMain, {
    listRuns: async () => summaries as never,
    readProjection: async () => ({ ok: true, data: projection(), token: `token-${configuredRoles.length}` } as never),
    readRegistryRoles: async () => ({
      ok: true,
      data: {
        roles: [
          { id: 'developer', label: 'Developer' },
          { id: 'tester', label: 'Tester' },
          { id: 'security', label: 'Security' },
        ],
      },
    } as never),
    enableRole: async (payload) => {
      enableRoleCalls.push(payload as unknown as Record<string, unknown>)
      if (!configuredRoles.includes(payload.role)) configuredRoles = [...configuredRoles, payload.role]
      return { ok: true } as never
    },
    openArtifact: refuse,
    reviewArtifact: refuse,
    initializeSprintEngineState: refuse,
    updateTask: refuse,
    createTask: refuse,
    commentTask: refuse,
    resolveTaskInput: refuse,
    setTaskStatus: refuse,
    setRunnerMode: refuse,
    cancelRun: refuse,
    createPullRequest: refuse,
    mergePullRequest: refuse,
    refreshPullRequestStatus: refuse,
    setRoleRuntime: refuse,
    readRegistryRole: refuse,
    summarizeFeedback: refuse,
    readTokenUsage: refuse,
  } as unknown as Parameters<typeof registerSprintEngineIpc>[1])

  // ── Renderer: the real preload bridge for every sprintengine channel ───────
  const notifications: Array<Record<string, unknown>> = []
  domWindow.api = withInertPreloadFallback({
    platform: 'darwin',
    ...sprintEngineApi,
    pathExists: async () => true,
    logDiagnostic: async (input: Record<string, unknown>) => {
      const entry = { ...input, id: `diag-${notifications.length + 1}`, timestamp: '2026-07-26T12:00:00.000Z' }
      notifications.push(entry)
      return entry
    },
  })

  const React = await import('react')
  const { act } = React
  const { createRoot } = await import('react-dom/client')
  const { useWorkspaceStore } = await import('../renderer/src/store/workspaceStore')
  const { default: SprintsGlobalSurface } = await import(
    '../renderer/src/components/workspace/globalSurface/sprints/SprintsGlobalSurface'
  )
  const { ConfirmDialogProvider } = await import('../renderer/src/components/ui/ConfirmDialog')

  // Every write in this suite crosses a real disk I/O boundary, so settling on
  // microtasks alone would read the file before the service has written it. Each
  // pass yields to the event loop for real.
  async function settle(times = 8): Promise<void> {
    for (let index = 0; index < times; index += 1) {
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 1))
      })
    }
  }

  // Waiting for a condition, never for a duration: a fixed settle long enough on
  // this machine is a flake on a loaded one, and a flaky suite is a quality
  // problem of its own. Assertions of ABSENCE cannot use this and settle
  // instead — there is no condition to wait for.
  async function waitFor(label: string, predicate: () => boolean, timeoutMs = 10_000): Promise<void> {
    const deadline = Date.now() + timeoutMs
    while (!predicate() && Date.now() < deadline) {
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 5))
      })
    }
    assert.ok(predicate(), `timed out waiting for ${label}`)
  }

  // One project open, and it is NOT the run's workspace: the run lists from
  // disk, so the board mounts on the door with `workspaceId === ''`.
  useWorkspaceStore.setState({
    workspaces: [
      { id: 'w1', name: 'project', mode: 'standard', folderPath: projectRoot, agents: {}, openFiles: [], createdAt: 1 },
    ],
    activeWorkspaceId: 'w1',
    activeGlobalSurface: 'sprints',
  } as never)

  const container = dom.window.document.createElement('div')
  dom.window.document.body.appendChild(container)
  const root = createRoot(container)
  await act(async () => {
    root.render(React.createElement(ConfirmDialogProvider, null, React.createElement(SprintsGlobalSurface)))
  })
  await settle()

  assert.equal(
    useWorkspaceStore.getState().workspaces.some((workspace) => workspace.sprintEngineContext?.statePath === statePath),
    false,
    'the run has no resident workspace — this is the door mount',
  )

  // ── Helpers over the rendered board ───────────────────────────────────────
  const openRunConfig = async (): Promise<void> => {
    const trigger = [...container.querySelectorAll('button')].find((candidate) =>
      candidate.getAttribute('aria-label')?.startsWith('Run configuration'),
    )
    assert.ok(trigger, 'the board header carries the run-configuration chip')
    await act(async () => {
      ;(trigger as HTMLElement).click()
    })
    await settle(3)
  }
  const modeLabel = (radio: Element): string => radio.querySelector('span span')?.textContent?.trim() ?? ''
  const pickAutomationMode = async (label: string): Promise<void> => {
    const option = [...dom.window.document.querySelectorAll('[role="radio"]')].find(
      (candidate) => modeLabel(candidate) === label,
    )
    assert.ok(option, `the run-configuration popover offers ${label}`)
    await act(async () => {
      ;(option as HTMLElement).click()
    })
    await settle()
  }
  const checkedAutomationMode = (): string => {
    const checked = [...dom.window.document.querySelectorAll('[role="radio"]')].find(
      (candidate) => candidate.getAttribute('aria-checked') === 'true',
    )
    return checked ? modeLabel(checked) : ''
  }
  const pickCliPreset = async (label: string): Promise<void> => {
    const trigger = dom.window.document.querySelector('button[aria-label="CLI permission preset"]')
    assert.ok(trigger, 'the popover carries the CLI permission preset control')
    await act(async () => {
      ;(trigger as HTMLElement).click()
    })
    const option = [...dom.window.document.querySelectorAll('li[role="option"]')].find((candidate) =>
      candidate.textContent?.startsWith(label),
    )
    assert.ok(option, `the preset list offers ${label}`)
    await act(async () => {
      ;(option as HTMLElement).click()
    })
    await settle()
  }
  const modeNotifications = (): Array<Record<string, unknown>> =>
    notifications.filter((entry) => entry.title === 'Auto-run mode changed')
  const persistedRecord = (): Record<string, unknown> | null => {
    if (!existsSync(intentPath)) return null
    return parseSprintEngineAutomationIntentRecord(
      JSON.parse(readFileSync(intentPath, 'utf8')),
    ) as unknown as Record<string, unknown>
  }

  // ── 1. The automation mode lands in the run's own state ───────────────────
  assert.equal(persistedRecord(), null, 'the run carries no intent before the door writes one')
  await openRunConfig()
  assert.equal(checkedAutomationMode(), 'Manual', 'a run with no intent reads Manual')

  await pickAutomationMode('Run agents')
  await waitFor('the door mode write to reach the run’s state file', () => persistedRecord() !== null)
  const afterMode = persistedRecord()
  assert.ok(afterMode, 'the door mode write reached the run’s own state file')
  assert.equal(afterMode?.desiredMode, 'run_agents', 'and it is the mode that was picked')
  assert.equal(afterMode?.revision, 1, 'as the first revision of this run’s intent')
  assert.equal(
    (afterMode?.lastWrite as Record<string, unknown> | undefined)?.actor,
    'ui',
    'attributed to the renderer boundary the write actually came through',
  )
  assert.equal(checkedAutomationMode(), 'Run agents', 'and the control holds what it wrote')
  await waitFor('the mode-changed notification', () => modeNotifications().length === 1)
  assert.equal(modeNotifications().length, 1, 'the confirmed write announces itself exactly once')
  assert.equal(
    modeNotifications()[0]?.workspaceId,
    undefined,
    'and names no workspace rather than carrying the empty sentinel',
  )
  assert.deepEqual(
    bridged,
    [{ statePath, cliWatchPolling: 'enabled' }],
    'the engine-level bridge ran for a door write, exactly as for a resident one',
  )
  assert.equal(broadcasts.length, 1, 'one broadcast per landed change')
  console.log('ok - a door automation-mode change lands in the run’s state through the real channel')

  // ── 2. The CLI permission preset shares that home (item 1799, D1) ─────────
  await pickCliPreset('Auto')
  await waitFor(
    'the preset write to land beside the mode',
    () => persistedRecord()?.cliPermissionPreset === 'auto',
  )
  const afterPreset = persistedRecord()
  assert.equal(afterPreset?.cliPermissionPreset, 'auto', 'the preset persisted beside the mode')
  assert.equal(afterPreset?.desiredMode, 'run_agents', 'a preset write never moves the mode')
  assert.equal(afterPreset?.revision, 2, 'and is a new revision of the same intent record')

  // What a workspace attaching later does. D1's whole claim is that the preset
  // a door wrote survives into the store on attach; hydration is the only path
  // that carries it, and nothing else exercises it against a door-written file.
  const hydrated = await automationService.hydrateAutomationMode({ statePath, mode: 'manual' })
  assert.equal(hydrated.ok, true)
  assert.equal(
    hydrated.ok ? hydrated.record?.cliPermissionPreset : null,
    'auto',
    'a workspace attaching afterwards hydrates the preset the door wrote',
  )
  assert.equal(
    hydrated.ok ? hydrated.record?.desiredMode : null,
    'run_agents',
    'and the mode with it, rather than the seed it offered',
  )
  console.log('ok - the CLI permission preset lands in the same record and survives into a later attach')

  // ── 3. No engine mutation is ever routed through the `''` sentinel ────────
  for (const write of [...modeWrites, ...presetWrites]) {
    assert.notEqual(write.workspaceId, '', 'no engine write carries the empty workspace-id sentinel')
    assert.equal(write.statePath, statePath, 'every engine write is keyed by the run’s state path')
  }
  console.log('ok - every run-configuration write is keyed by statePath, never by a workspace id')

  // ── 4. Terminal-bound actions are unavailable, not inert ──────────────────
  const openAgentsTab = async (): Promise<void> => {
    const tab = dom.window.document.getElementById('sprintengine-view-tab-roster')
    assert.ok(tab, 'the board carries the Agents tab')
    await act(async () => {
      ;(tab as HTMLElement).click()
    })
    await settle()
  }
  await act(async () => {
    dom.window.document.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
  })
  await settle(3)
  await openAgentsTab()

  const spawn = ([...container.querySelectorAll('button')] as HTMLButtonElement[]).find((candidate) =>
    candidate.getAttribute('aria-label')?.startsWith('Spawn '),
  )
  assert.ok(spawn, 'the roster row still carries its Spawn action')
  assert.equal(spawn.disabled, true, 'spawning a terminal is unavailable with the workspace closed')
  assert.match(
    spawn.getAttribute('aria-label') ?? '',
    /workspace is closed/u,
    'and it says so where it sits',
  )
  assert.equal(
    container.querySelector('button[aria-label$=" actions"]'),
    null,
    'opening the agent’s tab is not offered either — the row menu holds nothing operable',
  )
  console.log('ok - spawn and open-tab are visibly unavailable on the door mount')

  // ── 5. Adding a role reaches the engine by statePath ──────────────────────
  const addRole = ([...container.querySelectorAll('button')] as HTMLButtonElement[]).find((candidate) =>
    candidate.textContent?.includes('Add a role'),
  )
  assert.ok(addRole, 'Add a role stays available — it writes to the run, not the workspace')
  assert.equal(addRole.disabled, false)
  await act(async () => {
    addRole.click()
  })
  const testerOption = [...dom.window.document.querySelectorAll('[role="menuitem"]')].find(
    (candidate) => candidate.textContent?.trim() === 'Tester',
  )
  assert.ok(testerOption, 'the menu lists the roles this run does not configure yet')
  await act(async () => {
    ;(testerOption as HTMLElement).click()
  })
  await waitFor('the role-enable call to reach the engine', () => enableRoleCalls.length > 0)
  await settle(6)
  assert.equal(enableRoleCalls.length, 1, 'the engine was asked exactly once')
  assert.equal(enableRoleCalls[0]?.statePath, statePath, 'by the run’s state path')
  assert.equal(enableRoleCalls[0]?.role, 'tester')
  assert.notEqual(enableRoleCalls[0]?.workspaceId, '', 'and with no empty workspace-id sentinel in the payload')
  assert.ok(
    container.querySelector('section[aria-label="Tester"]'),
    'the run re-read after the write, so the new role has its band on the board',
  )
  console.log('ok - adding a role completes through the engine channel keyed by statePath')

  // ── 6. A write that did not land claims nothing ───────────────────────────
  // The run's directory disappears underneath the open door (deleted from
  // another window, a cleaned-up worktree). The service refuses, and the door
  // must not move its control or announce a change it did not make.
  const notificationsBefore = modeNotifications().length
  const broadcastsBefore = broadcasts.length
  const modeWritesBefore = modeWrites.length
  rmSync(teamDirectory, { recursive: true, force: true })
  await openRunConfig()
  await pickAutomationMode('Run agents + approve artifacts')
  await waitFor('the refused write to be attempted', () => modeWrites.length > modeWritesBefore)
  // Absence is asserted after a settle, not a wait: there is no condition that
  // ever becomes true, so this gives the notification/broadcast every chance to
  // appear before concluding they did not.
  await settle(10)
  assert.equal(
    modeWrites.length,
    modeWritesBefore + 1,
    'the write was attempted — a refusal is the engine’s answer, not the door declining to ask',
  )
  assert.equal(modeNotifications().length, notificationsBefore, 'a refused write publishes no success notification')
  assert.equal(broadcasts.length, broadcastsBefore, 'and nothing is broadcast as a change')
  assert.equal(checkedAutomationMode(), 'Run agents', 'the control stays where it was')
  console.log('ok - a refused write moves no control and claims no success')

  await act(async () => {
    root.unmount()
  })
  console.log('all Sprints door seam tests passed')
}

main().catch((error) => {
  console.error('not ok - Sprints door seam')
  console.error(error)
  process.exit(1)
})
