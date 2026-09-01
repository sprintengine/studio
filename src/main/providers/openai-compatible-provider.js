export function createOpenAiCompatibleProvider(options) {
    const fetchImpl = options.fetch ?? fetch;
    return {
        id: 'openai-compatible-api',
        listModels: () => [],
        startSession(input) {
            return [
                event(input, 'session_started'),
                event(input, 'session_ready'),
            ];
        },
        sendTurn(input) {
            return streamTurn(input, options, fetchImpl);
        },
        resolveApproval() {
            return [];
        },
        interrupt(input) {
            return [event(input, 'turn_failed', { reason: 'interrupted' })];
        },
        stopSession(input) {
            return [event(input, 'session_closed')];
        },
    };
}
export async function testOpenAiCompatibleConnection(input) {
    const provider = input.getProviderById(input.providerId);
    if (!provider)
        return testFailure(input.providerId, 'invalid_endpoint', 'Conversation provider is not installed.');
    if (!provider.manifest.openaiCompatible) {
        return testFailure(input.providerId, 'invalid_endpoint', 'Conversation provider is not OpenAI-compatible.');
    }
    const modelId = input.modelId?.trim() || provider.manifest.models[0]?.id;
    if (!modelId || !provider.manifest.models.some((model) => model.id === modelId)) {
        return testFailure(input.providerId, 'model_error', 'Conversation model is invalid.');
    }
    const secret = await input.resolveSecret(input.providerId);
    if (!secret.ok) {
        return testFailure(input.providerId, 'missing_key', 'Provider API key is not configured.');
    }
    const endpoint = resolveEndpoint(provider);
    if (!endpoint.ok)
        return testFailure(input.providerId, 'invalid_endpoint', endpoint.message);
    try {
        const response = await (input.fetch ?? fetch)(endpoint.url, {
            method: 'POST',
            headers: buildHeaders(secret.value),
            body: JSON.stringify({
                model: modelId,
                messages: [{ role: 'user', content: 'Multicode connection test. Reply briefly.' }],
                max_tokens: 1,
                stream: false,
            }),
        });
        if (!response.ok) {
            const detail = await readProviderErrorDetail(response);
            return testFailure(input.providerId, mapHttpFailure(response.status), httpFailureMessage(response.status, detail));
        }
        let payload;
        try {
            payload = await response.json();
        }
        catch {
            return testFailure(input.providerId, 'malformed_response', 'Provider returned a malformed connection-test response.');
        }
        if (!isChatCompletionResponse(payload)) {
            return testFailure(input.providerId, 'malformed_response', 'Provider returned a malformed connection-test response.');
        }
        const usage = extractUsage(payload.usage);
        return {
            ok: true,
            status: {
                providerId: input.providerId,
                state: 'reachable',
                modelId,
                message: 'Provider endpoint is reachable.',
                ...(usage ? { usage } : {}),
            },
        };
    }
    catch {
        return testFailure(input.providerId, 'network_error', 'Provider endpoint could not be reached.');
    }
}
async function* streamTurn(input, options, fetchImpl) {
    yield event(input, 'turn_started', { turnId: input.turnId });
    const provider = options.getProviderById(input.providerId);
    if (!provider?.manifest.openaiCompatible) {
        yield failure(input, 'invalid_endpoint', 'OpenAI-compatible provider descriptor is unavailable.');
        return;
    }
    const secret = await options.resolveSecret(input.providerId);
    if (!secret.ok) {
        yield failure(input, 'auth', 'Provider API key is not configured.');
        return;
    }
    const endpoint = resolveEndpoint(provider);
    if (!endpoint.ok) {
        yield failure(input, 'invalid_endpoint', endpoint.message);
        return;
    }
    try {
        const response = await fetchImpl(endpoint.url, {
            method: 'POST',
            headers: buildHeaders(secret.value),
            signal: input.signal,
            body: JSON.stringify({
                // Send the full conversation history when the runtime provides it, so the
                // model actually has memory across turns; fall back to the single message.
                model: input.modelId,
                messages: input.messages?.length ? input.messages : [{ role: 'user', content: input.message }],
                stream: true,
                stream_options: { include_usage: true },
            }),
        });
        if (!response.ok) {
            const detail = await readProviderErrorDetail(response);
            yield failure(input, mapHttpTurnFailure(response.status), httpFailureMessage(response.status, detail));
            return;
        }
        if (!response.body) {
            yield failure(input, 'malformed_stream', 'Provider did not return a streaming response body.');
            return;
        }
        let sawDone = false;
        for await (const chunk of parseSse(response.body, input.signal)) {
            if (input.signal?.aborted) {
                yield failure(input, 'interrupted', 'Provider stream was interrupted.');
                return;
            }
            if (chunk === '[DONE]') {
                sawDone = true;
                break;
            }
            let payload;
            try {
                payload = JSON.parse(chunk);
            }
            catch {
                yield failure(input, 'malformed_stream', 'Provider returned malformed streaming data.');
                return;
            }
            const content = payload?.choices?.[0]?.delta?.content;
            if (typeof content === 'string' && content.length > 0) {
                yield event(input, 'content_delta', { turnId: input.turnId, text: content });
            }
            const usage = extractUsage(payload?.usage);
            if (usage) {
                yield event(input, 'usage_updated', {
                    turnId: input.turnId,
                    inputTokens: usage.inputTokens,
                    outputTokens: usage.outputTokens,
                    totalTokens: usage.totalTokens,
                });
            }
        }
        if (!sawDone) {
            yield failure(input, 'malformed_stream', 'Provider stream ended before completion.');
            return;
        }
        yield event(input, 'turn_completed', { turnId: input.turnId });
    }
    catch {
        if (input.signal?.aborted) {
            yield failure(input, 'interrupted', 'Provider stream was interrupted.');
            return;
        }
        yield failure(input, 'network', 'Provider endpoint could not be reached.');
    }
}
async function* parseSse(body, signal) {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    const abort = () => {
        void reader.cancel().catch(() => undefined);
    };
    if (signal?.aborted)
        abort();
    signal?.addEventListener('abort', abort, { once: true });
    try {
        while (true) {
            if (signal?.aborted)
                break;
            const { done, value } = await reader.read();
            if (done)
                break;
            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split(/\r?\n/);
            buffer = lines.pop() ?? '';
            for (const line of lines) {
                const trimmed = line.trim();
                if (trimmed.startsWith('data:'))
                    yield trimmed.slice('data:'.length).trim();
            }
        }
        buffer += decoder.decode();
        for (const line of buffer.split(/\r?\n/)) {
            const trimmed = line.trim();
            if (trimmed.startsWith('data:'))
                yield trimmed.slice('data:'.length).trim();
        }
    }
    finally {
        signal?.removeEventListener('abort', abort);
        reader.releaseLock();
    }
}
function resolveEndpoint(provider) {
    const config = provider.manifest.openaiCompatible;
    if (!config)
        return { ok: false, message: 'OpenAI-compatible provider config is missing.' };
    try {
        const base = new URL(config.baseUrl);
        if (base.protocol !== 'https:' && base.protocol !== 'http:') {
            return { ok: false, message: 'Provider endpoint must use http or https.' };
        }
        const path = config.chatCompletionsPath ?? '/v1/chat/completions';
        return { ok: true, url: new URL(path, base).toString() };
    }
    catch {
        return { ok: false, message: 'Provider endpoint URL is invalid.' };
    }
}
// OpenRouter uses these for its app-attribution rankings; other OpenAI-compatible
// endpoints ignore unknown headers, so they are safe to send unconditionally.
const ATTRIBUTION_HEADERS = {
    'HTTP-Referer': 'https://multicode.app',
    'X-Title': 'Multicode',
};
function buildHeaders(apiKey) {
    return {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        ...ATTRIBUTION_HEADERS,
    };
}
// Fetch a provider's live model catalog from its OpenAI-shaped models endpoint
// (`modelsPath`). Used for providers like OpenRouter whose real value is a large,
// frequently-changing catalog. The API key is included when configured but is not
// required (OpenRouter's models endpoint is public); any failure returns ok:false
// so the renderer can fall back to the manifest's seed models.
export async function listOpenAiCompatibleModels(input) {
    const provider = input.getProviderById(input.providerId);
    if (!provider)
        return { ok: false, message: 'Conversation provider is not installed.' };
    const config = provider.manifest.openaiCompatible;
    if (!config?.modelsPath)
        return { ok: false, message: 'Provider does not expose a model catalog.' };
    let url;
    try {
        url = new URL(config.modelsPath, new URL(config.baseUrl)).toString();
    }
    catch {
        return { ok: false, message: 'Provider models endpoint URL is invalid.' };
    }
    const secret = await input.resolveSecret(input.providerId);
    const headers = { Accept: 'application/json', ...ATTRIBUTION_HEADERS };
    if (secret.ok)
        headers.Authorization = `Bearer ${secret.value}`;
    try {
        const response = await (input.fetch ?? fetch)(url, { method: 'GET', headers });
        if (!response.ok)
            return { ok: false, message: `Model catalog request failed (${response.status}).` };
        let payload;
        try {
            payload = await response.json();
        }
        catch {
            return { ok: false, message: 'Provider returned a malformed model catalog.' };
        }
        const models = parseModelsPayload(payload);
        if (!models)
            return { ok: false, message: 'Provider returned a malformed model catalog.' };
        return { ok: true, models };
    }
    catch {
        return { ok: false, message: 'Model catalog endpoint could not be reached.' };
    }
}
// Parse an OpenAI-shaped `{ data: [{ id, name? }] }` models response into our
// model descriptors, dropping any entry without a usable string id.
function parseModelsPayload(payload) {
    if (!payload || typeof payload !== 'object')
        return null;
    const data = payload.data;
    if (!Array.isArray(data))
        return null;
    const models = [];
    for (const item of data) {
        if (!item || typeof item !== 'object')
            continue;
        const id = item.id;
        if (typeof id !== 'string' || !id.trim())
            continue;
        const name = item.name;
        const contextLength = numberOrUndefined(item.context_length);
        models.push({
            id: id.trim(),
            ...(typeof name === 'string' && name.trim() ? { displayName: name.trim() } : {}),
            ...(contextLength && contextLength > 0 ? { contextLength } : {}),
        });
    }
    return models;
}
function mapHttpFailure(status) {
    if (status === 401 || status === 403)
        return 'invalid_key';
    if (status === 429)
        return 'rate_limited';
    return 'invalid_endpoint';
}
function mapHttpTurnFailure(status) {
    if (status === 401 || status === 403)
        return 'auth';
    if (status === 429)
        return 'rate_limit';
    if (status === 400)
        return 'model';
    return 'invalid_endpoint';
}
function httpFailureMessage(status, detail) {
    const base = status === 401 || status === 403
        ? 'Provider rejected the API key.'
        : status === 429
            ? 'Provider rate limit was reached.'
            : status === 400
                ? 'Provider rejected the selected model or request.'
                : 'Provider endpoint did not accept the chat-completions request.';
    // Include the provider's own error text (e.g. OpenRouter "No endpoints found
    // for <model>") so an opaque status becomes actionable.
    return detail ? `${base} (${status}: ${detail})` : `${base} (${status})`;
}
// Read a failed provider response body and pull out its human error message.
// OpenAI/OpenRouter return `{ error: { message } }`; fall back to a trimmed raw
// body. Never throws — diagnostics are best-effort.
async function readProviderErrorDetail(response) {
    try {
        const text = await response.text();
        if (!text.trim())
            return undefined;
        try {
            const json = JSON.parse(text);
            const message = (typeof json.error?.message === 'string' && json.error.message)
                || (typeof json.message === 'string' && json.message);
            if (message && message.trim())
                return message.trim().slice(0, 300);
        }
        catch {
            // Not JSON — fall through to the raw snippet.
        }
        return text.trim().slice(0, 300);
    }
    catch {
        return undefined;
    }
}
function extractUsage(value) {
    if (!isObject(value))
        return null;
    const inputTokens = numberOrUndefined(value.prompt_tokens);
    const outputTokens = numberOrUndefined(value.completion_tokens);
    const totalTokens = numberOrUndefined(value.total_tokens);
    if (inputTokens === undefined && outputTokens === undefined && totalTokens === undefined)
        return null;
    return { inputTokens, outputTokens, totalTokens };
}
function isChatCompletionResponse(value) {
    if (!isObject(value) || !Array.isArray(value.choices) || value.choices.length === 0)
        return false;
    return value.choices.some((choice) => {
        if (!isObject(choice))
            return false;
        const message = choice.message;
        if (!isObject(message))
            return false;
        return typeof message.content === 'string' || Array.isArray(message.content);
    });
}
function numberOrUndefined(value) {
    return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}
function testFailure(providerId, state, message) {
    return { ok: false, status: { providerId, state, message } };
}
function failure(input, reason, message) {
    return event(input, 'turn_failed', { turnId: input.turnId, reason, message });
}
function event(input, type, payload) {
    return {
        id: '',
        sessionId: input.sessionId,
        workspaceId: input.workspaceId,
        agentId: input.agentId,
        providerId: input.providerId,
        modelId: input.modelId,
        type,
        createdAt: 0,
        payload,
    };
}
function isObject(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
