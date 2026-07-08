import { useMemo, useState } from 'react'
import type {
  GuidedBriefRuntimeState,
  SprintEngineRoleCounts,
} from '../../../types/workspace'
import { useWorkspaceStore } from '../../../store/workspaceStore'
import {
  createPlanSourcedSprintEngineWorkspace,
  PlanSourcedSprintEngineWorkspaceError,
} from '../../../utils/sprintengineWorkspaceCreation'
import {
  applyUserDisabledSprintEngineRoleCounts,
  getSprintEngineRoleLabel,
  getUserDisabledSprintEngineRoleIds,
  sprintEngineRoleOrder,
} from '../../../utils/sprintengine'
import { SPRINT_ENGINE_DEFAULT_MAX_PARALLEL_AGENTS } from '../newWorkspace/controllers/sprintEngineController'
import {
  sprintEngineAutomationInitialStateForMode,
  sprintEngineAutomationModeForRunOptions,
} from '../../../utils/sprintengineAutomationLifecycle'
import type { SprintEngineRoleId } from '../../../types/workspace'
import {
  buildGuidedBriefSprintEngineSourceBundle,
  writeGuidedBriefBuildHandoff,
} from '../../../utils/guidedBriefWorkspace'
import { GuidedBriefFlow, type GuidedBriefRunOptions } from './GuidedBriefFlow'
import { selectAgentCliCatalog } from '../newWorkspace/cliRuntimeOptions'
import { guidedBriefBuildHandoffRelativePath, guidedBriefSprintEngineGoal } from './handoff'
import { joinWorkspacePath } from './paths'
import { requireFreshSprintEngineAccess } from '../../../utils/premiumAccess'

type Props = {
  workspaceId: string
}

function sprintEngineRosterSummary(roleCounts: SprintEngineRoleCounts): string[] {
  // Bundled roles are listed first in their canonical order; any custom
  // registry-keyed role with a non-zero count is appended afterwards so the
  // guided brief summary works even when a workspace ships its own role.
  const orderedRoles = new Set<SprintEngineRoleId>([
    ...sprintEngineRoleOrder,
    ...Object.keys(roleCounts),
  ])
  return [...orderedRoles]
    .filter((role) => (roleCounts[role] ?? 0) > 0)
    .map((role) => `${getSprintEngineRoleLabel(role)}: ${roleCounts[role]}`)
}

