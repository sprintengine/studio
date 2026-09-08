import { createServer, type IncomingHttpHeaders, type IncomingMessage, type Server, type ServerResponse } from 'node:http'

import type { AutomationTriggerPollEvent } from '../../shared/automations/contracts'
import {
  AutomationsStore,
  type AutomationStoreProblem,
} from './store'
import type {
  AutomationsEngineProblem,
  AutomationsEngineTriggerEventDeliveryResult,
  AutomationsProjectFolder,
} from './engine'
import {
  activeWebhookTriggerConfig,
  buildWebhookTriggerEvent,
  normalizeWebhookDeliveryId,
  verifyWebhookSignature,
  webhookPayloadMatchesConfig,
  WEBHOOK_DELIVERY_ID_HEADER,
  WEBHOOK_EVENT_TIME_HEADER,
  WEBHOOK_ROUTE_PREFIX,
  WEBHOOK_SIGNATURE_HEADER,
  WEBHOOK_TRIGGER_KIND,
  type WebhookTriggerConfig,
} from './triggers/webhook'
import { isRecord } from '../../shared/records'

export type AutomationWebhookReceiverOptions = {
  getProjectFolders: () => AutomationsProjectFolder[] | Promise<AutomationsProjectFolder[]>
  createStore?: (workspaceRoot: string) => AutomationsStore
  deliverTriggerEvent(input: {
    workspaceRoot: string
    workspaceId?: string
    automationId: string
    event: AutomationTriggerPollEvent
  }): Promise<AutomationsEngineTriggerEventDeliveryResult>
  now?: () => number
  host?: string
  logDeliveryProblem?: (problem: AutomationsEngineProblem) => void
}

export type AutomationWebhookDeliveryInput = {
  port: number
  path: string
  headers: IncomingHttpHeaders | Record<string, string | string[] | undefined>
  rawBody: string | Buffer
}

export type AutomationWebhookDeliveryResult =
  | {
    ok: true
    status: 'delivered' | 'duplicate' | 'ignored'
    fired: number
    duplicates: number
    ignored: number
    inFlight: number
    runIds: string[]
  }
  | { ok: false; statusCode: number; code: string; message: string }

type AutomationWebhookDeliveryFailure = Extract<AutomationWebhookDeliveryResult, { ok: false }>

export type AutomationWebhookReceiverStatus = {
  state: 'running' | 'stopped'
  host: string
  ports: number[]
  targetCount: number
  error?: string
}

type WebhookTarget = {
  workspaceRoot: string
  workspaceId: string
  automationId: string
  config: WebhookTriggerConfig
}

type ServerEntry = {
  server: Server
  actualPort: number
}

const DEFAULT_WEBHOOK_HOST = '127.0.0.1'
const MAX_WEBHOOK_BODY_BYTES = 256 * 1024

export class AutomationWebhookReceiverRefreshError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'AutomationWebhookReceiverRefreshError'
  }
}

export class AutomationWebhookReceiver {
  private readonly getProjectFolders: AutomationWebhookReceiverOptions['getProjectFolders']
  private readonly createStore: (workspaceRoot: string) => AutomationsStore
  private readonly deliverTriggerEvent: AutomationWebhookReceiverOptions['deliverTriggerEvent']
  private readonly now: () => number
  private readonly host: string
  private readonly logDeliveryProblem: (problem: AutomationsEngineProblem) => void
  private readonly servers = new Map<number, ServerEntry>()
  private operationQueue: Promise<void> = Promise.resolve()
  private mutationGeneration = 0
  private routes = new Map<string, WebhookTarget[]>()
  private targetCount = 0
  private lastError: string | null = null

  constructor(options: AutomationWebhookReceiverOptions) {
    this.getProjectFolders = options.getProjectFolders
    this.createStore = options.createStore ?? ((workspaceRoot) => new AutomationsStore(workspaceRoot))
    this.deliverTriggerEvent = options.deliverTriggerEvent
    this.now = options.now ?? Date.now
    this.host = options.host ?? DEFAULT_WEBHOOK_HOST
    this.logDeliveryProblem = options.logDeliveryProblem ?? defaultDeliveryProblemLogger
  }

  async refresh(): Promise<AutomationWebhookReceiverStatus> {
    const generation = this.mutationGeneration += 1
    return this.enqueueMutation(async () => this.refreshLatest(generation))
  }

