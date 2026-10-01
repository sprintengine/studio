// The one outbound request a credential broker makes on a module's behalf.
//
// Both brokers (module-secrets.ts, module-github.ts) attach a credential the
// module never sees, so the request they send is shaped here once: no
// redirects (a 3xx would carry the credential's request to a host nobody
// allowed), a deadline, and a bounded read of the answer. Failures come back
// as fixed sentences, never as the underlying error's text — a fetch error can
// quote a header value, and a header value here may be the credential.

export type BrokerFetch = (input: string, init: RequestInit) => Promise<Response>

export type BrokerHttpResponse = {
  status: number
  headers: Record<string, string>
  body: string
}

export type BrokerHttpOutcome =
  | { ok: true; response: BrokerHttpResponse }
  | { ok: false; reason: 'timeout' | 'too_large' | 'redirect' | 'failed'; message: string }

export const BROKER_DEFAULT_TIMEOUT_MS = 30_000
export const BROKER_MAX_TIMEOUT_MS = 120_000

/** A caller's timeout, or the default, held inside 1ms..BROKER_MAX_TIMEOUT_MS. */
export function brokerTimeout(timeoutMs: unknown): number {
  if (typeof timeoutMs !== 'number' || !Number.isFinite(timeoutMs) || timeoutMs <= 0) return BROKER_DEFAULT_TIMEOUT_MS
  return Math.min(Math.ceil(timeoutMs), BROKER_MAX_TIMEOUT_MS)
}

/**
 * Send one request and read its answer, at most `maxBytes` of body. `label`
 * names the far end in failure messages (an origin, never a full URL: a query
 * may hold the credential).
 */
export async function brokerRequest(
  fetchImpl: BrokerFetch,
  url: string,
  init: { method: string; headers: Record<string, string>; body?: string },
  options: { timeoutMs: number; maxBytes: number; label: string },
): Promise<BrokerHttpOutcome> {
  const controller = new AbortController()
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    controller.abort()
  }, options.timeoutMs)
  try {
    let response: Response
    try {
      response = await fetchImpl(url, {
        method: init.method,
        headers: init.headers,
        ...(init.body !== undefined ? { body: init.body } : {}),
        redirect: 'error',
        signal: controller.signal,
      })
    } catch {
      if (timedOut) return timeoutFailure(options)
      // `redirect: 'error'` rejects the fetch itself, indistinguishable by
      // type from a refused connection; neither's own text is safe to pass on.
      return { ok: false, reason: 'failed', message: `The request to ${options.label} failed.` }
    }
    // A runtime that ignores `redirect: 'error'` (a test double, a polyfill)
    // still does not get a redirect's answer through.
    if (
      response.type === 'opaqueredirect' ||
      (response.status >= 300 && response.status < 400 && response.headers.has('location'))
    ) {
      await response.body?.cancel().catch(() => {})
      return {
        ok: false,
        reason: 'redirect',
        message: `${options.label} answered with a redirect, which the host does not follow.`,
      }
    }
    const declared = Number(response.headers.get('content-length'))
    if (Number.isFinite(declared) && declared > options.maxBytes) {
      await response.body?.cancel().catch(() => {})
      return tooLarge(options)
    }
    const body = await readCapped(response, options.maxBytes)
    if (body === 'too_large') return tooLarge(options)
    const headers: Record<string, string> = {}
    response.headers.forEach((value, name) => {
      headers[name.toLowerCase()] = value
    })
    return { ok: true, response: { status: response.status, headers, body } }
  } catch {
    if (timedOut) return timeoutFailure(options)
    return { ok: false, reason: 'failed', message: `Reading the answer from ${options.label} failed.` }
  } finally {
    clearTimeout(timer)
  }
}

async function readCapped(response: Response, maxBytes: number): Promise<string | 'too_large'> {
  if (!response.body) return ''
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > maxBytes) {
      await reader.cancel().catch(() => {})
      return 'too_large'
    }
    chunks.push(value)
  }
  return Buffer.concat(chunks).toString('utf8')
}

function timeoutFailure(options: { timeoutMs: number; label: string }): BrokerHttpOutcome {
  return {
    ok: false,
    reason: 'timeout',
    message: `The request to ${options.label} timed out after ${options.timeoutMs}ms.`,
  }
}

function tooLarge(options: { maxBytes: number; label: string }): BrokerHttpOutcome {
  return {
    ok: false,
    reason: 'too_large',
    message: `The answer from ${options.label} is larger than ${formatBytes(options.maxBytes)}, so it was not read.`,
  }
}

function formatBytes(bytes: number): string {
  return bytes % (1024 * 1024) === 0 ? `${bytes / (1024 * 1024)} MiB` : `${bytes} bytes`
}

/** Every occurrence of `secret` in `text` replaced, so an echoing server cannot hand it back. */
export function redactSecret(text: string, secret: string): string {
  return secret.length > 0 && text.includes(secret) ? text.split(secret).join('[redacted]') : text
}
