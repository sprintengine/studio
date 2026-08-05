import React, { Suspense, type ReactNode } from 'react'

import type { WorkspaceTypeCreationStep } from '../../../modules/renderer-host'
import { InlineNotice } from '../../ui'

// A throwing module step component must never block the hub: the boundary
// swallows the throw, reports it inline, and creation proceeds zero-config
// (stepValue undefined) — see ModuleCreationStepSection.
class ModuleStepBoundary extends React.Component<
  { onBroken: () => void; children: ReactNode },
  { failed: boolean }
> {
  state = { failed: false }

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true }
  }

  componentDidCatch(error: unknown): void {
    console.error('[modules] workspace creation step component threw:', error)
    this.props.onBroken()
  }

  render(): ReactNode {
    return this.state.failed ? null : this.props.children
  }
}

// The module-contributed config page (WorkspaceTypeDefinition.creationStep),
// in the same chrome as the hub's ConfigStepSection but with the step's own
// registered heading instead of a STEP_HEADING entry.
export function ModuleCreationStepSection({
  step,
  headingRef,
  value,
  setValue,
  broken,
  onBroken,
}: {
  step: WorkspaceTypeCreationStep
  headingRef?: React.Ref<HTMLHeadingElement>
  value: unknown
  setValue: (value: unknown) => void
  broken: boolean
  onBroken: () => void
}) {
  const StepComponent = step.Component
  return (
    <section className="flex min-h-0 flex-1 flex-col gap-4">
      <header className="flex flex-col gap-1.5">
        <h3
          ref={headingRef}
          tabIndex={-1}
          className="text-title font-semibold leading-6 tracking-tight text-[color:var(--text-strong)] outline-none"
        >
          {step.heading}
        </h3>
        {step.description ? (
          <p className="text-body leading-5 text-[color:var(--text-muted)]">{step.description}</p>
        ) : null}
      </header>
      {broken ? (
        <InlineNotice tone="error">
          This step hit an error and was skipped — the workspace is created with its default setup.
        </InlineNotice>
      ) : (
        <ModuleStepBoundary onBroken={onBroken}>
          <Suspense fallback={null}>
            <StepComponent value={value} setValue={setValue} />
          </Suspense>
        </ModuleStepBoundary>
      )}
    </section>
  )
}
