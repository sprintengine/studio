// A scheduled agent: a prompt and a schedule. When the schedule comes round, a
// new chat starts in the project with that prompt as its first message — the
// same chat New chat would start, in a workspace of its own, on the machine
// and with the model, permissions, skills, MCP servers and worktree picked when
// it was scheduled. Nothing carries from one run to the next, and nothing about
// a run is kept here but whether the last one started: each run's chat carries
// this record's id (`Workspace.scheduledAgentId`) instead, so the chats are
// where the runs are listed from. A run never makes, removes or fires a
// scheduled agent (the MCP tools refuse a run's chat), so the schedule a person
// set up is the one long-lived thing, and its runs come and go under it.
//
// Scheduled agents live in the app's own data on this computer, never in the
// project, so a commit someone else pushes can never schedule anything here.
//
// This module is the pure half both processes share: the record, its draft,
// validation, and the words and times every surface reads off the schedule.

import type { CliPermissionPreset } from './cli-permission-preset'
import { parseCliPermissionPreset } from './cli-permission-preset'
import { describeCronSchedule, nextCronRun, nextCronRuns, parseCronSchedule } from './cron'
import { isWslHostId, type ExecutionHostId } from './execution-host'
import { isRecord } from './records'

export type ScheduledAgentSchedule = {
  /** Five-field cron; several expressions separated by `;`. */
  cron: string
  /** The IANA zone the cron's wall-clock is read in: the machine it runs on. */
  timezone: string
}

/** A skill or an installed MCP server, by id, with the name its chip shows. */
export type ScheduledAgentAttachment = { id: string; name: string }

export type ScheduledAgentLastRun =
  { at: number; ok: true; workspaceId: string } | { at: number; ok: false; message: string }

export type ScheduledAgent = {
  id: string
  /** The first message each run's chat is sent. Its first line is the scheduled agent's title. */
  prompt: string
  schedule: ScheduledAgentSchedule
  /** The project each run starts in. */
  folderPath: string
  /** The machine on this computer each run starts on; null is this machine. */
  hostId: ExecutionHostId | null
  cli: string
  cliModel: string | null
  /** Absent, the preset chosen for that CLI at run time. */
  permissionPreset: CliPermissionPreset | null
  skills: ScheduledAgentAttachment[]
  mcpServers: ScheduledAgentAttachment[]
  /** A fresh worktree per run, named from this; null runs in the project's checkout. */
  worktree: { name: string } | null
  /** The extension that created it, when one did. */
  ownerModuleId: string | null
  createdAt: number
  updatedAt: number
  lastRun: ScheduledAgentLastRun | null
  /** When a failed last run was last looked at; the card says "Failed" until then. */
  lastFailureSeenAt: number | null
}

/** What a person (or an extension, or an agent) writes: everything but the bookkeeping. */
export type ScheduledAgentDraft = Pick<
  ScheduledAgent,
  | 'prompt'
  | 'schedule'
  | 'folderPath'
  | 'hostId'
  | 'cli'
  | 'cliModel'
  | 'permissionPreset'
  | 'skills'
  | 'mcpServers'
  | 'worktree'
>

/** A scheduled agent as the renderer lists it: the record plus when it runs next. */
export type ScheduledAgentView = ScheduledAgent & { nextRunAt: number | null }

export type ScheduledAgentWriteResult = { ok: true; agent: ScheduledAgentView } | { ok: false; message: string }

export const SCHEDULED_AGENTS_CHANGED_CHANNEL = 'scheduled-agents:changed'

export const SCHEDULED_AGENTS_IPC = {
  list: 'scheduled-agents:list',
  create: 'scheduled-agents:create',
  update: 'scheduled-agents:update',
  remove: 'scheduled-agents:remove',
  runNow: 'scheduled-agents:run-now',
  markSeen: 'scheduled-agents:mark-seen',
} as const

/** The schedule a new scheduled agent starts on before anyone changes it: weekdays at 9 AM. */
export const DEFAULT_SCHEDULED_AGENT_CRON = '0 9 * * 1-5'

const MAX_TITLE_LENGTH = 80

/** The sidebar's name for a scheduled agent: its prompt's first line. */
export function scheduledAgentTitle(prompt: string): string {
  const firstLine =
    prompt
      .split(/\r?\n/u)
      .map((line) => line.trim())
      .find((line) => line.length > 0) ?? ''
  if (!firstLine) return 'Scheduled agent'
  return firstLine.length > MAX_TITLE_LENGTH ? `${firstLine.slice(0, MAX_TITLE_LENGTH - 1).trimEnd()}…` : firstLine
}