  async stop(): Promise<void> {
    this.mutationGeneration += 1
    await this.enqueueMutation(async () => {
      await this.stopAllServers()
      this.routes = new Map()
      this.targetCount = 0
      this.lastError = null
    })
  }

  status(): AutomationWebhookReceiverStatus {
    const ports = [...this.servers.values()]
      .filter((entry) => entry.server.listening)
      .map((entry) => entry.actualPort)
      .sort((left, right) => left - right)
    return {
      state: ports.length > 0 ? 'running' : 'stopped',
      host: this.host,
      ports,
      targetCount: this.targetCount,
      ...(this.lastError ? { error: this.lastError } : {}),
    }
  }

  async deliver(input: AutomationWebhookDeliveryInput): Promise<AutomationWebhookDeliveryResult> {
    const path = normalizeDeliveryPath(input.path)
    if (!path) return failDelivery(404, 'webhook_route_not_found', 'Webhook route was not found.')

    const targets = this.routes.get(routeKey(input.port, path)) ?? []
    if (targets.length === 0) return failDelivery(404, 'webhook_route_not_found', 'Webhook route was not found.')

    const contentType = headerValue(input.headers, 'content-type')
    if (!contentType?.toLowerCase().includes('application/json')) {
      return failDelivery(415, 'unsupported_content_type', 'Webhook requests must use application/json.')
    }

    const body = parseWebhookBody(input.rawBody)
    if (!body.ok) return body

    const deliveryId = normalizeWebhookDeliveryId(headerValue(input.headers, WEBHOOK_DELIVERY_ID_HEADER))
    if (!deliveryId) {
      return failDelivery(400, 'invalid_delivery_id', `Webhook requests must include ${WEBHOOK_DELIVERY_ID_HEADER}.`)
    }

    const signature = headerValue(input.headers, WEBHOOK_SIGNATURE_HEADER)
    const receivedAt = new Date(this.now()).toISOString()
    const occurredAt = normalizeEventTime(headerValue(input.headers, WEBHOOK_EVENT_TIME_HEADER), receivedAt)
    if (!occurredAt.ok) return occurredAt

    let authorized = 0
    let fired = 0
    let duplicates = 0
    let ignored = 0
    let inFlight = 0
    const runIds: string[] = []

    for (const target of targets) {
      if (!target.config.secret || !verifyWebhookSignature({ secret: target.config.secret, rawBody: input.rawBody, signature })) {
        continue
      }
      authorized += 1
      if (!webhookPayloadMatchesConfig(body.value, target.config)) {
        ignored += 1
        continue
      }

      const delivery = await this.deliverTriggerEvent({
        workspaceRoot: target.workspaceRoot,
        workspaceId: target.workspaceId,
        automationId: target.automationId,
        event: buildWebhookTriggerEvent({
          config: target.config,
          deliveryId,
          rawPayload: body.value,
          occurredAt: occurredAt.value,
          receivedAt,
        }),
      })
      if (!delivery.ok) {
        this.logDeliveryProblem(delivery.problem)
        return failDelivery(500, delivery.problem.code, 'Webhook delivery failed.')
      }

      if (delivery.delivery.status === 'fired') {
        fired += 1
        runIds.push(delivery.delivery.run.id)
      } else if (delivery.delivery.status === 'duplicate') {
        duplicates += 1
      } else if (delivery.delivery.status === 'in_flight') {
        inFlight += 1
      }
    }

    if (authorized === 0) {
      return failDelivery(401, 'webhook_unauthorized', 'Webhook signature is missing or invalid.')
    }

    const status = fired > 0
      ? 'delivered'
      : duplicates > 0 || inFlight > 0
        ? 'duplicate'
        : 'ignored'
    return { ok: true, status, fired, duplicates, ignored, inFlight, runIds }
  }

