/**
 * Agent sessions for capability modules (Reviews extraction, D5 / WP-B).
 *
 * The in-tree review guide spawns a terminal agent, keeps one per review, pastes
 * follow-up prompts into it, holds it out of the idle reaper while it works, and
 * watches for its exit — roughly 200 lines of main-process plumbing over the
 * terminal runtime and the agent control plane. Every one of those lines is
 * generic. When the guide moves out of this repo into an installed module, it
 * cannot take them with it: a module's `entry.main` has no terminal runtime, no
 * control plane, and no business minting spawn payloads.
 *
 * So the plumbing stays here and becomes the published surface
 * ({@link ModuleAgentSessionService}, resolved through the SDK's
 * `getAgentSessionService(host)`), and the module keeps only the part that was
 * ever about reviews: which prompt, which skill, which review id.
 *
 * ## What it is, and what it is built on
 *
 * A module agent session is an ORDINARY agent terminal. It gets a tab, the
 * user's CLI and permission default, their CLI runtime overrides and MCP
 * servers, the project's knowledge graph, a name from the shared pool — because
 * it is composed by {@link AgentLaunchService}, the same main-process service
 * behind `agent.launch`, `backlog.work` and agent-backed automation runs. This
 * file is the module-facing half: identity the module owns, reuse of a live
 * session, skill resolution, and the four controls (send/kill/reapExempt/onExit)
 * that the launch service deliberately has no opinion about.
 *
 * ## Identity, and why scoping hangs off it
 *
 * A module names its agents `${agentIdPrefix}${agentIdKey}` — a namespace it
 * registered (`review-guide-`) plus its own key (the review id). That id is
 * stable across spawns, which is what makes "start the guide again" find the
 * live terminal instead of growing a second one, and it is also the ONLY thing
 * separating one module's agents from another's (and from the user's). Every
 * read and every control is filtered by it: `list()` answers for owned
 * prefixes, and `send`/`kill`/`setReapExempt` refuse a session this module
 * neither spawned nor named.
 *
 * The session id is minted fresh per spawn and is never the agent id. A
 * Claude-harness CLI is launched with `--session-id <it>` and rejects both a
 * non-UUID and an id it has already used — the mistake that once left reviewers
 * with a bare shell instead of a guide.
 *
 * ## Known limitation: prefix ownership
 *
 * Agent-id namespaces are registered on the RENDERER host, and main holds no
 * mirror of that registry today. `getModuleAgentIdPrefixes` is the seam for one;
 * without it a prefix is validated as non-empty and ownership falls back to
 * "prefixes this module has spawned under in this process", which is sound
 * (a module still cannot reach another's agents) but forgets across a restart.
 */
import { isAbsolute } from 'path'

import type { AgentSessionExitEvent } from '../shared/agent-runtime'
import type { AgentLaunchRequest, AgentLaunchResult } from '../shared/agent-launch'
import type { TerminalSessionSnapshot } from '../shared/electron-api'
import type {
  AgentSessionsRegistry,
  ModuleAgentExitEvent,
  ModuleAgentSessionRecord,
  ModuleAgentSpawnRequest,
  ModuleAgentSpawnResult,
} from '../shared/modules/agent-sessions'

/** The permission every method here checks before it does anything. */
export const AGENT_SESSION_PERMISSION = 'agents:session'

export type AgentSessionsModuleDeps = {
  /**
   * The composition layer (`createAgentLaunchService`). A module spawn is an
   * ordinary launch with a caller-owned agent id, an explicit cwd, and the
   * workspace-mode guard waived — see `AgentLaunchRequest`.
   */
  launchAgent: (request: AgentLaunchRequest) => Promise<AgentLaunchResult>
  terminal: {
    list: () => TerminalSessionSnapshot[]
    kill: (sessionId: string) => void
    setReapExempt: (sessionId: string, exempt: boolean) => void
    /** Fires when any agent session's pty exits (gated on `agentSession.executionId`). */
    onAgentSessionExit: (listener: (event: AgentSessionExitEvent) => void) => () => void
  }
  /**
   * Deliver a prompt to a live session through the agent control plane: paste
   * plus a separately-dispatched submit, as one serialized turn. Nothing here
   * writes to a pty of its own, so a module prompt landing on the same session
   * so concurrent writers queue instead of interleaving bytes.
   */
  sendPrompt: (sessionId: string, text: string) => Promise<{ ok: boolean; message?: string }>
  /** Does this workspace id name a real workspace? */
  hasWorkspace: (workspaceId: string) => boolean
  /**
   * Skill resolution seam. Today the builtin catalogue (`findBuiltinSkill`);
   * WP-D widens it to skills a module registered, and this service needs no
   * change when it does — an id nothing resolves is `unknown_skill`, never a
   * spawn that quietly runs without its instructions.
   */
  resolveSkill: (skillId: string) => { id: string } | null
  /**
   * Pre-install a resolved skill into the working directory. Optional: the
   * terminal runtime installs `spawnSkillId` itself immediately before launch,
   * so this is the WP-D seam for a module that wants the copy on disk earlier.
   */
  ensureSkillInstalled?: (workspaceRoot: string, skillId: string) => Promise<void>
  /** The CLI-native explicit invocation for a skill, or undefined for a CLI with none. */
  resolveSkillInvocation: (cli: string, skillId: string) => string | undefined
  /** The permissions the module declared in its manifest (disclosure list). */
  getModulePermissions: (moduleId: string) => readonly string[] | undefined
  /**
   * The agent-id namespaces this module registered, when main can see them.
   * Undefined (the case today) falls back to the prefixes it has spawned under
   * in this process — see the module note above.
   */
  getModuleAgentIdPrefixes?: (moduleId: string) => readonly string[] | undefined
}

