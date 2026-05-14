import { useState } from 'react'
import type {
  AgentCli,
  GuidedBriefRuntimeState,
  SprintEngineRoleCliDefaults,
  SprintEngineRoleCounts,
} from '../../../types/workspace'
import { useWorkspaceStore } from '../../../store/workspaceStore'
import {
  createPlanSourcedSprintEngineWorkspace,
  PlanSourcedSprintEngineWorkspaceError,
} from '../../../utils/sprintengineWorkspaceCreation'
import { countSprintEngineAgents } from '../../../utils/sprintengine'
import { GuidedBriefFlow } from './GuidedBriefFlow'
import { guidedBriefBuildHandoffRelativePath, guidedBriefSprintEngineGoal } from './handoff'
import { joinWorkspacePath } from './paths'

type Props = {
  workspaceId: string
}

const guidedBriefSprintEngineRoleCounts: SprintEngineRoleCounts = {
  architect: 1,
  product: 1,
  frontend: 1,
  developer: 1,
  code_reviewer: 1,
  spec_reviewer: 1,
  performance: 0,
  tester: 1,
  security: 0,
}

const guidedBriefRoleCliDefaults: Required<SprintEngineRoleCliDefaults> = {
  architect: 'codex',
  product: 'codex',
  frontend: 'codex',
  developer: 'codex',
  code_reviewer: 'codex',
  spec_reviewer: 'codex',
  performance: 'codex',
  tester: 'codex',
  security: 'codex',
}

export default function GuidedBriefWorkspacePanel({ workspaceId }: Props) {
  const workspace = useWorkspaceStore((s) => s.workspaces.find((candidate) => candidate.id === workspaceId) ?? null)
  const setGuidedBriefState = useWorkspaceStore((s) => s.setGuidedBriefState)
  const authState = useWorkspaceStore((s) => s.authState)
  const cli = useWorkspaceStore((s) => s.appSettings.lastSelectedCli ?? 'codex')
  const cliRuntimes = useWorkspaceStore((s) => s.appSettings.cliRuntimes)
  const cliPermissionPreset = useWorkspaceStore((s) => s.appSettings.lastAgentSpawnPermissionPreset ?? 'default')
  const [viewingIdea, setViewingIdea] = useState(false)

  const runtimeState = workspace?.guidedBriefState ?? null

  const startBuild = async (
    state: GuidedBriefRuntimeState,
    runOptions: { startRunner: boolean; autoApproveArtifacts: boolean },
  ) => {
    if (!authState.authenticated) {
      await window.api.authLogin(authState.selectedOrganization?.id ?? null)
      throw new Error('Sign in to use Sprint Engine mode.')
    }
    if (!state.acceptedProductBrief) {
      throw new Error('Accept the product brief before starting the build.')
    }
    if (state.hasUi === 'yes' && (!state.acceptedUiDirection || state.acceptedMockups.length === 0)) {
      throw new Error('Accept the UI direction and mockups before starting the build.')
    }

    const sourcePath = guidedBriefBuildHandoffRelativePath()
    const sourceContent = await window.api.readfile(joinWorkspacePath(state.workspaceRoot, sourcePath))
    const goal = guidedBriefSprintEngineGoal(sourceContent, state.hasUi)

    try {
      await createPlanSourcedSprintEngineWorkspace({
        rootPath: state.workspaceRoot,
        teamName: `${state.workspaceName} Build`,
        goal,
        sourcePath,
        sourceContent,
        sourcePlanKind: 'product_plan',
        roleCounts: guidedBriefSprintEngineRoleCounts,
        roleCliDefaults: guidedBriefRoleCliDefaults,
        sprintEngineAutoState: {
          enabled: runOptions.startRunner,
          autoApproveArtifacts: runOptions.autoApproveArtifacts,
          cliPermissionPreset,
          maxConcurrentAgents: countSprintEngineAgents(guidedBriefSprintEngineRoleCounts),
        },
        pathExists: window.api.pathExists,
      })
    } catch (error) {
      if (error instanceof PlanSourcedSprintEngineWorkspaceError && error.code === 'team-exists') {
        throw new Error('A Sprint Engine team with this name already exists.')
      }
      throw error instanceof Error ? error : new Error('Could not create the Sprint Engine workspace.')
    }
  }

  if (!workspace || !runtimeState) {
    return (
      <div className="flex h-full items-center justify-center bg-[color:var(--bg-app)] px-6 text-center text-[12px] text-[color:var(--text-muted)]">
        Guided brief state is missing for this workspace.
      </div>
    )
  }

  if (viewingIdea) {
    return (
      <div className="flex h-full flex-col bg-[color:var(--bg-app)]">
        <header className="flex shrink-0 items-center gap-3 border-b border-[color:var(--bg-surface-raised)] px-5 py-3">
          <button
            type="button"
            onClick={() => setViewingIdea(false)}
            className="
              inline-flex h-8 items-center rounded-md px-2 text-[12px] font-medium text-[color:var(--text-muted)]
              transition-colors hover:bg-[color:var(--bg-surface-raised)] hover:text-[color:var(--text-strong)]
              focus:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--accent-primary)]
            "
          >
            Back to brief
          </button>
        </header>
        <main className="flex min-h-0 flex-1 justify-center overflow-auto px-6 py-10">
          <div className="flex w-full max-w-[560px] flex-col gap-4">
            <h2 className="text-[18px] font-semibold text-[color:var(--text-strong)]">Idea seed</h2>
            <div className="rounded-md border border-[color:var(--border-default)] bg-[color:var(--bg-surface)] p-4">
              <p className="whitespace-pre-wrap text-[13px] leading-6 text-[color:var(--text-default)]">
                {runtimeState.idea}
              </p>
              <p className="mt-4 text-[12px] text-[color:var(--text-muted)]">
                UI: {runtimeState.hasUi === 'yes' ? 'visual app' : 'script or service'}
              </p>
            </div>
          </div>
        </main>
      </div>
    )
  }

  return (
    <GuidedBriefFlow
      runtimeState={runtimeState}
      onChange={(next) => setGuidedBriefState(workspaceId, next)}
      onBackToIdea={() => setViewingIdea(true)}
      onStartBuild={startBuild}
      cli={cli as AgentCli}
      cliRuntimes={cliRuntimes}
    />
  )
}
