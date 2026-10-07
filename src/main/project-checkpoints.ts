import type {
  ConversationCheckpointDiff,
  ConversationKey,
  ConversationRevertInput,
  ConversationRevertResult,
  ConversationTurnDiffInput,
  ConversationTurnDiffResult,
} from '../shared/conversation-runtime'
import { projectRepositoryOf, type ProjectRepositories, type ProjectRepository } from '../shared/project-repositories'
import { ConversationCheckpoints, type ConversationCheckpointResult } from './conversation-checkpoints'
import { discoverProjectRepositories } from './project-repositories'

// Conversation checkpoints for a chat in a folder of several repositories
// (docs/design/multi-repo-projects.md, 4.3): the same checkpoints, taken in
// each member. Everything `ConversationCheckpoints` does is per repository
// already, and its refs are named by the conversation (workspace and agent),
// not by the folder, so a member is checkpointed by handing it the chat's key
// with the member as its root. A chat in a repository, or in a folder that is
// neither, goes straight through, unchanged.
//
// Paths cross this boundary project-relative (`api/src/user.ts`), so the
// changed-files card lists every member's files under its member, and a revert
// names them the way the card showed them.
//
// A member that cannot be captured for a turn (too many untracked files, git
// failed), or that appeared after the turn's `pre`, is left out of that turn;
// the others are still kept. A project over the repository cap is not
// checkpointed at all: a turn would otherwise wait on every one of them.

/** How many members are captured or diffed at once. */
const MEMBER_CONCURRENCY = 4

type Member = Pick<ProjectRepository, 'path' | 'relativePath'>

export class ProjectCheckpoints {
  constructor(
    private readonly inner: ConversationCheckpoints = new ConversationCheckpoints(),
    private readonly discover: (folder: string) => ProjectRepositories | null = (folder) =>
      discoverProjectRepositories(folder),
  ) {}

  async available(cwd: string): Promise<boolean> {
    return this.members(cwd) !== null || this.inner.available(cwd)
  }

  fileScope(cwd: string): Promise<string> {
    return this.inner.fileScope(cwd)
  }

  async capture(key: ConversationKey, turnSeq: number, point: 'pre' | 'post'): Promise<ConversationCheckpointResult> {
    const members = this.members(key.workspaceRoot)
    if (!members) return this.inner.capture(key, turnSeq, point)
    const results = await eachMember(members, (member) => this.inner.capture(memberKey(key, member), turnSeq, point))
    const captured = results.find((result) => result.ok)
    if (captured) return captured
    const failed = results.find((result) => !result.ok && !result.skipped)
    if (failed && !failed.ok) return { ok: false, message: failed.message }
    const skipped = results[0]
    return { ok: false, skipped: true, message: skipped && !skipped.ok ? skipped.message : 'Checkpoints skipped.' }
  }

  async getTurnDiff(input: ConversationTurnDiffInput): Promise<ConversationTurnDiffResult> {
    const members = this.members(input.key.workspaceRoot)
    if (!members) return this.inner.getTurnDiff(input)
    if (input.path !== undefined) {
      const found = projectRepositoryOf(members, input.path)
      if (!found) return { ok: false, message: 'File is not part of this turn.' }
      const result = await this.inner.getTurnDiff({
        key: memberKey(input.key, found.repository),
        turnSeq: input.turnSeq,
        path: found.inner,
      })
      if (!result.ok) return result
      const prefix = found.repository.relativePath
      return {
        ...result,
        diff: prefixDiff(result.diff, prefix),
        ...(result.patch !== undefined ? { patch: prefixPatch(result.patch, prefix) } : {}),
      }
    }
    const results = await eachMember(members, (member) =>
      this.inner.getTurnDiff({ key: memberKey(input.key, member), turnSeq: input.turnSeq }),
    )
    // A member with no checkpoint for this turn answers with git's complaint
    // about a ref it does not have; it took no part in the turn as far as the
    // card can tell, and is left out rather than failing the others.
    if (!results.some((result) => result.ok)) return results[0] ?? { ok: false, message: 'No checkpoint.' }
    const files = results.flatMap((result, index) =>
      result.ok ? prefixDiff(result.diff, members[index].relativePath).files : [],
    )
    return { ok: true, diff: { files, submodulesExcluded: true } }
  }

