import { useCallback, useEffect, useRef, useState } from 'react'
import type {
  SwitchboardExecutionProviderKind,
  SwitchboardRunnerQueue,
  SwitchboardRunnerResult,
  SwitchboardRunnerStartInput,
  SwitchboardRunnerState,
} from '../../../shared/switchboard'

export const RUNNER_QUEUES: SwitchboardRunnerQueue[] = ['ready', 'testing', 'review']
export const RUNNER_PROVIDERS: SwitchboardExecutionProviderKind[] = ['local-process', 'codex-app-server']

export type RunnerStatusKind = 'unconfigured' | 'stopped' | 'running' | 'paused'

export type SwitchboardRunner = {
  state: SwitchboardRunnerState | null
  status: RunnerStatusKind
  error: string | null
  busy: boolean
  refresh: () => Promise<void>
  start: (input: Omit<SwitchboardRunnerStartInput, 'workspaceRoot'>) => Promise<boolean>
  pause: () => Promise<boolean>
  resume: () => Promise<boolean>
  tick: () => Promise<boolean>
}

const POLL_INTERVAL_MS = 5_000

export function useSwitchboardRunner(workspaceRoot: string | null | undefined): SwitchboardRunner {
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

  const refresh = useCallback(async () => {
    activeRootRef.current = workspaceRoot ?? null
    const targetRoot = workspaceRoot ?? null
    if (!targetRoot) {
      setState(null)
      setError(null)
      return
    }
    try {
      const result = await window.api.getSwitchboardRunnerState(targetRoot)
      apply(result, targetRoot)
    } catch (caught) {
      if (activeRootRef.current !== targetRoot) return
      setError(caught instanceof Error ? caught.message : 'Failed to read runner state.')
    }
  }, [apply, workspaceRoot])

  useEffect(() => {
    setState(null)
    setError(null)
    activeRootRef.current = workspaceRoot ?? null
    if (!workspaceRoot) return

    void refresh()
    const handle = window.setInterval(() => {
      void refresh()
    }, POLL_INTERVAL_MS)
    return () => window.clearInterval(handle)
  }, [refresh, workspaceRoot])

  const runAction = useCallback(
    async (invoke: (root: string) => Promise<SwitchboardRunnerResult>): Promise<boolean> => {
      const targetRoot = workspaceRoot ?? null
      if (!targetRoot) return false
      setBusy(true)
      try {
        const result = await invoke(targetRoot)
        return apply(result, targetRoot)
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
      runAction((root) => window.api.startSwitchboardRunner({ workspaceRoot: root, ...input })),
    [runAction]
  )
  const pause = useCallback(
    () => runAction((root) => window.api.pauseSwitchboardRunner(root)),
    [runAction]
  )
  const resume = useCallback(
    () => runAction((root) => window.api.resumeSwitchboardRunner(root)),
    [runAction]
  )
  const tick = useCallback(
    () => runAction((root) => window.api.tickSwitchboardRunner(root)),
    [runAction]
  )

  const status: RunnerStatusKind = !state || !state.enabled
    ? 'unconfigured'
    : state.paused
      ? 'paused'
      : state.running
        ? 'running'
        : 'stopped'

  return { state, status, error, busy, refresh, start, pause, resume, tick }
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
    case 'local-process':
      return 'local process'
    case 'codex-app-server':
      return 'codex app server'
  }
}