export type AgentSessionsModuleRegistry = AgentSessionsRegistry & {
  /** Release the runtime exit listener. Called on host shutdown. */
  dispose(): void
}

/** What this process has watched a module start, so it can be scoped later. */
type OwnedAgents = {
  prefixes: Set<string>
  sessionIds: Set<string>
  executionIds: Set<string>
}

export function createAgentSessionsModuleRegistry(
  deps: AgentSessionsModuleDeps
): AgentSessionsModuleRegistry {
  const owned = new Map<string, OwnedAgents>()
  const exitListeners = new Map<string, Set<(event: ModuleAgentExitEvent) => void>>()
  // executionId → sessionId, for every session this registry spawned. The
  // runtime reports an exit by execution id; clearing the reap exemption needs
  // the session id, and no snapshot survives the exit to translate between them.
  const spawnedSessions = new Map<string, string>()

  const stopWatching = deps.terminal.onAgentSessionExit((event) => onAgentExit(event))

  function ownedFor(moduleId: string): OwnedAgents {
    const existing = owned.get(moduleId)
    if (existing) return existing
    const fresh: OwnedAgents = { prefixes: new Set(), sessionIds: new Set(), executionIds: new Set() }
    owned.set(moduleId, fresh)
    return fresh
  }

  /**
   * The prefixes this module may spawn under and read back. The injected mirror
   * is authoritative when there is one; otherwise the prefixes it has already
   * used in this process, which is what the renderer registry would have said.
   */
  function prefixesFor(moduleId: string): readonly string[] {
    const registered = deps.getModuleAgentIdPrefixes?.(moduleId)
    if (registered) return registered
    return [...ownedFor(moduleId).prefixes]
  }

  function declaresPermission(moduleId: string): boolean {
    return (deps.getModulePermissions(moduleId) ?? []).includes(AGENT_SESSION_PERMISSION)
  }

  function permissionMessage(moduleId: string, verb: string): string {
    return `Module "${moduleId}" must declare the "${AGENT_SESSION_PERMISSION}" permission to ${verb}.`
  }

  function requirePermission(moduleId: string, verb: string): void {
    if (declaresPermission(moduleId)) return
    throw new Error(permissionMessage(moduleId, verb))
  }

  /**
   * Is this session this module's to touch? Either it carries an agent id under
   * one of the module's prefixes, or this registry spawned it for that module.
   * Both halves are needed: a module that named no prefix still owns what it
   * started, and a prefix still owns a session spawned before a restart.
   */
  function ownsSession(moduleId: string, sessionId: string): boolean {
    const mine = ownedFor(moduleId)
    if (mine.sessionIds.has(sessionId)) return true
    const session = findSession(sessionId)
    return session ? matchesPrefix(prefixesFor(moduleId), session.agentId) : false
  }

  function findSession(sessionId: string): TerminalSessionSnapshot | undefined {
    return deps.terminal.list().find((session) => session.sessionId === sessionId)
  }

  /** This agent's terminal, live or retained, found by the id the module owns. */
  function findByAgentId(agentId: string): TerminalSessionSnapshot | undefined {
    return deps.terminal
      .list()
      .find((session) => session.kind === 'agent' && session.agentId === agentId)
  }

  async function spawn(
    moduleId: string,
    request: ModuleAgentSpawnRequest
  ): Promise<ModuleAgentSpawnResult> {
    if (!declaresPermission(moduleId)) {
      return { ok: false, code: 'permission_missing', message: permissionMessage(moduleId, 'spawn an agent') }
    }

    const workspaceId = request.workspaceId?.trim() ?? ''
    if (!workspaceId || !deps.hasWorkspace(workspaceId)) {
      return {
        ok: false,
        code: 'unknown_workspace',
        message: `Workspace "${request.workspaceId}" is not open, so there is nowhere for the agent to live.`,
      }
    }
    // An agent spawned into `process.cwd()` runs inside the app's own install
    // directory. A relative path is the same mistake with a longer fuse.
    const cwd = request.cwd?.trim() ?? ''
    if (!cwd || !isAbsolute(cwd)) {
      return {
        ok: false,
        code: 'missing_cwd',
        message: 'An agent session needs an absolute working directory.',
      }
    }

    const prefix = request.agentIdPrefix?.trim() ?? ''
    const key = request.agentIdKey?.trim() ?? ''
    if (prefix || key) {
      if (!prefix) {
        return { ok: false, code: 'spawn_failed', message: 'An agent id key needs an agent id prefix.' }
      }
      const registered = deps.getModuleAgentIdPrefixes?.(moduleId)
      if (registered && !registered.includes(prefix)) {
        return {
          ok: false,
          code: 'spawn_failed',
          message: `Module "${moduleId}" has not registered the agent-id namespace "${prefix}".`,
        }
      }
    }
    // No prefix at all is allowed — the launch service mints an app-owned id —
    // but then this module's only claim on the session is having started it.
    const agentId = prefix ? `${prefix}${key}` : undefined

    const skillId = request.skill?.id?.trim()
    if (skillId && !deps.resolveSkill(skillId)) {
      return {
        ok: false,
        code: 'unknown_skill',
        message: `No skill is installed under the id "${skillId}", so the agent would run without its instructions.`,
      }
    }

    // A live terminal under this agent id takes the prompt rather than being
    // twinned. Suspended counts as not live: the reaper froze the process, and
    // pasting into it would write into a pty that is not reading.
    const existing = agentId ? findByAgentId(agentId) : undefined
    const live = existing && existing.processAlive && !existing.suspended ? existing : null
    if (live && agentId && (request.reuseLive ?? true)) {
      const sent = await deps.sendPrompt(live.sessionId, request.prompt)
      if (!sent.ok) {
        return {
          ok: false,
          code: 'send_failed',
          message: sent.message ?? 'The prompt could not be delivered to the live agent session.',
        }
      }
      remember(moduleId, { prefix, sessionId: live.sessionId, executionId: live.agentSession?.executionId })
      const cli = live.cli ?? ''
      return {
        ok: true,
        sessionId: live.sessionId,
        agentId,
        // A session spawned outside this registry may carry no execution
        // identity; its own session id is the only stable handle left.
        executionId: live.agentSession?.executionId ?? live.sessionId,
        workspaceId: live.workspaceId ?? workspaceId,
        cli,
        reused: true,
        ...invocation(cli, skillId),
      }
    }

    // A retained record for a terminal that is gone (exited, or suspended by
    // the reaper) has to go before the fresh spawn, or the agent is listed
    // twice — once dead, once live — and the module's own `list()` cannot tell
    // which one it is holding.
    if (existing) deps.terminal.kill(existing.sessionId)

    if (skillId && deps.ensureSkillInstalled) {
      // Advisory: the runtime installs `spawnSkillId` again immediately before
      // launch, and that copy is the one the agent reads. A failure here is
      // therefore not a failure of the spawn.
      await deps.ensureSkillInstalled(cwd, skillId).catch(() => {})
    }

    const launched = await deps.launchAgent({
      workspaceId,
      cwd,
      prompt: request.prompt,
      anyWorkspaceMode: true,
      ...(agentId ? { agentId } : {}),
      ...(request.cli?.trim() ? { cli: request.cli.trim() } : {}),
      ...(request.cliModel?.trim() ? { cliModel: request.cliModel.trim() } : {}),
      ...(request.label?.trim() ? { name: request.label.trim() } : {}),
      ...(request.permissionPreset ? { permissionPreset: request.permissionPreset } : {}),
      ...(skillId ? { spawnSkillId: skillId } : {}),
    })
    if (!launched.ok) {
      return { ok: false, code: spawnFailureCode(launched.code), message: launched.message }
    }

    remember(moduleId, {
      prefix,
      sessionId: launched.sessionId,
      executionId: launched.executionId,
    })
    spawnedSessions.set(launched.executionId, launched.sessionId)
    return {
      ok: true,
      sessionId: launched.sessionId,
      agentId: launched.agentId,
      executionId: launched.executionId,
      workspaceId: launched.workspaceId,
      cli: launched.cli,
      reused: false,
      ...invocation(launched.cli, skillId),
    }
  }

  function invocation(cli: string, skillId: string | undefined): { skillInvocation?: string } {
    if (!skillId || !cli) return {}
    const resolved = deps.resolveSkillInvocation(cli, skillId)
    return resolved ? { skillInvocation: resolved } : {}
  }

  function remember(
    moduleId: string,
    input: { prefix: string; sessionId: string; executionId?: string }
  ): void {
    const mine = ownedFor(moduleId)
    if (input.prefix) mine.prefixes.add(input.prefix)
    mine.sessionIds.add(input.sessionId)
    if (input.executionId) mine.executionIds.add(input.executionId)
  }

  async function send(
    moduleId: string,
    sessionId: string,
    text: string
  ): Promise<{ ok: boolean; message?: string }> {
    if (!declaresPermission(moduleId)) {
      return { ok: false, message: permissionMessage(moduleId, 'prompt an agent session') }
    }
    if (!ownsSession(moduleId, sessionId)) {
      return { ok: false, message: `Session "${sessionId}" is not one of this module's agent sessions.` }
    }
    return deps.sendPrompt(sessionId, text)
  }

  function kill(moduleId: string, sessionId: string): void {
    requirePermission(moduleId, 'stop an agent session')
    if (!ownsSession(moduleId, sessionId)) return
    deps.terminal.kill(sessionId)
  }

  function setReapExempt(moduleId: string, sessionId: string, exempt: boolean): void {
    requirePermission(moduleId, 'hold an agent session out of the idle reaper')
    if (!ownsSession(moduleId, sessionId)) return
    deps.terminal.setReapExempt(sessionId, exempt)
  }

  function onExit(moduleId: string, listener: (event: ModuleAgentExitEvent) => void): () => void {
    requirePermission(moduleId, 'watch its agent sessions')
    const listeners = exitListeners.get(moduleId) ?? new Set()
    listeners.add(listener)
    exitListeners.set(moduleId, listeners)
    return () => {
      listeners.delete(listener)
    }
  }

  function list(moduleId: string): ModuleAgentSessionRecord[] {
    requirePermission(moduleId, 'list its agent sessions')
    const prefixes = prefixesFor(moduleId)
    const mine = ownedFor(moduleId)
    return deps.terminal
      .list()
      .filter(
        (session) =>
          session.kind === 'agent'
          && (matchesPrefix(prefixes, session.agentId) || mine.sessionIds.has(session.sessionId))
      )
      .map(toRecord)
  }

  /**
   * A module agent's pty ended. Two things follow, in this order: the reap
   * exemption it may have been holding is released by the HOST (a module that
   * never balances its own `setReapExempt` cannot leave an unsuspendable
   * process behind), and every module that owns the agent hears about it.
   */
  function onAgentExit(event: AgentSessionExitEvent): void {
    const sessionId = spawnedSessions.get(event.executionId)
    if (sessionId) {
      deps.terminal.setReapExempt(sessionId, false)
      spawnedSessions.delete(event.executionId)
    }
    const projected: ModuleAgentExitEvent = {
      agentId: event.agentId ?? null,
      executionId: event.executionId,
      workspaceId: event.workspaceId ?? null,
      exitCode: event.exitCode,
    }
    for (const [moduleId, listeners] of exitListeners) {
      const mine = ownedFor(moduleId)
      const isMine =
        mine.executionIds.has(event.executionId) || matchesPrefix(prefixesFor(moduleId), event.agentId)
      if (!isMine) continue
      for (const listener of [...listeners]) listener(projected)
    }
  }

  return {
    spawn,
    send,
    kill,
    setReapExempt,
    onExit,
    list,
    dispose: () => {
      stopWatching()
      exitListeners.clear()
    },
  }
}

