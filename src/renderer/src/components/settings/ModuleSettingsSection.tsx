// Host wrapper for a module-contributed Settings section. It wires the section
// component to the module's persisted `module:<id>` namespace in app settings,
// lazy-loads it behind Suspense, and contains rendering failures so a broken
// section shows an inline error instead of breaking the Settings overlay.

import React, { Suspense, useCallback } from 'react'
import type { RegisteredSettingsSection } from '../../modules/renderer-host'
import { moduleSettingsNamespace } from '../../store/slices/settingsSlice'
import { useWorkspaceStore } from '../../store/workspaceStore'
import { SuspenseFallback } from '../ui/SuspenseFallback'
import { GhostButton, InlineNotice } from '../ui'

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
  // The kit's failure card, not a hand-rolled tone bar: `role="alert"`,
  // the failure sentence, the owning module behind the hint, and the recovery on
  // the action row — the anatomy the notice contract asks for.
  return (
    <InlineNotice
      tone="error"
      title={`${section.label} failed to render. The rest of Settings is unaffected.`}
      hint={`From ${section.moduleId}`}
      action={<GhostButton onClick={onRetry}>Try again</GhostButton>}
    />
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
      // oxlint-disable-next-line react/no-did-update-set-state -- guarded reset, runs once per switch
      this.setState({ failed: false })
    }
  }

  render(): React.ReactNode {
    if (this.state.failed) {
      return (
        <ModuleSectionErrorFallback section={this.props.section} onRetry={() => this.setState({ failed: false })} />
      )
    }
    return this.props.children
  }
}

export function ModuleSettingsSectionHost({ section }: { section: RegisteredSettingsSection }) {
  const namespace = moduleSettingsNamespace(section.moduleId)
  const values = useWorkspaceStore((s) => s.appSettings.moduleSettings[namespace] ?? EMPTY_SECTION_VALUES)
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
