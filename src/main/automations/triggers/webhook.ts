import { createHmac, timingSafeEqual } from 'node:crypto'

import {
  WEBHOOK_TRIGGER_KIND,
  type AutomationTriggerPollEvent,
  type AutomationTriggerProvider,
  type WebhookTriggerConfig,
} from '../../../shared/automations/contracts'
import { isRecord } from '../../../shared/records'

// Canonical kind + config now live in contracts.ts; re-export so existing
// importers of this module (webhook-receiver, automations-ipc, tests) keep their
// import paths.
export { WEBHOOK_TRIGGER_KIND }
export type { WebhookTriggerConfig }

export const WEBHOOK_SIGNATURE_HEADER = 'x-multicode-signature'
export const WEBHOOK_DELIVERY_ID_HEADER = 'x-multicode-delivery-id'
export const WEBHOOK_EVENT_TIME_HEADER = 'x-multicode-event-time'
export const WEBHOOK_ROUTE_PREFIX = '/automations/webhooks/'

type WebhookTriggerValidationResult = { ok: true; value: WebhookTriggerConfig } | { ok: false; error: string }

const WEBHOOK_PATH_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u
const MAX_DELIVERY_ID_LENGTH = 200
const MIN_WEBHOOK_SECRET_LENGTH = 16

export function createWebhookTriggerProvider(): AutomationTriggerProvider {
  return {
    kind: WEBHOOK_TRIGGER_KIND,
    label: 'Webhook',
    glyph: 'clock',
    summary: 'On webhook',
    configSchema: {
      type: 'object',
      required: ['kind'],
      properties: {
        kind: { const: WEBHOOK_TRIGGER_KIND },
        enabled: { type: 'boolean', default: false },
        port: { type: 'integer', minimum: 0, maximum: 65535 },
        path: { type: 'string', pattern: WEBHOOK_PATH_PATTERN.source },
        secret: { type: 'string', minLength: MIN_WEBHOOK_SECRET_LENGTH },
        eventType: { type: 'string', minLength: 1 },
        label: { type: 'string', minLength: 1 },
      },
    },
    validateConfig(config) {
      const validation = validateWebhookTriggerConfig(config)
      return validation.ok ? { ok: true } : validation
    },
    subscribe(input) {
      const validation = validateWebhookTriggerConfig(input.config)
      if (!validation.ok) throw new Error(validation.error)
      return () => undefined
    },
    async poll(input) {
      const validation = validateWebhookTriggerConfig(input.config)
      if (!validation.ok) return { ok: false, blockedReason: validation.error }
      return { ok: true, events: [] }
    },
  }
}

function validateWebhookTriggerConfig(config: unknown): WebhookTriggerValidationResult {
  if (!isRecord(config)) return invalid('Webhook trigger config must be an object.')
  if (config.kind !== WEBHOOK_TRIGGER_KIND) return invalid('Webhook trigger kind must be "webhook".')

  if (config.enabled !== undefined && typeof config.enabled !== 'boolean') {
    return invalid('Webhook trigger enabled flag must be a boolean.')
  }

  const enabled = config.enabled === true
  const port = normalizeWebhookPort(config.port)
  if (!port.ok) return invalid(port.error)

  const path = normalizeWebhookPath(config.path)
  if (!path.ok) return invalid(path.error)

  const secret = normalizeSecret(config.secret)
  if (!secret.ok) return invalid(secret.error)

  const eventType = trimmedString(config.eventType)
  if (config.eventType !== undefined && !eventType) {
    return invalid('Webhook trigger eventType must be a non-empty string.')
  }

  const label = trimmedString(config.label)
  if (config.label !== undefined && !label) {
    return invalid('Webhook trigger label must be a non-empty string.')
  }

  if (enabled) {
    if (port.value === undefined) return invalid('Webhook trigger port is required when enabled is true.')
    if (!path.value) return invalid('Webhook trigger path is required when enabled is true.')
    if (!secret.value) return invalid('Webhook trigger secret is required when enabled is true.')
  }

  return {
    ok: true,
    value: {
      kind: WEBHOOK_TRIGGER_KIND,
      enabled,
      ...(port.value !== undefined ? { port: port.value } : {}),
      ...(path.value ? { path: path.value } : {}),
      ...(secret.value ? { secret: secret.value } : {}),
      ...(eventType ? { eventType } : {}),
      ...(label ? { label } : {}),
    },
  }
}

