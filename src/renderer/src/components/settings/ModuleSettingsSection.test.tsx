import assert from 'node:assert/strict'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

import type { RegisteredSettingsSection } from '../../modules/renderer-host'
import { ModuleSectionErrorBoundary, ModuleSectionErrorFallback } from './ModuleSettingsSection'

// Containment contract: a broken contributed section must degrade to an inline,
// screen-reader-announced error that names the owning module and offers
// recovery — never a broken Settings overlay. Error boundaries do not run in
// static-markup rendering, so the boundary class is exercised directly through
// its lifecycle statics and the fallback through markup.

const section: RegisteredSettingsSection = {
  id: 'demo-general',
  label: 'Demo Module',
  icon: () => null,
  Component: () => null,
  moduleId: 'demo-module',
}

// --- Fallback surface --------------------------------------------------------
const fallbackMarkup = renderToStaticMarkup(<ModuleSectionErrorFallback section={section} onRetry={() => {}} />)
assert.match(fallbackMarkup, /role="alert"/, 'failure is announced to assistive tech')
assert.match(fallbackMarkup, /Demo Module failed to render/, 'failure names the section')
assert.match(fallbackMarkup, /The rest of Settings is unaffected/, 'copy scopes the failure')
assert.match(fallbackMarkup, /From demo-module/, 'ownership is visible: the failing module is named')
assert.match(fallbackMarkup, /Try again/, 'a recovery action is offered')
assert.match(fallbackMarkup, /type="button"/, 'recovery is a real button, not a link')

// --- Boundary lifecycle ------------------------------------------------------
assert.deepEqual(
  ModuleSectionErrorBoundary.getDerivedStateFromError(),
  { failed: true },
  'a render error flips the boundary into the failed state',
)

// Failed boundary renders the fallback, not the (broken) children.
const failedBoundary = new ModuleSectionErrorBoundary({ section, children: 'children' })
failedBoundary.state = { failed: true }
const failedRender = failedBoundary.render()
assert.equal(
  React.isValidElement(failedRender) && failedRender.type,
  ModuleSectionErrorFallback,
  'a failed boundary renders the inline fallback instead of its children',
)

// Healthy boundary passes children through untouched.
const healthyBoundary = new ModuleSectionErrorBoundary({ section, children: 'children' })
assert.equal(healthyBoundary.render(), 'children', 'a healthy boundary renders its children')

// Switching to another module's section clears a sticky failure; staying on the
// same section keeps it (only Try again resets it).
const otherSection: RegisteredSettingsSection = { ...section, id: 'other-general', moduleId: 'other-module' }
let recordedState: { failed: boolean } | null = null
const switchingBoundary = new ModuleSectionErrorBoundary({ section: otherSection, children: 'children' })
switchingBoundary.state = { failed: true }
switchingBoundary.setState = ((state: { failed: boolean }) => {
  recordedState = state
}) as typeof switchingBoundary.setState
switchingBoundary.componentDidUpdate({ section, children: 'children' })
assert.deepEqual(recordedState, { failed: false }, 'a failure does not stick to the next section')
recordedState = null
switchingBoundary.componentDidUpdate({ section: otherSection, children: 'children' })
assert.equal(recordedState, null, 'staying on the same section keeps the failed state')

console.log('ModuleSettingsSection.test.tsx: ok')
