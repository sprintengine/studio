import type {
  SwitchboardAddCommentInput,
  SwitchboardCancelTaskInput,
  SwitchboardClaimTaskInput,
  SwitchboardClaimTaskResult,
  SwitchboardCreateTaskInput,
  SwitchboardExecutionLogsInput,
  SwitchboardExecutionLogsResult,
  SwitchboardExecutionStatusInput,
  SwitchboardExecutionStatusResult,
  SwitchboardImportItem,
  SwitchboardImportItemResult,
  SwitchboardInitApiResult,
  SwitchboardMoveTaskInput,
  SwitchboardMutationResult,
  SwitchboardPromoteInboxTaskInput,
  SwitchboardPublishTaskInput,
  SwitchboardReadResult,
  SwitchboardRecoverLockInput,
  SwitchboardRecoverLockResult,
  SwitchboardRequeueTaskInput,
  SwitchboardTaskRecord,
  SwitchboardUpdateTaskInput,
  WatchtowerRunListResult,
  WatchtowerRunResult,
  WatchtowerStartReviewInput,
  WatchtowerStartTriageInput,
} from '../shared/switchboard'
import { runSwitchboardCore, type SwitchboardCoreCommandResult, workspaceArgs } from './switchboard-core-client'
import { spawnSwitchboardAgentSession, stopSpawnedWatchtowerSessions } from './switchboard-runtime-service'
import { APP_INSTANCE_ID } from './workspace-runner-lock'

function mutationResult(result: SwitchboardCoreCommandResult, fallbackMessage: string): SwitchboardMutationResult {
  if (!result.ok) return { ok: false, message: result.message || fallbackMessage }
  const record = result.payload.record
  if (!record || typeof record !== 'object' || Array.isArray(record)) {
    return { ok: false, message: 'Switchboard core returned a mutation without a task record.' }
  }
  return { ok: true, record: record as SwitchboardTaskRecord }
}

function claimResult(result: SwitchboardCoreCommandResult): SwitchboardClaimTaskResult {
  if (!result.ok) return { ok: false, message: result.message || 'Unable to claim Switchboard task.' }
  if (result.payload.claimed === false) {
    return { ok: false, message: typeof result.payload.message === 'string' ? result.payload.message : 'No eligible task.' }
  }
  return mutationResult(result, 'Unable to claim Switchboard task.') as SwitchboardClaimTaskResult
}

export async function initializeSwitchboard(input: { workspaceRoot: string }): Promise<SwitchboardInitApiResult> {
  const result = await runSwitchboardCore(['init', ...workspaceArgs(input.workspaceRoot)])
  if (!result.ok) return { ok: false, message: result.message || 'Unable to initialize Switchboard.' }
  return result.payload as SwitchboardInitApiResult
}

export async function readAllSwitchboardTasks(input: { workspaceRoot: string }): Promise<SwitchboardReadResult> {
  const result = await runSwitchboardCore(['read-all', ...workspaceArgs(input.workspaceRoot)])
  if (!result.ok) return { ok: false, message: result.message || 'Unable to read Switchboard tasks.' }
  return result.payload as SwitchboardReadResult
}

export async function createSwitchboardTask(input: SwitchboardCreateTaskInput): Promise<SwitchboardMutationResult> {
  const result = await runSwitchboardCore([
    'create',
    ...workspaceArgs(input.workspaceRoot),
    '--input-json',
    JSON.stringify(input),
  ])
  return mutationResult(result, 'Unable to create Switchboard task.')
}

export async function importSwitchboardItem(
  workspaceRoot: string,
  item: SwitchboardImportItem
): Promise<SwitchboardImportItemResult> {
  const result = await runSwitchboardCore([
    'import-task',
    ...workspaceArgs(workspaceRoot),
    '--input-json',
    JSON.stringify(item),
  ])
  if (!result.ok) {
    return {
      provider: item.provider,
      externalKey: item.externalKey,
      externalUrl: item.externalUrl,
      status: 'error',
      message: result.message || 'Unable to import task.',
    }
  }
  if (result.payload.created === true || result.payload.status === 'created') {
    return {
      provider: item.provider,
      externalKey: item.externalKey,
      externalUrl: item.externalUrl,
      status: 'created',
      taskId: typeof result.payload.id === 'string' ? result.payload.id : null,
    }
  }
  if (result.payload.status === 'updated') {
    return {
      provider: item.provider,
      externalKey: item.externalKey,
      externalUrl: item.externalUrl,
      status: 'updated',
      taskId: typeof result.payload.id === 'string' ? result.payload.id : null,
    }
  }
  return {
    provider: item.provider,
    externalKey: item.externalKey,
    externalUrl: item.externalUrl,
    status: 'skipped',
    message: 'Duplicate source identity.',
  }
}