export default function GuidedBriefWorkspacePanel({ workspaceId }: Props) {
  const workspace = useWorkspaceStore((s) => s.workspaces.find((candidate) => candidate.id === workspaceId) ?? null)
  const setGuidedBriefState = useWorkspaceStore((s) => s.setGuidedBriefState)
  const authState = useWorkspaceStore((s) => s.authState)
  const setAuthState = useWorkspaceStore((s) => s.setAuthState)
  const cliRuntimes = useWorkspaceStore((s) => s.appSettings.cliRuntimes)
  const pluginCatalogEntries = useWorkspaceStore((s) => s.pluginCatalogEntries)
  const pluginCatalogStatus = useWorkspaceStore((s) => s.pluginCatalogStatus)
  const cliAvailability = useWorkspaceStore((s) => s.cliAvailability)
  const cliAvailabilityStatus = useWorkspaceStore((s) => s.cliAvailabilityStatus)
  const cliOptions = useMemo(
    () =>
      selectAgentCliCatalog(pluginCatalogStatus, pluginCatalogEntries, cliRuntimes, {
        map: cliAvailability,
        status: cliAvailabilityStatus,
      }),
    [pluginCatalogStatus, pluginCatalogEntries, cliRuntimes, cliAvailability, cliAvailabilityStatus],
  )
  const sprintEngineRoleSettings = useWorkspaceStore((s) => s.appSettings.sprintEngineRoleSettings)
  const workspaceWindowId = useWorkspaceStore((s) =>
    s.workspaceWindows.find((windowState) => windowState.workspaceIds.includes(workspaceId))?.id
    ?? s.primaryWorkspaceWindowId
  )
  const sprintEngineDisabledRoleIds = getUserDisabledSprintEngineRoleIds(sprintEngineRoleSettings)
  const [viewingIdea, setViewingIdea] = useState(false)

  const runtimeState = workspace?.guidedBriefState ?? null

  const startBuild = async (
    state: GuidedBriefRuntimeState,
    runOptions: GuidedBriefRunOptions,
  ) => {
    try {
      await requireFreshSprintEngineAccess(window.api, setAuthState)
    } catch (error) {
      if (!authState.authenticated) await window.api.authLogin(authState.selectedOrganization?.id ?? null)
      throw new Error(error instanceof Error ? error.message : 'Sprint access could not be verified.')
    }
    if (state.wantsProductDiscussion && !state.acceptedProductBrief) {
      throw new Error('Accept the product brief before starting the build.')
    }
    if (state.wantsArchitectureDiscussion && !state.acceptedArchitecturePlan) {
      throw new Error('Accept the architecture plan before starting the build.')
    }
    if (state.hasUi === 'yes' && state.wantsFrontendDiscussion && (!state.acceptedUiDirection || state.acceptedMockups.length === 0)) {
      throw new Error('Accept the UI direction and mockups before starting the build.')
    }

    const finalRoleCounts = applyUserDisabledSprintEngineRoleCounts(
      runOptions.roleCounts,
      sprintEngineDisabledRoleIds,
    )

    await writeGuidedBriefBuildHandoff({
      workspaceRoot: state.workspaceRoot,
      idea: state.idea,
      hasUi: state.hasUi,
      productBrief: state.acceptedProductBrief,
      architecturePlan: state.acceptedArchitecturePlan,
      uiDirection: state.acceptedUiDirection,
      mockups: state.acceptedMockups,
      requireMockups: state.hasUi === 'yes' && state.wantsFrontendDiscussion,
      confirmedDecisions: [
        state.hasUi === 'yes' ? 'Application includes a visual UI.' : 'No visual UI is required.',
      ],
      roster: sprintEngineRosterSummary(finalRoleCounts),
      validationNotes: ['Validate implementation against accepted Guided brief artifact snapshot hashes.'],
      filesystem: {
        ensureDir: window.api.ensureDir,
        readFile: window.api.readfile,
        writeFile: window.api.writefile,
      },
    })
    const sourcePath = guidedBriefBuildHandoffRelativePath()
    const sourceContent = await window.api.readfile(joinWorkspacePath(state.workspaceRoot, sourcePath))
    const sourceBundle = await buildGuidedBriefSprintEngineSourceBundle({
      workspaceRoot: state.workspaceRoot,
      handoffPath: sourcePath,
      handoffContent: sourceContent,
      productBrief: state.acceptedProductBrief,
      architecturePlan: state.acceptedArchitecturePlan,
      uiDirection: state.acceptedUiDirection,
      mockups: state.acceptedMockups,
      readArtifact: async (workspaceRoot, path) => window.api.readfile(joinWorkspacePath(workspaceRoot, path)),
    })
    const goal = guidedBriefSprintEngineGoal(sourceContent, state.hasUi)

    try {
      await createPlanSourcedSprintEngineWorkspace({
        rootPath: state.workspaceRoot,
        teamName: `${state.workspaceName} Build`,
        goal,
        sourcePath,
        sourceContent,
        sourcePlanKind: 'unknown',
        sourceBundle,
        roleCounts: finalRoleCounts,
        roleCliDefaults: runOptions.roleCliDefaults,
        workspaceWindowId,
        sprintEngineAutoState: {
          ...sprintEngineAutomationInitialStateForMode(sprintEngineAutomationModeForRunOptions(runOptions)),
          cliPermissionPreset: runOptions.cliPermissionPreset,
          // MC-1450: the ceiling is a workspace-level knob, never roster size.
          maxConcurrentAgents: SPRINT_ENGINE_DEFAULT_MAX_PARALLEL_AGENTS,
        },
        pathExists: window.api.pathExists,
      })
    } catch (error) {
      if (error instanceof PlanSourcedSprintEngineWorkspaceError && error.code === 'team-exists') {
        throw new Error('A sprint roster with this name already exists.')
      }
      throw error instanceof Error ? error : new Error('Could not create the sprint workspace.')
    }
  }

  if (!workspace || !runtimeState) {
    return (
      <div className="flex h-full items-center justify-center bg-[color:var(--bg-app)] px-6 text-center text-[12px] text-[color:var(--text-muted)]">
        Design Wizard state is missing for this workspace.
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
      workspaceId={workspaceId}
      onChange={(next) => setGuidedBriefState(workspaceId, next)}
      onBackToIdea={() => setViewingIdea(true)}
      onStartBuild={startBuild}
      cliRuntimes={cliRuntimes}
      cliOptions={cliOptions}
      sprintEngineDisabledRoleIds={sprintEngineDisabledRoleIds}
    />
  )
}
