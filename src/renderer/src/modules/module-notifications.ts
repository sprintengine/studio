import type { ModuleNotificationDelivery } from '../../../shared/modules/notifications'
import type { DiagnosticLevel, DiagnosticLogEntry } from '../types/workspace'

// A capability module's `MainHost.notify`, filed into this window's bell
// (shared/modules/notifications.ts has the delivery contract). Pure apart from
// the ports it is handed, so the mapping and the once-only filing are testable
// without a store or a preload.
//
// Two ways a row reaches a window: live, on the kernel's push channel, and from
// the kernel's recent backlog, read once as the window boots — a module's
// launch failure or an `onStartup` notify is sent before any window listens.
// The delivery id makes the second a no-op for anything the first already
// filed (and for anything the person cleared since).

const LEVEL: Readonly<Record<ModuleNotificationDelivery['severity'], DiagnosticLevel>> = {
  info: 'info',
  warning: 'warning',
  error: 'error',
}

/**
 * One delivery as a bell row. Identity comes from the kernel's stamp, never
 * from the module; a `target` files the row under its door's Extensions drawer
 * row, so the door's count carries it and opening the door reads it.
 */
export function moduleNotificationEntry(notification: ModuleNotificationDelivery): DiagnosticLogEntry {
  const target = notification.target
  return {
    id: `module:${notification.id}`,
    timestamp: new Date(notification.emittedAt).toISOString(),
    level: LEVEL[notification.severity] ?? 'info',
    source: 'module',
    title: notification.title,
    message: notification.body ?? '',
    sourceModule: { id: notification.sourceModuleId, name: notification.sourceModuleName },
    ...(target
      ? {
          surfaceTarget: { surfaceId: target.surfaceId, ...(target.viewId ? { viewId: target.viewId } : {}) },
          extensionsRow: target.surfaceId,
        }
      : {}),
  }
}

export type ModuleNotificationIngestPorts = {
  /** The live push channel; returns its unsubscriber. */
  subscribe(cb: (notification: ModuleNotificationDelivery) => void): () => void
  /** The kernel's recent deliveries, oldest first. Optional: a client without it hears live rows only. */
  listRecent?: () => Promise<ModuleNotificationDelivery[]>
  /** File one row once; false when its delivery id was filed before. */
  file(deliveryId: string, entry: DiagnosticLogEntry): boolean
}

function isDelivery(value: unknown): value is ModuleNotificationDelivery {
  if (!value || typeof value !== 'object') return false
  const candidate = value as Partial<ModuleNotificationDelivery>
  return (
    typeof candidate.id === 'string' &&
    typeof candidate.sourceModuleId === 'string' &&
    typeof candidate.sourceModuleName === 'string' &&
    typeof candidate.title === 'string' &&
    typeof candidate.emittedAt === 'number' &&
    (candidate.severity === 'info' || candidate.severity === 'warning' || candidate.severity === 'error')
  )
}

/** Start filing this window's module notifications. Returns the stopper. */
export function startModuleNotificationIngest(ports: ModuleNotificationIngestPorts): () => void {
  let stopped = false
  const file = (notification: unknown): void => {
    if (stopped || !isDelivery(notification)) return
    ports.file(notification.id, moduleNotificationEntry(notification))
  }
  const unsubscribe = ports.subscribe(file)
  if (ports.listRecent) {
    ports
      .listRecent()
      .then((recent) => {
        if (!Array.isArray(recent)) return
        for (const notification of recent) file(notification)
      })
      .catch(() => {
        // A client that cannot read the backlog (a web tab, a server that is
        // restarting) still hears every row sent from now on.
      })
  }
  return () => {
    stopped = true
    unsubscribe()
  }
}
