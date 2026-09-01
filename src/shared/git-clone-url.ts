/**
 * Validation and normalization for a clone source URL, shared by the main
 * process (which refuses to spawn git on anything else) and the renderer's
 * new-workspace picker (which derives the folder leaf and inline errors).
 *
 * Only real transports pass: https, ssh://, or scp-style git@host:path. A
 * leading dash, an exotic transport (ext::, file://), or embedded whitespace
 * is rejected outright — this string reaches a git argv.
 */

export type CloneUrlValidation =
  | { ok: true; url: string; httpsHost: string | null; repoName: string }
  | { ok: false; error: string }

const SCP_LIKE = /^([A-Za-z0-9_][A-Za-z0-9_.-]*)@([A-Za-z0-9][A-Za-z0-9.-]*):([A-Za-z0-9_.~-][A-Za-z0-9_./~-]*?)(\.git)?\/?$/

function repoNameFromPath(path: string): string {
  const segments = path.split('/').filter(Boolean)
  const last = segments[segments.length - 1] ?? ''
  return last.replace(/\.git$/i, '')
}

export function validateCloneUrl(raw: string): CloneUrlValidation {
  const trimmed = raw.trim()
  if (!trimmed) return { ok: false, error: 'Enter a repository URL.' }
  if (trimmed.startsWith('-') || /\s/.test(trimmed)) {
    return { ok: false, error: 'That does not look like a repository URL.' }
  }

  if (/^https:\/\//i.test(trimmed)) {
    let parsed: URL
    try {
      parsed = new URL(trimmed)
    } catch {
      return { ok: false, error: 'That does not look like a repository URL.' }
    }
    if (parsed.username || parsed.password) {
      return { ok: false, error: 'Remove the credentials from the URL — authentication uses the saved token.' }
    }
    const host = parsed.hostname.toLowerCase()
    let pathname = parsed.pathname.replace(/\/+$/, '')
    // A pasted github.com PAGE URL often carries a sub-path (/tree/main,
    // /blob/..., /pulls); the repository is always the first two segments,
    // so normalize to the repo root instead of handing git a 404.
    if (host === 'github.com') {
      const segments = pathname.split('/').filter(Boolean)
      if (segments.length > 2) pathname = `/${segments[0]}/${segments[1]}`
    }
    const repoName = repoNameFromPath(pathname)
    if (!repoName) return { ok: false, error: 'The URL is missing a repository path.' }
    // Normalize away fragments/queries and a trailing slash; git accepts the
    // web form of a github.com repo URL as-is.
    return { ok: true, url: `${parsed.origin}${pathname}`, httpsHost: host, repoName }
  }

  if (/^ssh:\/\//i.test(trimmed)) {
    let parsed: URL
    try {
      parsed = new URL(trimmed)
    } catch {
      return { ok: false, error: 'That does not look like a repository URL.' }
    }
    const repoName = repoNameFromPath(parsed.pathname)
    if (!repoName) return { ok: false, error: 'The URL is missing a repository path.' }
    return { ok: true, url: trimmed, httpsHost: null, repoName }
  }

  const scp = trimmed.match(SCP_LIKE)
  if (scp) {
    const repoName = repoNameFromPath(scp[3])
    if (!repoName) return { ok: false, error: 'The URL is missing a repository path.' }
    return { ok: true, url: trimmed, httpsHost: null, repoName }
  }

  if (/^http:\/\//i.test(trimmed)) {
    return { ok: false, error: 'Only https and ssh repository URLs are supported.' }
  }
  return { ok: false, error: 'Enter an https URL (https://github.com/owner/repo) or an ssh clone URL.' }
}