  private async refreshLatest(generation: number): Promise<AutomationWebhookReceiverStatus> {
    const load = await this.loadRoutes()
    if (!this.isLatestMutation(generation)) return this.status()
    if (load.error) {
      await this.failClosed(load.error)
    }

    const desiredPorts = new Set(load.ports)
    for (const port of [...this.servers.keys()]) {
      if (!this.isLatestMutation(generation)) return this.status()
      if (!desiredPorts.has(port)) await this.stopServer(port)
    }

    const startErrors: string[] = []
    for (const port of desiredPorts) {
      if (!this.isLatestMutation(generation)) return this.status()
      if (this.servers.has(port)) continue
      const started = await this.startServer(port)
      if (!this.isLatestMutation(generation)) {
        await this.stopAllServers()
        return this.status()
      }
      if (!started.ok) startErrors.push(started.message)
    }

    if (startErrors.length > 0) {
      await this.failClosed(startErrors.join('; '))
    }

    if (!this.isLatestMutation(generation)) return this.status()
    this.routes = load.routes
    this.targetCount = load.targetCount
    this.lastError = null
    return this.status()
  }

  private enqueueMutation<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.operationQueue.then(operation, operation)
    this.operationQueue = run.then(() => undefined, () => undefined)
    return run
  }

  private isLatestMutation(generation: number): boolean {
    return generation === this.mutationGeneration
  }

  private async failClosed(message: string): Promise<never> {
    await this.stopAllServers()
    this.routes = new Map()
    this.targetCount = 0
    this.lastError = message
    throw new AutomationWebhookReceiverRefreshError(message)
  }

  private async stopAllServers(): Promise<void> {
    await Promise.all([...this.servers.keys()].map((port) => this.stopServer(port)))
  }

  private async loadRoutes(): Promise<{
    routes: Map<string, WebhookTarget[]>
    ports: number[]
    targetCount: number
    error: string | null
  }> {
    let projectFolders: AutomationsProjectFolder[]
    try {
      projectFolders = await this.getProjectFolders()
    } catch (error) {
      return {
        routes: new Map(),
        ports: [],
        targetCount: 0,
        error: error instanceof Error ? error.message : 'Unable to read workspace folders.',
      }
    }

    const routes = new Map<string, WebhookTarget[]>()
    let targetCount = 0
    let firstError: string | null = null

    for (const projectFolder of projectFolders) {
      const workspaceRoot = projectFolder.folderPath.trim()
      if (!workspaceRoot) continue
      const listed = await this.createStore(workspaceRoot).listDefinitions()
      if (!listed.ok) {
        firstError ??= listed.errors.map((error) => storeProblemMessage(error)).join('; ')
        continue
      }

      for (const definition of listed.values) {
        if (definition.status !== 'enabled') continue
        if (definition.trigger.kind !== WEBHOOK_TRIGGER_KIND) continue
        const config = activeWebhookTriggerConfig(definition.trigger.config)
        if (!config || config.port === undefined || !config.path) continue

        const target: WebhookTarget = {
          workspaceRoot,
          workspaceId: projectFolder.workspaceId,
          automationId: definition.id,
          config,
        }
        const key = routeKey(config.port, config.path)
        routes.set(key, [...routes.get(key) ?? [], target])
        targetCount += 1
      }
    }

    return {
      routes,
      ports: [...new Set([...routes.values()].flatMap((targets) => targets.map((target) => target.config.port ?? 0)))],
      targetCount,
      error: firstError,
    }
  }

  private async startServer(port: number): Promise<{ ok: true } | { ok: false; message: string }> {
    const server = createServer((request, response) => {
      void this.handleHttpRequest(port, request, response)
    })

    try {
      const actualPort = await new Promise<number>((resolve, reject) => {
        const onError = (error: Error) => {
          cleanup()
          reject(error)
        }
        const onListening = () => {
          cleanup()
          const address = server.address()
          resolve(typeof address === 'object' && address ? address.port : port)
        }
        const cleanup = () => {
          server.off('error', onError)
          server.off('listening', onListening)
        }
        server.on('error', onError)
        server.on('listening', onListening)
        server.listen(port, this.host)
      })
      this.servers.set(port, { server, actualPort })
      return { ok: true }
    } catch (error) {
      return {
        ok: false,
        message: error instanceof Error ? error.message : `Unable to start webhook receiver on port ${port}.`,
      }
    }
  }

  private async stopServer(port: number): Promise<void> {
    const entry = this.servers.get(port)
    if (!entry) return
    this.servers.delete(port)
    if (!entry.server.listening) return
    await new Promise<void>((resolve) => {
      entry.server.close(() => resolve())
    })
  }

  private async handleHttpRequest(
    configuredPort: number,
    request: IncomingMessage,
    response: ServerResponse
  ): Promise<void> {
    if (request.method !== 'POST') {
      writeJson(response, 405, { ok: false, code: 'method_not_allowed', message: 'Webhook requests must use POST.' })
      return
    }

    let rawBody: Buffer
    try {
      rawBody = await readRequestBody(request)
    } catch (error) {
      writeJson(response, 413, {
        ok: false,
        code: 'payload_too_large',
        message: error instanceof Error ? error.message : 'Webhook request body is too large.',
      })
      return
    }

    const result = await this.deliver({
      port: configuredPort,
      path: request.url ?? '',
      headers: request.headers,
      rawBody,
    })
    if (result.ok) {
      writeJson(response, 202, result)
      return
    }
    writeJson(response, result.statusCode, result)
  }
}