export async function updateSwitchboardTask(input: SwitchboardUpdateTaskInput): Promise<SwitchboardMutationResult> {
  const result = await runSwitchboardCore([
    'update',
    ...workspaceArgs(input.workspaceRoot),
    input.id,
    '--updates-json',
    JSON.stringify(input.updates),
  ])
  return mutationResult(result, 'Unable to update Switchboard task.')
}

export async function moveSwitchboardTask(input: SwitchboardMoveTaskInput): Promise<SwitchboardMutationResult> {
  const result = await runSwitchboardCore(['move', ...workspaceArgs(input.workspaceRoot), input.id, '--to', input.to])
  return mutationResult(result, 'Unable to move Switchboard task.')
}

export async function promoteSwitchboardInboxTask(input: SwitchboardPromoteInboxTaskInput): Promise<SwitchboardMutationResult> {
  const result = await runSwitchboardCore(['promote', ...workspaceArgs(input.workspaceRoot), input.id])
  return mutationResult(result, 'Unable to promote Switchboard inbox task.')
}

export async function cancelSwitchboardTask(input: SwitchboardCancelTaskInput): Promise<SwitchboardMutationResult> {
  const result = await runSwitchboardCore(['cancel', ...workspaceArgs(input.workspaceRoot), input.id])
  return mutationResult(result, 'Unable to cancel Switchboard task.')
}

export async function addSwitchboardComment(input: SwitchboardAddCommentInput): Promise<SwitchboardMutationResult> {
  const args = ['comment', ...workspaceArgs(input.workspaceRoot), input.id, '--body', input.body]
  if (input.author?.name) args.push('--author', input.author.name)
  if (input.author?.type) args.push('--author-type', input.author.type)
  if (input.author?.id) args.push('--author-id', input.author.id)
  if (input.kind) args.push('--kind', input.kind)
  if (input.confidencePct != null) args.push('--confidence-pct', String(input.confidencePct))
  const result = await runSwitchboardCore(args)
  return mutationResult(result, 'Unable to add Switchboard comment.')
}

export async function claimSwitchboardTask(input: SwitchboardClaimTaskInput): Promise<SwitchboardClaimTaskResult> {
  const result = await runSwitchboardCore([
    'claim',
    ...workspaceArgs(input.workspaceRoot),
    '--from',
    input.from,
    '--agent',
    input.owner,
  ])
  return claimResult(result)
}

export async function publishSwitchboardTask(input: SwitchboardPublishTaskInput): Promise<SwitchboardMutationResult> {
  const to = input.to ?? 'testing'
  const args = ['publish', ...workspaceArgs(input.workspaceRoot), input.id, '--to', to]
  if (input.summary?.trim()) args.push('--summary', input.summary.trim())
  for (const artifact of input.artifacts ?? []) {
    if (artifact.trim()) args.push('--artifact', artifact.trim())
  }
  for (const command of input.commandsRun ?? []) {
    if (command.trim()) args.push('--command', command.trim())
  }
  for (const touchedFile of input.touchedFiles ?? []) {
    if (touchedFile.trim()) args.push('--touched-file', touchedFile.trim())
  }
  if (input.comment?.trim()) args.push('--comment', input.comment.trim())
  const result = await runSwitchboardCore(args)
  return mutationResult(result, 'Unable to publish Switchboard task.')
}

export async function recoverSwitchboardLock(input: SwitchboardRecoverLockInput): Promise<SwitchboardRecoverLockResult> {
  const result = await runSwitchboardCore([
    'recover-lock',
    ...workspaceArgs(input.workspaceRoot),
    '--status',
    input.status,
  ])
  if (!result.ok) return { ok: false, message: result.message || 'Unable to recover Switchboard lock.' }
  return result.payload as SwitchboardRecoverLockResult
}

export async function requeueSwitchboardTask(input: SwitchboardRequeueTaskInput): Promise<SwitchboardMutationResult> {
  const args = ['requeue', ...workspaceArgs(input.workspaceRoot), input.id]
  if (input.reason?.trim()) args.push('--reason', input.reason.trim())
  const result = await runSwitchboardCore(args)
  return mutationResult(result, 'Unable to requeue Switchboard task.')
}

export async function getSwitchboardExecutionStatus(
  input: SwitchboardExecutionStatusInput,
): Promise<SwitchboardExecutionStatusResult> {
  if (!input.workspaceRoot?.trim()) return { ok: false, message: 'workspaceRoot is required.' }
  if (!input.executionId?.trim()) return { ok: false, message: 'executionId is required.' }
  const fallback = await runSwitchboardCore([
    'execution',
    'status',
    ...workspaceArgs(input.workspaceRoot),
    input.executionId,
  ])
  if (!fallback.ok) {
    return { ok: false, message: fallback.message || 'Unable to read Switchboard execution status.' }
  }
  return fallback.payload as SwitchboardExecutionStatusResult
}

