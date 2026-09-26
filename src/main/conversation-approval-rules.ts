import { mkdir, readFile, realpath, rename, writeFile } from 'fs/promises'
import { dirname, join, resolve } from 'path'
import { randomUUID } from 'crypto'
import {
  approvalFilePath,
  approvalRuleCandidate,
  isConversationApprovalRule,
  isPathWithinApprovalRoot,
  matchesApprovalRule,
  type ApprovalRuleRequest,
  type ConversationApprovalRule,
} from '../shared/conversation/approvalRules'

/** Grants live in app settings, never in a repository-controlled sidecar. */
export class ConversationApprovalRuleStore {
  private persistent: ConversationApprovalRule[] = []
  private sessions = new Map<string, ConversationApprovalRule[]>()
  private loaded?: Promise<void>
  private writes: Promise<void> = Promise.resolve()
  constructor(private readonly userDataDir?: string) {}
  private async load(): Promise<void> {
    this.loaded ??= (async () => {
      if (!this.userDataDir) return
      try {
        const value: unknown = JSON.parse(
          await readFile(join(this.userDataDir, 'conversation-approval-rules.json'), 'utf8'),
        )
        if (!Array.isArray(value) || !value.every(isConversationApprovalRule))
          throw new Error('Saved conversation approval rules are invalid.')
        this.persistent = value
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
    })()
    return this.loaded
  }
  async list(workspaceRoot?: string): Promise<ConversationApprovalRule[]> {
    await this.load()
    return this.persistent
      .filter((rule) => !workspaceRoot || rule.workspaceRoot === workspaceRoot)
      .map((rule) => ({ ...rule, matcher: { ...rule.matcher } }))
  }
  async match(
    workspaceRoot: string,
    sessionId: string,
    request: ApprovalRuleRequest,
  ): Promise<ConversationApprovalRule | null> {
    await this.load()
    const rule = [...(this.sessions.get(sessionId) ?? []), ...this.persistent].find((entry) =>
      matchesApprovalRule(entry, request, workspaceRoot),
    )
    if (!rule || !(await safeFileScope(request, workspaceRoot))) return null
    return rule
  }
  async remember(
    workspaceRoot: string,
    sessionId: string,
    request: ApprovalRuleRequest,
    scope: 'conversation' | 'always',
  ): Promise<ConversationApprovalRule> {
    await this.load()
    const candidate = approvalRuleCandidate(request, workspaceRoot)
    if (!candidate || !(await safeFileScope(request, workspaceRoot)))
      throw new Error('This request can only be allowed once.')
    const rule = { ...candidate, id: randomUUID(), createdAt: Date.now() }
    if (scope === 'conversation')
      this.sessions.set(sessionId, [
        ...(this.sessions.get(sessionId) ?? []).filter((entry) => !matchesApprovalRule(entry, request, workspaceRoot)),
        rule,
      ])
    else {
      if (!this.userDataDir) throw new Error('Persistent conversation permissions are unavailable.')
      await this.mutate((rules) => [
        ...rules.filter((entry) => !matchesApprovalRule(entry, request, workspaceRoot)),
        rule,
      ])
    }
    return rule
  }
  async revoke(id: string): Promise<void> {
    await this.load()
    await this.mutate((rules) => rules.filter((rule) => rule.id !== id))
  }
  dropSession(sessionId: string): void {
    this.sessions.delete(sessionId)
  }
  private mutate(change: (rules: ConversationApprovalRule[]) => ConversationApprovalRule[]): Promise<void> {
    const write = this.writes
      .catch(() => undefined)
      .then(async () => {
        if (!this.userDataDir) throw new Error('Persistent conversation permissions are unavailable.')
        const next = change(this.persistent)
        await mkdir(this.userDataDir, { recursive: true })
        const file = join(this.userDataDir, 'conversation-approval-rules.json')
        const temp = `${file}.${randomUUID()}.tmp`
        await writeFile(temp, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 })
        await rename(temp, file)
        this.persistent = next
      })
    this.writes = write
    return write
  }
}

async function safeFileScope(request: ApprovalRuleRequest, workspaceRoot: string): Promise<boolean> {
  const candidate = approvalRuleCandidate(request, workspaceRoot)
  if (!candidate) return false
  if (candidate.matcher.type !== 'path') return true
  const path = approvalFilePath(request, workspaceRoot)
  if (!path) return false
  try {
    const root = await realpath(workspaceRoot)
    let existing = resolve(path)
    // A Write may name a file or several parent directories that do not exist.
    // Resolve the first existing ancestor; a symlink there must stay in scope.
    for (;;) {
      try {
        return isPathWithinApprovalRoot(await realpath(existing), root)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || dirname(existing) === existing) return false
        existing = dirname(existing)
      }
    }
  } catch {
    return false
  }
}
