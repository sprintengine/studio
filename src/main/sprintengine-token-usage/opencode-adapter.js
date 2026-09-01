import { emptyModelUsage, tokenCount } from './types';
// A reachable server returns 200 with this username; the password is the
// OPENCODE_SERVER_PASSWORD the server was started with (HTTP Basic auth).
const OPENCODE_BASIC_AUTH_USER = 'opencode';
// The server is always a local loopback process, and the request carries the
// Basic-auth password. Restrict the base URL to loopback hosts so a misconfigured
// OPENCODE_SERVER can never send those credentials to a remote origin; anything
// else reports unmeasured (null). URL parsing also rejects malformed values.
// URL.hostname serializes IPv6 with brackets, so [::1] is matched as written.
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);
function resolveBaseUrl(env) {
    const raw = env.OPENCODE_SERVER?.trim();
    if (!raw)
        return null;
    let parsed;
    try {
        parsed = new URL(raw);
    }
    catch {
        return null;
    }
    if (!LOOPBACK_HOSTS.has(parsed.hostname))
        return null;
    return raw.replace(/\/+$/, '');
}
function authHeaders(env) {
    const password = env.OPENCODE_SERVER_PASSWORD?.trim();
    if (!password)
        return {};
    const credentials = Buffer.from(`${OPENCODE_BASIC_AUTH_USER}:${password}`).toString('base64');
    return { Authorization: `Basic ${credentials}` };
}
// Returns null when no server is configured/reachable or the session is unknown
// (caller reports measured:false); otherwise the per-model usage summed from the
// session's assistant messages.
export async function readOpenCodeUsage(cliSessionId, env, fetchImpl) {
    const baseUrl = resolveBaseUrl(env);
    if (!baseUrl)
        return null;
    const url = `${baseUrl}/session/${encodeURIComponent(cliSessionId)}/message`;
    let response;
    try {
        // redirect:'error' keeps the credentialed request on the loopback origin —
        // a 3xx cannot bounce the Basic-auth header to another host.
        response = await fetchImpl(url, { headers: authHeaders(env), redirect: 'error' });
    }
    catch {
        return null; // server unreachable
    }
    if (!response.ok)
        return null; // 404 session not found, 401 unauthorized, etc.
    let messages;
    try {
        messages = await response.json();
    }
    catch {
        return null;
    }
    if (!Array.isArray(messages))
        return null;
    const perModel = new Map();
    for (const message of messages) {
        // The endpoint wraps each message as { info, parts }; tolerate a flat shape.
        const info = (message && typeof message === 'object' && 'info' in message
            ? message.info
            : message);
        if (!info || typeof info !== 'object' || info.role !== 'assistant')
            continue;
        const tokens = info.tokens;
        if (!tokens || typeof tokens !== 'object')
            continue;
        const model = typeof info.modelID === 'string' && info.modelID ? info.modelID : 'unknown';
        const bucket = perModel.get(model) ?? emptyModelUsage(model);
        bucket.input += tokenCount(tokens.input);
        // Reasoning folds into output (no distinct field in ModelTokenUsage).
        bucket.output += tokenCount(tokens.output) + tokenCount(tokens.reasoning);
        const cache = tokens.cache ?? {};
        bucket.cacheRead += tokenCount(cache.read);
        bucket.cacheCreation += tokenCount(cache.write);
        perModel.set(model, bucket);
    }
    return [...perModel.values()];
}
