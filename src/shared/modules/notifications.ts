// Module notifications — the shared payload contract for the main-process
// module host's notification buffer.
//
// A notification is a small, typed, status payload emitted by a capability
// module through its scoped host (`host.notify(...)`). The source module id is
// stamped by the host from its own scope — it is never accepted from the
// caller, so one module cannot impersonate another. The kernel buffers the
// recent ones for diagnostics; there is no renderer channel for them today.

export type ModuleNotificationSeverity = 'info' | 'warning' | 'error'

const SEVERITIES: readonly ModuleNotificationSeverity[] = ['info', 'warning', 'error']

export type ModuleNotification = {
  /** Stamped by the host kernel from the emitting module's scope. */
  sourceModuleId: string
  severity: ModuleNotificationSeverity
  title: string
  body?: string
  /** Epoch ms at emission, assigned by the kernel. */
  emittedAt: number
}

/** What a module passes to `host.notify(...)`; identity and time are stamped by the kernel. */
export type ModuleNotifyInput = {
  severity: ModuleNotificationSeverity
  title: string
  body?: string
}

const MAX_TITLE_LENGTH = 200
const MAX_BODY_LENGTH = 2000

export type ModuleNotifyValidation =
  | { ok: true; severity: ModuleNotificationSeverity; title: string; body?: string }
  | { ok: false; message: string }

// Boundary validation for notify payloads. Module code (including third-party
// entry.main code) calls notify directly, so the input is untrusted.
export function validateModuleNotifyInput(input: unknown): ModuleNotifyValidation {
  if (!input || typeof input !== 'object') {
    return { ok: false, message: 'notify(...) requires a payload object.' }
  }
  const { severity, title, body } = input as Record<string, unknown>
  if (typeof severity !== 'string' || !SEVERITIES.includes(severity as ModuleNotificationSeverity)) {
    return { ok: false, message: 'notify(...) severity must be "info", "warning", or "error".' }
  }
  if (typeof title !== 'string' || title.trim().length === 0) {
    return { ok: false, message: 'notify(...) requires a non-empty title.' }
  }
  if (body !== undefined && typeof body !== 'string') {
    return { ok: false, message: 'notify(...) body must be a string when provided.' }
  }
  const trimmedBody = body?.trim()
  return {
    ok: true,
    severity: severity as ModuleNotificationSeverity,
    title: title.trim().slice(0, MAX_TITLE_LENGTH),
    body: trimmedBody ? trimmedBody.slice(0, MAX_BODY_LENGTH) : undefined,
  }
}

// Notification text shown for a module failure must not leak install locations
// (mirrors the launch-snapshot sanitizer in third-party-main-loader.ts).
export function sanitizeNotificationText(text: string, fallback: string): string {
  if (/(^|[\s'"])(?:\/[\w.-][^\s'"]*|[A-Za-z]:\\[^\s'"]+)/.test(text)) return fallback
  return text
}
