import { useState } from 'react'
import { getSpecialistAction } from '../../specialists/specialistActions'
import { useWorkspaceStore } from '../../store/workspaceStore'
import type { AgentState } from '../../types/workspace'
import { focusOrAddAgentTab } from '../../utils/modelRegistry'
import { prependAgentIdentifier } from '../../utils/agentPrompt'
import { buildSwarmReviewReportTemplate, buildSwarmReviewStartupPrompt } from '../../utils/swarmReviewPrompt'
import { sectorLabel } from '../../utils/swarmReview'

function pathSeparatorFor(path: string): string {
  return path.includes('\\') && !path.includes('/') ? '\\' : '/'
}

function basename(path: string): string {
  return path.split(/[/\\]/).filter(Boolean).pop() ?? path
}

function isPathOrChild(path: string, parentPath: string): boolean {
  const separator = pathSeparatorFor(parentPath)
  return path === parentPath || path.startsWith(`${parentPath.replace(/[\\/]+$/u, '')}${separator}`)
}

async function ensureReportFile(path: string, content: string): Promise<void> {
  const existing = await window.api.readfile(path).catch(() => '')
  if (existing.trim().length > 0) return
  await window.api.writefile(path, content)
}

async function ensureOutputDirectory(workspaceRoot: string, runId: string): Promise<void> {
  const multiCode = await window.api.ensureDir(workspaceRoot, '.multi-code')
  const reviews = await window.api.ensureDir(multiCode, 'swarm-reviews')
  await window.api.ensureDir(reviews, runId)
}

export default function SwarmReviewBriefPanel({ workspaceId }: { workspaceId: string }) {
  const workspace = useWorkspaceStore((s) => s.workspaces.find((w) => w.id === workspaceId))
  const updateAgent = useWorkspaceStore((s) => s.updateAgent)
  const updateSwarmReviewAgentStatus = useWorkspaceStore((s) => s.updateSwarmReviewAgentStatus)
  const [launching, setLaunching] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const state = workspace?.swarmReviewState ?? null

  const launch = async () => {
    if (!workspace?.folderPath || !state) return
    setLaunching(true)
    setMessage(null)

    try {
      if (!isPathOrChild(state.outputDirectory, workspace.folderPath)) {
        setMessage('Report directory must stay inside the workspace.')
        return
      }

      await ensureOutputDirectory(workspace.folderPath, state.runId)
      await ensureReportFile(
        `${state.outputDirectory}${pathSeparatorFor(state.outputDirectory)}README.md`,
        [
          `# ${state.name}`,
          '',
          state.objective,
          '',
          '## Reports',
          '',
          ...state.agents.map((agent) => {
            const specialist = getSpecialistAction(agent.specialistId)
            return `- ${specialist.shortLabel}: ${basename(agent.reportPath)}`
          }),
          '',
        ].join('\n')
      )

      for (const reviewAgent of state.agents) {
        const specialist = getSpecialistAction(reviewAgent.specialistId)
        await ensureReportFile(
          reviewAgent.reportPath,
          buildSwarmReviewReportTemplate({ agent: reviewAgent, state, workspaceRoot: workspace.folderPath })
        )
        const prompt = buildSwarmReviewStartupPrompt({
          agent: reviewAgent,
          state,
          workspaceRoot: workspace.folderPath,
        })
        const agentPatch: Partial<AgentState> = {
          name: specialist.shortLabel,
          kind: 'swarm_review',
          specialistId: reviewAgent.specialistId,
          cli: reviewAgent.cli ?? 'codex',
          cliPermissionPreset: 'default',
          cliStartupPrompt: prependAgentIdentifier(prompt, specialist.shortLabel, specialist.shortLabel),
          cliStartRequested: true,
          cliOnboardingPromptSent: false,
          cliHasLaunched: false,
          cliResumeAvailable: false,
          cliSessionId: crypto.randomUUID(),
        }
        updateAgent(workspaceId, reviewAgent.agentId, agentPatch)
        updateSwarmReviewAgentStatus(workspaceId, reviewAgent.agentId, 'running')
        focusOrAddAgentTab(workspaceId, reviewAgent.agentId, specialist.shortLabel)
      }
      setMessage('Swarm review agents launched.')
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Could not launch swarm review.')
    } finally {
      setLaunching(false)
    }
  }

  if (!workspace || !state) {
    return <div className="h-full bg-[#08090b] p-4 text-sm text-[#8a8a92]">No swarm review configured.</div>
  }

  return (
    <div className="h-full overflow-auto bg-[#08090b] p-4 text-sm text-[#d7d7dc]">
      <div className="mx-auto max-w-5xl space-y-5">
        <div className="flex items-start justify-between gap-4 border-b border-[#24252b] pb-4">
          <div className="min-w-0">
            <h2 className="truncate text-base font-semibold text-[#ececee]">{state.name}</h2>
            <p className="mt-2 max-w-3xl text-[13px] leading-6 text-[#a1a1aa]">{state.objective}</p>
            <p className="mt-2 font-mono text-[12px] text-[#6f7078]">{state.outputDirectory}</p>
          </div>
          <button
            type="button"
            onClick={launch}
            disabled={launching || !workspace.folderPath}
            className="h-8 shrink-0 rounded-md border border-[#ececee] bg-[#ececee] px-3 text-[12px] font-semibold text-[#08090b] disabled:opacity-50"
          >
            {launching ? 'Launching...' : 'Launch selected'}
          </button>
        </div>

        {message ? (
          <div className="border-l border-[#5c7cff] pl-3 text-[12px] leading-5 text-[#b9c4ff]">{message}</div>
        ) : null}

        <div className="grid gap-3 lg:grid-cols-2">
          {state.agents.map((agent) => {
            const specialist = getSpecialistAction(agent.specialistId)
            return (
              <div key={agent.agentId} className="rounded-md border border-[#24252b] bg-[#0d0e11] p-3">
                <div className="flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <div className="truncate text-sm font-semibold text-[#ececee]">{specialist.shortLabel}</div>
                    <div className="mt-1 truncate font-mono text-[11px] text-[#6f7078]">{agent.reportPath}</div>
                  </div>
                  <span className="shrink-0 rounded border border-[#303139] px-2 py-1 text-[11px] text-[#a1a1aa]">
                    {agent.status}
                  </span>
                </div>
                <div className="mt-3 flex flex-wrap gap-1.5">
                  {agent.sectors.map((sector) => (
                    <span key={sector} className="rounded border border-[#303139] bg-[#111216] px-2 py-1 text-[11px] text-[#d7d7dc]">
                      {sectorLabel(sector)}
                    </span>
                  ))}
                </div>
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}
