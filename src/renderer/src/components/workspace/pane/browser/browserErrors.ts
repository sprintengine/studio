import type { BrowserLoadError } from '../../../../../../shared/browser'

// One friendly line per Chromium net error the pane is likely to meet; the raw
// ERR_* name stays on the page beneath it. Anything not listed keeps the
// description Chromium sent.

const FRIENDLY: Record<string, string> = {
  ERR_CONNECTION_REFUSED: 'refused to connect.',
  ERR_CONNECTION_RESET: 'reset the connection.',
  ERR_CONNECTION_CLOSED: 'closed the connection.',
  ERR_CONNECTION_TIMED_OUT: 'took too long to respond.',
  ERR_TIMED_OUT: 'took too long to respond.',
  ERR_NAME_NOT_RESOLVED: 'could not be found.',
  ERR_ADDRESS_UNREACHABLE: 'is unreachable.',
  ERR_INTERNET_DISCONNECTED: 'is unreachable — no network.',
  ERR_CERT_AUTHORITY_INVALID: 'uses a certificate this app does not trust.',
  ERR_CERT_COMMON_NAME_INVALID: 'uses a certificate for another host.',
  ERR_CERT_DATE_INVALID: 'uses an expired certificate.',
  ERR_SSL_PROTOCOL_ERROR: 'did not speak HTTPS on that port.',
  ERR_EMPTY_RESPONSE: 'sent an empty response.',
  ERR_TOO_MANY_REDIRECTS: 'redirected too many times.',
  ERR_BLOCKED_BY_RESPONSE: 'refused to be embedded.',
  ERR_INVALID_URL: 'is not a valid address.',
}

export type BrowserErrorCopy = {
  heading: string
  line: string
  code: string
}

export function describeBrowserError(error: BrowserLoadError): BrowserErrorCopy {
  let host = ''
  try {
    host = new URL(error.url).host
  } catch {
    host = error.url
  }
  const code = error.description || `ERR_${error.code}`
  const friendly = FRIENDLY[code]
  if (code.startsWith('RENDERER_')) {
    return { heading: 'The page stopped responding', line: 'Reload to start it again.', code }
  }
  return {
    heading: "This site can't be reached",
    line: friendly ? `${host || 'The server'} ${friendly}` : host ? `${host} did not load.` : 'The page did not load.',
    code,
  }
}
