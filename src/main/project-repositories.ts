import { lstatSync, readdirSync, readFileSync, realpathSync, statSync, type Dirent } from 'fs'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'path'

import {
  PROJECT_REPOSITORY_LIMIT,
  type ProjectRepositories,
  type ProjectRepository,
} from '../shared/project-repositories'

// Which repositories a project folder holds, when it is not one itself
// (`docs/design/multi-repo-projects.md`, section 3). The rules, in order:
//
//  * A folder in a repository is never a multi-repository project: the
//    repository it is in is the project, and what lies below is that
//    repository's (submodules, nested clones). Found by looking for a `.git`
//    entry in the folder and each ancestor, the walk git itself makes, with no
//    git process.
//  * One `.code-workspace` file directly in the folder lists the members, in
//    its order. Two such files are ambiguous, and one that does not parse or
//    lists no repository says nothing; each falls back to the children.
//  * Otherwise, the immediate child folders that have a `.git` entry. Never
//    recursive, never through a symlink, never a hidden folder (the worktree
//    pool keeps every member's worktrees in `.sprintengine-worktrees`).
//  * Never outside the folder, by path or by symlink, and at most three
//    folders down; a member inside another member is that member's business.
//  * At most PROJECT_REPOSITORY_LIMIT, with `truncated` saying there are more.
//
// Synchronous on purpose: a terminal launch builds its host context
// synchronously, and the reads are a directory listing and one `lstat` per
// child and per ancestor. Cached per folder for half a minute and keyed by the
// folder's own modification time, so a clone added beside the others is seen
// on the next read; no watcher, since a project changes shape about never.

const HOLD_MS = 30_000
const HELD_LIMIT = 64
// `services/billing/api` and no deeper: a workspace entry further down is a
// folder inside something, not a project's member.
const MAX_ENTRY_DEPTH = 3
// A workspace file is a few hundred bytes; one this size is not one.
const WORKSPACE_FILE_BYTES = 256 * 1024
const SKIPPED_CHILDREN = new Set(['node_modules'])

type Held = { at: number; mtimeMs: number; answer: ProjectRepositories | null }
const held = new Map<string, Held>()

export type DiscoverProjectRepositoriesOptions = {
  /** Read the folder again rather than answer from the last read. */
  refresh?: boolean
  now?: number
}

/**
 * The repositories `folder` holds, or null when it holds none, is in a
 * repository itself, or cannot be read. Never throws.
 */
export function discoverProjectRepositories(
  folder: string | null | undefined,
  options: DiscoverProjectRepositoriesOptions = {},
): ProjectRepositories | null {
  if (!folder?.trim() || !isAbsolute(folder)) return null
  const root = resolve(folder)
  const info = statOrNull(root)
  if (!info?.isDirectory()) {
    held.delete(root)
    return null
  }
  const now = options.now ?? Date.now()
  const cached = held.get(root)
  if (!options.refresh && cached && now - cached.at < HOLD_MS && cached.mtimeMs === info.mtimeMs) return cached.answer
  let answer: ProjectRepositories | null = null
  try {
    answer = readProjectRepositories(root)
  } catch {
    answer = null
  }
  if (held.size >= HELD_LIMIT && !held.has(root)) {
    const oldest = held.keys().next().value
    if (oldest !== undefined) held.delete(oldest)
  }
  held.set(root, { at: now, mtimeMs: info.mtimeMs, answer })
  return answer
}

/** Forget every cached answer. For tests. */
export function clearProjectRepositoriesCache(): void {
  held.clear()
}

type Candidate = { path: string; relativePath: string }

function readProjectRepositories(root: string): ProjectRepositories | null {
  if (insideRepository(root)) return null
  const entries = readdirSync(root, { withFileTypes: true })
  const fromFile = workspaceFileCandidates(root, entries)
  if (fromFile) {
    const members = repositoryMembers(fromFile.candidates)
    if (members.length > 0) return answerOf(root, { kind: 'code-workspace', file: fromFile.file }, members)
  }
  const members = repositoryMembers(childCandidates(root, entries))
  return members.length > 0 ? answerOf(root, { kind: 'children' }, members) : null
}

function answerOf(root: string, source: ProjectRepositories['source'], members: Candidate[]): ProjectRepositories {
  const repositories: ProjectRepository[] = members
    .slice(0, PROJECT_REPOSITORY_LIMIT)
    .map((member) => ({ path: member.path, relativePath: member.relativePath, name: basename(member.path) }))
  return { root, source, repositories, truncated: members.length > PROJECT_REPOSITORY_LIMIT }
}

/** The folder, or an ancestor, has a `.git` entry: it is in a work tree. */
function insideRepository(root: string): boolean {
  let directory = root
  for (;;) {
    if (hasGitEntry(directory)) return true
    const parent = dirname(directory)
    if (parent === directory) return false
    directory = parent
  }
}

