// The line an owner's question arrives with in the author's terminal.
//
// A question typed into a callout is about one place in one tour, and the agent
// reading it has none of that on screen. So the paste leads with where it came
// from — the tour, the step, the file and lines, and which side — in one
// bracketed line the agent can parse or simply read.

import type { LiveTourStep, Tour } from './tour-types'

type StepPlace = Pick<LiveTourStep, 'id' | 'title' | 'anchor' | 'startLine' | 'endLine'>

export function tourStepLocation(step: Pick<LiveTourStep, 'anchor' | 'startLine' | 'endLine'>): string {
  const { anchor } = step
  const start = step.startLine ?? anchor.startLine
  const end = step.endLine ?? anchor.endLine
  if (start === null || end === null) return `${anchor.path} (whole file, ${anchor.side})`
  const range = start === end ? `L${start}` : `L${start}–${end}`
  return `${anchor.path} ${range} (${anchor.side})`
}

export function tourAskText(input: {
  tour: Pick<Tour, 'id' | 'title'>
  step: StepPlace
  index: number
  of: number
  question: string
}): string {
  const header = `[Tour "${input.tour.title}" · step ${input.index + 1}/${input.of} "${input.step.title}" · ${tourStepLocation(input.step)}]`
  return `${header}\n${input.question.trim()}`
}

/** For an agent that did not write the tour: enough to find it again with `tour_status`. */
export function tourAskSeed(input: { tour: Pick<Tour, 'id' | 'title'>; step: StepPlace; question: string }): string {
  return [
    `About the diff tour "${input.tour.title}" (tourId ${input.tour.id}), step "${input.step.id}" — ${input.step.title}, at ${tourStepLocation(input.step)}.`,
    'Read the tour with the tour_status tool and the code at that location, then answer:',
    '',
    input.question.trim(),
  ].join('\n')
}
