// Host wrapper for a module-contributed Settings section. It wires the section
// component to the module's persisted `module:<id>` namespace in app settings,
// lazy-loads it behind Suspense, and contains rendering failures so a broken
// section shows an inline error instead of breaking the Settings overlay.

import React, { Suspense, useCallback } from 'react'
import type { RegisteredSettingsSection } from '../../modules/renderer-host'
import { moduleSettingsNamespace } from '../../store/slices/settingsSlice'
import { useWorkspaceStore } from '../../store/workspaceStore'
import { SuspenseFallback } from '../ui/SuspenseFallback'
import { FOCUS_RING_CLASS } from '../ui/tokens'

const EMPTY_SECTION_VALUES: Readonly<Record<string, unknown>> = Object.freeze({})

// Exported separately so the failure surface is testable without triggering a
// real render error (error boundaries do not run in static-markup rendering).
export function ModuleSectionErrorFallback({
  section,
  onRetry,
}: {
  section: RegisteredSettingsSection
  onRetry: () => void
}) {
  return (
    <div role="alert" className="border-l-2 border-[color:var(--tone-error)] pl-3 text-body leading-5">
      <p className="text-[color:var(--tone-error)]">
        {section.label} failed to render. The rest of Settings is unaffected.
      </p>
      <p className="mt-0.5 font-mono text-meta leading-4 text-[color:var(--text-subtle)]">
        From {section.moduleId}
      </p>
      <button
        type="button"
        onClick={onRetry}
        className={`mt-1.5 text-body font-semibold text-[color:var(--text-default)] hover:text-[color:var(--text-strong)] ${FOCUS_RING_CLASS}`}
      >
        Try again
      </button>
    </div>
  )
}

type BoundaryProps = { section: RegisteredSettingsSection; children: React.ReactNode }
type BoundaryState = { failed: boolean }

export class ModuleSectionErrorBoundary extends React.Component<BoundaryProps, BoundaryState> {
  state: BoundaryState = { failed: false }

  static getDerivedStateFromError(): BoundaryState {
    return { failed: true }
  }

  componentDidUpdate(previous: BoundaryProps): void {
    // The boundary instance is reused when the user switches sections; a
    // failure in one module's section must not stick to the next one.
    if (previous.section.id !== this.props.section.id && this.state.failed) {
      this.setState({ failed: false })
    }
  }

  render(): React.ReactNode {
    if (this.state.failed) {
      return (
        <ModuleSectionErrorFallback
          section={this.props.section}
          onRetry={() => this.setState({ failed: false })}
        />
      )
    }
    return this.props.children
  }
}

export function ModuleSettingsSectionHost({ section }: { section: RegisteredSettingsSection }) {
  const namespace = moduleSettingsNamespace(section.moduleId)
  const values = useWorkspaceStore(
    (s) => s.appSettings.moduleSettings[namespace] ?? EMPTY_SECTION_VALUES,
  )
  const setModuleSettingValue = useWorkspaceStore((s) => s.setModuleSettingValue)
  const setValue = useCallback(
    (key: string, value: unknown) => setModuleSettingValue(section.moduleId, key, value),
    [setModuleSettingValue, section.moduleId],
  )
  const SectionComponent = section.Component
  return (
    <ModuleSectionErrorBoundary section={section}>
      <Suspense fallback={<SuspenseFallback label={`Loading ${section.label}`} />}>
        <SectionComponent values={values} setValue={setValue} />
      </Suspense>
    </ModuleSectionErrorBoundary>
  )
}