/** The schedule in words, or null when the cron does not parse. */
export function scheduledAgentScheduleWords(schedule: Pick<ScheduledAgentSchedule, 'cron'>): string | null {
  const parsed = parseCronSchedule(schedule.cron)
  return parsed.ok ? describeCronSchedule(parsed.schedule) : null
}

export function nextScheduledAgentRun(schedule: ScheduledAgentSchedule, after: number): number | null {
  const parsed = parseCronSchedule(schedule.cron)
  if (!parsed.ok) return null
  try {
    return nextCronRun(parsed.schedule, schedule.timezone, after)
  } catch {
    return null
  }
}

export function nextScheduledAgentRuns(schedule: ScheduledAgentSchedule, after: number, count: number): number[] {
  const parsed = parseCronSchedule(schedule.cron)
  if (!parsed.ok) return []
  try {
    return nextCronRuns(parsed.schedule, schedule.timezone, after, count)
  } catch {
    return []
  }
}

export function isValidTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone })
    return true
  } catch {
    return false
  }
}

export type ScheduledAgentDraftValidation = { ok: true; draft: ScheduledAgentDraft } | { ok: false; message: string }

/**
 * A draft from any door — the New chat panel, an extension, an agent's MCP
 * call — held to one bar. A schedule that never runs (the 30th of February) is
 * refused here rather than saved to sit silent.
 */
export function validateScheduledAgentDraft(input: unknown, now: number): ScheduledAgentDraftValidation {
  if (!isRecord(input)) return { ok: false, message: 'A scheduled agent must be an object.' }
  const prompt = typeof input.prompt === 'string' ? input.prompt.trim() : ''
  if (!prompt) return { ok: false, message: 'A scheduled agent needs a prompt.' }
  const folderPath = typeof input.folderPath === 'string' ? input.folderPath.trim() : ''
  if (!folderPath) return { ok: false, message: 'A scheduled agent needs a project folder to run in.' }
  const cli = typeof input.cli === 'string' ? input.cli.trim() : ''
  if (!cli) return { ok: false, message: 'A scheduled agent needs an agent CLI to run.' }

  const schedule = isRecord(input.schedule) ? input.schedule : null
  const cron = typeof schedule?.cron === 'string' ? schedule.cron.trim() : ''
  const timezone = typeof schedule?.timezone === 'string' ? schedule.timezone.trim() : ''
  const parsed = parseCronSchedule(cron)
  if (!parsed.ok) return { ok: false, message: parsed.error }
  if (!timezone || !isValidTimeZone(timezone)) {
    return { ok: false, message: `"${timezone}" is not a timezone this computer knows.` }
  }
  if (nextCronRun(parsed.schedule, timezone, now) === null) {
    return { ok: false, message: 'That schedule never comes round — no calendar has that day.' }
  }

  const hostId = input.hostId === null || input.hostId === undefined ? null : input.hostId
  if (hostId !== null && !(typeof hostId === 'string' && isWslHostId(hostId))) {
    return { ok: false, message: 'A scheduled agent runs on this machine or one of its WSL distributions.' }
  }
  const permissionPreset =
    input.permissionPreset === null || input.permissionPreset === undefined
      ? null
      : parseCliPermissionPreset(input.permissionPreset)
  if (input.permissionPreset !== null && input.permissionPreset !== undefined && permissionPreset === null) {
    return { ok: false, message: `"${String(input.permissionPreset)}" is not a permission preset.` }
  }
  const worktreeName =
    isRecord(input.worktree) && typeof input.worktree.name === 'string' ? input.worktree.name.trim() : null

  return {
    ok: true,
    draft: {
      prompt,
      schedule: { cron, timezone },
      folderPath,
      hostId: hostId as ExecutionHostId | null,
      cli,
      cliModel: typeof input.cliModel === 'string' && input.cliModel.trim() ? input.cliModel.trim() : null,
      permissionPreset,
      skills: attachments(input.skills),
      mcpServers: attachments(input.mcpServers),
      worktree: isRecord(input.worktree) ? { name: worktreeName ?? '' } : null,
    },
  }
}

function attachments(input: unknown): ScheduledAgentAttachment[] {
  if (!Array.isArray(input)) return []
  const seen = new Set<string>()
  const out: ScheduledAgentAttachment[] = []
  for (const entry of input) {
    if (!isRecord(entry) || typeof entry.id !== 'string' || !entry.id.trim()) continue
    const id = entry.id.trim()
    if (seen.has(id)) continue
    seen.add(id)
    out.push({ id, name: typeof entry.name === 'string' && entry.name.trim() ? entry.name.trim() : id })
  }
  return out
}
