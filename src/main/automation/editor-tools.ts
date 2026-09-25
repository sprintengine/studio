import { dirname } from 'node:path'

import {
  clampEditorRange,
  EDITOR_NOTE_MAX_CHARS,
  EDITOR_OPEN_MAX_FILES,
  editorFileName,
  parseEditorLocation,
  parseEditorNote,
  type EditorDiffChanges,
  type EditorLocation,
  type EditorRevealDiffTarget,
  type EditorRevealFileTarget,
  type EditorRevealReason,
  type EditorRevealRequest,
  type EditorRevealShown,
  type EditorWindowState,
} from '../../shared/editor-reveal'
import { changelistOwnerId, normalizeChangelistPath } from '../../shared/git/changelists'
import { comparablePath, distroOfUncPath } from '../../shared/host-paths'
import { distroOfHostId, isWslHostId } from '../../shared/execution-host'
import type { McpConnectionContext, McpToolRegistration, McpToolResult } from '../../shared/modules/mcp-tools'
import {
  classifyAgentPath,
  displayPathFor,
  isInsideComparable,
  resolveAgentPath,
  type AgentPathContext,
  type PathPolicyFs,
  type ResolvedAgentPath,
} from '../editor-reveal/path-policy'

// The editor.* family: an agent puts files, or a diff, in front of the person at
// the lines it means — instead of pasting paths into its reply and hoping.
//
// Opening is a MUTATION for the gateway's two purposes (studio-gateway-tools):
// every call is audited, and a paired device needs `workspace:operate` to make
// one. It changes what is on the person's screen, which is the whole of what
// "state" means to them. `editor.state` only looks.
export const EDITOR_MUTATION_TOOL_NAMES: readonly string[] = ['editor.open', 'editor.open_diff']

/** What the tools need to know about the agent session that is calling. */
export type EditorAgentSession = {
  cwd: string | null
  worktreePath: string | null
  /** Where the session's hooks last saw it, resolved to a checkout by git. */
  gitRoot: string | null
  hostId: string | null
  pathStyle: string | null
  /** The files this session has reported editing. */
  fileChanges: readonly string[]
}

/** A diff view's changed files, repo-relative and posix. */
export type EditorDiffSource = {
  workingTree(repoRoot: string): Promise<Array<{ relativePath: string; staged: boolean; unstaged: boolean }>>
  branch(repoRoot: string): Promise<string[]>
  commit(repoRoot: string, hash: string): Promise<string[]>
  /** A revision to its full commit hash, or null when it names none. */
  resolveCommit(repoRoot: string, revision: string): Promise<string | null>
  /** The full hashes of the commits the branch holds over its base — the steps the diff pane walks. */
  branchCommits(repoRoot: string): Promise<string[]>
  /** The agent's changelist, or null when it has none in this repository. */
  agentChangelistPaths(repoRoot: string, agentId: string): Promise<string[] | null>
}

export type EditorToolsDeps = {
  findWorkspace(workspaceId: string): { folderPath: string | null } | null
  findAgentSession(workspaceId: string, agentId: string): EditorAgentSession | null
  /** Every file this agent reported writing since the app started, any repository. */
  agentWrittenPaths(agentId: string): Iterable<string>
  resolveRepoRoot(directory: string): Promise<string | null>
  listWorktreePaths(repoRoot: string): Promise<string[]>
  fs: PathPolicyFs
  homeDir(): string
  userDataDir(): string
  reveal(request: Omit<EditorRevealRequest, 'requestId'>): Promise<{ shown: EditorRevealShown }>
  queryState(workspaceId: string): Promise<EditorWindowState | null>
  hasPendingReveal(workspaceId: string): boolean
  isAppFocused(): boolean
  diff: EditorDiffSource
}