/**
 * The launch service's vocabulary in the module's. Its codes are the app's own
 * (`workspace_folder_missing`, `agent_spawn_failed`); the module contract names
 * the same facts in terms of what the module asked for. Anything unmapped —
 * a connector failure, a mode refusal a module spawn cannot reach — is a spawn
 * that did not happen, which is exactly what `spawn_failed` says.
 */
function spawnFailureCode(code: string): Extract<ModuleAgentSpawnResult, { ok: false }>['code'] {
  switch (code) {
    case 'unknown_workspace':
      return 'unknown_workspace'
    case 'workspace_folder_missing':
      return 'missing_cwd'
    case 'no_cli_selected':
      return 'no_cli_selected'
    case 'cli_not_agent_selectable':
      return 'cli_not_agent_selectable'
    default:
      return 'spawn_failed'
  }
}

function matchesPrefix(prefixes: readonly string[], agentId: string | undefined): boolean {
  if (!agentId) return false
  return prefixes.some((prefix) => prefix.length > 0 && agentId.startsWith(prefix))
}

function toRecord(session: TerminalSessionSnapshot): ModuleAgentSessionRecord {
  return {
    sessionId: session.sessionId,
    agentId: session.agentId ?? null,
    name: session.agentName ?? null,
    cli: session.cli ?? null,
    workspaceId: session.workspaceId ?? null,
    executionId: session.agentSession?.executionId ?? null,
    isLive: session.processAlive && !session.suspended,
    suspended: session.suspended,
    reapExempt: session.reapExempt,
    startedAt: session.startedAt,
  }
}