export async function getSwitchboardExecutionLogs(
  input: SwitchboardExecutionLogsInput,
): Promise<SwitchboardExecutionLogsResult> {
  if (!input.workspaceRoot?.trim()) return { ok: false, message: 'workspaceRoot is required.' }
  if (!input.executionId?.trim()) return { ok: false, message: 'executionId is required.' }
  if (input.stream !== 'stdout' && input.stream !== 'stderr') {
    return { ok: false, message: 'stream must be stdout or stderr.' }
  }
  const tail = Number.isFinite(input.tail) ? Math.max(1, Math.min(5000, Math.floor(input.tail as number))) : 200
  const fallback = await runSwitchboardCore([
    'execution',
    'logs',
    ...workspaceArgs(input.workspaceRoot),
    input.executionId,
    '--stream',
    input.stream,
    '--tail',
    String(tail),
  ])
  if (!fallback.ok) {
    return { ok: false, message: fallback.message || 'Unable to read Switchboard execution logs.' }
  }
  return fallback.payload as SwitchboardExecutionLogsResult
}

export async function startWatchtowerReview(input: WatchtowerStartReviewInput): Promise<WatchtowerRunResult> {
  const args = [
    'watchtower',
    'start-review',
    ...workspaceArgs(input.workspaceRoot),
    '--preset',
    input.preset,
    '--app-instance-id',
    APP_INSTANCE_ID,
  ]
  if (input.workspaceId) args.push('--workspace-id', input.workspaceId)
  const result = await runSwitchboardCore(args)
  if (!result.ok) return { ok: false, message: result.message || 'Unable to start Watchtower review.' }
  const payload = result.payload as WatchtowerRunResult
  if (payload.ok) {
    const descriptors = payload.descriptors ?? []
    for (const descriptor of payload.descriptors ?? []) {
      const spawned = await spawnSwitchboardAgentSession({
        workspaceId: input.workspaceId,
        workspaceRoot: input.workspaceRoot,
        descriptor,
        mcpSettings: input.mcpSettings,
      })
      if (spawned && !spawned.ok) {
        await stopSpawnedWatchtowerSessions(
          input.workspaceRoot,
          descriptors,
          spawned.message || 'Watchtower review startup failed.',
        )
        return { ok: false, message: spawned.message || 'Unable to start Watchtower review terminal.' }
      }
    }
  }
  return payload
}

export async function startWatchtowerTriage(input: WatchtowerStartTriageInput): Promise<WatchtowerRunResult> {
  const args = [
    'watchtower',
    'start-triage',
    ...workspaceArgs(input.workspaceRoot),
    '--scope',
    input.scope,
    '--app-instance-id',
    APP_INSTANCE_ID,
  ]
  if (input.workspaceId) args.push('--workspace-id', input.workspaceId)
  if (input.taskId?.trim()) args.push('--task-id', input.taskId.trim())
  const result = await runSwitchboardCore(args)
  if (!result.ok) return { ok: false, message: result.message || 'Unable to start Watchtower triage.' }
  const payload = result.payload as WatchtowerRunResult
  if (payload.ok) {
    const descriptors = payload.descriptors ?? []
    for (const descriptor of payload.descriptors ?? []) {
      const spawned = await spawnSwitchboardAgentSession({
        workspaceId: input.workspaceId,
        workspaceRoot: input.workspaceRoot,
        descriptor,
        mcpSettings: input.mcpSettings,
      })
      if (spawned && !spawned.ok) {
        await stopSpawnedWatchtowerSessions(
          input.workspaceRoot,
          descriptors,
          spawned.message || 'Watchtower triage startup failed.',
        )
        return { ok: false, message: spawned.message || 'Unable to start Watchtower triage terminal.' }
      }
    }
  }
  return payload
}

export async function getWatchtowerRun(input: { workspaceRoot: string; runId: string }): Promise<WatchtowerRunResult> {
  const result = await runSwitchboardCore(['watchtower', 'run-status', ...workspaceArgs(input.workspaceRoot), input.runId])
  if (!result.ok) return { ok: false, message: result.message || 'Unable to read Watchtower run.' }
  return result.payload as WatchtowerRunResult
}

export async function listWatchtowerRuns(workspaceRoot: string): Promise<WatchtowerRunListResult> {
  const result = await runSwitchboardCore(['watchtower', 'run-list', ...workspaceArgs(workspaceRoot)])
  if (!result.ok) return { ok: false, message: result.message || 'Unable to list Watchtower runs.' }
  return result.payload as WatchtowerRunListResult
}
