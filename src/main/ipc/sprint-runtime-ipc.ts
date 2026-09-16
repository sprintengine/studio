import type { IpcInvokeHandler } from '../module-host/main-host'
import type {
  SprintRuntimeOp,
  SprintRuntimeRunRegistration,
  SprintRuntimeStopReasonPush,
} from '../../shared/sprintengine/runtime-bridge'
import type { SprintRunsChangedEvent } from '../../shared/sprintengine/runSummary'
import { SPRINT_ENGINE_CHANNELS } from '../../shared/sprintengine/ipc-channels'
import type { SprintRuntime } from '../sprint-runtime'

export type SprintRuntimeIpcHost = {
  registerIpc(channel: string, handler: IpcInvokeHandler): void
}

type SprintRuntimeIpcDependencies = {
  sprintRuntime: Pick<SprintRuntime, 'registerRun' | 'unregisterRun' | 'applyStopReason' | 'applyResume'>
}

type RuntimeOpEmit = (op: SprintRuntimeOp) => void
type RunsChangedEmit = (event: SprintRunsChangedEvent) => void

let runtimeOpEmit: RuntimeOpEmit | null = null
let runsChangedEmit: RunsChangedEmit | null = null

export function bindSprintRuntimeOpEmit(emit: RuntimeOpEmit | null): void {
  runtimeOpEmit = emit
}

export function bindSprintRunsChangedEmit(emit: RunsChangedEmit | null): void {
  runsChangedEmit = emit
}

export function deliverSprintRuntimeOp(op: SprintRuntimeOp): void {
  runtimeOpEmit?.(op)
}

export function deliverSprintRunsChanged(event: SprintRunsChangedEvent): void {
  runsChangedEmit?.(event)
}

export function registerSprintRuntimeIpc(
  host: SprintRuntimeIpcHost,
  deps: SprintRuntimeIpcDependencies,
): void {
  host.registerIpc(SPRINT_ENGINE_CHANNELS.runtimeRegisterRun, (_event, payload: unknown) => {
    deps.sprintRuntime.registerRun(payload as SprintRuntimeRunRegistration)
    return { ok: true as const }
  })

  host.registerIpc(SPRINT_ENGINE_CHANNELS.runtimeUnregisterRun, (_event, payload: unknown) => {
    deps.sprintRuntime.unregisterRun((payload as { statePath: string }).statePath)
    return { ok: true as const }
  })

  host.registerIpc(SPRINT_ENGINE_CHANNELS.runtimeStopReason, (_event, payload: unknown) => {
    deps.sprintRuntime.applyStopReason(payload as SprintRuntimeStopReasonPush)
    return { ok: true as const }
  })

  // Same-mode recovery (the board's Resume control): re-enter `running`
  // without a mode change and wake the scheduler.
  host.registerIpc(SPRINT_ENGINE_CHANNELS.runtimeResume, (_event, payload: unknown) => {
    deps.sprintRuntime.applyResume((payload as { statePath: string }).statePath)
    return { ok: true as const }
  })
}
