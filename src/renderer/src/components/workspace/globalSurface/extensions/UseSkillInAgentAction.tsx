// The Extensions door's end of the round trip: install → in the agent's hands.
//
// A skill page used to end at "Installed", and a plugin page at "Install to
// this workspace". Both left the person holding a thing they could not use
// without navigating to another door and finding the row again. This is the
// action that closes it, on both pages and in the same words: pick a running
// agent (or skip the menu when there is only one), and the skill is written
// where that CLI reads skills and its invocation is parked at its prompt.
//
// It owns nothing of its own. The flow is `utils/useSkillInAgent.ts`, the menu
// is `ui/UseSkillInAgentMenu`, and the only reason this container exists is
// that the door pages are given a skill's NAME, not the workspace inventory
// record behind it — and the CLI list that renders the per-CLI invocation lives
// in the workspace store. "New agent…" is the shell's route (it spawns and
// closes the door around itself), read from the door's host seam at click time
// the way every other host action in this door is.

import React, { type JSX } from 'react'

import type { WorkspaceSkill } from '../../../../../../shared/electron-api'
import { UseSkillInAgentMenu } from '../../../ui/UseSkillInAgentMenu'
import { useWorkspaceStore } from '../../../../store/workspaceStore'
import { showToast } from '../../../../store/toastStore'
import {
  NO_WORKSPACE_FOLDER_MESSAGE,
  resolveWorkspaceSkill,
  skillRestartToast,
  useSkillInAgent,
  type LiveAgentSession,
} from '../../../../utils/useSkillInAgent'
import { getExtensionsSurfaceHost } from './extensionsSurfaceHost'

/** `onInstallFirst` said no; its host has already said why on its own surface. */
export const INSTALL_DID_NOT_FINISH_MESSAGE = 'The install did not finish, so there is nothing to use yet.'

/** The shell unmounted between the menu opening and the row being chosen. */
const NO_SHELL_MESSAGE = 'No workspace is open to start an agent in.'

export type UseSkillInAgentActionProps = {
  /** The workspace-inventory id — the skill's directory name once installed. */
  skillId: string
  skillName: string
  workspaceRoot: string | null
  /**
   * Install it first. Given when the skill is not in the workspace yet, so the
   * one button reads "Install and use" and does both; it must resolve only
   * after the install has finished (and return false when it failed or was
   * refused, e.g. a plugin whose hooks are not acknowledged yet).
   */
  onInstallFirst?: (() => Promise<boolean>) | null
  label?: string
  emphasis?: 'outline' | 'primary'
  size?: 'sm' | 'md'
  disabled?: boolean
}

export function UseSkillInAgentAction({
  skillId,
  skillName,
  workspaceRoot,
  onInstallFirst,
  label,
  emphasis = 'outline',
  size = 'sm',
  disabled = false,
}: UseSkillInAgentActionProps): JSX.Element {
  const clis = useWorkspaceStore((state) => state.pluginCatalogEntries)
  // The pane the person was last looking at in this workspace, so a workspace
  // with several agents still answers in one click.
  const activeWorkspaceId = useWorkspaceStore((state) => state.activeWorkspaceId)
  const focusedAgentId = useWorkspaceStore((state) =>
    state.activeWorkspaceId ? state.focusedAgentByWorkspaceId[state.activeWorkspaceId] : undefined,
  )

  // Everything before an agent is named: install if asked, then read the
  // record at click time, never at render — a skill installed a moment ago by
  // the button itself is only in the inventory now.
  const prepare = async (): Promise<{ ok: true; skill: WorkspaceSkill } | { ok: false; message: string }> => {
    if (onInstallFirst) {
      const installed = await onInstallFirst()
      // The host reports WHY on its own surface, which is behind this dialog;
      // the menu still has to say that nothing was handed to the agent.
      if (!installed) return { ok: false, message: INSTALL_DID_NOT_FINISH_MESSAGE }
    }
    return resolveWorkspaceSkill({ workspaceRoot, skillId })
  }

  const use = async (session: LiveAgentSession): Promise<string | null> => {
    const prepared = await prepare()
    if (!prepared.ok) return prepared.message
    const used = await useSkillInAgent({
      workspaceRoot,
      skill: prepared.skill,
      session,
      clis,
    })
    if (!used.ok) return used.message
    const toast = skillRestartToast(used, prepared.skill.name)
    if (toast) showToast(toast)
    return null
  }

  // Offered only when a shell is mounted to take it (never in a detached
  // render): a "New agent…" row that did nothing would be worse than none.
  const newAgent = getExtensionsSurfaceHost()
    ? async (): Promise<string | null> => {
        const prepared = await prepare()
        if (!prepared.ok) return prepared.message
        const host = getExtensionsSurfaceHost()
        if (!host) return NO_SHELL_MESSAGE
        host.onUseSkillInNewAgent(prepared.skill)
        return null
      }
    : undefined

  return (
    <UseSkillInAgentMenu
      skillName={skillName}
      workspaceId={activeWorkspaceId}
      preferred={{ agentId: focusedAgentId ?? null }}
      directWhenSingle
      label={label ?? (onInstallFirst ? 'Install and use' : 'Use in agent')}
      emphasis={emphasis}
      size={size}
      disabled={disabled}
      unavailableReason={workspaceRoot ? null : NO_WORKSPACE_FOLDER_MESSAGE}
      onUse={use}
      onNewAgent={newAgent}
    />
  )
}
