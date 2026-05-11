import { useEffect, useMemo, useState } from 'react'
import {
  createMultiloopTemplate,
  createSprintEngineTemplate,
  createSwitchboardTemplate,
  LAYOUT_TEMPLATES,
} from '../../layouts/templates'
import { useWorkspaceStore } from '../../store/workspaceStore'
import type {
  AgentCli,
  FuturePlanWorkspaceSource,
  LayoutTemplate,
  SprintEngineAutoState,
  SprintEngineMockConfig,
  SprintEngineRole,
  SprintEngineRoleCliDefaults,
  SprintEngineRoleCounts,
  SprintEngineState,
  SprintEngineWorkspaceContext,
} from '../../types/workspace'
import {
  createPlanSourcedSprintEngineWorkspace,
  PlanSourcedSprintEngineWorkspaceError,
} from '../../utils/sprintengineWorkspaceCreation'
import {
  createMultiloopWorkspace,
  MultiloopWorkspaceCreationError,
} from '../../utils/multiloopWorkspaceCreation'
import {
  countSprintEngineAgents,
  createInitialSprintEngineState,
} from '../../utils/sprintengine'
import { slugifySprintEngineName } from '../../utils/sprintengineStateFile'
import { ModeCard } from './newWorkspace/ModeCard'
import { RecentFolderRow, isSameFolder } from './newWorkspace/RecentFolderRow'
import { SprintEngineRosterTable } from './newWorkspace/SprintEngineRosterTable'
import {
  buildSprintEngineContext,
  useFolderHints,
  useFolderScan,
} from './newWorkspace/useNewWorkspaceFolder'
import { basename, folderKey, planBasename, markdownTitle, toTitleName } from './newWorkspace/helpers'
import type { CreationMode, ExistingTeam, SprintEnginePath } from './newWorkspace/types'

const MAX_RECENT_FOLDERS = 6
const MODES: CreationMode[] = ['standard', 'switchboard', 'sprintengine', 'multiloop']

const initialSprintEngineRoleCounts: SprintEngineRoleCounts = {
  architect: 1,
  product: 1,
  frontend: 0,
  developer: 0,
  code_reviewer: 0,
  performance: 0,
  tester: 0,
  security: 0,
}

const initialSprintEngineRoleCliDefaults: Required<SprintEngineRoleCliDefaults> = {
  architect: 'codex',
  product: 'codex',
  frontend: 'codex',
  developer: 'codex',
  code_reviewer: 'codex',
  performance: 'codex',
  tester: 'codex',
  security: 'codex',
}

export type NewWorkspacePanelInitialState = {
  mode?: CreationMode
  folderPath?: string | null
  futurePlanSource?: FuturePlanWorkspaceSource | null
}

interface Props {
  onCreate: (args: {
    template: LayoutTemplate
    name: string
    folderPath: string | null
    sprintEngineState?: SprintEngineState | null
    sprintEngineContext?: SprintEngineWorkspaceContext | null
    sprintEngineRoleCliDefaults?: SprintEngineRoleCliDefaults | null
    sprintEngineAutoState?: Partial<SprintEngineAutoState> | null
    mode?: CreationMode
  }) => void
  onClose: () => void
  allowClose?: boolean
  initialState?: NewWorkspacePanelInitialState | null
}