function hasGitEntry(directory: string): boolean {
  try {
    return lstatSync(join(directory, '.git'), { throwIfNoEntry: false }) !== undefined
  } catch {
    return false
  }
}

function statOrNull(path: string) {
  try {
    return statSync(path, { throwIfNoEntry: false }) ?? null
  } catch {
    return null
  }
}

/**
 * Candidates that are repository roots, in order, with any candidate inside
 * another dropped: the outer one owns it, as a submodule or a nested clone.
 */
function repositoryMembers(candidates: Candidate[]): Candidate[] {
  const seen = new Set<string>()
  const repositories = candidates.filter((candidate) => {
    if (seen.has(candidate.relativePath)) return false
    seen.add(candidate.relativePath)
    return hasGitEntry(candidate.path)
  })
  return repositories.filter(
    (candidate) =>
      !repositories.some((other) => other !== candidate && candidate.relativePath.startsWith(`${other.relativePath}/`)),
  )
}

function childCandidates(root: string, entries: Dirent[]): Candidate[] {
  return entries
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.') && !SKIPPED_CHILDREN.has(entry.name))
    .map((entry) => entry.name)
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
    .map((name) => ({ path: join(root, name), relativePath: name }))
}

/**
 * The folders the one `.code-workspace` file in `root` lists, each resolved and
 * kept only when it is inside `root`. Null when there is not exactly one such
 * file, or it does not parse.
 */
function workspaceFileCandidates(root: string, entries: Dirent[]): { file: string; candidates: Candidate[] } | null {
  const files = entries.filter((entry) => entry.isFile() && entry.name.endsWith('.code-workspace'))
  if (files.length !== 1) return null
  const file = files[0].name
  let parsed: unknown
  try {
    const path = join(root, file)
    if ((statOrNull(path)?.size ?? Infinity) > WORKSPACE_FILE_BYTES) return null
    parsed = parseJsonWithComments(readFileSync(path, 'utf8'))
  } catch {
    return null
  }
  const folders = (parsed as { folders?: unknown } | null)?.folders
  if (!Array.isArray(folders)) return null
  let realRoot: string
  try {
    realRoot = realpathSync(root)
  } catch {
    return null
  }
  const candidates: Candidate[] = []
  for (const entry of folders) {
    const listed = (entry as { path?: unknown } | null)?.path
    if (typeof listed !== 'string' || !listed.trim()) continue
    const candidate = insideCandidate(root, realRoot, listed.trim())
    if (candidate) candidates.push(candidate)
  }
  return { file, candidates }
}

/** `listed` resolved against `root`, or null when it is `root` itself, outside it, or too deep. */
function insideCandidate(root: string, realRoot: string, listed: string): Candidate | null {
  const path = resolve(root, listed)
  const relativePath = within(root, path)
  if (!relativePath || relativePath.split('/').length > MAX_ENTRY_DEPTH) return null
  // A folder inside by name can still lead out through a symlink.
  let real: string
  try {
    real = realpathSync(path)
  } catch {
    return null
  }
  if (!within(realRoot, real)) return null
  return { path, relativePath }
}

/** `path` below `root`, with `/` separators; null for `root` itself or anywhere outside it. */
function within(root: string, path: string): string | null {
  const rel = relative(root, path)
  if (!rel || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return null
  return rel.split(sep).join('/')
}

/**
 * JSON with the two liberties a workspace file takes: `//` and `/* *\/`
 * comments, and a trailing comma before `}` or `]`. Strings are copied as they
 * are, so a `//` inside a path survives. Throws as `JSON.parse` does.
 */
export function parseJsonWithComments(text: string): unknown {
  return JSON.parse(withoutTrailingCommas(withoutComments(text.replace(/^﻿/u, ''))))
}

/** Index just past the string literal opening at `start`. */
function stringEnd(text: string, start: number): number {
  let index = start + 1
  while (index < text.length && text[index] !== '"') index += text[index] === '\\' ? 2 : 1
  return index + 1
}

function withoutComments(text: string): string {
  let out = ''
  let index = 0
  while (index < text.length) {
    const char = text[index]
    if (char === '"') {
      const end = stringEnd(text, index)
      out += text.slice(index, end)
      index = end
    } else if (char === '/' && text[index + 1] === '/') {
      while (index < text.length && text[index] !== '\n') index++
    } else if (char === '/' && text[index + 1] === '*') {
      const end = text.indexOf('*/', index + 2)
      index = end < 0 ? text.length : end + 2
    } else {
      out += char
      index++
    }
  }
  return out
}

function withoutTrailingCommas(text: string): string {
  let out = ''
  let index = 0
  while (index < text.length) {
    const char = text[index]
    if (char === '"') {
      const end = stringEnd(text, index)
      out += text.slice(index, end)
      index = end
      continue
    }
    if (char === ',') {
      let next = index + 1
      while (next < text.length && /\s/u.test(text[next])) next++
      if (text[next] === '}' || text[next] === ']') {
        index++
        continue
      }
    }
    out += char
    index++
  }
  return out
}
