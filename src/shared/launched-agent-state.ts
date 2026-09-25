// The agent record a main-launched session stands for.
//
// Two processes build it from the same session: main, which registers the
// agent in the workspace registry the moment the launch service spawns it, and
// the renderer, which projects a live session it finds no record for. One
// function keeps the two from disagreeing about what a launched agent is.
import type { TerminalSessionSnapshot } from './electron-api'
import type { AgentLaunchRecord } from './agent-launch'
import type { AgentState } from '../renderer/src/types/workspace'

/**
 * The `AgentState` a launched session projects to.
 *
 * `cliHasLaunched`/`cliOnboardingPromptSent` are true because they are true:
 * main already launched the CLI and already delivered the startup prompt. Saying
 * otherwise would make the mounting terminal re-send a prompt the agent has
 * had — and, with `cliStartupPrompt` still set, treat this as live launch intent
 * and spawn a second process alongside the one it is looking at.
 */
export function agentStateFromLaunchRecord(
  record: AgentLaunchRecord,
  session: Pick<TerminalSessionSnapshot, 'sessionId' | 'worktreeId' | 'cliSessionId'>,
): AgentState {
  return {
    id: record.agentId,
    name: record.name,
    status: 'idle',
    execution: record.worktreePath
      ? { mode: 'worktree', worktreeId: session.worktreeId ?? null, cwd: record.worktreePath }
      : { mode: 'current_workspace', worktreeId: null, cwd: null },
    messages: [],
    streamBuffer: '',
    runtimeKind: 'terminal',
    cliSessionId: session.sessionId,
    // The harness's own id, when its lifecycle hook has reported one yet. Absent
    // right after launch and learned later; the launch-flag reconcile fills it in.
    ...(session.cliSessionId ? { harnessSessionId: session.cliSessionId } : {}),
    cliStartRequested: false,
    cliRestartNonce: 0,
    cliHasLaunched: true,
    cliOnboardingPromptSent: true,
    cliResumeAvailable: false,
    cli: record.cli,
    ...(record.cliModel ? { cliModel: record.cliModel } : {}),
    cliPermissionPreset: record.cliPermissionPreset,
    ...(record.connectorMcpSettings ? { connectorMcpSettings: record.connectorMcpSettings } : {}),
    ...(record.spawnSkillId ? { spawnSkillId: record.spawnSkillId } : {}),
  }
}