export default function NewWorkspacePanel({
  onCreate,
  onClose,
  allowClose = true,
  initialState = null,
}: Props) {
  const authState = useWorkspaceStore((s) => s.authState)
  const addWorkspace = useWorkspaceStore((s) => s.addWorkspace)
  const storedRecentFolders = useWorkspaceStore(
    (s) => s.appSettings.recentWorkspaceFolders ?? [],
  )
  const workspaces = useWorkspaceStore((s) => s.workspaces)

  const initialFuturePlan = initialState?.futurePlanSource ?? null
  const initialMode: CreationMode =
    initialState?.mode ?? (initialFuturePlan ? 'sprintengine' : 'standard')

  const [mode, setMode] = useState<CreationMode>(initialMode)
  const [folderPath, setFolderPath] = useState<string | null>(
    initialState?.folderPath ?? initialFuturePlan?.folderPath ?? null,
  )
  const [name, setName] = useState('')
  const [nameTouched, setNameTouched] = useState(false)
  const [layoutId, setLayoutId] = useState<string>(
    LAYOUT_TEMPLATES[2]?.id ?? LAYOUT_TEMPLATES[0].id,
  )
  const [showAdvanced, setShowAdvanced] = useState(false)

  const [sePath, setSePath] = useState<SprintEnginePath>(initialFuturePlan ? 'plan' : 'new')
  const [sePlanPath, setSePlanPath] = useState(initialFuturePlan?.sourcePath ?? '')
  const [sePlanContent, setSePlanContent] = useState<string | null>(
    initialFuturePlan?.sourceContent ?? null,
  )
  const [seExistingTeam, setSeExistingTeam] = useState<ExistingTeam | null>(null)
  const [seTeamName, setSeTeamName] = useState(initialFuturePlan?.teamName ?? '')
  const [seTeamNameTouched, setSeTeamNameTouched] = useState(Boolean(initialFuturePlan))
  const [seGoal, setSeGoal] = useState(initialFuturePlan?.goal ?? '')
  const [seRoleCounts, setSeRoleCounts] = useState<SprintEngineRoleCounts>(
    initialSprintEngineRoleCounts,
  )
  const [seRoleCliDefaults, setSeRoleCliDefaults] = useState<Required<SprintEngineRoleCliDefaults>>(
    initialSprintEngineRoleCliDefaults,
  )
  const [seStartRunner, setSeStartRunner] = useState(true)
  const [sePlanError, setSePlanError] = useState<string | null>(null)

  const [mlName, setMlName] = useState('')
  const [mlNameTouched, setMlNameTouched] = useState(false)
  const [mlGoal, setMlGoal] = useState('')
  const [mlError, setMlError] = useState<string | null>(null)

  const [isCreating, setIsCreating] = useState(false)

  const folderScan = useFolderScan(folderPath)
  const totalAgents = countSprintEngineAgents(seRoleCounts)
  const isSprintEngine = mode === 'sprintengine'

  const recentFolders = useMemo(() => {
    const seen = new Set<string>()
    const folders: string[] = []
    const candidates = [
      ...storedRecentFolders,
      ...workspaces.map((workspace) => workspace.folderPath).filter((path): path is string => Boolean(path)),
    ]
    candidates.forEach((path) => {
      const key = folderKey(path)
      if (seen.has(key)) return
      seen.add(key)
      folders.push(path)
    })
    return folders.slice(0, MAX_RECENT_FOLDERS)
  }, [storedRecentFolders, workspaces])

  const folderHints = useFolderHints(recentFolders)

  // Sync initial future-plan option into the scan list once available.
  useEffect(() => {
    if (!initialFuturePlan) return
    setSePath('plan')
    setSePlanPath(initialFuturePlan.sourcePath)
    setSePlanContent(initialFuturePlan.sourceContent ?? null)
  }, [initialFuturePlan])

  // Escape closes when allowed.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && allowClose) onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose, allowClose])

  // Reset SprintEngine path if the folder loses prerequisites.
  useEffect(() => {
    if (!isSprintEngine) return
    if (sePath === 'existing' && folderScan.result.teams.length === 0) {
      setSePath('new')
      setSeExistingTeam(null)
    }
    if (sePath === 'plan' && !folderScan.isScanning && folderScan.result.plans.length === 0 && !sePlanPath) {
      setSePath('new')
    }
  }, [isSprintEngine, sePath, folderScan.result, folderScan.isScanning, sePlanPath])

  const sprintEngineAccess = getSprintEngineAccessState(authState)

  const switchboardObjectiveComplete =
    Boolean(folderPath?.trim()) && name.trim().length > 0
  const standardComplete = name.trim().length > 0
  const multiloopComplete =
    Boolean(folderPath?.trim()) && mlName.trim().length > 0 && mlGoal.trim().length > 0
  const seObjectiveComplete =
    seExistingTeam != null || (seTeamName.trim().length > 0 && seGoal.trim().length > 0)
  const sePlanReady =
    sePath !== 'plan' || (sePlanPath !== '' && sePlanContent != null && !sePlanError)
  const sprintEngineComplete =
    sprintEngineAccess.allowed
    && Boolean(folderPath?.trim())
    && sePlanReady
    && (seExistingTeam != null || (seObjectiveComplete && totalAgents > 0))

  const blockingMessage = computeBlockingMessage({
    mode,
    folderPath,
    name,
    standardComplete,
    switchboardObjectiveComplete,
    multiloopComplete,
    sprintEngineAccess,
    sprintEngineComplete,
    sePath,
    sePlanReady,
    seExistingTeam,
    seObjectiveComplete,
    totalAgents,
  })

  const canCreate =
    !isCreating
    && (
      (mode === 'standard' && Boolean(folderPath?.trim()) && standardComplete)
      || (mode === 'switchboard' && switchboardObjectiveComplete)
      || (mode === 'multiloop' && multiloopComplete)
      || (mode === 'sprintengine' && sprintEngineComplete)
    )

  const handleSelectMode = (next: CreationMode) => {
    setMode(next)
    if (next === 'standard' && !nameTouched) setName(basename(folderPath ?? '') || 'workspace')
    if (next === 'switchboard' && !nameTouched)
      setName(toTitleName(basename(folderPath ?? '')) || 'Switchboard')
    if (next === 'multiloop' && !mlNameTouched)
      setMlName(toTitleName(basename(folderPath ?? '')) || 'Product Loop')
    if (next !== 'sprintengine') {
      setSeExistingTeam(null)
    }
  }

  const handleSelectFolder = (dir: string) => {
    const folderName = basename(dir)
    setFolderPath(dir)
    setSeExistingTeam(null)
    setSePlanPath('')
    setSePlanContent(null)
    setSePlanError(null)
    setMlError(null)
    if (!nameTouched) setName(folderName || 'workspace')
    if (!seTeamNameTouched) setSeTeamName(toTitleName(folderName) || 'Sprint Engine Team')
    if (!mlNameTouched) setMlName(toTitleName(folderName) || 'Product Loop')

    const hint = folderHints.get(dir)
    if (hint && (hint.hasSprintEngineTeam || hint.hasMultiloop)) {
      // Suggest the matching mode if user hasn't deviated.
      if (!nameTouched && hint.hasSprintEngineTeam) handleSelectMode('sprintengine')
      else if (!nameTouched && hint.hasMultiloop) handleSelectMode('multiloop')
    }
  }

  const pickFolder = async () => {
    const dir = await window.api.openDir()
    if (!dir) return
    handleSelectFolder(dir)
  }

  const handleSelectExistingTeam = (slug: string) => {
    const team = folderScan.result.teams.find((candidate) => candidate.slug === slug)
    if (!team) {
      setSeExistingTeam(null)
      return
    }
    setSeExistingTeam(team)
    setSeTeamName(team.displayName)
    setSeGoal(team.state.goal)
    setSeRoleCounts(team.state.roleCounts)
  }

  const handleSelectPlan = async (sourcePath: string) => {
    setSePlanPath(sourcePath)
    setSePlanError(null)
    if (!sourcePath) {
      setSePlanContent(null)
      return
    }
    const option = folderScan.result.plans.find((candidate) => candidate.path === sourcePath)
    if (!option) {
      setSePlanContent(null)
      setSePlanError('Selected markdown file is not available.')
      return
    }
    try {
      const content = await window.api.readfile(option.path)
      const fallbackName = planBasename(option.path)
      const goal = markdownTitle(content) ?? toTitleName(fallbackName)
      setSePlanContent(content)
      if (!seTeamNameTouched) setSeTeamName(slugifySprintEngineName(fallbackName))
      setSeGoal(goal)
      setSeExistingTeam(null)
    } catch {
      setSePlanContent(null)
      setSePlanError('Could not read the selected markdown file.')
    }
  }

  const setRoleCount = (role: SprintEngineRole, count: number) => {
    const min = role === 'architect' ? 1 : 0
    setSeExistingTeam(null)
    setSeRoleCounts((current) => ({
      ...current,
      [role]: Math.max(min, Math.min(10, Math.floor(count))),
    }))
  }

  const setRoleCli = (role: SprintEngineRole, cli: AgentCli) => {
    setSeRoleCliDefaults((current) => ({ ...current, [role]: cli }))
  }

  const sprintEngineConfig = useMemo<SprintEngineMockConfig>(
    () => ({
      name: seTeamName.trim() || 'Sprint Engine Team',
      goal: seGoal.trim(),
      roleCounts: seRoleCounts,
    }),
    [seGoal, seRoleCounts, seTeamName],
  )

  const handleCreate = async () => {
    if (!canCreate) return

    if (mode === 'multiloop') {
      if (!folderPath) return
      setIsCreating(true)
      setMlError(null)
      try {
        const created = await createMultiloopWorkspace({
          rootPath: folderPath,
          loopName: mlName,
          finalGoal: mlGoal,
          initializeState: window.api.initializeMultiloopState,
          readFile: window.api.readfile,
        })
        addWorkspace(createMultiloopTemplate(), {
          name: mlName.trim() || 'Multiloop',
          folderPath,
          multiloopState: created.state,
          multiloopContext: created.context,
        })
        onClose()
      } catch (error) {
        setMlError(
          error instanceof MultiloopWorkspaceCreationError || error instanceof Error
            ? error.message
            : 'Could not create the Multiloop workspace.',
        )
      } finally {
        setIsCreating(false)
      }
      return
    }

    if (mode === 'switchboard') {
      if (!folderPath) return
      onCreate({
        template: createSwitchboardTemplate(),
        name: name.trim() || 'Switchboard',
        folderPath,
        mode: 'switchboard',
      })
      onClose()
      return
    }

    if (mode === 'sprintengine') {
      if (seExistingTeam) {
        const { displayName, state, context } = seExistingTeam
        const loadedState = { ...state, name: displayName }
        const template = createSprintEngineTemplate({
          name: loadedState.name,
          goal: loadedState.goal,
          roleCounts: loadedState.roleCounts,
        })
        onCreate({
          template,
          name: loadedState.name,
          folderPath,
          sprintEngineState: loadedState,
          sprintEngineContext: context,
          sprintEngineRoleCliDefaults: seRoleCliDefaults,
          sprintEngineAutoState: {
            enabled: seStartRunner,
            maxConcurrentAgents: Math.max(1, countSprintEngineAgents(loadedState.roleCounts)),
          },
        })
        return
      }

      if (sePath === 'plan' && sePlanPath) {
        const option = folderScan.result.plans.find((candidate) => candidate.path === sePlanPath)
        if (!folderPath || !option || sePlanContent == null) return
        setIsCreating(true)
        try {
          if (!(await window.api.pathExists(option.path))) {
            setSePlanError('Selected markdown file is not available.')
            return
          }
          await createPlanSourcedSprintEngineWorkspace({
            rootPath: folderPath,
            teamName: seTeamName,
            goal: seGoal,
            sourcePath: option.relativePath,
            sourceContent: sePlanContent,
            roleCounts: seRoleCounts,
            roleCliDefaults: seRoleCliDefaults,
            sprintEngineAutoState: {
              enabled: seStartRunner,
              maxConcurrentAgents: Math.max(1, totalAgents),
            },
            pathExists: window.api.pathExists,
          })
          onClose()
        } catch (error) {
          if (error instanceof PlanSourcedSprintEngineWorkspaceError && error.code === 'team-exists') {
            setSePlanError('A Sprint Engine team with this name already exists.')
          } else {
            setSePlanError(
              error instanceof Error ? error.message : 'Could not create the Sprint Engine workspace.',
            )
          }
        } finally {
          setIsCreating(false)
        }
        return
      }

      const sprintEngineState = createInitialSprintEngineState(sprintEngineConfig)
      const template = createSprintEngineTemplate(sprintEngineConfig)
      const sprintEngineContext = folderPath
        ? buildSprintEngineContext(
            folderPath,
            sprintEngineState.name,
            slugifySprintEngineName(sprintEngineState.name),
          )
        : null
      onCreate({
        template,
        name: sprintEngineState.name,
        folderPath,
        sprintEngineState,
        sprintEngineContext,
        sprintEngineRoleCliDefaults: seRoleCliDefaults,
        sprintEngineAutoState: {
          enabled: seStartRunner,
          maxConcurrentAgents: Math.max(1, totalAgents),
        },
      })
      return
    }

    // Standard
    const template = LAYOUT_TEMPLATES.find((t) => t.id === layoutId) ?? LAYOUT_TEMPLATES[0]
    onCreate({
      template,
      name: name.trim(),
      folderPath,
    })
  }

  const startLogin = async () => {
    await window.api.authLogin(authState.selectedOrganization?.id ?? null)
  }

  return (
    <section
      aria-labelledby="new-workspace-title"
      tabIndex={-1}
      className="flex h-full min-h-0 flex-col bg-[#08090b] outline-none"
    >
      <header className="flex shrink-0 items-center justify-between gap-3 border-b border-[#1f2025] bg-[#0d0e11] px-5 py-3">
        <div className="min-w-0">
          <h2
            id="new-workspace-title"
            className="truncate text-[15px] font-semibold tracking-tight text-[#ececee]"
          >
            New workspace
          </h2>
          <p className="mt-0.5 truncate text-[12px] leading-5 text-[#8a8a92]">
            Pick a mode, a folder, and the few settings that matter.
          </p>
        </div>
        {allowClose ? (
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="
              inline-flex h-8 w-8 items-center justify-center rounded-md border border-[#24252b] bg-[#111216]
              text-[#9a9aa2] transition-colors hover:border-[#303139] hover:bg-[#17181d] hover:text-[#ececee]
              focus:outline-none focus-visible:ring-2 focus-visible:ring-[#5c7cff]/60
            "
          >
            <svg className="h-4 w-4" viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <path
                d="M3.5 3.5L12.5 12.5M12.5 3.5L3.5 12.5"
                stroke="currentColor"
                strokeWidth="1.6"
                strokeLinecap="round"
              />
            </svg>
          </button>
        ) : null}
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-[680px] px-6 pb-32 pt-6">
          <Section label="Workspace mode" hint="Choose how this workspace opens.">
            <div role="radiogroup" aria-label="Workspace mode" className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              {MODES.map((m) => (
                <ModeCard key={m} mode={m} active={mode === m} onSelect={handleSelectMode} />
              ))}
            </div>
          </Section>

          <Section label="Folder" hint="Workspace files live here. Recent folders are below.">
            <button
              type="button"
              onClick={() => void pickFolder()}
              className="
                flex h-[42px] w-full items-center gap-3 rounded-md border border-[#303139] bg-[#0d0e11] px-3
                text-left transition-colors hover:bg-[#111216]
                focus:outline-none focus-visible:ring-2 focus-visible:ring-[#5c7cff]/60
              "
            >
              <svg className="h-4 w-4 shrink-0 text-[#9a9aa2]" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                <path
                  d="M3.75 7.5C3.75 6.39543 4.64543 5.5 5.75 5.5H9.5L11.5 7.5H18.25C19.3546 7.5 20.25 8.39543 20.25 9.5V16.25C20.25 17.3546 19.3546 18.25 18.25 18.25H5.75C4.64543 18.25 3.75 17.3546 3.75 16.25V7.5Z"
                  stroke="currentColor"
                  strokeWidth="1.7"
                  strokeLinejoin="round"
                />
              </svg>
              <span
                className={`min-w-0 flex-1 truncate text-[13px] ${
                  folderPath ? 'text-[#d7d7dc]' : 'text-[#777780]'
                }`}
              >
                {folderPath ?? 'Choose a folder…'}
              </span>
              <span className="shrink-0 text-[12px] font-semibold text-[#a8a8b0]">Browse</span>
            </button>

            {recentFolders.length > 0 ? (
              <div className="mt-3">
                <div className="mb-1.5 px-1 text-[10px] font-semibold uppercase tracking-[0.12em] text-[#777780]">
                  Recent
                </div>
                <div className="space-y-0.5">
                  {recentFolders.map((recent) => {
                    const hint = folderHints.get(recent)
                    const hints: Array<'sprintengine' | 'multiloop'> = []
                    if (hint?.hasSprintEngineTeam) hints.push('sprintengine')
                    if (hint?.hasMultiloop) hints.push('multiloop')
                    return (
                      <RecentFolderRow
                        key={recent}
                        path={recent}
                        active={isSameFolder(folderPath, recent)}
                        hints={hints}
                        onSelect={handleSelectFolder}
                      />
                    )
                  })}
                </div>
              </div>
            ) : null}
          </Section>

          <Section
            label="Configure"
            hint={`Settings specific to the ${labelFor(mode).toLowerCase()} mode.`}
          >
            {mode === 'standard' ? (
              <StandardConfigure
                name={name}
                onChangeName={(value) => {
                  setName(value)
                  setNameTouched(true)
                }}
                onSubmit={() => void handleCreate()}
                showAdvanced={showAdvanced}
                onToggleAdvanced={() => setShowAdvanced((v) => !v)}
                layoutId={layoutId}
                onChangeLayoutId={setLayoutId}
              />
            ) : null}

            {mode === 'switchboard' ? (
              <SwitchboardConfigure
                name={name}
                onChangeName={(value) => {
                  setName(value)
                  setNameTouched(true)
                }}
                onSubmit={() => void handleCreate()}
              />
            ) : null}

            {mode === 'multiloop' ? (
              <MultiloopConfigure
                loopName={mlName}
                onChangeLoopName={(value) => {
                  setMlName(value)
                  setMlNameTouched(true)
                  setMlError(null)
                }}
                goal={mlGoal}
                onChangeGoal={(value) => {
                  setMlGoal(value)
                  setMlError(null)
                }}
                error={mlError}
              />
            ) : null}

            {mode === 'sprintengine' ? (
              <SprintEngineConfigure
                access={sprintEngineAccess}
                onSignIn={() => void startLogin()}
                folderPath={folderPath}
                isScanning={folderScan.isScanning}
                existingTeams={folderScan.result.teams}
                planOptions={folderScan.result.plans}
                path={sePath}
                onChangePath={(p) => {
                  setSePath(p)
                  setSeExistingTeam(null)
                  if (p === 'plan') {
                    /* keep existing plan selection */
                  } else {
                    setSePlanPath('')
                    setSePlanContent(null)
                  }
                  setSePlanError(null)
                }}
                planPath={sePlanPath}
                onSelectPlan={(p) => void handleSelectPlan(p)}
                planError={sePlanError}
                existingTeamSlug={seExistingTeam?.slug ?? ''}
                onSelectExistingTeam={handleSelectExistingTeam}
                teamName={seTeamName}
                onChangeTeamName={(value) => {
                  setSeExistingTeam(null)
                  setSeTeamName(value)
                  setSeTeamNameTouched(true)
                  setSePlanError(null)
                }}
                goal={seGoal}
                onChangeGoal={(value) => {
                  setSeExistingTeam(null)
                  setSeGoal(value)
                  setSePlanError(null)
                }}
                roleCounts={seRoleCounts}
                roleCliDefaults={seRoleCliDefaults}
                rosterDisabled={seExistingTeam != null}
                onSetRoleCount={setRoleCount}
                onSetRoleCli={setRoleCli}
                startRunner={seStartRunner}
                onChangeStartRunner={setSeStartRunner}
              />
            ) : null}
          </Section>
        </div>
      </div>

      <footer className="flex shrink-0 items-center justify-between gap-4 border-t border-[#1f2025] bg-[#0d0e11] px-5 py-3">
        <div className="min-w-0 flex-1 text-[12px] leading-5 text-[#8a8a92]">
          {blockingMessage}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {allowClose ? (
            <button
              type="button"
              onClick={onClose}
              className="
                h-8 rounded-md border border-[#24252b] bg-[#111216] px-3 text-[13px] font-medium text-[#d7d7dc]
                transition-colors hover:border-[#303139] hover:bg-[#17181d] hover:text-[#ececee]
                focus:outline-none focus-visible:ring-2 focus-visible:ring-[#5c7cff]/60
              "
            >
              Cancel
            </button>
          ) : null}
          <button
            type="button"
            onClick={() => void handleCreate()}
            disabled={!canCreate}
            className="
              h-8 rounded-md bg-[#5c7cff] px-4 text-[13px] font-semibold text-[#08090b]
              transition-colors hover:bg-[#6e8eff]
              disabled:cursor-not-allowed disabled:bg-[#17181d] disabled:text-[#5a5a63]
              focus:outline-none focus-visible:ring-2 focus-visible:ring-[#5c7cff]/60
            "
          >
            {createLabelFor(mode, isCreating, seExistingTeam != null)}
          </button>
        </div>
      </footer>
    </section>
  )
}

function Section({
  label,
  hint,
  children,
}: {
  label: string
  hint?: string
  children: React.ReactNode
}) {
  return (
    <section className="border-t border-[#1f2025] py-5 first:border-t-0 first:pt-0">
      <div className="mb-3 flex items-baseline justify-between gap-3">
        <h3 className="text-[13px] font-semibold text-[#ececee]">{label}</h3>
        {hint ? <p className="text-[11px] text-[#8a8a92]">{hint}</p> : null}
      </div>
      {children}
    </section>
  )
}

function FieldLabel({ children }: { children: React.ReactNode }) {
  return <span className="text-[11px] font-semibold uppercase tracking-[0.06em] text-[#9a9aa2]">{children}</span>
}

function StandardConfigure({
  name,
  onChangeName,
  onSubmit,
  showAdvanced,
  onToggleAdvanced,
  layoutId,
  onChangeLayoutId,
}: {
  name: string
  onChangeName: (value: string) => void
  onSubmit: () => void
  showAdvanced: boolean
  onToggleAdvanced: () => void
  layoutId: string
  onChangeLayoutId: (id: string) => void
}) {
  const layout = LAYOUT_TEMPLATES.find((t) => t.id === layoutId) ?? LAYOUT_TEMPLATES[0]
  return (
    <div className="space-y-4">
      <label className="flex flex-col gap-1.5">
        <FieldLabel>Workspace name</FieldLabel>
        <input
          value={name}
          onChange={(event) => onChangeName(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') onSubmit()
          }}
          placeholder="my-workspace"
          className="
            block h-[36px] w-full rounded-md border border-[#303139] bg-[#0d0e11] px-3
            text-[13px] text-[#ececee] outline-none transition-colors
            placeholder:text-[#5a5a63] focus:border-[#ececee]/70
          "
        />
      </label>

      <div>
        <button
          type="button"
          onClick={onToggleAdvanced}
          className="
            inline-flex items-center gap-1.5 text-[12px] font-medium text-[#8a8a92]
            hover:text-[#ececee] focus:outline-none focus-visible:underline
          "
        >
          <svg
            className={`h-3 w-3 transition-transform ${showAdvanced ? 'rotate-90' : ''}`}
            viewBox="0 0 12 12"
            fill="none"
            aria-hidden="true"
          >
            <path d="M4.5 3L7.5 6L4.5 9" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          IDE layout · {layout.name}
        </button>
        {showAdvanced ? (
          <div className="mt-2 space-y-1 rounded-md border border-[#1f2025] bg-[#0a0b0e] p-2">
            {LAYOUT_TEMPLATES.map((template) => {
              const active = template.id === layoutId
              return (
                <button
                  key={template.id}
                  type="button"
                  aria-pressed={active}
                  onClick={() => onChangeLayoutId(template.id)}
                  className={`
                    grid w-full grid-cols-[16px_minmax(0,1fr)] items-start gap-3 rounded px-2 py-1.5 text-left
                    transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-[#5c7cff]/60
                    ${active ? 'bg-[#17181d]' : 'hover:bg-[#111216]'}
                  `}
                >
                  <span
                    className={`mt-0.5 inline-flex h-3.5 w-3.5 items-center justify-center rounded-full border ${
                      active ? 'border-[#ececee] bg-[#ececee]' : 'border-[#3a3b42]'
                    }`}
                    aria-hidden="true"
                  >
                    {active ? <span className="h-1.5 w-1.5 rounded-full bg-[#08090b]" /> : null}
                  </span>
                  <span className="min-w-0">
                    <span className="block text-[13px] font-semibold text-[#ececee]">{template.name}</span>
                    <span className="block text-[11px] leading-4 text-[#9a9aa2]">{template.description}</span>
                  </span>
                </button>
              )
            })}
          </div>
        ) : null}
      </div>
    </div>
  )
}

function SwitchboardConfigure({
  name,
  onChangeName,
  onSubmit,
}: {
  name: string
  onChangeName: (value: string) => void
  onSubmit: () => void
}) {
  return (
    <label className="flex flex-col gap-1.5">
      <FieldLabel>Workspace name</FieldLabel>
      <input
        value={name}
        onChange={(event) => onChangeName(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter') onSubmit()
        }}
        placeholder="Switchboard"
        className="
          block h-[36px] w-full rounded-md border border-[#303139] bg-[#0d0e11] px-3
          text-[13px] text-[#ececee] outline-none transition-colors
          placeholder:text-[#5a5a63] focus:border-[#ececee]/70
        "
      />
    </label>
  )
}

function MultiloopConfigure({
  loopName,
  onChangeLoopName,
  goal,
  onChangeGoal,
  error,
}: {
  loopName: string
  onChangeLoopName: (value: string) => void
  goal: string
  onChangeGoal: (value: string) => void
  error: string | null
}) {
  return (
    <div className="space-y-4">
      <label className="flex flex-col gap-1.5">
        <FieldLabel>Loop name</FieldLabel>
        <input
          value={loopName}
          onChange={(event) => onChangeLoopName(event.target.value)}
          placeholder="Release Readiness"
          className="
            block h-[36px] w-full rounded-md border border-[#303139] bg-[#0d0e11] px-3
            text-[13px] font-medium text-[#ececee] outline-none transition-colors
            placeholder:text-[#5a5a63] focus:border-[#ececee]/70
          "
        />
      </label>
      <label className="flex flex-col gap-1.5">
        <FieldLabel>Final goal</FieldLabel>
        <textarea
          value={goal}
          onChange={(event) => onChangeGoal(event.target.value)}
          placeholder="What outcome should this loop reach?"
          className="
            min-h-[120px] w-full resize-none rounded-md border border-[#303139] bg-[#0d0e11] px-3 py-2.5
            text-[13px] leading-5 text-[#ececee] outline-none transition-colors
            placeholder:text-[#5a5a63] focus:border-[#ececee]/70
          "
        />
      </label>
      {error ? (
        <div className="border-l-2 border-[#ff787c] pl-3 text-[12px] leading-5 text-[#ffb3b5]">
          {error}
        </div>
      ) : null}
    </div>
  )
}

type SprintEngineAccessState = {
  allowed: boolean
  title: string
  body: string
  action: 'login'
}

function getSprintEngineAccessState(authState: MulticodeAuthState): SprintEngineAccessState {
  if (!authState.authenticated) {
    return {
      allowed: false,
      title: 'Sprint Engine mode is locked while signed out.',
      body: 'Sign in to create or supervise local Sprint Engine specialist workflows.',
      action: 'login',
    }
  }
  return {
    allowed: true,
    title: 'Sprint Engine mode is available.',
    body: 'This signed-in Multicode session can create local Sprint Engine workflows.',
    action: 'login',
  }
}

function SprintEngineConfigure(props: {
  access: SprintEngineAccessState
  onSignIn: () => void
  folderPath: string | null
  isScanning: boolean
  existingTeams: ExistingTeam[]
  planOptions: Array<{ path: string; relativePath: string }>
  path: SprintEnginePath
  onChangePath: (path: SprintEnginePath) => void
  planPath: string
  onSelectPlan: (sourcePath: string) => void
  planError: string | null
  existingTeamSlug: string
  onSelectExistingTeam: (slug: string) => void
  teamName: string
  onChangeTeamName: (value: string) => void
  goal: string
  onChangeGoal: (value: string) => void
  roleCounts: SprintEngineRoleCounts
  roleCliDefaults: Required<SprintEngineRoleCliDefaults>
  rosterDisabled: boolean
  onSetRoleCount: (role: SprintEngineRole, count: number) => void
  onSetRoleCli: (role: SprintEngineRole, cli: AgentCli) => void
  startRunner: boolean
  onChangeStartRunner: (value: boolean) => void
}) {
  const {
    access,
    onSignIn,
    folderPath,
    isScanning,
    existingTeams,
    planOptions,
    path,
    onChangePath,
    planPath,
    onSelectPlan,
    planError,
    existingTeamSlug,
    onSelectExistingTeam,
    teamName,
    onChangeTeamName,
    goal,
    onChangeGoal,
    roleCounts,
    roleCliDefaults,
    rosterDisabled,
    onSetRoleCount,
    onSetRoleCli,
    startRunner,
    onChangeStartRunner,
  } = props

  if (!access.allowed) {
    return (
      <div className="rounded-md border border-[#3a3426] bg-[#1a1408] p-4" aria-live="polite">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0 flex-1">
            <div className="text-[13px] font-semibold text-[#ffe0a3]">{access.title}</div>
            <p className="mt-1 max-w-md text-[12px] leading-5 text-[#a8a8b0]">{access.body}</p>
          </div>
          <button
            type="button"
            onClick={onSignIn}
            className="
              h-8 shrink-0 rounded-md bg-[#ececee] px-3 text-[12px] font-semibold text-[#08090b]
              transition-colors hover:bg-white
              focus:outline-none focus-visible:ring-2 focus-visible:ring-[#5c7cff]/60
            "
          >
            Sign in
          </button>
        </div>
      </div>
    )
  }

  const planAvailable = planOptions.length > 0
  const teamAvailable = existingTeams.length > 0

  return (
    <div className="space-y-5">
      <div role="radiogroup" aria-label="Sprint Engine starting point" className="grid gap-1.5">
        <PathRadio
          checked={path === 'new'}
          label="Start a new team"
          hint="Define an objective, pick specialists, run from scratch."
          onSelect={() => onChangePath('new')}
        />
        <PathRadio
          checked={path === 'existing'}
          disabled={!teamAvailable}
          label="Load an existing team"
          hint={
            isScanning
              ? 'Scanning the folder for saved teams…'
              : teamAvailable
                ? `${existingTeams.length} team${existingTeams.length === 1 ? '' : 's'} saved in this folder.`
                : !folderPath
                  ? 'Pick a folder to detect saved teams.'
                  : 'No saved teams in this folder.'
          }
          onSelect={() => onChangePath('existing')}
        />
        <PathRadio
          checked={path === 'plan'}
          disabled={!planAvailable && !planPath}
          label="Source from a plan"
          hint={
            isScanning
              ? 'Scanning the folder for markdown plans…'
              : planAvailable
                ? `${planOptions.length} markdown plan${planOptions.length === 1 ? '' : 's'} available.`
                : !folderPath
                  ? 'Pick a folder to detect markdown plans.'
                  : 'No markdown plans found.'
          }
          onSelect={() => onChangePath('plan')}
        />
      </div>

      {path === 'existing' ? (
        <label className="flex flex-col gap-1.5">
          <FieldLabel>Team</FieldLabel>
          <select
            value={existingTeamSlug}
            onChange={(event) => onSelectExistingTeam(event.target.value)}
            disabled={isScanning || existingTeams.length === 0}
            className="
              h-[36px] w-full rounded-md border border-[#303139] bg-[#0d0e11] px-3
              text-[13px] font-medium text-[#d7d7dc] outline-none transition-colors
              focus:border-[#ececee]/70 disabled:text-[#5a5a63]
            "
          >
            <option value="">Select a team…</option>
            {existingTeams.map((team) => (
              <option key={team.slug} value={team.slug}>
                {team.displayName}
              </option>
            ))}
          </select>
        </label>
      ) : null}

      {path === 'plan' ? (
        <label className="flex flex-col gap-1.5">
          <FieldLabel>Markdown plan</FieldLabel>
          <select
            value={planPath}
            onChange={(event) => onSelectPlan(event.target.value)}
            disabled={!folderPath || isScanning}
            className="
              h-[36px] w-full rounded-md border border-[#303139] bg-[#0d0e11] px-3
              text-[13px] font-medium text-[#d7d7dc] outline-none transition-colors
              focus:border-[#ececee]/70 disabled:text-[#5a5a63]
            "
          >
            <option value="">Select a plan…</option>
            {planOptions.map((plan) => (
              <option key={plan.path} value={plan.path}>
                {plan.relativePath}
              </option>
            ))}
          </select>
        </label>
      ) : null}

      {planError ? (
        <div className="border-l-2 border-[#ff787c] pl-3 text-[12px] leading-5 text-[#ffb3b5]">
          {planError}
        </div>
      ) : null}

      <div className="grid gap-4 sm:grid-cols-2">
        <label className="flex flex-col gap-1.5">
          <FieldLabel>Team name</FieldLabel>
          <input
            value={teamName}
            onChange={(event) => onChangeTeamName(event.target.value)}
            placeholder="Interface Team"
            className="
              block h-[36px] w-full rounded-md border border-[#303139] bg-[#0d0e11] px-3
              text-[13px] font-medium text-[#ececee] outline-none transition-colors
              placeholder:text-[#5a5a63] focus:border-[#ececee]/70
            "
          />
        </label>
      </div>

      <label className="flex flex-col gap-1.5">
        <FieldLabel>Objective</FieldLabel>
        <textarea
          value={goal}
          onChange={(event) => onChangeGoal(event.target.value)}
          placeholder="What outcome should this team deliver?"
          className="
            min-h-[100px] w-full resize-none rounded-md border border-[#303139] bg-[#0d0e11] px-3 py-2.5
            text-[13px] leading-5 text-[#ececee] outline-none transition-colors
            placeholder:text-[#5a5a63] focus:border-[#ececee]/70
          "
        />
      </label>

      <div>
        <div className="mb-2 flex items-baseline justify-between">
          <FieldLabel>Roster</FieldLabel>
          <span className="text-[11px] text-[#8a8a92]">
            {countSprintEngineAgents(roleCounts)} specialist
            {countSprintEngineAgents(roleCounts) === 1 ? '' : 's'}
          </span>
        </div>
        <SprintEngineRosterTable
          roleCounts={roleCounts}
          roleCliDefaults={roleCliDefaults}
          disabled={rosterDisabled}
          onSetCount={onSetRoleCount}
          onSetCli={onSetRoleCli}
        />
      </div>

      <label className="flex items-start justify-between gap-3 rounded-md border border-[#1f2025] bg-[#0a0b0e] px-3 py-2.5">
        <span className="min-w-0">
          <span className="block text-[13px] font-semibold text-[#ececee]">
            Start roster runner when workspace opens
          </span>
          <span className="mt-0.5 block text-[11px] leading-4 text-[#9a9aa2]">
            Launch selected Sprint Engine agents in the background as soon as the workspace mounts.
          </span>
        </span>
        <input
          type="checkbox"
          checked={startRunner}
          onChange={(event) => onChangeStartRunner(event.currentTarget.checked)}
          className="mt-0.5 h-4 w-4 shrink-0 accent-[#5c7cff] focus:outline-none focus:ring-2 focus:ring-[#5c7cff]"
        />
      </label>
    </div>
  )
}

function PathRadio({
  checked,
  label,
  hint,
  disabled,
  onSelect,
}: {
  checked: boolean
  label: string
  hint: string
  disabled?: boolean
  onSelect: () => void
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={checked}
      disabled={disabled}
      onClick={onSelect}
      className={`
        grid w-full grid-cols-[16px_minmax(0,1fr)] items-start gap-3 rounded-md border px-3 py-2.5 text-left
        transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-[#5c7cff]/60
        disabled:cursor-not-allowed disabled:opacity-55
        ${checked ? 'border-[#3a3b42] bg-[#17181d]' : 'border-[#1f2025] bg-[#0d0e11] hover:border-[#303139] hover:bg-[#111216]'}
      `}
    >
      <span
        className={`mt-0.5 inline-flex h-3.5 w-3.5 items-center justify-center rounded-full border ${
          checked ? 'border-[#ececee] bg-[#ececee]' : 'border-[#3a3b42]'
        }`}
        aria-hidden="true"
      >
        {checked ? <span className="h-1.5 w-1.5 rounded-full bg-[#08090b]" /> : null}
      </span>
      <span className="min-w-0">
        <span className={`block text-[13px] font-semibold ${checked ? 'text-[#ececee]' : 'text-[#d7d7dc]'}`}>
          {label}
        </span>
        <span className="mt-0.5 block text-[11px] leading-4 text-[#9a9aa2]">{hint}</span>
      </span>
    </button>
  )
}

function labelFor(mode: CreationMode): string {
  switch (mode) {
    case 'standard':
      return 'Standard'
    case 'switchboard':
      return 'Switchboard'
    case 'sprintengine':
      return 'Sprint Engine'
    case 'multiloop':
      return 'Multiloop'
  }
}

function createLabelFor(mode: CreationMode, isCreating: boolean, hasExistingTeam: boolean): string {
  if (isCreating) return 'Creating…'
  if (mode === 'sprintengine' && hasExistingTeam) return 'Load team'
  switch (mode) {
    case 'sprintengine':
      return 'Create Sprint Engine'
    case 'switchboard':
      return 'Create Switchboard'
    case 'multiloop':
      return 'Create Multiloop'
    case 'standard':
      return 'Create workspace'
  }
}

function computeBlockingMessage(args: {
  mode: CreationMode
  folderPath: string | null
  name: string
  standardComplete: boolean
  switchboardObjectiveComplete: boolean
  multiloopComplete: boolean
  sprintEngineAccess: SprintEngineAccessState
  sprintEngineComplete: boolean
  sePath: SprintEnginePath
  sePlanReady: boolean
  seExistingTeam: ExistingTeam | null
  seObjectiveComplete: boolean
  totalAgents: number
}): string {
  const {
    mode,
    folderPath,
    name,
    standardComplete,
    switchboardObjectiveComplete,
    multiloopComplete,
    sprintEngineAccess,
    sprintEngineComplete,
    sePath,
    sePlanReady,
    seExistingTeam,
    seObjectiveComplete,
    totalAgents,
  } = args

  if (mode === 'standard') {
    if (!folderPath) return 'Pick a folder to continue.'
    if (!standardComplete) return 'Give the workspace a name.'
    return 'Ready to create.'
  }
  if (mode === 'switchboard') {
    if (!folderPath) return 'Pick a folder to continue.'
    if (!switchboardObjectiveComplete) return 'Give the workspace a name.'
    return 'Ready to create.'
  }
  if (mode === 'multiloop') {
    if (!folderPath) return 'Pick a folder to continue.'
    if (!name && !multiloopComplete) return 'Add a loop name and a final goal.'
    if (!multiloopComplete) return 'A loop name and final goal are required.'
    return 'Ready to create.'
  }
  // SprintEngine
  if (!sprintEngineAccess.allowed) return 'Sign in to use Sprint Engine mode.'
  if (!folderPath) return 'Pick a folder to continue.'
  if (sePath === 'plan' && !sePlanReady) return 'Select a markdown plan.'
  if (seExistingTeam) return 'Ready to load team.'
  if (!seObjectiveComplete) return 'Add a team name and an objective.'
  if (totalAgents === 0) return 'Add at least one specialist.'
  if (sprintEngineComplete) return 'Ready to create.'
  return 'Add the missing details to continue.'
}
