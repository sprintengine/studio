// Pure helpers for the backlog "Mockups" attachment surface (MC-1485). No React,
// no `window` — so every rule here (parse, body detection, path resolution) is
// unit-testable in isolation (see backlogMockups.test.ts).
//
// An attachment is authored intent, stored exactly like `dependsOn`: a single
// comma-separated `mockups:` frontmatter line of project-relative paths. Beyond
// the attached list, the body of an item often already links its mockup in prose
// (`Mockup: [x](../mockups/x.html)`); those references light up the same section
// read-only, so every existing item gets the feature with zero migration.

import { parseBacklogCsvList } from './frontmatter'
import type { BacklogItem } from './scan'

export type BacklogMockupSource = 'attached' | 'detected'

// One mockup shown in the section. `path` is project-root-relative (or, for a
// legacy `backlog/`-relative ref, exactly as authored — the resolver below is
// tolerant across both roots). `source` decides whether the row is removable
// (attached) or read-only (detected from the body).
export type BacklogMockupEntry = {
  path: string
  source: BacklogMockupSource
}

// Collapse `.`/`..` segments and duplicate/leading slashes into a clean
// forward-slash relative path. Shared by every normalizer below so "the path" is
// one shape everywhere. A `..` that would climb above the root is dropped rather
// than kept (callers never want to escape the workspace).
function collapseRelativePath(pathValue: string): string {
  const parts = pathValue.replace(/\\/g, '/').split('/')
  const out: string[] = []
  for (const part of parts) {
    if (part === '' || part === '.') continue
    if (part === '..') {
      out.pop()
      continue
    }
    out.push(part)
  }
  return out.join('/')
}

// A ref points outside the workspace (or nowhere useful) when it is an http(s)
// URL, a protocol-relative `//host` URL, an absolute POSIX path, or a Windows
// drive/UNC path. Those are never workspace attachments, so they are skipped by
// both the parser and the body detector.
function isExternalOrAbsoluteRef(ref: string): boolean {
  return (
    /^[a-z][a-z0-9+.-]*:/i.test(ref) || // scheme: (http:, https:, mailto:, file:, …)
    ref.startsWith('//') ||
    ref.startsWith('/') ||
    ref.startsWith('\\\\') ||
    /^[A-Za-z]:[\\/]/.test(ref)
  )
}

