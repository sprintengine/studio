import { mkdir, readFile, realpath, rename, writeFile } from 'fs/promises'
import { dirname, join, resolve } from 'path'
import { randomUUID } from 'crypto'
import { STUDIO_MCP_SERVER_ID } from '../shared/product-identity'
import {
  approvalFilePath,
  approvalRuleCandidate,
  isApprovalPathInGitDirectory,
  isPathWithinApprovalRoot,
  matchesApprovalRule,
  migrateConversationApprovalRule,
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
        if (!Array.isArray(value)) throw new Error('Saved conversation approval rules are invalid.')
        const rules = value.map(migrateConversationApprovalRule)
        this.persistent = rules.filter((rule) => rule !== null)
        // Narrowed or dropped grants are written back at once, so an older
        // build reading the file later cannot revive the wider scope.
        if (rules.some((rule, index) => rule !== value[index])) await this.save(this.persistent)
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
  /**
   * Forget every rule that allows a tool of these client toolsets, on the
   * Studio gateway, saved or for a session: the toolsets' app was revoked, and
   * a later app that takes one of the names must inherit no "always allow".
   * A rule names the tool as the CLI spelled it (`game.spawn` or
   * `game_spawn`), and a toolset name has no underscore, so either splits at
   * its first separator.
   */
  async forgetGatewayToolsets(toolsets: readonly string[]): Promise<number> {
    if (toolsets.length === 0) return 0
    await this.load()
    const names = new Set(toolsets)
    const forgets = (rule: ConversationApprovalRule) => {
      if (rule.matcher.type !== 'mcp' || !rule.matcher.server.includes(STUDIO_MCP_SERVER_ID)) return false
      const toolset = /^([a-z][a-z0-9-]*)[._]/u.exec(rule.matcher.tool)?.[1]
      return toolset !== undefined && names.has(toolset)
    }
    for (const [sessionId, rules] of this.sessions)
      this.sessions.set(
        sessionId,
        rules.filter((rule) => !forgets(rule)),
      )
    const before = this.persistent.length
    if (this.userDataDir && this.persistent.some(forgets))
      await this.mutate((rules) => rules.filter((rule) => !forgets(rule)))
    return before - this.persistent.length
  }
  dropSession(sessionId: string): void {
    this.sessions.delete(sessionId)
  }
  private mutate(change: (rules: ConversationApprovalRule[]) => ConversationApprovalRule[]): Promise<void> {
    const write = this.writes
      .catch(() => undefined)
      .then(async () => {
        const next = change(this.persistent)
        await this.save(next)
        this.persistent = next
      })
    this.writes = write
    return write
  }
  private async save(rules: ConversationApprovalRule[]): Promise<void> {
    if (!this.userDataDir) throw new Error('Persistent conversation permissions are unavailable.')
    await mkdir(this.userDataDir, { recursive: true })
    const file = join(this.userDataDir, 'conversation-approval-rules.json')
    const temp = `${file}.${randomUUID()}.tmp`
    await writeFile(temp, `${JSON.stringify(rules, null, 2)}\n`, { mode: 0o600 })
    await rename(temp, file)
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
        const real = await realpath(existing)
        // A symlink inside the workspace may point into its git directory.
        return isPathWithinApprovalRoot(real, root) && !isApprovalPathInGitDirectory(real, root)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || dirname(existing) === existing) return false
        existing = dirname(existing)
      }
    }
  } catch {
    return false
  }
}
