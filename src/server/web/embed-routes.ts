import type { IncomingMessage } from 'node:http'

import { secretsMatch } from '../../main/automation/tailnet/secret-hash'
import type { EmbedStore } from './embeds'
import { readBody, sendJson, sendText } from './web-http'
import type { WebExtraRoute } from './web-listener'
import type { WebSessionStore } from './web-sessions'
import type { WebStaticRoot } from './web-static'

// The embed's HTTP routes on the web listener (phase 9 spec, 5.4):
//
//   GET  /embed/conversation/<embedId>   the iframe page, framed only by the embed's origins
//   POST /embed/session                   an embed token for a single-use socket ticket
//   POST /embed/mint                      a new embed, for `studio-server embed` (the run file's key)
//   POST /embed/list                      the embeds, for `studio-server embed --list` (the run file's key)
//   POST /embed/revoke                    revoke one, for `studio-server embed --revoke` (the run file's key)
//
// The page is the web bundle's `embed.html`, served with a
// Content-Security-Policy whose `frame-ancestors` is read from the embed on
// every load, so revoking an embed or changing who may frame it lands on the
// next load. The token travels in the page's fragment, which no server or
// Referer sees; the page trades it here for a ticket and opens `/ws` with it.

const MAX_BODY_BYTES = 16 * 1024
const PAGE = /^\/embed\/conversation\/([\w-]{1,64})\/?$/u

export function createEmbedRoutes(options: {
  embeds: EmbedStore
  sessions: WebSessionStore
  staticRoot: () => WebStaticRoot | null
  pageHeaders: (origin: string, frameAncestors: readonly string[]) => Record<string, string>
  mintKey: string
}): WebExtraRoute {
  async function json(request: IncomingMessage): Promise<Record<string, unknown> | null> {
    try {
      const value = JSON.parse((await readBody(request, MAX_BODY_BYTES)).toString('utf8')) as unknown
      return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null
    } catch {
      return null
    }
  }

  return async ({ request, response, url, origin }) => {
    const method = request.method ?? 'GET'
    const page = PAGE.exec(url.pathname)
    if (page && (method === 'GET' || method === 'HEAD')) {
      const embed = options.embeds.get(page[1])
      const html = options.staticRoot()?.embedHtml() ?? null
      if (!embed || !html) {
        sendText(response, 404, 'This embed does not exist, was revoked, or has expired.')
        return true
      }
      // The page is two levels below the bundle; its relative asset addresses
      // are written for the bundle's root. (`<base>` is refused by the policy.)
      const body = html
        .replaceAll('"./assets/', '"../../assets/')
        .replaceAll('"./fonts/', '"../../fonts/')
        .replace(
          '<head>',
          `<head>\n    <meta name="sprintengine-embed-origins" content="${embed.origins.join(' ')}" />`,
        )
      response.writeHead(200, {
        ...options.pageHeaders(origin, embed.origins),
        'Content-Type': 'text/html; charset=utf-8',
        'Content-Length': String(Buffer.byteLength(body)),
      })
      response.end(method === 'HEAD' ? undefined : body)
      return true
    }

    if (url.pathname === '/embed/session' && method === 'POST') {
      const body = await json(request)
      const embedId = typeof body?.embedId === 'string' ? body.embedId : ''
      const token = typeof body?.token === 'string' ? body.token : ''
      const embed = embedId && token ? options.embeds.authenticate(embedId, token) : null
      if (!embed) {
        sendJson(response, 401, {
          ok: false,
          code: 'embed_unauthorized',
          message: 'This embed was revoked or has expired.',
        })
        return true
      }
      const { ticket, expiresAt } = options.sessions.mintTicket({ kind: 'embed', embedId: embed.embedId })
      sendJson(response, 200, { ok: true, ticket, expiresAt, conversation: embed.conversation })
      return true
    }

    const command = /^\/embed\/(mint|list|revoke)$/u.exec(url.pathname)?.[1]
    if (command && method === 'POST') {
      // `studio-server embed`, like `pair`: a program that read the run file,
      // sending no Origin. The listener let it through the Origin rule for
      // that reason only; a request with an Origin is a page, and is refused.
      const presented = /^Bearer (.+)$/u.exec(request.headers.authorization ?? '')?.[1] ?? ''
      if (request.headers.origin !== undefined || !secretsMatch(presented, options.mintKey)) {
        sendJson(response, 403, { ok: false, message: 'Not allowed.' })
        return true
      }
      if (command === 'list') {
        sendJson(response, 200, { ok: true, embeds: options.embeds.list() })
        return true
      }
      const body = await json(request)
      if (command === 'revoke') {
        const embedId = typeof body?.embedId === 'string' ? body.embedId : ''
        const revoked = embedId !== '' && options.embeds.revoke(embedId)
        sendJson(
          response,
          revoked ? 200 : 404,
          revoked ? { ok: true } : { ok: false, message: 'No embed by that id: it was revoked, or it expired.' },
        )
        return true
      }
      const created = options.embeds.create({
        conversation: { workspaceId: body?.workspaceId, agentId: body?.agentId },
        origins: body?.origins,
        ttlMs: body?.ttlMs,
        live: body?.live,
      })
      if (!created.ok) {
        sendJson(response, 400, created)
        return true
      }
      sendJson(response, 200, {
        ok: true,
        embed: created.embed,
        url: `${origin}/embed/conversation/${created.embed.embedId}#token=${created.token}`,
      })
      return true
    }
    return false
  }
}
