// Single source of truth for the film's timeline. Every scene's duration and
// on-screen caption lives here; the composition derives all frame math from
// `sceneStart`/`sceneWindow` so changing one duration reflows the whole piece.
// This is the Creative Brief beat sheet, made executable.
//
// Arc: hook (orchestrator) → mechanism (decompose → dependency graph →
// parallel multi-vendor execution → review gates) → proof/CTA.

export type SceneId =
  | 'orchestrator'
  | 'decompose'
  | 'graph'
  | 'execute'
  | 'gates'
  | 'cta'

export type Scene = {
  id: SceneId
  durationInFrames: number
  kicker: string
  caption: string
}

// 30 fps. Scenes read at 1× with no audio; each holds one idea.
export const FPS = 30

export const scenes: Scene[] = [
  {
    id: 'orchestrator',
    durationInFrames: 132,
    kicker: 'Sprint Engine',
    caption: 'One architect orchestrates the whole team.',
  },
  {
    id: 'decompose',
    durationInFrames: 168,
    kicker: 'Architect · Fable 5',
    caption: 'The brief becomes a dependency-ordered set of tasks.',
  },
  {
    id: 'graph',
    durationInFrames: 192,
    kicker: 'Dependency graph',
    caption: 'A topological sort runs independent work in parallel, dependents in order.',
  },
  {
    id: 'execute',
    durationInFrames: 222,
    kicker: 'Roster · your subscriptions',
    caption: 'Each task runs on the model you choose — Opus 4.8, Codex 5.5, GLM 5.2.',
  },
  {
    id: 'gates',
    durationInFrames: 198,
    kicker: 'Review gates · Fable 5',
    caption: 'Every change clears named review gates before it ships.',
  },
  {
    id: 'cta',
    durationInFrames: 156,
    kicker: 'multicode',
    caption: 'Sprint Engine orchestrates the terminals. You bring the models.',
  },
]

export const CROSSFADE = 22

export function sceneStart(id: SceneId): number {
  let acc = 0
  for (const scene of scenes) {
    if (scene.id === id) return acc
    acc += scene.durationInFrames
  }
  return acc
}

export function sceneWindow(id: SceneId): { start: number; end: number; duration: number } {
  const scene = scenes.find((candidate) => candidate.id === id)
  const duration = scene?.durationInFrames ?? 0
  const start = sceneStart(id)
  return { start, end: start + duration, duration }
}

export const TOTAL_FRAMES = scenes.reduce((sum, scene) => sum + scene.durationInFrames, 0)
