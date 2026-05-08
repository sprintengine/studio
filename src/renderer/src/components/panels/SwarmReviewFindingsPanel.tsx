import { useEffect, useMemo, useState } from 'react'
import { getSpecialistAction } from '../../specialists/specialistActions'
import { useWorkspaceStore } from '../../store/workspaceStore'
import { sectorLabel } from '../../utils/swarmReview'

type Finding = {
  source: string
  severity: string
  area: string
  file: string
  finding: string
  recommendation: string
}

function parseFindings(source: string, content: string): Finding[] {
  return content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.startsWith('|') && !line.includes('---') && !line.includes('Severity | Area'))
    .map((line) => line.split('|').slice(1, -1).map((cell) => cell.trim()))
    .filter((cells) => cells.length >= 5 && cells.some(Boolean))
    .map((cells) => ({
      source,
      severity: cells[0],
      area: cells[1],
      file: cells[2],
      finding: cells[3],
      recommendation: cells[4],
    }))
}

export default function SwarmReviewFindingsPanel({ workspaceId }: { workspaceId: string }) {
  const state = useWorkspaceStore((s) =>
    s.workspaces.find((workspace) => workspace.id === workspaceId)?.swarmReviewState ?? null
  )
  const [findings, setFindings] = useState<Finding[]>([])

  useEffect(() => {
    if (!state) {
      setFindings([])
      return
    }
    let disposed = false
    Promise.all(
      state.agents.map(async (agent) => {
        const content = await window.api.readfile(agent.reportPath).catch(() => '')
        const specialist = getSpecialistAction(agent.specialistId)
        return parseFindings(specialist.shortLabel, content)
      })
    ).then((groups) => {
      if (!disposed) setFindings(groups.flat())
    })
    return () => {
      disposed = true
    }
  }, [state])

  const sectorSummary = useMemo(() => state?.agents.flatMap((agent) =>
    agent.sectors.map((sector) => ({
      agentId: agent.agentId,
      specialist: getSpecialistAction(agent.specialistId).shortLabel,
      sector,
    }))
  ) ?? [], [state])

  if (!state) {
    return <div className="h-full bg-[#08090b] p-4 text-sm text-[#8a8a92]">No findings available.</div>
  }

  return (
    <div className="h-full overflow-auto bg-[#08090b] p-4 text-sm text-[#d7d7dc]">
      <div className="mx-auto max-w-6xl space-y-5">
        <section>
          <h2 className="text-base font-semibold text-[#ececee]">Findings Matrix</h2>
          <p className="mt-1 text-[12px] text-[#8a8a92]">Parsed from report Markdown findings tables.</p>
        </section>

        <section className="grid gap-2 lg:grid-cols-3">
          {sectorSummary.map((item) => (
            <div key={`${item.agentId}-${item.sector}`} className="rounded-md border border-[#24252b] bg-[#0d0e11] px-3 py-2">
              <div className="truncate text-[12px] font-semibold text-[#ececee]">{sectorLabel(item.sector)}</div>
              <div className="mt-1 truncate text-[11px] text-[#8a8a92]">{item.specialist}</div>
            </div>
          ))}
        </section>

        <section className="overflow-hidden rounded-md border border-[#24252b]">
          <table className="w-full border-collapse text-left text-[12px]">
            <thead className="bg-[#111216] text-[#9a9aa2]">
              <tr>
                <th className="border-b border-[#24252b] px-3 py-2">Severity</th>
                <th className="border-b border-[#24252b] px-3 py-2">Area</th>
                <th className="border-b border-[#24252b] px-3 py-2">File</th>
                <th className="border-b border-[#24252b] px-3 py-2">Finding</th>
                <th className="border-b border-[#24252b] px-3 py-2">Recommendation</th>
                <th className="border-b border-[#24252b] px-3 py-2">Source</th>
              </tr>
            </thead>
            <tbody>
              {findings.length === 0 ? (
                <tr>
                  <td colSpan={6} className="px-3 py-8 text-center text-[#6f7078]">No findings parsed yet.</td>
                </tr>
              ) : findings.map((finding, index) => (
                <tr key={`${finding.source}-${index}`} className="odd:bg-[#0d0e11]">
                  <td className="border-t border-[#1f2025] px-3 py-2 align-top">{finding.severity}</td>
                  <td className="border-t border-[#1f2025] px-3 py-2 align-top">{finding.area}</td>
                  <td className="border-t border-[#1f2025] px-3 py-2 align-top font-mono text-[#a1a1aa]">{finding.file}</td>
                  <td className="border-t border-[#1f2025] px-3 py-2 align-top">{finding.finding}</td>
                  <td className="border-t border-[#1f2025] px-3 py-2 align-top">{finding.recommendation}</td>
                  <td className="border-t border-[#1f2025] px-3 py-2 align-top">{finding.source}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      </div>
    </div>
  )
}
