import { useCallback, useEffect, useRef, useState } from 'react'
import type { McpSettings } from '../../../shared/electron-api'
import type {
  SwitchboardExecutionProviderKind,
  SwitchboardRunnerExecution,
  SwitchboardRunnerQueue,
  SwitchboardRunnerResult,
  SwitchboardRunnerStartInput,
  SwitchboardRunnerState,
  SwitchboardTaskRunnerExecution,
} from '../../../shared/switchboard'
import {
  SWITCHBOARD_REFRESH_POLL_INTERVAL_MS,
  rememberSwitchboardRefreshValue,
  runSwitchboardRefresh,
  type SwitchboardRefreshOptions,
} from './switchboardRefreshCoordinator'

export const RUNNER_QUEUES: SwitchboardRunnerQueue[] = ['ready', 'testing', 'review']
export const RUNNER_PROVIDERS: SwitchboardExecutionProviderKind[] = ['electron-session']

export type RunnerStatusKind = 'unconfigured' | 'stopped' | 'running' | 'paused'

export type SwitchboardRunner = {
  state: SwitchboardRunnerState | null
  status: RunnerStatusKind
  error: string | null
  busy: boolean
  refresh: (options?: SwitchboardRefreshOptions) => Promise<void>
  start: (input: Omit<SwitchboardRunnerStartInput, 'workspaceRoot'>) => Promise<boolean>
  pause: () => Promise<boolean>
  resume: () => Promise<boolean>
  stop: () => Promise<boolean>
  tick: () => Promise<boolean>
  stopExecution: (executionId: string, reason?: string) => Promise<boolean>
}

const SWITCHBOARD_RUNNER_REFRESH_KEY_PREFIX = 'switchboard-runner'

function runnerRefreshKey(workspaceRoot: string): string {
  return `${SWITCHBOARD_RUNNER_REFRESH_KEY_PREFIX}:${workspaceRoot}`
}