const CHANGES: readonly EditorDiffChanges[] = ['uncommitted', 'branch', 'staged', 'unstaged', 'commit']
const MAX_DIFF_PATHS = 200
/** The file list in an open_diff answer: enough to talk about, not the whole checkout. */
const MAX_LISTED_DIFF_FILES = 50
const COMMIT_REVISION = /^[0-9A-Za-z._/@^~-]{1,200}$/

type ClassifiedLocation = {
  location: EditorLocation
  resolved: ResolvedAgentPath | null
  entry: FileEntry
  target: EditorRevealFileTarget | null
}

type FileEntry = {
  path: string
  displayPath: string
  status: 'opened' | 'awaiting_owner' | 'refused'
  reason: EditorRevealReason | null
  lineCount?: number
  view?: 'file' | 'diff'
  message?: string
}

function success(structured: Record<string, unknown>): McpToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(structured, null, 2) }], structuredContent: structured }
}

function failure(code: string, message: string): McpToolResult {
  const structured = { error: { code, message } }
  return {
    content: [{ type: 'text', text: JSON.stringify(structured, null, 2) }],
    structuredContent: structured,
    isError: true,
  }
}

function str(args: Record<string, unknown>, key: string): string | null {
  const value = args[key]
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

const LOCATION_SCHEMA = {
  type: 'object',
  properties: {
    path: { type: 'string', description: 'Absolute, or relative to your working directory.' },
    range: {
      type: 'object',
      description: '1-based and inclusive, like file:line. Scrolls there and highlights it briefly.',
      properties: {
        startLine: { type: 'integer', minimum: 1 },
        endLine: { type: 'integer', minimum: 1 },
        startColumn: { type: 'integer', minimum: 1 },
        endColumn: { type: 'integer', minimum: 1 },
      },
      required: ['startLine'],
      additionalProperties: false,
    },
    view: {
      type: 'string',
      enum: ['file', 'diff'],
      description: '"diff" shows the file\'s uncommitted diff instead of the file. Default "file".',
    },
    side: {
      type: 'string',
      enum: ['modified', 'original'],
      description: 'Which side of a diff `range` counts on. Default "modified" (the new text).',
    },
  },
  required: ['path'],
  additionalProperties: false,
} as const

const NOTE_SCHEMA = {
  type: 'string',
  maxLength: EDITOR_NOTE_MAX_CHARS,
  description: `One line shown above the editor, e.g. "The retry loop you asked about". At most ${EDITOR_NOTE_MAX_CHARS} characters.`,
} as const

const WORKSPACE_SCHEMA = {
  type: 'string',
  description: "Only for a connection that is not an agent's own; a Studio agent is bound to its workspace.",
} as const

/**
 * The shown/not-shown sentence an agent should relay. Written here once so
 * every tool says it the same way, and so the one instruction that matters —
 * do not retry into a window nobody is looking at — rides every answer.
 */
function shownNote(shown: EditorRevealShown): string | undefined {
  if (shown === 'background')
    return 'The person was typing, so it opened behind their current tab. Tell them it is there.'
  if (shown === 'not_visible') {
    return 'No window is showing this workspace right now. It will open when the person switches to it; say so in your reply and do not retry.'
  }
  return undefined
}

export function createEditorTools(deps: EditorToolsDeps): McpToolRegistration[] {
  function resolveWorkspace(args: Record<string, unknown>, context?: McpConnectionContext): string | McpToolResult {
    const bound = context?.metadata.workspaceId
    const explicit = str(args, 'workspaceId')
    if (bound && explicit && explicit !== bound) {
      return failure('forbidden', 'This connection is bound to its own workspace; drop `workspaceId`.')
    }
    const workspaceId = bound ?? explicit
    if (!workspaceId) return failure('no_workspace', 'This connection is not bound to a workspace; pass `workspaceId`.')
    if (!deps.findWorkspace(workspaceId)) {
      return failure('unknown_workspace', `Workspace "${workspaceId}" is not known to the running app.`)
    }
    return workspaceId
  }

  type CallScope = {
    workspaceId: string
    workspaceRoot: string | null
    agentId: string | null
    agentName: string | null
    remote: boolean
    session: EditorAgentSession | null
    pathContext: AgentPathContext
  }

  function scopeOf(workspaceId: string, context?: McpConnectionContext): CallScope {
    const metadata = context?.metadata
    const remote = metadata?.kind === 'remote-tailnet'
    // A paired device is not an agent on this machine, whatever it declared.
    const agentId = !remote && metadata?.agentId ? metadata.agentId : null
    const workspaceRoot = deps.findWorkspace(workspaceId)?.folderPath ?? null
    const session = agentId ? deps.findAgentSession(workspaceId, agentId) : null
    const wsl =
      session && (isWslHostId(session.hostId) || session.pathStyle === 'wsl')
        ? { distro: distroOfHostId(session.hostId) ?? distroOfUncPath(session.cwd ?? workspaceRoot ?? '') }
        : null
    return {
      workspaceId,
      workspaceRoot,
      agentId,
      // The name the strip says is speaking. A paired device's declared agent
      // name is not proof of anything, so it is named as the device it is.
      agentName: remote ? (metadata?.deviceName ?? 'A paired device') : (metadata?.agentName ?? null),
      remote,
      session,
      pathContext: {
        // Relative paths are relative to where the agent runs: its own cwd,
        // which for an isolated agent is its worktree.
        cwd: session?.cwd ?? session?.worktreePath ?? workspaceRoot,
        wsl,
        homeDir: deps.homeDir(),
      },
    }
  }

  /**
   * Tier 1, real paths: the workspace folder, the agent's cwd and worktree, the
   * checkout its hooks last saw it in, and every worktree of those
   * repositories. A paired device gets the workspace's own folders only.
   */
  async function trustedRootsOf(scope: CallScope): Promise<string[]> {
    const roots = new Set<string>()
    if (scope.workspaceRoot) roots.add(scope.workspaceRoot)
    // A paired device is shown the workspace folder and nothing wider.
    if (!scope.remote) {
      // The agent's LAUNCH directories — never the checkout its hooks last
      // reported: an agent that `cd`s into another repository must not widen
      // what it may show by doing so.
      if (scope.session?.cwd) roots.add(scope.session.cwd)
      if (scope.session?.worktreePath) roots.add(scope.session.worktreePath)
      // Every worktree of the workspace's own repository.
      const repo = scope.workspaceRoot ? await deps.resolveRepoRoot(scope.workspaceRoot).catch(() => null) : null
      if (repo) {
        roots.add(repo)
        for (const worktree of await deps.listWorktreePaths(repo).catch(() => [] as string[])) roots.add(worktree)
      }
    }
    const real: string[] = []
    for (const root of roots) {
      real.push(root)
      const resolved = await deps.fs.realpath(root).catch(() => null)
      if (resolved && comparablePath(resolved) !== comparablePath(root)) real.push(resolved)
    }
    return real
  }

  function writtenSetOf(scope: CallScope): Set<string> {
    const written = new Set<string>()
    if (scope.remote || !scope.agentId) return written
    const add = (raw: string): void => {
      const resolved = resolveAgentPath(raw, scope.pathContext)
      if (resolved.ok) written.add(comparablePath(resolved.value.path))
    }
    for (const path of deps.agentWrittenPaths(scope.agentId)) add(path)
    for (const path of scope.session?.fileChanges ?? []) add(path)
    return written
  }

  async function classifyLocations(scope: CallScope, locations: EditorLocation[]): Promise<ClassifiedLocation[]> {
    const trust = {
      trustedRoots: await trustedRootsOf(scope),
      agentWritten: writtenSetOf(scope),
      remote: scope.remote,
      homeDir: deps.homeDir(),
      userDataDir: deps.userDataDir(),
    }
    const out: ClassifiedLocation[] = []
    for (const location of locations) {
      const resolved = resolveAgentPath(location.path, scope.pathContext)
      if (!resolved.ok) {
        out.push({
          location,
          resolved: null,
          entry: {
            path: location.path,
            displayPath: location.path,
            status: 'refused' as const,
            reason: 'not_found' as const,
            message: resolved.message,
          },
          target: null,
        })
        continue
      }
      const displayPath = displayPathFor(resolved.value, scope.workspaceRoot)
      const verdict = await classifyAgentPath(resolved.value.path, trust, deps.fs)
      const base = { path: resolved.value.path, displayPath }
      if (verdict.status === 'refused') {
        out.push({
          location,
          resolved: resolved.value,
          entry: { ...base, status: 'refused' as const, reason: verdict.reason, message: verdict.message },
          target: null,
        })
        continue
      }
      // The window opens the file main checked, not the spelling it was
      // handed: a symlink retargeted between this answer and the open (a
      // reveal can wait hours for its workspace to be shown) must not lead the
      // window somewhere the check never looked.
      const target: EditorRevealFileTarget = {
        path: verdict.realPath,
        displayPath,
        name: editorFileName(resolved.value.path),
        range: location.range
          ? verdict.status === 'opened'
            ? clampEditorRange(location.range, verdict.lineCount)
            : location.range
          : null,
      }
      out.push({
        location,
        resolved: resolved.value,
        entry:
          verdict.status === 'opened'
            ? { ...base, status: 'opened' as const, reason: null, lineCount: verdict.lineCount, view: 'file' as const }
            : { ...base, status: 'awaiting_owner' as const, reason: verdict.reason },
        target,
      })
    }
    return out
  }

  // ── editor.open ─────────────────────────────────────────────────────────────

  async function open(args: Record<string, unknown>, context?: McpConnectionContext): Promise<McpToolResult> {
    const workspaceId = resolveWorkspace(args, context)
    if (typeof workspaceId !== 'string') return workspaceId
    if (!Array.isArray(args.files) || args.files.length === 0) {
      return failure('invalid_arguments', '`files` must list 1 to 8 locations.')
    }
    if (args.files.length > EDITOR_OPEN_MAX_FILES) {
      return failure(
        'invalid_arguments',
        `\`files\` lists ${args.files.length} locations; at most ${EDITOR_OPEN_MAX_FILES}. Pick the ones that matter, or use editor_open_diff with \`paths\`.`,
      )
    }
    const locations: EditorLocation[] = []
    for (const raw of args.files) {
      const parsed = parseEditorLocation(raw)
      if (!parsed.ok) return failure('invalid_arguments', parsed.message)
      locations.push(parsed.value)
    }
    const note = parseEditorNote(args.note)
    if (!note.ok) return failure('invalid_arguments', note.message)

    const scope = scopeOf(workspaceId, context)
    const classified = await classifyLocations(scope, locations)

    // At most one location becomes a diff (the view has one file under the
    // cursor at a time); a second `view: "diff"` opens as a file and says so.
    let diff: EditorRevealDiffTarget | null = null
    for (const item of classified) {
      if (item.location.view !== 'diff' || item.entry.status !== 'opened' || !item.target) continue
      if (diff) {
        item.entry.message = 'Only one location per call opens as a diff; this one opened as the file.'
        continue
      }
      const target = await diffTargetForFile(item.target, item.location)
      if (!target) {
        item.entry.message = 'The file has no uncommitted changes in a repository here, so it opened as the file.'
        continue
      }
      diff = target
      item.entry.view = 'diff'
    }

    const files = classified
      .filter((item) => item.entry.status === 'opened' && item.entry.view === 'file' && item.target)
      .map((item) => item.target as EditorRevealFileTarget)
    const awaiting = classified
      .filter((item) => item.entry.status === 'awaiting_owner' && item.target)
      .map((item) => item.target as EditorRevealFileTarget)
    const entries = classified.map((item) => item.entry)

    if (files.length === 0 && awaiting.length === 0 && !diff) {
      // Nothing to show and nothing to ask: no window is touched, and the
      // answer says why file by file.
      return success({ shown: null, files: entries, note: "Nothing was opened; see each file's `reason`." })
    }
    const { shown } = await deps.reveal({
      workspaceId,
      agentName: scope.agentName,
      note: note.value,
      files,
      awaiting,
      diff,
    })
    const hint = shownNote(shown)
    const awaitingHint =
      awaiting.length > 0
        ? 'Files marked awaiting_owner are outside this workspace: the person was asked whether to open them. Do not open them another way.'
        : undefined
    return success({
      shown,
      files: entries,
      ...(hint || awaitingHint ? { note: [hint, awaitingHint].filter(Boolean).join(' ') } : {}),
    })
  }

  /** A file's own uncommitted diff, if it has one in a repository the agent may show. */
  async function diffTargetForFile(
    file: EditorRevealFileTarget,
    location: EditorLocation,
  ): Promise<EditorRevealDiffTarget | null> {
    const repoRoot = await deps.resolveRepoRoot(dirname(file.path)).catch(() => null)
    if (!repoRoot) return null
    const changed = await deps.diff.workingTree(repoRoot).catch(() => [])
    const relative = relativeInRepo(repoRoot, file.path)
    const entry = relative
      ? changed.find((candidate) => normalizeChangelistPath(candidate.relativePath) === relative)
      : null
    if (!entry) return null
    return {
      repoRoot,
      scope: entry.unstaged ? 'unstaged' : 'staged',
      step: { kind: 'uncommitted' },
      changelistId: null,
      paths: null,
      totalChangedFiles: changed.length,
      focusPath: file.path,
      focusKind: entry.unstaged ? 'unstaged' : 'staged',
      focusRange: location.range ?? null,
      focusSide: location.side ?? 'modified',
    }
  }

  // ── editor.open_diff ────────────────────────────────────────────────────────

  async function openDiff(args: Record<string, unknown>, context?: McpConnectionContext): Promise<McpToolResult> {
    const workspaceId = resolveWorkspace(args, context)
    if (typeof workspaceId !== 'string') return workspaceId
    const changes = (args.changes ?? 'uncommitted') as EditorDiffChanges
    if (!CHANGES.includes(changes)) {
      return failure('invalid_arguments', `\`changes\` must be one of ${CHANGES.join(', ')}.`)
    }
    if (args.only !== undefined && args.only !== 'mine' && args.only !== 'all') {
      return failure('invalid_arguments', '`only` must be "mine" or "all".')
    }
    const note = parseEditorNote(args.note)
    if (!note.ok) return failure('invalid_arguments', note.message)
    let focus: EditorLocation | null = null
    if (args.focus !== undefined) {
      const parsed = parseEditorLocation(args.focus)
      if (!parsed.ok) return failure('invalid_arguments', parsed.message)
      focus = parsed.value
    }
    let requestedPaths: string[] | null = null
    if (args.paths !== undefined) {
      if (!Array.isArray(args.paths) || args.paths.some((path) => typeof path !== 'string' || !path.trim())) {
        return failure('invalid_arguments', '`paths` must be a list of file paths.')
      }
      if (args.paths.length > MAX_DIFF_PATHS) {
        return failure('invalid_arguments', `\`paths\` lists ${args.paths.length} files; at most ${MAX_DIFF_PATHS}.`)
      }
      requestedPaths = (args.paths as string[]).map((path) => path.trim())
    }

    const scope = scopeOf(workspaceId, context)
    // The agent's own checkout: its worktree, else its cwd, else the
    // workspace's folder. Never a repository the call names — the diff an
    // agent shows is the one it made.
    const checkout = scope.session?.worktreePath ?? scope.session?.cwd ?? scope.workspaceRoot
    if (!checkout) return failure('no_repository', 'This workspace has no folder to read a diff from.')
    const repoRoot = await deps.resolveRepoRoot(checkout).catch(() => null)
    if (!repoRoot) return failure('no_repository', `${checkout} is not inside a Git repository.`)

    // Whose changes. `mine` is the default for an agent — the 3 files it
    // touched, not the 40 the checkout holds — and applies to the working tree
    // only: commits are not attributed to agents, so a branch or commit view
    // shows what the history holds.
    const workingTreeView = changes === 'uncommitted' || changes === 'staged' || changes === 'unstaged'
    const wantsMine = args.only === undefined ? Boolean(scope.agentId) : args.only === 'mine'
    if (wantsMine && !scope.agentId) {
      return failure('invalid_arguments', '`only: "mine"` needs an agent connection; pass `only: "all"`.')
    }

    let changed: string[]
    let focusKindOf: (relative: string) => 'staged' | 'unstaged' | null = () => null
    let step: EditorRevealDiffTarget['step'] = null
    let viewerScope: EditorRevealDiffTarget['scope'] = null
    if (workingTreeView) {
      const entries = await deps.diff.workingTree(repoRoot)
      const kept = entries.filter((entry) =>
        changes === 'staged' ? entry.staged : changes === 'unstaged' ? entry.unstaged : true,
      )
      changed = kept.map((entry) => normalizeChangelistPath(entry.relativePath))
      const byPath = new Map(kept.map((entry) => [normalizeChangelistPath(entry.relativePath), entry]))
      focusKindOf = (relative) => {
        const entry = byPath.get(relative)
        if (!entry) return null
        if (changes === 'staged') return 'staged'
        if (changes === 'unstaged') return 'unstaged'
        return entry.unstaged ? 'unstaged' : 'staged'
      }
      viewerScope = changes === 'staged' ? 'staged' : 'unstaged'
      step = { kind: 'uncommitted' }
    } else if (changes === 'branch') {
      changed = (await deps.diff.branch(repoRoot)).map(normalizeChangelistPath)
      step = { kind: 'span' }
    } else {
      const revision = str(args, 'commit')
      if (!revision || !COMMIT_REVISION.test(revision) || revision.startsWith('-')) {
        return failure('invalid_arguments', '`changes: "commit"` needs `commit`: a hash or revision on this branch.')
      }
      const hash = await deps.diff.resolveCommit(repoRoot, revision)
      if (!hash) return failure('not_found', `"${revision}" does not name a commit in ${repoRoot}.`)
      const onBranch = await deps.diff.branchCommits(repoRoot)
      if (!onBranch.includes(hash)) {
        return failure(
          'not_on_branch',
          `${hash.slice(0, 12)} is not one of this branch's own commits; the diff view steps through the commits the branch adds over its base.`,
        )
      }
      changed = (await deps.diff.commit(repoRoot, hash)).map(normalizeChangelistPath)
      step = { kind: 'commit', hash }
    }
    const totalChangedFiles = changed.length

    let changelistId: string | null = null
    if (workingTreeView && wantsMine && scope.agentId) {
      const mine = await deps.diff.agentChangelistPaths(repoRoot, scope.agentId).catch(() => null)
      const owned = new Set((mine ?? []).map(normalizeChangelistPath))
      changed = changed.filter((path) => owned.has(path))
      changelistId = changelistOwnerId(scope.agentId)
      if (changed.length === 0) {
        return failure(
          'nothing_to_show',
          `None of the ${totalChangedFiles} changed files in ${repoRoot} are yours. Pass \`only: "all"\` to show every change.`,
        )
      }
    }
    if (changed.length === 0) return failure('nothing_to_show', `There are no ${changes} changes in ${repoRoot}.`)

    // `paths`: a viewer filter over what is left, with a way back to the rest.
    const entries: FileEntry[] = []
    let shownPaths = changed
    let pathsFilter: string[] | null = null
    if (requestedPaths) {
      const available = new Set(changed)
      const picked: string[] = []
      for (const raw of requestedPaths) {
        const relative = relativeForDiff(raw, repoRoot, scope)
        if (relative && available.has(relative)) {
          if (!picked.includes(relative)) picked.push(relative)
          continue
        }
        entries.push({
          path: raw,
          displayPath: relative ?? raw,
          status: 'refused',
          reason: 'not_found',
          message: 'Not among the changed files in this view.',
        })
      }
      if (picked.length === 0) {
        return failure('nothing_to_show', 'None of `paths` is among the changed files in this view.')
      }
      shownPaths = picked
      pathsFilter = picked
    }

    // Where the cursor lands: `focus` when it is one of the shown files, else
    // the first of them.
    let focusRelative = shownPaths[0]
    let focusRange: EditorRevealDiffTarget['focusRange'] = null
    let focusSide: 'modified' | 'original' = 'modified'
    if (focus) {
      const relative = relativeForDiff(focus.path, repoRoot, scope)
      if (relative && shownPaths.includes(relative)) {
        focusRelative = relative
        focusRange = focus.range ?? null
        focusSide = focus.side ?? 'modified'
      } else {
        entries.push({
          path: focus.path,
          displayPath: relative ?? focus.path,
          status: 'refused',
          reason: 'not_found',
          message: '`focus` is not among the files shown; the view opened on the first one.',
        })
      }
    }

    const absolute = (relative: string): string => joinRepo(repoRoot, relative)
    const diff: EditorRevealDiffTarget = {
      repoRoot,
      scope: viewerScope,
      step,
      changelistId,
      paths: pathsFilter,
      totalChangedFiles: changelistId ? changed.length : totalChangedFiles,
      focusPath: absolute(focusRelative),
      focusKind: focusKindOf(focusRelative),
      focusRange,
      focusSide,
    }
    const { shown } = await deps.reveal({
      workspaceId,
      agentName: scope.agentName,
      note: note.value,
      files: [],
      awaiting: [],
      diff,
    })
    const listed = shownPaths.slice(0, MAX_LISTED_DIFF_FILES).map<FileEntry>((relative) => ({
      path: absolute(relative),
      displayPath: relative,
      status: 'opened',
      reason: null,
      view: 'diff',
    }))
    const hint = shownNote(shown)
    return success({
      shown,
      files: [...listed, ...entries],
      fileCount: shownPaths.length,
      totalChangedFiles,
      repoRoot,
      ...(shownPaths.length > MAX_LISTED_DIFF_FILES
        ? { omittedFromList: shownPaths.length - MAX_LISTED_DIFF_FILES }
        : {}),
      ...(hint ? { note: hint } : {}),
    })
  }

  /** A path as the diff view names it: repo-relative, posix. Null when it is outside the repository. */
  function relativeForDiff(raw: string, repoRoot: string, scope: CallScope): string | null {
    const resolved = resolveAgentPath(raw, scope.pathContext)
    if (resolved.ok) {
      const relative = relativeInRepo(repoRoot, resolved.value.path)
      if (relative) return relative
    }
    // Not under the repo from the agent's cwd: a relative path may already be
    // repo-relative, which is how `git status` prints them.
    if (!/^([A-Za-z]:)?[\\/]/.test(raw) && !raw.startsWith('~')) {
      const relative = relativeInRepo(repoRoot, joinRepo(repoRoot, raw))
      if (relative) return relative
    }
    return null
  }

  // ── editor.state ────────────────────────────────────────────────────────────

  async function state(args: Record<string, unknown>, context?: McpConnectionContext): Promise<McpToolResult> {
    const workspaceId = resolveWorkspace(args, context)
    if (typeof workspaceId !== 'string') return workspaceId
    const windowState = await deps.queryState(workspaceId)
    const queued = deps.hasPendingReveal(workspaceId) ? 1 : 0
    return success({
      visible: Boolean(windowState?.windowVisible),
      appFocused: deps.isAppFocused(),
      active: windowState?.active ?? null,
      openFiles: windowState?.openFiles ?? [],
      pendingForOwner: (windowState?.awaitingOwner ?? 0) + queued,
      // The person opens files in the pop-out editor window: what is open there
      // is not in `active` / `openFiles`.
      ...(windowState?.fileSurface ? { fileSurface: windowState.fileSurface } : {}),
    })
  }

  return [
    {
      name: 'editor.open',
      mutates: true,
      description:
        "Open files in the person's editor, scrolled to and briefly highlighting the lines you mean. Use it instead of pasting paths into your reply whenever you want them to look at specific code — the 3 files that matter out of 40, the function you changed, a patch you wrote outside the repo for them to copy. It never takes keyboard focus or raises a window. `shown: not_visible` means no window is showing this workspace: it opens when they switch to it, so say so and do not retry. Files outside the workspace that you did not write come back `awaiting_owner` — the person is asked to Open or Dismiss.",
      inputSchema: {
        type: 'object',
        properties: {
          files: {
            type: 'array',
            minItems: 1,
            maxItems: EDITOR_OPEN_MAX_FILES,
            items: LOCATION_SCHEMA,
            description: 'The locations, in the order to show them. The first ends up in front.',
          },
          note: NOTE_SCHEMA,
          workspaceId: WORKSPACE_SCHEMA,
        },
        required: ['files'],
        additionalProperties: false,
      },
      handler: open,
    },
    {
      name: 'editor.open_diff',
      mutates: true,
      description:
        'Open the diff viewer on your own changes (by default only the files you edited — your changelist), optionally narrowed to `paths` and landing on `focus` at a line range. Use it when the person should review what you changed rather than read a file. `changes` picks the view: uncommitted (default), staged, unstaged, branch (everything the branch adds over its base) or commit (with `commit`). `paths` shows just those files with a way to show the rest. Never takes focus; `shown: not_visible` means it opens when they switch to the workspace — say so, do not retry.',
      inputSchema: {
        type: 'object',
        properties: {
          changes: { type: 'string', enum: [...CHANGES], description: 'Which diff. Default "uncommitted".' },
          commit: { type: 'string', description: 'With `changes: "commit"`: a hash of one of this branch\'s commits.' },
          only: {
            type: 'string',
            enum: ['mine', 'all'],
            description: 'Working-tree views: "mine" (default) shows the files you changed, "all" every change.',
          },
          paths: {
            type: 'array',
            items: { type: 'string' },
            maxItems: MAX_DIFF_PATHS,
            description: 'Show only these files (absolute, cwd-relative or repo-relative).',
          },
          focus: { ...LOCATION_SCHEMA, description: 'The file and lines to land on.' },
          note: NOTE_SCHEMA,
          workspaceId: WORKSPACE_SCHEMA,
        },
        additionalProperties: false,
      },
      handler: openDiff,
    },
    {
      name: 'editor.state',
      description:
        'What the person\'s editor shows for this workspace: whether a window shows it (`visible`), whether the app has focus, the active file with its visible line range and selection, the open files, and how many of your reveals are still waiting for them. `fileSurface: "popout"` means they open files in a separate editor window, which `active` and `openFiles` do not describe. Read-only. Use it to check they can see something before you talk about it, not in a loop.',
      inputSchema: {
        type: 'object',
        properties: { workspaceId: WORKSPACE_SCHEMA },
        additionalProperties: false,
      },
      handler: state,
    },
  ]
}

function joinRepo(repoRoot: string, relative: string): string {
  const separator = repoRoot.includes('\\') && !repoRoot.includes('/') ? '\\' : '/'
  return `${repoRoot.replace(/[\\/]+$/, '')}${separator}${relative.split('/').join(separator)}`
}

function relativeInRepo(repoRoot: string, path: string): string | null {
  if (!isInsideComparable(repoRoot, path)) return null
  const base = comparablePath(repoRoot)
  const original = path.replace(/\\/g, '/').replace(/\/+$/, '')
  const relative = original.slice(original.length - (comparablePath(path).length - base.length)).replace(/^\/+/, '')
  return relative ? normalizeChangelistPath(relative) : null
}
