import { createHash } from 'crypto'
import { lstat, mkdtemp, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join, resolve, relative, isAbsolute } from 'path'
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

  async capture(
    key: ConversationKey,
    turnSeq: number,
    point: 'pre' | 'post' | 'undo',
  ): Promise<ConversationCheckpointResult> {
    try {
      const root = await this.root(key.workspaceRoot)
      const guard = await this.checkSize(root)
      if (guard) return { ok: false, skipped: true, message: guard }
      const tree = await this.worktreeTree(root)
      const commit = await this.git(
        root,
        ['commit-tree', tree, '-m', `Conversation checkpoint ${turnSeq} ${point}`],
        IDENTITY,
      )
      const ref = this.ref(key, turnSeq, point)
      await this.git(root, ['update-ref', ref, commit.trim()])
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
      const target = this.ref(input.key, input.turnSeq, input.undo ? 'undo' : 'pre')
      const current = await this.worktreeTree(root)
      const { files } = await this.diff(root, target, current)
      if (!input.confirmed) return { ok: true, files, reverted: false }
      // Capture the exact current state before changing any path. Undo restores
      // this ref and keeps it intact, so repeated undo never overwrites recovery.
      const undo = input.undo
        ? { ok: true as const, ref: target }
        : await this.capture(input.key, input.turnSeq, 'undo')
      if (!undo.ok) return undo
      const restores = files.filter((file) => file.status !== 'added').map((file) => file.path)
      if (restores.length)
        await this.git(
          root,
          ['restore', '--source', target, '--staged', '--worktree', '--pathspec-from-file=-', '--pathspec-file-nul'],
          { GIT_LITERAL_PATHSPECS: '1' },
          restores.join('\0') + '\0',
        )
      for (const file of files.filter((file) => file.status === 'added')) {
        const path = safePath(root, file.path)
        // Files absent from the target can be untracked, so restore cannot
        // remove them. Remove only the exact diff path, never a directory tree.
        const info = await lstat(path).catch(() => null)
        if (info?.isDirectory()) throw new Error(`Cannot remove directory ${file.path} during revert.`)
        await this.git(root, ['rm', '--cached', '--ignore-unmatch', '--', `:(literal)${file.path}`])
        await rm(path, { force: true })
      }
      return { ok: true, files, reverted: true, undoRef: undo.ref }
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

  async collectExpired(cwd: string, now = Date.now()): Promise<void> {
    if (!(await this.available(cwd))) return
    const refs = await this.git(cwd, ['for-each-ref', '--format=%(refname) %(committerdate:unix)', PREFIX])
    const cutoff = now / 1000 - 30 * 24 * 60 * 60
    for (const line of refs.trim().split('\n')) {
      const [ref, timestamp] = line.split(' ')
      if (ref?.startsWith(PREFIX) && Number(timestamp) < cutoff) await this.git(cwd, ['update-ref', '-d', ref])
    }
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

  private async worktreeTree(root: string): Promise<string> {
    const temp = await mkdtemp(join(tmpdir(), 'conversation-index-'))
    const env = { GIT_INDEX_FILE: join(temp, 'index'), GIT_OPTIONAL_LOCKS: '0' }
    try {
      const head = await runGitCommand(root, ['rev-parse', '--verify', 'HEAD'])
      await this.git(root, head.ok ? ['read-tree', 'HEAD'] : ['read-tree', '--empty'], env)
      const files = (await this.git(root, ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], env))
        .split('\0')
        .filter((path) => path && !isSidecar(path))
      if (files.length)
        await this.git(
          root,
          ['add', '-A', '--pathspec-from-file=-', '--pathspec-file-nul'],
          { ...env, GIT_LITERAL_PATHSPECS: '1' },
          [...new Set(files)].join('\0') + '\0',
        )
      return (await this.git(root, ['write-tree'], env)).trim()
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
