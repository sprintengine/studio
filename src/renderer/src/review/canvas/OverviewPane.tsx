import type { ReactNode } from 'react'

import type { KnowledgeRef, ReviewBrief } from '../../../../shared/review'
import { InlineNotice } from '../../components/ui/InlineNotice'

interface OverviewPaneProps {
  overview: ReviewBrief['overview']
  knowledgeRefs: KnowledgeRef[]
  // Changed files the guide did not fold into any step. Surfaced as a warn notice
  // so coverage gaps are honest, never hidden.
  unassignedPaths: string[]
  // MC-1685 supplies the ChangeMapView here; T7 reserves the slot and renders
  // nothing when it is absent.
  changeMapSlot?: ReactNode
}

function LabeledParagraph({ label, children }: { label: string; children: ReactNode }) {
  return (
    <p className="mb-4 max-w-[80ch] text-body leading-[1.55] text-[color:var(--text-muted)]">
      <span className="font-medium text-[color:var(--text-strong)]">{label}</span> {children}
    </p>
  )
}

// The Overview pane: what the change is, its blast radius, and how to read it,
// then the reserved change-map slot. Knowledge the guide grounded the walkthrough
// in is surfaced as a list in strong ink rather than silently inlined — strong,
// not accent: the refs are not links, and the accent is the view's one action.
export function OverviewPane({ overview, knowledgeRefs, unassignedPaths, changeMapSlot }: OverviewPaneProps) {
  return (
    <div>
      <h4 className="mb-2 text-title font-semibold tracking-tight text-[color:var(--text-strong)]">Overview</h4>
      {unassignedPaths.length > 0 ? (
        <InlineNotice tone="warn" className="mb-4 max-w-[80ch]">
          <span className="font-medium">Not covered by the walkthrough</span> — {unassignedPaths.length}{' '}
          {unassignedPaths.length === 1 ? 'file' : 'files'} the guide did not fold into a step:
          <span className="mt-1 block font-mono text-meta">{unassignedPaths.join(', ')}</span>
        </InlineNotice>
      ) : null}
      <LabeledParagraph label="What this is.">{overview.intent}</LabeledParagraph>
      <LabeledParagraph label="Blast radius.">{overview.blastRadius}</LabeledParagraph>
      <LabeledParagraph label="How it reads.">{overview.readingGuide}</LabeledParagraph>

      {knowledgeRefs.length > 0 ? (
        <p className="mb-4 max-w-[80ch] text-meta leading-5 text-[color:var(--text-subtle)]">
          <span className="font-medium text-[color:var(--text-muted)]">Grounded in </span>
          {knowledgeRefs.map((ref, index) => (
            <span key={ref.note}>
              <span className="text-[color:var(--text-strong)]">{ref.note}</span>
              {index < knowledgeRefs.length - 1 ? ', ' : ''}
            </span>
          ))}
        </p>
      ) : null}

      {changeMapSlot ?? null}
    </div>
  )
}

export default OverviewPane