export function activeWebhookTriggerConfig(config: unknown): WebhookTriggerConfig | null {
  const validation = validateWebhookTriggerConfig(config)
  if (!validation.ok || validation.value.enabled !== true) return null
  if (validation.value.port === undefined || !validation.value.path || !validation.value.secret) return null
  return validation.value
}

export function webhookEndpointPath(path: string): string {
  return `${WEBHOOK_ROUTE_PREFIX}${path}`
}

export function createWebhookSignature(secret: string, rawBody: string | Buffer): string {
  const digest = createHmac('sha256', secret).update(rawBody).digest('hex')
  return `sha256=${digest}`
}

export function verifyWebhookSignature(input: {
  secret: string
  rawBody: string | Buffer
  signature: string | undefined
}): boolean {
  const signature = input.signature?.trim()
  if (!signature?.startsWith('sha256=')) return false
  const expected = Buffer.from(createWebhookSignature(input.secret, input.rawBody), 'utf8')
  const actual = Buffer.from(signature, 'utf8')
  if (actual.length !== expected.length) return false
  return timingSafeEqual(actual, expected)
}

export function normalizeWebhookDeliveryId(value: unknown): string | null {
  const deliveryId = typeof value === 'string' ? value.trim() : ''
  if (!deliveryId || deliveryId.length > MAX_DELIVERY_ID_LENGTH) return null
  if (/[\r\n]/u.test(deliveryId)) return null
  return deliveryId
}

export function buildWebhookTriggerEvent(input: {
  config: WebhookTriggerConfig
  deliveryId: string
  rawPayload: Record<string, unknown>
  occurredAt: string
  receivedAt: string
}): AutomationTriggerPollEvent {
  const eventType =
    typeof input.rawPayload.eventType === 'string' && input.rawPayload.eventType.trim()
      ? input.rawPayload.eventType.trim()
      : input.config.eventType
  return {
    id: [WEBHOOK_TRIGGER_KIND, input.config.path, input.deliveryId].join(':'),
    occurredAt: input.occurredAt,
    payload: {
      kind: WEBHOOK_TRIGGER_KIND,
      deliveryId: input.deliveryId,
      path: input.config.path,
      port: input.config.port,
      occurredAt: input.occurredAt,
      receivedAt: input.receivedAt,
      ...(eventType ? { eventType } : {}),
      body: input.rawPayload,
    },
  }
}

export function webhookPayloadMatchesConfig(payload: Record<string, unknown>, config: WebhookTriggerConfig): boolean {
  if (!config.eventType) return true
  return typeof payload.eventType === 'string' && payload.eventType.trim() === config.eventType
}

function normalizeWebhookPort(value: unknown): { ok: true; value?: number } | { ok: false; error: string } {
  if (value === undefined) return { ok: true }
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > 65535) {
    return { ok: false, error: 'Webhook trigger port must be an integer from 0 to 65535.' }
  }
  return { ok: true, value }
}

function normalizeWebhookPath(value: unknown): { ok: true; value?: string } | { ok: false; error: string } {
  if (value === undefined) return { ok: true }
  const path = typeof value === 'string' ? value.trim().replace(/^\/+/u, '') : ''
  if (!path || !WEBHOOK_PATH_PATTERN.test(path)) {
    return { ok: false, error: 'Webhook trigger path must be a 1-128 character URL-safe slug.' }
  }
  return { ok: true, value: path }
}

function normalizeSecret(value: unknown): { ok: true; value?: string } | { ok: false; error: string } {
  if (value === undefined) return { ok: true }
  const secret = typeof value === 'string' ? value.trim() : ''
  if (secret.length < MIN_WEBHOOK_SECRET_LENGTH) {
    return { ok: false, error: `Webhook trigger secret must be at least ${MIN_WEBHOOK_SECRET_LENGTH} characters.` }
  }
  if (/[\r\n]/u.test(secret)) return { ok: false, error: 'Webhook trigger secret cannot contain newlines.' }
  return { ok: true, value: secret }
}

function trimmedString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined
}

function invalid(error: string): WebhookTriggerValidationResult {
  return { ok: false, error }
}
