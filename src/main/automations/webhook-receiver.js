import { createServer } from 'node:http';
import { AutomationsStore, } from './store';
import { activeWebhookTriggerConfig, buildWebhookTriggerEvent, normalizeWebhookDeliveryId, verifyWebhookSignature, webhookPayloadMatchesConfig, WEBHOOK_DELIVERY_ID_HEADER, WEBHOOK_EVENT_TIME_HEADER, WEBHOOK_ROUTE_PREFIX, WEBHOOK_SIGNATURE_HEADER, WEBHOOK_TRIGGER_KIND, } from './triggers/webhook';
const DEFAULT_WEBHOOK_HOST = '127.0.0.1';
const MAX_WEBHOOK_BODY_BYTES = 256 * 1024;
export class AutomationWebhookReceiverRefreshError extends Error {
    constructor(message) {
        super(message);
        this.name = 'AutomationWebhookReceiverRefreshError';
    }
}
export class AutomationWebhookReceiver {
    getProjectFolders;
    createStore;
    deliverTriggerEvent;
    now;
    host;
    logDeliveryProblem;
    servers = new Map();
    operationQueue = Promise.resolve();
    mutationGeneration = 0;
    routes = new Map();
    targetCount = 0;
    lastError = null;
    constructor(options) {
        this.getProjectFolders = options.getProjectFolders;
        this.createStore = options.createStore ?? ((workspaceRoot) => new AutomationsStore(workspaceRoot));
        this.deliverTriggerEvent = options.deliverTriggerEvent;
        this.now = options.now ?? Date.now;
        this.host = options.host ?? DEFAULT_WEBHOOK_HOST;
        this.logDeliveryProblem = options.logDeliveryProblem ?? defaultDeliveryProblemLogger;
    }
    async refresh() {
        const generation = this.mutationGeneration += 1;
        return this.enqueueMutation(async () => this.refreshLatest(generation));
    }
    async stop() {
        this.mutationGeneration += 1;
        await this.enqueueMutation(async () => {
            await this.stopAllServers();
            this.routes = new Map();
            this.targetCount = 0;
            this.lastError = null;
        });
    }
    status() {
        const ports = [...this.servers.values()]
            .filter((entry) => entry.server.listening)
            .map((entry) => entry.actualPort)
            .sort((left, right) => left - right);
        return {
            state: ports.length > 0 ? 'running' : 'stopped',
            host: this.host,
            ports,
            targetCount: this.targetCount,
            ...(this.lastError ? { error: this.lastError } : {}),
        };
    }
    async deliver(input) {
        const path = normalizeDeliveryPath(input.path);
        if (!path)
            return failDelivery(404, 'webhook_route_not_found', 'Webhook route was not found.');
        const targets = this.routes.get(routeKey(input.port, path)) ?? [];
        if (targets.length === 0)
            return failDelivery(404, 'webhook_route_not_found', 'Webhook route was not found.');
        const contentType = headerValue(input.headers, 'content-type');
        if (!contentType?.toLowerCase().includes('application/json')) {
            return failDelivery(415, 'unsupported_content_type', 'Webhook requests must use application/json.');
        }
        const body = parseWebhookBody(input.rawBody);
        if (!body.ok)
            return body;
        const deliveryId = normalizeWebhookDeliveryId(headerValue(input.headers, WEBHOOK_DELIVERY_ID_HEADER));
        if (!deliveryId) {
            return failDelivery(400, 'invalid_delivery_id', `Webhook requests must include ${WEBHOOK_DELIVERY_ID_HEADER}.`);
        }
        const signature = headerValue(input.headers, WEBHOOK_SIGNATURE_HEADER);
        const receivedAt = new Date(this.now()).toISOString();
        const occurredAt = normalizeEventTime(headerValue(input.headers, WEBHOOK_EVENT_TIME_HEADER), receivedAt);
        if (!occurredAt.ok)
            return occurredAt;
        let authorized = 0;
        let fired = 0;
        let duplicates = 0;
        let ignored = 0;
        let inFlight = 0;
        const runIds = [];
        for (const target of targets) {
            if (!target.config.secret || !verifyWebhookSignature({ secret: target.config.secret, rawBody: input.rawBody, signature })) {
                continue;
            }
            authorized += 1;
            if (!webhookPayloadMatchesConfig(body.value, target.config)) {
                ignored += 1;
                continue;
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
            });
            if (!delivery.ok) {
                this.logDeliveryProblem(delivery.problem);
                return failDelivery(500, delivery.problem.code, 'Webhook delivery failed.');
            }
            if (delivery.delivery.status === 'fired') {
                fired += 1;
                runIds.push(delivery.delivery.run.id);
            }
            else if (delivery.delivery.status === 'duplicate') {
                duplicates += 1;
            }
            else if (delivery.delivery.status === 'in_flight') {
                inFlight += 1;
            }
        }
        if (authorized === 0) {
            return failDelivery(401, 'webhook_unauthorized', 'Webhook signature is missing or invalid.');
        }
        const status = fired > 0
            ? 'delivered'
            : duplicates > 0 || inFlight > 0
                ? 'duplicate'
                : 'ignored';
        return { ok: true, status, fired, duplicates, ignored, inFlight, runIds };
    }
    async refreshLatest(generation) {
        const load = await this.loadRoutes();
        if (!this.isLatestMutation(generation))
            return this.status();
        if (load.error) {
            await this.failClosed(load.error);
        }
        const desiredPorts = new Set(load.ports);
        for (const port of [...this.servers.keys()]) {
            if (!this.isLatestMutation(generation))
                return this.status();
            if (!desiredPorts.has(port))
                await this.stopServer(port);
        }
        const startErrors = [];
        for (const port of desiredPorts) {
            if (!this.isLatestMutation(generation))
                return this.status();
            if (this.servers.has(port))
                continue;
            const started = await this.startServer(port);
            if (!this.isLatestMutation(generation)) {
                await this.stopAllServers();
                return this.status();
            }
            if (!started.ok)
                startErrors.push(started.message);
        }
        if (startErrors.length > 0) {
            await this.failClosed(startErrors.join('; '));
        }
        if (!this.isLatestMutation(generation))
            return this.status();
        this.routes = load.routes;
        this.targetCount = load.targetCount;
        this.lastError = null;
        return this.status();
    }
    enqueueMutation(operation) {
        const run = this.operationQueue.then(operation, operation);
        this.operationQueue = run.then(() => undefined, () => undefined);
        return run;
    }
    isLatestMutation(generation) {
        return generation === this.mutationGeneration;
    }
    async failClosed(message) {
        await this.stopAllServers();
        this.routes = new Map();
        this.targetCount = 0;
        this.lastError = message;
        throw new AutomationWebhookReceiverRefreshError(message);
    }
    async stopAllServers() {
        await Promise.all([...this.servers.keys()].map((port) => this.stopServer(port)));
    }
    async loadRoutes() {
        let projectFolders;
        try {
            projectFolders = await this.getProjectFolders();
        }
        catch (error) {
            return {
                routes: new Map(),
                ports: [],
                targetCount: 0,
                error: error instanceof Error ? error.message : 'Unable to read workspace folders.',
            };
        }
        const routes = new Map();
        let targetCount = 0;
        let firstError = null;
        for (const projectFolder of projectFolders) {
            const workspaceRoot = projectFolder.folderPath.trim();
            if (!workspaceRoot)
                continue;
            const listed = await this.createStore(workspaceRoot).listDefinitions();
            if (!listed.ok) {
                firstError ??= listed.errors.map((error) => storeProblemMessage(error)).join('; ');
                continue;
            }
            for (const definition of listed.values) {
                if (definition.status !== 'enabled')
                    continue;
                if (definition.trigger.kind !== WEBHOOK_TRIGGER_KIND)
                    continue;
                const config = activeWebhookTriggerConfig(definition.trigger.config);
                if (!config || config.port === undefined || !config.path)
                    continue;
                const target = {
                    workspaceRoot,
                    workspaceId: projectFolder.workspaceId,
                    automationId: definition.id,
                    config,
                };
                const key = routeKey(config.port, config.path);
                routes.set(key, [...routes.get(key) ?? [], target]);
                targetCount += 1;
            }
        }
        return {
            routes,
            ports: [...new Set([...routes.values()].flatMap((targets) => targets.map((target) => target.config.port ?? 0)))],
            targetCount,
            error: firstError,
        };
    }
    async startServer(port) {
        const server = createServer((request, response) => {
            void this.handleHttpRequest(port, request, response);
        });
        try {
            const actualPort = await new Promise((resolve, reject) => {
                const onError = (error) => {
                    cleanup();
                    reject(error);
                };
                const onListening = () => {
                    cleanup();
                    const address = server.address();
                    resolve(typeof address === 'object' && address ? address.port : port);
                };
                const cleanup = () => {
                    server.off('error', onError);
                    server.off('listening', onListening);
                };
                server.on('error', onError);
                server.on('listening', onListening);
                server.listen(port, this.host);
            });
            this.servers.set(port, { server, actualPort });
            return { ok: true };
        }
        catch (error) {
            return {
                ok: false,
                message: error instanceof Error ? error.message : `Unable to start webhook receiver on port ${port}.`,
            };
        }
    }
    async stopServer(port) {
        const entry = this.servers.get(port);
        if (!entry)
            return;
        this.servers.delete(port);
        if (!entry.server.listening)
            return;
        await new Promise((resolve) => {
            entry.server.close(() => resolve());
        });
    }
    async handleHttpRequest(configuredPort, request, response) {
        if (request.method !== 'POST') {
            writeJson(response, 405, { ok: false, code: 'method_not_allowed', message: 'Webhook requests must use POST.' });
            return;
        }
        let rawBody;
        try {
            rawBody = await readRequestBody(request);
        }
        catch (error) {
            writeJson(response, 413, {
                ok: false,
                code: 'payload_too_large',
                message: error instanceof Error ? error.message : 'Webhook request body is too large.',
            });
            return;
        }
        const result = await this.deliver({
            port: configuredPort,
            path: request.url ?? '',
            headers: request.headers,
            rawBody,
        });
        if (result.ok) {
            writeJson(response, 202, result);
            return;
        }
        writeJson(response, result.statusCode, result);
    }
}
export function createAutomationWebhookReceiver(options) {
    return new AutomationWebhookReceiver(options);
}
function routeKey(port, path) {
    return `${port}\u0000${path}`;
}
function normalizeDeliveryPath(value) {
    let pathname = value;
    try {
        pathname = new URL(value, 'http://127.0.0.1').pathname;
    }
    catch {
        pathname = value;
    }
    if (!pathname.startsWith(WEBHOOK_ROUTE_PREFIX))
        return null;
    pathname = pathname.slice(WEBHOOK_ROUTE_PREFIX.length);
    pathname = pathname.replace(/^\/+/u, '').trim();
    return pathname || null;
}
function headerValue(headers, name) {
    const direct = headers[name];
    const value = direct === undefined
        ? Object.entries(headers).find(([key]) => key.toLowerCase() === name.toLowerCase())?.[1]
        : direct;
    return Array.isArray(value) ? value[0] : value;
}
function parseWebhookBody(rawBody) {
    const bodyLength = Buffer.isBuffer(rawBody) ? rawBody.length : Buffer.byteLength(rawBody);
    if (bodyLength > MAX_WEBHOOK_BODY_BYTES) {
        return failDelivery(413, 'payload_too_large', `Webhook request body cannot exceed ${MAX_WEBHOOK_BODY_BYTES} bytes.`);
    }
    let parsed;
    try {
        parsed = JSON.parse(Buffer.isBuffer(rawBody) ? rawBody.toString('utf8') : rawBody);
    }
    catch {
        return failDelivery(400, 'malformed_json', 'Webhook request body must be valid JSON.');
    }
    if (!isRecord(parsed)) {
        return failDelivery(400, 'invalid_payload', 'Webhook request body must be a JSON object.');
    }
    return { ok: true, value: parsed };
}
function normalizeEventTime(value, fallback) {
    if (!value)
        return { ok: true, value: fallback };
    const parsed = Date.parse(value);
    if (!Number.isFinite(parsed)) {
        return failDelivery(400, 'invalid_event_time', `${WEBHOOK_EVENT_TIME_HEADER} must be an ISO timestamp.`);
    }
    return { ok: true, value: new Date(parsed).toISOString() };
}
function failDelivery(statusCode, code, message) {
    return { ok: false, statusCode, code, message };
}
async function readRequestBody(request) {
    const chunks = [];
    let totalLength = 0;
    for await (const chunk of request) {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        totalLength += buffer.length;
        if (totalLength > MAX_WEBHOOK_BODY_BYTES) {
            throw new Error(`Webhook request body cannot exceed ${MAX_WEBHOOK_BODY_BYTES} bytes.`);
        }
        chunks.push(buffer);
    }
    return Buffer.concat(chunks);
}
function writeJson(response, statusCode, payload) {
    response.statusCode = statusCode;
    response.setHeader('content-type', 'application/json; charset=utf-8');
    response.end(JSON.stringify(payload));
}
function storeProblemMessage(error) {
    return `${error.path}: ${error.message}`;
}
function defaultDeliveryProblemLogger(problem) {
    console.warn(`[automations:webhook] delivery failed (${problem.code})`, problem.message);
}
function isRecord(value) {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
