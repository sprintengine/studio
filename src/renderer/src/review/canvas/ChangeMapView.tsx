import type { KeyboardEvent } from 'react'

import type { ChangeMap } from '../../../../shared/review'
import { FOCUS_RING_CLASS } from '../../components/ui/tokens'
import {
  computeChangeMapLayout,
  type ChangeMapLayoutNode,
} from './changeMapLayout'

interface ChangeMapViewProps {
  changeMap: ChangeMap
  // The brief's steps in reading order — fixes column order and node badges.
  orderedStepIds: string[]
  // Navigate to a node's step. The same local step navigation the rail uses;
  // there is no shared goto primitive.
  onNavigate: (stepId: string) => void
}

const ARROW_MARKER_ID = 'review-change-map-arrow'

// The Overview change map: a small entity-relationship view of the change, laid
// out deterministically by reviewChangeMapLayout (no mermaid, no agent-drawn
// diagram). Token-only SVG; every node navigates to its step by click or Enter,
// and the whole diagram carries a prose aria-label so a screen reader never has
// to parse geometry.
export function ChangeMapView({ changeMap, orderedStepIds, onNavigate }: ChangeMapViewProps) {
  const layout = computeChangeMapLayout(changeMap, orderedStepIds)
  if (layout.nodes.length === 0) return null

  return (
    <section className="mb-5 mt-0.5 max-w-[680px]">
      {/* `ui/Section`'s heading treatment, not the component: the head would
          carry its own inset and indent the label against the diagram's edge.
          The size and ink are the section heading's, so this reads as one
          heading family with the "In this step" column beside it. */}
      <h3 className="mb-2 text-meta font-semibold text-[color:var(--text-strong)]">Change map</h3>
      <div className="overflow-x-auto">
        <svg
          viewBox={`0 0 ${layout.width} ${layout.height}`}
          role="group"
          aria-label={layout.ariaLabel}
          className="block h-auto w-full"
          style={{ maxWidth: layout.width, minWidth: Math.min(layout.width, 480) }}
        >
          <defs>
            <marker
              id={ARROW_MARKER_ID}
              viewBox="0 0 8 8"
              refX={7}
              refY={4}
              markerWidth={7}
              markerHeight={7}
              orient="auto"
            >
              <path d="M0 0 L8 4 L0 8 Z" className="[fill:var(--border-strong)]" />
            </marker>
          </defs>

          {layout.edges.map((edge, index) => (
            <g key={`${edge.from}->${edge.to}-${index}`}>
              <path
                d={edge.path}
                fill="none"
                strokeWidth={1}
                className="[stroke:var(--border-strong)]"
                markerEnd={`url(#${ARROW_MARKER_ID})`}
              />
              {edge.label ? (
                <text
                  x={edge.labelX}
                  y={edge.labelY}
                  textAnchor="middle"
                  fontSize={9}
                  className="[fill:var(--text-subtle)]"
                >
                  {edge.label}
                </text>
              ) : null}
            </g>
          ))}

          {layout.nodes.map((node) => (
            <ChangeMapNodeGlyph key={node.id} node={node} onNavigate={onNavigate} />
          ))}
        </svg>
      </div>

      {changeMap.deployNote ? (
        <p className="mt-2 max-w-[66ch] text-meta leading-5 text-[color:var(--text-subtle)]">
          <span className="font-medium text-[color:var(--text-muted)]">Deploy order:</span> {changeMap.deployNote}
        </p>
      ) : null}
    </section>
  )
}

function ChangeMapNodeGlyph({
  node,
  onNavigate,
}: {
  node: ChangeMapLayoutNode
  onNavigate: (stepId: string) => void
}) {
  const onKeyDown = (event: KeyboardEvent<SVGGElement>) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault()
      onNavigate(node.stepId)
    }
  }
  const label = node.sublabel
    ? `${node.label} — ${node.sublabel}. Go to step ${node.stepBadge}.`
    : `${node.label}. Go to step ${node.stepBadge}.`
  const badgeCx = node.x + node.width - 15
  const badgeCy = node.y + 15

  return (
    <g
      role="button"
      tabIndex={0}
      aria-label={label}
      onClick={() => onNavigate(node.stepId)}
      onKeyDown={onKeyDown}
      // The product's one focus indicator, on the node itself. The accent
      // stroke used to double as the focus treatment (with the UA outline
      // suppressed), which was a second focus idiom in accent ink; the stroke
      // now answers hover only.
      className={`group cursor-pointer ${FOCUS_RING_CLASS}`}
    >
      <rect
        x={node.x}
        y={node.y}
        width={node.width}
        height={node.height}
        rx={7}
        strokeWidth={1}
        className="[fill:var(--bg-hover)] [stroke:var(--border-default)] transition-[fill,stroke] duration-[var(--motion-fast)] ease-[var(--motion-ease)] group-hover:[fill:var(--accent-primary-soft)] group-hover:[stroke:var(--accent-primary)] motion-reduce:transition-none"
      />
      <text
        x={node.x + 16}
        y={node.sublabel ? node.y + 23 : node.y + 31}
        fontSize={11}
        fontWeight={500}
        className="[fill:var(--text-strong)]"
      >
        {node.label}
      </text>
      {node.sublabel ? (
        <text
          x={node.x + 16}
          y={node.y + 41}
          fontSize={9.5}
          className="font-mono [fill:var(--text-subtle)]"
        >
          {node.sublabel}
        </text>
      ) : null}
      <circle cx={badgeCx} cy={badgeCy} r={8} strokeWidth={1} className="[fill:var(--bg-surface)] [stroke:var(--border-strong)]" />
      <text
        x={badgeCx}
        y={badgeCy + 3}
        textAnchor="middle"
        fontSize={9}
        fontWeight={600}
        className="tabular-nums [fill:var(--text-muted)]"
      >
        {node.stepBadge}
      </text>
    </g>
  )
}

export default ChangeMapView
