import { createHash } from 'crypto'
import { lstat, mkdtemp, realpath, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { basename, dirname, join, resolve, relative, isAbsolute } from 'path'
import { runGitCommand } from './git-utils'
import type {
  ConversationKey,
  ConversationCheckpointFile,
  ConversationCheckpointDiff,
  ConversationTurnDiffInput,
  ConversationTurnDiffResult,
  ConversationRevertInput,
  ConversationRevertResult,
} from '../shared/conversation-runtime'

export type ConversationCheckpointResult = { ok: true; ref: string } | { ok: false; message: string; skipped?: boolean }

const PREFIX = 'refs/sprintengine/checkpoints/'
const IDENTITY = {
  GIT_AUTHOR_NAME: 'SprintEngine Studio',
  GIT_AUTHOR_EMAIL: 'studio@example.com',
  GIT_COMMITTER_NAME: 'SprintEngine Studio',
  GIT_COMMITTER_EMAIL: 'studio@example.com',
}

/** Hidden git objects use an isolated index; only an explicit revert alters files. */
export class ConversationCheckpoints {
  constructor(private readonly limits = { bytes: 200 * 1024 * 1024, files: 50_000 }) {}

  async available(cwd: string): Promise<boolean> {
    return (await runGitCommand(cwd, ['rev-parse', '--is-inside-work-tree'])).stdout.trim() === 'true'
  }

  async fileScope(cwd: string): Promise<string> {
    return this.root(cwd).catch(() => realpath(cwd))
  }

  async capture(key: ConversationKey, turnSeq: number, point: 'pre' | 'post'): Promise<ConversationCheckpointResult> {
    try {
      const root = await this.root(key.workspaceRoot)
      const guard = await this.checkSize(root)
      if (guard) return { ok: false, skipped: true, message: guard }
      const ref = this.ref(key, turnSeq, point)
      await this.git(root, ['update-ref', ref, await this.commit(root, await this.worktreeTree(root), turnSeq, point)])
      return { ok: true, ref }
    } catch (error) {
      return { ok: false, message: errorMessage(error) }
    }
  }

  async getTurnDiff(input: ConversationTurnDiffInput): Promise<ConversationTurnDiffResult> {
    try {
      const root = await this.root(input.key.workspaceRoot)
      const before = this.ref(input.key, input.turnSeq, 'pre')
      const after = this.ref(input.key, input.turnSeq, 'post')
      const diff = await this.diff(root, before, after)
      if (input.path !== undefined && !diff.files.some((file) => file.path === input.path))
        return { ok: false, message: 'File is not part of this turn.' }
      if (input.path !== undefined) {
        const file = diff.files.find((file) => file.path === input.path)!
        if (file.binary) return { ok: false, message: 'Binary checkpoint files cannot be displayed as text.' }
        const original = file.status === 'added' ? '' : await this.readText(root, before, input.path)
        const modified = file.status === 'deleted' ? '' : await this.readText(root, after, input.path)
        const patch = await this.git(root, [
          'diff',
          '--no-ext-diff',
          '--no-renames',
          '--ignore-submodules=all',
          before,
          after,
          '--',
          `:(literal)${input.path}`,
        ])
        return { ok: true, diff, patch, original, modified }
      }
      const patch =
        input.path === undefined
          ? undefined
          : await this.git(root, [
              'diff',
              '--no-ext-diff',
              '--no-renames',
              '--ignore-submodules=all',
              before,
              after,
              '--',
              `:(literal)${input.path}`,
            ])
      return { ok: true, diff, ...(patch !== undefined ? { patch } : {}) }
    } catch (error) {
      return { ok: false, message: errorMessage(error) }
    }
  }

  async revert(input: ConversationRevertInput): Promise<ConversationRevertResult> {
    try {
      const root = await this.root(input.key.workspaceRoot)
      const guard = await this.checkSize(root)
      if (guard) return { ok: false, message: guard }
      const target = input.undo
        ? await this.latestRecovery(root, input.key, input.turnSeq, 'undo')
        : this.ref(input.key, input.turnSeq, 'pre')
      if (!target) return { ok: false, message: 'There is no revert to undo for this turn.' }
      // A file the target holds may be ignored now; capture it anyway so the
      // diff shows it and the recovery ref can bring back what is replaced.
      const current = await this.worktreeTree(root, await this.blobPaths(root, target))
      const { files } = await this.diff(root, target, current)
      if (!input.confirmed) return { ok: true, files, reverted: false }
      // Act only on what the dialog showed. A file that changed state since the
      // preview could otherwise be restored or removed without being seen.
      const shown = new Set(input.files ?? [])
      if (!input.files || shown.size !== files.length || files.some((file) => !shown.has(file.path)))
        return {
          ok: false,
          changed: true,
          message: 'The files to restore changed since they were shown. Review the new list and confirm again.',
        }
      // Record the exact state about to be replaced before changing any path,
      // for an undo as much as for a revert: work done after a revert is as
      // much the user's as work done before it. Each recovery ref is new, so a
      // second revert of the same turn never overwrites the first one's.
      const recovery = await this.storeRecovery(root, input.key, input.turnSeq, input.undo ? 'redo' : 'undo', current)
      const restores = files.filter((file) => file.status !== 'added').map((file) => file.path)
      if (restores.length) await this.checkoutFiles(root, target, restores)
      // A file absent from the target that the target's own ignore rules
      // ignore most likely existed, ignored, before the turn: keep it.
      const kept = await this.ignoredPaths(
        root,
        files.filter((file) => file.status === 'added').map((file) => file.path),
      )
      for (const file of files.filter((file) => file.status === 'added' && !kept.has(file.path))) {
        const path = safePath(root, file.path)
        // Files absent from the target can be untracked, so a checkout cannot
        // remove them. Remove only the exact diff path, never a directory tree,
        // and never through a symlinked parent that leads out of the work tree.
        const info = await lstat(path).catch(() => null)
        if (!info) continue
        if (info.isDirectory()) throw new Error(`Cannot remove directory ${file.path} during revert.`)
        safePath(await realpath(root), join(await realpath(dirname(path)), basename(path)))
        await rm(path, { force: true })
      }
      return { ok: true, files, reverted: true, undoRef: recovery, ...(kept.size ? { kept: [...kept] } : {}) }
    } catch (error) {
      return { ok: false, message: errorMessage(error) }
    }
  }

  async deleteConversation(key: ConversationKey): Promise<void> {
    if (!(await this.available(key.workspaceRoot))) return
    const prefix = `${PREFIX}${this.identity(key)}/`
    const refs = await this.git(key.workspaceRoot, ['for-each-ref', '--format=%(refname)', prefix])
    for (const ref of refs.trim().split('\n').filter(Boolean))
      await this.git(key.workspaceRoot, ['update-ref', '-d', ref])
  }

  /**
   * Expire a conversation's refs once the conversation itself has been idle
   * for 30 days, never ref by ref: a live conversation keeps every turn's
   * checkpoint however old that turn is. Activity is the newest of its refs
   * and, for conversations the caller knows, the thread's last update. Refs of
   * conversations the caller does not know (another worktree of the same
   * repository shares this ref namespace) expire on their refs alone.
   */
  async collectExpired(
    cwd: string,
    now = Date.now(),
    live: Array<{ key: ConversationKey; updatedAt: number }> = [],
  ): Promise<void> {
    if (!(await this.available(cwd))) return
    const refs = await this.git(cwd, ['for-each-ref', '--format=%(refname) %(committerdate:unix)', PREFIX])
    const groups = new Map<string, { refs: string[]; activity: number }>()
    for (const line of refs.trim().split('\n')) {
      const [ref, timestamp] = line.split(' ')
      const identity = ref?.startsWith(PREFIX) ? ref.slice(PREFIX.length).split('/')[0] : ''
      if (!identity) continue
      const group = groups.get(identity) ?? { refs: [], activity: 0 }
      group.refs.push(ref)
      group.activity = Math.max(group.activity, Number(timestamp) * 1000 || 0)
      groups.set(identity, group)
    }
    for (const thread of live) {
      const group = groups.get(this.identity(thread.key))
      if (group) group.activity = Math.max(group.activity, thread.updatedAt)
    }
    const cutoff = now - 30 * 24 * 60 * 60 * 1000
    for (const group of groups.values())
      if (group.activity < cutoff) for (const ref of group.refs) await this.git(cwd, ['update-ref', '-d', ref])
  }

  private async commit(root: string, tree: string, turnSeq: number, point: string): Promise<string> {
    return (
      await this.git(root, ['commit-tree', tree, '-m', `Conversation checkpoint ${turnSeq} ${point}`], IDENTITY)
    ).trim()
  }

  /**
   * `<turn>-undo-<n>` holds the files a revert replaced; `<turn>-redo-<n>` the
   * files an undo replaced. Numbers only grow and every ref is kept, so each
   * recovery point stays listed until the conversation is deleted or expires.
   */
  private async recoveries(root: string, key: ConversationKey, turnSeq: number, kind: 'undo' | 'redo') {
    const base = this.ref(key, turnSeq, kind)
    const refs = await this.git(root, ['for-each-ref', '--format=%(refname)', `${base}*`])
    return refs
      .split('\n')
      .map((ref) => {
        // The unnumbered `<turn>-undo` is what earlier builds wrote.
        const match = ref === base ? ['', '0'] : new RegExp(`^${base}-(\\d+)$`, 'u').exec(ref)
        return match ? { ref, n: Number(match[1]) } : null
      })
      .filter((entry) => entry !== null)
      .sort((a, b) => a.n - b.n)
  }
  private async latestRecovery(root: string, key: ConversationKey, turnSeq: number, kind: 'undo' | 'redo') {
    return (await this.recoveries(root, key, turnSeq, kind)).at(-1)?.ref ?? null
  }
  private async storeRecovery(
    root: string,
    key: ConversationKey,
    turnSeq: number,
    kind: 'undo' | 'redo',
    tree: string,
  ): Promise<string> {
    const n = ((await this.recoveries(root, key, turnSeq, kind)).at(-1)?.n ?? 0) + 1
    const ref = `${this.ref(key, turnSeq, kind)}-${n}`
    const commit = await this.commit(root, tree, turnSeq, kind)
    // Create-only: an existing ref of this name is never replaced.
    await this.git(root, ['update-ref', ref, commit, '0'.repeat(commit.length)])
    return ref
  }

  private identity(key: ConversationKey): string {
    return createHash('sha256').update(`${key.workspaceId}\0${key.agentId}`).digest('hex').slice(0, 24)
  }
  private ref(key: ConversationKey, turnSeq: number, point: string): string {
    if (!Number.isSafeInteger(turnSeq) || turnSeq < 1) throw new Error('Turn sequence is invalid.')
    return `${PREFIX}${this.identity(key)}/${turnSeq}-${point}`
  }
  private async root(cwd: string): Promise<string> {
    return (await this.git(cwd, ['rev-parse', '--show-toplevel'])).trim()
  }
  private async readText(root: string, ref: string, path: string): Promise<string> {
    const object = `${ref}:${path}`
    const size = Number((await this.git(root, ['cat-file', '-s', object])).trim())
    if (!Number.isFinite(size) || size > 2 * 1024 * 1024)
      throw new Error('Checkpoint file exceeds the 2 MB text preview limit.')
    return this.git(root, ['show', object])
  }

  private async checkSize(root: string): Promise<string | null> {
    const paths = (await this.git(root, ['ls-files', '--others', '--exclude-standard', '-z']))
      .split('\0')
      .filter((path) => path && !isSidecar(path))
    if (paths.length > this.limits.files) return 'Checkpoints skipped: too many untracked files.'
    let bytes = 0
    for (const path of paths) {
      bytes += (await lstat(safePath(root, path))).size
      if (bytes > this.limits.bytes) return 'Checkpoints skipped: untracked files exceed the size limit.'
    }
    return null
  }

  /** `include` names extra paths to capture when present on disk, ignored or not. */
  private async worktreeTree(root: string, include: string[] = []): Promise<string> {
    const temp = await mkdtemp(join(tmpdir(), 'conversation-index-'))
    const env = { GIT_INDEX_FILE: join(temp, 'index'), GIT_OPTIONAL_LOCKS: '0' }
    try {
      const head = await runGitCommand(root, ['rev-parse', '--verify', 'HEAD'])
      await this.git(root, head.ok ? ['read-tree', 'HEAD'] : ['read-tree', '--empty'], env)
      const files = (await this.git(root, ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], env))
        .split('\0')
        .filter((path) => path && !isSidecar(path))
      // A force-added file can be tracked in the user's index while absent
      // from HEAD and ignored by discovery through our temporary index.
      const staged = (await this.git(root, ['ls-files', '--cached', '-z']))
        .split('\0')
        .filter((path) => path && !isSidecar(path))
      const captured = new Set(files)
      for (const path of staged)
        if (!captured.has(path) && (await lstat(safePath(root, path)).catch(() => null))) captured.add(path)
      for (const path of include)
        if (!captured.has(path) && !isSidecar(path) && (await lstat(safePath(root, path)).catch(() => null))?.isFile())
          captured.add(path)
      if (captured.size)
        await this.git(
          root,
          ['add', '-A', '-f', '--pathspec-from-file=-', '--pathspec-file-nul'],
          { ...env, GIT_LITERAL_PATHSPECS: '1' },
          [...captured].join('\0') + '\0',
        )
      return (await this.git(root, ['write-tree'], env)).trim()
    } finally {
      await rm(temp, { recursive: true, force: true })
    }
  }

  private async blobPaths(root: string, commit: string): Promise<string[]> {
    return (await this.git(root, ['ls-tree', '-r', '-z', '--full-tree', commit]))
      .split('\0')
      .filter((line) => /^\d+ blob /u.test(line))
      .map((line) => line.slice(line.indexOf('\t') + 1))
  }

  private async ignoredPaths(root: string, paths: string[]): Promise<Set<string>> {
    if (!paths.length) return new Set()
    // Exit status 1 means none are ignored; nothing is kept on any failure.
    const result = await runGitCommand(root, ['check-ignore', '--no-index', '-z', '--stdin'], undefined, {
      stdin: paths.join('\0') + '\0',
    })
    return new Set(result.stdout.split('\0').filter(Boolean))
  }

  /**
   * Write `paths` from `commit` into the work tree through a throwaway index.
   * The user's index is never read or written, so what they staged stays
   * staged byte for byte and nothing they had untracked becomes staged.
   */
  private async checkoutFiles(root: string, commit: string, paths: string[]): Promise<void> {
    const temp = await mkdtemp(join(tmpdir(), 'conversation-restore-'))
    const env = { GIT_INDEX_FILE: join(temp, 'index'), GIT_OPTIONAL_LOCKS: '0' }
    try {
      await this.git(root, ['read-tree', commit], env)
      await this.git(root, ['checkout-index', '-f', '-z', '--stdin'], env, paths.join('\0') + '\0')
    } finally {
      await rm(temp, { recursive: true, force: true })
    }
  }

  private async diff(root: string, before: string, after: string): Promise<ConversationCheckpointDiff> {
    const base = ['diff', '--no-ext-diff', '--no-renames', '--ignore-submodules=all']
    const stats = (await this.git(root, [...base, '--numstat', '-z', before, after])).split('\0').filter(Boolean)
    const statuses = (await this.git(root, [...base, '--name-status', '-z', before, after])).split('\0')
    const status = new Map<string, ConversationCheckpointFile['status']>()
    for (let i = 0; i + 1 < statuses.length; i += 2)
      status.set(statuses[i + 1], statuses[i] === 'A' ? 'added' : statuses[i] === 'D' ? 'deleted' : 'modified')
    return {
      submodulesExcluded: true,
      files: stats.map((line) => {
        const first = line.indexOf('\t')
        const second = line.indexOf('\t', first + 1)
        const added = line.slice(0, first)
        const removed = line.slice(first + 1, second)
        const path = line.slice(second + 1)
        return {
          path,
          status: status.get(path) ?? 'modified',
          addedLines: Number(added) || 0,
          removedLines: Number(removed) || 0,
          binary: added === '-' || removed === '-',
        }
      }),
    }
  }

  private async git(cwd: string, args: string[], env?: NodeJS.ProcessEnv, stdin?: string): Promise<string> {
    const result = await runGitCommand(cwd, args, env, { ...(stdin !== undefined ? { stdin } : {}) })
    if (!result.ok) throw new Error(result.message || result.stderr || 'Checkpoint git operation failed.')
    return result.stdout
  }
}

function safePath(root: string, path: string): string {
  const absolute = resolve(root, path)
  const rel = relative(root, absolute)
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) throw new Error('Checkpoint path escapes the work tree.')
  return absolute
}
function isSidecar(path: string): boolean {
  return (
    path === '.sprintengine' ||
    path.startsWith('.sprintengine/') ||
    path === '.multi-code' ||
    path.startsWith('.multi-code/')
  )
}
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Checkpoint operation failed.'
}
