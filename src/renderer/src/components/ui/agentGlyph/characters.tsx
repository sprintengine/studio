import type { JSX } from 'react'

// The characters an agent can appear as, drawn on the 16px glyph grid in
// currentColor line work. Each is split so one drawing serves every state:
//
//   body     — always drawn, never moves
//   working  — the parts that move while the agent works, each carrying the
//              `agent-glyph__*` class its keyframes key on (index.css)
//   rest     — those same parts standing still, for a finished agent
//   eyes     — where the eyes sit ([left x, right x, y]), so the finished
//              faces (^ ^ done, x x failed, - - stopped) are drawn from them
//   doneExtra — a smile or mouth some characters add when they are done
//
// At 16px one unit is one pixel, so every character keeps a clear face: solid
// eyes with room around them, and anything that says who it is (a hat, ears,
// antlers, a string) outside the face rather than on it. A ring round an eye
// or a feature squeezed between the eyes blurs into the outline at this size.
//
// Classes, not inline styles, drive the motion so reduced motion and the idle
// pause (index.css) can stop every part in one place.

export type AgentCharacterId =
  | 'robot'
  | 'blob'
  | 'balloon'
  | 'bear'
  | 'gent'
  | 'mushroom'
  | 'ghost'
  | 'pumpkin'
  | 'cat'
  | 'witch'
  | 'skull'
  | 'elf'
  | 'santa'
  | 'reindeer'
  | 'present'

export type AgentCharacter = {
  name: string
  body: JSX.Element
  working: JSX.Element
  rest: JSX.Element | null
  eyes: readonly [left: number, right: number, y: number]
  // Half the span of a failed face's x, for characters with small eyes.
  crossSize?: number
  doneExtra?: JSX.Element
}

const BODY = {
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.4,
  strokeLinejoin: 'round',
  strokeLinecap: 'round',
} as const
const LINE = {
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.3,
  strokeLinejoin: 'round',
  strokeLinecap: 'round',
} as const
const INK = { fill: 'currentColor' } as const

/** Two solid oval eyes, the part most characters blink or glance with. */
function ovalEyes(left: number, right: number, y: number, rx: number, ry: number): JSX.Element {
  return (
    <g className="agent-glyph__eyes">
      <ellipse {...INK} cx={left} cy={y} rx={rx} ry={ry} />
      <ellipse {...INK} cx={right} cy={y} rx={rx} ry={ry} />
    </g>
  )
}

// A round head under a hat, filling the lower two thirds of the grid.
const HAT_HEAD = 'M8 6c3.1 0 5 1.9 5 4.4 0 2.4-1.9 3.6-5 3.6s-5-1.2-5-3.6C3 7.9 4.9 6 8 6z'

const balloonString = <path {...LINE} d="M8 12.9c-.9.7.9 1.4 0 2.3" />
const topHat = (
  <>
    <rect {...INK} x="5.3" y="1.6" width="5.4" height="4" rx=".5" />
    <path {...BODY} d="M3.4 5.9h9.2" />
  </>
)
const catWhiskers = <path {...LINE} d="M.9 9.7l2.1.3M1 11.6l2.1-.5M15.1 9.7l-2.1.3M15 11.6l-2.1-.5" />
const witchHat = (
  <>
    <path {...INK} d="M4.9 6.6L8.2 1.4l1.2 1.4L11.1 6.6z" />
    <path {...BODY} d="M1.6 6.9h12.8" />
  </>
)
const elfHat = (
  <>
    <path {...INK} d="M4 7.2L8.2 1.9q2.6.1 3.9 2.3l-1.2.6L12 7.2z" />
    <circle {...INK} cx="12.8" cy="4.4" r="1" />
  </>
)
const santaHat = (
  <>
    <path {...INK} d="M3.3 6.6C3.7 3.5 5.5 1.8 8.3 1.8c2 0 3.5 1 4.1 2.8l-1.3.5c-.4-.8-1-1.2-1.6-1.2L12.7 6.6z" />
    <circle {...INK} cx="13.3" cy="5.5" r="1.1" />
  </>
)
const antlers = <path {...LINE} d="M5.2 5.4Q4.4 3.6 2.6 2.6M4.7 4.1L2.8 4.4M10.8 5.4q.8-1.8 2.6-2.8M11.3 4.1l1.9.3" />
const reindeerNose = <ellipse {...INK} cx="8" cy="12.9" rx="1.7" ry="1.3" />
const bow = (
  <path {...LINE} d="M8 6.2C7 3.6 4.4 3.8 5.2 5.6 5.6 6.3 7 6.3 8 6.2c1-.1 2.4-.1 2.8-.6.8-1.8-1.8-2-2.8.6z" />
)