export function createAutomationWebhookReceiver(options: AutomationWebhookReceiverOptions): AutomationWebhookReceiver {
  return new AutomationWebhookReceiver(options)
}

function routeKey(port: number, path: string): string {
  return `${port}\u0000${path}`
}

function normalizeDeliveryPath(value: string): string | null {
  let pathname = value
  try {
    pathname = new URL(value, 'http://127.0.0.1').pathname
  } catch {
    pathname = value
  }
  if (!pathname.startsWith(WEBHOOK_ROUTE_PREFIX)) return null
  pathname = pathname.slice(WEBHOOK_ROUTE_PREFIX.length)
  pathname = pathname.replace(/^\/+/u, '').trim()
  return pathname || null
}

function headerValue(
  headers: IncomingHttpHeaders | Record<string, string | string[] | undefined>,
  name: string
): string | undefined {
  const direct = headers[name]
  const value = direct === undefined
    ? Object.entries(headers).find(([key]) => key.toLowerCase() === name.toLowerCase())?.[1]
    : direct
  return Array.isArray(value) ? value[0] : value
}

function parseWebhookBody(rawBody: string | Buffer): { ok: true; value: Record<string, unknown> } | AutomationWebhookDeliveryFailure {
  const bodyLength = Buffer.isBuffer(rawBody) ? rawBody.length : Buffer.byteLength(rawBody)
  if (bodyLength > MAX_WEBHOOK_BODY_BYTES) {
    return failDelivery(413, 'payload_too_large', `Webhook request body cannot exceed ${MAX_WEBHOOK_BODY_BYTES} bytes.`)
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(Buffer.isBuffer(rawBody) ? rawBody.toString('utf8') : rawBody)
  } catch {
    return failDelivery(400, 'malformed_json', 'Webhook request body must be valid JSON.')
  }
  if (!isRecord(parsed)) {
    return failDelivery(400, 'invalid_payload', 'Webhook request body must be a JSON object.')
  }
  return { ok: true, value: parsed }
}

function normalizeEventTime(
  value: string | undefined,
  fallback: string
): { ok: true; value: string } | AutomationWebhookDeliveryFailure {
  if (!value) return { ok: true, value: fallback }
  const parsed = Date.parse(value)
  if (!Number.isFinite(parsed)) {
    return failDelivery(400, 'invalid_event_time', `${WEBHOOK_EVENT_TIME_HEADER} must be an ISO timestamp.`)
  }
  return { ok: true, value: new Date(parsed).toISOString() }
}

function failDelivery(
  statusCode: number,
  code: string,
  message: string
): AutomationWebhookDeliveryFailure {
  return { ok: false, statusCode, code, message }
}

async function readRequestBody(request: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = []
  let totalLength = 0
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    totalLength += buffer.length
    if (totalLength > MAX_WEBHOOK_BODY_BYTES) {
      throw new Error(`Webhook request body cannot exceed ${MAX_WEBHOOK_BODY_BYTES} bytes.`)
    }
    chunks.push(buffer)
  }
  return Buffer.concat(chunks)
}

function writeJson(response: ServerResponse, statusCode: number, payload: unknown): void {
  response.statusCode = statusCode
  response.setHeader('content-type', 'application/json; charset=utf-8')
  response.end(JSON.stringify(payload))
}

function storeProblemMessage(error: AutomationStoreProblem): string {
  return `${error.path}: ${error.message}`
}

function defaultDeliveryProblemLogger(problem: AutomationsEngineProblem): void {
  console.warn(
    `[automations:webhook] delivery failed (${problem.code})`,
    problem.message
  )
}

