import { renderToStaticMarkup } from 'react-dom/server'
import { expect, test } from 'vitest'

import { Slider } from './Slider'

const stops = Array.from({ length: 6 }, (_, index) => ({ id: `s${index}`, label: `Stop ${index}` }))
const tickPositions = (html: string) => [...html.matchAll(/--slider-tick:([0-9.]+)/g)].map((match) => Number(match[1]))

test('every stop is a tick by default', () => {
  const html = renderToStaticMarkup(<Slider ariaLabel="Level" stops={stops} value={2} onChange={() => undefined} />)
  expect(tickPositions(html)).toEqual([0, 0.2, 0.4, 0.6, 0.8, 1])
})

test('a long ramp can mark only the stops worth finding, or none', () => {
  const marked = renderToStaticMarkup(
    <Slider ariaLabel="Level" stops={stops} value={2} ticks={[5, 0, 1, 1, 9]} onChange={() => undefined} />,
  )
  // Sorted, once each, and never a stop the ramp does not have.
  expect(tickPositions(marked)).toEqual([0, 0.2, 1])
  const none = renderToStaticMarkup(
    <Slider ariaLabel="Level" stops={stops} value={2} ticks="none" onChange={() => undefined} />,
  )
  expect(tickPositions(none)).toEqual([])
  // The value is still the stop's, whatever is marked.
  expect(none).toContain('aria-valuetext="Stop 2"')
})