// Whether a ref names an HTML file, ignoring any `#fragment` or `?query` tail
// (case-insensitive). Only `.html`/`.htm` refs are treated as mockups by the
// body detector.
function isHtmlRef(ref: string): boolean {
  const withoutTail = ref.replace(/[?#].*$/, '')
  return /\.html?$/i.test(withoutTail)
}

// Parse the flat comma-separated `mockups:` frontmatter scalar into a clean list
// of project-relative paths, exactly mirroring how `dependsOn` is read: split via
// the shared CSV helper, normalize `\` → `/`, then drop empties, absolute paths,
// and anything containing a `..` segment (a stored mockup path can never escape
// the workspace). Deduped, first-seen order preserved.
export function parseBacklogMockups(raw: string | undefined): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  for (const entry of parseBacklogCsvList(raw)) {
    const normalized = entry.replace(/\\/g, '/').trim()
    if (!normalized) continue
    if (isExternalOrAbsoluteRef(normalized)) continue
    // Reject any `..` segment outright (not just collapse it): a stored path is
    // authored intent and must stay inside the workspace by construction.
    if (normalized.split('/').includes('..')) continue
    const clean = collapseRelativePath(normalized)
    if (!clean || seen.has(clean)) continue
    seen.add(clean)
    out.push(clean)
  }
  return out
}

// Directory of an item's file (project-relative), for resolving `../`-style body
// refs. `backlog/2026-07-06-foo.md` → `backlog`; a root-level file → ''.
function itemDirectory(itemRelativePath: string): string {
  const normalized = collapseRelativePath(itemRelativePath)
  const slash = normalized.lastIndexOf('/')
  return slash === -1 ? '' : normalized.slice(0, slash)
}

// Scan an item's markdown body for references to HTML mockups, resolved to
// project-root-relative paths. Two syntaxes are recognized:
//   (a) markdown link targets — `](target)`, title and `<>` wrapper stripped;
//   (b) inline backtick spans — `` `path` ``.
// External/absolute refs are skipped. A `./`- or `../`-relative ref is resolved
// against the item file's directory (so `backlog/foo.md` linking
// `../mockups/x.html` → `mockups/x.html`); any other ref is already understood as
// root-relative and kept as-is (a bare `mockups/x.html` stays `mockups/x.html`).
// Deduped, first-seen order preserved.
export function detectBacklogMockupReferences(
  sourceContent: string,
  itemRelativePath: string,
): string[] {
  const dir = itemDirectory(itemRelativePath)
  const out: string[] = []
  const seen = new Set<string>()

  const add = (rawRef: string): void => {
    // Strip a `<>` wrapper, then a `#fragment`/`?query` tail — neither is part of
    // the on-disk path (and srcDoc previews can't act on a fragment anyway).
    const ref = rawRef.trim().replace(/^<|>$/g, '').replace(/[?#].*$/, '').trim()
    if (!ref || isExternalOrAbsoluteRef(ref) || !isHtmlRef(ref)) return
    const resolved =
      ref.startsWith('./') || ref.startsWith('../')
        ? collapseRelativePath(dir ? `${dir}/${ref}` : ref)
        : collapseRelativePath(ref)
    if (!resolved || seen.has(resolved)) return
    seen.add(resolved)
    out.push(resolved)
  }

  // Markdown link targets: `](target)` or `](target "title")` — the target is
  // everything up to the first whitespace (which begins an optional title).
  for (const match of sourceContent.matchAll(/\]\(([^)]+)\)/g)) {
    add(match[1].split(/\s+/)[0] ?? '')
  }
  // Inline code spans: `` `path` `` (single-line only; a span spanning a newline
  // is body prose, not a path).
  for (const match of sourceContent.matchAll(/`([^`\n]+)`/g)) {
    add(match[1])
  }

  return out
}

// A cross-root identity key for a mockup ref: the collapsed path with any leading
// `backlog/` stripped, so the same file authored root-relative
// (`backlog/mockups/x.html`) and `backlog/`-relative (`mockups/x.html`) — the two
// tolerated roots (amendment 2) — is recognized as one file for dedup, matching
// how backlogMockupResolutionCandidates unifies them at existence-check time.
function canonicalMockupKey(path: string): string {
  const clean = collapseRelativePath(path.replace(/\\/g, '/'))
  return clean.startsWith('backlog/') ? clean.slice('backlog/'.length) : clean
}

// The section's full row set: the item's attached mockups (frontmatter, removable)
// first, then any body-detected references not already attached (read-only),
// compared on the cross-root identity key so the same file authored two ways is
// not shown twice.
export function collectBacklogMockups(
  item: Pick<BacklogItem, 'mockups' | 'sourceContent' | 'relativePath'>,
): BacklogMockupEntry[] {
  const entries: BacklogMockupEntry[] = []
  const seen = new Set<string>()
  for (const path of item.mockups ?? []) {
    const clean = collapseRelativePath(path.replace(/\\/g, '/'))
    const key = canonicalMockupKey(clean)
    if (!clean || seen.has(key)) continue
    seen.add(key)
    entries.push({ path: clean, source: 'attached' })
  }
  for (const path of detectBacklogMockupReferences(item.sourceContent, item.relativePath)) {
    const key = canonicalMockupKey(path)
    if (seen.has(key)) continue
    seen.add(key)
    entries.push({ path, source: 'detected' })
  }
  return entries
}

// The tolerant cross-root resolver (MC-1485 amendment 2, shared with MC-1697's
// scan-time dangling-reference check): a `mockups:` path may be authored
// project-root-relative (`backlog/mockups/x.html`, the canonical home) OR
// `backlog/`-relative (`mockups/x.html`, written by the review-workspace and
// roadmap-redesign items). Return the candidate root-relative paths to probe for
// existence, in resolution order: the ref as written first, then the same ref
// under `backlog/`. One definition so the feature's missing-row check and the
// engine-side reference check never drift.
export function backlogMockupResolutionCandidates(ref: string): string[] {
  const clean = collapseRelativePath(ref.replace(/\\/g, '/'))
  if (!clean) return []
  const candidates = [clean]
  if (!clean.startsWith('backlog/')) candidates.push(`backlog/${clean}`)
  return candidates
}

// The one probe-in-resolution-order loop over the candidates above: returns the
// first candidate the probe resolves, or null when the ref dangles. The probe
// decides what "resolves" means (exists on disk, readable content, …) and
// reports a miss as null or by throwing — both advance to the next candidate.
// Every consumer of the tolerated-roots rule goes through here so the probing
// behavior can never drift between the section UI, the preview, and the sprint
// source enrichment.
export async function resolveFirstMockupCandidate<T>(
  ref: string,
  probe: (relativePath: string) => Promise<T | null>,
): Promise<T | null> {
  for (const relativePath of backlogMockupResolutionCandidates(ref)) {
    try {
      const result = await probe(relativePath)
      if (result !== null) return result
    } catch {
      // A probe error is a miss for this candidate root.
    }
  }
  return null
}

// The scan-time dangling-reference check (MC-1697): every mockup an item names —
// attached (`mockups:`) or body-detected — that resolves to no file under either
// tolerated root. `exists` probes a root-relative path (typically a filesystem
// existence check); a ref is dangling only when NEITHER candidate root resolves,
// so the same file authored `mockups/x.html` or `backlog/mockups/x.html` is never
// falsely flagged. Refs are returned in first-seen order, exactly as
// collectBacklogMockups surfaces them (so the row warning and the detail-pane
// "Missing" rows name the same set). Pure of any UI — the caller supplies the
// probe — so it unit-tests without the filesystem.
export async function collectDanglingMockups(
  item: Pick<BacklogItem, 'mockups' | 'sourceContent' | 'relativePath'>,
  exists: (relativePath: string) => Promise<boolean>,
): Promise<string[]> {
  const dangling: string[] = []
  for (const entry of collectBacklogMockups(item)) {
    const found = await resolveFirstMockupCandidate(entry.path, async (relativePath) =>
      (await exists(relativePath)) ? relativePath : null,
    )
    if (found === null) dangling.push(entry.path)
  }
  return dangling
}
