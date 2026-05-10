import { createHash, randomUUID } from 'crypto'
import type { MobileSprintEngineCommandAuditEntry } from './command'
import type { MobileControlSnapshot, MobileSprintEngineArtifactSnapshot, MobileSprintEngineSnapshot, MobileSprintEngineTaskSnapshot } from './snapshot'

const mobileControlProtocolVersion = 1 as const

export type MobileNotificationCategory =
  | 'artifact.ready'
  | 'task.needs_input'
  | 'command.failed'
  | 'desktop.offline'
  | 'sprintengine.complete'

type MobileNotificationTarget =
  | { kind: 'artifact'; sprintEngineId: string; artifactId: string }
  | { kind: 'task'; sprintEngineId: string; taskId: string }
  | { kind: 'sprintengine'; sprintEngineId: string }
  | { kind: 'command'; commandId: string; sprintEngineId?: string }
  | { kind: 'desktop' }

export type MobileNotificationEvent = {
  protocolVersion: typeof mobileControlProtocolVersion
  eventId: string
  type: 'notification.created'
  emittedAt: string
  payload: {
    category: MobileNotificationCategory
    sprintEngineId?: string
    title: string
    body: string
    severity: 'info' | 'warning' | 'error'
    deepLink: string
    target: MobileNotificationTarget
  }
}

export type MobileNotificationDelivery = {
  deviceId: string
  registrationId: string
  event: MobileNotificationEvent
}

export type MobilePushRegistrationTarget = {
  deviceId: string
  registrationId: string
  revokedAt?: string
}

type MobileSprintEngineActivityPublisherOptions = {
  now?: () => Date
  getPushTargets: () => readonly MobilePushRegistrationTarget[]
  publish: (delivery: MobileNotificationDelivery) => void
}

export class MobileSprintEngineActivityPublisher {
  private previousSnapshot: MobileControlSnapshot | null = null
  private previousDesktopOffline = false
  private readonly now: () => Date
  private readonly getPushTargets: () => readonly MobilePushRegistrationTarget[]
  private readonly publishDelivery: (delivery: MobileNotificationDelivery) => void

  constructor(options: MobileSprintEngineActivityPublisherOptions) {
    this.now = options.now ?? (() => new Date())
    this.getPushTargets = options.getPushTargets
    this.publishDelivery = options.publish
  }

  publishSnapshotActivity(snapshot: MobileControlSnapshot): MobileNotificationDelivery[] {
    const previousBySprintEngine = new Map(
      (this.previousSnapshot?.sprintEngines ?? []).map((sprintengine) => [sprintengine.sprintEngineId, sprintengine])
    )
    const events = snapshot.sprintEngines.flatMap((sprintengine) =>
      this.eventsForSprintEngineTransition(previousBySprintEngine.get(sprintengine.sprintEngineId) ?? null, sprintengine)
    )

    this.previousSnapshot = snapshot
    return this.deliver(events)
  }

  publishCommandAudit(entry: MobileSprintEngineCommandAuditEntry): MobileNotificationDelivery[] {
    if (entry.status !== 'failed') return []

    return this.deliver([
      this.notification({
        category: 'command.failed',
        title: 'Mobile command failed',
        body: `${entry.commandType} could not be completed.`,
        severity: 'error',
        deepLink: commandDeepLink(entry),
        target: {
          kind: 'command',
          commandId: entry.commandId,
          ...(entry.statePath ? { sprintEngineId: sprintEngineIdFromStatePath(entry.statePath) } : {}),
        },
        ...(entry.statePath ? { sprintEngineId: sprintEngineIdFromStatePath(entry.statePath) } : {}),
      }),
    ])
  }

  publishDesktopPresence(online: boolean): MobileNotificationDelivery[] {
    const offline = !online
    if (!offline || this.previousDesktopOffline) {
      this.previousDesktopOffline = offline
      return []
    }

    this.previousDesktopOffline = true
    return this.deliver([
      this.notification({
        category: 'desktop.offline',
        title: 'Desktop is offline',
        body: 'Mobile commands will wait until Multicode Desktop reconnects.',
        severity: 'warning',
        deepLink: 'multicode-mobile://desktop',
        target: { kind: 'desktop' },
      }),
    ])
  }