  /**
   * Every member the turn can be reverted in is previewed first, and a
   * confirmed revert checks every member's list against what the dialog
   * showed before it changes any file. It is not atomic across members: one
   * that fails after another has been reverted stops there and says which
   * were; each of those keeps its own recovery point, so Undo restores them.
   */
  async revert(input: ConversationRevertInput): Promise<ConversationRevertResult> {
    const members = this.members(input.key.workspaceRoot)
    if (!members) return this.inner.revert(input)
    const point = input.undo ? 'undo' : 'pre'
    const holding = await eachMember(members, (member) =>
      this.inner.has(memberKey(input.key, member), input.turnSeq, point),
    )
    const involved = members.filter((_member, index) => holding[index])
    if (!involved.length)
      return {
        ok: false,
        message: input.undo ? 'There is no revert to undo for this turn.' : 'This turn has no checkpoint to revert to.',
      }
    const previews = await eachMember(involved, (member) =>
      this.inner.revert({
        key: memberKey(input.key, member),
        turnSeq: input.turnSeq,
        ...(input.undo ? { undo: true } : {}),
      }),
    )
    const listed: Array<{ member: Member; files: string[] }> = []
    const files: Extract<ConversationRevertResult, { ok: true }>['files'] = []
    for (const [index, preview] of previews.entries()) {
      const member = involved[index]
      if (!preview.ok) return { ...preview, message: `${member.relativePath}: ${preview.message}` }
      const prefixed = prefixDiff({ files: preview.files, submodulesExcluded: true }, member.relativePath).files
      files.push(...prefixed)
      listed.push({ member, files: preview.files.map((file) => file.path) })
    }
    if (!input.confirmed) return { ok: true, files, reverted: false }

    // The dialog's list, back in each member's own paths. Anything it showed
    // that no member lists now, or any member whose list moved, is drift.
    const shown = new Map<string, string[]>()
    for (const path of input.files ?? []) {
      const found = projectRepositoryOf(involved, path)
      if (!found) return drifted()
      shown.set(found.repository.relativePath, [...(shown.get(found.repository.relativePath) ?? []), found.inner])
    }
    for (const { member, files: now } of listed) {
      const then = shown.get(member.relativePath) ?? []
      if (then.length !== now.length || now.some((path) => !then.includes(path))) return drifted()
    }

    const reverted: string[] = []
    const kept: string[] = []
    let undoRef: string | undefined
    for (const { member, files: paths } of listed) {
      if (!paths.length) continue
      const result = await this.inner.revert({
        key: memberKey(input.key, member),
        turnSeq: input.turnSeq,
        ...(input.undo ? { undo: true } : {}),
        confirmed: true,
        files: paths,
      })
      if (!result.ok) {
        const already = reverted.length
          ? ` The revert stopped there; ${reverted.join(', ')} ${reverted.length === 1 ? 'was' : 'were'} already restored, and Undo revert puts ${reverted.length === 1 ? 'it' : 'them'} back.`
          : ''
        const said = already && !/[.!?]$/u.test(result.message) ? `${result.message}.` : result.message
        return { ...result, message: `${member.relativePath}: ${said}${already}` }
      }
      reverted.push(member.relativePath)
      undoRef ??= result.undoRef
      kept.push(...(result.kept ?? []).map((path) => `${member.relativePath}/${path}`))
    }
    return { ok: true, files, reverted: true, ...(undoRef ? { undoRef } : {}), ...(kept.length ? { kept } : {}) }
  }

  async deleteConversation(key: ConversationKey): Promise<void> {
    const members = this.members(key.workspaceRoot)
    if (!members) return this.inner.deleteConversation(key)
    await eachMember(members, (member) => this.inner.deleteConversation(memberKey(key, member)).catch(() => undefined))
  }

  async collectExpired(
    cwd: string,
    now = Date.now(),
    live: Array<{ key: ConversationKey; updatedAt: number }> = [],
  ): Promise<void> {
    const members = this.members(cwd)
    if (!members) return this.inner.collectExpired(cwd, now, live)
    // A live key names the project folder; the refs are named by its ids alone.
    await eachMember(members, (member) => this.inner.collectExpired(member.path, now, live).catch(() => undefined))
  }

  /** The members to checkpoint, or null when the folder is checkpointed as itself. */
  private members(cwd: string): Member[] | null {
    const project = this.discover(cwd)
    if (!project || project.truncated || !project.repositories.length) return null
    return project.repositories
  }
}

function drifted(): ConversationRevertResult {
  return {
    ok: false,
    changed: true,
    message: 'The files to restore changed since they were shown. Review the new list and confirm again.',
  }
}

function memberKey(key: ConversationKey, member: Member): ConversationKey {
  return { ...key, workspaceRoot: member.path }
}

/** `run` over every member, a few at a time, answers in the members' order. */
async function eachMember<T>(members: readonly Member[], run: (member: Member) => Promise<T>): Promise<T[]> {
  const answers = new Array<T>(members.length)
  let next = 0
  const worker = async () => {
    while (next < members.length) {
      const index = next++
      answers[index] = await run(members[index])
    }
  }
  await Promise.all(Array.from({ length: Math.min(MEMBER_CONCURRENCY, members.length) }, worker))
  return answers
}

function prefixDiff(diff: ConversationCheckpointDiff, prefix: string): ConversationCheckpointDiff {
  return { ...diff, files: diff.files.map((file) => ({ ...file, path: `${prefix}/${file.path}` })) }
}

/**
 * A member's patch with its headers naming the file as the project does. The
 * diff is taken without renames, so a `diff --git` line names one path twice,
 * which is how it is split even when the path holds a space; a path git quoted
 * keeps its quotes.
 */
export function prefixPatch(patch: string, prefix: string): string {
  return patch
    .split('\n')
    .map((line) => {
      if (line.startsWith('diff --git ')) return prefixedGitHeader(line.slice('diff --git '.length), prefix) ?? line
      if (line.startsWith('--- a/') || line.startsWith('--- "a/')) return line.replace('a/', `a/${prefix}/`)
      if (line.startsWith('+++ b/') || line.startsWith('+++ "b/')) return line.replace('b/', `b/${prefix}/`)
      return line
    })
    .join('\n')
}

function prefixedGitHeader(rest: string, prefix: string): string | null {
  for (const quote of ['', '"']) {
    // `<q>a/P<q> <q>b/P<q>`: the path's length follows from the line's.
    const length = (rest.length - 5 - 4 * quote.length) / 2
    if (!Number.isInteger(length) || length < 1) continue
    const first = `${quote}a/`
    const path = rest.slice(first.length, first.length + length)
    if (rest === `${quote}a/${path}${quote} ${quote}b/${path}${quote}`)
      return `diff --git ${quote}a/${prefix}/${path}${quote} ${quote}b/${prefix}/${path}${quote}`
  }
  return null
}
