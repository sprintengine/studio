// What pressing Enter on a palette extension row actually does.
//
// The row is the easy half. The hard half is that "use this" means four
// different things depending on what the row is, and three of them must not be
// guessed at:
//
//   • a skill you have        → hand it to the agent;
//   • a skill you do not have → install it from its source, THEN hand it over;
//   • a plugin with no hooks, no MCP servers and exactly one skill → the same,
//     in one press;
//   • anything else about a plugin — hooks, MCP servers, an unread linked
//     repository, more than one skill, a first-party registry entry — → open
//     its page in the Extensions door and let the person decide there.
//
// The hooks clause is the one that matters. A plugin's hooks are shell commands
// that run on the agent's tool calls, and `skillsInstallPlugin` refuses to
// install them without `acknowledgedHooks`. A palette that quietly passed that
// flag would be a search box that installs shell commands on Enter, so it never
// passes it: a plugin with hooks is a deep link, and the acknowledgement stays
// where a person can read what they are agreeing to.
//
// MCP servers are the same shape of thing one rung down. The main process does
// not gate them, so the door installs them with the skills — but the door shows
// the server's command before Install, and a palette row shows a name and a
// sentence. A person who picked "a skill" and got a process registered with
// their CLI was not asked; so a plugin that declares any is a page here too
// (skills-everywhere review, 2026-09-10).
//
// Store-free and DOM-free: the deep link arrives as a callback, so the whole
// decision is testable against a fake `window.api`.

import type { WorkspaceSkill } from '../../../../shared/electron-api'
import type { ShowToastInput } from '../../store/toastStore'
import { useWorkspaceStore } from '../../store/workspaceStore'
import {
  AGENT_NO_LONGER_RUNNING_MESSAGE,
  NO_WORKSPACE_FOLDER_MESSAGE,
  pickTargetSession,
  resolveWorkspaceSkill,
  skillRestartToast,
  useSkillInAgent,
  type LiveAgentSession,
  type SkillCliEntry,
} from '../../utils/useSkillInAgent'
import type { ExtensionPluginRow, ExtensionSkillRow } from './extensionsProvider'

/** The plugin installed, but nothing it shipped is a skill an agent can run. */
export const PLUGIN_HAS_NO_SKILL_MESSAGE = 'That plugin ships no skill an agent can run.'

export type ExtensionActionOutcome =
  | { ok: true; toast: ShowToastInput | null }
  | { ok: false; message: string }

/** The workspace-inventory record a row resolved to, once it is really there. */
export type ResolvedSkillOutcome =
  | { ok: true; skill: WorkspaceSkill }
  | { ok: false; message: string }

/** Only the calls these actions make, so a test hands over two functions. */
export type ExtensionsActionApi = Pick<typeof window.api, 'skillsInstall' | 'skillsInstallPlugin'>

export type SkillRowInput = {
  row: ExtensionSkillRow
  workspaceRoot: string | null
  api?: ExtensionsActionApi
}

/**
 * The skill, in the workspace, as the inventory knows it — installing it from
 * its source first when the workspace does not have it yet.
 *
 * The install's `dirName` is what the inventory files a skill under, so it —
 * not the source-relative id, which carries the whole `plugins/x/skills/y`
 * path — is what resolves the record afterwards.
 */
export async function installSkillRow(input: SkillRowInput): Promise<ResolvedSkillOutcome> {
  const { row, workspaceRoot } = input
  if (!workspaceRoot) return { ok: false, message: NO_WORKSPACE_FOLDER_MESSAGE }
  const api = input.api ?? window.api

  let dirName = row.dirName
  if (!row.installed) {
    const installed = await api.skillsInstall({
      sourceId: row.sourceId,
      skillId: row.skillId,
      workspaceRoot,
    })
    if (!installed.ok) return { ok: false, message: installed.message }
    dirName = installed.dirName
    useWorkspaceStore.getState().bumpSprintEngineRoleRegistryEpoch()
  }
  return resolveWorkspaceSkill({ workspaceRoot, skillId: dirName })
}

/**
 * Install if needed, then run the shared round trip: write the skill where
 * that CLI reads skills, render the CLI's own invocation, park it at the
 * prompt unsubmitted. Nothing is ever submitted on the person's behalf.
 */
export async function useSkillRowInAgent(
  input: SkillRowInput & {
    /** The agent this lands in — resolved by the caller, never guessed here. */
    session: Pick<LiveAgentSession, 'sessionId' | 'cli'>
    /** The CLI plugin entries whose `skillIntegration` renders the invocation. */
    clis?: readonly SkillCliEntry[]
  },
): Promise<ExtensionActionOutcome> {
  const prepared = await installSkillRow(input)
  if (!prepared.ok) return prepared
  return handSkillToAgent({
    workspaceRoot: input.workspaceRoot as string,
    skill: prepared.skill,
    session: input.session,
    clis: input.clis,
  })
}

/** The tail every "use it now" path shares. */
export async function handSkillToAgent(input: {
  workspaceRoot: string
  skill: WorkspaceSkill
  session: Pick<LiveAgentSession, 'sessionId' | 'cli'>
  clis?: readonly SkillCliEntry[]
}): Promise<ExtensionActionOutcome> {
  const used = await useSkillInAgent({
    workspaceRoot: input.workspaceRoot,
    skill: input.skill,
    session: input.session,
    clis: input.clis,
  })
  if (!used.ok) return { ok: false, message: used.message }
  return { ok: true, toast: skillRestartToast(used, input.skill.name) }
}

