import { createHash, randomUUID } from 'crypto'
import type { MobileSwarmCommandAuditEntry } from './mobile-swarm-command'
import type { MobileControlSnapshot, MobileSwarmArtifactSnapshot, MobileSwarmSnapshot, MobileSwarmTaskSnapshot } from './mobile-swarm-snapshot'

const mobileControlProtocolVersion = 1 as const

export type MobileNotificationCategory =
  | 'artifact.ready'
  | 'task.needs_input'
  | 'command.failed'
  | 'desktop.offline'
  | 'swarm.complete'

type MobileNotificationTarget =
  | { kind: 'artifact'; swarmId: string; artifactId: string }
  | { kind: 'task'; swarmId: string; taskId: string }
  | { kind: 'swarm'; swarmId: string }
  | { kind: 'command'; commandId: string; swarmId?: string }
  | { kind: 'desktop' }

export type MobileNotificationEvent = {
  protocolVersion: typeof mobileControlProtocolVersion
  eventId: string
  type: 'notification.created'
  emittedAt: string
  payload: {
    category: MobileNotificationCategory
    swarmId?: string
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

type MobileSwarmActivityPublisherOptions = {
  now?: () => Date
  getPushTargets: () => readonly MobilePushRegistrationTarget[]
  publish: (delivery: MobileNotificationDelivery) => void
}

export class MobileSwarmActivityPublisher {
  private previousSnapshot: MobileControlSnapshot | null = null
  private previousDesktopOffline = false
  private readonly now: () => Date
  private readonly getPushTargets: () => readonly MobilePushRegistrationTarget[]
  private readonly publishDelivery: (delivery: MobileNotificationDelivery) => void

  constructor(options: MobileSwarmActivityPublisherOptions) {
    this.now = options.now ?? (() => new Date())
    this.getPushTargets = options.getPushTargets
    this.publishDelivery = options.publish
  }

  publishSnapshotActivity(snapshot: MobileControlSnapshot): MobileNotificationDelivery[] {
    const previousBySwarm = new Map(
      (this.previousSnapshot?.swarms ?? []).map((swarm) => [swarm.swarmId, swarm])
    )
    const events = snapshot.swarms.flatMap((swarm) =>
      this.eventsForSwarmTransition(previousBySwarm.get(swarm.swarmId) ?? null, swarm)
    )

    this.previousSnapshot = snapshot
    return this.deliver(events)
  }

  publishCommandAudit(entry: MobileSwarmCommandAuditEntry): MobileNotificationDelivery[] {
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
          ...(entry.statePath ? { swarmId: swarmIdFromStatePath(entry.statePath) } : {}),
        },
        ...(entry.statePath ? { swarmId: swarmIdFromStatePath(entry.statePath) } : {}),
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

  private eventsForSwarmTransition(
    previous: MobileSwarmSnapshot | null,
    next: MobileSwarmSnapshot
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
      events.push(this.swarmCompleteEvent(next))
    }

    return events
  }

  private artifactReadyEvent(
    swarm: MobileSwarmSnapshot,
    artifact: MobileSwarmArtifactSnapshot
  ): MobileNotificationEvent {
    return this.notification({
      category: 'artifact.ready',
      swarmId: swarm.swarmId,
      title: 'Artifact ready for review',
      body: `${artifact.kind} ${artifact.artifactId} is ready in ${swarm.name}.`,
      severity: 'info',
      deepLink: `multicode-mobile://swarms/${encodeURIComponent(swarm.swarmId)}/artifacts/${encodeURIComponent(artifact.artifactId)}`,
      target: {
        kind: 'artifact',
        swarmId: swarm.swarmId,
        artifactId: artifact.artifactId,
      },
    })
  }

  private taskNeedsInputEvent(
    swarm: MobileSwarmSnapshot,
    task: MobileSwarmTaskSnapshot
  ): MobileNotificationEvent {
    return this.notification({
      category: 'task.needs_input',
      swarmId: swarm.swarmId,
      title: 'Task needs input',
      body: `${task.taskId} needs attention in ${swarm.name}.`,
      severity: 'warning',
      deepLink: `multicode-mobile://swarms/${encodeURIComponent(swarm.swarmId)}/tasks/${encodeURIComponent(task.taskId)}`,
      target: {
        kind: 'task',
        swarmId: swarm.swarmId,
        taskId: task.taskId,
      },
    })
  }

  private swarmCompleteEvent(swarm: MobileSwarmSnapshot): MobileNotificationEvent {
    return this.notification({
      category: 'swarm.complete',
      swarmId: swarm.swarmId,
      title: 'Swarm complete',
      body: `${swarm.name} has finished all tasks.`,
      severity: 'info',
      deepLink: `multicode-mobile://swarms/${encodeURIComponent(swarm.swarmId)}`,
      target: {
        kind: 'swarm',
        swarmId: swarm.swarmId,
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

function isComplete(swarm: MobileSwarmSnapshot): boolean {
  return swarm.tasks.length > 0 && swarm.tasks.every((task) => task.status === 'done')
}

function commandDeepLink(entry: MobileSwarmCommandAuditEntry): string {
  const swarmId = entry.statePath ? swarmIdFromStatePath(entry.statePath) : null
  if (!swarmId) return 'multicode-mobile://commands'
  return `multicode-mobile://swarms/${encodeURIComponent(swarmId)}/commands/${encodeURIComponent(entry.commandId)}`
}

function swarmIdFromStatePath(statePath: string): string {
  const normalized = statePath.replace(/\\/gu, '/')
  return normalized.split('/').at(-2) ?? 'unknown'
}
