// @vitest-environment jsdom
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'

import {
  ModuleContributionBoundary,
  ModuleContributionErrorFallback,
  getModuleContributionError,
} from './ModuleContributionBoundary'

// A module's contribution that throws stays that contribution's failure: the
// shell around it keeps rendering, the failure is recorded under the module,
// and a panel offers a retry while a control in a row simply drops out.

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  // React reports a caught render error on console.error; the boundary's own
  // report does too. Both are expected here.
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.restoreAllMocks()
})

function Boom({ message }: { message: string }): React.ReactNode {
  throw new Error(message)
}

test('a panel that throws renders a compact notice and the shell around it survives', () => {
  act(() =>
    root.render(
      <div>
        <span>shell chrome</span>
        <ModuleContributionBoundary moduleId="acme-board" surface='panel "acme.board"' variant="panel" label="Board">
          <Boom message={'board exploded\n    at /Users/dev/acme/board.js:1:1'} />
        </ModuleContributionBoundary>
      </div>,
    ),
  )
  expect(container.textContent).toContain('shell chrome')
  expect(container.textContent).toContain('Board hit a problem and stopped.')
  expect(container.textContent).toContain('From acme-board')
  expect(container.querySelector('[role="alert"]')).not.toBeNull()
  // Recorded under the module, first line only: no stack, no author paths.
  expect(getModuleContributionError('acme-board')).toBe('panel "acme.board" crashed: board exploded')
})

test('retry remounts the contribution', () => {
  let shouldThrow = true
  function Flaky(): React.ReactNode {
    if (shouldThrow) throw new Error('first render fails')
    return <span>recovered</span>
  }
  act(() =>
    root.render(
      <ModuleContributionBoundary moduleId="acme-flaky" surface='panel "acme.flaky"' variant="panel">
        <Flaky />
      </ModuleContributionBoundary>,
    ),
  )
  expect(container.textContent).toContain('acme-flaky hit a problem')
  shouldThrow = false
  const retry = [...container.querySelectorAll('button')].find((button) => button.textContent === 'Try again')
  act(() => retry!.click())
  expect(container.textContent).toContain('recovered')
})

test('an inline control that throws drops out and leaves its neighbours', () => {
  act(() =>
    root.render(
      <div>
        <button type="button">neighbour</button>
        <ModuleContributionBoundary moduleId="acme-mic" surface='top-bar item "mic"' variant="inline">
          <Boom message="mic exploded" />
        </ModuleContributionBoundary>
      </div>,
    ),
  )
  expect(container.textContent).toBe('neighbour')
  expect(getModuleContributionError('acme-mic')).toBe('top-bar item "mic" crashed: mic exploded')
})

test('a lazy contribution whose chunk fails to load is contained too', async () => {
  const Broken = React.lazy(() => Promise.reject(new Error('chunk load failed')))
  await act(async () =>
    root.render(
      <ModuleContributionBoundary moduleId="acme-lazy" surface='panel "acme.lazy"' variant="panel">
        <React.Suspense fallback={null}>
          <Broken />
        </React.Suspense>
      </ModuleContributionBoundary>,
    ),
  )
  expect(container.textContent).toContain('acme-lazy hit a problem')
  expect(getModuleContributionError('acme-lazy')).toBe('panel "acme.lazy" crashed: chunk load failed')
})

test('the fallback names the module and offers a real button', () => {
  act(() => root.render(<ModuleContributionErrorFallback label="Board" moduleId="acme-board" onRetry={() => {}} />))
  const button = container.querySelector('button')
  expect(button?.getAttribute('type')).toBe('button')
  expect(container.textContent).toContain('The rest of the app is unaffected.')
})