// ── Plugins ──────────────────────────────────────────────────────────────────

/** Why a plugin row cannot be resolved to one skill in one press. */
export type PluginDeepLinkReason =
  /** A first-party entry: it installs through the storefront, not from here. */
  | 'registry'
  /** It declares hooks — shell commands, and an acknowledgement to read. */
  | 'hooks'
  /** It declares MCP servers — commands the CLI would launch, unshown here. */
  | 'mcp'
  /** A linked plugin nobody has opened: its components are unknown, not empty. */
  | 'unread'
  /** More than one skill, so which one is a question. */
  | 'choice'
  /** No skill at all — commands, agents, MCP servers: things a page explains. */
  | 'nothing-to-run'

export type PluginRowPlan =
  | { kind: 'install-and-use'; skillDirName: string }
  | { kind: 'deep-link'; reason: PluginDeepLinkReason }

/**
 * What selecting a plugin row should do, decided from the scan alone.
 *
 * Pure, and the whole safety argument: `install-and-use` is reachable only for
 * a plugin whose components have been READ, that declares no hooks and no MCP
 * servers, and that ships exactly one skill. Every other shape is a page.
 */
export function planPluginRow(row: ExtensionPluginRow): PluginRowPlan {
  if (row.registry) return { kind: 'deep-link', reason: 'registry' }
  if (row.hooks) return { kind: 'deep-link', reason: 'hooks' }
  if (row.mcp) return { kind: 'deep-link', reason: 'mcp' }
  if (!row.componentsKnown) return { kind: 'deep-link', reason: 'unread' }
  if (row.skillDirNames.length === 0) return { kind: 'deep-link', reason: 'nothing-to-run' }
  if (row.skillDirNames.length > 1) return { kind: 'deep-link', reason: 'choice' }
  return { kind: 'install-and-use', skillDirName: row.skillDirNames[0] }
}

// ── Which agent ──────────────────────────────────────────────────────────────

/** Where a chosen skill goes: into one session now, or to the person to say. */
export type PaletteTargetDecision =
  | { kind: 'use'; session: LiveAgentSession }
  | {
      kind: 'ask'
      /** Something to say above the question, when the reason for it is news. */
      notice: string | null
    }

/**
 * The one agent to use without asking, or the fact that there is a question.
 *
 * A pane that asked for the palette (the terminal's star) named its session,
 * and that is an instruction, not a hint: it is used when it is still live and
 * it is NOT replaced by a guess when it is not. `pickTargetSession`'s "one live
 * agent is not a question" is the right rule when nobody said which agent — it
 * is the wrong rule when somebody did and that agent has since exited, because
 * the one agent left is precisely the one the person did not point at. So a
 * named session that has gone is a question, with a line saying why
 * (skills-everywhere review, 2026-09-10).
 *
 * Absent a named session, the focused agent wins, then a lone live agent.
 */
export function decidePaletteTarget(
  sessions: readonly LiveAgentSession[],
  preferred: { sessionId: string } | null | undefined,
  focusedAgentId: string | null | undefined,
): PaletteTargetDecision {
  if (preferred) {
    const named = sessions.find((session) => session.sessionId === preferred.sessionId)
    return named ? { kind: 'use', session: named } : { kind: 'ask', notice: AGENT_NO_LONGER_RUNNING_MESSAGE }
  }
  const picked = pickTargetSession(sessions, { agentId: focusedAgentId ?? null })
  return picked ? { kind: 'use', session: picked } : { kind: 'ask', notice: null }
}

export type PluginRowInput = {
  row: ExtensionPluginRow
  workspaceRoot: string | null
  /** The dir name `planPluginRow` resolved; the receipt may still correct it. */
  skillDirName: string
  api?: ExtensionsActionApi
}

/**
 * Install a hook-free, single-skill plugin and resolve the skill it shipped.
 *
 * Never call it for a row `planPluginRow` sent to a deep link — it does not
 * re-check, because the caller has to branch on the plan anyway and two places
 * deciding the same thing is how the hooks clause would come to be skipped in
 * one of them. `acknowledgedHooks` is never passed from here, so even a
 * mis-wired caller is refused by the main process rather than obeyed.
 */
export async function installPluginRow(input: PluginRowInput): Promise<ResolvedSkillOutcome> {
  const { row, workspaceRoot } = input
  if (!workspaceRoot) return { ok: false, message: NO_WORKSPACE_FOLDER_MESSAGE }
  const api = input.api ?? window.api
  const installed = await api.skillsInstallPlugin({
    sourceId: row.sourceId,
    pluginId: row.pluginId,
    workspaceRoot,
  })
  if (!installed.ok) return { ok: false, message: installed.message }
  useWorkspaceStore.getState().bumpSprintEngineRoleRegistryEpoch()
  // What the install actually wrote outranks what the scan predicted: the
  // receipt is the only thing that knows which directories exist now.
  const written = installed.harnesses.flatMap((harness) => harness.skillDirNames)
  const dirName = written[0] ?? input.skillDirName
  if (!dirName) return { ok: false, message: PLUGIN_HAS_NO_SKILL_MESSAGE }
  return resolveWorkspaceSkill({ workspaceRoot, skillId: dirName })
}