  private eventsForSprintEngineTransition(
    previous: MobileSprintEngineSnapshot | null,
    next: MobileSprintEngineSnapshot
  ): MobileNotificationEvent[] {
    const previousTasks = new Map((previous?.tasks ?? []).map((task) => [task.taskId, task]))
    const previousArtifacts = new Map((previous?.artifacts ?? []).map((artifact) => [artifact.artifactId, artifact]))
    const events: MobileNotificationEvent[] = []

    for (const artifact of next.artifacts) {
      const previousArtifact = previousArtifacts.get(artifact.artifactId)
      if (artifact.status === 'ready_for_review' && previousArtifact?.status !== 'ready_for_review') {
        events.push(this.artifactReadyEvent(next, artifact))
      }
    }

    for (const task of next.tasks) {
      const previousTask = previousTasks.get(task.taskId)
      if (task.status === 'needs_input' && previousTask?.status !== 'needs_input') {
        events.push(this.taskNeedsInputEvent(next, task))
      }
    }

    if (isComplete(next) && (!previous || !isComplete(previous))) {
      events.push(this.sprintEngineCompleteEvent(next))
    }

    return events
  }

  private artifactReadyEvent(
    sprintengine: MobileSprintEngineSnapshot,
    artifact: MobileSprintEngineArtifactSnapshot
  ): MobileNotificationEvent {
    return this.notification({
      category: 'artifact.ready',
      sprintEngineId: sprintengine.sprintEngineId,
      title: 'Artifact ready for review',
      body: `${artifact.kind} ${artifact.artifactId} is ready in ${sprintengine.name}.`,
      severity: 'info',
      deepLink: `multicode-mobile://sprintengines/${encodeURIComponent(sprintengine.sprintEngineId)}/artifacts/${encodeURIComponent(artifact.artifactId)}`,
      target: {
        kind: 'artifact',
        sprintEngineId: sprintengine.sprintEngineId,
        artifactId: artifact.artifactId,
      },
    })
  }

  private taskNeedsInputEvent(
    sprintengine: MobileSprintEngineSnapshot,
    task: MobileSprintEngineTaskSnapshot
  ): MobileNotificationEvent {
    return this.notification({
      category: 'task.needs_input',
      sprintEngineId: sprintengine.sprintEngineId,
      title: 'Task needs input',
      body: `${task.taskId} needs attention in ${sprintengine.name}.`,
      severity: 'warning',
      deepLink: `multicode-mobile://sprintengines/${encodeURIComponent(sprintengine.sprintEngineId)}/tasks/${encodeURIComponent(task.taskId)}`,
      target: {
        kind: 'task',
        sprintEngineId: sprintengine.sprintEngineId,
        taskId: task.taskId,
      },
    })
  }

  private sprintEngineCompleteEvent(sprintengine: MobileSprintEngineSnapshot): MobileNotificationEvent {
    return this.notification({
      category: 'sprintengine.complete',
      sprintEngineId: sprintengine.sprintEngineId,
      title: 'Sprint Engine complete',
      body: `${sprintengine.name} has finished all tasks.`,
      severity: 'info',
      deepLink: `multicode-mobile://sprintengines/${encodeURIComponent(sprintengine.sprintEngineId)}`,
      target: {
        kind: 'sprintengine',
        sprintEngineId: sprintengine.sprintEngineId,
      },
    })
  }

  private notification(input: MobileNotificationEvent['payload']): MobileNotificationEvent {
    return {
      protocolVersion: mobileControlProtocolVersion,
      eventId: `notif_${randomUUID()}`,
      type: 'notification.created',
      emittedAt: this.now().toISOString(),
      payload: input,
    }
  }

  private deliver(events: MobileNotificationEvent[]): MobileNotificationDelivery[] {
    if (events.length === 0) return []

    const targets = this.getPushTargets().filter((target) => !target.revokedAt)
    const deliveries = events.flatMap((event) =>
      targets.map((target) => ({
        deviceId: target.deviceId,
        registrationId: target.registrationId,
        event,
      }))
    )

    for (const delivery of deliveries) {
      this.publishDelivery(delivery)
    }

    return deliveries
  }
}

export function pushTokenHash(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

function isComplete(sprintengine: MobileSprintEngineSnapshot): boolean {
  return sprintengine.tasks.length > 0 && sprintengine.tasks.every((task) => task.status === 'done')
}

function commandDeepLink(entry: MobileSprintEngineCommandAuditEntry): string {
  const sprintEngineId = entry.statePath ? sprintEngineIdFromStatePath(entry.statePath) : null
  if (!sprintEngineId) return 'multicode-mobile://commands'
  return `multicode-mobile://sprintengines/${encodeURIComponent(sprintEngineId)}/commands/${encodeURIComponent(entry.commandId)}`
}

function sprintEngineIdFromStatePath(statePath: string): string {
  const normalized = statePath.replace(/\\/gu, '/')
  return normalized.split('/').at(-2) ?? 'unknown'
}
