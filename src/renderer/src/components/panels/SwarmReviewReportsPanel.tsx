import { useEffect, useState } from 'react'
import { getSpecialistAction } from '../../specialists/specialistActions'
import { useWorkspaceStore } from '../../store/workspaceStore'

function basename(path: string): string {
  return path.split(/[/\\]/).filter(Boolean).pop() ?? path
}

export default function SwarmReviewReportsPanel({ workspaceId }: { workspaceId: string }) {
  const state = useWorkspaceStore((s) =>
    s.workspaces.find((workspace) => workspace.id === workspaceId)?.swarmReviewState ?? null
  )
  const [selectedPath, setSelectedPath] = useState(state?.agents[0]?.reportPath ?? '')
  const [content, setContent] = useState('')
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!selectedPath) {
      setContent('')
      return
    }
    let disposed = false
    window.api.readfile(selectedPath)
      .then((value) => {
        if (!disposed) {
          setContent(value)
          setError(null)
        }
      })
      .catch((readError) => {
        if (!disposed) {
          setContent('')
          setError(readError instanceof Error ? readError.message : 'Report not written yet.')
        }
      })
    return () => {
      disposed = true
    }
  }, [selectedPath])

  useEffect(() => {
    if (!selectedPath && state?.agents[0]?.reportPath) setSelectedPath(state.agents[0].reportPath)
  }, [selectedPath, state?.agents])

  if (!state) {
    return <div className="h-full bg-[#08090b] p-4 text-sm text-[#8a8a92]">No swarm review reports.</div>
  }

  return (
    <div className="grid h-full grid-cols-[260px_minmax(0,1fr)] bg-[#08090b] text-sm text-[#d7d7dc]">
      <aside className="overflow-auto border-r border-[#24252b] bg-[#0d0e11]">
        <div className="border-b border-[#24252b] px-3 py-2 text-[12px] font-semibold text-[#9a9aa2]">Reports</div>
        {state.agents.map((agent) => {
          const specialist = getSpecialistAction(agent.specialistId)
          const selected = selectedPath === agent.reportPath
          return (
            <button
              key={agent.agentId}
              type="button"
              onClick={() => setSelectedPath(agent.reportPath)}
              className={`block w-full border-b border-[#1f2025] px-3 py-3 text-left ${selected ? 'bg-[#17181d]' : 'hover:bg-[#111216]'}`}
            >
              <span className="block truncate text-[13px] font-semibold text-[#ececee]">{specialist.shortLabel}</span>
              <span className="mt-1 block truncate font-mono text-[11px] text-[#6f7078]">{basename(agent.reportPath)}</span>
            </button>
          )
        })}
      </aside>
      <main className="overflow-auto p-4">
        <div className="mb-3 font-mono text-[12px] text-[#6f7078]">{selectedPath}</div>
        {error ? (
          <div className="border-l border-[#ff787c] pl-3 text-[12px] leading-5 text-[#ffb3b5]">{error}</div>
        ) : (
          <pre className="whitespace-pre-wrap text-[13px] leading-6 text-[#d7d7dc]">{content}</pre>
        )}
      </main>
    </div>
  )
}
