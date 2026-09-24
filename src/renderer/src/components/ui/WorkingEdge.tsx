import type { JSX } from 'react'

type WorkingEdgeProps = {
  /** What is being worked on, announced once to screen readers ("Resuming agent"). */
  label: string
}

// Spec: design-system/components/working-edge/component.md.
//
// A light that travels round the edge of a surface that is being brought back
// to life while its content stays readable — a paused terminal resuming. It
// draws on the edge only, never over the content, and takes no pointer events,
// so the surface under it can still be read, scrolled and selected.
//
// Place it as the last child of a positioned surface; it fills that surface's
// box and follows its radius. The motion lives in `.working-edge` (index.css),
// which also carries the reduced-motion treatment: a still accent ring.
export function WorkingEdge({ label }: WorkingEdgeProps): JSX.Element {
  return (
    <>
      <div aria-hidden="true" className="working-edge" />
      <span role="status" className="sr-only">
        {label}
      </span>
    </>
  )
}