export const AGENT_CHARACTERS: Record<AgentCharacterId, AgentCharacter> = {
  robot: {
    name: 'Robot',
    body: (
      <>
        <rect {...BODY} x="3" y="5.4" width="10" height="7.8" rx="2.4" />
        <path {...LINE} d="M8 5.4V3.3M2.1 8.4v1.8M13.9 8.4v1.8" />
      </>
    ),
    working: (
      <>
        <circle {...INK} className="agent-glyph__antenna" cx="8" cy="2.4" r=".95" />
        <g className="agent-glyph__eyes">
          <rect {...INK} x="5.4" y="8" width="1.6" height="2.2" rx=".6" />
          <rect {...INK} x="9" y="8" width="1.6" height="2.2" rx=".6" />
        </g>
      </>
    ),
    rest: <circle {...INK} cx="8" cy="2.4" r=".95" opacity=".35" />,
    eyes: [6.2, 9.8, 9.2],
  },
  blob: {
    name: 'Bubble',
    body: (
      <path {...BODY} d="M8 3.2c3.1 0 5.1 2.6 5.1 5.9 0 2.6-1.6 4.1-5.1 4.1s-5.1-1.5-5.1-4.1C2.9 5.8 4.9 3.2 8 3.2z" />
    ),
    working: (
      <g className="agent-glyph__eyes">
        <circle {...INK} cx="6.5" cy="8.4" r=".95" />
        <circle {...INK} cx="9.5" cy="8.4" r=".95" />
      </g>
    ),
    rest: null,
    eyes: [6.5, 9.5, 8.4],
    doneExtra: <path {...LINE} d="M7.2 10.4q.8.6 1.6 0" />,
  },
  balloon: {
    name: 'Balloon',
    body: (
      <>
        <path {...BODY} d="M8 1.8c2.7 0 4.6 2.1 4.6 4.9 0 2.9-2.2 5.2-4.6 5.2S3.4 9.6 3.4 6.7C3.4 3.9 5.3 1.8 8 1.8z" />
        <path {...INK} d="M7.1 12.9L8 11.8l.9 1.1z" />
      </>
    ),
    working: (
      <>
        <g className="agent-glyph__string">{balloonString}</g>
        {ovalEyes(6.4, 9.6, 6.4, 0.9, 1.1)}
      </>
    ),
    rest: balloonString,
    eyes: [6.4, 9.6, 6.4],
    doneExtra: <path {...LINE} d="M7.2 8.6q.8.6 1.6 0" />,
  },
  bear: {
    name: 'Bear',
    body: (
      <>
        <circle {...BODY} cx="8" cy="8.8" r="5" />
        <path {...BODY} d="M3.65 6.34A1.9 1.9 0 1 1 6.23 4.12M9.77 4.12A1.9 1.9 0 1 1 12.35 6.34" />
        <ellipse {...INK} cx="8" cy="10.6" rx=".95" ry=".7" />
      </>
    ),
    working: ovalEyes(6.1, 9.9, 8.5, 0.85, 1),
    rest: null,
    eyes: [6.1, 9.9, 8.5],
  },
  gent: {
    name: 'Gent',
    body: (
      <>
        <path {...BODY} d={HAT_HEAD} />
        <path
          {...INK}
          d="M8 11.2c-.6-.8-1.8-1-2.6-.4-.4.3-.9.3-1.2-.1.1 1.2 1.6 1.8 2.9 1.3.4-.1.7-.4.9-.7.2.3.5.6.9.7 1.3.5 2.8-.1 2.9-1.3-.3.4-.8.4-1.2.1-.8-.6-2-.4-2.6.4z"
        />
      </>
    ),
    working: (
      <>
        <g className="agent-glyph__hat">{topHat}</g>
        {ovalEyes(6.3, 9.7, 8.6, 0.8, 0.95)}
      </>
    ),
    rest: topHat,
    eyes: [6.3, 9.7, 8.6],
    crossSize: 0.6,
  },
  mushroom: {
    name: 'Mushroom',
    body: (
      <>
        <path {...BODY} d="M1.8 8.2C1.8 4.6 4.6 2 8 2s6.2 2.6 6.2 6.2z" />
        <path {...BODY} d="M4.6 8.2v3.3q0 2.5 3.4 2.5t3.4-2.5V8.2" />
        <circle {...INK} cx="5.6" cy="5.2" r=".95" />
        <circle {...INK} cx="10.1" cy="4.5" r=".8" />
      </>
    ),
    working: ovalEyes(6.6, 9.4, 10.6, 0.75, 0.95),
    rest: null,
    eyes: [6.6, 9.4, 10.6],
    crossSize: 0.55,
  },
  ghost: {
    name: 'Ghost',
    body: <path {...BODY} d="M3.2 13.6V7.4a4.8 4.8 0 0 1 9.6 0v6.2l-1.6-1.2-1.6 1.2L8 12.4l-1.6 1.2-1.6-1.2z" />,
    working: ovalEyes(6.4, 9.6, 7.6, 0.85, 1.1),
    rest: null,
    eyes: [6.4, 9.6, 7.6],
  },
  pumpkin: {
    name: 'Pumpkin',
    body: (
      <>
        <path {...BODY} d="M8 5.4C5.7 4.4 1.8 5.3 1.8 9.4c0 3.4 3 4.6 6.2 4.6s6.2-1.2 6.2-4.6c0-4.1-3.9-5-6.2-4z" />
        <path {...BODY} d="M8 5.4V3.4q.6-1.2 2-1.4" />
      </>
    ),
    working: (
      <>
        <path {...INK} className="agent-glyph__eyes" d="M4.7 9.5l1.3-2 1.3 2zM8.7 9.5l1.3-2 1.3 2z" />
        <path {...LINE} d="M5.6 11.3q2.4 1.5 4.8 0" />
      </>
    ),
    rest: null,
    eyes: [6, 10, 8.8],
    doneExtra: <path {...LINE} d="M6.2 11.4q1.8 1.1 3.6 0" />,
  },
  cat: {
    name: 'Black cat',
    body: <path {...BODY} d="M3.2 7.6L3.4 2.6l3.2 2.5q1.4-.3 2.8 0l3.2-2.5.2 5q.9 6.4-4.8 6.4T3.2 7.6z" />,
    working: (
      <>
        <g className="agent-glyph__whiskers">{catWhiskers}</g>
        {ovalEyes(6.2, 9.8, 9, 0.8, 1.15)}
      </>
    ),
    rest: catWhiskers,
    eyes: [6.2, 9.8, 9],
    doneExtra: <path {...LINE} d="M7.4 11.3L8 11.8l.6-.5" />,
  },
  witch: {
    name: 'Witch',
    body: <path {...BODY} d="M4 7.4q-.5 6.6 4 6.6t4-6.6" />,
    working: (
      <>
        <g className="agent-glyph__hat">{witchHat}</g>
        {ovalEyes(6.4, 9.6, 9.9, 0.8, 1)}
      </>
    ),
    rest: witchHat,
    eyes: [6.4, 9.6, 9.9],
    crossSize: 0.6,
  },
  skull: {
    name: 'Skull',
    body: (
      <>
        <path
          {...BODY}
          d="M8 2.4c3.3 0 5.4 2.3 5.4 5.3 0 1.7-.8 2.8-1.9 3.4v2q0 .9-.9.9H5.4q-.9 0-.9-.9v-2C3.4 10.5 2.6 9.4 2.6 7.7c0-3 2.1-5.3 5.4-5.3z"
        />
        <path {...INK} d="M8 9.4l.8 1.3H7.2z" />
      </>
    ),
    working: ovalEyes(5.9, 10.1, 7.6, 1.25, 1.35),
    rest: null,
    eyes: [5.9, 10.1, 7.6],
  },
  elf: {
    name: 'Elf',
    body: (
      <>
        <path {...BODY} d="M3.6 7.4c-.4 4 1.7 6.6 4.4 6.6s4.8-2.6 4.4-6.6z" />
        <path {...LINE} d="M3.6 9L1.4 7.9l2.4 2.8M12.4 9l2.2-1.1-2.4 2.8" />
      </>
    ),
    working: (
      <>
        <g className="agent-glyph__hat">{elfHat}</g>
        {ovalEyes(6.4, 9.6, 10, 0.8, 1)}
      </>
    ),
    rest: elfHat,
    eyes: [6.4, 9.6, 10],
    crossSize: 0.6,
  },
  santa: {
    name: 'Santa',
    body: (
      <>
        <path {...BODY} d="M3.4 7.2q-.4 3.8 1.2 5.6.9 1 1.9.5 1.5 1.3 3 0 1 .5 1.9-.5 1.6-1.8 1.2-5.6" />
        <path
          {...INK}
          d="M8 11.1c-.5-.6-1.6-.8-2.3-.2-.3.2-.7.2-.9-.1.1 1 1.4 1.4 2.5 1 .3-.1.5-.3.7-.5.2.2.4.4.7.5 1.1.4 2.4 0 2.5-1-.2.3-.6.3-.9.1-.7-.6-1.8-.4-2.3.2z"
        />
      </>
    ),
    working: (
      <>
        <g className="agent-glyph__hat">{santaHat}</g>
        {ovalEyes(6.3, 9.7, 8.9, 0.75, 0.9)}
      </>
    ),
    rest: santaHat,
    eyes: [6.3, 9.7, 8.9],
    crossSize: 0.55,
  },
  reindeer: {
    name: 'Reindeer',
    body: (
      <path
        {...BODY}
        d="M8 5.4c3 0 4.6 1.8 4.4 4.2-.2 1.6-1.2 2.4-2 3.2H5.6c-.8-.8-1.8-1.6-2-3.2C3.4 7.2 5 5.4 8 5.4z"
      />
    ),
    working: (
      <>
        {antlers}
        {ovalEyes(6.3, 9.7, 8.6, 0.8, 1)}
        <g className="agent-glyph__nose">{reindeerNose}</g>
      </>
    ),
    rest: (
      <>
        {antlers}
        {reindeerNose}
      </>
    ),
    eyes: [6.3, 9.7, 8.6],
    crossSize: 0.6,
  },
  present: {
    name: 'Present',
    body: <rect {...BODY} x="2.8" y="6.6" width="10.4" height="7.4" rx="1.6" />,
    working: (
      <>
        <g className="agent-glyph__bow">{bow}</g>
        {ovalEyes(6.3, 9.7, 10, 0.85, 1)}
      </>
    ),
    rest: bow,
    eyes: [6.3, 9.7, 10],
    doneExtra: <path {...LINE} d="M7.2 12q.8.6 1.6 0" />,
  },
}

/** Closed, content eyes: ^ ^. */
export function doneEyes([left, right, y]: AgentCharacter['eyes']): JSX.Element {
  return <path {...LINE} d={`M${left - 0.8} ${y + 0.35}q.8-1 1.6 0M${right - 0.8} ${y + 0.35}q.8-1 1.6 0`} />
}

/** Crossed-out eyes: x x. */
export function failedEyes([left, right, y]: AgentCharacter['eyes'], size = 0.7): JSX.Element {
  const cross = (x: number) =>
    `M${x - size} ${y - size}l${2 * size} ${2 * size}M${x + size} ${y - size}l${-2 * size} ${2 * size}`
  return <path {...LINE} d={cross(left) + cross(right)} />
}

/** Level, switched-off eyes: - -. */
export function stoppedEyes([left, right, y]: AgentCharacter['eyes']): JSX.Element {
  return <path {...LINE} d={`M${left - 0.7} ${y}h1.4M${right - 0.7} ${y}h1.4`} />
}
