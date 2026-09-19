export type SafeExternalUrl = { ok: true; url: string } | { ok: false; message: string }

// Terminal output is untrusted: only hand http/https to the OS so that schemes
// like file:, vscode:, or custom protocol handlers cannot be triggered by
// clicking text a process happened to print into the terminal.
export function safeExternalUrl(url: unknown): SafeExternalUrl {
  if (typeof url !== 'string' || url.trim() === '') {
    return { ok: false, message: 'No link to open.' }
  }
  let protocol: string
  try {
    protocol = new URL(url).protocol
  } catch {
    return { ok: false, message: `Not a valid link: ${url}` }
  }
  if (protocol !== 'http:' && protocol !== 'https:') {
    return { ok: false, message: `Cannot open ${protocol} links from the terminal.` }
  }
  return { ok: true, url }
}
