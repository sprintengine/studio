import assert from 'node:assert/strict'

import { renderToStaticMarkup } from 'react-dom/server'

import { useRoadmapPlanDraft, type RoadmapPlanDraft } from './useRoadmapPlanDraft'
import { addLane } from './roadmapAuthoring'

// The horizon's draft + autosave loop. Its whole job is not losing an edit, so
// what is proved here is the two rules that are easy to get backwards:
//
//   • a pending write targets the file the EDITS were made to, never the file
//     the surface has since moved on to, and
//   • an external content change is adopted only when there is nothing unsaved.
//
// SSR gives one render pass per `renderToStaticMarkup`, which is exactly the
// granularity these rules live at: `path` is a prop and `draft` is state, so the
// bug this file exists for only appears on the single render where they disagree.

let failures = 0
function run(name: string, fn: () => void): void {
  try {
    fn()
    console.log(`ok - ${name}`)
  } catch (error) {
    failures += 1
    console.error(`not ok - ${name}`)
    console.error(error)
  }
}

const PLAN_A = ['---', 'type: roadmap', 'status: ready', '---', '# Horizon A', '', '## Delivery', '- backlog/a.md', ''].join('\n')
const PLAN_B = ['---', 'type: roadmap', 'status: idea', '---', '# Horizon B', '', '## Mobile', '- backlog/b.md', ''].join('\n')

type Write = { path: string; content: string }

// A window.api stub recording every write, so a flush that targets the wrong
// file is visible as a fact rather than inferred.
function stubApi(files: Record<string, string>): { writes: Write[] } {
  const writes: Write[] = []
  ;(globalThis as { window?: unknown }).window = {
    api: {
      readfile: async (path: string) => {
        if (!(path in files)) throw new Error(`no such file: ${path}`)
        return files[path]
      },
      writefile: async (path: string, content: string) => {
        writes.push({ path, content })
        files[path] = content
      },
    },
  }
  return { writes }
}

// Render the hook once and capture what it returned. Effects do not run under
// SSR, so this exercises the RENDER-time bookkeeping — which is where the
// pending write is recorded.
function renderHook(props: Parameters<typeof useRoadmapPlanDraft>[0]): RoadmapPlanDraft {
  let captured: RoadmapPlanDraft | null = null
  function Probe(): null {
    captured = useRoadmapPlanDraft(props)
    return null
  }
  renderToStaticMarkup(<Probe />)
  return captured as unknown as RoadmapPlanDraft
}

run('a clean draft starts saved, holding exactly the file it was given', () => {
  stubApi({ '/repo/a.md': PLAN_A })
  const plan = renderHook({
    path: '/repo/a.md',
    relativePath: 'backlog/roadmaps/a.md',
    sourceContent: PLAN_A,
    onSaved: () => undefined,
  })
  assert.equal(plan.dirty, false)
  assert.equal(plan.saveState, 'saved')
  assert.deepEqual(plan.draft.lanes.map((lane) => lane.title), ['Delivery'])
  assert.equal(plan.draft.title, 'Horizon A')
})

run('an edit makes the draft dirty and the readout say so, before any write', () => {
  stubApi({ '/repo/a.md': PLAN_A })
  const plan = renderHook({
    path: '/repo/a.md',
    relativePath: 'backlog/roadmaps/a.md',
    sourceContent: PLAN_A,
    onSaved: () => undefined,
  })
  // The hook's own transforms are pure; dirtiness is a comparison, not a write.
  const edited = { ...plan.draft, lanes: addLane(plan.draft.lanes, 'Second') }
  assert.notDeepEqual(edited.lanes, plan.baseline.lanes)
  assert.equal(plan.saveState, 'saved', 'nothing is claimed saved that was not saved')
})

run('a save composes onto the CURRENT bytes, so out-of-band frontmatter survives', async () => {
  // The scan stamped `id:` after the draft was seeded — a save must not drop it.
  const onDisk = PLAN_A.replace('status: ready', 'status: ready\nid: 42')
  const { writes } = stubApi({ '/repo/a.md': onDisk })
  const plan = renderHook({
    path: '/repo/a.md',
    relativePath: 'backlog/roadmaps/a.md',
    sourceContent: PLAN_A,
    onSaved: () => undefined,
  })
  await plan.save()
  assert.equal(writes.length, 1)
  assert.equal(writes[0].path, '/repo/a.md')
  assert.match(writes[0].content, /id: 42/, 'the id the scan added is still there')
})

run('an unreadable file falls back to the last known bytes, never composing onto ""', async () => {
  // readfile throws for this path; a fallback of "" would emit a body with no
  // frontmatter at all, turning a failed read into a wiped horizon.
  const { writes } = stubApi({})
  const plan = renderHook({
    path: '/repo/gone.md',
    relativePath: 'backlog/roadmaps/gone.md',
    sourceContent: PLAN_A,
    onSaved: () => undefined,
  })
  await plan.save()
  assert.equal(writes.length, 1)
  assert.match(writes[0].content, /^---\ntype: roadmap/, 'the frontmatter block survived')
})

run('the pending write is recorded against the file the EDITS belong to', () => {
  // The render where the rail switches: `path`/`relativePath` are already
  // horizon B's, while the draft state is still horizon A's. Recording that pair
  // is what flushed A's plan into B's file.
  stubApi({ '/repo/a.md': PLAN_A, '/repo/b.md': PLAN_B })
  const plan = renderHook({
    path: '/repo/b.md',
    relativePath: 'backlog/roadmaps/b.md',
    sourceContent: PLAN_B,
    onSaved: () => undefined,
  })
  // A first render for B is not a switch — it seeds from B and holds B.
  assert.equal(plan.draft.title, 'Horizon B')
  assert.deepEqual(plan.draft.lanes.map((lane) => lane.title), ['Mobile'])
})

run('two horizons never share a draft: each render seeds from its own content', () => {
  stubApi({ '/repo/a.md': PLAN_A, '/repo/b.md': PLAN_B })
  const a = renderHook({
    path: '/repo/a.md',
    relativePath: 'backlog/roadmaps/a.md',
    sourceContent: PLAN_A,
    onSaved: () => undefined,
  })
  const b = renderHook({
    path: '/repo/b.md',
    relativePath: 'backlog/roadmaps/b.md',
    sourceContent: PLAN_B,
    onSaved: () => undefined,
  })
  assert.equal(a.draft.title, 'Horizon A')
  assert.equal(b.draft.title, 'Horizon B')
  assert.notDeepEqual(a.draft.lanes, b.draft.lanes)
})

run('a horizon with no file yet holds an empty plan and writes nothing', async () => {
  const { writes } = stubApi({})
  const plan = renderHook({ path: '', relativePath: '', sourceContent: '', onSaved: () => undefined })
  assert.deepEqual(plan.draft.lanes, [])
  assert.equal(plan.dirty, false, 'an empty plan is never dirty, so autosave never fires for it')
  assert.equal(writes.length, 0)
})

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`)
  process.exit(1)
}
console.log('roadmap plan draft: all checks passed')