export function useSwitchboardRunner(
  workspaceRoot: string | null | undefined,
  workspaceId?: string,
  mcpSettings?: McpSettings
): SwitchboardRunner {
  const [state, setState] = useState<SwitchboardRunnerState | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const activeRootRef = useRef<string | null>(workspaceRoot ?? null)

  const apply = useCallback((result: SwitchboardRunnerResult, expectedRoot: string | null): boolean => {
    if (activeRootRef.current !== expectedRoot) return false
    if (result.ok === false) {
      setError(result.message)
      return false
    }
    setState(result)
    setError(result.lastError ?? null)
    return true
  }, [])

  const refresh = useCallback(async (options: SwitchboardRefreshOptions = { force: true }) => {
    activeRootRef.current = workspaceRoot ?? null
    const targetRoot = workspaceRoot ?? null
    if (!targetRoot) {
      setState(null)
      setError(null)
      return
    }
    try {
      const coordinated = await runSwitchboardRefresh(
        runnerRefreshKey(targetRoot),
        () => window.api.getSwitchboardRunnerState({ workspaceRoot: targetRoot, workspaceId, mcpSettings }),
        options
      )
      const result = coordinated.value
      apply(result, targetRoot)
    } catch (caught) {
      if (activeRootRef.current !== targetRoot) return
      setError(caught instanceof Error ? caught.message : 'Failed to read runner state.')
    }
  }, [apply, mcpSettings, workspaceId, workspaceRoot])

  useEffect(() => {
    setState(null)
    setError(null)
    activeRootRef.current = workspaceRoot ?? null
    if (!workspaceRoot) return

    void refresh({ force: false })
    const handle = window.setInterval(() => {
      void refresh({ force: false })
    }, SWITCHBOARD_REFRESH_POLL_INTERVAL_MS)
    return () => window.clearInterval(handle)
  }, [refresh, workspaceRoot])

  const runAction = useCallback(
    async (invoke: (root: string) => Promise<SwitchboardRunnerResult>): Promise<boolean> => {
      const targetRoot = workspaceRoot ?? null
      if (!targetRoot) return false
      setBusy(true)
      try {
        const result = await invoke(targetRoot)
        const applied = apply(result, targetRoot)
        if (applied && result.ok !== false) rememberSwitchboardRefreshValue(runnerRefreshKey(targetRoot), result)
        return applied
      } catch (caught) {
        if (activeRootRef.current !== targetRoot) return false
        setError(caught instanceof Error ? caught.message : 'Runner action failed.')
        return false
      } finally {
        setBusy(false)
      }
    },
    [apply, workspaceRoot]
  )

  const start = useCallback(
    (input: Omit<SwitchboardRunnerStartInput, 'workspaceRoot'>) =>
      runAction((root) => window.api.startSwitchboardRunner({ workspaceRoot: root, mcpSettings, ...input })),
    [mcpSettings, runAction]
  )
  const pause = useCallback(
    () => runAction((root) => window.api.pauseSwitchboardRunner(root)),
    [runAction]
  )
  const resume = useCallback(
    () => runAction((root) => window.api.resumeSwitchboardRunner({ workspaceRoot: root, workspaceId, mcpSettings })),
    [mcpSettings, runAction, workspaceId]
  )
  const stop = useCallback(
    () => runAction((root) => window.api.stopSwitchboardRunner(root)),
    [runAction]
  )
  const tick = useCallback(
    () => runAction((root) => window.api.tickSwitchboardRunner({ workspaceRoot: root, workspaceId, mcpSettings })),
    [mcpSettings, runAction, workspaceId]
  )
  const stopExecution = useCallback(
    async (executionId: string, reason?: string): Promise<boolean> => {
      const targetRoot = workspaceRoot ?? null
      if (!targetRoot) return false
      setBusy(true)
      try {
        const result = await window.api.stopSwitchboardExecution({ workspaceRoot: targetRoot, executionId, reason })
        if (activeRootRef.current !== targetRoot) return false
        if (result.ok === false) {
          setError(result.message)
          return false
        }
        await refresh()
        return true
      } catch (caught) {
        if (activeRootRef.current !== targetRoot) return false
        setError(caught instanceof Error ? caught.message : 'Runner action failed.')
        return false
      } finally {
        setBusy(false)
      }
    },
    [refresh, workspaceRoot]
  )

  const status: RunnerStatusKind = !state
    ? 'unconfigured'
    : !state.enabled
      ? 'stopped'
      : state.paused
        ? 'paused'
        : state.running
          ? 'running'
          : 'stopped'

  return { state, status, error, busy, refresh, start, pause, resume, stop, tick, stopExecution }
}

export function runnerQueueLabel(queue: SwitchboardRunnerQueue): string {
  switch (queue) {
    case 'ready':
      return 'Ready'
    case 'testing':
      return 'Testing'
    case 'review':
      return 'Review'
  }
}

export function providerLabel(provider: SwitchboardExecutionProviderKind): string {
  switch (provider) {
    case 'electron-session':
      return 'session manager'
  }
}

export function isSwitchboardTaskExecution(execution: SwitchboardRunnerExecution): execution is SwitchboardTaskRunnerExecution {
  return (
    execution.kind === 'switchboard_task'
    && typeof execution.taskId === 'string'
    && execution.taskId.length > 0
    && (execution.claimedFrom === 'ready' || execution.claimedFrom === 'testing' || execution.claimedFrom === 'review')
    && (
      execution.claimedStatus === 'in_progress'
      || execution.claimedStatus === 'testing_in_progress'
      || execution.claimedStatus === 'review_in_progress'
    )
  )
}

export function executionSubjectLabel(execution: SwitchboardRunnerExecution): string {
  if (isSwitchboardTaskExecution(execution)) return execution.taskId.slice(0, 8)
  if (execution.watchtowerAgentId) return execution.watchtowerAgentId
  if (execution.watchtowerRunId) return execution.watchtowerRunId
  return execution.executionId.slice(0, 8)
}

export function executionRouteLabel(execution: SwitchboardRunnerExecution): string {
  if (isSwitchboardTaskExecution(execution)) {
    return `${runnerQueueLabel(execution.claimedFrom)} -> ${execution.claimedStatus.replace(/_/g, ' ')}`
  }
  if (execution.kind === 'watchtower_review') return 'Watchtower review'
  if (execution.kind === 'watchtower_triage') return 'Watchtower triage'
  return 'Tracked execution'
}
